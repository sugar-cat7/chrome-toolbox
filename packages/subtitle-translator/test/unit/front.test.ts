// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchFront, type FrontState } from '../../src/front.ts';
import type { DisplayMode } from '../../src/settings.ts';
import { fakeVideo } from './video.ts';
import { fakeViewport } from './viewport.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** `state` or `state:reason`, as the table writes it. */
const label = (front: FrontState | undefined): string | undefined =>
  front === undefined
    ? undefined
    : front.reason === undefined
      ? front.state
      : `${front.state}:${front.reason}`;

function start() {
  const viewport = fakeViewport();
  const player = document.createElement('div');
  player.id = 'movie_player';
  const playback = fakeVideo();
  player.append(playback.video);
  document.body.append(player);
  let display: DisplayMode = 'both';
  const onChange = vi.fn<(state: FrontState) => void>();
  const front = watchFront({
    doc: document,
    player,
    video: playback.video,
    display: () => display,
    onChange,
  });
  const events = {
    play: () => playback.play(),
    pause: () => playback.pause(),
    end: () => playback.end(),
    mute: () => playback.mute(true),
    unmute: () => playback.mute(false),
    volume0: () => playback.setVolume(0),
    hidden: () => playback.visibility('hidden'),
    visible: () => playback.visibility('visible'),
    pagehide: () => window.dispatchEvent(new Event('pagehide')),
    ad: () => player.classList.add('ad-showing'),
    offscreen: () => viewport.report(player, { width: 0, height: 0, isIntersecting: false }),
    edge: () => viewport.report(player, { width: 0, height: 0, isIntersecting: true }),
    onscreen: () => viewport.report(player, { width: 1280, height: 720 }),
    'display-off': () => {
      display = 'off';
      front.displayChanged();
    },
    waiting: () => playback.video.dispatchEvent(new Event('waiting')),
  } as const;
  return {
    player,
    playback,
    viewport,
    front,
    onChange,
    events,
    /** Runs the events in order and lets the player's class observer see each one. */
    run: async (names: readonly (keyof typeof events)[]) => {
      for (const name of names) {
        events[name]();
        await Promise.resolve();
      }
    },
    states: () => onChange.mock.calls.map(([state]) => label(state)),
  };
}

describe('front of the viewer', () => {
  it.each([
    { name: '再生中', events: ['play'], expected: 'active' },
    { name: '一時停止', events: ['play', 'pause'], expected: 'pause:paused' },
    { name: '終了', events: ['play', 'end'], expected: 'pause:paused' },
    { name: 'ミュート', events: ['play', 'mute'], expected: 'pause:muted' },
    { name: '音量 0', events: ['play', 'volume0'], expected: 'pause:muted' },
    { name: '裏のタブ', events: ['play', 'hidden'], expected: 'away:hidden' },
    { name: 'ページを離れる', events: ['play', 'pagehide'], expected: 'away:hidden' },
    { name: '広告', events: ['play', 'ad'], expected: 'away:ad' },
    { name: 'プレイヤーが画面外', events: ['play', 'offscreen'], expected: 'away:offscreen' },
    { name: '画面の端に接するだけ', events: ['play', 'edge'], expected: 'away:offscreen' },
    { name: '画面に戻る', events: ['play', 'offscreen', 'onscreen'], expected: 'active' },
    { name: '表示オフ', events: ['play', 'display-off'], expected: 'away:display-off' },
    { name: '広告中に一時停止', events: ['play', 'ad', 'pause'], expected: 'away:ad' },
    { name: 'ミュートで裏のタブ', events: ['play', 'mute', 'hidden'], expected: 'away:hidden' },
    { name: 'バッファ中', events: ['play', 'waiting'], expected: 'active' },
  ] as const)('front: $name', async ({ events, expected }) => {
    const { run, onChange } = start();
    await run(events);
    expect(label(onChange.mock.lastCall?.[0])).toBe(expected);
  });

  it('reports only changes and removes every listener and observer on stop', async () => {
    // Each listener added or removed, as its target, type and function.
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const added = () =>
      add.mock.calls.map(([type, listener], i) => [add.mock.contexts[i], type, listener]);
    const removed = () =>
      remove.mock.calls.map(([type, listener], i) => [remove.mock.contexts[i], type, listener]);
    const { run, front, viewport, states, onChange, player } = start();
    // The state at the start is reported once: the video has not started.
    expect(states()).toEqual(['pause:paused']);
    await run(['play', 'waiting', 'onscreen', 'unmute', 'visible']);
    player.classList.add('ytp-autohide');
    await Promise.resolve();
    expect(states()).toEqual(['pause:paused', 'active']);
    expect(viewport.observed()).toBe(1);
    expect(added().length).toBeGreaterThan(0);

    front.stop();
    expect(viewport.observed()).toBe(0);
    expect(removed()).toEqual(expect.arrayContaining(added()));
    onChange.mockClear();
    await run(['pause', 'mute', 'hidden', 'pagehide', 'ad', 'offscreen', 'display-off']);
    expect(onChange).not.toHaveBeenCalled();
  });
});
