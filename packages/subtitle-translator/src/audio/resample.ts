import type { ASR_SAMPLE_RATE } from '@chrome-toolbox/extension-core';

/**
 * extension-core's `ASR_SAMPLE_RATE`, checked against it by type. The audio worklet bundles this
 * module, and importing the value would bundle extension-core's zod schemas with it (~25 kB).
 */
export const PCM_RATE: typeof ASR_SAMPLE_RATE = 16000;
/** Under the 8 kHz Nyquist of the 16 kHz output; one pole only weakens what lies above it. */
const CUTOFF_HZ = 7000;

/** Samples one call can produce from `length` input samples (at most one more than the ratio). */
const capacity = (length: number, step: number) => Math.ceil(length / step) + 1;

/**
 * A streaming resampler: a first-order 7 kHz low-pass (bilinear transform), then linear
 * interpolation. The fractional position and the filter state carry across calls, so 128-frame
 * render blocks resample as one stream.
 *
 * The result is a view of one reused buffer, valid until the next call; a view is kept per length,
 * so steady 128-frame calls allocate nothing. Without room for the cutoff (`inputRate` ≤ 14 kHz)
 * the input is interpolated unfiltered.
 */
export function createResampler(
  inputRate: number,
  outputRate: typeof ASR_SAMPLE_RATE,
): (input: Float32Array) => Float32Array {
  const step = inputRate / outputRate;
  // y[n] = b0·x[n] + b1·x[n−1] − a·y[n−1], prewarped so the −3 dB point is at the cutoff.
  const filters = CUTOFF_HZ < inputRate / 2;
  const k = Math.tan((Math.PI * CUTOFF_HZ) / inputRate);
  const b0 = filters ? k / (1 + k) : 1;
  const b1 = filters ? b0 : 0;
  const a = filters ? (k - 1) / (k + 1) : 0;
  // The previous input and the previous filtered sample (the one before each new one).
  let input1 = 0;
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
      const x = input[i] ?? 0;
      const filtered = b0 * x + b1 * input1 - a * output1;
      while (phase <= 1) {
        out[count] = output1 + (filtered - output1) * phase;
        count += 1;
        phase += step;
      }
      phase -= 1;
      input1 = x;
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
