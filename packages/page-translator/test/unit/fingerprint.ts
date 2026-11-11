/**
 * What `root` shows, one line per node in document order: `root` and the open shadow roots under
 * it, each node's type, name, attributes (sorted) and text, indented by depth. Two equal
 * fingerprints mean the same nodes in the same places with the same content. The jsdom twin of
 * `fingerprint` in `test/browser/page.ts`, by the same rules.
 */
export function fingerprint(root: Node): string {
  const lines: string[] = [];
  const visit = (node: Node, depth: number): void => {
    const attributes =
      node instanceof Element
        ? [...node.attributes]
            .map(({ name, value }) => `${name}=${JSON.stringify(value)}`)
            .toSorted()
            .join(' ')
        : '';
    const text = node instanceof CharacterData ? JSON.stringify(node.data) : '';
    lines.push(`${'  '.repeat(depth)}${node.nodeType} ${node.nodeName} ${attributes} ${text}`);
    // `shadowRoot` is null for a closed shadow root: only open ones are walked.
    if (node instanceof Element && node.shadowRoot !== null) visit(node.shadowRoot, depth + 1);
    for (const child of node.childNodes) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines.join('\n');
}
