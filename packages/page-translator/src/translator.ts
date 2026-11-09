import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createLlamaClient,
  createQueue,
  cutByMaxTokens,
  PAGE_PLAMO_MAX_TOKENS,
  pageBatchMaxTokens,
  pageBatchPrompt,
  pageTokensValid,
  pageUnitSource,
  parsePageBatch,
  parsePlamoLine,
  PLAMO_TRANSLATE_MODEL,
  plamoTranslateRequest,
  readPagePieces,
  type Fetch,
  type LlamaClient,
  type PageToken,
  type SettingsStore,
} from '@chrome-toolbox/extension-core';
import type { TranslateReply, TranslateRequest } from './protocol.ts';
import { defaultPageSettings, type PageSettings, type PageSettingsStore } from './settings.ts';

/** A router's cold model load took 13 s live; a batch of 6 units writes a few hundred tokens. */
export const PAGE_TIMEOUT_MS = 30_000;
/**
 * Whether PLaMo also gets units with markers (links, emphasis). The page bench (Task 3) decides;
 * until then they go to Gemma, whose grammar keeps every marker.
 */
export const PLAMO_TAKES_RICH = false;
/** PLaMo requests at once at most: its slots 1 and 2. */
const PLAMO_PARALLEL = 2;
/** Requests waiting for each model; more are refused (`queue_full`) instead of piling up. */
const QUEUE_PENDING = 16;
/** Units before a PLaMo unit that it gets as context, after the page's title. */
const CONTEXT_UNITS = 2;

type Purpose = TranslateRequest['purpose'];
const PURPOSES: readonly Purpose[] = ['page', 'selection'];

/** The slots pages use on one model: Gemma's one slot, and PLaMo's slots (one request each). */
export type SlotPlan = Readonly<{ gemma: number; plamo: readonly number[] }>;

/**
 * The slots pages use on a server with `totalSlots` slots per model (`--parallel`). Slot 0 is the
 * subtitles' and is never used: Gemma takes the last slot, PLaMo slots 1 and 2 (those the server
 * has). `undefined` when the count is unknown or there is no slot besides 0: then nothing is sent,
 * since a request without `id_slot` may land on slot 0.
 */
export function slotPlan(totalSlots: number | undefined): SlotPlan | undefined {
  if (totalSlots === undefined || totalSlots < 2) return undefined;
  return {
    gemma: totalSlots - 1,
    plamo: Array.from({ length: Math.min(PLAMO_PARALLEL, totalSlots - 1) }, (_, i) => i + 1),
  };
}

export type PageTranslator = {
  /**
   * Translates a request of the page script in tab `tabId`. A unit that is no page unit
   * (`pageTokensValid`) or does not read back gets no `pieces` and fails alone (P21). The same
   * tab's running request of the same purpose is aborted first: a selection never stops a page
   * batch. Gemma's batch failing (no answer, a timeout, a full queue) fails the whole request.
   */
  translate(this: void, tabId: number, request: TranslateRequest): Promise<Result<TranslateReply>>;
  /** Aborts the tab's running request of `purpose`, or of both purposes. */
  cancel(this: void, tabId: number, purpose?: Purpose): void;
  /** The settings changed: the next request reads them and asks the server again. */
  reload(this: void): void;
  /** Aborts every request; later ones answer `operation_cancelled`. */
  dispose(this: void): void;
};

/**
 * What the settings say and what the server told about them, kept until `reload`: whether
 * `/v1/models` lists PLaMo (once it answered) and each model's slots (`slotsOf`: the question
 * while it runs, then its answer of 2 or more slots).
 */
type Setup = {
  model: string;
  translator: PageSettings['translator'];
  gemma: LlamaClient;
  plamo: LlamaClient;
  listed: boolean | undefined;
  slots: Map<string, Promise<Result<SlotPlan>>>;
};
/** A unit of the request: where it stands in it, its tokens and its text as sent. */
type Unit = Readonly<{ at: number; tokens: readonly PageToken[]; line: string }>;

const cancelled = (): Result<never> => Err(failure('operation_cancelled'));
/** `pending`'s result, or `operation_cancelled` as soon as `signal` aborts. */
async function unlessAborted<T>(
  pending: Promise<Result<T>>,
  signal: AbortSignal,
): Promise<Result<T>> {
  if (signal.aborted) return cancelled();
  let stop = (): void => undefined;
  const aborted = new Promise<Result<T>>((resolve) => {
    stop = () => resolve(cancelled());
    signal.addEventListener('abort', stop, { once: true });
  });
  const result = await Promise.race([pending, aborted]);
  signal.removeEventListener('abort', stop);
  return result;
}
const isPlain = (tokens: readonly PageToken[]): boolean =>
  tokens.every((token) => token.t === 'text' || token.t === 'space');

/**
 * The background's page translation: Gemma batches on its last slot, and PLaMo one unit at a
 * time on slots 1 and 2 when the settings choose it, with Gemma translating what PLaMo could not.
 */
export function createPageTranslator({
  fetch,
  settings,
  pageSettings,
  timeoutMs = PAGE_TIMEOUT_MS,
}: {
  fetch: Fetch;
  settings: SettingsStore;
  pageSettings: PageSettingsStore;
  timeoutMs?: number;
}): PageTranslator {
  // One Gemma batch at a time on its one slot; PLaMo has two slots.
  const gemmaQueue = createQueue({ concurrency: 1, maxPending: QUEUE_PENDING });
  const plamoQueue = createQueue({ concurrency: PLAMO_PARALLEL, maxPending: QUEUE_PENDING });
  /** Each tab's running request per purpose. */
  const running = new Map<string, AbortController>();
  const keyOf = (tabId: number, purpose: Purpose): string => `${tabId}:${purpose}`;
  let loading: Promise<Result<Setup>> | undefined;
  let disposed = false;
  /** Aborts the questions requests share (`slotsOf`) once the translator is disposed. */
  const probe = new AbortController();

  async function load(): Promise<Result<Setup>> {
    const shared = await settings.load();
    if (!shared.ok) return shared;
    const page = await pageSettings.load();
    // A stored record that is no page settings does not lock translation: the defaults apply
    // until the options page saves valid ones. Storage that cannot be read fails the request.
    if (!page.ok && page.error.internalCode !== 'response_invalid') return page;
    const { llamaBaseUrl: baseUrl, models } = shared.value;
    return Ok({
      model: models.translate,
      translator: page.ok ? page.value.translator : defaultPageSettings.translator,
      gemma: createLlamaClient({ baseUrl, fetch, queue: gemmaQueue, timeoutMs }),
      plamo: createLlamaClient({ baseUrl, fetch, queue: plamoQueue, timeoutMs }),
      listed: undefined,
      slots: new Map(),
    });
  }
  async function setup(): Promise<Result<Setup>> {
    const pending = (loading ??= load());
    const loaded = await pending;
    // The settings changed while they were read: read the newer ones.
    if (pending !== loading) return setup();
    if (!loaded.ok) loading = undefined;
    return loaded;
  }

  /**
   * The slots of `model`; nothing is sent to a model without its own slots. One `/props` question
   * per model serves every request waiting for it, and its answer is kept; a failed or too small
   * answer is forgotten, so the next request asks again. The question is no request's to abort: a
   * cancelled request stops waiting while the others keep the answer.
   */
  function slotsOf(current: Setup, model: string, signal: AbortSignal): Promise<Result<SlotPlan>> {
    let asked = current.slots.get(model);
    if (asked === undefined) {
      asked = askSlots(current, model);
      current.slots.set(model, asked);
    }
    return unlessAborted(asked, signal);
  }
  async function askSlots(current: Setup, model: string): Promise<Result<SlotPlan>> {
    const props = await current.gemma.props({ model, signal: probe.signal });
    const plan = props.ok ? slotPlan(props.value.totalSlots) : undefined;
    if (plan === undefined) current.slots.delete(model);
    if (!props.ok) return props;
    return plan === undefined ? Err(failure('model_refused')) : Ok(plan);
  }

  /**
   * Whether the server has PLaMo, asked once: the router lists every model it can load. A list
   * that cannot be read is no answer: PLaMo is tried, and the next request asks again.
   */
  async function hasPlamo(current: Setup, signal: AbortSignal): Promise<Result<boolean>> {
    if (current.listed !== undefined) return Ok(current.listed);
    const models = await current.gemma.models(signal);
    if (signal.aborted) return cancelled();
    if (!models.ok) return Ok(true);
    current.listed = models.value.includes(PLAMO_TRANSLATE_MODEL);
    return Ok(current.listed);
  }

  /**
   * PLaMo's translation of `unit` on `slot`, with the page's title and the units before it as
   * context; `undefined` when PLaMo refuses or fails it or its reply does not read back (Gemma
   * then translates it). Only a cancel fails.
   */
  async function plamoPieces(
    current: Setup,
    request: TranslateRequest,
    unit: Unit,
    slot: number,
    signal: AbortSignal,
  ): Promise<Result<string[] | undefined>> {
    const title = request.page.title.trim() === '' ? [] : [`Page: ${request.page.title}`];
    const before = request.units
      .slice(Math.max(0, unit.at - CONTEXT_UNITS), unit.at)
      .map(({ tokens }) => pageUnitSource(tokens).text);
    // An empty text is no PLaMo input (input_invalid).
    const built = plamoTranslateRequest({
      line: unit.line,
      sourceLang: 'auto',
      previous: [...title, ...before],
      glossary: [],
      slot,
      maxTokensCap: PAGE_PLAMO_MAX_TOKENS,
    });
    if (!built.ok) return Ok(undefined);
    const reply = await current.plamo.chat({ ...built.value, signal });
    if (!reply.ok)
      return reply.error.internalCode === 'operation_cancelled' ? reply : Ok(undefined);
    const text = parsePlamoLine(reply.value, built.value.maxTokens, unit.line);
    return Ok(text.ok ? readPagePieces(text.value, unit.tokens) : undefined);
  }

  /**
   * Sends PLaMo's units one at a time per slot of `plan`, writing what reads back into `pieces`;
   * answers the units left for Gemma, in page order.
   */
  async function viaPlamo(
    current: Setup,
    request: TranslateRequest,
    units: readonly Unit[],
    pieces: Map<number, string[]>,
    signal: AbortSignal,
  ): Promise<Result<Unit[]>> {
    const taken = units.filter((unit) => PLAMO_TAKES_RICH || isPlain(unit.tokens));
    if (taken.length === 0) return Ok([...units]);
    const plan = await slotsOf(current, PLAMO_TRANSLATE_MODEL, signal);
    if (signal.aborted) return cancelled();
    // Without its own slots PLaMo gets nothing: Gemma translates every unit.
    if (!plan.ok) return Ok([...units]);
    const waiting = [...taken];
    async function work(slot: number): Promise<Result<void>> {
      for (let unit = waiting.shift(); unit !== undefined; unit = waiting.shift()) {
        const read = await plamoPieces(current, request, unit, slot, signal);
        if (!read.ok) return read;
        if (read.value !== undefined) pieces.set(unit.at, read.value);
      }
      return Ok(undefined);
    }
    const worked = await Promise.all(plan.value.plamo.map(work));
    const failed = worked.find((result) => !result.ok);
    if (failed !== undefined) return failed;
    return Ok(units.filter((unit) => !pieces.has(unit.at)));
  }

  /** One Gemma batch of `units` on Gemma's slot, writing what reads back into `pieces`. */
  async function viaGemma(
    current: Setup,
    page: TranslateRequest['page'],
    units: readonly Unit[],
    pieces: Map<number, string[]>,
    signal: AbortSignal,
  ): Promise<Result<void>> {
    const plan = await slotsOf(current, current.model, signal);
    if (!plan.ok) return plan;
    const batch = units.map((unit) => unit.tokens);
    const { messages, grammar } = pageBatchPrompt({ page, units: batch });
    const maxTokens = pageBatchMaxTokens(batch);
    // No `tellRefusal`: an HTTP error is network_failed, which the page script sends again.
    const reply = await current.gemma.chat({
      model: current.model,
      messages,
      grammar,
      maxTokens,
      temperature: 0,
      templateKwargs: { enable_thinking: false },
      slot: plan.value.gemma,
      signal,
    });
    if (!reply.ok) return reply;
    const read = parsePageBatch(reply.value.text, batch, {
      cut: cutByMaxTokens(reply.value, maxTokens),
    });
    for (const [i, unit] of units.entries()) {
      const unitPieces = read[i];
      if (unitPieces !== undefined) pieces.set(unit.at, unitPieces);
    }
    return Ok(undefined);
  }

  async function run(
    request: TranslateRequest,
    signal: AbortSignal,
  ): Promise<Result<TranslateReply>> {
    const loaded = await setup();
    if (signal.aborted) return cancelled();
    if (!loaded.ok) return loaded;
    const current = loaded.value;
    // A unit that is no page unit fails alone (P21).
    let left: Unit[] = request.units.flatMap(({ tokens }, at) =>
      pageTokensValid(tokens) ? [{ at, tokens, line: pageUnitSource(tokens).text }] : [],
    );
    const pieces = new Map<number, string[]>();
    let translator: TranslateReply['translator'] = 'gemma';
    let missing = false;
    if (current.translator === 'plamo') {
      const listed = await hasPlamo(current, signal);
      if (!listed.ok) return listed;
      missing = !listed.value;
      if (listed.value) {
        const rest = await viaPlamo(current, request, left, pieces, signal);
        if (!rest.ok) return rest;
        left = rest.value;
        // The reply names PLaMo only when it translated a unit (`pieces` holds PLaMo's so far).
        if (pieces.size > 0) translator = 'plamo';
      }
    }
    if (left.length > 0) {
      const batch = await viaGemma(current, request.page, left, pieces, signal);
      if (!batch.ok) return batch;
    }
    return Ok({
      results: request.units.map(({ id }, at) => {
        const unitPieces = pieces.get(at);
        return unitPieces === undefined ? { id } : { id, pieces: unitPieces };
      }),
      translator,
      ...(missing ? { notice: 'plamo_missing' } : {}),
    });
  }

  return {
    translate: async (tabId, request): Promise<Result<TranslateReply>> => {
      if (disposed) return cancelled();
      const key = keyOf(tabId, request.purpose);
      running.get(key)?.abort();
      const controller = new AbortController();
      running.set(key, controller);
      const result = await run(request, controller.signal);
      if (running.get(key) === controller) running.delete(key);
      return result;
    },
    cancel: (tabId, purpose) => {
      for (const each of purpose === undefined ? PURPOSES : [purpose]) {
        const key = keyOf(tabId, each);
        running.get(key)?.abort();
        running.delete(key);
      }
    },
    reload: () => {
      loading = undefined;
    },
    dispose: () => {
      disposed = true;
      loading = undefined;
      for (const controller of running.values()) controller.abort();
      probe.abort();
      running.clear();
      gemmaQueue.clear();
      plamoQueue.clear();
    },
  };
}
