import { PCM_RATE } from './resample.ts';

/** The VAD's settings (spec): every value is fixed, so the buffers below have fixed sizes. */
export type VadOptions = {
  frameMs: 20;
  hangoverMs: 300;
  minSegmentMs: 300;
  maxSegmentMs: 1500;
  cutSearchMs: 500;
  preRollMs: 100;
  floorWindowMs: 2000;
  floorRatio: 3;
  minRms: 0.003;
};

export const VAD_OPTIONS: VadOptions = {
  frameMs: 20,
  hangoverMs: 300,
  minSegmentMs: 300,
  maxSegmentMs: 1500,
  cutSearchMs: 500,
  preRollMs: 100,
  floorWindowMs: 2000,
  floorRatio: 3,
  minRms: 0.003,
};

/**
 * A closed stretch of speech as 16 kHz PCM16. `pcm` is a view of the VAD's own buffer, valid until
 * the next `push`, `flush` or `reset`; copy it to keep it.
 */
export type Segment = Readonly<{
  pcm: Int16Array;
  durationMs: number;
  /**
   * Silence received after the segment's end and left out: `hangoverMs` when silence closed it,
   * what a flush found (under `hangoverMs`), 0 when its length did. The rest of a length cut (up to
   * `cutSearchMs` − `frameMs`) is speech, so it does not count here.
   */
  trailingSilenceMs: number;
  /**
   * The time from the end of the last segment sent (or from the start or a reset) to this
   * segment's speech; 0 for the rest of a segment cut for length. Closes a sentence at 700 ms.
   */
  gapBeforeMs: number;
}>;

/** The lengths of the VAD's buffers, which never change. */
export type VadSizes = Readonly<{
  segmentSamples: number;
  preRollSamples: number;
  floorLevels: number;
}>;

export type Vad = {
  /** Takes one frame of `frameMs` at 16 kHz (320 samples); returns the segment it closed, if any. */
  push(this: void, frame: Float32Array): Segment | undefined;
  /** Closes the open segment; returns it when it is long enough. */
  flush(this: void): Segment | undefined;
  /** Drops the open segment, the pre-roll and the floor. */
  reset(this: void): void;
  sizes(this: void): VadSizes;
};

function rmsOf(frame: Float32Array, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (frame[i] ?? 0) ** 2;
  return Math.sqrt(sum / length);
}

const toPcm16 = (sample: number) => Math.round(Math.max(-1, Math.min(1, sample)) * 32767);

/**
 * An energy VAD with an adaptive floor. A frame is speech when its RMS exceeds
 * max(`minRms`, floor × `floorRatio`), the floor being the lowest frame RMS of the last
 * `floorWindowMs` (this frame included): steady sound such as music lifts its own floor.
 *
 * A segment starts with the `preRollMs` before its first speech frame and closes after
 * `hangoverMs` of silence, which it leaves out. At `maxSegmentMs` it is cut after the quietest frame
 * of its last `cutSearchMs` (the later one on a tie): cutting mid-syllable makes the speech model
 * repeat itself (Task 4). What follows that frame starts the next segment, without a pre-roll.
 * Segments shorter than `minSegmentMs` are dropped.
 *
 * Every buffer is allocated here at a fixed size; pushing allocates only a returned segment.
 */
export function createVad(options: VadOptions): Vad {
  const frameSamples = (options.frameMs * PCM_RATE) / 1000;
  const framesOf = (ms: number) => Math.round(ms / options.frameMs);
  const hangoverFrames = framesOf(options.hangoverMs);
  const minFrames = framesOf(options.minSegmentMs);
  const maxFrames = framesOf(options.maxSegmentMs);
  const searchFrames = framesOf(options.cutSearchMs);
  const preRollFrames = framesOf(options.preRollMs);
  const floorFrames = framesOf(options.floorWindowMs);
  // Sized as the spec states, for the longest segment and the pre-roll. The pre-roll counts toward
  // `maxSegmentMs`, so its share is headroom.
  const pcm = new Int16Array((maxFrames + preRollFrames) * frameSamples);
  const levels = new Float32Array(maxFrames + preRollFrames);
  const preRoll = new Int16Array(preRollFrames * frameSamples);
  const floor = new Float32Array(floorFrames);

  let open = false;
  /** Frames in `pcm`. */
  let buffered = 0;
  /** Non-speech frames at the end of `pcm`. */
  let silentRun = 0;
  let gapBeforeMs = 0;
  /** Frames since the end of the last segment sent. */
  let sinceEnd = 0;
  /** After a cut, the frame the rest starts at; moved to the front on the next call. */
  let restFrom = 0;
  let preRollNext = 0;
  /** Frames in `preRoll` after the last segment sent, so a pre-roll never repeats its audio. */
  let preRollCount = 0;
  let floorNext = 0;
  let floorCount = 0;

  const copyFrame = (from: Int16Array, fromFrame: number, toFrame: number) => {
    const source = fromFrame * frameSamples;
    const target = toFrame * frameSamples;
    for (let i = 0; i < frameSamples; i += 1) pcm[target + i] = from[source + i] ?? 0;
  };

  /** Moves the rest of a cut, which the returned segment's view still covered, to the front. */
  const settle = () => {
    if (!restFrom) return;
    pcm.copyWithin(0, restFrom * frameSamples, (restFrom + buffered) * frameSamples);
    levels.copyWithin(0, restFrom, restFrom + buffered);
    restFrom = 0;
  };

  const segment = (frames: number, trailingSilenceMs: number): Segment => ({
    pcm: pcm.subarray(0, frames * frameSamples),
    durationMs: frames * options.frameMs,
    trailingSilenceMs,
    gapBeforeMs,
  });

  /** Closes the open segment before its trailing silence. */
  const close = (): Segment | undefined => {
    const frames = buffered - silentRun;
    const trailing = silentRun;
    open = false;
    buffered = 0;
    silentRun = 0;
    if (frames < minFrames) return undefined;
    sinceEnd = trailing;
    preRollCount = Math.min(preRollCount, trailing);
    return segment(frames, trailing * options.frameMs);
  };

  /** Closes a full segment after the quietest frame of its last `cutSearchMs`; the rest stays open. */
  const cut = (): Segment => {
    let quietest = buffered - searchFrames;
    for (let at = quietest + 1; at < buffered; at += 1)
      if ((levels[at] ?? 0) <= (levels[quietest] ?? 0)) quietest = at;
    const frames = quietest + 1;
    const closed = segment(frames, 0);
    restFrom = frames;
    buffered -= frames;
    silentRun = Math.min(silentRun, buffered);
    sinceEnd = buffered;
    gapBeforeMs = 0;
    return closed;
  };

  /** The lowest level of the floor window, this frame's included. */
  const floorLevel = () => {
    let lowest = Infinity;
    for (let i = 0; i < floorCount; i += 1) lowest = Math.min(lowest, floor[i] ?? 0);
    return lowest;
  };

  return {
    push(frame) {
      settle();
      const level = rmsOf(frame, frameSamples);
      floor[floorNext] = level;
      floorNext = (floorNext + 1) % floorFrames;
      floorCount = Math.min(floorCount + 1, floorFrames);
      const speech = level > Math.max(options.minRms, floorLevel() * options.floorRatio);

      if (!open && speech) {
        // The pre-roll frames are the latest ones before this frame, oldest first; their levels
        // are the floor's entries before this frame's.
        open = true;
        buffered = Math.min(preRollCount, preRollFrames);
        for (let at = 0; at < buffered; at += 1) {
          const back = buffered - at;
          copyFrame(preRoll, (preRollNext - back + preRollFrames) % preRollFrames, at);
          levels[at] = floor[(floorNext - 1 - back + floorFrames) % floorFrames] ?? 0;
        }
        silentRun = 0;
        gapBeforeMs = sinceEnd * options.frameMs;
      }

      const slot = preRollNext * frameSamples;
      for (let i = 0; i < frameSamples; i += 1) preRoll[slot + i] = toPcm16(frame[i] ?? 0);
      if (open) {
        copyFrame(preRoll, preRollNext, buffered);
        levels[buffered] = level;
        buffered += 1;
        silentRun = speech ? 0 : silentRun + 1;
      }
      preRollNext = (preRollNext + 1) % preRollFrames;
      preRollCount = Math.min(preRollCount + 1, preRollFrames);
      sinceEnd += 1;

      if (!open) return undefined;
      if (silentRun >= hangoverFrames) return close();
      return buffered >= maxFrames ? cut() : undefined;
    },
    flush() {
      settle();
      return open ? close() : undefined;
    },
    reset() {
      open = false;
      buffered = 0;
      silentRun = 0;
      gapBeforeMs = 0;
      sinceEnd = 0;
      restFrom = 0;
      preRollNext = 0;
      preRollCount = 0;
      floorNext = 0;
      floorCount = 0;
    },
    sizes: () => ({
      segmentSamples: pcm.length,
      preRollSamples: preRoll.length,
      floorLevels: floor.length,
    }),
  };
}
