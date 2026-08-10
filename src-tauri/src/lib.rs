mod credentials;
mod models;
mod orchestrator;
mod process_tree;
mod protocol;
mod storage;

use orchestrator::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = AppState::initialize(app_data_dir)?;
            app.manage(state);

            let show_i = MenuItem::with_id(app, "show", "Hiện cửa sổ", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("CIV7 Localization Tool")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        app.state::<AppState>().shutdown();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            // Keep the tray handle alive for the app lifetime.
            let tray = tray_builder.build(app)?;
            app.manage(tray);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Minimize to tray instead of quitting.
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Destroyed => {
                window.state::<AppState>().shutdown();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            orchestrator::get_app_state,
            orchestrator::save_app_config,
            orchestrator::validate_paths,
            orchestrator::start_job,
            orchestrator::cancel_job,
            orchestrator::apply_sync,
            orchestrator::open_report,
            orchestrator::open_reports_folder,
            orchestrator::clear_reports,
            orchestrator::clear_job_events,
            orchestrator::get_translation_cache_info,
            orchestrator::open_translation_cache,
            orchestrator::clear_translation_cache,
            orchestrator::get_glossary,
            orchestrator::save_glossary,
            orchestrator::search_tags,
            orchestrator::list_tags,
            orchestrator::update_tag,
            orchestrator::open_file,
            orchestrator::restore_backup,
            orchestrator::list_backup_files,
            orchestrator::open_backup_folder,
            orchestrator::delete_backup,
            orchestrator::add_api_key,
            orchestrator::rename_api_key,
            orchestrator::test_api_key,
            orchestrator::set_api_key_enabled,
            orchestrator::reorder_api_keys,
            orchestrator::delete_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
