// The synthetic speech of the audio path's browser tests: a WAV made in the test, never a file in
// the repository (public repo: no recorded audio). The VAD takes each tone as one utterance and
// each silence as its end; the llama.cpp stub answers every recognition with a made-up line.

/** 48 kHz, 16-bit mono PCM: 220 Hz sawtooth for 600 ms, then 500 ms of silence, repeated. */
export const TONES = { sampleRate: 48_000, hz: 220, toneMs: 600, silenceMs: 500 } as const;
/** One tone and its silence, in ms. */
export const TONE_PERIOD_MS = TONES.toneMs + TONES.silenceMs;
/** The sawtooth's peak: well above the VAD's floor, far from clipping. */
const PEAK = 0.3;

/** A WAV (RIFF, PCM 16-bit mono at 48 kHz) of `periods` tones, each followed by its silence. */
export function toneWav(periods: number): Buffer {
  const { sampleRate, hz, toneMs, silenceMs } = TONES;
  const toneSamples = (sampleRate * toneMs) / 1000;
  const periodSamples = toneSamples + (sampleRate * silenceMs) / 1000;
  const samples = periodSamples * periods;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // bytes a second
  wav.writeUInt16LE(2, 32); // bytes a frame
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const inPeriod = i % periodSamples;
    const phase = ((inPeriod * hz) / sampleRate) % 1;
    const value = inPeriod < toneSamples ? PEAK * (2 * phase - 1) : 0;
    wav.writeInt16LE(Math.round(value * 32_767), 44 + i * 2);
  }
  return wav;
}
