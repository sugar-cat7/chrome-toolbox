/** The mark the running page script leaves on its isolated world's global object. */
const CLAIM = Symbol.for('chrome-toolbox.page-translator');

/**
 * Claims the page for this page script: true when `scope` (the isolated world's `globalThis`)
 * has no mark yet, which it then gets; false when an earlier injection into the same world holds
 * it, and this one must do nothing.
 */
export function claimPage(scope: object): boolean {
  if (Reflect.has(scope, CLAIM)) return false;
  return Reflect.defineProperty(scope, CLAIM, { value: true, configurable: true });
}
