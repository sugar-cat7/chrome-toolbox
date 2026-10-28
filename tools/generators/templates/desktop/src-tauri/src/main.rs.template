#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod errors_generated;
mod telemetry;
use errors_generated::{AppError, ErrorCode, PublicError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use telemetry::{NativeOperation, Operation, TraceCarrier};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    text: String,
    created_at: u64,
}
#[derive(Default)]
struct Notes(Mutex<Vec<Note>>);

fn new_note(text: &str) -> Result<Note, AppError> {
    // Match the portable contract's ECMAScript TrimString whitespace set.
    // Rust's Unicode White_Space removes U+0085 but preserves U+FEFF.
    let text = text.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    });
    if text.is_empty() || text.encode_utf16().count() > 1000 {
        return Err(AppError::new(ErrorCode::InputInvalid));
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::new(ErrorCode::ClockInvalid))?
        .as_millis();
    Ok(Note {
        id: Uuid::new_v4().to_string(),
        text: text.to_owned(),
        created_at: u64::try_from(millis).map_err(|_| AppError::new(ErrorCode::ClockInvalid))?,
    })
}

fn read_notes(state: State<'_, Notes>) -> Result<Vec<Note>, AppError> {
    Ok(state
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?
        .clone())
}
fn insert_note(text: String, state: State<'_, Notes>) -> Result<Note, AppError> {
    let note = new_note(&text)?;
    state
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?
        .push(note.clone());
    Ok(note)
}
fn remove_note(id: String, state: State<'_, Notes>) -> Result<(), AppError> {
    Uuid::parse_str(&id).map_err(|_| AppError::new(ErrorCode::InputInvalid))?;
    let mut notes = state
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    let previous = notes.len();
    notes.retain(|note| note.id != id);
    if notes.len() == previous {
        return Err(AppError::new(ErrorCode::ResourceMissing));
    }
    Ok(())
}

fn write_notes(path: &Path, notes: &[Note]) -> Result<(), AppError> {
    let json =
        serde_json::to_vec_pretty(notes).map_err(|_| AppError::new(ErrorCode::ExportFailed))?;
    fs::write(path, json).map_err(|_| AppError::new(ErrorCode::ExportFailed))
}

fn selected_destination(app: &AppHandle) -> Result<Option<std::path::PathBuf>, AppError> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("STARTER_TEST_SAVE_PATH") {
        return if path == "cancel" {
            Ok(None)
        } else {
            Ok(Some(path.into()))
        };
    }
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("notes.json")
        .blocking_save_file()
        .map(|file| {
            file.into_path()
                .map_err(|_| AppError::new(ErrorCode::ExportFailed))
        })
        .transpose()
}

async fn save_notes(app: AppHandle, state: State<'_, Notes>) -> Result<Option<String>, AppError> {
    let notes = state
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = selected_destination(&app)? else {
            return Ok(None);
        };
        write_notes(&path, &notes)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::ExportFailed))?
}

fn project<T>(operation: Operation, result: Result<T, AppError>) -> Result<T, PublicError> {
    operation.record(&result);
    result.map_err(|error| error.public())
}
#[tauri::command]
fn list_notes(
    state: State<'_, Notes>,
    telemetry: Option<TraceCarrier>,
) -> Result<Vec<Note>, PublicError> {
    let operation = Operation::new(NativeOperation::List, telemetry);
    project(operation, read_notes(state))
}
#[tauri::command]
fn add_note(
    text: String,
    state: State<'_, Notes>,
    telemetry: Option<TraceCarrier>,
) -> Result<Note, PublicError> {
    let operation = Operation::new(NativeOperation::Add, telemetry);
    project(operation, insert_note(text, state))
}
#[tauri::command]
fn delete_note(
    id: String,
    state: State<'_, Notes>,
    telemetry: Option<TraceCarrier>,
) -> Result<(), PublicError> {
    let operation = Operation::new(NativeOperation::Remove, telemetry);
    project(operation, remove_note(id, state))
}
#[tauri::command]
async fn export_notes(
    app: AppHandle,
    state: State<'_, Notes>,
    telemetry: Option<TraceCarrier>,
) -> Result<Option<String>, PublicError> {
    let operation = Operation::new(NativeOperation::Export, telemetry);
    project(operation, save_notes(app, state).await)
}

fn main() {
    let builder = tauri::Builder::default()
        .manage(Notes::default())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    if let Err(_error) = builder
        .invoke_handler(tauri::generate_handler![
            list_notes,
            add_note,
            delete_note,
            export_notes
        ])
        .on_page_load(|_, payload| {
            eprintln!("NATIVE_PAGE_LOAD {:?}", payload.event());
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                println!("NATIVE_READY");
            }
        })
        .run(tauri::generate_context!())
    {
        eprintln!("NATIVE_START_FAILED");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_text_and_serializes_portable_contract() -> Result<(), AppError> {
        assert!(new_note("   ").is_err());
        assert!(new_note(&"x".repeat(1001)).is_err());
        assert!(new_note(&"😀".repeat(501)).is_err());
        assert!(new_note(&format!("{}x", "😀".repeat(500))).is_err());
        assert_eq!(
            new_note(&format!("\u{feff}{}\u{feff}", "😀".repeat(500)))?
                .text
                .encode_utf16()
                .count(),
            1000
        );
        assert!(new_note("\u{feff}").is_err());
        assert_eq!(new_note("\u{0085}")?.text, "\u{0085}");
        assert_eq!(new_note("\u{feff}note\u{feff}")?.text, "note");
        assert_eq!(
            new_note("\u{feff}\u{0085}note\u{0085}\u{feff}")?.text,
            "\u{0085}note\u{0085}"
        );
        assert_eq!(
            new_note(&format!("\u{feff}{}\u{feff}", "x".repeat(1000)))?
                .text
                .len(),
            1000
        );
        let note = new_note(" note ")?;
        assert_eq!(note.text, "note");
        let json =
            serde_json::to_value(&note).map_err(|_| AppError::new(ErrorCode::ExportFailed))?;
        assert!(json.get("createdAt").is_some());
        assert!(Uuid::parse_str(&note.id).is_ok());
        Ok(())
    }
    #[test]
    fn saves_json_and_reports_an_unwritable_destination() -> Result<(), AppError> {
        let directory = std::env::temp_dir().join(format!("native-json-{}", Uuid::new_v4()));
        fs::create_dir(&directory).map_err(|_| AppError::new(ErrorCode::ExportFailed))?;
        let path = directory.join("notes.json");
        let notes = vec![new_note("local data")?];
        write_notes(&path, &notes)?;
        let bytes = fs::read(&path).map_err(|_| AppError::new(ErrorCode::ExportFailed))?;
        let saved: Vec<Note> =
            serde_json::from_slice(&bytes).map_err(|_| AppError::new(ErrorCode::ExportFailed))?;
        assert_eq!(saved, notes);
        assert!(write_notes(&directory.join("absent/notes.json"), &notes).is_err());
        fs::remove_dir_all(directory).map_err(|_| AppError::new(ErrorCode::ExportFailed))?;
        Ok(())
    }
}
