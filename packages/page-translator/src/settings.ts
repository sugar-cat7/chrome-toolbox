import { z } from 'zod/mini';
import {
  capture,
  captureSync,
  decode,
  Err,
  failure,
  Ok,
  type Result,
} from '@chrome-toolbox/contracts';
import type { StorageArea } from '@chrome-toolbox/extension-core';
import { DISPLAY_MODES, PAGE_TRANSLATORS } from './protocol.ts';

/**
 * - `always`: sites translated as soon as they open, at most this many;
 * - `never`: sites never translated, at most this many;
 * - `host`: the longest host name (DNS: 253 characters).
 */
export const PAGE_SETTINGS_LIMITS = { always: 200, never: 500, host: 253 } as const;
/** The longest `always` entry: `https://`, a host name and `/*`. */
const PATTERN_LENGTH = 'https://'.length + PAGE_SETTINGS_LIMITS.host + '/*'.length;

/**
 * The viewer's page choices, the same in every tab: how translations show (`mode`), who
 * translates (`translator`: `gemma` is the shared settings' `models.translate`, `plamo` the fixed
 * `PLAMO_TRANSLATE_MODEL`, P5), the sites translated as they open (`always`, match patterns) and
 * the sites never translated (`never`, host names). The llama.cpp URL and the models stay in
 * extension-core's settings (key `settings`).
 */
export const pageSettingsSchema = z.strictObject({
  v: z.literal(1),
  mode: z.enum(DISPLAY_MODES),
  translator: z.enum(PAGE_TRANSLATORS),
  always: z
    .array(z.string().check(z.maxLength(PATTERN_LENGTH)))
    .check(z.maxLength(PAGE_SETTINGS_LIMITS.always)),
  never: z
    .array(z.string().check(z.maxLength(PAGE_SETTINGS_LIMITS.host)))
    .check(z.maxLength(PAGE_SETTINGS_LIMITS.never)),
});
export type PageSettings = z.infer<typeof pageSettingsSchema>;
/** Gemma translates until the page bench (Task 3) decides for PLaMo. */
export const defaultPageSettings: PageSettings = {
  v: 1,
  mode: 'replace',
  translator: 'gemma',
  always: [],
  never: [],
};

/**
 * A site as the page settings name it: `host` (the lower-case host name, for the never list) and
 * `pattern` (`<protocol>//<host>/*`, the match pattern of the always list and of the host
 * permission Chrome grants for it).
 */
export type Site = Readonly<{ host: string; pattern: string }>;

/** An IPv6 address as URL writes it, in brackets. */
const IPV6_HOST = /^\[[\d.:a-f]+\]$/u;
/** One label of a host name or a part of an IPv4 address (URL has lowered the letters). */
const HOST_LABEL = /^[\w-]{1,63}$/u;
/**
 * Whether `host` (from URL, without a trailing dot) is a host name or an address. A `*` or any
 * other sign would make a match pattern for more than one site.
 */
const isHostName = (host: string): boolean =>
  IPV6_HOST.test(host) ||
  (host.length <= PAGE_SETTINGS_LIMITS.host &&
    host.split('.').every((label) => HOST_LABEL.test(label)));
const withoutTrailingDot = (host: string): string => host.replace(/\.$/u, '');

/**
 * The site of a page at `url`. Only `http:` and `https:` pages are sites; any other page (the
 * browser's, a file, another extension's) is `page_restricted`.
 */
export function siteOf(url: string): Result<Site> {
  const parsed = captureSync(() => new URL(url), 'page_restricted');
  if (!parsed.ok) return parsed;
  const { protocol, hostname } = parsed.value;
  if ((protocol !== 'http:' && protocol !== 'https:') || !isHostName(withoutTrailingDot(hostname)))
    return Err(failure('page_restricted'));
  return Ok({ host: hostname, pattern: `${protocol}//${hostname}/*` });
}

/**
 * The host name in what the viewer typed into the options page's never list: a bare name, or a
 * URL whose scheme, port, path and trailing dot are dropped. Anything else is `input_invalid`.
 */
export function normalizeHost(input: string): Result<string> {
  const text = input.trim();
  const url = /^[a-z][\d+.a-z-]*:\/\//iu.test(text) ? text : `https://${text}`;
  const parsed = captureSync(() => new URL(url), 'input_invalid');
  if (!parsed.ok) return parsed;
  const { protocol, hostname } = parsed.value;
  const host = withoutTrailingDot(hostname);
  if ((protocol !== 'http:' && protocol !== 'https:') || !isHostName(host))
    return Err(failure('input_invalid'));
  return Ok(host);
}

/**
 * The entry of `never` for a parent domain of `host` (the first in the list), if any. It covers
 * other sites too, so lifting it for one site is the options page's to do (P29).
 */
export function parentExclusion(host: string, never: readonly string[]): string | undefined {
  const name = withoutTrailingDot(host);
  return never.find((entry) => name.endsWith(`.${entry}`));
}

/**
 * The entry of `never` that excludes `host`: a parent domain's entry first (`parentExclusion`),
 * since taking the host's own entry off leaves a parent's in force; else the host's own.
 */
export function excludedBy(host: string, never: readonly string[]): string | undefined {
  const name = withoutTrailingDot(host);
  return parentExclusion(host, never) ?? never.find((entry) => entry === name);
}

/** Whether `host` is excluded: it is an entry of `never`, or a subdomain of one. */
export function isNever(host: string, never: readonly string[]): boolean {
  return excludedBy(host, never) !== undefined;
}

/** Whether the page at `url` is on a site of the always list (the same scheme and host). */
export function isAlways(url: string, always: readonly string[]): boolean {
  const site = siteOf(url);
  return site.ok && always.includes(site.value.pattern);
}

export type PageSettingsStore = {
  load(this: void): Promise<Result<PageSettings>>;
  save(this: void, settings: PageSettings): Promise<Result<PageSettings>>;
};

/** The page choices in extension storage under `key`; the defaults until something is saved. */
export function pageSettingsStore(area: StorageArea, key = 'page'): PageSettingsStore {
  return {
    load: async (): Promise<Result<PageSettings>> => {
      const stored = await capture(() => area.get(key), 'storage_failed');
      if (!stored.ok) return stored;
      const value = stored.value[key];
      return value === undefined ? Ok(defaultPageSettings) : decode(pageSettingsSchema, value);
    },
    save: async (settings): Promise<Result<PageSettings>> => {
      const parsed = pageSettingsSchema.safeParse(settings);
      if (!parsed.success) return Err(failure('input_invalid'));
      const written = await capture(() => area.set({ [key]: parsed.data }), 'storage_failed');
      return written.ok ? Ok(parsed.data) : written;
    },
  };
}
