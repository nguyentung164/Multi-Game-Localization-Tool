mod credentials;
mod launch_file;
mod models;
mod orchestrator;
mod process_tree;
mod protocol;
mod storage;
mod tool_paths;

use crate::launch_file::{extract_legend_file_arg, PendingLaunchFile, OPEN_LEGEND_FILE_EVENT};
use crate::models::APP_DISPLAY_NAME;
use orchestrator::AppState;
use std::{
    env, fs, io,
    path::Path,
    sync::Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};

const LEGACY_APP_IDENTIFIER: &str = "com.nqt.civ7-localization-tool";

fn copy_dir_all(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn migrate_legacy_app_data(app_data_dir: &Path) -> io::Result<()> {
    let Some(parent) = app_data_dir.parent() else {
        return Ok(());
    };
    let legacy_dir = parent.join(LEGACY_APP_IDENTIFIER);
    if !legacy_dir.is_dir() {
        return Ok(());
    }
    if app_data_dir.is_dir() && fs::read_dir(app_data_dir)?.next().transpose()?.is_some() {
        return Ok(());
    }

    let staging_dir = parent.join(".localization-tool-migration");
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)?;
    }
    copy_dir_all(&legacy_dir, &staging_dir)?;
    if app_data_dir.exists() {
        fs::remove_dir(app_data_dir)?;
    }
    if let Err(error) = fs::rename(&staging_dir, app_data_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn emit_open_legend_file(app: &tauri::AppHandle, path: String) {
    let _ = app.emit(OPEN_LEGEND_FILE_EVENT, path);
}

#[tauri::command]
fn take_pending_launch_file(
    pending: State<'_, PendingLaunchFile>,
) -> Option<String> {
    pending.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main_window(app);
            if let Some(path) = extract_legend_file_arg(&args) {
                emit_open_legend_file(app, path);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let launch_path = extract_legend_file_arg(&env::args().collect::<Vec<_>>());
            app.manage(PendingLaunchFile(Mutex::new(launch_path)));

            let app_data_dir = app.path().app_data_dir()?;
            migrate_legacy_app_data(&app_data_dir)?;
            let state = AppState::initialize(app_data_dir)?;
            app.manage(state);

            let show_i = MenuItem::with_id(app, "show", "Hiện cửa sổ", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip(APP_DISPLAY_NAME)
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
            take_pending_launch_file,
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
            orchestrator::replace_tags,
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
            orchestrator::inspect_legend_file,
            orchestrator::list_legend_file_entries,
            orchestrator::search_legend_file,
            orchestrator::update_legend_lines,
            orchestrator::dedupe_legend_file,
            orchestrator::estimate_legend_translation,
            orchestrator::get_legend_glossary,
            orchestrator::save_legend_glossary,
            orchestrator::export_legend_glossary,
            orchestrator::start_legend_translation,
            orchestrator::get_legend_translation_preview,
            orchestrator::list_legend_preview_diffs,
            orchestrator::list_legend_preview_han_lines,
            orchestrator::list_legend_preview_line_refs,
            orchestrator::list_legend_previews,
            orchestrator::adopt_legend_preview_from_path,
            orchestrator::get_legend_source_path,
            orchestrator::get_legend_deploy_path,
            orchestrator::set_legend_deploy_path,
            orchestrator::sync_legend_staged,
            orchestrator::update_legend_translation_preview,
            orchestrator::retranslate_legend_preview,
            orchestrator::apply_legend_translation,
            orchestrator::list_legend_backups,
            orchestrator::restore_legend_backup,
            orchestrator::delete_legend_backup,
            orchestrator::open_legend_backup_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
