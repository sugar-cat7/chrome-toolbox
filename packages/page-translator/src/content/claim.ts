import { captureSync } from '@chrome-toolbox/contracts';

/** The mark the running page script leaves on its isolated world's global object. */
const CLAIM = Symbol.for('chrome-toolbox.page-translator');

/**
 * The claim on a page: the running session's `end` (it stops and restores the page at once, then
 * lets go of everything), kept where every later injection into the same world finds it.
 */
type Claim = { end: (() => void) | undefined };

const isClaim = (value: unknown): value is Claim =>
  typeof value === 'object' && value !== null && 'end' in value;

function claimOf(scope: object): Claim | undefined {
  const value: unknown = Reflect.get(scope, CLAIM);
  return isClaim(value) ? value : undefined;
}

/**
 * Claims the page for this page script: true when `scope` (the isolated world's `globalThis`)
 * has no mark yet, which it then gets; false when an earlier injection into the same world holds
 * it, and this one must do nothing.
 */
export function claimPage(scope: object): boolean {
  if (Reflect.has(scope, CLAIM)) return false;
  const claim: Claim = { end: undefined };
  return Reflect.defineProperty(scope, CLAIM, { value: claim, configurable: true });
}

/**
 * Whether the extension of `api` (WXT's `browser`) has ended, by a reload, an update or its
 * removal: an orphaned script's runtime has no id, or none at all, or fails to read it.
 */
export function extensionGone(api: { readonly runtime?: { readonly id?: string } }): boolean {
  const id = captureSync(() => api.runtime?.id, 'ipc_failed');
  return !id.ok || id.value === undefined;
}

/** What one injection of the page script runs with. */
export type Injection = Readonly<{
  /** The isolated world's `globalThis`. */
  scope: object;
  /** Starts the session; returns its end. */
  start: () => () => void;
  /** Whether the extension has ended (`extensionGone`). */
  gone: () => boolean;
  /** WXT's `ctx.onInvalidated` of this injection. */
  onInvalidated: (listener: () => void) => void;
}>;

/**
 * One injection of the page script. The first in its isolated world claims the page, starts the
 * session and keeps its end on the claim. When an injection's WXT context ends:
 * - The extension still runs: the script was injected again (the button pressed again), whose
 *   context ends the one before (P18). The session goes on.
 * - The extension has gone (P28): its new version's script, starting on the page in a fresh
 *   world, ended the context. The session ends at once, the scheduler stopped and the original
 *   text back, so the new script reads the page's own text, not this one's translation. Whichever
 *   injection's context sees it ends the session, found through the claim.
 */
export function runInjection({ scope, start, gone, onInvalidated }: Injection): void {
  if (claimPage(scope)) {
    const end = start();
    const claim = claimOf(scope);
    if (claim !== undefined) claim.end = end;
  }
  onInvalidated(() => {
    if (!gone()) return;
    const claim = claimOf(scope);
    const end = claim?.end;
    if (claim === undefined || end === undefined) return;
    claim.end = undefined;
    end();
  });
}
