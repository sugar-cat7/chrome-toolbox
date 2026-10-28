import { z } from 'zod/mini';
import { INTERNAL_ERRORS, PUBLIC_ERRORS, type InternalErrorCode } from './errors.generated.ts';

export type AppError = Readonly<{ internalCode: InternalErrorCode; diagnosticId: string }>;
export type Result<T, E = AppError> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;
export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

const publicCodes = Object.keys(PUBLIC_ERRORS) as [
  keyof typeof PUBLIC_ERRORS,
  ...(keyof typeof PUBLIC_ERRORS)[],
];
const diagnosticId = z.string().check(z.regex(/^[a-f0-9]{32}$/u));
export const publicErrorSchema = z.strictObject({
  code: z.enum(publicCodes),
  message: z.string(),
  failureClass: z.string(),
  retry: z.enum(['never', 'owner_only']),
  remediation: z.string(),
  diagnosticId,
});
export type PublicError = z.infer<typeof publicErrorSchema>;

export function failure(
  internalCode: InternalErrorCode,
  id = crypto.randomUUID().replaceAll('-', ''),
): AppError {
  return {
    internalCode: Object.hasOwn(INTERNAL_ERRORS, internalCode)
      ? internalCode
      : 'unexpected_failure',
    diagnosticId: /^[a-f0-9]{32}$/u.test(id) ? id : crypto.randomUUID().replaceAll('-', ''),
  };
}
export function publicFailure(error: AppError): PublicError {
  const code = INTERNAL_ERRORS[error.internalCode];
  const policy = PUBLIC_ERRORS[code];
  return {
    code,
    message: policy.message,
    failureClass: policy.class,
    retry: policy.retry,
    remediation: policy.remediation,
    diagnosticId: error.diagnosticId,
  };
}
export function errorStatus(error: AppError): number {
  return PUBLIC_ERRORS[INTERNAL_ERRORS[error.internalCode]].status;
}
export function decodePublicError(value: unknown): Result<PublicError> {
  const parsed = publicErrorSchema.safeParse(value);
  if (!parsed.success) return Err(failure('response_invalid'));
  const policy = PUBLIC_ERRORS[parsed.data.code];
  if (
    parsed.data.message !== policy.message ||
    parsed.data.failureClass !== policy.class ||
    parsed.data.retry !== policy.retry ||
    parsed.data.remediation !== policy.remediation
  )
    return Err(failure('response_invalid'));
  return Ok(parsed.data);
}
export async function capturePublic<T>(
  operation: () => Promise<T>,
  code: InternalErrorCode,
): Promise<Result<T, PublicError>> {
  try {
    return Ok(await operation());
  } catch (input) {
    const parsed = decodePublicError(input);
    return Err(parsed.ok ? parsed.value : publicFailure(failure(code)));
  }
}
// SDK/transport ingress only: invoke a thunk so synchronous throws are normalized too.
// Raw exceptions never cross a public boundary, appear in telemetry, or trigger automatic retries.
export async function capture<T>(
  operation: () => Promise<T>,
  code: InternalErrorCode,
): Promise<Result<T>> {
  try {
    return Ok(await operation());
  } catch {
    return Err(failure(code));
  }
}
export function captureSync<T>(operation: () => T, code: InternalErrorCode): Result<T> {
  try {
    return Ok(operation());
  } catch {
    return Err(failure(code));
  }
}
export function decode<T>(schema: z.ZodMiniType<T>, input: unknown): Result<T> {
  const parsed = schema.safeParse(input);
  return parsed.success ? Ok(parsed.data) : Err(failure('response_invalid'));
}
// Browser event APIs require a void callback. The one owner closes unexpected rejection.
export function launch(operation: () => Promise<void>, onFailure: (error: AppError) => void): void {
  try {
    operation().catch(() => onFailure(failure('unexpected_failure')));
  } catch {
    onFailure(failure('unexpected_failure'));
  }
}
