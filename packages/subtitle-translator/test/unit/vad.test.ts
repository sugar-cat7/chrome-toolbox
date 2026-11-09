import { describe, expect, it } from 'vitest';
import { createVad, VAD_OPTIONS, type Segment, type Vad } from '../../src/audio/vad.ts';
import { inPieces, pattern, type Part } from './audio.ts';

const RATE = 16000;
/** 20 ms at 16 kHz. */
const FRAME = 320;

/** Pushes `samples` frame by frame; each segment's PCM is copied (the VAD reuses its buffer). */
function run(vad: Vad, samples: Float32Array): Segment[] {
  const segments: Segment[] = [];
  inPieces(samples, FRAME, (frame) => {
    const segment = vad.push(frame);
    if (segment) segments.push({ ...segment, pcm: segment.pcm.slice() });
  });
  return segments;
}
const segmentsOf = (parts: readonly Part[]) => run(createVad(VAD_OPTIONS), pattern(parts, RATE));

/** The largest distance between the PCM16 samples and the float input they came from. */
function distance(pcm: Int16Array, input: Float32Array): number {
  expect(pcm.length).toBe(input.length);
  let worst = 0;
  pcm.forEach((sample, i) => {
    worst = Math.max(worst, Math.abs(sample - (input[i] ?? 0) * 32767));
  });
  return worst;
}

describe('vad', () => {
  it.each<{ name: string; pattern: Part[]; segments: number[] }>([
    {
      name: '発話→無音で区切る',
      pattern: ['silence:200', 'speech:600', 'silence:400'],
      segments: [700],
    },
    {
      // 前置き 100 + 発話 1,300 + 静かな 20 で 1,420。続きも同じ。最後は 460
      name: '1.5 秒を超える発話は、最後の 500 ms でいちばん静かなフレームの後ろで切る',
      pattern: [
        'silence:200',
        'speech:1300',
        'silence:20',
        'speech:1400',
        'silence:20',
        'speech:460',
        'silence:400',
      ],
      segments: [1420, 1420, 460],
    },
    {
      name: '短すぎる音は捨てる',
      pattern: ['silence:200', 'speech:160', 'silence:400'],
      segments: [],
    },
    { name: '無音だけ', pattern: ['silence:60000'], segments: [] },
    { name: '一定の大きさの BGM だけ', pattern: ['tone:60000'], segments: [] },
  ])('vad: $name', ({ pattern: parts, segments }) => {
    const found = segmentsOf(parts);
    expect(found.map((segment) => segment.durationMs)).toEqual(segments);
    for (const segment of found) expect(segment.pcm.length).toBe(segment.durationMs * 16);
  });

  it('keeps the pre-roll and the speech, and drops the trailing silence', () => {
    const input = pattern(['silence:200', 'speech:600', 'silence:400'], RATE);
    const [segment] = run(createVad(VAD_OPTIONS), input);
    // From 100 ms (the pre-roll) to 800 ms (the end of the speech).
    expect(distance(segment?.pcm ?? new Int16Array(), input.subarray(1600, 12800))).toBeLessThan(1);
  });

  it('cuts a forced segment after 1,000 ms at the latest and loses no audio', () => {
    const input = pattern(['silence:200', 'speech:1800', 'silence:400'], RATE);
    const found = run(createVad(VAD_OPTIONS), input);
    expect(found).toHaveLength(2);
    const [first, second] = found;
    expect(first?.durationMs).toBeGreaterThanOrEqual(1020);
    expect(first?.durationMs).toBeLessThanOrEqual(1500);
    expect((first?.durationMs ?? 0) + (second?.durationMs ?? 0)).toBe(1900);
    // The two segments join into the audio from the pre-roll to the end of the speech.
    const joined = new Int16Array([...(first?.pcm ?? []), ...(second?.pcm ?? [])]);
    expect(distance(joined, input.subarray(1600, 32000))).toBeLessThan(1);
  });

  it('cuts after the later of two equally quiet frames', () => {
    // Two silent frames with the same level in the last 500 ms: the cut follows the second.
    const quiet = pattern(['silence:20'], RATE, 7);
    const input = pattern(['silence:200', 'speech:1500'], RATE);
    input.set(quiet, 1100 * 16);
    input.set(quiet, 1200 * 16);
    const [first] = run(createVad(VAD_OPTIONS), input);
    // Pre-roll 100 + speech from 200 ms to the end of the frame at 1,200 ms.
    expect(first?.durationMs).toBe(1120);
  });

  it('reports trailing silence and the gap before each segment', () => {
    const silenceClosed = segmentsOf([
      'silence:200',
      'speech:600',
      'silence:800',
      'speech:600',
      'silence:400',
    ]);
    expect(
      silenceClosed.map(({ trailingSilenceMs, gapBeforeMs }) => ({
        trailingSilenceMs,
        gapBeforeMs,
      })),
    ).toEqual([
      { trailingSilenceMs: 300, gapBeforeMs: 200 },
      { trailingSilenceMs: 300, gapBeforeMs: 800 },
    ]);
    const lengthCut = segmentsOf(['silence:200', 'speech:1800', 'silence:400']);
    expect(
      lengthCut.map(({ trailingSilenceMs, gapBeforeMs }) => ({ trailingSilenceMs, gapBeforeMs })),
    ).toEqual([
      { trailingSilenceMs: 0, gapBeforeMs: 200 },
      { trailingSilenceMs: 300, gapBeforeMs: 0 },
    ]);
  });

  it('measures the gap from the last segment it sent, past a dropped short sound', () => {
    const found = segmentsOf([
      'silence:200',
      'speech:600',
      'silence:400',
      'speech:100',
      'silence:400',
      'speech:600',
      'silence:400',
    ]);
    expect(found.map((segment) => segment.gapBeforeMs)).toEqual([200, 900]);
  });

  it('keeps every VAD buffer at a fixed size through an hour of silence', () => {
    const vad = createVad(VAD_OPTIONS);
    const sizes = vad.sizes();
    // (1,500 + 100) ms × 16 samples, 5 frames of pre-roll, 100 floor levels.
    expect(sizes).toEqual({ segmentSamples: 25_600, preRollSamples: 1_600, floorLevels: 100 });
    const quiet = pattern(['silence:20'], RATE);
    let segments = 0;
    for (let frame = 0; frame < 180_000; frame += 1) if (vad.push(quiet)) segments += 1;
    expect(segments).toBe(0);
    expect(vad.sizes()).toEqual(sizes);
    const [segment] = run(vad, pattern(['speech:600', 'silence:400'], RATE));
    expect(segment).toMatchObject({ durationMs: 700, gapBeforeMs: 3_600_000 });
  });

  it.each<{ name: string; pattern: Part[]; flushed: Omit<Segment, 'pcm'> | undefined }>([
    {
      name: 'an open segment',
      pattern: ['silence:200', 'speech:600'],
      flushed: { durationMs: 700, trailingSilenceMs: 0, gapBeforeMs: 200 },
    },
    {
      name: 'an open segment in its hangover',
      pattern: ['silence:200', 'speech:600', 'silence:100'],
      flushed: { durationMs: 700, trailingSilenceMs: 100, gapBeforeMs: 200 },
    },
    { name: 'a sound too short', pattern: ['silence:200', 'speech:160'], flushed: undefined },
    { name: 'silence', pattern: ['silence:400'], flushed: undefined },
  ])(
    'flush closes the open segment when it is long enough: $name',
    ({ pattern: parts, flushed }) => {
      const vad = createVad(VAD_OPTIONS);
      expect(run(vad, pattern(parts, RATE))).toEqual([]);
      const segment = vad.flush();
      expect(segment && { ...segment, pcm: undefined }).toEqual(
        flushed && { ...flushed, pcm: undefined },
      );
      expect(segment?.pcm.length ?? 0).toBe((flushed?.durationMs ?? 0) * 16);
      expect(vad.flush()).toBeUndefined();
    },
  );

  it('flush sends the rest of a forced cut, without a pre-roll', () => {
    const vad = createVad(VAD_OPTIONS);
    const [first] = run(vad, pattern(['silence:200', 'speech:1800'], RATE));
    expect(vad.flush()).toMatchObject({
      durationMs: 1900 - (first?.durationMs ?? 0),
      trailingSilenceMs: 0,
      gapBeforeMs: 0,
    });
  });

  it('reset drops the open segment, the pre-roll and the floor', () => {
    const vad = createVad(VAD_OPTIONS);
    run(vad, pattern(['silence:200', 'speech:600'], RATE));
    vad.reset();
    expect(vad.flush()).toBeUndefined();
    expect(run(vad, pattern(['silence:400'], RATE))).toEqual([]);
    const after = createVad(VAD_OPTIONS);
    run(after, pattern(['silence:400'], RATE, 3));
    after.reset();
    // No quiet frame since the reset: steady speech has no floor to rise above.
    expect(run(after, pattern(['speech:600', 'silence:400'], RATE))).toEqual([]);
    after.reset();
    // The pre-roll and the gap start at the reset.
    const [segment] = run(after, pattern(['silence:40', 'speech:600', 'silence:400'], RATE));
    expect(segment).toMatchObject({ durationMs: 640, gapBeforeMs: 40 });
  });
});
