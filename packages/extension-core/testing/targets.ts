// Finding an extension's own documents among the browser's DevTools targets (CDP
// `Target.getTargets`). Node only, like the rest of testing/: the Playwright fixtures attach to
// what this finds.

/** The part of a CDP `TargetInfo` the search reads. */
export type TargetEntry = Readonly<{ targetId: string; type: string; url: string }>;

/**
 * The target of the extension's document at `path` (`/offscreen.html`): the one whose URL is
 * `chrome-extension://<extensionId><path>`, with or without a query or hash. Chrome lists an
 * offscreen document as a `background_page`, which Playwright does not attach to (it is in neither
 * `context.pages()` nor `context.backgroundPages()`). Another extension's document, a page that
 * only links to the path and a path that merely starts the same are not it. Undefined when there
 * is none; an error when two match, since the test would not know which it measures.
 */
export function extensionTarget(
  targets: readonly TargetEntry[],
  extensionId: string,
  path: `/${string}`,
): TargetEntry | undefined {
  const found = targets.filter((target) => {
    const url = URL.parse(target.url);
    // `origin` is "null" for a scheme the URL standard does not know, so the parts are compared.
    return (
      url?.protocol === 'chrome-extension:' && url.host === extensionId && url.pathname === path
    );
  });
  if (found.length > 1)
    throw new Error(
      `${found.length} targets show chrome-extension://${extensionId}${path}; expected at most one`,
    );
  return found[0];
}
