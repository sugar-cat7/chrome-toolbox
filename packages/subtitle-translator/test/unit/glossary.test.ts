import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { glossaryStore, GLOSSARY_LIMITS, toPromptGlossary } from '../../src/glossary.ts';

afterEach(() => fakeBrowser.reset());
const e = (source: string, target: string) => ({ source, target });
const store = () => glossaryStore(fakeBrowser.storage.local);

describe('glossary', () => {
  it('loads nothing for an unknown streamer', async () => {
    expect(await store().load('UCfixture')).toEqual(Ok([]));
  });

  it.each([
    {
      name: '51 entries',
      entries: Array.from({ length: 51 }, (_, i) => e(`name${i}`, 'x')),
    },
    { name: '33-char source', entries: [e('a'.repeat(33), 'x')] },
    { name: '33-char target', entries: [e('a', 'x'.repeat(33))] },
    { name: 'empty source', entries: [e('  ', 'x')] },
  ])('save refuses $name with input_invalid and keeps nothing', async ({ entries }) => {
    expect(await store().save('UCfixture', entries)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    expect(await store().load('UCfixture')).toEqual(Ok([]));
  });

  it('save keeps the later entry of a repeated source, trimmed', async () => {
    const expected = [e('Fixturo', 'フィクスチューロ')];
    expect(
      await store().save('UCfixture', [e('Fixturo', ''), e(' Fixturo ', 'フィクスチューロ')]),
    ).toEqual(Ok(expected));
    expect(await store().load('UCfixture')).toEqual(Ok(expected));
  });

  it('accepts exactly the limits', async () => {
    const entries = Array.from({ length: GLOSSARY_LIMITS.entries }, (_, i) =>
      e(`${i}`.padEnd(GLOSSARY_LIMITS.chars, 'a'), ''),
    );
    expect((await store().save('UCfixture', entries)).ok).toBe(true);
  });

  it('removes the oldest streamer key when the 101st streamer is saved', async () => {
    const glossary = store();
    for (let i = 0; i < 101; i += 1) await glossary.save(`UC${i}`, [e('Fixturo', '')]);
    const stored = await fakeBrowser.storage.local.get(null);
    const index = z.array(z.string()).parse(stored['glossary:index']);
    expect(index).toHaveLength(100);
    expect(index[0]).toBe('UC1');
    expect(stored['glossary:UC0']).toBeUndefined();
    expect(stored['glossary:UC100']).toBeDefined();
    expect(await glossary.load('UC0')).toEqual(Ok([]));
  });

  it('saving a streamer again moves it to the newest place without a duplicate', async () => {
    const glossary = store();
    await glossary.save('UCa', [e('A', '')]);
    await glossary.save('UCb', [e('B', '')]);
    await glossary.save('UCa', [e('A2', '')]);
    expect((await fakeBrowser.storage.local.get('glossary:index'))['glossary:index']).toEqual([
      'UCb',
      'UCa',
    ]);
  });

  it('rejects an empty streamer key', async () => {
    expect(await store().save('', [])).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
  });

  it('toPromptGlossary keeps an untranslated name as itself', () => {
    expect(toPromptGlossary([e('Fixturo', ''), e('Quest', 'クエスト')])).toEqual([
      e('Fixturo', 'Fixturo'),
      e('Quest', 'クエスト'),
    ]);
  });
});
