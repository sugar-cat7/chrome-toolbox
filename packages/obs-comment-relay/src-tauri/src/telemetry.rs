use crate::errors_generated::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
static FILE_WRITE: Mutex<()> = Mutex::new(());
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
pub struct TraceCarrier {
    pub traceparent: String,
}
pub enum NativeOperation {
    List,
    Add,
    Remove,
    Export,
}
impl NativeOperation {
    fn name(&self) -> &'static str {
        match self {
            Self::List => "notes.list",
            Self::Add => "notes.add",
            Self::Remove => "notes.remove",
            Self::Export => "notes.export",
        }
    }
}
pub struct Operation {
    sampled: bool,
    name: &'static str,
    trace_id: String,
    span_id: String,
    parent_id: Option<String>,
    start: Option<u128>,
    elapsed: Instant,
}
fn finite_hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
        && value.bytes().any(|ch| ch != b'0')
}
fn epoch() -> Option<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos())
}
fn attribute(key: &str, value: &str) -> Value {
    json!({"key":key,"value":{"stringValue":value}})
}
impl Operation {
    pub fn new(operation: NativeOperation, carrier: Option<TraceCarrier>) -> Self {
        let parts = carrier
            .as_ref()
            .map(|value| value.traceparent.split('-').collect::<Vec<_>>());
        let valid = parts.as_ref().filter(|parts| {
            parts.len() == 4
                && parts[0] == "00"
                && finite_hex(parts[1], 32)
                && finite_hex(parts[2], 16)
                && parts[3].len() == 2
                && parts[3]
                    .bytes()
                    .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
        });
        Self {
            name: operation.name(),
            sampled: valid.is_none_or(|parts| {
                u8::from_str_radix(parts[3], 16).is_ok_and(|flags| flags & 1 == 1)
            }),
            trace_id: valid.map_or_else(
                || Uuid::new_v4().simple().to_string(),
                |parts| parts[1].to_owned(),
            ),
            span_id: Uuid::new_v4().simple().to_string()[..16].to_owned(),
            parent_id: valid.map(|parts| parts[2].to_owned()),
            start: epoch(),
            elapsed: Instant::now(),
        }
    }
    pub fn payloads<T>(&self, result: &Result<T, AppError>, run: &str) -> Option<[Value; 3]> {
        if !self.sampled {
            return None;
        }
        let start = self.start?.to_string();
        let end = epoch()?.to_string();
        let duration = self.elapsed.elapsed().as_secs_f64() * 1000.0;
        let mut attributes = vec![attribute("operation.name", self.name)];
        let cancelled = result
            .as_ref()
            .err()
            .is_some_and(|error| error.public().failure_class == "cancelled");
        if let Err(error) = result {
            attributes.extend([
                attribute("error.type", error.internal_code()),
                attribute("app.failure.class", error.public().failure_class),
                attribute("app.diagnostic.id", &error.diagnostic_id),
            ]);
        }
        let resource = json!({"attributes":[attribute("service.name", concat!(env!("CARGO_PKG_NAME"),"-native")),attribute("service.instance.id", std::env::consts::OS),attribute("test.run.id", run),attribute("service.version", &std::env::var("STARTER_OTEL_VERSION").ok().filter(|value| !value.is_empty() && value.len() <= 128 && value.bytes().all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))).unwrap_or_else(|| "development".into())),attribute("deployment.environment.name","local")]});
        let mut span = json!({"traceId":self.trace_id,"spanId":self.span_id,"name":self.name,"kind":1,"startTimeUnixNano":start,"endTimeUnixNano":end,"attributes":attributes,"status":{"code":if result.is_err() && !cancelled {2} else {0}}});
        if let Some(parent) = &self.parent_id {
            span["parentSpanId"] = json!(parent);
        }
        let traces = json!({"resourceSpans":[{"resource":resource,"scopeSpans":[{"scope":{"name":"native-boundary","version":"1.0.0"},"spans":[span]}]}]});
        let logs = json!({"resourceLogs":[{"resource":resource,"scopeLogs":[{"scope":{"name":"native-boundary","version":"1.0.0"},"logRecords":[{"timeUnixNano":end,"observedTimeUnixNano":end,"traceId":self.trace_id,"spanId":self.span_id,"severityNumber":if result.is_err() && !cancelled {17} else {9},"severityText":if result.is_err() && !cancelled {"ERROR"} else {"INFO"},"body":{"stringValue":if result.is_err() {"operation.failed"} else {"operation.completed"}},"attributes":attributes}]}]}]});
        // Correlation IDs are exemplars, never metric labels. A single duration observation.
        let metrics = json!({"resourceMetrics":[{"resource":resource,"scopeMetrics":[{"scope":{"name":"native-boundary","version":"1.0.0"},"metrics":[{"name":"application.operation.duration","unit":"ms","histogram":{"aggregationTemporality":1,"dataPoints":[{"startTimeUnixNano":start,"timeUnixNano":end,"count":"1","sum":duration,"explicitBounds":[],"bucketCounts":["1"],"attributes":[attribute("operation.name",self.name)],"exemplars":[{"timeUnixNano":end,"asDouble":duration,"traceId":self.trace_id,"spanId":self.span_id,"filteredAttributes":[]}]}]}}]}]}]});
        Some([traces, logs, metrics])
    }
    pub fn record<T>(&self, result: &Result<T, AppError>) {
        if !self.sampled {
            return;
        }
        let Some(directory) = std::env::var_os("STARTER_OTEL_NATIVE_DIR") else {
            return;
        };
        let run = std::env::var("STARTER_OTEL_RUN_ID").unwrap_or_else(|_| "local".to_owned());
        if !run
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))
            || run.len() > 128
            || run.is_empty()
        {
            eprintln!("NATIVE_TELEMETRY_INVALID_RUN");
            return;
        }
        let Some(payloads) = self.payloads(result, &run) else {
            eprintln!("NATIVE_TELEMETRY_CLOCK_UNAVAILABLE");
            return;
        };
        for (signal, payload) in ["traces", "logs", "metrics"].into_iter().zip(payloads) {
            if write_payload(Path::new(&directory), signal, &payload).is_err() {
                eprintln!("NATIVE_TELEMETRY_EXPORT_FAILED");
            }
        }
    }
}
pub fn write_payload(directory: &Path, signal: &str, payload: &Value) -> std::io::Result<()> {
    // Caller chooses a local diagnostics directory; never send payloads or credentials over native IPC.
    if !["traces", "logs", "metrics"].contains(&signal)
        || !std::fs::symlink_metadata(directory)?.is_dir()
    {
        return Err(std::io::Error::other("Invalid telemetry destination"));
    }
    let _guard = FILE_WRITE
        .lock()
        .map_err(|_| std::io::Error::other("Telemetry writer unavailable"))?;
    let path = directory.join(format!("native.{signal}.jsonl"));
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(std::io::Error::other("Invalid telemetry file"));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let mut bytes = serde_json::to_vec(payload)?;
    bytes.push(b'\n');
    if file.metadata()?.len() + bytes.len() as u64 > 16 * 1024 * 1024 {
        return Err(std::io::Error::other("Telemetry capacity exceeded"));
    }
    file.write_all(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors_generated::ErrorCode;
    #[test]
    fn propagates_native_parent_and_keeps_raw_failure_out_of_wire()
    -> Result<(), Box<dyn std::error::Error>> {
        let operation = Operation::new(
            NativeOperation::Add,
            Some(TraceCarrier {
                traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01".into(),
            }),
        );
        let result: Result<(), AppError> = Err(AppError::new(ErrorCode::InputInvalid));
        let payloads = operation
            .payloads(&result, "native-test")
            .ok_or("Missing native clock")?;
        assert_eq!(
            payloads[0]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["parentSpanId"],
            "1234567890abcdef"
        );
        assert_eq!(
            payloads[0]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["traceId"],
            "1234567890abcdef1234567890abcdef"
        );
        let error = result.err().ok_or("Missing expected native error")?;
        let public = serde_json::to_string(&error.public())?;
        assert!(!public.contains("input_invalid"));
        assert!(public.contains("invalid_input"));
        let directory = std::env::temp_dir().join(format!("native-telemetry-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory)?;
        write_payload(&directory, "traces", &payloads[0])?;
        assert_eq!(
            serde_json::from_str::<Value>(
                std::fs::read_to_string(directory.join("native.traces.jsonl"))?.trim()
            )?,
            payloads[0]
        );
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }
    #[test]
    fn refuses_invalid_parent_and_reports_the_file_boundary() {
        let operation = Operation::new(
            NativeOperation::List,
            Some(TraceCarrier {
                traceparent: "00-00000000000000000000000000000000-1234567890abcdef-01".into(),
            }),
        );
        assert!(operation.parent_id.is_none());
        assert!(finite_hex(&operation.trace_id, 32));
        assert!(
            write_payload(Path::new("/absent/native-telemetry"), "traces", &json!({})).is_err()
        );
    }
}
