use crate::{
    errors_generated::{AppError, ErrorCode, PublicError},
    llama::{HttpReply, LlamaOperation, LlamaProxy, LlamaRequest},
    relay::Relay,
    server::{self, ServerTask},
    settings::{SaveSettings, Settings, SettingsStore},
    source::{self, SourceSession},
    wire::*,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    path::PathBuf,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, State, Webview,
    ipc::{Channel, InvokeBody, Request},
};
use tokio::sync::watch;
use uuid::Uuid;

pub struct NativeState {
    relay: Mutex<Relay>,
    settings: Mutex<SettingsStore>,
    proxy: LlamaProxy,
    server: tokio::sync::Mutex<Option<ServerTask>>,
    lifecycle: tokio::sync::Mutex<()>,
    changes: watch::Sender<u64>,
    last_status: Mutex<String>,
    notification_stop: watch::Sender<bool>,
    pub exiting: AtomicBool,
    pub closed: AtomicBool,
}
fn state_error() -> AppError {
    AppError::new(ErrorCode::StateUnavailable)
}
impl NativeState {
    pub fn new(directory: PathBuf) -> Result<Self, AppError> {
        let settings = match SettingsStore::open(directory.clone()) {
            Ok(store) => store,
            Err(error) => SettingsStore::blocked(directory, error),
        };
        let mut relay = Relay::new(&settings.current);
        if let Some(error) = &settings.error {
            relay.record(error)?;
        }
        let (changes, _) = watch::channel(0);
        let (notification_stop, _) = watch::channel(false);
        Ok(Self {
            relay: Mutex::new(relay),
            settings: Mutex::new(settings),
            proxy: LlamaProxy::new()?,
            server: tokio::sync::Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(()),
            changes,
            last_status: Mutex::new(String::new()),
            notification_stop,
            exiting: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        })
    }
    fn relay(&self) -> Result<MutexGuard<'_, Relay>, AppError> {
        self.relay.lock().map_err(|_| state_error())
    }
    fn settings(&self) -> Result<MutexGuard<'_, SettingsStore>, AppError> {
        self.settings.lock().map_err(|_| state_error())
    }
    fn snapshot(&self) -> Result<EngineAttachment, AppError> {
        let relay = self.relay()?;
        Ok(EngineAttachment {
            status: relay.status.clone(),
            generation: relay.generation,
            source_session_id: relay.source.as_ref().map(|source| source.id.clone()),
        })
    }
    fn changed(&self) -> Result<(), AppError> {
        let status = serde_json::to_string(&self.relay()?.status).map_err(|_| state_error())?;
        let mut previous = self.last_status.lock().map_err(|_| state_error())?;
        if *previous != status {
            *previous = status;
            self.changes
                .send_modify(|revision| *revision = revision.wrapping_add(1));
        }
        Ok(())
    }
    pub fn project<T>(&self, result: Result<T, AppError>) -> Result<T, PublicError> {
        if let Err(error) = &result
            && let Err(record) = self.relay().and_then(|mut relay| relay.record(error))
        {
            eprintln!("{record}");
        }
        if let Err(error) = self.changed() {
            return Err(error.public());
        }
        result.map_err(|error| error.public())
    }
    pub fn start_tasks(&self, app: AppHandle) {
        let mut changes = self.changes.subscribe();
        let mut stop = self.notification_stop.subscribe();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut last: Option<tokio::time::Instant> = None;
            loop {
                tokio::select! {biased; _=stop.changed()=>break,result=changes.changed()=>if result.is_err(){break;} }
                if let Some(at) = last {
                    tokio::select! {biased; _=stop.changed()=>break,_=tokio::time::sleep_until(at+Duration::from_secs(1))=>{}}
                }
                changes.borrow_and_update();
                if let Err(_error) = handle.emit_to("main", "relay-status-changed", ()) {
                    eprintln!("RELAY_STATUS_NOTIFICATION_FAILED");
                }
                last = Some(tokio::time::Instant::now());
            }
        });
        tauri::async_runtime::spawn(async move {
            let state = app.state::<NativeState>();
            let _lifecycle = state.lifecycle.lock().await;
            let result = state.start_server().await;
            if let Err(error) = state.project(result) {
                eprintln!("RELAY_SERVER_START {}", error.diagnostic_id);
            }
        });
    }
    async fn start_server(&self) -> Result<(), AppError> {
        let settings = self.settings()?.get()?;
        let listener = server::bind(settings.overlay_port).await?;
        let hub = self.relay()?.hub.clone();
        *self.server.lock().await = Some(ServerTask::start(listener, settings.overlay_token, hub)?);
        Ok(())
    }
    pub async fn stop(&self, app: &AppHandle) -> Result<(), AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_locked(app)
    }
    fn stop_locked(&self, app: &AppHandle) -> Result<(), AppError> {
        let settings = self.settings()?.current.clone();
        let cancel = self.proxy.cancel_all();
        let reset = self.relay().and_then(|mut relay| relay.stop(&settings));
        let destroy = source::destroy(app);
        cancel.and(reset).and(destroy)
    }
    async fn stop_rejected(&self, app: &AppHandle, expected: &str) -> Result<(), AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        if self
            .relay()?
            .source
            .as_ref()
            .is_none_or(|source| source.id != expected)
        {
            return Ok(());
        }
        let result = self.stop_locked(app);
        self.relay()?.status.source = SourceState::Attention;
        result
    }
    async fn request(
        &self,
        input: LlamaRequest,
        expected: Option<u64>,
    ) -> Result<HttpReply, AppError> {
        let lifecycle = self.lifecycle.lock().await;
        if self.exiting.load(Ordering::SeqCst) {
            return Err(AppError::new(ErrorCode::OperationCancelled));
        }
        let settings = self.settings()?.get()?;
        let generation = self.relay()?.generation;
        if expected.is_some_and(|expected| generation != expected) {
            return Err(AppError::new(ErrorCode::OperationCancelled));
        }
        // Poll once under the lifecycle lock to register cancellation before a concurrent reset.
        let future = self.proxy.request(&settings.base_url, settings.mode, input);
        tokio::pin!(future);
        let first = futures_util::poll!(&mut future);
        drop(lifecycle);
        let result = match first {
            std::task::Poll::Ready(result) => result,
            std::task::Poll::Pending => future.await,
        };
        if self.relay()?.generation != generation {
            return Err(AppError::new(ErrorCode::OperationCancelled));
        }
        result
    }
    pub async fn shutdown(&self, app: &AppHandle) -> Result<(), AppError> {
        self.exiting.store(true, Ordering::SeqCst);
        let _lifecycle = self.lifecycle.lock().await;
        // Invalidate publication before closing the remote window; perform all cleanup even on failure.
        let settings = self.settings()?.current.clone();
        let mut failure = None;
        for result in [
            self.relay().and_then(|mut relay| relay.stop(&settings)),
            self.proxy.cancel_all(),
            source::destroy(app),
            self.relay().and_then(|relay| relay.hub.close()),
        ] {
            if let Err(error) = result {
                failure = Some(error);
            }
        }
        if let Some(task) = self.server.lock().await.take()
            && let Err(error) = task.shutdown().await
        {
            failure = Some(error);
        }
        self.notification_stop.send_replace(true);
        failure.map_or(Ok(()), Err)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineAttachment {
    pub status: RelayStatus,
    pub generation: u64,
    pub source_session_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    input: T,
}
fn input<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, AppError> {
    match request.body() {
        InvokeBody::Json(value) => Ok(decode::<Envelope<T>>(value.clone())?.input),
        InvokeBody::Raw(_) => Err(invalid()),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
fn empty(request: &Request<'_>) -> Result<(), AppError> {
    match request.body() {
        InvokeBody::Json(value) => {
            decode::<Empty>(value.clone())?;
            Ok(())
        }
        _ => Err(invalid()),
    }
}
pub fn local_url(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    let path = matches!(url.path(), "/" | "/index.html" | "");
    path && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && ((url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none())
            || dev.is_some_and(|dev| url.origin() == dev.origin()))
}
fn local(app: &AppHandle, webview: &Webview, state: &NativeState) -> Result<(), AppError> {
    if state.exiting.load(Ordering::SeqCst) || webview.label() != "main" {
        return Err(forbidden());
    }
    let url = webview.url().map_err(|_| forbidden())?;
    #[cfg(debug_assertions)]
    let dev = app.config().build.dev_url.as_ref();
    #[cfg(not(debug_assertions))]
    let dev: Option<&tauri::Url> = {
        let _app = app;
        None
    };
    if !local_url(&url, dev) {
        return Err(forbidden());
    }
    Ok(())
}
#[tauri::command]
pub async fn chat_ingest(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<IngestAck, PublicError> {
    let result = (|| {
        if state.exiting.load(Ordering::SeqCst) {
            return Err(forbidden());
        }
        let url = webview.url().map_err(|_| forbidden())?;
        state
            .relay()?
            .ingest(webview.label(), &url, input(&request)?, Instant::now())
    })();
    let mut destroy = None;
    if result.is_err() {
        let mut relay = state.relay().map_err(|error| error.public())?;
        // Only failures from the active source contribute to its rejection budget.
        if relay
            .source
            .as_ref()
            .is_some_and(|source| source.target.site.label() == webview.label())
        {
            relay.rejected = relay.rejected.saturating_add(1);
            if relay.rejected >= 3 {
                destroy = relay.source.as_ref().map(|source| source.id.clone());
            }
        }
    } else {
        state.relay().map_err(|error| error.public())?.rejected = 0;
    }
    if let Some(expected) = destroy {
        let stopped = state.stop_rejected(&app, &expected).await;
        if let Err(error) = stopped {
            return state.project(Err(error));
        }
    }
    state.project(result)
}
#[tauri::command]
pub async fn attach_engine(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    channel: Channel<EngineInput>,
) -> Result<EngineAttachment, PublicError> {
    let result = async {
        local(&app, &webview, &state)?;
        let _lifecycle = state.lifecycle.lock().await;
        state.proxy.cancel_all()?;
        let settings = state.settings()?.get()?;
        state.relay()?.attach(channel, &settings)?;
        let source = state.relay()?.source.clone();
        if let Some(source) = source {
            source::destroy(&app)?;
            source::create(&app, &source)?;
        }
        state.snapshot()
    }
    .await;
    state.project(result)
}
#[tauri::command]
pub fn ack_chat_batch(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<(), PublicError> {
    let result = (|| {
        local(&app, &webview, &state)?;
        state.relay()?.ack(input(&request)?)
    })();
    state.project(result)
}
#[tauri::command]
pub fn publish_comments(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<(), PublicError> {
    let result = (|| {
        local(&app, &webview, &state)?;
        state.relay()?.publish(input(&request)?)
    })();
    state.project(result)
}
#[tauri::command]
pub fn get_settings(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<Settings, PublicError> {
    let result = (|| {
        local(&app, &webview, &state)?;
        empty(&request)?;
        state.settings()?.get()
    })();
    state.project(result)
}
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<Settings, PublicError> {
    let result = async {
        local(&app, &webview, &state)?;
        let input: SaveSettings = input(&request)?;
        let _lifecycle = state.lifecycle.lock().await;
        let previous = state.settings()?.current.clone();
        let settings = match input.settings {
            Some(update) => previous.updated(update)?,
            None if input.reset_corrupt && state.settings()?.error.is_some() => Settings::default(),
            None => return Err(invalid()),
        };
        let needs_listener =
            settings.overlay_port != previous.overlay_port || state.server.lock().await.is_none();
        // Reserve the requested port before persisting; bind failure leaves the old settings/server intact.
        let listener = if needs_listener {
            Some(server::bind(settings.overlay_port).await?)
        } else {
            None
        };
        state
            .settings()?
            .persist(settings.clone(), input.reset_corrupt)?;
        state.proxy.cancel_all()?;
        {
            let mut relay = state.relay()?;
            relay.status.error = None;
            relay.status.inference = InferenceState::Idle;
            relay.reset(&settings)?;
            relay.settings_changed(&settings)?;
        }
        if let Some(listener) = listener {
            if let Some(task) = state.server.lock().await.take() {
                task.shutdown().await?;
            }
            let hub = state.relay()?.hub.clone();
            *state.server.lock().await = Some(ServerTask::start(
                listener,
                settings.overlay_token.clone(),
                hub,
            )?);
        }
        Ok(settings)
    }
    .await;
    state.project(result)
}
#[tauri::command]
pub async fn start_source(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<EngineAttachment, PublicError> {
    let result = async {
        local(&app, &webview, &state)?;
        let input: StartSource = input(&request)?;
        let source = SourceSession::new(source::normalize(&input.url)?);
        let _lifecycle = state.lifecycle.lock().await;
        let settings = state.settings()?.get()?;
        state.stop_locked(&app)?;
        state.relay()?.start(source.clone(), &settings)?;
        if let Err(error) = source::create(&app, &source) {
            let mut relay = state.relay()?;
            relay.stop(&settings)?;
            relay.status.source = SourceState::Failed;
            return Err(error);
        }
        state.snapshot()
    }
    .await;
    state.project(result)
}
#[tauri::command]
pub async fn stop_source(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<RelayStatus, PublicError> {
    let result = async {
        local(&app, &webview, &state)?;
        empty(&request)?;
        state.stop(&app).await?;
        Ok(state.relay()?.status.clone())
    }
    .await;
    state.project(result)
}
#[tauri::command]
pub fn get_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<RelayStatus, PublicError> {
    let result = (|| {
        local(&app, &webview, &state)?;
        empty(&request)?;
        Ok(state.relay()?.status.clone())
    })();
    state.project(result)
}
#[tauri::command]
pub async fn llama_request(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<HttpReply, PublicError> {
    let result = async {
        local(&app, &webview, &state)?;
        let input: LlamaRequest = input(&request)?;
        state.request(input, None).await
    }
    .await;
    state.project(result)
}
#[tauri::command]
pub fn cancel_llama(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<(), PublicError> {
    let result = (|| {
        local(&app, &webview, &state)?;
        let input: RequestId = input(&request)?;
        state.proxy.cancel(&input.request_id)
    })();
    state.project(result)
}
#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionReport {
    pub health: HttpReply,
    pub models: HttpReply,
}
#[tauri::command]
pub async fn check_connection(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<ConnectionReport, PublicError> {
    let result = async {
        local(&app, &webview, &state)?;
        empty(&request)?;
        let generation = state.relay()?.generation;
        {
            let mut relay = state.relay()?;
            relay.status.inference = InferenceState::Starting;
        }
        state.changed()?;
        let health = state
            .request(
                LlamaRequest {
                    request_id: Uuid::new_v4().to_string(),
                    operation: LlamaOperation::Health,
                    body: None,
                },
                Some(generation),
            )
            .await?;
        let models = state
            .request(
                LlamaRequest {
                    request_id: Uuid::new_v4().to_string(),
                    operation: LlamaOperation::Models,
                    body: None,
                },
                Some(generation),
            )
            .await?;
        let valid_health = serde_json::from_str::<serde_json::Value>(&health.body)
            .ok()
            .is_some_and(|value| value["status"] == "ok");
        let valid_models = serde_json::from_str::<serde_json::Value>(&models.body)
            .ok()
            .is_some_and(|value| {
                ["clef-flash", "plamo-3-translate-2b"].iter().all(|name| {
                    value["data"]
                        .as_array()
                        .is_some_and(|models| models.iter().any(|model| model["id"] == *name))
                })
            });
        let mut relay = state.relay()?;
        if relay.generation != generation {
            return Err(AppError::new(ErrorCode::OperationCancelled));
        }
        if health.status == 200 && models.status == 200 && valid_health && valid_models {
            relay.status.inference = InferenceState::Ready;
            relay.status.error = None;
        } else {
            relay.status.inference = InferenceState::Degraded;
            relay.record(&AppError::new(ErrorCode::ModelRefused))?;
        }
        relay.hub.status(relay.status.clone())?;
        Ok(ConnectionReport { health, models })
    }
    .await;
    if result
        .as_ref()
        .is_err_and(|error: &AppError| !matches!(error.code, ErrorCode::OperationCancelled))
        && let Ok(mut relay) = state.relay()
    {
        relay.status.inference = InferenceState::Degraded;
    }
    state.project(result)
}
#[tauri::command]
pub fn select_model_file(
    app: AppHandle,
    webview: Webview,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> Result<Option<String>, PublicError> {
    let result = (|| {
        local(&app, &webview, &state)?;
        let input: SelectModelFile = input(&request)?;
        match input.model {
            Model::Clef | Model::Plamo => Err(AppError::new(ErrorCode::RelayFeatureUnavailable)),
        }
    })();
    state.project(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_controls_refuse_remote_pages_and_only_debug_accepts_selected_dev_origin()
    -> Result<(), Box<dyn std::error::Error>> {
        for url in [
            "https://youtube.com/live_chat",
            "https://evil.invalid",
            "http://127.0.0.1:18084/overlay/token",
            "tauri://evil.invalid",
            "tauri://localhost/other",
        ] {
            assert!(!local_url(&tauri::Url::parse(url)?, None));
        }
        assert!(local_url(
            &tauri::Url::parse("tauri://localhost/index.html")?,
            None
        ));
        let dev = tauri::Url::parse("http://127.0.0.1:5174")?;
        assert!(local_url(&dev, Some(&dev)));
        assert!(!local_url(&dev, None));
        Ok(())
    }
}
