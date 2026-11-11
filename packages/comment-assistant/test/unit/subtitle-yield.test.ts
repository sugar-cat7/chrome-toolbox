import { describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createSubtitleYield,
  slotZeroBusy,
  SUBTITLE_YIELD,
  type SubtitleYield,
} from '../../src/subtitle-yield.ts';
import { fakeClock } from './fake-clock.ts';

const START = 1_800_000_000_000;

type Probe = (signal: AbortSignal) => Promise<Result<boolean>>;

/** A probe whose answers the test gives by hand, in order. */
const manualProbe = () => {
  const calls: { signal: AbortSignal; answer: (result: Result<boolean>) => void }[] = [];
  const probe = vi.fn<Probe>(
    (signal) =>
      new Promise<Result<boolean>>((resolve) => {
        calls.push({ signal, answer: resolve });
      }),
  );
  return { probe, calls };
};

const setup = (probe: Probe) => {
  const clock = fakeClock(START);
  const changed = vi.fn<() => void>();
  const subtitles: SubtitleYield = createSubtitleYield({
    probe,
    now: clock.now,
    timers: clock.timers,
    changed,
  });
  return { clock, changed, subtitles };
};

/** Lets the probe's answer reach the yield (it settles a few microtasks later). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('subtitle yield', () => {
  it('uses the values of ruling S37', () => {
    expect(SUBTITLE_YIELD).toEqual({
      busyWindowMs: 15_000,
      probeTtlMs: 1_500,
      probeTimeoutMs: 1_000,
    });
  });

  it.each([
    { name: '枠 0 が処理中', answer: Ok(true), limit: 1 },
    { name: '枠 0 が空き', answer: Ok(false), limit: 2 },
    { name: '問い合わせの失敗', answer: Err(failure('network_failed')), limit: 2 },
    { name: '枠 0 のない答え', answer: Err(failure('response_invalid')), limit: 2 },
  ])('limit(2) once the probe answers: $name → $limit', async ({ answer, limit }) => {
    const { probe, calls } = manualProbe();
    const { changed, subtitles } = setup(probe);
    expect(subtitles.limit(2)).toBe(1);
    expect(subtitles.limit(2)).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    calls[0]?.answer(answer);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(subtitles.limit(2)).toBe(limit);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('stays at 1 until 15 s after slot 0 was last seen processing', async () => {
    const { probe, calls } = manualProbe();
    const { clock, changed, subtitles } = setup(probe);
    subtitles.limit(2);
    calls[0]?.answer(Ok(true));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(subtitles.limit(2)).toBe(1);
    // Every 1.5 s a fresh probe says slot 0 is idle.
    for (let at = 1_500; at <= 15_000; at += 1_500) {
      clock.advance(1_500);
      expect(subtitles.limit(2)).toBe(1);
      calls.at(-1)?.answer(Ok(false));
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(at / 1_500 + 1));
      expect(subtitles.limit(2)).toBe(at < 15_000 ? 1 : 2);
    }
    expect(probe).toHaveBeenCalledTimes(11);
  });

  it('asks at most once per 1.5 s however often it is called', async () => {
    const probe = vi.fn<Probe>(async () => Ok(false));
    const { clock, subtitles } = setup(probe);
    for (let i = 0; i < 100; i += 1) {
      subtitles.limit(2);
      await settle();
      clock.advance(i === 99 ? 0 : 15);
    }
    expect(clock.now() - START).toBeLessThan(1_500);
    expect(probe).toHaveBeenCalledTimes(1);
    clock.advance(1_500 - (clock.now() - START));
    subtitles.limit(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a probe without an answer after 1 s as failed and aborts it', async () => {
    const { probe, calls } = manualProbe();
    const { clock, changed, subtitles } = setup(probe);
    expect(subtitles.limit(2)).toBe(1);
    clock.advance(999);
    expect(calls[0]?.signal.aborted).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    clock.advance(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(subtitles.limit(2)).toBe(2);
    // The late answer is thrown away.
    calls[0]?.answer(Ok(true));
    await settle();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(subtitles.limit(2)).toBe(2);
    expect(clock.active()).toBe(0);
  });

  it('clears the timeout once the probe answers', async () => {
    const { probe, calls } = manualProbe();
    const { clock, changed, subtitles } = setup(probe);
    subtitles.limit(2);
    calls[0]?.answer(Ok(true));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(clock.active()).toBe(0);
    expect(calls[0]?.signal.aborted).toBe(false);
  });

  it('never asks when one batch is all the server allows', () => {
    const probe = vi.fn<Probe>(async () => Ok(true));
    const { subtitles } = setup(probe);
    for (let i = 0; i < 10; i += 1) expect(subtitles.limit(1)).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('dispose aborts the running probe and asks no more', async () => {
    const { probe, calls } = manualProbe();
    const { clock, changed, subtitles } = setup(probe);
    subtitles.limit(2);
    subtitles.dispose();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(clock.active()).toBe(0);
    calls[0]?.answer(Ok(true));
    await settle();
    expect(changed).not.toHaveBeenCalled();
    clock.advance(5_000);
    expect(subtitles.limit(2)).toBe(2);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('treats a probe that rejects as failed', async () => {
    const probe = vi.fn<Probe>(() => Promise.reject(new Error('boom')));
    const { changed, subtitles } = setup(probe);
    expect(subtitles.limit(2)).toBe(1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(subtitles.limit(2)).toBe(2);
  });
});

describe('slotZeroBusy', () => {
  it.each([
    {
      name: '枠 0 が処理中',
      slots: [
        { id: 0, processing: true },
        { id: 1, processing: false },
      ],
      expected: true,
    },
    {
      name: '枠 0 が空き',
      slots: [
        { id: 1, processing: true },
        { id: 0, processing: false },
      ],
      expected: false,
    },
    {
      name: '枠 0 がない',
      slots: [{ id: 1, processing: true }],
      expected: 'response_invalid',
    },
  ])('slotZeroBusy: $name', ({ slots, expected }) => {
    const busy = slotZeroBusy(slots);
    expect(busy.ok ? busy.value : busy.error.internalCode).toBe(expected);
  });
});
