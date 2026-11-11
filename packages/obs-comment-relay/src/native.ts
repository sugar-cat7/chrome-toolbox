import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod/mini';
import {
  capturePublic,
  decode,
  Err,
  publicFailure,
  publicErrorSchema,
  relayCountersSchema,
  type PublicError,
  type Result,
} from '@chrome-toolbox/contracts';

export const relayStatusSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.uuid(),
  source: z.enum(['stopped', 'connecting', 'reading', 'attention', 'failed']),
  inference: z.enum(['idle', 'starting', 'ready', 'degraded']),
  counters: relayCountersSchema,
  error: z.optional(publicErrorSchema),
});
const httpReplySchema = z.strictObject({
  status: z.int().check(z.gte(100), z.lte(599)),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
const connectionSchema = z.strictObject({ health: httpReplySchema, models: httpReplySchema });
const fileSchema = z.strictObject({
  path: z.string(),
  sha256: z.string(),
  size: z.int(),
  modifiedAt: z.int(),
});
const settingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.enum(['managed', 'external']),
  baseUrl: z.string(),
  models: z.strictObject({ clef: z.nullable(fileSchema), plamo: z.nullable(fileSchema) }),
  filterStrength: z.enum(['mild', 'normal', 'strict']),
  translate: z.boolean(),
  sourceLanguage: z.string(),
  targetLanguage: z.literal('ja'),
  display: z.enum(['translated', 'original', 'both']),
  maxItems: z.int().check(z.gte(1), z.lte(100)),
  overlayPort: z.int().check(z.gte(1), z.lte(65535)),
  overlayToken: z.uuid(),
});
export type RelayStatus = z.infer<typeof relayStatusSchema>;
async function command<T>(
  name: string,
  schema: z.ZodMiniType<T>,
  args?: Record<string, unknown>,
): Promise<Result<T, PublicError>> {
  const result = await capturePublic(
    () => (args ? invoke<unknown>(name, args) : invoke<unknown>(name)),
    'ipc_failed',
  );
  if (!result.ok) return result;
  const parsed = decode(schema, result.value);
  return parsed.ok ? parsed : Err(publicFailure(parsed.error));
}
/** No automatic health polling or telemetry; every inference call is explicitly requested. */
export const nativeRelay = {
  status: (): Promise<Result<RelayStatus, PublicError>> => command('get_status', relayStatusSchema),
  check: (): Promise<Result<z.infer<typeof connectionSchema>, PublicError>> =>
    command('check_connection', connectionSchema),
  restore: (): Promise<Result<z.infer<typeof settingsSchema>, PublicError>> =>
    command('save_settings', settingsSchema, { input: { resetCorrupt: true } }),
};
