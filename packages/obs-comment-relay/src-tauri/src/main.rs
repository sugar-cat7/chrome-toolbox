#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod errors_generated;
mod llama;
mod relay;
mod server;
mod settings;
mod source;
mod wire;

use commands::NativeState;
use errors_generated::{AppError, ErrorCode};
use std::sync::atomic::Ordering;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

fn report(app: &tauri::AppHandle, result: Result<(), AppError>) {
    if let Err(error) = app.state::<NativeState>().project(result) {
        eprintln!("RELAY_NATIVE {}", error.diagnostic_id);
    }
}
fn tray(app: &tauri::AppHandle) -> Result<(), AppError> {
    let show = MenuItem::with_id(app, "show", "コントロールを表示", true, None::<&str>)
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    let stop = MenuItem::with_id(app, "stop", "中継を停止", true, None::<&str>)
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    let menu = Menu::with_items(app, &[&show, &stop, &quit])
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("OBS コメント中継")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let result = app
                    .get_webview_window("main")
                    .ok_or_else(|| AppError::new(ErrorCode::StateUnavailable))
                    .and_then(|window| {
                        window
                            .show()
                            .and_then(|()| window.set_focus())
                            .map_err(|_| AppError::new(ErrorCode::StateUnavailable))
                    });
                report(app, result);
            }
            "stop" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = app.state::<NativeState>().stop(&app).await;
                    report(&app, result);
                });
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)
        .map_err(|_| AppError::new(ErrorCode::StateUnavailable))?;
    Ok(())
}
fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    let app = builder
        .setup(|app| {
            let directory = app
                .path()
                .app_config_dir()
                .map_err(|_| AppError::new(ErrorCode::StorageFailed))?;
            app.manage(NativeState::new(directory)?);
            tray(app.handle())?;
            app.state::<NativeState>().start_tasks(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::chat_ingest,
            commands::attach_engine,
            commands::ack_chat_batch,
            commands::llama_request,
            commands::cancel_llama,
            commands::publish_comments,
            commands::get_settings,
            commands::save_settings,
            commands::start_source,
            commands::stop_source,
            commands::get_status,
            commands::check_connection,
            commands::select_model_file
        ])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                report(
                    window.app_handle(),
                    window
                        .hide()
                        .map_err(|_| AppError::new(ErrorCode::StateUnavailable)),
                );
            }
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                println!("NATIVE_READY");
            }
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = handle.state::<NativeState>();
                if !state.closed.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if !state.exiting.swap(true, Ordering::SeqCst) {
                        let app = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<NativeState>();
                            let result = state.shutdown(&app).await;
                            let code = if result.is_ok() { 0 } else { 1 };
                            report(&app, result);
                            state.closed.store(true, Ordering::SeqCst);
                            app.exit(code);
                        });
                    }
                }
            }
        }),
        Err(_) => {
            eprintln!("RELAY_NATIVE_START_FAILED");
            std::process::exit(1);
        }
    }
}
