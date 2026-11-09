import { describe, expect, it } from 'vitest';
import { createResampler, downmix } from '../../src/audio/resample.ts';
import { inPieces, noise, pattern, rms, seeded, tone } from './audio.ts';

/** Feeds `input` in 128-sample render blocks and copies out every result (the buffer is reused). */
function resampleInBlocks(inputRate: number, input: Float32Array): number[] {
  const resample = createResampler(inputRate, 16000);
  const out: number[] = [];
  inPieces(input, 128, (block) => out.push(...resample(block)));
  return out;
}

describe('resampler', () => {
  it.each([
    { name: '48k→16k の長さ', inputRate: 48000, samples: 4800, expected: 1600 },
    { name: '44.1k→16k の長さ', inputRate: 44100, samples: 4410, expected: 1600 },
  ])('resampler: $name', ({ inputRate, samples, expected }) => {
    const out = resampleInBlocks(inputRate, noise(samples, 0.1, seeded(1)));
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(1);
  });

  it('keeps a 1 kHz tone and weakens a 12 kHz tone', () => {
    const level = (hz: number) =>
      // The first samples hold the filter's start; the level is read after it.
      rms(resampleInBlocks(48000, tone(48000, 48000, hz, 0.5)).slice(64));
    const low = level(1000);
    expect(low).toBeGreaterThan(0.5 * Math.SQRT1_2 * 0.95);
    expect(level(12000)).toBeLessThanOrEqual(low * 0.6);
  });

  it('carries the fraction and the filter across calls', () => {
    const input = pattern(['speech:200'], 44100);
    const whole = Array.from(createResampler(44100, 16000)(input));
    const blocks = resampleInBlocks(44100, input);
    expect(blocks).toHaveLength(whole.length);
    expect(Math.max(...blocks.map((sample, i) => Math.abs(sample - (whole[i] ?? 0))))).toBeLessThan(
      1e-6,
    );
  });

  it('returns a view of one reused buffer for each 128-frame block', () => {
    const resample = createResampler(48000, 16000);
    const input = pattern(['speech:100'], 48000);
    const first = resample(input.subarray(0, 128));
    const views = new Set<Float32Array>();
    inPieces(input.subarray(128, 128 * 30), 128, (block) => {
      const out = resample(block);
      expect(out.buffer).toBe(first.buffer);
      views.add(out);
    });
    // 128 / 3 is 42.67: each block gives 42 or 43 samples, one cached view per length.
    expect(views.size).toBeLessThanOrEqual(2);
  });
});

describe('downmix', () => {
  it.each([
    {
      name: 'stereo is averaged',
      channels: [
        [1, 0.5, -1],
        [0, 0.5, 1],
      ],
      expected: [0.5, 0.5, 0],
    },
    { name: 'mono passes through', channels: [[0.25, -0.5, 1]], expected: [0.25, -0.5, 1] },
    { name: 'no input is silence', channels: [], expected: [0, 0, 0] },
  ])('$name', ({ channels, expected }) => {
    const out = new Float32Array(3);
    const mixed = downmix(
      channels.map((samples) => Float32Array.from(samples)),
      out,
    );
    expect(mixed).toBe(out);
    expect(Array.from(mixed)).toEqual(expected);
  });
});
