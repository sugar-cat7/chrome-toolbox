use crate::errors_generated::{AppError, ErrorCode, PublicError};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const MAX_BYTES: usize = 64 * 1024;
pub const MAX_INTEGER: u64 = 9_007_199_254_740_991;
pub fn invalid() -> AppError {
    AppError::new(ErrorCode::RelayInputInvalid)
}
pub fn forbidden() -> AppError {
    AppError::new(ErrorCode::RelaySenderForbidden)
}
pub fn uuid(value: &str) -> bool {
    value.len() == 36
        && Uuid::parse_str(value).is_ok_and(|uuid| {
            uuid.is_nil()
                || uuid == Uuid::max()
                || (uuid.get_variant() == uuid::Variant::RFC4122
                    && (1..=8).contains(&uuid.get_version_num()))
        })
}
pub fn text(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.encode_utf16().count())
}
pub fn now() -> Result<u64, AppError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::new(ErrorCode::ClockInvalid))?
        .as_millis();
    u64::try_from(millis)
        .ok()
        .filter(|n| *n <= MAX_INTEGER)
        .ok_or_else(|| AppError::new(ErrorCode::ClockInvalid))
}
pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T, AppError> {
    // Tauri has already decoded the IPC envelope; this bounds the handler, not the transport.
    if serde_json::to_vec(&value).map_err(|_| invalid())?.len() > MAX_BYTES {
        return Err(invalid());
    }
    serde_json::from_value(value).map_err(|_| invalid())
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    Youtube,
    Twitch,
}
impl Site {
    pub fn label(self) -> &'static str {
        match self {
            Self::Youtube => "source-youtube",
            Self::Twitch => "source-twitch",
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorRole {
    Owner,
    Moderator,
    Verified,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawChatComment {
    pub id: String,
    pub author: String,
    pub text: String,
    pub at: u64,
    #[serde(
        default,
        deserialize_with = "optional_role",
        skip_serializing_if = "Option::is_none"
    )]
    pub role: Option<AuthorRole>,
}
fn optional_role<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AuthorRole>, D::Error> {
    AuthorRole::deserialize(deserializer).map(Some)
}
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
impl RawChatComment {
    pub fn validate(&self) -> Result<(), AppError> {
        if !text(&self.id, 1, 256)
            || !text(&self.author, 0, 256)
            || !text(&self.text, 1, 1000)
            || self.at > MAX_INTEGER
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReaderState {
    Waiting,
    Reading,
    Attention,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChatIngest {
    Comments {
        v: u8,
        source_session_id: String,
        batch_id: String,
        site: Site,
        channel: String,
        comments: Vec<RawChatComment>,
    },
    State {
        v: u8,
        source_session_id: String,
        batch_id: String,
        site: Site,
        channel: String,
        state: ReaderState,
    },
}
impl ChatIngest {
    pub fn context(&self) -> (u8, &str, &str, Site, &str) {
        match self {
            Self::Comments {
                v,
                source_session_id,
                batch_id,
                site,
                channel,
                ..
            }
            | Self::State {
                v,
                source_session_id,
                batch_id,
                site,
                channel,
                ..
            } => (*v, source_session_id, batch_id, *site, channel),
        }
    }
    pub fn validate(&self) -> Result<(), AppError> {
        let (v, session, batch, _, channel) = self.context();
        if v != 1 || !uuid(session) || !uuid(batch) || !text(channel, 1, 256) {
            return Err(invalid());
        }
        if let Self::Comments { comments, .. } = self {
            if !(1..=16).contains(&comments.len()) {
                return Err(invalid());
            }
            for comment in comments {
                comment.validate()?;
            }
        }
        Ok(())
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IngestAck {
    pub batch_id: String,
    pub accepted: usize,
    pub dropped: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedComment {
    pub comment: RawChatComment,
    pub received_at: u64,
    pub seq: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EngineInput {
    ChatBatch {
        session_id: String,
        generation: u64,
        batch_id: String,
        site: Site,
        channel: String,
        comments: Vec<ReceivedComment>,
    },
    SourceReset {
        session_id: String,
        generation: u64,
        source_session_id: Option<String>,
        site: Option<Site>,
        channel: Option<String>,
    },
    SettingsChanged {
        session_id: String,
        generation: u64,
        settings: crate::settings::EngineSettings,
    },
    Stop {
        session_id: String,
        generation: u64,
    },
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TranslationState {
    Translated,
    Disabled,
    Unnecessary,
    Unsupported,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AllowedFilter {
    pub verdict: Allowed,
    pub probability: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Allowed {
    Allowed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum Translator {
    #[serde(rename = "plamo-3-translate-2b")]
    Plamo,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayComment {
    pub v: u8,
    pub session_id: String,
    pub id: String,
    pub seq: u64,
    pub site: Site,
    pub channel: String,
    pub author: String,
    pub original: String,
    #[serde(deserialize_with = "nullable")]
    pub translation: Option<String>,
    pub translation_state: TranslationState,
    pub at: u64,
    pub received_at: u64,
    pub published_at: u64,
    pub filter: AllowedFilter,
    #[serde(deserialize_with = "nullable")]
    pub translator: Option<Translator>,
}
impl RelayComment {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.v != 1
            || !uuid(&self.session_id)
            || !text(&self.id, 1, 256)
            || !text(&self.author, 0, 256)
            || !text(&self.original, 1, 1000)
            || !text(&self.channel, 1, 256)
            || self.translation.as_ref().is_some_and(|s| !text(s, 0, 2000))
            || [self.seq, self.at, self.received_at, self.published_at]
                .iter()
                .any(|n| *n > MAX_INTEGER)
            || !self.filter.probability.is_finite()
            || !(0.0..=1.0).contains(&self.filter.probability)
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishComments {
    pub session_id: String,
    pub generation: u64,
    pub comments: Vec<RelayComment>,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayCounters {
    pub accepted: u64,
    pub dropped: u64,
    pub published: u64,
    pub filtered: u64,
    pub failed: u64,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SourceState {
    Stopped,
    Connecting,
    Reading,
    Attention,
    Failed,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InferenceState {
    Idle,
    Starting,
    Ready,
    Degraded,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayStatus {
    pub v: u8,
    pub session_id: String,
    pub source: SourceState,
    pub inference: InferenceState,
    pub counters: RelayCounters,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PublicError>,
}
impl Default for RelayStatus {
    fn default() -> Self {
        Self {
            v: 1,
            session_id: Uuid::new_v4().to_string(),
            source: SourceState::Stopped,
            inference: InferenceState::Idle,
            counters: RelayCounters::default(),
            error: None,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    Translated,
    Original,
    Both,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayView {
    pub v: u8,
    pub display: DisplayMode,
    pub max_items: u8,
    pub translate: bool,
    pub attribution: &'static str,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSource {
    pub url: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AckChatBatch {
    pub session_id: String,
    pub generation: u64,
    pub batch_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestId {
    pub request_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    Clef,
    Plamo,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectModelFile {
    pub model: Model,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn ingest() -> Value {
        json!({"kind":"comments","v":1,"sourceSessionId":"5a78ed3a-a355-4bef-8fc6-238505f23858","batchId":"ce65017d-1c12-4ca4-af5c-1b9713580485","site":"youtube","channel":"abcdefghijk","comments":[{"id":"c","author":"a","text":"hello","at":1}]})
    }
    #[test]
    fn rejects_unknown_ingest_and_comment_fields() {
        let mut value = ingest();
        value["url"] = json!("https://evil.invalid");
        assert!(serde_json::from_value::<ChatIngest>(value).is_err());
        let mut value = ingest();
        value["comments"][0]["extra"] = json!(true);
        assert!(serde_json::from_value::<ChatIngest>(value).is_err());
    }
    #[test]
    fn enforces_utf16_count_version_batch_and_safe_time() -> Result<(), AppError> {
        for (field, value) in [
            ("v", json!(2)),
            ("sourceSessionId", json!("bad")),
            ("comments", json!([])),
            (
                "comments",
                json!(
                    (0..17)
                        .map(|_| ingest()["comments"][0].clone())
                        .collect::<Vec<_>>()
                ),
            ),
        ] {
            let mut input = ingest();
            input[field] = value;
            assert!(decode::<ChatIngest>(input)?.validate().is_err());
        }
        for value in [json!("😀".repeat(501)), json!("")] {
            let mut input = ingest();
            input["comments"][0]["text"] = value;
            assert!(decode::<ChatIngest>(input)?.validate().is_err());
        }
        let mut input = ingest();
        input["comments"][0]["text"] = json!("😀".repeat(500));
        decode::<ChatIngest>(input)?.validate()?;
        let mut input = ingest();
        input["comments"][0]["at"] = json!(MAX_INTEGER + 1);
        assert!(decode::<ChatIngest>(input)?.validate().is_err());
        let mut input = ingest();
        input["comments"][0]["at"] = json!(1.5);
        assert!(decode::<ChatIngest>(input).is_err());
        assert!(decode::<ChatIngest>(json!({"padding":"x".repeat(MAX_BYTES)})).is_err());
        Ok(())
    }
    #[test]
    fn state_variant_has_no_comments() -> Result<(), AppError> {
        let mut input = ingest();
        if let Some(object) = input.as_object_mut() {
            object.remove("comments");
        }
        input["kind"] = json!("state");
        input["state"] = json!("waiting");
        decode::<ChatIngest>(input.clone())?.validate()?;
        input["comments"] = json!([]);
        assert!(decode::<ChatIngest>(input).is_err());
        Ok(())
    }
    #[test]
    fn matches_shared_relay_fixture_and_required_nullable_fields()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture: Value =
            serde_json::from_str(include_str!("../../test/fixtures/relay-comment.json"))?;
        serde_json::from_value::<RelayComment>(fixture.clone())?.validate()?;
        for field in ["translation", "translator"] {
            let mut missing = fixture.clone();
            if let Some(object) = missing.as_object_mut() {
                object.remove(field);
            }
            assert!(serde_json::from_value::<RelayComment>(missing).is_err());
            let mut nullable = fixture.clone();
            nullable[field] = Value::Null;
            serde_json::from_value::<RelayComment>(nullable)?.validate()?;
        }
        let mut raw = ingest();
        raw["comments"][0]["role"] = Value::Null;
        assert!(decode::<ChatIngest>(raw).is_err());
        Ok(())
    }
}
