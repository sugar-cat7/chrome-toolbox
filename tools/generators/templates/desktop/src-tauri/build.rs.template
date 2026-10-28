fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "list_notes",
        "add_note",
        "delete_note",
        "export_notes",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).unwrap_or_else(
        |error| {
            eprintln!("Tauri build configuration failed: {error}");
            std::process::exit(1);
        },
    );
}
