// A local stand-in for llama.cpp's HTTP server, so extension E2E tests never depend on a real
// model server. It runs in Node (outside src/) and speaks the formats the extensions send:
// health, props and models, the compact comment batch, the chat summary and the genre guess
// (`/v1/chat/completions`, prompts.ts) and Clef (`/v1/systemone`, toxicity.ts).
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  COMMENT_CATEGORY_CODES,
  commentBatchPrompt,
  genrePrompt,
  PLAMO_LANGUAGES,
  PLAMO_STOP,
  PLAMO_TRANSLATE_MODEL,
  summaryPrompt,
  type ChatMessage,
  type CommentCategory,
  type StreamGenre,
} from '../src/index.ts';

/** The body of a `/v1/chat/completions` request, as the llama client sends it. */
export type StubChat = Readonly<{
  messages: readonly ChatMessage[];
  model?: string;
  grammar?: string;
  max_tokens?: number;
  id_slot?: number;
  temperature?: number;
  stop?: readonly string[];
  chat_template_kwargs?: Record<string, unknown>;
  response_format?: unknown;
}>;
export type StubRequest = Readonly<{
  method: string;
  /** The path without the query (`/props?model=…` is `/props`). */
  path: string;
  /** The JSON body; undefined when the request has none. */
  body: unknown;
  /** The body of a chat completion request. */
  chat?: StubChat | undefined;
}>;
export type StubReply = Readonly<{ status?: number; body: unknown }>;
/** Answers one request; a test may replace the stub's responder or wrap `defaultResponder`. */
export type Responder = (request: StubRequest) => StubReply | Promise<StubReply>;

export type LlamaStub = {
  origin: string;
  /** `<METHOD> <url>` of every request, in order. */
  requests: string[];
  /** Answers every request from now on; `defaultResponder` until a test replaces it. */
  respond: Responder;
  /** Closes the server and every open connection: requests fail as with llama.cpp down. */
  stop(this: void): Promise<void>;
  /** Listens again on the same port. */
  start(this: void): Promise<void>;
};

/** The fixed system turns of the comment batch and the summary prompts. */
const COMMENT_SYSTEM = commentBatchPrompt({ comments: [], context: '' }).messages[0]?.content;
const SUMMARY_SYSTEM = summaryPrompt({ windowMinutes: 5, questions: [], peaks: [], others: [] })
  .messages[0]?.content;
const GENRE_SYSTEM = genrePrompt({}).messages[0]?.content;
/** The genre the stub guesses for every stream. */
export const STUB_GENRE: StreamGenre = 'story';
/**
 * Words that steer the stub (R37, R43): the model calls a text with `BAD` or `ROUGH` abusive, and
 * Clef scores a text with `BAD` or `HARSH` as abusive.
 */
const MODEL_ABUSIVE = /BAD|ROUGH/u;
const CLEF_ABUSIVE = /BAD|HARSH/u;
/** Clef's probability for a text with `BAD` or `HARSH`, and for any other text. */
export const STUB_ABUSIVE = 0.95;
export const STUB_BENIGN = 0.02;
/** The topic (unless a test names another) and the merged question of a summary reply. */
export const STUB_TOPIC = 'テスト話題';
export const STUB_QUESTION = 'テスト質問';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isMessage = (value: unknown): value is ChatMessage =>
  isRecord(value) &&
  (value.role === 'system' || value.role === 'user' || value.role === 'assistant') &&
  typeof value.content === 'string';

/** The chat completion body, or undefined when `body` is not one. */
function chatOf(body: unknown): StubChat | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
  const messages = body.messages.filter(isMessage);
  if (messages.length !== body.messages.length) return undefined;
  return { ...body, messages };
}

/** One comment line of the batch user turn: `{"id":1,"lang":…,"translate":…,"text":…}`. */
type BatchLine = Readonly<{ id: number; translate: boolean; text: string }>;
function batchLines(user: string): BatchLine[] {
  // The comment lines are the only ones of the user turn that start with "{".
  return user
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line): unknown => JSON.parse(line))
    .filter(
      (line): line is BatchLine =>
        isRecord(line) &&
        typeof line.id === 'number' &&
        typeof line.translate === 'boolean' &&
        typeof line.text === 'string',
    );
}

/**
 * The compact batch reply, one `<n>\t<code>[\t<ja>]` line per comment: a text with `BAD` or
 * `ROUGH` is abusive (the comment extension then asks Clef, which decides), one ending in `?` a
 * question, anything else chatter, and a comment the batch marks gets the translation `訳:` + its
 * text.
 */
export function commentBatchReply(user: string): string {
  return batchLines(user)
    .map((line) => {
      const category: CommentCategory = MODEL_ABUSIVE.test(line.text)
        ? 'abusive'
        : line.text.endsWith('?')
          ? 'question'
          : 'chatter';
      const fields = [String(line.id), COMMENT_CATEGORY_CODES[category]];
      if (line.translate) fields.push(`訳:${line.text}`);
      return `${fields.join('\t')}\n`;
    })
    .join('');
}

/**
 * A summary reply to the user turn `user`: one topic (`テスト話題` unless given), and one
 * question merging Q1 when the chat has questions.
 */
export function summaryReply(user: string, topic: string = STUB_TOPIC): string {
  const asked = user.split('\n').some((line) => line.startsWith('Q1 '));
  return `T ${topic}\n${asked ? `Q 1 ${STUB_QUESTION}\n` : ''}`;
}

/** Clef's answer: `noul` per question `c<n>` for chat message `<n>` of the state. */
function clefReply(body: unknown): StubReply {
  if (!isRecord(body) || typeof body.state !== 'string' || !isRecord(body.questions))
    return { status: 400, body: { error: { code: 400 } } };
  const texts = new Map<string, string>();
  for (const line of body.state.split('\n')) {
    const match = /^(\d+): (".*")$/u.exec(line);
    const text: unknown = match?.[2] === undefined ? undefined : JSON.parse(match[2]);
    if (match?.[1] !== undefined && typeof text === 'string') texts.set(`c${match[1]}`, text);
  }
  const answers = Object.fromEntries(
    Object.keys(body.questions).map((id) => [
      id,
      { noul: CLEF_ABUSIVE.test(texts.get(id) ?? '') ? STUB_ABUSIVE : STUB_BENIGN },
    ]),
  );
  return { body: { answers } };
}

/** A chat completion whose reply text is `content`, finished by a stop (not cut by max_tokens). */
export const chatCompletion = (content: string): StubReply => ({
  body: {
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  },
});
const NOT_FOUND: StubReply = { status: 404, body: { error: { code: 404 } } };

/** The translation prefix of a PLaMo reply from `withPlamo`: made up, not a PLaMo output. */
export const STUB_PLAMO_PREFIX = '訳P:';
const PLAMO_REFUSED: StubReply = {
  status: 400,
  body: { error: { code: 400, type: 'invalid_request_error' } },
};
const sameStrings = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined && a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * Whether a PLaMo chat has the form PLaMo's chat template accepts (see `plamoTranslateRequest`):
 * emptiness is ASCII-only, `source_lang` is one of the model card's codes, and no variable
 * holds the reserved `<|plamo:`.
 */
function plamoForm(chat: StubChat): boolean {
  const [only, ...rest] = chat.messages;
  const kwargs = chat.chat_template_kwargs;
  const sourceLang = kwargs?.source_lang;
  return (
    only?.role === 'user' &&
    rest.length === 0 &&
    !/^[ \t\r\n]*$/u.test(only.content) &&
    kwargs?.target_lang === 'ja' &&
    (sourceLang === undefined ||
      (typeof sourceLang === 'string' && PLAMO_LANGUAGES.includes(sourceLang))) &&
    !JSON.stringify([only.content, kwargs.context, kwargs.glossary]).includes('<|plamo:') &&
    sameStrings(chat.stop, PLAMO_STOP) &&
    chat.grammar === undefined &&
    chat.response_format === undefined
  );
}

/**
 * Makes `responder` a router that also serves PLaMo 3 Translate 2B: the model is listed, and a
 * chat to it in the form PLaMo takes is answered `訳P:` + the line, anything else with HTTP 400
 * as the template does. Every other request goes to `responder`.
 */
export function withPlamo(responder: Responder): Responder {
  return async (request) => {
    const key = `${request.method} ${request.path}`;
    if (key === 'POST /v1/chat/completions' && request.chat?.model === PLAMO_TRANSLATE_MODEL)
      return plamoForm(request.chat)
        ? chatCompletion(`${STUB_PLAMO_PREFIX}${request.chat.messages[0]?.content ?? ''}`)
        : PLAMO_REFUSED;
    const reply = await responder(request);
    if (key !== 'GET /v1/models' || !isRecord(reply.body) || !Array.isArray(reply.body.data))
      return reply;
    return {
      ...reply,
      body: { ...reply.body, data: [...reply.body.data, { id: PLAMO_TRANSLATE_MODEL }] },
    };
  };
}

/**
 * llama.cpp as the extensions use it: a healthy server with one model and 2 slots, a comment
 * batch and summary reply built by `commentBatchReply` (a text with `BAD` or `ROUGH` is abusive)
 * and `summaryReply`, `STUB_GENRE` for a genre guess, and Clef scoring a text with `BAD` or
 * `HARSH` as abusive (0.95). Other requests get 404. In router mode every request carries a
 * `model`; the stub ignores it.
 */
export function defaultResponder(request: StubRequest): StubReply {
  switch (`${request.method} ${request.path}`) {
    case 'GET /health':
      return { body: { status: 'ok' } };
    case 'GET /props':
      return { body: { total_slots: 2 } };
    case 'GET /v1/models':
      return { body: { object: 'list', data: [{ id: 'stub-model' }] } };
    case 'POST /v1/systemone':
      return clefReply(request.body);
    case 'POST /v1/chat/completions': {
      const system = request.chat?.messages[0]?.content;
      const user = request.chat?.messages.find((message) => message.role === 'user')?.content;
      if (user === undefined) return NOT_FOUND;
      if (system === COMMENT_SYSTEM) return chatCompletion(commentBatchReply(user));
      if (system === SUMMARY_SYSTEM) return chatCompletion(summaryReply(user));
      if (system === GENRE_SYSTEM) return chatCompletion(STUB_GENRE);
      return NOT_FOUND;
    }
    default:
      return NOT_FOUND;
  }
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

/** Starts the stub on a free port of 127.0.0.1. */
export async function startLlamaStub(): Promise<LlamaStub> {
  let port = 0;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    stub.requests.push(`${request.method} ${request.url}`);
    const { pathname } = new URL(request.url ?? '/', 'http://stub.invalid');
    const body = await bodyOf(request);
    const reply = await stub.respond({
      method: request.method ?? 'GET',
      path: pathname,
      body,
      chat: pathname === '/v1/chat/completions' ? chatOf(body) : undefined,
    });
    response.statusCode = reply.status ?? 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(reply.body));
  }
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { code: 500, message: String(error) } }));
    });
  });
  async function start(): Promise<void> {
    if (server.listening) return;
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    port = address !== null && typeof address === 'object' ? address.port : port;
  }
  async function stop(): Promise<void> {
    if (!server.listening) return;
    const closed = once(server, 'close');
    server.close();
    // Keep-alive connections would otherwise keep answering until they idle out.
    server.closeAllConnections();
    await closed;
  }
  const stub: LlamaStub = { origin: '', requests: [], respond: defaultResponder, start, stop };
  await start();
  stub.origin = `http://127.0.0.1:${port}`;
  return stub;
}
