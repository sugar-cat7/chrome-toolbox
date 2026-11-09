import { createResampler, downmix, PCM_RATE } from './resample.ts';
import { createVad, VAD_OPTIONS, type Segment } from './vad.ts';

/** What the `st-pcm` worklet posts for each closed segment; `pcm.buffer` is transferred. */
export type PcmSegmentMessage = Readonly<{
  type: 'segment';
  pcm: Int16Array<ArrayBuffer>;
  durationMs: number;
  trailingSilenceMs: number;
  carriedMs: number;
  gapBeforeMs: number;
}>;

/** What the `st-pcm` worklet accepts: close and send the open segment, or drop it. */
export type PcmCommand = Readonly<{ type: 'flush' | 'reset' }>;

export type PcmPipeline = {
  /** One render block: one array per channel, each of the block's length. */
  process(this: void, channels: readonly Float32Array[]): void;
  /** A message from the port; anything but a `PcmCommand` is ignored. */
  command(this: void, data: unknown): void;
};

const isCommand = (data: unknown): data is PcmCommand =>
  typeof data === 'object' &&
  data !== null &&
  'type' in data &&
  (data.type === 'flush' || data.type === 'reset');

/**
 * The work of the `st-pcm` AudioWorklet, kept out of it so it runs in Node: each render block is
 * mixed to mono, resampled from the device rate to 16 kHz, cut into 20 ms frames and given to the
 * VAD. A closed segment is copied out of the VAD's buffer and sent with its buffer transferred.
 * Nothing else allocates per block once the block length is steady.
 */
export function createPcmPipeline(
  inputRate: number,
  send: (message: PcmSegmentMessage, transfer: [ArrayBuffer]) => void,
): PcmPipeline {
  const resample = createResampler(inputRate, PCM_RATE);
  const vad = createVad(VAD_OPTIONS);
  let mono = new Float32Array(128);
  const frame = new Float32Array((VAD_OPTIONS.frameMs * PCM_RATE) / 1000);
  let filled = 0;

  const post = (segment: Segment | undefined) => {
    if (!segment) return;
    const pcm = segment.pcm.slice();
    send(
      {
        type: 'segment',
        pcm,
        durationMs: segment.durationMs,
        trailingSilenceMs: segment.trailingSilenceMs,
        carriedMs: segment.carriedMs,
        gapBeforeMs: segment.gapBeforeMs,
      },
      [pcm.buffer],
    );
  };

  return {
    process(channels) {
      const length = channels[0]?.length ?? 0;
      if (!length) return;
      if (mono.length !== length) mono = new Float32Array(length);
      const samples = resample(downmix(channels, mono));
      for (let i = 0; i < samples.length; i += 1) {
        frame[filled] = samples[i] ?? 0;
        filled += 1;
        if (filled < frame.length) continue;
        filled = 0;
        post(vad.push(frame));
      }
    },
    command(data) {
      if (!isCommand(data)) return;
      if (data.type === 'flush') post(vad.flush());
      else {
        vad.reset();
        filled = 0;
      }
    },
  };
}
