// Generated from tools/errors/catalog.json by errors:generate. Do not edit.
export const PUBLIC_ERRORS = {
  invalid_input: {
    status: 400,
    class: 'validation',
    retry: 'never',
    message: 'Text must contain 1–1000 characters and no extra fields.',
    remediation: 'Check the input and try again.',
  },
  invalid_json: {
    status: 400,
    class: 'validation',
    retry: 'never',
    message: 'Request body must be valid JSON.',
    remediation: 'Send a valid JSON body.',
  },
  writes_disabled: {
    status: 403,
    class: 'forbidden',
    retry: 'never',
    message: 'Writes are disabled in this environment.',
    remediation: 'Use an environment that explicitly permits writes.',
  },
  not_found: {
    status: 404,
    class: 'not_found',
    retry: 'never',
    message: 'Note, route or selected feature not found.',
    remediation: 'Check the target identifier and selected features.',
  },
  unavailable: {
    status: 503,
    class: 'transient',
    retry: 'owner_only',
    message: 'The service is unavailable.',
    remediation: "Check the previous operation's outcome before retrying.",
  },
  cancelled: {
    status: 499,
    class: 'cancelled',
    retry: 'never',
    message: 'The operation was cancelled.',
    remediation: 'Start a new operation only when requested.',
  },
  internal_error: {
    status: 500,
    class: 'unknown',
    retry: 'owner_only',
    message: 'The operation could not be completed.',
    remediation: 'Investigate the diagnostic identifier; verify writes before retrying.',
  },
} as const;
export const INTERNAL_ERRORS = {
  input_invalid: 'invalid_input',
  request_json_invalid: 'invalid_json',
  write_forbidden: 'writes_disabled',
  resource_missing: 'not_found',
  storage_failed: 'internal_error',
  response_invalid: 'internal_error',
  network_failed: 'unavailable',
  ipc_failed: 'unavailable',
  export_failed: 'internal_error',
  state_unavailable: 'unavailable',
  clock_invalid: 'internal_error',
  unexpected_failure: 'internal_error',
  operation_cancelled: 'cancelled',
} as const;
export type PublicErrorCode = keyof typeof PUBLIC_ERRORS;
export type InternalErrorCode = keyof typeof INTERNAL_ERRORS;
