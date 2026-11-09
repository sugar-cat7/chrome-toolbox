import { describe, expect, it } from 'vitest';
import { createPcmPipeline, type PcmSegmentMessage } from '../../src/audio/pcm-pipeline.ts';
import { inPieces, pattern, type Part } from './audio.ts';

/** The worklet's side: 128-frame stereo render blocks in, posted messages and their transfer lists out. */
function start(inputRate: number) {
  const sent: { message: PcmSegmentMessage; transfer: readonly ArrayBuffer[] }[] = [];
  const pipeline = createPcmPipeline(inputRate, (message, transfer) =>
    sent.push({ message, transfer }),
  );
  const feed = (parts: readonly Part[]) =>
    inPieces(pattern(parts, inputRate), 128, (block) => pipeline.process([block, block]));
  return { sent, pipeline, feed };
}

describe('pcm pipeline', () => {
  it.each([{ inputRate: 48000 }, { inputRate: 44100 }])(
    'sends each closed segment from $inputRate Hz stereo as its own 16 kHz PCM',
    ({ inputRate }) => {
      const { sent, feed } = start(inputRate);
      feed(['silence:200', 'speech:600', 'silence:400', 'speech:600', 'silence:400']);
      expect(sent).toHaveLength(2);
      for (const { message, transfer } of sent) {
        expect(message).toMatchObject({
          type: 'segment',
          trailingSilenceMs: 300,
          gapBeforeMs: expect.any(Number),
        });
        // The edge frames of the speech may hold the resampling filter's tail.
        expect(message.durationMs).toBeGreaterThanOrEqual(700);
        expect(message.durationMs).toBeLessThanOrEqual(720);
        expect(message.pcm).toHaveLength(message.durationMs * 16);
        // A copy that owns its buffer, handed over rather than cloned.
        expect(message.pcm.buffer.byteLength).toBe(message.pcm.byteLength);
        expect(transfer).toEqual([message.pcm.buffer]);
      }
      expect(sent[0]?.message.pcm.buffer).not.toBe(sent[1]?.message.pcm.buffer);
    },
  );

  it('flush sends the open segment and reset drops it', () => {
    const flushed = start(48000);
    flushed.feed(['silence:200', 'speech:600']);
    flushed.pipeline.command({ type: 'flush' });
    expect(flushed.sent.map(({ message }) => message.trailingSilenceMs)).toEqual([0]);

    const dropped = start(48000);
    dropped.feed(['silence:200', 'speech:600']);
    dropped.pipeline.command({ type: 'reset' });
    dropped.pipeline.command({ type: 'flush' });
    dropped.feed(['silence:400']);
    expect(dropped.sent).toEqual([]);
  });

  it.each([null, 'flush', {}, { type: 'segment' }, { type: 'stop' }])(
    'ignores the message %j',
    (data) => {
      const { sent, pipeline, feed } = start(48000);
      feed(['silence:200', 'speech:600']);
      pipeline.command(data);
      expect(sent).toEqual([]);
      pipeline.command({ type: 'flush' });
      expect(sent).toHaveLength(1);
    },
  );

  it('does nothing without an input', () => {
    const { sent, pipeline } = start(48000);
    pipeline.process([]);
    pipeline.command({ type: 'flush' });
    expect(sent).toEqual([]);
  });
});
