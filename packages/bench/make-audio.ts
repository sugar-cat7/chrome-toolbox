import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadAudioSamples } from './datasets.ts';
import { fromRoot } from './paths.ts';

/** Voice names from `say -v '?'` (the name is everything before the locale column). */
export function parseVoices(listing: string): Set<string> {
  return new Set(
    listing.split('\n').flatMap((line) => {
      const name = /^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]+\s/u.exec(line)?.[1];
      return name === undefined ? [] : [name.trim()];
    }),
  );
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      manifest: { type: 'string', default: 'packages/bench/fixtures/audio.jsonl' },
      out: { type: 'string', default: 'bench-data/audio' },
    },
  });
  const samples = loadAudioSamples(fromRoot(values.manifest));
  const voices = parseVoices(execFileSync('say', ['-v', '?'], { encoding: 'utf8' }));
  mkdirSync(fromRoot(values.out), { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir(), 'make-audio-'));
  let written = 0;
  try {
    for (const sample of samples) {
      if (!voices.has(sample.voice)) {
        console.warn(`skip ${sample.id}: voice "${sample.voice}" is not installed`);
        continue;
      }
      const aiff = path.join(tmp, `${sample.id}.aiff`);
      const wav = path.join(fromRoot(values.out), `${sample.id}.wav`);
      execFileSync('say', ['-v', sample.voice, '-o', aiff, sample.transcript]);
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
      written += 1;
      console.log(`wrote ${wav}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${written}/${samples.length} clips in ${values.out}`);
}

if (import.meta.main)
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
