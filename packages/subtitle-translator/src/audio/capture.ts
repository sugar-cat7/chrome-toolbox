import { capture, captureSync, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import type { PcmCommand } from './pcm-pipeline.ts';
import type { Segment } from './vad.ts';

/** A segment of the worklet, with when its speech ended (`performance.timeOrigin` clock, ms). */
export type DatedSegment = Segment & { endedAt: number };

export type CaptureDeps = Readonly<{
  /** From `tabCapture.getMediaStreamId`: used at once, it expires within about 10 s (Task 13). */
  streamId: string;
  /** The `st-pcm` AudioWorklet module (`/pcm-worklet.js`). */
  workletUrl: string;
  onSegment: (segment: DatedSegment) => void;
}>;

export type Capture = {
  /** Connects the tab's audio to the worklet, or disconnects it (the worklet then reads silence). */
  input(this: void, on: boolean): void;
  /** Closes the open segment and sends it. */
  flush(this: void): void;
  /** Drops the open segment and the VAD's floor (resume: the floor filled with silence). */
  discard(this: void): void;
  /** Stops the track, disconnects the nodes and closes the AudioContext, which ends the worklet. */
  stop(this: void): void;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * A worklet message as a segment (`PcmSegmentMessage`), dated: its speech ended `trailingSilenceMs
 * + carriedMs` before `receivedAt` (S45). Anything else is undefined.
 */
export function readSegment(data: unknown, receivedAt: number): DatedSegment | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('type' in data) || data.type !== 'segment') return undefined;
  if (!('pcm' in data) || !(data.pcm instanceof Int16Array)) return undefined;
  const durationMs: unknown = Reflect.get(data, 'durationMs');
  const trailingSilenceMs: unknown = Reflect.get(data, 'trailingSilenceMs');
  const carriedMs: unknown = Reflect.get(data, 'carriedMs');
  const gapBeforeMs: unknown = Reflect.get(data, 'gapBeforeMs');
  if (
    !isCount(durationMs) ||
    !isCount(trailingSilenceMs) ||
    !isCount(carriedMs) ||
    !isCount(gapBeforeMs)
  )
    return undefined;
  return {
    pcm: data.pcm,
    durationMs,
    trailingSilenceMs,
    carriedMs,
    gapBeforeMs,
    endedAt: receivedAt - trailingSilenceMs - carriedMs,
  };
}

/** The clock of `endedAt` and of the live pipeline. */
const wallClock = (): number => performance.timeOrigin + performance.now();

/** Chrome's tab source for `getUserMedia`, which the DOM types do not name. */
type TabAudioConstraints = MediaTrackConstraints & {
  mandatory: Readonly<{ chromeMediaSource: 'tab'; chromeMediaSourceId: string }>;
};

/**
 * Captures the tab's audio in the offscreen document: `getUserMedia` with the tab's stream id, an
 * AudioContext at the device rate (`interactive`), the source played back to `destination` so the
 * viewer still hears the tab (a captured tab is not played otherwise), and the `st-pcm` worklet,
 * fed only while `input(true)`. The worklet's segments go to `onSegment`, dated. A failure at any
 * step releases what was made and gives `capture_failed`.
 */
export async function startCapture({
  streamId,
  workletUrl,
  onSegment,
}: CaptureDeps): Promise<Result<Capture>> {
  const audio: TabAudioConstraints = {
    mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
  };
  const stream = await capture(
    () => navigator.mediaDevices.getUserMedia({ audio, video: false }),
    'capture_failed',
  );
  if (!stream.ok) return stream;
  const stopTracks = (): void => {
    for (const track of stream.value.getTracks()) track.stop();
  };
  const made = captureSync(
    () => new AudioContext({ latencyHint: 'interactive' }),
    'capture_failed',
  );
  if (!made.ok) {
    stopTracks();
    return made;
  }
  const context = made.value;
  const close = (): void => {
    stopTracks();
    launch(
      async () => {
        await context.close();
      },
      () => undefined,
    );
  };
  const loaded = await capture(() => context.audioWorklet.addModule(workletUrl), 'capture_failed');
  const nodes = loaded.ok
    ? captureSync(
        () => ({
          source: context.createMediaStreamSource(stream.value),
          worklet: new AudioWorkletNode(context, 'st-pcm', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
          }),
        }),
        'capture_failed',
      )
    : loaded;
  if (!nodes.ok) {
    close();
    return nodes;
  }
  const { source, worklet } = nodes.value;
  const command = (type: PcmCommand['type']): void => {
    worklet.port.postMessage({ type } satisfies PcmCommand);
  };
  worklet.port.onmessage = (event: MessageEvent<unknown>) => {
    const segment = readSegment(event.data, wallClock());
    if (segment !== undefined) onSegment(segment);
  };
  source.connect(context.destination);
  let connected = false;
  let stopped = false;
  return Ok({
    input(on) {
      if (stopped || on === connected) return;
      connected = on;
      if (on) source.connect(worklet);
      else source.disconnect(worklet);
    },
    flush: () => command('flush'),
    discard: () => command('reset'),
    stop() {
      if (stopped) return;
      stopped = true;
      worklet.port.onmessage = null;
      source.disconnect();
      worklet.disconnect();
      close();
    },
  });
}
