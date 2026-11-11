use crate::{
    errors_generated::{AppError, ErrorCode},
    server::Hub,
    settings::Settings,
    source::SourceSession,
    wire::*,
};
use std::{
    collections::{HashSet, VecDeque},
    time::Instant,
};
use tauri::ipc::Channel;
use uuid::Uuid;

pub struct Relay {
    pub status: RelayStatus,
    pub generation: u64,
    pub source: Option<SourceSession>,
    pub hub: Hub,
    engine: Option<Channel<EngineInput>>,
    pending: VecDeque<ReceivedComment>,
    in_flight: Option<(String, usize)>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    received_seq: u64,
    tokens: f64,
    rate_at: Instant,
    pub rejected: u8,
}
impl Relay {
    pub fn new(settings: &Settings) -> Self {
        let status = RelayStatus::default();
        let hub = Hub::new(status.clone(), settings.view());
        Self {
            status,
            generation: 0,
            source: None,
            hub,
            engine: None,
            pending: VecDeque::new(),
            in_flight: None,
            seen: HashSet::new(),
            seen_order: VecDeque::new(),
            received_seq: 0,
            tokens: 4.0,
            rate_at: Instant::now(),
            rejected: 0,
        }
    }
    fn send(&mut self, input: EngineInput) -> Result<(), AppError> {
        if let Some(engine) = &self.engine
            && engine.send(input).is_err()
        {
            self.engine = None;
            self.status.counters.dropped += self.pending.len() as u64
                + self
                    .in_flight
                    .as_ref()
                    .map_or(0, |(_, count)| *count as u64);
            self.pending.clear();
            self.in_flight = None;
            return Err(AppError::new(ErrorCode::IpcFailed));
        }
        Ok(())
    }
    pub fn reset(&mut self, settings: &Settings) -> Result<(), AppError> {
        self.status.counters.dropped += self.pending.len() as u64
            + self
                .in_flight
                .as_ref()
                .map_or(0, |(_, count)| *count as u64);
        self.pending.clear();
        self.in_flight = None;
        self.seen.clear();
        self.seen_order.clear();
        self.received_seq = 0;
        self.status.session_id = Uuid::new_v4().to_string();
        self.generation = self
            .generation
            .checked_add(1)
            .filter(|n| *n <= MAX_INTEGER)
            .ok_or_else(invalid)?;
        self.hub.reset(self.status.clone(), settings.view())?;
        let source = self.source.as_ref();
        self.send(EngineInput::SourceReset {
            session_id: self.status.session_id.clone(),
            generation: self.generation,
            source_session_id: source.map(|source| source.id.clone()),
            site: source.map(|source| source.target.site),
            channel: source.map(|source| source.target.channel.clone()),
        })?;
        Ok(())
    }
    pub fn attach(
        &mut self,
        engine: Channel<EngineInput>,
        settings: &Settings,
    ) -> Result<(), AppError> {
        // The old endpoint receives one terminal message, then is never used again.
        if let Err(error) = self.send(EngineInput::Stop {
            session_id: self.status.session_id.clone(),
            generation: self.generation,
        }) {
            self.status.error = Some(error.public());
        }
        self.engine = Some(engine);
        if let Some(source) = &mut self.source {
            source.id = Uuid::new_v4().to_string();
        }
        self.reset(settings)?;
        self.settings_changed(settings)
    }
    pub fn settings_changed(&mut self, settings: &Settings) -> Result<(), AppError> {
        self.send(EngineInput::SettingsChanged {
            session_id: self.status.session_id.clone(),
            generation: self.generation,
            settings: settings.engine(),
        })
    }
    pub fn start(&mut self, source: SourceSession, settings: &Settings) -> Result<(), AppError> {
        self.source = Some(source);
        self.status.source = SourceState::Connecting;
        self.status.error = None;
        self.rejected = 0;
        self.tokens = 4.0;
        self.rate_at = Instant::now();
        self.reset(settings)
    }
    pub fn stop(&mut self, settings: &Settings) -> Result<(), AppError> {
        self.source = None;
        self.status.source = SourceState::Stopped;
        self.status.inference = InferenceState::Idle;
        self.reset(settings)?;
        self.send(EngineInput::Stop {
            session_id: self.status.session_id.clone(),
            generation: self.generation,
        })
    }
    pub fn ingest(
        &mut self,
        label: &str,
        url: &tauri::Url,
        input: ChatIngest,
        at: Instant,
    ) -> Result<IngestAck, AppError> {
        input.validate()?;
        let (_, session, batch, site, channel) = input.context();
        let source = self.source.as_ref().ok_or_else(forbidden)?;
        source.verify(label, url, session, site, channel)?;
        let elapsed = at.saturating_duration_since(self.rate_at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * 4.0).min(4.0);
        self.rate_at = at;
        if self.tokens < 1.0 {
            return Err(AppError::new(ErrorCode::QueueFull));
        }
        self.tokens -= 1.0;
        let batch_id = batch.to_owned();
        let mut accepted = 0;
        let mut dropped = 0;
        match input {
            ChatIngest::State { state, .. } => {
                self.status.source = match state {
                    ReaderState::Waiting => SourceState::Connecting,
                    ReaderState::Reading => SourceState::Reading,
                    ReaderState::Attention => SourceState::Attention,
                };
            }
            ChatIngest::Comments { comments, .. } => {
                let received_at = now()?;
                for comment in comments {
                    if !self.seen.insert(comment.id.clone()) {
                        dropped += 1;
                        continue;
                    }
                    self.seen_order.push_back(comment.id.clone());
                    if self.seen_order.len() > 2000
                        && let Some(old) = self.seen_order.pop_front()
                    {
                        self.seen.remove(&old);
                    }
                    if self.pending.len() == 64 {
                        self.pending.pop_front();
                        dropped += 1;
                    }
                    self.received_seq = self
                        .received_seq
                        .checked_add(1)
                        .filter(|n| *n <= MAX_INTEGER)
                        .ok_or_else(invalid)?;
                    self.pending.push_back(ReceivedComment {
                        comment,
                        received_at,
                        seq: self.received_seq,
                    });
                    accepted += 1;
                }
                self.status.source = SourceState::Reading;
            }
        }
        self.status.counters.accepted += accepted as u64;
        self.status.counters.dropped += dropped as u64;
        self.dispatch()?;
        self.hub.status(self.status.clone())?;
        Ok(IngestAck {
            batch_id,
            accepted,
            dropped,
        })
    }
    fn dispatch(&mut self) -> Result<(), AppError> {
        if self.engine.is_none() || self.in_flight.is_some() || self.pending.is_empty() {
            return Ok(());
        }
        let source = self.source.as_ref().ok_or_else(forbidden)?;
        let site = source.target.site;
        let channel = source.target.channel.clone();
        let comments: Vec<_> = self.pending.drain(..self.pending.len().min(16)).collect();
        let batch_id = Uuid::new_v4().to_string();
        self.in_flight = Some((batch_id.clone(), comments.len()));
        self.send(EngineInput::ChatBatch {
            session_id: self.status.session_id.clone(),
            generation: self.generation,
            batch_id,
            site,
            channel,
            comments,
        })
    }
    pub fn ack(&mut self, ack: AckChatBatch) -> Result<(), AppError> {
        if ack.session_id != self.status.session_id
            || ack.generation != self.generation
            || self
                .in_flight
                .as_ref()
                .is_none_or(|(id, _)| id != &ack.batch_id)
        {
            return Err(forbidden());
        }
        self.in_flight = None;
        self.dispatch()
    }
    pub fn publish(&mut self, input: PublishComments) -> Result<(), AppError> {
        if input.session_id != self.status.session_id || input.generation != self.generation {
            return Err(forbidden());
        }
        let source = self.source.as_ref().ok_or_else(forbidden)?;
        if !(1..=16).contains(&input.comments.len()) {
            return Err(invalid());
        }
        for comment in &input.comments {
            comment.validate()?;
            if comment.session_id != self.status.session_id
                || comment.site != source.target.site
                || comment.channel != source.target.channel
            {
                return Err(forbidden());
            }
        }
        for comment in input.comments {
            self.hub.comment(comment)?;
            self.status.counters.published += 1;
        }
        self.hub.status(self.status.clone())
    }
    pub fn record(&mut self, error: &AppError) -> Result<(), AppError> {
        self.status.error = Some(error.public());
        self.hub.status(self.status.clone())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    fn channel() -> (Channel<EngineInput>, Arc<Mutex<Vec<Value>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let output = messages.clone();
        (
            Channel::new(move |response| {
                let value = match response {
                    tauri::ipc::InvokeResponseBody::Json(value) => serde_json::from_str(&value)?,
                    tauri::ipc::InvokeResponseBody::Raw(_) => Value::Null,
                };
                output
                    .lock()
                    .map_err(|_| tauri::Error::Io(std::io::Error::other("test channel lock")))?
                    .push(value);
                Ok(())
            }),
            messages,
        )
    }
    fn input(source: &SourceSession, index: u32) -> Result<ChatIngest, AppError> {
        decode(
            json!({"kind":"comments","v":1,"sourceSessionId":source.id,"batchId":Uuid::new_v4().to_string(),"site":"youtube","channel":source.target.channel,"comments":(0..16).map(|n|json!({"id":format!("{index}-{n}"),"author":"fixture","text":"hello","at":1})).collect::<Vec<_>>()}),
        )
    }
    #[test]
    fn enforces_one_unacked_batch_bounded_ingress_sender_and_rate()
    -> Result<(), Box<dyn std::error::Error>> {
        let settings = Settings::default();
        let mut relay = Relay::new(&settings);
        let (engine, messages) = channel();
        relay.attach(engine, &settings)?;
        let source = SourceSession::new(crate::source::normalize("https://youtu.be/abcdefghijk")?);
        relay.start(source.clone(), &settings)?;
        let instant = Instant::now();
        assert!(
            relay
                .ingest("main", &source.target.url, input(&source, 0)?, instant)
                .is_err()
        );
        for index in 0..4 {
            relay.ingest(
                "source-youtube",
                &source.target.url,
                input(&source, index)?,
                instant,
            )?;
        }
        assert!(
            relay
                .ingest(
                    "source-youtube",
                    &source.target.url,
                    input(&source, 4)?,
                    instant
                )
                .is_err()
        );
        assert_eq!(relay.pending.len(), 48);
        for index in 5..8 {
            relay.ingest(
                "source-youtube",
                &source.target.url,
                input(&source, index)?,
                instant + std::time::Duration::from_secs(index as u64),
            )?;
        }
        assert_eq!(relay.pending.len(), 64);
        assert_eq!(relay.status.counters.dropped, 32);
        let sent = messages.lock().map_err(|_| invalid())?;
        assert_eq!(
            sent.iter()
                .filter(|message| message["kind"] == "chat-batch")
                .count(),
            1
        );
        drop(sent);
        let batch = relay.in_flight.clone().ok_or("No batch")?.0;
        relay.ack(AckChatBatch {
            session_id: relay.status.session_id.clone(),
            generation: relay.generation,
            batch_id: batch.clone(),
        })?;
        assert!(
            relay
                .ack(AckChatBatch {
                    session_id: relay.status.session_id.clone(),
                    generation: relay.generation,
                    batch_id: batch
                })
                .is_err()
        );
        assert_eq!(relay.pending.len(), 48);
        Ok(())
    }
    #[test]
    fn reattach_invalidates_old_engine_source_session_and_publication_generation()
    -> Result<(), Box<dyn std::error::Error>> {
        let settings = Settings::default();
        let mut relay = Relay::new(&settings);
        let (engine, old) = channel();
        relay.attach(engine, &settings)?;
        let source = SourceSession::new(crate::source::normalize("https://youtu.be/abcdefghijk")?);
        relay.start(source.clone(), &settings)?;
        let old_session = relay.status.session_id.clone();
        let generation = relay.generation;
        let (engine, _new) = channel();
        relay.attach(engine, &settings)?;
        let count = old.lock().map_err(|_| invalid())?.len();
        assert!(
            relay
                .ingest(
                    "source-youtube",
                    &source.target.url,
                    input(&source, 0)?,
                    Instant::now()
                )
                .is_err()
        );
        assert!(
            relay
                .publish(PublishComments {
                    session_id: old_session,
                    generation,
                    comments: Vec::new()
                })
                .is_err()
        );
        relay.stop(&settings)?;
        assert_eq!(old.lock().map_err(|_| invalid())?.len(), count);
        Ok(())
    }
}
