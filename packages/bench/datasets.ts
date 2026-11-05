import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const sampleLangs = ['en', 'id', 'ko', 'es', 'zh', 'mixed'] as const;
export const sampleKinds = ['speech', 'chat'] as const;
export type TextSample = {
  id: string;
  lang: (typeof sampleLangs)[number];
  kind: (typeof sampleKinds)[number];
  text: string;
  /** The `*.jsonl` file the sample came from. */
  file?: string;
};

type Fields = Record<string, unknown>;

/** Reads a JSONL file; one non-blank line is one record, errors name `file:line`. */
function readJsonl<T>(file: string, parse: (fields: Fields, where: string) => T): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (line.trim() === '') return [];
      const where = `${path.basename(file)}:${index + 1}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${where}: invalid JSON`);
      }
      if (typeof value !== 'object' || value === null) throw new Error(`${where}: not an object`);
      return [parse(value as Fields, where)];
    });
}

function parseText({ id, lang, kind, text }: Fields, where: string): TextSample {
  if (typeof id !== 'string' || id === '') throw new Error(`${where}: id must be a string`);
  const knownLang = sampleLangs.find((candidate) => candidate === lang);
  if (knownLang === undefined) throw new Error(`${where}: unknown lang`);
  const knownKind = sampleKinds.find((candidate) => candidate === kind);
  if (knownKind === undefined) throw new Error(`${where}: unknown kind`);
  if (typeof text !== 'string' || text === '') throw new Error(`${where}: text must be a string`);
  return { id, lang: knownLang, kind: knownKind, text };
}

/** Reads every `*.jsonl` in a directory (sorted by name); one line is one sample. */
export function loadTextSamples(dir: string): TextSample[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  return files.flatMap((name) =>
    readJsonl(path.join(dir, name), parseText).map((sample) => ({ ...sample, file: name })),
  );
}

export type AudioSample = {
  id: string;
  lang: (typeof sampleLangs)[number];
  voice: string;
  transcript: string;
};

function parseAudio({ id, lang, voice, transcript }: Fields, where: string): AudioSample {
  if (typeof id !== 'string' || id === '') throw new Error(`${where}: id must be a string`);
  const knownLang = sampleLangs.find((candidate) => candidate === lang);
  if (knownLang === undefined) throw new Error(`${where}: unknown lang`);
  if (typeof voice !== 'string') throw new Error(`${where}: voice must be a string`);
  if (typeof transcript !== 'string' || transcript === '')
    throw new Error(`${where}: transcript must be a string`);
  return { id, lang: knownLang, voice, transcript };
}

/** Reads an audio manifest (`*.jsonl`); one line is one sample. */
export function loadAudioSamples(file: string): AudioSample[] {
  return readJsonl(file, parseAudio);
}

/** A chat comment and whether it is abusive (the expected Clef answer). */
export type ClefSample = { text: string; toxic: boolean };

function parseClef({ text, toxic }: Fields, where: string): ClefSample {
  if (typeof text !== 'string' || text === '') throw new Error(`${where}: text must be a string`);
  if (typeof toxic !== 'boolean') throw new Error(`${where}: toxic must be a boolean`);
  return { text, toxic };
}

/** Reads labelled comments (`*.jsonl`); one line is `{ text, toxic }`. */
export function loadClefSamples(file: string): ClefSample[] {
  return readJsonl(file, parseClef);
}
