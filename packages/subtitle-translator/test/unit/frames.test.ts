// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncFrames } from '../../src/overlay/frames.ts';
import { fakeVideo } from './video.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function start() {
  const player = document.createElement('div');
  player.id = 'movie_player';
  const playback = fakeVideo();
  player.append(playback.video);
  document.body.append(player);
  const onFrame = vi.fn<(ms: number) => void>();
  const sync = syncFrames({ doc: document, player, video: playback.video, onFrame });
  return { player, playback, onFrame, sync };
}
/** Lets the player's class observer see a change. */
const observed = () => Promise.resolve();

describe('frame sync', () => {
  it('reads the playback position of every frame while the video plays', () => {
    const { playback, onFrame, sync } = start();
    expect(sync.running()).toBe(false);
    expect(playback.waiting()).toBe(0);
    playback.play();
    expect(sync.running()).toBe(true);
    playback.frame(1_500);
    playback.frame(1_516.5);
    expect(onFrame.mock.calls).toEqual([[1_500], [1_516.5]]);
    expect(playback.waiting()).toBe(1);
  });

  it.each([
    { name: '一時停止', act: 'pause' },
    { name: '終了', act: 'end' },
    { name: '広告', act: 'ad' },
    { name: '裏のタブ', act: 'hide' },
  ] as const)('stops on $name and starts again', async ({ act }) => {
    const { player, playback, onFrame, sync } = start();
    playback.play();
    if (act === 'pause') playback.pause();
    if (act === 'end') playback.end();
    if (act === 'ad') player.classList.add('ad-showing');
    if (act === 'hide') playback.visibility('hidden');
    await observed();
    expect(sync.running()).toBe(false);
    expect(playback.waiting()).toBe(0);
    playback.frame(2_000);
    expect(onFrame).not.toHaveBeenCalled();
    if (act === 'ad') player.classList.remove('ad-showing');
    if (act === 'hide') playback.visibility('visible');
    if (act === 'pause' || act === 'end') playback.play();
    await observed();
    expect(sync.running()).toBe(true);
    playback.frame(2_500);
    expect(onFrame.mock.calls).toEqual([[2_500]]);
  });

  it('shows the position a paused video was moved to', () => {
    const { playback, onFrame } = start();
    playback.seek(42_000);
    expect(onFrame.mock.calls).toEqual([[42_000]]);
  });

  it('does not read the position of an ad', async () => {
    const { player, playback, onFrame } = start();
    player.classList.add('ad-showing');
    await observed();
    playback.seek(5_000);
    playback.play();
    playback.frame(5_100);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('waits for one frame at a time, however many playback events come', () => {
    const { playback, sync } = start();
    playback.play();
    playback.video.dispatchEvent(new Event('playing'));
    playback.video.dispatchEvent(new Event('play'));
    expect(playback.waiting()).toBe(1);
    playback.pause();
    playback.video.dispatchEvent(new Event('pause'));
    expect(sync.running()).toBe(false);
    expect(playback.waiting()).toBe(0);
  });

  it('removes every listener and observer and cancels the frame request on stop', async () => {
    const { player, playback, onFrame, sync } = start();
    playback.play();
    sync.stop();
    expect(playback.waiting()).toBe(0);
    expect(sync.running()).toBe(false);
    playback.pause();
    playback.play();
    playback.seek(3_000);
    player.classList.add('ad-showing');
    playback.visibility('hidden');
    await observed();
    playback.frame(3_000);
    expect(onFrame).not.toHaveBeenCalled();
    expect(sync.running()).toBe(false);
    expect(playback.waiting()).toBe(0);
  });
});
