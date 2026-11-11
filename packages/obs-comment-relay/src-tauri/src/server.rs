use crate::{
    errors_generated::{AppError, ErrorCode},
    wire::{self, RelayComment, RelayStatus, RelayView},
};
use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{
        Html, IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::get,
};
use futures_util::stream;
use serde::Serialize;
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
};
use uuid::Uuid;

#[derive(Clone)]
struct Message {
    name: &'static str,
    id: String,
    data: String,
}
impl Message {
    fn event(self) -> Event {
        Event::default()
            .event(self.name)
            .id(self.id)
            .data(self.data)
    }
}
struct SubscriberSender {
    tx: mpsc::Sender<Message>,
    stop: watch::Sender<bool>,
}
struct HubInner {
    status: RelayStatus,
    view: RelayView,
    seq: u64,
    subscribers: HashMap<Uuid, SubscriberSender>,
    closed: bool,
}
#[derive(Clone)]
pub struct Hub(Arc<Mutex<HubInner>>);
impl Hub {
    pub fn new(status: RelayStatus, view: RelayView) -> Self {
        Self(Arc::new(Mutex::new(HubInner {
            status,
            view,
            seq: 0,
            subscribers: HashMap::new(),
            closed: false,
        })))
    }
    fn lock(&self) -> Result<MutexGuard<'_, HubInner>, AppError> {
        self.0
            .lock()
            .map_err(|_| AppError::new(ErrorCode::StateUnavailable))
    }
    fn message(
        inner: &mut HubInner,
        name: &'static str,
        data: impl Serialize,
    ) -> Result<Message, AppError> {
        inner.seq = inner
            .seq
            .checked_add(1)
            .filter(|n| *n <= wire::MAX_INTEGER)
            .ok_or_else(wire::invalid)?;
        Ok(Message {
            name,
            id: format!("{}:{}", inner.status.session_id, inner.seq),
            data: serde_json::to_string(&data)
                .map_err(|_| AppError::new(ErrorCode::ResponseInvalid))?,
        })
    }
    fn send(inner: &mut HubInner, message: Message) {
        inner.subscribers.retain(|_, subscriber| {
            if subscriber.tx.try_send(message.clone()).is_err() {
                subscriber.stop.send_replace(true);
                false
            } else {
                true
            }
        });
    }
    pub fn reset(&self, status: RelayStatus, view: RelayView) -> Result<(), AppError> {
        let mut inner = self.lock()?;
        inner.status = status;
        inner.view = view;
        inner.seq = 0;
        let session = inner.status.session_id.clone();
        let reset = Self::message(
            &mut inner,
            "relay.reset.v1",
            serde_json::json!({"v":1,"sessionId":session}),
        )?;
        Self::send(&mut inner, reset);
        let view = inner.view.clone();
        let config = Self::message(&mut inner, "relay.config.v1", view)?;
        Self::send(&mut inner, config);
        let status = inner.status.clone();
        let event = Self::message(&mut inner, "relay.status.v1", status)?;
        Self::send(&mut inner, event);
        Ok(())
    }
    pub fn status(&self, status: RelayStatus) -> Result<(), AppError> {
        let mut inner = self.lock()?;
        if serde_json::to_value(&inner.status).map_err(|_| wire::invalid())?
            == serde_json::to_value(&status).map_err(|_| wire::invalid())?
        {
            return Ok(());
        }
        inner.status = status.clone();
        let message = Self::message(&mut inner, "relay.status.v1", status)?;
        Self::send(&mut inner, message);
        Ok(())
    }
    pub fn comment(&self, mut comment: RelayComment) -> Result<(), AppError> {
        let mut inner = self.lock()?;
        if inner.closed || comment.session_id != inner.status.session_id {
            return Err(wire::forbidden());
        }
        comment.seq = inner.seq.checked_add(1).ok_or_else(wire::invalid)?;
        comment.published_at = wire::now()?;
        let message = Self::message(&mut inner, "relay.comment.v1", comment)?;
        Self::send(&mut inner, message);
        Ok(())
    }
    fn subscribe(&self) -> Result<Subscriber, AppError> {
        let mut inner = self.lock()?;
        if inner.closed || inner.subscribers.len() >= 4 {
            return Err(AppError::new(ErrorCode::QueueFull));
        }
        let (tx, rx) = mpsc::channel(64);
        let (stop, cancel) = watch::channel(false);
        let id = Uuid::new_v4();
        let session = inner.status.session_id.clone();
        let reset = Self::message(
            &mut inner,
            "relay.reset.v1",
            serde_json::json!({"v":1,"sessionId":session}),
        )?;
        let view = inner.view.clone();
        let config = Self::message(&mut inner, "relay.config.v1", view)?;
        let status = inner.status.clone();
        let status = Self::message(&mut inner, "relay.status.v1", status)?;
        for message in [reset, config, status] {
            tx.try_send(message)
                .map_err(|_| AppError::new(ErrorCode::QueueFull))?;
        }
        inner.subscribers.insert(id, SubscriberSender { tx, stop });
        Ok(Subscriber {
            id,
            hub: self.clone(),
            rx,
            cancel,
        })
    }
    pub fn close_subscribers(&self) -> Result<(), AppError> {
        let mut inner = self.lock()?;
        for (_, subscriber) in inner.subscribers.drain() {
            subscriber.stop.send_replace(true);
        }
        Ok(())
    }
    pub fn close(&self) -> Result<(), AppError> {
        self.lock()?.closed = true;
        self.close_subscribers()
    }
}
struct Subscriber {
    id: Uuid,
    hub: Hub,
    rx: mpsc::Receiver<Message>,
    cancel: watch::Receiver<bool>,
}
impl Subscriber {
    async fn next(&mut self) -> Option<Message> {
        if *self.cancel.borrow() {
            return None;
        }
        tokio::select! { biased; _=self.cancel.changed()=>None,message=self.rx.recv()=>message }
    }
}
impl Drop for Subscriber {
    fn drop(&mut self) {
        match self.hub.lock() {
            Ok(mut inner) => {
                inner.subscribers.remove(&self.id);
            }
            Err(error) => eprintln!("{}", error),
        }
    }
}
#[derive(Clone)]
struct HttpState {
    hub: Hub,
    token: String,
    authority: String,
}
fn authorized(headers: &HeaderMap, authority: &str) -> bool {
    headers.get_all(header::HOST).iter().count() == 1
        && headers.get(header::HOST).and_then(|v| v.to_str().ok()) == Some(authority)
        && headers.get_all(header::ORIGIN).iter().count() <= 1
        && headers
            .get(header::ORIGIN)
            .is_none_or(|v| v.to_str().ok() == Some(format!("http://{authority}").as_str()))
}
fn failure(status: StatusCode, code: ErrorCode) -> Response {
    (status, Json(AppError::new(code).public())).into_response()
}
async fn guard(State(state): State<HttpState>, request: Request, next: Next) -> Response {
    let mut response = if authorized(request.headers(), &state.authority) {
        next.run(request).await
    } else {
        failure(StatusCode::FORBIDDEN, ErrorCode::RelaySenderForbidden)
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY,header::HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response
}
async fn overlay(State(state): State<HttpState>, Path(token): Path<String>) -> Response {
    if token != state.token {
        return failure(StatusCode::NOT_FOUND, ErrorCode::ResourceMissing);
    }
    Html(include_str!("../overlay/index.html")).into_response()
}
async fn events(State(state): State<HttpState>, Path(token): Path<String>) -> Response {
    if token != state.token {
        return failure(StatusCode::NOT_FOUND, ErrorCode::ResourceMissing);
    }
    let subscriber = match state.hub.subscribe() {
        Ok(subscriber) => subscriber,
        Err(error) => {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(error.public())).into_response();
        }
    };
    let stream = stream::unfold(subscriber, |mut subscriber| async move {
        subscriber
            .next()
            .await
            .map(|message| (Ok::<_, Infallible>(message.event()), subscriber))
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}
async fn assets(Path(asset): Path<String>) -> Response {
    match asset.as_str() {
        "overlay.js" => (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            include_str!("../overlay/overlay.js"),
        )
            .into_response(),
        "overlay.css" => (
            [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
            include_str!("../overlay/overlay.css"),
        )
            .into_response(),
        _ => failure(StatusCode::NOT_FOUND, ErrorCode::ResourceMissing),
    }
}
fn router(state: HttpState) -> Router {
    Router::new()
        .route("/overlay/{token}", get(overlay))
        .route("/events/{token}", get(events))
        .route("/assets/{*asset}", get(assets))
        .fallback(|| async { failure(StatusCode::NOT_FOUND, ErrorCode::ResourceMissing) })
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}
pub async fn bind(port: u16) -> Result<TcpListener, AppError> {
    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| AppError::new(ErrorCode::RelayBindFailed))
}
pub struct ServerTask {
    stop: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<Result<(), AppError>>,
    hub: Hub,
}
impl ServerTask {
    pub fn start(listener: TcpListener, token: String, hub: Hub) -> Result<Self, AppError> {
        let authority = listener
            .local_addr()
            .map_err(|_| AppError::new(ErrorCode::RelayBindFailed))?
            .to_string();
        let state = HttpState {
            hub: hub.clone(),
            token,
            authority,
        };
        let (stop, mut signal) = watch::channel(false);
        let task = tauri::async_runtime::spawn(async move {
            axum::serve(listener, router(state))
                .with_graceful_shutdown(async move {
                    if !*signal.borrow() {
                        let _change = signal.changed().await;
                    }
                })
                .await
                .map_err(|_| AppError::new(ErrorCode::NetworkFailed))
        });
        Ok(Self { stop, task, hub })
    }
    pub async fn shutdown(self) -> Result<(), AppError> {
        self.hub.close_subscribers()?;
        self.stop.send_replace(true);
        self.task
            .await
            .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;
    #[test]
    fn rejects_foreign_host_origin_null_and_duplicate_headers()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:18084".parse()?);
        assert!(authorized(&headers, "127.0.0.1:18084"));
        for origin in [
            "null",
            "https://evil.invalid",
            "http://localhost:18084",
            "http://127.0.0.1:18085",
        ] {
            headers.insert(header::ORIGIN, origin.parse()?);
            assert!(!authorized(&headers, "127.0.0.1:18084"));
        }
        headers.insert(header::ORIGIN, "http://127.0.0.1:18084".parse()?);
        assert!(authorized(&headers, "127.0.0.1:18084"));
        headers.append(header::HOST, "evil.invalid".parse()?);
        assert!(!authorized(&headers, "127.0.0.1:18084"));
        Ok(())
    }
    #[tokio::test]
    async fn loopback_routes_require_token_host_and_origin_and_close_sse_before_listener()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = bind(0).await?;
        let address = listener.local_addr()?;
        let base = format!("http://{address}");
        assert!(bind(address.port()).await.is_err());
        let hub = Hub::new(RelayStatus::default(), Settings::default().view());
        let server = ServerTask::start(listener, "secret".into(), hub.clone())?;
        let client = reqwest::Client::builder().no_proxy().build()?;
        for path in [
            "/overlay",
            "/events",
            "/overlay/wrong",
            "/events/wrong",
            "/health",
            "/assets/private",
        ] {
            assert_eq!(
                client.get(format!("{base}{path}")).send().await?.status(),
                404
            );
        }
        for path in ["/overlay/secret", "/events/secret", "/assets/overlay.js"] {
            for (name, value) in [
                ("host", "evil.invalid"),
                ("origin", "null"),
                ("origin", "https://evil.invalid"),
            ] {
                let response = client
                    .get(format!("{base}{path}"))
                    .header(name, value)
                    .send()
                    .await?;
                assert_eq!(response.status(), 403);
                assert!(
                    response
                        .headers()
                        .get("access-control-allow-origin")
                        .is_none()
                );
            }
        }
        let response = client.get(format!("{base}/overlay/secret")).send().await?;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()?
                .contains("connect-src 'self'")
        );
        let mut response = client
            .get(format!("{base}/events/secret"))
            .header("origin", &base)
            .header("last-event-id", "old:999")
            .send()
            .await?;
        assert_eq!(response.status(), 200);
        let chunk = response
            .chunk()
            .await?
            .ok_or("Missing SSE initial snapshot")?;
        let data = std::str::from_utf8(&chunk)?;
        assert!(data.contains("relay.reset.v1"));
        assert!(!data.contains("relay.comment.v1"));
        tokio::time::timeout(Duration::from_secs(2), server.shutdown()).await??;
        while tokio::time::timeout(Duration::from_secs(2), response.chunk())
            .await??
            .is_some()
        {}
        let listener = bind(address.port()).await?;
        drop(listener);
        Ok(())
    }
    #[tokio::test]
    async fn bounds_subscribers_and_disconnects_slow_consumers_without_replay()
    -> Result<(), AppError> {
        let status = RelayStatus::default();
        let hub = Hub::new(status.clone(), Settings::default().view());
        let mut slow = hub.subscribe()?;
        let two = hub.subscribe()?;
        let three = hub.subscribe()?;
        let four = hub.subscribe()?;
        assert!(hub.subscribe().is_err());
        drop(two);
        drop(three);
        drop(four);
        for i in 0..65 {
            let mut changed = status.clone();
            changed.counters.accepted = i;
            hub.status(changed)?;
        }
        assert!(slow.next().await.is_none());
        let mut fresh = hub.subscribe()?;
        for expected in ["relay.reset.v1", "relay.config.v1", "relay.status.v1"] {
            assert_eq!(fresh.next().await.ok_or_else(wire::invalid)?.name, expected);
        }
        hub.close()?;
        assert!(fresh.next().await.is_none());
        Ok(())
    }
}
