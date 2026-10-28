// Generated from tools/errors/catalog.json by errors:generate. Do not edit.
use serde::Serialize;
#[derive(Clone, Copy, Debug)]
#[allow(
    dead_code,
    reason = "The generated catalog contains codes for every runtime, including optional adapters"
)]
pub enum ErrorCode {
    InputInvalid,
    RequestJsonInvalid,
    WriteForbidden,
    ResourceMissing,
    StorageFailed,
    ResponseInvalid,
    NetworkFailed,
    IpcFailed,
    ExportFailed,
    StateUnavailable,
    ClockInvalid,
    UnexpectedFailure,
    OperationCancelled,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicError {
    pub code: &'static str,
    pub message: &'static str,
    pub failure_class: &'static str,
    pub retry: &'static str,
    pub remediation: &'static str,
    pub diagnostic_id: String,
}
#[derive(Clone, Debug)]
pub struct AppError {
    pub code: ErrorCode,
    pub diagnostic_id: String,
}
impl AppError {
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            diagnostic_id: uuid::Uuid::new_v4().simple().to_string(),
        }
    }
    pub fn public(&self) -> PublicError {
        let (code, message, failure_class, retry, remediation) = match self.code {
            ErrorCode::InputInvalid => (
                "invalid_input",
                "Text must contain 1–1000 characters and no extra fields.",
                "validation",
                "never",
                "Check the input and try again.",
            ),
            ErrorCode::RequestJsonInvalid => (
                "invalid_json",
                "Request body must be valid JSON.",
                "validation",
                "never",
                "Send a valid JSON body.",
            ),
            ErrorCode::WriteForbidden => (
                "writes_disabled",
                "Writes are disabled in this environment.",
                "forbidden",
                "never",
                "Use an environment that explicitly permits writes.",
            ),
            ErrorCode::ResourceMissing => (
                "not_found",
                "Note, route or selected feature not found.",
                "not_found",
                "never",
                "Check the target identifier and selected features.",
            ),
            ErrorCode::StorageFailed => (
                "internal_error",
                "The operation could not be completed.",
                "unknown",
                "owner_only",
                "Investigate the diagnostic identifier; verify writes before retrying.",
            ),
            ErrorCode::ResponseInvalid => (
                "internal_error",
                "The operation could not be completed.",
                "unknown",
                "owner_only",
                "Investigate the diagnostic identifier; verify writes before retrying.",
            ),
            ErrorCode::NetworkFailed => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::IpcFailed => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::ExportFailed => (
                "internal_error",
                "The operation could not be completed.",
                "unknown",
                "owner_only",
                "Investigate the diagnostic identifier; verify writes before retrying.",
            ),
            ErrorCode::StateUnavailable => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::ClockInvalid => (
                "internal_error",
                "The operation could not be completed.",
                "unknown",
                "owner_only",
                "Investigate the diagnostic identifier; verify writes before retrying.",
            ),
            ErrorCode::UnexpectedFailure => (
                "internal_error",
                "The operation could not be completed.",
                "unknown",
                "owner_only",
                "Investigate the diagnostic identifier; verify writes before retrying.",
            ),
            ErrorCode::OperationCancelled => (
                "cancelled",
                "The operation was cancelled.",
                "cancelled",
                "never",
                "Start a new operation only when requested.",
            ),
        };
        PublicError {
            code,
            message,
            failure_class,
            retry,
            remediation,
            diagnostic_id: self.diagnostic_id.clone(),
        }
    }
    pub fn internal_code(&self) -> &'static str {
        match self.code {
            ErrorCode::InputInvalid => "input_invalid",
            ErrorCode::RequestJsonInvalid => "request_json_invalid",
            ErrorCode::WriteForbidden => "write_forbidden",
            ErrorCode::ResourceMissing => "resource_missing",
            ErrorCode::StorageFailed => "storage_failed",
            ErrorCode::ResponseInvalid => "response_invalid",
            ErrorCode::NetworkFailed => "network_failed",
            ErrorCode::IpcFailed => "ipc_failed",
            ErrorCode::ExportFailed => "export_failed",
            ErrorCode::StateUnavailable => "state_unavailable",
            ErrorCode::ClockInvalid => "clock_invalid",
            ErrorCode::UnexpectedFailure => "unexpected_failure",
            ErrorCode::OperationCancelled => "operation_cancelled",
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.internal_code(), self.diagnostic_id)
    }
}
impl std::error::Error for AppError {}
