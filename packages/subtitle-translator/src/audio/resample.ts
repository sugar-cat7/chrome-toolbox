import type { ASR_SAMPLE_RATE } from '@chrome-toolbox/extension-core';

/**
 * extension-core's `ASR_SAMPLE_RATE`, checked against it by type. The audio worklet bundles this
 * module, and importing the value would bundle extension-core's zod schemas with it (~25 kB).
 */
export const PCM_RATE: typeof ASR_SAMPLE_RATE = 16000;
/**
 * The −3 dB point of the anti-aliasing low-pass, under the 8 kHz Nyquist of the 16 kHz output. A
 * 4th-order Butterworth at 7 kHz leaves a 10 kHz tone (whose alias lands at 6 kHz) only ~15.5 dB
 * down at 48 kHz. At 6 kHz it is 21.5 dB down at 48 kHz and 23.7 dB at 44.1 kHz, while 3 kHz stays
 * within 0.2 dB after resampling (measured, 2026-11-09).
 */
const CUTOFF_HZ = 6000;
/** The Qs of a 4th-order Butterworth's two sections: 1 / (2 sin((2k − 1)π / 8)), k = 1, 2. */
const BUTTERWORTH_Q1 = 1 / (2 * Math.sin(Math.PI / 8));
const BUTTERWORTH_Q2 = 1 / (2 * Math.sin((3 * Math.PI) / 8));

/**
 * One low-pass biquad by the bilinear transform (the Audio EQ Cookbook's LPF), transposed direct
 * form II; its two state values carry from call to call.
 */
function lowPass(cutoffHz: number, rate: number, q: number): (x: number) => number {
  const w = (2 * Math.PI * cutoffHz) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - Math.cos(w)) / 2 / a0;
  const b1 = (1 - Math.cos(w)) / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let z1 = 0;
  let z2 = 0;
  return (x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    // b2 equals b0 in a low-pass.
    z2 = b0 * x - a2 * y;
    return y;
  };
}

/** Samples one call can produce from `length` input samples (at most one more than the ratio). */
const capacity = (length: number, step: number) => Math.ceil(length / step) + 1;

/**
 * A streaming resampler: a 4th-order Butterworth low-pass at 6 kHz (two biquads designed for
 * `inputRate`), then linear interpolation. The fractional position and the filter state carry
 * across calls, so 128-frame render blocks resample as one stream.
 *
 * The result is a view of one reused buffer, valid until the next call; a view is kept per length,
 * so steady 128-frame calls allocate nothing. Without room for the cutoff (`inputRate` ≤ 12 kHz)
 * the input is interpolated unfiltered.
 */
export function createResampler(
  inputRate: number,
  outputRate: typeof ASR_SAMPLE_RATE,
): (input: Float32Array) => Float32Array {
  const step = inputRate / outputRate;
  const filters = CUTOFF_HZ < inputRate / 2;
  const first = filters ? lowPass(CUTOFF_HZ, inputRate, BUTTERWORTH_Q1) : (x: number) => x;
  const second = filters ? lowPass(CUTOFF_HZ, inputRate, BUTTERWORTH_Q2) : (x: number) => x;
  /** The filtered sample before each new one. */
  let output1 = 0;
  // From the previous filtered sample to the next output position, in input samples; the first
  // output falls on the first input sample.
  let phase = 1;
  let out = new Float32Array(capacity(128, step));
  let views: Float32Array[] = [];
  return (input) => {
    if (capacity(input.length, step) > out.length) {
      out = new Float32Array(capacity(input.length, step));
      views = [];
    }
    let count = 0;
    for (let i = 0; i < input.length; i += 1) {
      const filtered = second(first(input[i] ?? 0));
      while (phase <= 1) {
        out[count] = output1 + (filtered - output1) * phase;
        count += 1;
        phase += step;
      }
      phase -= 1;
      output1 = filtered;
    }
    return (views[count] ??= out.subarray(0, count));
  };
}

/** Averages the channels into `out` (silence without channels) and returns `out`. */
export function downmix(channels: readonly Float32Array[], out: Float32Array): Float32Array {
  const scale = channels.length ? 1 / channels.length : 0;
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels.length; c += 1) sum += channels[c]?.[i] ?? 0;
    out[i] = sum * scale;
  }
  return out;
}
