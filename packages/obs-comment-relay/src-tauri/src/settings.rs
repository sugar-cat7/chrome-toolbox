use crate::{
    errors_generated::{AppError, ErrorCode},
    wire::{DisplayMode, MAX_BYTES, RelayView},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const LANGUAGES: &[&str] = &[
    "auto", "ja", "en", "zh-hans", "zh-hant", "ko", "ar", "az", "be", "bg", "bn", "ca", "ceb",
    "de", "es", "et", "eu", "fa", "fr", "gu", "he", "hi", "hr", "hu", "hy", "id", "it", "jv", "ka",
    "kk", "km", "lt", "lv", "ml", "mr", "ms", "my", "ne", "nl", "pa", "pl", "ru", "si", "sk", "sl",
    "sr", "sw", "ta", "te", "th", "tl", "ur", "uz", "vi",
];
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LlamaMode {
    Managed,
    External,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Strength {
    Mild,
    Normal,
    Strict,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub enum TargetLanguage {
    #[serde(rename = "ja")]
    Ja,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub modified_at: u64,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelFiles {
    pub clef: Option<ModelFile>,
    pub plamo: Option<ModelFile>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u8,
    pub mode: LlamaMode,
    pub base_url: String,
    pub models: ModelFiles,
    pub filter_strength: Strength,
    pub translate: bool,
    pub source_language: String,
    pub target_language: TargetLanguage,
    pub display: DisplayMode,
    pub max_items: u8,
    pub overlay_port: u16,
    pub overlay_token: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            mode: LlamaMode::Managed,
            base_url: "http://127.0.0.1:18083".into(),
            models: ModelFiles::default(),
            filter_strength: Strength::Normal,
            translate: true,
            source_language: "auto".into(),
            target_language: TargetLanguage::Ja,
            display: DisplayMode::Translated,
            max_items: 20,
            overlay_port: 18084,
            overlay_token: Uuid::new_v4().to_string(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineSettings {
    pub mode: LlamaMode,
    pub base_url: String,
    pub filter_strength: Strength,
    pub translate: bool,
    pub source_language: String,
    pub target_language: TargetLanguage,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdate {
    pub mode: LlamaMode,
    pub base_url: String,
    pub filter_strength: Strength,
    pub translate: bool,
    pub source_language: String,
    pub target_language: TargetLanguage,
    pub display: DisplayMode,
    pub max_items: u8,
    pub overlay_port: u16,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSettings {
    pub settings: Option<SettingsUpdate>,
    #[serde(default)]
    pub reset_corrupt: bool,
}
impl Settings {
    pub fn validate(&self) -> Result<(), AppError> {
        let token = Uuid::parse_str(&self.overlay_token).map_err(|_| crate::wire::invalid())?;
        if self.schema_version != 1
            || token.get_version_num() != 4
            || self.overlay_token != token.to_string()
            || self.overlay_port == 0
            || !(1..=100).contains(&self.max_items)
            || !LANGUAGES.contains(&self.source_language.as_str())
        {
            return Err(crate::wire::invalid());
        }
        crate::llama::loopback_base(&self.base_url)?;
        for model in [&self.models.clef, &self.models.plamo]
            .into_iter()
            .flatten()
        {
            if model.path.is_empty()
                || !Path::new(&model.path).is_absolute()
                || model.sha256.len() != 64
                || !model.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || model.size == 0
                || model.size > crate::wire::MAX_INTEGER
                || model.modified_at > crate::wire::MAX_INTEGER
            {
                return Err(crate::wire::invalid());
            }
        }
        Ok(())
    }
    pub fn engine(&self) -> EngineSettings {
        EngineSettings {
            mode: self.mode,
            base_url: self.base_url.clone(),
            filter_strength: self.filter_strength,
            translate: self.translate,
            source_language: self.source_language.clone(),
            target_language: self.target_language,
        }
    }
    pub fn view(&self) -> RelayView {
        RelayView {
            v: 1,
            display: self.display,
            max_items: self.max_items,
            translate: self.translate,
            attribution: "Built with PLaMo · 翻訳: PLaMo",
        }
    }
    pub fn updated(&self, input: SettingsUpdate) -> Result<Self, AppError> {
        let next = Self {
            mode: input.mode,
            base_url: crate::llama::loopback_base(&input.base_url)?,
            filter_strength: input.filter_strength,
            translate: input.translate,
            source_language: input.source_language,
            target_language: input.target_language,
            display: input.display,
            max_items: input.max_items,
            overlay_port: input.overlay_port,
            ..self.clone()
        };
        next.validate()?;
        Ok(next)
    }
}
pub struct SettingsStore {
    directory: PathBuf,
    pub current: Settings,
    pub error: Option<AppError>,
}
fn storage_error() -> AppError {
    AppError::new(ErrorCode::RelaySettingsSaveFailed)
}
fn corrupt() -> AppError {
    AppError::new(ErrorCode::RelaySettingsCorrupt)
}
impl SettingsStore {
    pub fn blocked(directory: PathBuf, error: AppError) -> Self {
        Self {
            directory,
            current: Settings::default(),
            error: Some(error),
        }
    }
    pub fn open(directory: PathBuf) -> Result<Self, AppError> {
        if !directory.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&directory).map_err(|_| storage_error())?;
        }
        let path = directory.join("settings.json");
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut store = Self {
                    directory,
                    current: Settings::default(),
                    error: None,
                };
                store.persist(store.current.clone(), false)?;
                return Ok(store);
            }
            Err(_) => return Err(corrupt()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| corrupt())?;
        if bytes.len() > MAX_BYTES {
            return Err(corrupt());
        }
        let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
        settings.validate().map_err(|_| corrupt())?;
        Ok(Self {
            directory,
            current: settings,
            error: None,
        })
    }
    pub fn get(&self) -> Result<Settings, AppError> {
        match &self.error {
            Some(error) => Err(error.clone()),
            None => Ok(self.current.clone()),
        }
    }
    pub fn persist(&mut self, settings: Settings, reset_corrupt: bool) -> Result<(), AppError> {
        settings.validate()?;
        if self.error.is_some() && !reset_corrupt {
            return Err(corrupt());
        }
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| storage_error())?;
        if bytes.len() > MAX_BYTES {
            return Err(crate::wire::invalid());
        }
        let target = self.directory.join("settings.json");
        let temporary = self
            .directory
            .join(format!("settings-{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temporary).map_err(|_| storage_error())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| storage_error())?;
            if self.error.is_some() && target.exists() {
                // Preserve exact corrupt bytes, including an oversize file, only on explicit recovery.
                let backup = self
                    .directory
                    .join(format!("settings.corrupt-{}.json", Uuid::new_v4()));
                fs::copy(&target, &backup).map_err(|_| storage_error())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&backup, fs::Permissions::from_mode(0o600))
                        .map_err(|_| storage_error())?;
                }
                fs::File::open(backup)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| storage_error())?;
            }
            fs::rename(&temporary, &target).map_err(|_| storage_error())?;
            #[cfg(unix)]
            fs::File::open(&self.directory)
                .and_then(|file| file.sync_all())
                .map_err(|_| storage_error())?;
            Ok(())
        })();
        if result.is_err() && temporary.exists() {
            fs::remove_file(temporary).map_err(|_| storage_error())?;
        }
        result?;
        self.current = settings;
        self.error = None;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_token_and_never_overwrites_corrupt_settings_without_recovery()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = std::env::temp_dir().join(format!("relay-settings-{}", Uuid::new_v4()));
        let store = SettingsStore::open(dir.clone())?;
        let token = store.current.overlay_token;
        assert_eq!(
            SettingsStore::open(dir.clone())?.current.overlay_token,
            token
        );
        let path = dir.join("settings.json");
        fs::write(&path, b"broken")?;
        assert!(SettingsStore::open(dir.clone()).is_err());
        assert_eq!(fs::read(&path)?, b"broken");
        let mut store = SettingsStore::blocked(dir.clone(), corrupt());
        assert!(store.get().is_err());
        assert!(store.persist(Settings::default(), false).is_err());
        store.persist(Settings::default(), true)?;
        assert!(fs::read_dir(&dir)?.filter_map(Result::ok).any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings.corrupt-")
        }));
        assert!(SettingsStore::open(dir.clone()).is_ok());
        fs::remove_dir_all(dir)?;
        Ok(())
    }
    #[test]
    fn rejects_oversize_unknown_keys_and_invalid_token() -> Result<(), Box<dyn std::error::Error>> {
        let mut value = serde_json::to_value(Settings::default())?;
        value["streamUrl"] = serde_json::json!("https://example.invalid");
        assert!(serde_json::from_value::<Settings>(value).is_err());
        let settings = Settings {
            overlay_token: String::new(),
            ..Settings::default()
        };
        assert!(settings.validate().is_err());
        let dir = std::env::temp_dir().join(format!("relay-settings-{}", Uuid::new_v4()));
        fs::create_dir(&dir)?;
        fs::write(dir.join("settings.json"), vec![b' '; MAX_BYTES + 1])?;
        assert!(SettingsStore::open(dir.clone()).is_err());
        fs::remove_dir_all(dir)?;
        Ok(())
    }
}
