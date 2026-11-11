use std::{env, fs, path::Path};

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "chat_ingest",
        "attach_engine",
        "ack_chat_batch",
        "llama_request",
        "cancel_llama",
        "publish_comments",
        "get_settings",
        "save_settings",
        "start_source",
        "stop_source",
        "get_status",
        "check_connection",
        "select_model_file",
    ]);
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    {
        eprintln!("Tauri build configuration failed: {error}");
        std::process::exit(1);
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-reader/reader.js");
    let out_dir = match env::var("OUT_DIR") {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("OUT_DIR is not set: {error}");
            std::process::exit(1);
        }
    };
    let target = Path::new(&out_dir).join("reader.js");
    let script = fs::read_to_string(&source)
        .unwrap_or_else(|_| "/* reader bundle was not built */\n".to_owned());
    if let Err(error) = fs::write(&target, script) {
        eprintln!("failed to write embedded reader: {error}");
        std::process::exit(1);
    }
    println!("cargo:rerun-if-changed={}", source.display());
}
