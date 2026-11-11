use crate::{errors_generated::AppError, wire::invalid};
pub fn loopback_base(input: &str) -> Result<String, AppError> {
    let url = tauri::Url::parse(input).map_err(|_| invalid())?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err(invalid());
    }
    Ok(format!(
        "http://127.0.0.1:{}",
        url.port_or_known_default().ok_or_else(invalid)?
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_never_keeps_hostname_or_accepts_remote_routing() -> Result<(), AppError> {
        assert_eq!(
            loopback_base("http://localhost:18083")?,
            "http://127.0.0.1:18083"
        );
        for url in [
            "https://localhost:18083",
            "http://user@127.0.0.1:18083",
            "http://127.0.0.1:18083/v1",
            "http://127.0.0.1:18083/?x=1",
            "http://192.168.1.1:18083",
            "http://[::1]:18083",
            "http://evil.invalid:18083",
            "http://localhost:0",
        ] {
            assert!(loopback_base(url).is_err(), "{url}");
        }
        Ok(())
    }
}

use crate::{
    errors_generated::ErrorCode,
    settings::{LANGUAGES, LlamaMode},
    wire::{self, MAX_BYTES},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use uuid::Uuid;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LlamaOperation {
    Health,
    Models,
    Clef,
    Plamo,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlamaRequest {
    pub request_id: String,
    pub operation: LlamaOperation,
    #[serde(default)]
    pub body: Option<Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpReply {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClefBody {
    model: String,
    state: String,
    questions: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserMessage {
    role: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateKwargs {
    target_lang: String,
    #[serde(default)]
    source_lang: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlamoBody {
    model: String,
    messages: Vec<UserMessage>,
    stream: bool,
    max_tokens: u16,
    temperature: f64,
    stop: Vec<String>,
    chat_template_kwargs: TemplateKwargs,
    #[serde(default)]
    id_slot: Option<u8>,
    #[serde(default)]
    cache_prompt: Option<bool>,
}
struct Plan {
    method: reqwest::Method,
    path: &'static str,
    body: Option<Vec<u8>>,
}
fn plan(request: &LlamaRequest, mode: LlamaMode) -> Result<Plan, AppError> {
    if !wire::uuid(&request.request_id) {
        return Err(invalid());
    }
    let value = request.body.clone().unwrap_or(Value::Null);
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid());
    }
    let path = match request.operation {
        LlamaOperation::Health | LlamaOperation::Models => {
            if !value.is_null() {
                return Err(invalid());
            }
            return Ok(Plan {
                method: reqwest::Method::GET,
                path: if request.operation == LlamaOperation::Health {
                    "/health"
                } else {
                    "/v1/models"
                },
                body: None,
            });
        }
        LlamaOperation::Clef => {
            let body: ClefBody = wire::decode(value)?;
            if body.model != "clef-flash"
                || body.state.is_empty()
                || body.questions.len() != 1
                || body.questions.values().any(|q| q.is_empty())
                || body.questions.keys().any(|key| key != "c1")
            {
                return Err(invalid());
            }
            "/v1/systemone"
        }
        LlamaOperation::Plamo => {
            let body: PlamoBody = wire::decode(value)?;
            if body.model != "plamo-3-translate-2b"
                || body.messages.len() != 1
                || body
                    .messages
                    .iter()
                    .any(|message| message.role != "user" || !wire::text(&message.content, 1, 1000))
                || body.stream
                || !(1..=256).contains(&body.max_tokens)
                || body.temperature != 0.0
                || body.stop != ["<|plamo:tag|>", "<|plamo:bos|>"]
                || body.chat_template_kwargs.target_lang != "ja"
                || body
                    .chat_template_kwargs
                    .source_lang
                    .as_ref()
                    .is_some_and(|lang| lang == "auto" || !LANGUAGES.contains(&lang.as_str()))
                || body
                    .id_slot
                    .is_some_and(|slot| slot != 0 || mode == LlamaMode::External)
            {
                return Err(invalid());
            }
            // Both values are part of the existing shared client's bounded transport contract.
            let _cache_prompt = body.cache_prompt;
            "/v1/chat/completions"
        }
    };
    Ok(Plan {
        method: reqwest::Method::POST,
        path,
        body: Some(bytes),
    })
}
struct Active {
    operation: LlamaOperation,
    identity: Uuid,
    cancel: watch::Sender<bool>,
}
#[derive(Clone)]
pub struct LlamaProxy {
    client: reqwest::Client,
    active: Arc<Mutex<HashMap<String, Active>>>,
}
struct Reservation {
    proxy: LlamaProxy,
    id: String,
    identity: Uuid,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        match self.proxy.active.lock() {
            Ok(mut active) => {
                if active
                    .get(&self.id)
                    .is_some_and(|request| request.identity == self.identity)
                {
                    active.remove(&self.id);
                }
            }
            Err(_) => eprintln!("RELAY_REQUEST_STATE_UNAVAILABLE"),
        }
    }
}
impl LlamaProxy {
    pub fn new() -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(1)
            .build()
            .map_err(|_| AppError::new(ErrorCode::NetworkFailed))?;
        Ok(Self {
            client,
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    pub fn cancel(&self, id: &str) -> Result<(), AppError> {
        if !wire::uuid(id) {
            return Err(invalid());
        }
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
        if let Some(request) = active.get(id) {
            request.cancel.send_replace(true);
        }
        Ok(())
    }
    pub fn cancel_all(&self) -> Result<(), AppError> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
        for request in active.values() {
            request.cancel.send_replace(true);
        }
        Ok(())
    }
    pub async fn request(
        &self,
        base: &str,
        mode: LlamaMode,
        input: LlamaRequest,
    ) -> Result<HttpReply, AppError> {
        let plan = plan(&input, mode)?;
        let base = loopback_base(base)?;
        if mode == LlamaMode::Managed {
            return Err(AppError::new(ErrorCode::RelayFeatureUnavailable));
        }
        let (cancel, mut signal) = watch::channel(false);
        let identity = Uuid::new_v4();
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
            if active.len() >= 4
                || active.contains_key(&input.request_id)
                || active
                    .values()
                    .any(|request| request.operation == input.operation)
            {
                return Err(AppError::new(ErrorCode::QueueFull));
            }
            active.insert(
                input.request_id.clone(),
                Active {
                    operation: input.operation,
                    identity,
                    cancel,
                },
            );
        }
        let _reservation = Reservation {
            proxy: self.clone(),
            id: input.request_id,
            identity,
        };
        tokio::select! {biased;
            _=signal.changed()=>Err(AppError::new(ErrorCode::OperationCancelled)),
            result=self.send(base,plan)=>result,
        }
    }
    async fn send(&self, base: String, plan: Plan) -> Result<HttpReply, AppError> {
        let mut request = self
            .client
            .request(plan.method, format!("{base}{}", plan.path));
        if let Some(body) = plan.body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| AppError::new(ErrorCode::NetworkFailed))?;
        let status = response.status().as_u16();
        let mut headers = BTreeMap::new();
        if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
            let value = content_type
                .to_str()
                .map_err(|_| AppError::new(ErrorCode::ResponseInvalid))?;
            if value.len() > 256 {
                return Err(AppError::new(ErrorCode::ResponseInvalid));
            }
            headers.insert("content-type".into(), value.into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES as u64)
        {
            return Err(AppError::new(ErrorCode::ResponseInvalid));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AppError::new(ErrorCode::NetworkFailed))?
        {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(AppError::new(ErrorCode::ResponseInvalid));
            }
            bytes.extend_from_slice(&chunk);
        }
        let body =
            String::from_utf8(bytes).map_err(|_| AppError::new(ErrorCode::ResponseInvalid))?;
        Ok(HttpReply {
            status,
            headers,
            body,
        })
    }
}
#[cfg(test)]
mod proxy_tests {
    use super::*;
    use axum::{Router, http::StatusCode, routing::get};
    fn request(operation: LlamaOperation, body: Value) -> LlamaRequest {
        LlamaRequest {
            request_id: Uuid::new_v4().to_string(),
            operation,
            body: Some(body),
        }
    }
    #[test]
    fn allows_only_known_operations_models_and_body_fields() -> Result<(), AppError> {
        let clef = serde_json::json!({"model":"clef-flash","state":"fixture","questions":{"c1":"fixture"}});
        assert_eq!(
            plan(
                &request(LlamaOperation::Clef, clef.clone()),
                LlamaMode::External
            )?
            .path,
            "/v1/systemone"
        );
        for (key, value) in [
            ("model", serde_json::json!("other")),
            ("headers", serde_json::json!({})),
            ("url", serde_json::json!("http://evil.invalid")),
        ] {
            let mut body = clef.clone();
            body[key] = value;
            assert!(plan(&request(LlamaOperation::Clef, body), LlamaMode::External).is_err());
        }
        assert!(plan(&request(LlamaOperation::Health, clef), LlamaMode::External).is_err());
        let plamo = serde_json::json!({"model":"plamo-3-translate-2b","messages":[{"role":"user","content":"Hello"}],"stream":false,"max_tokens":128,"temperature":0,"stop":["<|plamo:tag|>","<|plamo:bos|>"],"chat_template_kwargs":{"target_lang":"ja"},"cache_prompt":true});
        assert_eq!(
            plan(
                &request(LlamaOperation::Plamo, plamo.clone()),
                LlamaMode::External
            )?
            .path,
            "/v1/chat/completions"
        );
        for (key, value) in [
            ("model", serde_json::json!("gemma")),
            ("stream", serde_json::json!(true)),
            ("max_tokens", serde_json::json!(257)),
            ("id_slot", serde_json::json!(0)),
            ("grammar", serde_json::json!("anything")),
        ] {
            let mut body = plamo.clone();
            body[key] = value;
            assert!(plan(&request(LlamaOperation::Plamo, body), LlamaMode::External).is_err());
        }
        assert!(
            wire::decode::<LlamaRequest>(
                serde_json::json!({"requestId":Uuid::new_v4().to_string(),"operation":"props"})
            )
            .is_err()
        );
        Ok(())
    }
    #[tokio::test]
    async fn preserves_http_failure_refuses_redirect_and_limits_response_body()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = crate::server::bind(0).await?;
        let address = listener.local_addr()?;
        let app = Router::new()
            .route(
                "/health",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [("location", "http://192.0.2.1/private")],
                        "redirect",
                    )
                }),
            )
            .route(
                "/v1/models",
                get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "not ready") }),
            );
        let task = tokio::spawn(async move { axum::serve(listener, app).await });
        let proxy = LlamaProxy::new()?;
        let base = format!("http://{address}");
        let redirect = proxy
            .request(
                &base,
                LlamaMode::External,
                request(LlamaOperation::Health, Value::Null),
            )
            .await?;
        assert_eq!(redirect.status, 302);
        assert_eq!(redirect.body, "redirect");
        assert!(!redirect.headers.contains_key("location"));
        assert_eq!(
            proxy
                .request(
                    &base,
                    LlamaMode::External,
                    request(LlamaOperation::Models, Value::Null)
                )
                .await?
                .status,
            503
        );
        task.abort();
        let listener = crate::server::bind(0).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/health", get(|| async { "x".repeat(MAX_BYTES + 1) })),
            )
            .await
        });
        assert!(
            proxy
                .request(
                    &base,
                    LlamaMode::External,
                    request(LlamaOperation::Health, Value::Null)
                )
                .await
                .is_err()
        );
        task.abort();
        assert!(proxy.active.lock().map_err(|_| invalid())?.is_empty());
        Ok(())
    }
    #[tokio::test]
    async fn cancellation_releases_bounded_request_reservation()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = crate::server::bind(0).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let started = Arc::new(tokio::sync::Notify::new());
        let notification = started.clone();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/health",
                    get(move || {
                        let started = started.clone();
                        async move {
                            started.notify_one();
                            std::future::pending::<&str>().await
                        }
                    }),
                ),
            )
            .await
        });
        let proxy = LlamaProxy::new()?;
        let input = request(LlamaOperation::Health, Value::Null);
        let id = input.request_id.clone();
        let cloned = proxy.clone();
        let pending =
            tokio::spawn(async move { cloned.request(&base, LlamaMode::External, input).await });
        tokio::time::timeout(Duration::from_secs(2), notification.notified()).await?;
        proxy.cancel(&id)?;
        let result = tokio::time::timeout(Duration::from_secs(2), pending).await??;
        assert_eq!(
            result.err().ok_or("Expected cancellation")?.public().code,
            "cancelled"
        );
        assert!(proxy.active.lock().map_err(|_| invalid())?.is_empty());
        task.abort();
        Ok(())
    }
}
