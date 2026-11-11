use crate::{
    errors_generated::{AppError, ErrorCode},
    wire::{Site, forbidden, invalid},
};
use tauri::{
    Manager, WebviewUrl, WebviewWindowBuilder, utils::config::BackgroundThrottlingPolicy,
    webview::NewWindowResponse,
};
use uuid::Uuid;

/// Built by `pnpm build:reader` into `dist-reader/` and copied here by `build.rs`.
const READER_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/reader.js"));
#[derive(Clone, Debug)]
pub struct SourceTarget {
    pub site: Site,
    pub channel: String,
    pub url: tauri::Url,
}
pub fn normalize(input: &str) -> Result<SourceTarget, AppError> {
    if input.len() > 2048 {
        return Err(invalid());
    }
    let url = tauri::Url::parse(input).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    let host = url.host_str().ok_or_else(invalid)?;
    let (site, channel) = match host {
        "www.youtube.com" | "youtube.com" | "m.youtube.com" => {
            let id = match parts.as_slice() {
                ["watch" | "live_chat"] => {
                    let ids: Vec<_> = url
                        .query_pairs()
                        .filter(|(key, _)| key == "v")
                        .map(|(_, v)| v.into_owned())
                        .collect();
                    if ids.len() != 1 {
                        return Err(invalid());
                    }
                    ids[0].clone()
                }
                ["live", id] => (*id).to_owned(),
                _ => return Err(invalid()),
            };
            (Site::Youtube, id)
        }
        "youtu.be" => match parts.as_slice() {
            [id] => (Site::Youtube, (*id).to_owned()),
            _ => return Err(invalid()),
        },
        "www.twitch.tv" | "twitch.tv" => {
            let login = match parts.as_slice() {
                [login] => *login,
                ["popout", login, "chat"] => *login,
                _ => return Err(invalid()),
            };
            let login = login.to_ascii_lowercase();
            if !(1..=25).contains(&login.len())
                || !login
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || [
                    "directory",
                    "videos",
                    "downloads",
                    "settings",
                    "login",
                    "signup",
                    "search",
                    "popout",
                ]
                .contains(&login.as_str())
            {
                return Err(invalid());
            }
            (Site::Twitch, login)
        }
        _ => return Err(invalid()),
    };
    if site == Site::Youtube
        && (channel.len() != 11
            || !channel
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)))
    {
        return Err(invalid());
    }
    let chat = match site {
        Site::Youtube => format!("https://www.youtube.com/live_chat?v={channel}&is_popout=1"),
        Site::Twitch => format!("https://www.twitch.tv/popout/{channel}/chat?popout="),
    };
    Ok(SourceTarget {
        site,
        channel,
        url: tauri::Url::parse(&chat).map_err(|_| invalid())?,
    })
}
#[derive(Clone, Debug)]
pub struct SourceSession {
    pub target: SourceTarget,
    pub id: String,
}
impl SourceSession {
    pub fn new(target: SourceTarget) -> Self {
        Self {
            target,
            id: Uuid::new_v4().to_string(),
        }
    }
    pub fn verify(
        &self,
        label: &str,
        url: &tauri::Url,
        session: &str,
        site: Site,
        channel: &str,
    ) -> Result<(), AppError> {
        if label != self.target.site.label()
            || url != &self.target.url
            || session != self.id
            || site != self.target.site
            || channel != self.target.channel
        {
            return Err(forbidden());
        }
        Ok(())
    }
}
/// The reader learns its session id from this prelude; the id is a UUID so quoting is safe.
fn reader_script(session: &SourceSession) -> String {
    let id = serde_json::to_string(&session.id).unwrap_or_else(|_| "\"\"".to_owned());
    format!("window.__RELAY_SOURCE_SESSION__={id};\n{READER_JS}")
}
pub fn create(app: &tauri::AppHandle, session: &SourceSession) -> Result<(), AppError> {
    let allowed = session.target.url.clone();
    WebviewWindowBuilder::new(
        app,
        session.target.site.label(),
        WebviewUrl::External(allowed.clone()),
    )
    .title("Chat source")
    .visible(false)
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .on_navigation(move |url| url == &allowed)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
    .initialization_script(reader_script(session))
    .build()
    .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    Ok(())
}
pub fn destroy(app: &tauri::AppHandle) -> Result<(), AppError> {
    for label in ["source-youtube", "source-twitch"] {
        if let Some(window) = app.get_webview_window(label) {
            window
                .destroy()
                .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_only_supported_video_and_channel_urls() -> Result<(), AppError> {
        for input in [
            "https://www.youtube.com/watch?v=abcdefghijk&t=2",
            "https://youtu.be/abcdefghijk?si=x",
            "https://youtube.com/live/abcdefghijk",
            "https://www.youtube.com/live_chat?v=abcdefghijk&is_popout=1",
        ] {
            assert_eq!(
                normalize(input)?.url.as_str(),
                "https://www.youtube.com/live_chat?v=abcdefghijk&is_popout=1"
            );
        }
        for input in [
            "https://twitch.tv/Some_User",
            "https://www.twitch.tv/popout/Some_User/chat?popout=",
        ] {
            assert_eq!(
                normalize(input)?.url.as_str(),
                "https://www.twitch.tv/popout/some_user/chat?popout="
            );
        }
        Ok(())
    }
    #[test]
    fn refuses_arbitrary_hosts_paths_credentials_ports_and_missing_ids() {
        for input in [
            "http://youtube.com/watch?v=abcdefghijk",
            "https://www.youtube.com.evil.invalid/watch?v=abcdefghijk",
            "https://user@youtube.com/watch?v=abcdefghijk",
            "https://youtube.com:444/watch?v=abcdefghijk",
            "https://youtube.com/@user/live",
            "https://youtube.com/live_chat_replay?v=abcdefghijk",
            "https://youtube.com/watch?v=short",
            "https://twitch.tv/videos/123",
            "https://twitch.tv/directory",
            "https://evil.invalid/chat",
            "https://youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv",
        ] {
            assert!(normalize(input).is_err(), "{input}");
        }
    }
}
