/**
 * Synthetic audio for the audio tests: seeded noise and sine tones only (this repository is public;
 * no recordings).
 */

/** The RMS of `silence`: room noise well under the VAD's `minRms`. */
export const SILENCE_RMS = 0.0005;
/** The RMS of `speech`: noise far above the floor. */
export const SPEECH_RMS = 0.1;

type Kind = 'silence' | 'speech' | 'tone';
export type Part = `${Kind}:${number}`;

/** Mulberry32: the same sequence for the same seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform noise with the given RMS (a uniform in ±a has RMS a/√3). */
export function noise(samples: number, rms: number, random: () => number): Float32Array {
  const amplitude = rms * Math.sqrt(3);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = (2 * random() - 1) * amplitude;
  return out;
}

export function tone(samples: number, rate: number, hz: number, amplitude: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/**
 * `['silence:200', 'speech:600']` at `rate`: `silence` is noise at RMS 0.0005, `speech` noise at
 * RMS 0.1 and `tone` a steady 440 Hz sine (background music at one level).
 */
export function pattern(parts: readonly Part[], rate: number, seed = 1): Float32Array {
  const random = seeded(seed);
  const pieces = parts.map((part) => {
    const [kind, ms] = part.split(':');
    const samples = Math.round((Number(ms) * rate) / 1000);
    if (kind === 'tone') return tone(samples, rate, 440, 0.1);
    return noise(samples, kind === 'speech' ? SPEECH_RMS : SILENCE_RMS, random);
  });
  const out = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Calls `step` with consecutive `size`-sample pieces of `samples` (the last may be shorter). */
export function inPieces(
  samples: Float32Array,
  size: number,
  step: (piece: Float32Array) => void,
): void {
  for (let at = 0; at < samples.length; at += size) step(samples.subarray(at, at + size));
}
