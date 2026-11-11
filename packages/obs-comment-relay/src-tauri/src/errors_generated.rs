// Generated from tools/errors/catalog.json by errors:generate. Do not edit.
use serde::Serialize;
#[derive(Clone, Copy, Debug)]
#[allow(
    dead_code,
    reason = "The generated catalog contains codes for every runtime, including optional adapters"
)]
pub enum ErrorCode {
    RelayInputInvalid,
    RelaySenderForbidden,
    RelaySettingsCorrupt,
    RelaySettingsSaveFailed,
    RelayBindFailed,
    RelayFeatureUnavailable,
    InputInvalid,
    RequestJsonInvalid,
    WriteForbidden,
    ResourceMissing,
    StorageFailed,
    ResponseInvalid,
    NetworkFailed,
    ClefUnavailable,
    IpcFailed,
    ExportFailed,
    StateUnavailable,
    ClockInvalid,
    UnexpectedFailure,
    OperationCancelled,
    QueueFull,
    HostPermissionDenied,
    SenderForbidden,
    ModelRefused,
    AudioUnsupported,
    CaptureFailed,
    CaptureNotInvoked,
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
            ErrorCode::RelayInputInvalid => (
                "relay_invalid_input",
                "The relay request or settings are invalid.",
                "validation",
                "never",
                "Check the relay URL, settings and request limits.",
            ),
            ErrorCode::RelaySenderForbidden => (
                "relay_sender_forbidden",
                "This page or session cannot send this relay request.",
                "forbidden",
                "never",
                "Use the local control window or restart the selected chat source.",
            ),
            ErrorCode::RelaySettingsCorrupt => (
                "relay_settings_corrupt",
                "Saved relay settings could not be validated.",
                "validation",
                "never",
                "Explicitly restore initial settings from the control window. The original file is preserved.",
            ),
            ErrorCode::RelaySettingsSaveFailed => (
                "relay_settings_save_failed",
                "Relay settings could not be saved.",
                "transient",
                "owner_only",
                "Check local storage permissions and capacity before saving again.",
            ),
            ErrorCode::RelayBindFailed => (
                "relay_port_unavailable",
                "The configured overlay port could not be opened.",
                "transient",
                "owner_only",
                "Choose another overlay port or release the configured port, then save settings.",
            ),
            ErrorCode::RelayFeatureUnavailable => (
                "relay_feature_unavailable",
                "This relay feature is not available in this phase.",
                "transient",
                "never",
                "Use an existing loopback llama server. Model installation and managed startup require a later phase.",
            ),
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
            ErrorCode::ClefUnavailable => (
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
            ErrorCode::QueueFull => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::HostPermissionDenied => (
                "permission_denied",
                "Access to the requested host was not granted.",
                "forbidden",
                "never",
                "Grant the host permission when prompted, or choose a permitted host.",
            ),
            ErrorCode::SenderForbidden => (
                "sender_forbidden",
                "Only the extension's own pages may make this request.",
                "forbidden",
                "never",
                "Send the request from the side panel or another extension page.",
            ),
            ErrorCode::ModelRefused => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::AudioUnsupported => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::CaptureFailed => (
                "unavailable",
                "The service is unavailable.",
                "transient",
                "owner_only",
                "Check the previous operation's outcome before retrying.",
            ),
            ErrorCode::CaptureNotInvoked => (
                "permission_denied",
                "Access to the requested host was not granted.",
                "forbidden",
                "never",
                "Grant the host permission when prompted, or choose a permitted host.",
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
            ErrorCode::RelayInputInvalid => "relay_input_invalid",
            ErrorCode::RelaySenderForbidden => "relay_sender_forbidden",
            ErrorCode::RelaySettingsCorrupt => "relay_settings_corrupt",
            ErrorCode::RelaySettingsSaveFailed => "relay_settings_save_failed",
            ErrorCode::RelayBindFailed => "relay_bind_failed",
            ErrorCode::RelayFeatureUnavailable => "relay_feature_unavailable",
            ErrorCode::InputInvalid => "input_invalid",
            ErrorCode::RequestJsonInvalid => "request_json_invalid",
            ErrorCode::WriteForbidden => "write_forbidden",
            ErrorCode::ResourceMissing => "resource_missing",
            ErrorCode::StorageFailed => "storage_failed",
            ErrorCode::ResponseInvalid => "response_invalid",
            ErrorCode::NetworkFailed => "network_failed",
            ErrorCode::ClefUnavailable => "clef_unavailable",
            ErrorCode::IpcFailed => "ipc_failed",
            ErrorCode::ExportFailed => "export_failed",
            ErrorCode::StateUnavailable => "state_unavailable",
            ErrorCode::ClockInvalid => "clock_invalid",
            ErrorCode::UnexpectedFailure => "unexpected_failure",
            ErrorCode::OperationCancelled => "operation_cancelled",
            ErrorCode::QueueFull => "queue_full",
            ErrorCode::HostPermissionDenied => "host_permission_denied",
            ErrorCode::SenderForbidden => "sender_forbidden",
            ErrorCode::ModelRefused => "model_refused",
            ErrorCode::AudioUnsupported => "audio_unsupported",
            ErrorCode::CaptureFailed => "capture_failed",
            ErrorCode::CaptureNotInvoked => "capture_not_invoked",
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.internal_code(), self.diagnostic_id)
    }
}
impl std::error::Error for AppError {}
