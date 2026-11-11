import { describe, expect, it } from 'vitest';
import { extensionTarget, type TargetEntry } from './targets.ts';

const ID = 'aoiiiipkbkbchdbfibagfokaijoohche';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const target = (type: string, url: string, targetId = url): TargetEntry => ({
  targetId,
  type,
  url,
});
// What Chromium lists while the offscreen document is open (seen in Task 15 Step 0).
const BROWSER = [
  target('service_worker', `chrome-extension://${ID}/background.js`),
  target('browser_ui', 'chrome://omnibox-popup.top-chrome/'),
  target('page', 'about:blank'),
  target('tab', 'https://www.youtube.com/watch?v=fixtureAud1'),
];

describe('extensionTarget', () => {
  for (const { name, targets, expected } of [
    {
      name: 'the offscreen document, listed as a background page',
      targets: [...BROWSER, target('background_page', `chrome-extension://${ID}/offscreen.html`)],
      expected: `chrome-extension://${ID}/offscreen.html`,
    },
    {
      name: 'with a query or hash',
      targets: [
        ...BROWSER,
        target('background_page', `chrome-extension://${ID}/offscreen.html?a#b`),
      ],
      expected: `chrome-extension://${ID}/offscreen.html?a#b`,
    },
    { name: 'none while it is closed', targets: BROWSER, expected: undefined },
    {
      name: "not another extension's",
      targets: [
        ...BROWSER,
        target('background_page', `chrome-extension://${OTHER}/offscreen.html`),
      ],
      expected: undefined,
    },
    {
      name: 'not another path of the extension',
      targets: [
        ...BROWSER,
        target('page', `chrome-extension://${ID}/sidepanel.html`),
        target('page', `chrome-extension://${ID}/offscreen.html.bak`),
        target('page', `chrome-extension://${ID}/x/offscreen.html`),
      ],
      expected: undefined,
    },
    {
      name: 'not a web page that names it',
      targets: [
        ...BROWSER,
        target('page', `https://example.test/chrome-extension://${ID}/offscreen.html`),
        target('page', `https://${ID}/offscreen.html`),
      ],
      expected: undefined,
    },
  ]) {
    it(`finds ${name}`, () => {
      expect(extensionTarget(targets, ID, '/offscreen.html')?.url).toBe(expected);
    });
  }

  it('refuses two documents at the path', () => {
    const twice = [
      target('background_page', `chrome-extension://${ID}/offscreen.html`, 'A'),
      target('page', `chrome-extension://${ID}/offscreen.html`, 'B'),
    ];
    expect(() => extensionTarget(twice, ID, '/offscreen.html')).toThrow(/2 targets/u);
  });
});
