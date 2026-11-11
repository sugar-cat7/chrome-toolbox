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
}
