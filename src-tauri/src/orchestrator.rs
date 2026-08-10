use crate::{
    credentials,
    models::{
        now_iso, now_millis, valid_key_id, ActiveJob, ActiveJobStatus, ApiKeyMeta, AppConfig,
        CachePathInput, CommandError, CommandResult, EngineEventEnvelope, EngineRequest,
        FrontendAppState, FrontendEventType, GlossaryPayload, GlossarySaveResult, InspectDiff,
        InspectDiffStatus, InspectInventoryStats, InspectSnapshot, InspectTagDelta,
        JobEventEnvelope, JobMode, JobStartResponse, KeyStatus,
        PathConfigInput, PathValidation, DeployChange, DeployChangeKind, QaIssue, QaSeverity,
        Report, StepId, StepStatus, SyncChange, SyncChangeKind, TagListResult, TagSearchResult,
        TagUpdateResult,
        TranslationCacheClearResult,
        TranslationCacheInfo, MAX_EVENT_LINE_BYTES, MAX_INSPECT_DIFFS_UI, MAX_SPILLED_RESULT_BYTES,
        MAX_DEPLOY_CHANGES_UI, MAX_SYNC_CHANGES_UI, PROTOCOL_VERSION,
    },
    process_tree::{soft_cancel, JobObject},
    protocol::ProtocolValidator,
    storage::{
        backup_directory, clear_reports as clear_report_files, create_pre_restore_safety_backup,
        delete_backup as remove_backup_entry, list_backup_files as read_backup_manifest_files,
        refresh_artifacts,
        report_directory, restore_backup_manifest, step_title, write_json_atomic, write_report,
        write_report_text, DeployPreview, PersistedData, PersistenceStore, SyncPreview,
    },
};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroize;

const SIDECAR_NAME: &str = "civ7-localization-engine";
const CANCEL_GRACE_PERIOD_SECS: u64 = 3;
const PROGRESS_PERSIST_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[derive(Clone)]
pub struct AppState {
    app_data_dir: PathBuf,
    store: PersistenceStore,
    data: Arc<Mutex<PersistedData>>,
    persist_lock: Arc<Mutex<()>>,
    process: Arc<Mutex<Option<RunningProcess>>>,
    job_gate: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
    last_progress_persist: Arc<Mutex<Option<Instant>>>,
}

struct RunningProcess {
    job_id: String,
    process_id: u32,
    child: Arc<Mutex<Child>>,
    cancel_requested: Arc<AtomicBool>,
    job_object: Option<JobObject>,
}

impl AppState {
    pub fn initialize(app_data_dir: PathBuf) -> CommandResult<Self> {
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| CommandError::io("Tạo AppData", error))?;
        let store = PersistenceStore::new(&app_data_dir);
        let mut data = match store.load() {
            Ok(data) => data,
            Err(_) => {
                store.quarantine_invalid()?;
                PersistedData::default()
            }
        };
        let interrupted_step = if let Some(active) = data.app.active_job.as_mut() {
            if matches!(active.status, ActiveJobStatus::Running) {
                active.status = ActiveJobStatus::Paused;
                active.is_saving_cache = Some(false);
                Some(active.step)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(interrupted_step) = interrupted_step {
            if let Some(step) = data.app.step_mut(interrupted_step) {
                step.status = StepStatus::Paused;
            }
        }
        data.app
            .api_keys
            .retain(|key| valid_key_id(&key.id) && key.masked_suffix.len() <= 32);
        normalize_priorities(&mut data.app.api_keys);
        data.app.normalize_gates();
        enforce_internal_gates(&mut data);
        trim_deploy_changes_for_ui(&mut data);
        let _ = refresh_artifacts(&mut data, &app_data_dir);
        data.app.sanitize_timeline_events();
        let state = Self {
            app_data_dir,
            store,
            data: Arc::new(Mutex::new(data)),
            persist_lock: Arc::new(Mutex::new(())),
            process: Arc::new(Mutex::new(None)),
            job_gate: Arc::new(AtomicBool::new(false)),
            next_id: Arc::new(AtomicU64::new(1)),
            last_progress_persist: Arc::new(Mutex::new(None)),
        };
        state.save_snapshot()?;
        Ok(state)
    }

    fn data(&self) -> CommandResult<MutexGuard<'_, PersistedData>> {
        self.data
            .lock()
            .map_err(|_| CommandError::new("state_poisoned", "Backend state lock bị lỗi"))
    }

    fn process(&self) -> CommandResult<MutexGuard<'_, Option<RunningProcess>>> {
        self.process
            .lock()
            .map_err(|_| CommandError::new("process_lock_poisoned", "Process lock bị lỗi"))
    }

    fn save_snapshot(&self) -> CommandResult<()> {
        let snapshot = self
            .data()
            .map_err(|error| error)?
            .clone();
        let _guard = self.persist_lock.lock().map_err(|_| {
            CommandError::new("persistence_lock_poisoned", "Persistence lock bị lỗi")
        })?;
        self.store.save(&snapshot)
    }

    fn save_snapshot_deferred(&self) {
        let state = self.clone();
        std::thread::spawn(move || {
            let _ = state.save_snapshot();
        });
    }

    fn reset_progress_persist_throttle(&self) {
        if let Ok(mut last) = self.last_progress_persist.lock() {
            *last = None;
        }
    }

    fn should_persist_progress(&self) -> bool {
        Self::should_run_progress_action(&self.last_progress_persist, PROGRESS_PERSIST_INTERVAL)
    }

    fn should_run_progress_action(
        slot: &Arc<Mutex<Option<Instant>>>,
        interval: Duration,
    ) -> bool {
        let Ok(mut last) = slot.lock() else {
            return true;
        };
        let now = Instant::now();
        if last
            .map(|instant| now.duration_since(instant) >= interval)
            .unwrap_or(true)
        {
            *last = Some(now);
            true
        } else {
            false
        }
    }

    fn unique_id(&self, prefix: &str) -> String {
        format!(
            "{prefix}-{}-{}",
            now_millis(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub fn shutdown(&self) {
        if let Ok(mut running) = self.process.lock() {
            if let Some(process) = running.as_mut() {
                if let Some(job) = process.job_object.as_ref() {
                    job.terminate();
                }
                if let Ok(mut child) = process.child.lock() {
                    let _ = child.kill();
                }
            }
            running.take();
        }
        self.job_gate.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub fn get_app_state(state: State<'_, AppState>) -> CommandResult<FrontendAppState> {
    let mut data = state.data()?;
    trim_deploy_changes_for_ui(&mut data);
    data.app.sanitize_timeline_events();
    data.app.normalize_gates();
    publish_gate_flags(&mut data);
    enforce_internal_gates(&mut data);
    Ok(data.app.clone())
}

#[tauri::command]
pub fn save_app_config(
    mut config: AppConfig,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    if config.report_path.as_os_str().is_empty() {
        config.report_path = state.app_data_dir.join("reports");
    }
    let validation = config.validate(true);
    if !validation.valid {
        return Err(CommandError::new(
            "invalid_config",
            validation
                .errors
                .values()
                .cloned()
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    {
        let mut data = state.data()?;
        if data.app.config != config {
            if let Some(step) = config_invalidation(&data.app.config, &config) {
                data.app.invalidate_from(step);
                if step <= StepId::Sync {
                    data.sync_previews.clear();
                    data.sync_applied = false;
                }
                if step <= StepId::Deploy {
                    data.deploy_previews.clear();
                    data.deploy_applied = false;
                }
            }
            data.app.config = config;
            data.app.normalize_gates();
            enforce_internal_gates(&mut data);
        }
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command]
pub fn validate_paths(config: PathConfigInput) -> PathValidation {
    config.validate()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_job(
    step: StepId,
    mode: JobMode,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<JobStartResponse> {
    // Tauri khuyến nghị async command; progress stream qua events/Channel, không block invoke.
    // https://v2.tauri.app/develop/calling-rust/
    start_job_sync(step, mode, &app, &state)
}

fn start_job_sync(
    step: StepId,
    mode: JobMode,
    app: &AppHandle,
    state: &AppState,
) -> CommandResult<JobStartResponse> {
    if step == StepId::Sync && mode == JobMode::Run {
        let fingerprint = state
            .data()?
            .sync_previews
            .values()
            .max_by(|left, right| left.created_at.cmp(&right.created_at))
            .map(|preview| preview.fingerprint.clone())
            .ok_or_else(|| {
                CommandError::new(
                    "sync_preview_not_found",
                    "Cần chạy dry-run trước khi áp dụng Đồng bộ",
                )
            })?;
        return start_engine_job(
            &app,
            &state,
            StepId::Sync,
            "sync-apply",
            false,
            Some(&fingerprint),
        );
    }
    if step == StepId::Deploy && mode == JobMode::Run {
        return start_engine_job(
            &app,
            &state,
            StepId::Deploy,
            "deploy-apply",
            false,
            None,
        );
    }
    let command = step.engine_command(mode)?;
    start_engine_job(&app, &state, step, command, mode == JobMode::DryRun, None)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_job(job_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    let (process_id, child, requested) = {
        let process = state.process()?;
        let running = process
            .as_ref()
            .ok_or_else(|| CommandError::new("no_active_job", "Không có job đang chạy"))?;
        if running.job_id != job_id {
            return Err(CommandError::new(
                "job_id_mismatch",
                "jobId không khớp job đang chạy",
            ));
        }
        running.cancel_requested.store(true, Ordering::Release);
        (
            running.process_id,
            Arc::clone(&running.child),
            Arc::clone(&running.cancel_requested),
        )
    };
    let _ = soft_cancel(process_id);
    let state_for_timeout = state.inner().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(CANCEL_GRACE_PERIOD_SECS));
        if !requested.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut process) = state_for_timeout.process.lock() {
            if let Some(running) = process.as_mut() {
                if running.job_id == job_id {
                    if let Some(job) = running.job_object.as_ref() {
                        job.terminate();
                    }
                    if let Ok(mut child) = child.lock() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn apply_sync(
    preview_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<JobStartResponse> {
    let fingerprint = state
        .data()?
        .sync_previews
        .get(&preview_id)
        .map(|preview| preview.fingerprint.clone())
        .ok_or_else(|| {
            CommandError::new(
                "sync_preview_not_found",
                "Preview không tồn tại hoặc đã bị vô hiệu hóa",
            )
        })?;
    start_engine_job(
        &app,
        &state,
        StepId::Sync,
        "sync-apply",
        false,
        Some(&fingerprint),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_report(
    report_id: String,
    kind: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let path = state
        .data()?
        .report_paths
        .get(&report_id)
        .cloned()
        .ok_or_else(|| CommandError::new("report_not_found", "Không tìm thấy report"))?;
    match kind.as_deref().unwrap_or("json") {
        "folder" => {
            let folder = path.parent().unwrap_or(path.as_path());
            open_path(&app, folder)
        }
        "txt" => {
            let txt_path = path.with_extension("txt");
            if !txt_path.is_file() {
                return Err(CommandError::new(
                    "report_txt_not_found",
                    "Chưa có file TXT cho báo cáo này",
                ));
            }
            open_path(&app, &txt_path)
        }
        _ => open_path(&app, &path),
    }
}

#[tauri::command]
pub fn open_reports_folder(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let path = report_directory(&state.app_data_dir, &state.data()?.app);
    fs::create_dir_all(&path).map_err(|error| CommandError::io("Tạo thư mục reports", error))?;
    open_path(&app, &path)
}

#[tauri::command]
pub fn clear_reports(state: State<'_, AppState>) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    {
        let mut data = state.data()?;
        let directory = report_directory(&state.app_data_dir, &data.app);
        clear_report_files(&mut data, &directory)?;
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command(rename_all = "camelCase")]
pub fn clear_job_events(
    step: StepId,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    {
        let mut data = state.data()?;
        data.app.events.retain(|event| event.step != step);
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_translation_cache_info(
    cache_path: Option<String>,
    report_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<TranslationCacheInfo> {
    let path = resolve_translation_cache_path(
        &state,
        &CachePathInput {
            cache_path: cache_path.unwrap_or_default(),
            report_path: report_path.unwrap_or_default(),
        },
    )?;
    Ok(read_translation_cache_info(&path))
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_translation_cache(
    app: AppHandle,
    cache_path: Option<String>,
    report_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let path = resolve_translation_cache_path(
        &state,
        &CachePathInput {
            cache_path: cache_path.unwrap_or_default(),
            report_path: report_path.unwrap_or_default(),
        },
    )?;
    ensure_translation_cache_file(&path)?;
    let allowed = allowed_open_path(&state, &path)?;
    open_path(&app, &allowed)
}

#[tauri::command(rename_all = "camelCase")]
pub fn clear_translation_cache(
    cache_path: Option<String>,
    report_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<TranslationCacheClearResult> {
    reject_while_running(&state)?;
    let path = resolve_translation_cache_path(
        &state,
        &CachePathInput {
            cache_path: cache_path.unwrap_or_default(),
            report_path: report_path.unwrap_or_default(),
        },
    )?;
    let before = read_translation_cache_info(&path);
    ensure_translation_cache_parent(&path)?;
    fs::write(&path, "{}\n").map_err(|error| CommandError::io("Xóa cache dịch", error))?;
    Ok(TranslationCacheClearResult {
        path: path.to_string_lossy().into_owned(),
        cleared_entries: before.entries,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_glossary(
    glossary_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<GlossaryPayload> {
    let path = resolve_glossary_path(&state, glossary_path)?;
    let exists = path.is_file();
    let mut entries = BTreeMap::new();
    if exists {
        let text = fs::read_to_string(&path)
            .map_err(|error| CommandError::io("Đọc glossary", error))?;
        let value: Value = serde_json::from_str(&text).map_err(|error| {
            CommandError::new(
                "glossary_invalid_json",
                format!("Glossary không phải JSON hợp lệ: {error}"),
            )
        })?;
        entries = parse_glossary_entries(&value)?;
    }
    Ok(GlossaryPayload {
        path: path.to_string_lossy().into_owned(),
        exists,
        entries,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_glossary(
    entries: BTreeMap<String, String>,
    glossary_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<GlossarySaveResult> {
    reject_while_running(&state)?;
    let path = allowed_glossary_write_path(&state, &resolve_glossary_path(&state, glossary_path)?)?;
    validate_glossary_entries(&entries)?;
    let json_entries: Map<String, Value> = entries
        .iter()
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect();
    write_json_atomic(&path, &Value::Object(json_entries))?;
    Ok(GlossarySaveResult {
        path: path.to_string_lossy().into_owned(),
        entries: entries.len() as u64,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn search_tags(
    query: String,
    scope: Option<String>,
    max_results: Option<u64>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<TagSearchResult> {
    let (config, app_config) = {
        let data = state.data()?;
        if data.app.config.export_path.as_os_str().is_empty()
            && data.app.config.mod_path.as_os_str().is_empty()
        {
            return Err(CommandError::new(
                "search_paths_missing",
                "Cần cấu hình exportPath hoặc modPath trước khi tra cứu",
            ));
        }
        let backup_root = backup_directory(&state.app_data_dir);
        let mut config = data
            .app
            .config
            .engine_config(&backup_root, false, None);
        let object = config.as_object_mut().ok_or_else(|| {
            CommandError::new("search_config_invalid", "Không tạo được config engine")
        })?;
        object.insert("query".into(), Value::String(query));
        object.insert(
            "scope".into(),
            Value::String(scope.unwrap_or_else(|| "all".into())),
        );
        let capped = max_results.unwrap_or(500).clamp(1, 5_000);
        object.insert("maxResults".into(), Value::from(capped));
        object.insert(
            "caseSensitive".into(),
            Value::Bool(case_sensitive.unwrap_or(false)),
        );
        object.insert(
            "wholeWord".into(),
            Value::Bool(whole_word.unwrap_or(false)),
        );
        (config, data.app.config.clone())
    };
    let payload = run_engine_sync(
        &app,
        &state,
        "search-tags",
        &config,
        &app_config,
        &[],
        120,
        true,
    )?;
    serde_json::from_value(Value::Object(payload)).map_err(|error| {
        CommandError::new(
            "search_result_invalid",
            format!("Engine trả về kết quả tra cứu không hợp lệ: {error}"),
        )
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_tags(
    max_results: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<TagListResult> {
    let (config, app_config) = {
        let data = state.data()?;
        if data.app.config.export_path.as_os_str().is_empty()
            && data.app.config.mod_path.as_os_str().is_empty()
        {
            return Err(CommandError::new(
                "list_paths_missing",
                "Cần cấu hình exportPath hoặc modPath trước khi tải danh sách tag",
            ));
        }
        let backup_root = backup_directory(&state.app_data_dir);
        let mut config = data
            .app
            .config
            .engine_config(&backup_root, false, None);
        let object = config.as_object_mut().ok_or_else(|| {
            CommandError::new("list_config_invalid", "Không tạo được config engine")
        })?;
        let capped = match max_results {
            Some(0) => 0,
            Some(value) => value.clamp(1, 500_000),
            None => 0,
        };
        object.insert("maxResults".into(), Value::from(capped));
        (config, data.app.config.clone())
    };
    let payload = run_engine_sync(
        &app,
        &state,
        "list-tags",
        &config,
        &app_config,
        &[],
        900,
        true,
    )?;
    serde_json::from_value(Value::Object(payload)).map_err(|error| {
        CommandError::new(
            "list_result_invalid",
            format!("Engine trả về danh sách tag không hợp lệ: {error}"),
        )
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_tag(
    file: String,
    tag: String,
    entry_type: String,
    vietnamese: String,
    timing: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<TagUpdateResult> {
    reject_while_running(&state)?;
    let (config, app_config) = {
        let data = state.data()?;
        if data.app.config.mod_path.as_os_str().is_empty() {
            return Err(CommandError::new(
                "update_mod_path_missing",
                "Cần cấu hình modPath trước khi lưu bản dịch",
            ));
        }
        let backup_root = backup_directory(&state.app_data_dir);
        let mut config = data
            .app
            .config
            .engine_config(&backup_root, false, None);
        let object = config.as_object_mut().ok_or_else(|| {
            CommandError::new("update_config_invalid", "Không tạo được config engine")
        })?;
        object.insert("file".into(), Value::String(file));
        object.insert("tag".into(), Value::String(tag));
        object.insert("entryType".into(), Value::String(entry_type));
        object.insert("vietnamese".into(), Value::String(vietnamese));
        if let Some(value) = timing {
            if !value.trim().is_empty() {
                object.insert("timing".into(), Value::String(value));
            }
        }
        (config, data.app.config.clone())
    };
    let payload = run_engine_sync(
        &app,
        &state,
        "update-tag",
        &config,
        &app_config,
        &[],
        60,
        false,
    )?;
    serde_json::from_value(Value::Object(payload)).map_err(|error| {
        CommandError::new(
            "update_result_invalid",
            format!("Engine trả về kết quả cập nhật không hợp lệ: {error}"),
        )
    })
}

#[tauri::command]
pub fn open_file(path: String, app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let path = PathBuf::from(path);
    let allowed = allowed_open_path(&state, &path)?;
    open_path(&app, &allowed)
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    let (backup, target, backup_root) = {
        let data = state.data()?;
        let backup = data
            .backup_paths
            .get(&backup_id)
            .cloned()
            .ok_or_else(|| CommandError::new("backup_not_found", "Không tìm thấy backup"))?;
        (
            backup,
            data.app.config.mod_path.clone(),
            backup_directory(&state.app_data_dir),
        )
    };
    create_pre_restore_safety_backup(&backup, &target, &backup_root)?;
    restore_backup_manifest(&backup, &target)?;
    {
        let mut data = state.data()?;
        data.sync_previews.clear();
        data.sync_applied = false;
        data.app.invalidate_from(StepId::Sync);
        data.app.selected_step = StepId::Inspect;
        enforce_internal_gates(&mut data);
        refresh_artifacts(&mut data, &state.app_data_dir)?;
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_backup_files(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    let backup = state
        .data()?
        .backup_paths
        .get(&backup_id)
        .cloned()
        .ok_or_else(|| CommandError::new("backup_not_found", "Không tìm thấy backup"))?;
    read_backup_manifest_files(&backup)
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_backup_folder(
    backup_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let backup = state
        .data()?
        .backup_paths
        .get(&backup_id)
        .cloned()
        .ok_or_else(|| CommandError::new("backup_not_found", "Không tìm thấy backup"))?;
    let allowed = allowed_open_path(&state, &backup)?;
    open_path(&app, &allowed)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    {
        let mut data = state.data()?;
        let backup_root = backup_directory(&state.app_data_dir);
        remove_backup_entry(&mut data, &backup_id, &backup_root)?;
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command]
pub fn add_api_key(
    label: String,
    mut secret: String,
    state: State<'_, AppState>,
) -> CommandResult<ApiKeyMeta> {
    reject_while_running(&state)?;
    validate_label(&label)?;
    if secret.trim().is_empty() || secret.len() > 16 * 1024 {
        secret.zeroize();
        return Err(CommandError::new("invalid_api_key", "API key không hợp lệ"));
    }
    let id = state.unique_id("key");
    let suffix: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>()
        .to_uppercase();
    let write_result = credentials::set_secret(&id, &secret);
    secret.zeroize();
    write_result?;
    let key = {
        let mut data = state.data()?;
        let key = ApiKeyMeta {
            id,
            label,
            masked_suffix: format!("•••• {suffix}"),
            priority: data.app.api_keys.len() as u32 + 1,
            enabled: true,
            status: KeyStatus::Unknown,
            last_used: None,
            local_requests: 0,
            active_since: None,
        };
        data.app.api_keys.push(key.clone());
        data.app.invalidate_from(StepId::Translate);
        key
    };
    state.save_snapshot()?;
    Ok(key)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_api_key(
    key_id: String,
    label: String,
    state: State<'_, AppState>,
) -> CommandResult<ApiKeyMeta> {
    reject_while_running(&state)?;
    validate_label(&label)?;
    let updated = {
        let mut data = state.data()?;
        let key = find_key_mut(&mut data.app.api_keys, &key_id)?;
        key.label = label;
        key.clone()
    };
    state.save_snapshot()?;
    Ok(updated)
}

#[tauri::command(rename_all = "camelCase")]
pub fn test_api_key(
    key_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<ApiKeyMeta> {
    reject_while_running(&state)?;
    if !state
        .data()?
        .app
        .api_keys
        .iter()
        .any(|key| key.id == key_id)
    {
        return Err(CommandError::new(
            "api_key_not_found",
            "Không tìm thấy API key",
        ));
    }
    let mut secret = credentials::get_secret(&key_id)?;
    let validation = run_api_key_validation(&app, &state, &secret);
    secret.zeroize();
    let valid = validation?;
    let updated = {
        let mut data = state.data()?;
        let key = find_key_mut(&mut data.app.api_keys, &key_id)?;
        key.status = if valid {
            KeyStatus::Valid
        } else {
            KeyStatus::Invalid
        };
        key.last_used = Some("Vừa kiểm tra".into());
        key.clone()
    };
    state.save_snapshot()?;
    Ok(updated)
}

fn run_api_key_validation(app: &AppHandle, state: &AppState, secret: &str) -> CommandResult<bool> {
    if state
        .job_gate
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(CommandError::new(
            "job_already_running",
            "Chỉ được chạy một job tại một thời điểm",
        ));
    }
    let result = (|| {
        let executable = resolve_sidecar_path(app).ok_or_else(|| {
            CommandError::new(
                "sidecar_not_found",
                format!("Không tìm thấy externalBin {SIDECAR_NAME}"),
            )
        })?;
        ensure_sidecar_runtime(app, &executable)?;
        let job_id = state.unique_id("key-test");
        let empty_config = Value::Object(Map::new());
        let mut keys = vec![secret.to_owned()];
        let request = EngineRequest {
            protocol_version: PROTOCOL_VERSION,
            job_id: &job_id,
            command: "validate-state",
            config: &empty_config,
            api_keys: &keys,
        };
        let serialized = serde_json::to_vec(&request);
        keys.zeroize();
        let mut bytes = serialized
            .map_err(|error| CommandError::new("request_serialize_failed", error.to_string()))?;
        let mut command = Command::new(&executable);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        hide_console_window(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| CommandError::io("Khởi chạy kiểm tra API key", error))?;
        let job_object = JobObject::attach(child.id()).ok().flatten();
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CommandError::new("sidecar_stdin_unavailable", "Không mở được stdin sidecar")
        })?;
        let write_result = stdin.write_all(&bytes).and_then(|_| stdin.flush());
        bytes.zeroize();
        drop(stdin);
        write_result.map_err(|error| CommandError::io("Gửi request kiểm tra key", error))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CommandError::new("sidecar_stdout_unavailable", "Không mở được stdout sidecar")
        })?;
        let child = Arc::new(Mutex::new(child));
        let watchdog_child = Arc::clone(&child);
        let finished = Arc::new(AtomicBool::new(false));
        let watchdog_finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(15));
            if !watchdog_finished.load(Ordering::Acquire) {
                if let Ok(mut child) = watchdog_child.lock() {
                    let _ = child.kill();
                }
            }
        });
        let mut validator = ProtocolValidator::new(&job_id);
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut valid = None;
        while read_bounded_line(&mut reader, &mut line)
            .map_err(|error| CommandError::io("Đọc kết quả kiểm tra key", error))?
        {
            let event = validator.parse_line(&line)?;
            if event.event_type == "result" {
                valid = event.payload.get("valid").and_then(Value::as_bool);
            }
        }
        finished.store(true, Ordering::Release);
        if let Ok(mut child) = child.lock() {
            let _ = child.wait();
        }
        drop(job_object);
        valid.ok_or_else(|| {
            CommandError::new(
                "api_key_test_failed",
                "Engine không trả về kết quả kiểm tra key",
            )
        })
    })();
    state.job_gate.store(false, Ordering::Release);
    result
}

fn run_engine_sync(
    app: &AppHandle,
    state: &AppState,
    command: &str,
    config: &Value,
    app_config: &AppConfig,
    api_keys: &[String],
    timeout_secs: u64,
    allow_while_job_running: bool,
) -> CommandResult<Map<String, Value>> {
    let gate_acquired = if allow_while_job_running {
        false
    } else if state
        .job_gate
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(CommandError::new(
            "job_already_running",
            "Chỉ được chạy một job tại một thời điểm",
        ));
    } else {
        true
    };
    let result = (|| {
        let executable = resolve_sidecar_path(app).ok_or_else(|| {
            CommandError::new(
                "sidecar_not_found",
                format!("Không tìm thấy externalBin {SIDECAR_NAME}"),
            )
        })?;
        ensure_sidecar_runtime(app, &executable)?;
        let job_id = state.unique_id("sync");
        let request = EngineRequest {
            protocol_version: PROTOCOL_VERSION,
            job_id: &job_id,
            command,
            config,
            api_keys,
        };
        let mut bytes = serde_json::to_vec(&request)
            .map_err(|error| CommandError::new("request_serialize_failed", error.to_string()))?;
        let mut command_process = Command::new(&executable);
        command_process
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        hide_console_window(&mut command_process);
        let mut child = command_process
            .spawn()
            .map_err(|error| CommandError::io("Khởi chạy engine sync", error))?;
        let job_object = JobObject::attach(child.id()).ok().flatten();
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CommandError::new("sidecar_stdin_unavailable", "Không mở được stdin sidecar")
        })?;
        let write_result = stdin.write_all(&bytes).and_then(|_| stdin.flush());
        bytes.zeroize();
        drop(stdin);
        write_result.map_err(|error| CommandError::io("Gửi request engine sync", error))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CommandError::new("sidecar_stdout_unavailable", "Không mở được stdout sidecar")
        })?;
        let child = Arc::new(Mutex::new(child));
        let watchdog_child = Arc::clone(&child);
        let finished = Arc::new(AtomicBool::new(false));
        let watchdog_finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(timeout_secs));
            if !watchdog_finished.load(Ordering::Acquire) {
                if let Ok(mut child) = watchdog_child.lock() {
                    let _ = child.kill();
                }
            }
        });
        let spill_roots = spill_allowed_roots(state, app_config);
        let mut validator = ProtocolValidator::new(&job_id);
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut result_payload: Option<Map<String, Value>> = None;
        let mut last_error: Option<String> = None;
        while read_bounded_line(&mut reader, &mut line)
            .map_err(|error| CommandError::io("Đọc kết quả engine sync", error))?
        {
            let event = validator.parse_line(&line)?;
            if event.event_type == "result" {
                let mut payload = event.payload;
                hydrate_spilled_result_payload(&mut payload, &spill_roots)?;
                result_payload = Some(payload);
            } else if event.event_type == "error" {
                let message = event
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let code = event
                    .payload
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("ENGINE_ERROR");
                last_error = Some(match message {
                    Some(message) if code == "INVALID_COMMAND" => format!(
                        "{message}. Sidecar có thể đã cũ — chạy `npm run build:engine` rồi khởi động lại app."
                    ),
                    Some(message) => message,
                    None => format!("Engine báo lỗi ({code})"),
                });
            }
        }
        finished.store(true, Ordering::Release);
        if let Ok(mut child) = child.lock() {
            let _ = child.wait();
        }
        drop(job_object);
        if let Some(payload) = result_payload {
            return Ok(payload);
        }
        if let Some(message) = last_error {
            return Err(CommandError::new("engine_sync_failed", message));
        }
        Err(CommandError::new(
            "engine_result_missing",
            "Engine không trả về kết quả. Kiểm tra sidecar (`npm run build:engine`) và đường dẫn export/mod.",
        ))
    })();
    if gate_acquired {
        state.job_gate.store(false, Ordering::Release);
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_api_key_enabled(
    key_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> CommandResult<ApiKeyMeta> {
    reject_while_running(&state)?;
    let updated = {
        let mut data = state.data()?;
        let key = find_key_mut(&mut data.app.api_keys, &key_id)?;
        key.enabled = enabled;
        if !enabled {
            key.status = KeyStatus::Unknown;
            key.active_since = None;
        }
        let updated = key.clone();
        data.app.invalidate_from(StepId::Translate);
        updated
    };
    state.save_snapshot()?;
    Ok(updated)
}

#[tauri::command(rename_all = "camelCase")]
pub fn reorder_api_keys(
    key_ids: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ApiKeyMeta>> {
    reject_while_running(&state)?;
    let reordered = {
        let mut data = state.data()?;
        if key_ids.len() != data.app.api_keys.len() || key_ids.iter().any(|id| !valid_key_id(id)) {
            return Err(CommandError::new(
                "invalid_key_order",
                "Danh sách keyId không hợp lệ",
            ));
        }
        let mut by_id: BTreeMap<String, ApiKeyMeta> = data
            .app
            .api_keys
            .drain(..)
            .map(|key| (key.id.clone(), key))
            .collect();
        let mut result = Vec::with_capacity(key_ids.len());
        for id in key_ids {
            result.push(by_id.remove(&id).ok_or_else(|| {
                CommandError::new("invalid_key_order", "keyIds phải là hoán vị đầy đủ")
            })?);
        }
        if !by_id.is_empty() {
            return Err(CommandError::new(
                "invalid_key_order",
                "keyIds phải là hoán vị đầy đủ",
            ));
        }
        normalize_priorities(&mut result);
        data.app.api_keys = result.clone();
        result
    };
    state.save_snapshot()?;
    Ok(reordered)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_api_key(key_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    reject_while_running(&state)?;
    if !state
        .data()?
        .app
        .api_keys
        .iter()
        .any(|key| key.id == key_id)
    {
        return Err(CommandError::new(
            "api_key_not_found",
            "Không tìm thấy API key",
        ));
    }
    credentials::delete_secret(&key_id)?;
    {
        let mut data = state.data()?;
        data.app.api_keys.retain(|key| key.id != key_id);
        normalize_priorities(&mut data.app.api_keys);
        data.app.invalidate_from(StepId::Translate);
    }
    state.save_snapshot()
}

fn start_engine_job(
    app: &AppHandle,
    state: &AppState,
    step: StepId,
    command_name: &str,
    dry_run: bool,
    fingerprint: Option<&str>,
) -> CommandResult<JobStartResponse> {
    if state
        .job_gate
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(CommandError::new(
            "job_already_running",
            "Chỉ được chạy một job tại một thời điểm",
        ));
    }
    if let Err(error) = preflight_engine_job(state, step, command_name, dry_run, fingerprint) {
        state.job_gate.store(false, Ordering::Release);
        return Err(error);
    }

    let job_id = state.unique_id("job");
    emit_job_started(app, state, step, &job_id);

    let app = app.clone();
    let state = state.clone();
    let command_name = command_name.to_owned();
    let fingerprint = fingerprint.map(str::to_owned);
    let thread_job_id = job_id.clone();

    std::thread::spawn(move || {
        if let Err(error) = start_reserved_job(
            &app,
            &state,
            step,
            &command_name,
            dry_run,
            fingerprint.as_deref(),
            &thread_job_id,
        ) {
            emit_synthetic_failure(
                &app,
                &state,
                step,
                &thread_job_id,
                1,
                error.message,
            );
            if let Ok(mut data) = state.data() {
                if data
                    .app
                    .active_job
                    .as_ref()
                    .is_some_and(|job| job.id == thread_job_id)
                {
                    data.app.active_job = None;
                }
                if let Some(item) = data.app.step_mut(step) {
                    item.status = StepStatus::Failed;
                }
            }
            clear_process(&state, &thread_job_id);
            state.job_gate.store(false, Ordering::Release);
        }
    });

    Ok(JobStartResponse { job_id })
}

fn preflight_engine_job(
    state: &AppState,
    step: StepId,
    command_name: &str,
    _dry_run: bool,
    fingerprint: Option<&str>,
) -> CommandResult<()> {
    let data = state.data()?;
    data.app.gate(step)?;
    if step == StepId::Translate && !data.sync_applied {
        return Err(CommandError::new(
            "sync_apply_required",
            "Cần apply bản sync preview trước khi dịch",
        ));
    }
    if step == StepId::Translate && !sync_requires_translation(&data.app.sync_changes) {
        return Err(CommandError::new(
            "translate_not_needed",
            "Đồng bộ chỉ xóa mục thừa — không có nội dung mới cần dịch.",
        ));
    }
    if command_name == "sync-apply" && fingerprint.is_none() {
        return Err(CommandError::new(
            "sync_preview_not_found",
            "Cần chạy dry-run trước khi áp dụng Đồng bộ",
        ));
    }
    if step == StepId::Translate {
        let keys: Vec<_> = data
            .app
            .api_keys
            .iter()
            .filter(|key| key.enabled)
            .collect();
        if keys.is_empty() {
            return Err(CommandError::new(
                "api_key_required",
                "Bước dịch cần ít nhất một API key đang bật",
            ));
        }
    }
    Ok(())
}

fn emit_job_started(app: &AppHandle, state: &AppState, step: StepId, job_id: &str) {
    let mut payload = Map::new();
    payload.insert(
        "title".into(),
        Value::String(format!("Bắt đầu {}", step_title(step))),
    );
    payload.insert(
        "description".into(),
        Value::String("Engine đang khởi động…".into()),
    );
    if let Ok(data) = state.data() {
        if step == StepId::Deploy {
            if let Some(deploy) = data.app.steps.iter().find(|item| item.id == StepId::Deploy) {
                if let Some(files) = deploy.summary.files {
                    payload.insert("total".into(), Value::from(files));
                }
            }
        }
    }
    let event = JobEventEnvelope {
        protocol_version: PROTOCOL_VERSION,
        job_id: job_id.to_owned(),
        seq: 0,
        step,
        timestamp: now_iso(),
        event_type: FrontendEventType::Started,
        payload,
    };
    if let Ok(mut data) = state.data() {
        data.app.push_timeline(&event);
    }
    let _ = app.emit("job-event", &event);
}

fn start_reserved_job(
    app: &AppHandle,
    state: &AppState,
    step: StepId,
    command_name: &str,
    dry_run: bool,
    fingerprint: Option<&str>,
    job_id: &str,
) -> CommandResult<()> {
    let (config, mut secrets, translate_key_ids) = {
        let data = state.data()?;
        let mut keys = data.app.api_keys.clone();
        keys.sort_by_key(|key| key.priority);
        let mut secrets = Vec::new();
        let mut translate_key_ids = Vec::new();
        if step == StepId::Translate {
            for key in keys.iter().filter(|key| key.enabled) {
                translate_key_ids.push(key.id.clone());
                secrets.push(credentials::get_secret(&key.id)?);
            }
        }
        (data.app.config.clone(), secrets, translate_key_ids)
    };
    let backup_dir = backup_directory(&state.app_data_dir);
    let engine_config = config.engine_config(&backup_dir, dry_run, fingerprint);
    let request = EngineRequest {
        protocol_version: PROTOCOL_VERSION,
        job_id,
        command: command_name,
        config: &engine_config,
        api_keys: &secrets,
    };
    let mut request_bytes = serde_json::to_vec(&request)
        .map_err(|error| CommandError::new("request_serialize_failed", error.to_string()))?;
    let mut redactions = secrets.clone();
    for secret in &mut secrets {
        secret.zeroize();
    }
    let executable = resolve_sidecar_path(app).ok_or_else(|| {
        request_bytes.zeroize();
        redactions.zeroize();
        CommandError::new(
            "sidecar_not_found",
            format!("Không tìm thấy externalBin {SIDECAR_NAME}"),
        )
    })?;
    if let Err(error) = ensure_sidecar_runtime(app, &executable) {
        request_bytes.zeroize();
        redactions.zeroize();
        return Err(error);
    }

    state.reset_progress_persist_throttle();
    {
        let mut data = state.data()?;
        let preserve_staged_changes = matches!(command_name, "sync-apply" | "deploy-apply");
        invalidate_pipeline_from(&mut data, step, preserve_staged_changes);
        data.app.selected_step = step;
        if let Some(item) = data.app.step_mut(step) {
            item.status = StepStatus::Running;
            item.locked_reason = None;
        }
        if step == StepId::Translate {
            data.translate_session_key_ids = translate_key_ids.clone();
            if let Some(key_id) = translate_key_ids.first() {
                apply_translate_key_active(&mut data, key_id);
            }
        } else {
            data.translate_session_key_ids.clear();
        }
        let initial_key_id = if step == StepId::Translate {
            translate_key_ids.first().cloned()
        } else {
            None
        };
        if command_name == "deploy-apply" {
            data.app.deploy_changes.clear();
        }
        let initial_total = (step == StepId::Deploy)
            .then(|| {
                data.app
                    .steps
                    .iter()
                    .find(|item| item.id == StepId::Deploy)
                    .and_then(|deploy| deploy.summary.files)
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        data.app.active_job = Some(ActiveJob {
            id: job_id.to_owned(),
            step,
            status: ActiveJobStatus::Running,
            started_at: now_iso(),
            elapsed: "00:00".into(),
            eta: None,
            progress: 0.0,
            batch_progress: 0.0,
            current_file: String::new(),
            processed: 0,
            total: initial_total,
            throughput: "Đang đo".into(),
            model: (step == StepId::Translate).then(|| config.model.clone()),
            key_id: initial_key_id,
            key_index: (step == StepId::Translate).then_some(1),
            is_saving_cache: None,
        });
    }
    state.save_snapshot_deferred();

    let thread_command = command_name.to_owned();
    let thread_job_id = job_id.to_owned();
    let spill_roots = spill_allowed_roots(state, &config);
    let started_at = Instant::now();
    let bootstrap = (|| -> CommandResult<(
        std::process::ChildStdout,
        Arc<Mutex<Child>>,
        Arc<AtomicBool>,
        Arc<Mutex<String>>,
    )> {
            let mut command = Command::new(&executable);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            hide_console_window(&mut command);
            let mut child = command
                .spawn()
                .map_err(|error| CommandError::io("Khởi chạy sidecar", error))?;
            let process_id = child.id();
            let job_object = JobObject::attach(process_id).ok().flatten();
            let mut stdin = child.stdin.take().ok_or_else(|| {
                CommandError::new("sidecar_stdin_unavailable", "Không mở được stdin sidecar")
            })?;
            stdin
                .write_all(&request_bytes)
                .and_then(|_| stdin.flush())
                .map_err(|error| CommandError::io("Gửi request sidecar", error))?;
            drop(stdin);
            request_bytes.zeroize();
            let stdout = child.stdout.take().ok_or_else(|| {
                CommandError::new("sidecar_stdout_unavailable", "Không mở được stdout sidecar")
            })?;
            let stderr_capture = Arc::new(Mutex::new(String::new()));
            if let Some(stderr) = child.stderr.take() {
                let stderr_capture = Arc::clone(&stderr_capture);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stderr);
                    let mut chunk = String::new();
                    while reader.read_line(&mut chunk).ok().is_some_and(|n| n > 0) {
                        if let Ok(mut buffer) = stderr_capture.lock() {
                            const MAX_STDERR_CHARS: usize = 4_000;
                            if buffer.len() >= MAX_STDERR_CHARS {
                                break;
                            }
                            let remaining = MAX_STDERR_CHARS - buffer.len();
                            let take = chunk.chars().take(remaining).collect::<String>();
                            buffer.push_str(&take);
                        }
                        chunk.clear();
                    }
                });
            }
            let child = Arc::new(Mutex::new(child));
            let cancel_requested = Arc::new(AtomicBool::new(false));
            if let Ok(mut process) = state.process.lock() {
                *process = Some(RunningProcess {
                    job_id: thread_job_id.clone(),
                    process_id,
                    child: Arc::clone(&child),
                    cancel_requested: Arc::clone(&cancel_requested),
                    job_object,
                });
            }
            Ok((
                stdout,
                child,
                cancel_requested,
                stderr_capture,
            ))
        })();

        let (stdout, child, cancel_requested, stderr_capture) = match bootstrap {
            Ok(parts) => parts,
            Err(error) => {
                redactions.zeroize();
                emit_synthetic_failure(
                    &app,
                    &state,
                    step,
                    &thread_job_id,
                    1,
                    error.message,
                );
                if let Ok(mut data) = state.data() {
                    if data
                        .app
                        .active_job
                        .as_ref()
                        .is_some_and(|job| job.id == thread_job_id)
                    {
                        data.app.active_job = None;
                    }
                    if let Some(item) = data.app.step_mut(step) {
                        item.status = StepStatus::Failed;
                    }
                }
                clear_process(state, &thread_job_id);
                return Ok(());
            }
        };

        let mut validator = ProtocolValidator::new(&thread_job_id);
        let mut terminal_seen = false;
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            let has_line = match read_bounded_line(&mut reader, &mut line) {
                Ok(has_line) => has_line,
                Err(error) => {
                    emit_synthetic_failure(
                        &app,
                        &state,
                        step,
                        &thread_job_id,
                        validator.next_seq(),
                        format!("Không đọc được engine stdout: {error}"),
                    );
                    terminal_seen = true;
                    break;
                }
            };
            if !has_line {
                break;
            }
            if line.is_empty() {
                continue;
            }
            match validator.parse_line(&line) {
                Ok(mut raw) => {
                    redact_value_map(&mut raw.payload, &redactions);
                    if raw.event_type == "result" {
                        if let Err(error) =
                            hydrate_spilled_result_payload(&mut raw.payload, &spill_roots)
                        {
                            emit_synthetic_failure(
                                &app,
                                &state,
                                step,
                                &thread_job_id,
                                validator.next_seq(),
                                error.message,
                            );
                            terminal_seen = true;
                            break;
                        }
                    }
                    let mut event = adapt_engine_event(&raw, step, &thread_job_id);
                    if matches!(event.event_type, FrontendEventType::Report) {
                        compact_report_event_payload(&mut event.payload);
                    }
                    terminal_seen |= matches!(
                        event.event_type,
                        FrontendEventType::Completed
                            | FrontendEventType::Failed
                            | FrontendEventType::Paused
                    );
                    if let Err(error) = apply_engine_event(
                        &app,
                        &state,
                        &thread_command,
                        &raw,
                        event,
                        started_at,
                    ) {
                        emit_synthetic_failure(
                            &app,
                            &state,
                            step,
                            &thread_job_id,
                            validator.next_seq(),
                            error.message,
                        );
                        terminal_seen = true;
                        break;
                    }
                }
                Err(error) => {
                    emit_synthetic_failure(
                        &app,
                        &state,
                        step,
                        &thread_job_id,
                        validator.next_seq(),
                        error.message,
                    );
                    terminal_seen = true;
                    break;
                }
            }
        }
        redactions.zeroize();
        if let Ok(mut child) = child.lock() {
            let _ = child.wait();
        }
        clear_process(&state, &thread_job_id);
        if !terminal_seen {
            let cancelled = cancel_requested.load(Ordering::Acquire);
            let event_type = if cancelled {
                FrontendEventType::Paused
            } else {
                FrontendEventType::Failed
            };
            let stderr_text = stderr_capture
                .lock()
                .ok()
                .map(|text| text.trim().to_owned())
                .filter(|text| !text.is_empty());
            let mut payload = Map::new();
            payload.insert(
                "message".into(),
                Value::String(if cancelled {
                    "Job đã được hủy".into()
                } else if let Some(stderr_text) = stderr_text {
                    format!("Engine thoát mà không gửi terminal event: {stderr_text}")
                } else {
                    "Engine thoát mà không gửi terminal event. Kiểm tra thư mục _internal cạnh sidecar (chạy npm run build:engine).".into()
                }),
            );
            let event = JobEventEnvelope {
                protocol_version: PROTOCOL_VERSION,
                job_id: thread_job_id,
                seq: validator.next_seq(),
                step,
                timestamp: now_iso(),
                event_type,
                payload,
            };
            let _ = apply_frontend_event(
                &app,
                &state,
                &thread_command,
                None,
                event,
                started_at,
            );
        }
    Ok(())
}

fn read_bounded_line(reader: &mut impl BufRead, output: &mut Vec<u8>) -> std::io::Result<bool> {
    output.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(!output.is_empty());
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if output.len().saturating_add(newline) > MAX_EVENT_LINE_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Engine event vượt quá 1 MiB",
                ));
            }
            output.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return Ok(true);
        }
        if output.len().saturating_add(available.len()) > MAX_EVENT_LINE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Engine event vượt quá 1 MiB",
            ));
        }
        let consumed = available.len();
        output.extend_from_slice(available);
        reader.consume(consumed);
    }
}

fn spill_allowed_roots(state: &AppState, config: &AppConfig) -> Vec<PathBuf> {
    let mut roots = vec![
        state.app_data_dir.clone(),
        std::env::temp_dir(),
        config.export_path.clone(),
        config.mod_path.clone(),
        config.report_path.clone(),
    ];
    roots.retain(|path| !path.as_os_str().is_empty());
    roots
}

fn path_under_roots(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(resolved) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        let Ok(root_resolved) = root.canonicalize() else {
            return resolved.starts_with(root);
        };
        resolved.starts_with(root_resolved)
    })
}

fn hydrate_spilled_result_payload(
    payload: &mut Map<String, Value>,
    allowed_roots: &[PathBuf],
) -> CommandResult<()> {
    let spilled = payload
        .get("spilled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(path_text) = payload
        .get("resultPath")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(());
    };
    if !spilled {
        return Ok(());
    }
    let path = PathBuf::from(&path_text);
    if !path_under_roots(&path, allowed_roots) {
        return Err(CommandError::new(
            "result_path_untrusted",
            "Đường dẫn resultPath không nằm trong thư mục được phép",
        ));
    }
    let metadata = fs::metadata(&path).map_err(|error| {
        CommandError::io("Đọc metadata result spilled", error)
    })?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            "result_path_invalid",
            "resultPath không phải file",
        ));
    }
    if metadata.len() > MAX_SPILLED_RESULT_BYTES {
        return Err(CommandError::new(
            "result_spilled_too_large",
            format!(
                "File result spilled vượt quá {} MiB",
                MAX_SPILLED_RESULT_BYTES / (1024 * 1024)
            ),
        ));
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| CommandError::io("Đọc result spilled", error))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| {
        CommandError::new(
            "result_spilled_invalid_json",
            format!("Result spilled không phải JSON hợp lệ: {error}"),
        )
    })?;
    let Some(object) = value.as_object() else {
        return Err(CommandError::new(
            "result_spilled_invalid_json",
            "Result spilled phải là JSON object",
        ));
    };
    let mut hydrated = object.clone();
    hydrated.insert("spilled".into(), Value::Bool(true));
    hydrated.insert("resultPath".into(), Value::String(path_text));
    *payload = hydrated;
    Ok(())
}

fn compact_report_event_payload(payload: &mut Map<String, Value>) {
    for key in [
        "actions",
        "changes",
        "english",
        "vietnamese",
        "diff",
        "copiedFiles",
        "createdInGame",
        "skippedExtraFiles",
        "unchangedFiles",
    ] {
        payload.remove(key);
    }
    if let Some(Value::Object(detail)) = payload.get_mut("detail") {
        for key in [
            "actions",
            "changes",
            "english",
            "vietnamese",
            "diff",
            "copiedFiles",
            "createdInGame",
            "skippedExtraFiles",
            "unchangedFiles",
        ] {
            detail.remove(key);
        }
    }
}

fn adapt_engine_event(raw: &EngineEventEnvelope, step: StepId, job_id: &str) -> JobEventEnvelope {
    let mut payload = raw.payload.clone();
    payload
        .entry("command")
        .or_insert_with(|| Value::String(raw.step.clone()));
    let event_type = match raw.event_type.as_str() {
        "started" => FrontendEventType::Started,
        "progress" => {
            normalize_progress(&mut payload);
            FrontendEventType::Progress
        }
        "warning" => {
            normalize_warning(&mut payload);
            FrontendEventType::Warning
        }
        "result" => {
            let detail = Value::Object(payload.clone());
            payload.insert("detail".into(), detail);
            payload
                .entry("title")
                .or_insert_with(|| Value::String(format!("Kết quả {}", step_title(step))));
            if raw.step == "sync-preview" || raw.step == "deploy-preview" {
                payload.insert("previewId".into(), Value::String(job_id.to_owned()));
            }
            FrontendEventType::Report
        }
        "error" => {
            if payload.get("code").and_then(Value::as_str) == Some("CANCELLED") {
                FrontendEventType::Paused
            } else {
                FrontendEventType::Failed
            }
        }
        "completed" => match payload.get("status").and_then(Value::as_str) {
            Some("cancelled") => FrontendEventType::Paused,
            Some("failed") => FrontendEventType::Failed,
            Some("partial") => {
                payload.insert("hasWarnings".into(), Value::Bool(true));
                FrontendEventType::Completed
            }
            _ => FrontendEventType::Completed,
        },
        _ => FrontendEventType::Log,
    };
    JobEventEnvelope {
        protocol_version: raw.protocol_version,
        job_id: raw.job_id.clone(),
        seq: raw.seq,
        step,
        timestamp: raw.timestamp.clone(),
        event_type,
        payload,
    }
}

fn normalize_warning(payload: &mut Map<String, Value>) {
    if payload.contains_key("title") && payload.contains_key("description") {
        return;
    }
    let phase = payload
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (title, description) = match phase {
        "endpoint-switch" => {
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("Endpoint hiện tại không khả dụng");
            let key_index = payload
                .get("keyIndex")
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into());
            let key_count = payload
                .get("keyCount")
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into());
            let model = payload
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                "Đổi model hoặc API key".into(),
                format!("{reason} · Key {key_index}/{key_count} · {model}"),
            )
        }
        "retry" => {
            let attempt = payload
                .get("attempt")
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into());
            let wait = payload
                .get("waitSeconds")
                .and_then(Value::as_f64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into());
            (
                "Đang thử lại API".into(),
                format!("Lần {attempt} · chờ {wait} giây"),
            )
        }
        "item-fallback" => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let error = payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Không dịch được batch");
            (
                "Fallback dịch từng mục".into(),
                format!("ID {id} · {error}"),
            )
        }
        "qa-summary" => {
            let issue_count = payload
                .get("issueCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let summary = payload
                .get("issueCounts")
                .and_then(Value::as_object)
                .map(|counts| {
                    let mut pairs: Vec<_> = counts
                        .iter()
                        .filter_map(|(key, value)| {
                            Some(format!("{key}: {}", value.as_u64()?))
                        })
                        .collect();
                    pairs.sort();
                    pairs.into_iter().take(5).collect::<Vec<_>>().join(", ")
                })
                .unwrap_or_else(|| issue_count.to_string());
            (
                "QA phát hiện cảnh báo".into(),
                format!("{issue_count} vấn đề · {summary}"),
            )
        }
        _ => {
            let title = payload
                .get("message")
                .or_else(|| payload.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("Cảnh báo")
                .to_owned();
            let description = payload
                .get("description")
                .or_else(|| payload.get("error"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            (title, description)
        }
    };
    payload
        .entry("title".to_owned())
        .or_insert_with(|| Value::String(title));
    payload
        .entry("description".to_owned())
        .or_insert_with(|| Value::String(description));
}

fn normalize_progress(payload: &mut Map<String, Value>) {
    let processed = payload
        .get("processed")
        .or_else(|| payload.get("copied"))
        .or_else(|| payload.get("index"))
        .and_then(Value::as_u64);
    let total = payload.get("total").and_then(Value::as_u64);
    if let Some(processed) = processed {
        payload.insert("processed".into(), Value::from(processed));
    }
    if let (Some(processed), Some(total)) = (processed, total) {
        let progress = if total == 0 {
            0.0
        } else {
            (processed as f64 * 100.0 / total as f64).round()
        };
        payload.insert("progress".into(), Value::from(progress));
    }
    if let Some(progress) = payload.get("progress").and_then(Value::as_f64) {
        payload.insert("progress".into(), Value::from(progress.round()));
    }
    if payload.get("batchProgress").is_none() {
        if let (Some(batch), Some(total)) = (
            payload.get("batch").and_then(Value::as_u64),
            payload.get("batchTotal").and_then(Value::as_u64),
        ) {
            if total > 0 {
                let batch_progress = (batch as f64 * 100.0 / total as f64).round();
                payload.insert("batchProgress".into(), Value::from(batch_progress));
            }
        }
    } else if let Some(batch) = payload.get("batchProgress").and_then(Value::as_f64) {
        payload.insert("batchProgress".into(), Value::from(batch.round()));
    }
    if let Some(current) = payload
        .get("file")
        .or_else(|| payload.get("current"))
        .or_else(|| payload.get("path"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        payload.insert("currentFile".into(), Value::String(current));
    }
}

fn apply_engine_event(
    app: &AppHandle,
    state: &AppState,
    command: &str,
    raw: &EngineEventEnvelope,
    event: JobEventEnvelope,
    started_at: Instant,
) -> CommandResult<()> {
    if raw.event_type == "result" {
        process_result(state, command, &raw.job_id, &raw.payload)?;
    }
    apply_frontend_event(app, state, command, Some(raw), event, started_at)
}

fn apply_frontend_event(
    app: &AppHandle,
    state: &AppState,
    command: &str,
    _raw: Option<&EngineEventEnvelope>,
    event: JobEventEnvelope,
    started_at: Instant,
) -> CommandResult<()> {
    let is_progress = event.event_type == FrontendEventType::Progress;
    {
        let mut data = state.data()?;
        apply_event_state(&mut data, command, &event, started_at);
        if !is_progress {
            data.app.push_timeline(&event);
        }
        enforce_internal_gates(&mut data);
    }
    app.emit("job-event", &event)
        .map_err(|error| CommandError::new("event_emit_failed", error.to_string()))?;
    // Deploy ngắn và I/O-bound: không clone/ghi toàn bộ state ở mỗi progress tick.
    if !is_progress || (command != "deploy-apply" && state.should_persist_progress()) {
        state.save_snapshot_deferred();
    }
    maybe_notify(app, state, &event);
    Ok(())
}

fn apply_translate_key_active(data: &mut PersistedData, key_id: &str) {
    for key in &mut data.app.api_keys {
        if key.id == key_id {
            if key.active_since.is_none() {
                key.active_since = Some(now_iso());
            }
            key.status = KeyStatus::Active;
        } else if key.status == KeyStatus::Active {
            key.status = KeyStatus::Valid;
        }
    }
}

fn apply_translate_progress(
    active: &mut ActiveJob,
    payload: &Map<String, Value>,
    next_key_id: Option<String>,
) {
    if let Some(model) = payload.get("model").and_then(Value::as_str) {
        active.model = Some(model.to_owned());
    }
    if let Some(key_index) = payload.get("keyIndex").and_then(Value::as_u64) {
        active.key_index = Some(key_index);
    }
    if let Some(key_id) = next_key_id {
        active.key_id = Some(key_id);
    }
}

fn increment_translate_key_request(data: &mut PersistedData) {
    let Some(key_id) = data
        .app
        .active_job
        .as_ref()
        .and_then(|job| job.key_id.clone())
    else {
        return;
    };
    if let Ok(key) = find_key_mut(&mut data.app.api_keys, &key_id) {
        key.local_requests = key.local_requests.saturating_add(1);
    }
}

fn resolve_translate_key_id(data: &PersistedData, payload: &Map<String, Value>) -> Option<String> {
    let key_index = payload.get("keyIndex").and_then(Value::as_u64)?;
    if key_index < 1 {
        return None;
    }
    data.translate_session_key_ids
        .get(key_index as usize - 1)
        .cloned()
}

fn clear_translate_session(data: &mut PersistedData) {
    data.translate_session_key_ids.clear();
    for key in &mut data.app.api_keys {
        if key.status == KeyStatus::Active {
            key.status = KeyStatus::Valid;
        }
    }
}

fn apply_event_state(
    data: &mut PersistedData,
    command: &str,
    event: &JobEventEnvelope,
    started_at: Instant,
) {
    match event.event_type {
        FrontendEventType::Started => {
            if let Some(step) = data.app.step_mut(event.step) {
                step.status = StepStatus::Running;
            }
        }
        FrontendEventType::Progress => {
            let payload = event.payload.clone();
            let resolved_key_id = resolve_translate_key_id(data, &payload);
            if let Some(key_id) = resolved_key_id.as_ref() {
                if data.app.active_job.as_ref().and_then(|job| job.key_id.as_ref())
                    != Some(key_id)
                {
                    apply_translate_key_active(data, key_id);
                }
            }
            if let Some(active) = data
                .app
                .active_job
                .as_mut()
                .filter(|job| job.id == event.job_id)
            {
                active.progress = payload
                    .get("progress")
                    .and_then(Value::as_f64)
                    .unwrap_or(active.progress)
                    .round();
                active.batch_progress = payload
                    .get("batchProgress")
                    .and_then(Value::as_f64)
                    .unwrap_or(active.batch_progress)
                    .round();
                active.current_file = payload
                    .get("currentFile")
                    .and_then(Value::as_str)
                    .unwrap_or(&active.current_file)
                    .to_owned();
                active.processed = payload
                    .get("processed")
                    .and_then(Value::as_u64)
                    .unwrap_or(active.processed);
                active.total = payload
                    .get("total")
                    .and_then(Value::as_u64)
                    .unwrap_or(active.total);
                active.elapsed = format_duration(started_at.elapsed());
                apply_translate_progress(active, &payload, resolved_key_id);
            }
            if payload.get("phase").and_then(Value::as_str) == Some("api") {
                increment_translate_key_request(data);
            }
        }
        FrontendEventType::Completed => {
            let payload_warning = event
                .payload
                .get("hasWarnings")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(step) = data.app.step_mut(event.step) {
                let summary_warnings = step.summary.warnings;
                step.status = step_status_after_completion(payload_warning, summary_warnings);
                step.last_run = Some(now_iso());
                step.duration = Some(format_duration(started_at.elapsed()));
            }
            if command == "sync-apply" {
                data.sync_applied = true;
                data.sync_previews.clear();
            }
            if command == "deploy-apply" {
                data.deploy_applied = true;
                data.deploy_previews.clear();
            }
            data.app.active_job = None;
            if command == "translate" || event.step == StepId::Translate {
                clear_translate_session(data);
            }
            data.app.normalize_gates();
            if command == "sync-apply" {
                skip_translate_when_sync_delete_only(data);
            }
        }
        FrontendEventType::Failed => {
            if let Some(step) = data.app.step_mut(event.step) {
                step.status = StepStatus::Failed;
            }
            if let Some(active) = data.app.active_job.as_mut() {
                active.status = ActiveJobStatus::Failed;
            }
        }
        FrontendEventType::Paused => {
            if let Some(step) = data.app.step_mut(event.step) {
                step.status = StepStatus::Paused;
            }
            if let Some(active) = data.app.active_job.as_mut() {
                active.status = ActiveJobStatus::Paused;
                active.is_saving_cache = Some(false);
            }
        }
        _ => {}
    }
}

fn process_result(
    state: &AppState,
    command: &str,
    job_id: &str,
    payload: &Map<String, Value>,
) -> CommandResult<()> {
    let value = Value::Object(payload.clone());
    let report_id = format!("{command}-{job_id}");
    let mut data = state.data()?;
    match command {
        "export" => {
            if let Some(step) = data.app.step_mut(StepId::Export) {
                step.summary.files = payload.get("filesCopied").and_then(Value::as_u64);
            }
        }
        "inspect" => update_inspect_result(&mut data, payload),
        "sync-preview" => update_sync_preview(&mut data, job_id, payload),
        "sync-apply" => {
            if let Some(step) = data.app.step_mut(StepId::Sync) {
                step.summary.changes = summary_total(payload.get("summary"));
            }
        }
        "translate" => update_translate_result(&mut data, payload),
        "deploy-preview" => update_deploy_preview(&mut data, job_id, payload),
        "deploy-apply" => {
            data.app.deploy_changes = deploy_changes(payload);
            if let Some(step) = data.app.step_mut(StepId::Deploy) {
                step.summary.changes = deploy_change_count(payload);
                step.summary.files = payload
                    .get("summary")
                    .and_then(Value::as_object)
                    .and_then(|summary| summary.get("total"))
                    .and_then(Value::as_u64);
                step.summary.skipped = payload
                    .get("summary")
                    .and_then(Value::as_object)
                    .and_then(|summary| summary.get("skipped"))
                    .and_then(Value::as_u64);
                step.summary.warnings = payload
                    .get("summary")
                    .and_then(Value::as_object)
                    .and_then(|summary| summary.get("errors"))
                    .and_then(Value::as_u64);
            }
        }
        _ => {}
    }
    let directory = report_directory(&state.app_data_dir, &data.app);
    let summary = result_summary(command, payload);
    let path = write_report(&directory, &report_id, &value)?;
    let _ = write_report_text(
        &directory,
        &report_id,
        &format!(
            "CIV7 Localization Tool — Báo cáo\nID: {report_id}\nBước: {}\nThời gian: {}\nTóm tắt: {summary}\n",
            step_title(command_step(command)),
            now_iso(),
        ),
    );
    data.report_paths.insert(report_id.clone(), path);
    data.app.reports.insert(
        0,
        Report {
            id: report_id,
            step: command_step(command),
            title: step_title(command_step(command)).to_owned(),
            status: StepStatus::Success,
            created_at: now_iso(),
            duration: String::new(),
            summary,
        },
    );
    Ok(())
}

fn update_inspect_result(data: &mut PersistedData, payload: &Map<String, Value>) {
    let snapshot = build_inspect_snapshot(payload);
    let english = snapshot.english.as_ref();
    let vietnamese = snapshot.vietnamese.as_ref();
    let invalid_warnings = english.map(|item| item.invalid_count).unwrap_or(0)
        + vietnamese.map(|item| item.invalid_count).unwrap_or(0);
    if let Some(step) = data.app.step_mut(StepId::Inspect) {
        step.summary.files = english.map(|item| item.xml_files + item.vtt_files);
        step.summary.rows = english.map(|item| item.rows + item.replaces + item.cues);
        step.summary.changes = Some(snapshot.different_files);
        step.summary.warnings = Some(invalid_warnings);
    }
    data.app.inspect_snapshot = Some(snapshot);
}

fn inspect_inventory_stats(value: Option<&Map<String, Value>>) -> Option<InspectInventoryStats> {
    let item = value?;
    Some(InspectInventoryStats {
        xml_files: item.get("xmlFiles").and_then(Value::as_u64).unwrap_or(0),
        vtt_files: item.get("vttFiles").and_then(Value::as_u64).unwrap_or(0),
        rows: item.get("rows").and_then(Value::as_u64).unwrap_or(0),
        replaces: item.get("replaces").and_then(Value::as_u64).unwrap_or(0),
        cues: item.get("cues").and_then(Value::as_u64).unwrap_or(0),
        invalid_count: item
            .get("invalid")
            .and_then(Value::as_array)
            .map(|items| items.len() as u64)
            .unwrap_or(0),
    })
}

fn inspect_tag_deltas(items: Option<&Vec<Value>>) -> Vec<InspectTagDelta> {
    items
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|item| InspectTagDelta {
            r#type: item
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tag: item
                .get("tag")
                .and_then(Value::as_str)
                .map(str::to_owned),
            timing: item
                .get("timing")
                .and_then(Value::as_str)
                .map(str::to_owned),
            count: item.get("count").and_then(Value::as_u64).unwrap_or(1),
        })
        .collect()
}

fn parse_inspect_diff_status(raw: &str) -> InspectDiffStatus {
    match raw {
        "vietnamese-only" => InspectDiffStatus::VietnameseOnly,
        "different" => InspectDiffStatus::Different,
        "invalid" => InspectDiffStatus::Invalid,
        _ => InspectDiffStatus::EnglishOnly,
    }
}

fn build_inspect_snapshot(payload: &Map<String, Value>) -> InspectSnapshot {
    let english = inspect_inventory_stats(payload.get("english").and_then(Value::as_object));
    let vietnamese =
        inspect_inventory_stats(payload.get("vietnamese").and_then(Value::as_object));
    let diff_meta = payload.get("diff").and_then(Value::as_object);
    let mut diffs = Vec::new();
    let mut english_only = diff_meta
        .and_then(|diff| diff.get("englishOnly"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut vietnamese_only = diff_meta
        .and_then(|diff| diff.get("vietnameseOnly"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut different_files = diff_meta
        .and_then(|diff| diff.get("differentFiles"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if let Some(files) = diff_meta
        .and_then(|diff| diff.get("files"))
        .and_then(Value::as_array)
    {
        different_files = files.len() as u64;
        english_only = 0;
        vietnamese_only = 0;
        for (index, entry) in files.iter().filter_map(Value::as_object).enumerate() {
            let status = parse_inspect_diff_status(
                entry
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("english-only"),
            );
            match status {
                InspectDiffStatus::EnglishOnly => english_only += 1,
                InspectDiffStatus::VietnameseOnly => vietnamese_only += 1,
                InspectDiffStatus::Different | InspectDiffStatus::Invalid => {}
            }
            if diffs.len() < MAX_INSPECT_DIFFS_UI {
                diffs.push(InspectDiff {
                    id: format!("inspect-{index}"),
                    file: entry
                        .get("file")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    status,
                    missing_in_vietnamese: inspect_tag_deltas(
                        entry
                            .get("missingInVietnamese")
                            .and_then(Value::as_array),
                    ),
                    extra_in_vietnamese: inspect_tag_deltas(
                        entry.get("extraInVietnamese").and_then(Value::as_array),
                    ),
                    error: entry
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
        }
    }
    InspectSnapshot {
        english,
        vietnamese,
        diffs,
        english_only,
        vietnamese_only,
        different_files,
    }
}

fn resolve_glossary_path(
    state: &AppState,
    glossary_path: Option<String>,
) -> CommandResult<PathBuf> {
    if let Some(path) = glossary_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let data = state.data()?;
    if !data.app.config.glossary_path.as_os_str().is_empty() {
        return Ok(data.app.config.glossary_path.clone());
    }
    Ok(report_directory(&state.app_data_dir, &data.app).join("glossary.json"))
}

fn allowed_glossary_write_path(state: &AppState, path: &Path) -> CommandResult<PathBuf> {
    if path.is_file() {
        return allowed_open_path(state, path);
    }
    let data = state.data()?;
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| path);
    let check = if parent.exists() {
        parent
            .canonicalize()
            .map_err(|error| CommandError::io("Kiểm tra thư mục glossary", error))?
    } else {
        parent.to_path_buf()
    };
    let report_dir = report_directory(&state.app_data_dir, &data.app);
    let mut roots = vec![
        data.app.config.game_path.clone(),
        data.app.config.export_path.clone(),
        data.app.config.mod_path.clone(),
        data.app.config.report_path.clone(),
        report_dir,
        backup_directory(&state.app_data_dir),
    ];
    if !data.app.config.glossary_path.as_os_str().is_empty() {
        if let Some(parent) = data.app.config.glossary_path.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    for root in roots {
        if root.as_os_str().is_empty() {
            continue;
        }
        let allowed = root
            .canonicalize()
            .ok()
            .is_some_and(|canonical| check == canonical || check.starts_with(&canonical))
            || check.starts_with(&root);
        if allowed {
            return Ok(path.to_path_buf());
        }
    }
    Err(CommandError::new(
        "glossary_path_not_allowed",
        "Đường dẫn glossary nằm ngoài phạm vi ứng dụng",
    ))
}

fn parse_glossary_entries(value: &Value) -> CommandResult<BTreeMap<String, String>> {
    let object = value.as_object().ok_or_else(|| {
        CommandError::new("glossary_invalid_shape", "Glossary phải là JSON object")
    })?;
    let mut entries = BTreeMap::new();
    for (key, item) in object {
        if key == "version" {
            continue;
        }
        let Some(text) = item.as_str() else {
            return Err(CommandError::new(
                "glossary_invalid_entry",
                format!("Giá trị của '{key}' phải là chuỗi"),
            ));
        };
        if key.trim().is_empty() || text.trim().is_empty() {
            return Err(CommandError::new(
                "glossary_invalid_entry",
                "Key và value glossary không được rỗng",
            ));
        }
        entries.insert(key.clone(), text.to_owned());
    }
    Ok(entries)
}

fn validate_glossary_entries(entries: &BTreeMap<String, String>) -> CommandResult<()> {
    let mut seen = std::collections::HashSet::new();
    for (key, value) in entries {
        if key.trim().is_empty() || value.trim().is_empty() {
            return Err(CommandError::new(
                "glossary_invalid_entry",
                "Key và value glossary không được rỗng",
            ));
        }
        if !seen.insert(key.clone()) {
            return Err(CommandError::new(
                "glossary_duplicate_key",
                format!("Thuật ngữ trùng: {key}"),
            ));
        }
    }
    Ok(())
}

fn update_sync_preview(data: &mut PersistedData, job_id: &str, payload: &Map<String, Value>) {
    if let Some(fingerprint) = payload.get("fingerprint").and_then(Value::as_str) {
        data.sync_previews.insert(
            job_id.to_owned(),
            SyncPreview {
                fingerprint: fingerprint.to_owned(),
                created_at: now_iso(),
            },
        );
        data.sync_applied = false;
    }
    let (changes, change_count) = sync_changes(payload);
    data.app.sync_changes = changes;
    if let Some(step) = data.app.step_mut(StepId::Sync) {
        step.summary.changes = Some(change_count);
        step.summary.warnings = Some(
            payload
                .get("errorCount")
                .and_then(Value::as_u64)
                .or_else(|| {
                    payload
                        .get("errors")
                        .and_then(Value::as_array)
                        .map(|errors| errors.len() as u64)
                })
                .unwrap_or(0),
        );
    }
}

fn sync_changes(payload: &Map<String, Value>) -> (Vec<SyncChange>, u64) {
    let mut changes = Vec::new();
    let mut total = 0u64;
    for (action_index, action) in payload
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .enumerate()
    {
        let operation = action
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("update");
        let file = action
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let items = action.get("items").and_then(Value::as_array);
        if let Some(items) = items {
            for (item_index, item) in items.iter().filter_map(Value::as_object).enumerate() {
                total = total.saturating_add(1);
                if changes.len() >= MAX_SYNC_CHANGES_UI {
                    continue;
                }
                let item_change = item
                    .get("change")
                    .and_then(Value::as_str)
                    .unwrap_or(operation);
                // Sync chỉ thêm/xóa cấu trúc theo EN; text VN đã dịch được giữ khi merge.
                // add  → after = text EN sẽ chèn vào VN (chờ dịch)
                // delete → before = text VN sẽ mất
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let before = item
                    .get("before")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        if item_change == "delete" {
                            text.clone()
                        } else {
                            None
                        }
                    });
                let after = item
                    .get("after")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        if item_change == "add" {
                            text.clone()
                        } else {
                            None
                        }
                    });
                changes.push(SyncChange {
                    id: format!("chg-{action_index}-{item_index}"),
                    kind: if file.to_ascii_lowercase().ends_with(".vtt") {
                        SyncChangeKind::Vtt
                    } else {
                        match item_change {
                            "add" => SyncChangeKind::Add,
                            "delete" => SyncChangeKind::Delete,
                            _ => SyncChangeKind::Update,
                        }
                    },
                    file: file.to_owned(),
                    tag: item
                        .get("tag")
                        .or_else(|| item.get("timing"))
                        .or_else(|| item.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    text: text.clone(),
                    before,
                    after,
                });
            }
        } else {
            total = total.saturating_add(1);
            if changes.len() >= MAX_SYNC_CHANGES_UI {
                continue;
            }
            changes.push(SyncChange {
                id: format!("chg-{action_index}"),
                kind: match operation {
                    "add" => SyncChangeKind::Add,
                    "delete" => SyncChangeKind::Delete,
                    _ => SyncChangeKind::Update,
                },
                file: file.to_owned(),
                tag: String::new(),
                text: None,
                before: None,
                after: None,
            });
        }
    }
    (changes, total)
}

fn sync_change_requires_translation(change: &SyncChange) -> bool {
    match change.kind {
        SyncChangeKind::Add | SyncChangeKind::Update => true,
        SyncChangeKind::Delete | SyncChangeKind::Warning => false,
        SyncChangeKind::Vtt => change
            .after
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

fn sync_requires_translation(changes: &[SyncChange]) -> bool {
    changes.iter().any(sync_change_requires_translation)
}

fn skip_translate_when_sync_delete_only(data: &mut PersistedData) {
    if !data.sync_applied || sync_requires_translation(&data.app.sync_changes) {
        return;
    }
    if !data
        .app
        .step(StepId::Sync)
        .is_some_and(|step| step.status.complete())
    {
        return;
    }
    let Some(translate) = data.app.step_mut(StepId::Translate) else {
        return;
    };
    if matches!(
        translate.status,
        StepStatus::Running | StepStatus::Failed | StepStatus::Paused
    ) {
        return;
    }
    translate.status = StepStatus::Success;
    translate.last_run = Some(now_iso());
    translate.duration = Some("00:00".into());
    translate.locked_reason = None;
    translate.summary.translated = Some(0);
    translate.summary.warnings = Some(0);
    // Translate vừa thành công do được bỏ qua; cập nhật ngay prerequisite của Deploy.
    data.app.normalize_gates();
}

fn deploy_change_requires_apply(change: &DeployChange) -> bool {
    matches!(
        change.kind,
        DeployChangeKind::Copy | DeployChangeKind::Create
    )
}

fn deploy_requires_apply(changes: &[DeployChange]) -> bool {
    changes.iter().any(deploy_change_requires_apply)
}

fn trim_deploy_changes_for_ui(data: &mut PersistedData) {
    data.app.deploy_changes.retain(|change| {
        !matches!(change.kind, DeployChangeKind::Unchanged)
    });
    if data.app.deploy_changes.len() > MAX_DEPLOY_CHANGES_UI {
        data.app.deploy_changes.truncate(MAX_DEPLOY_CHANGES_UI);
    }
}

fn deploy_action_required(data: &PersistedData) -> bool {
    if data
        .app
        .step(StepId::Deploy)
        .and_then(|step| step.summary.changes)
        .is_some_and(|count| count > 0)
    {
        return true;
    }
    deploy_requires_apply(&data.app.deploy_changes)
}

fn skip_deploy_when_nothing_to_apply(data: &mut PersistedData) {
    if data.deploy_applied || deploy_action_required(data) {
        return;
    }
    if !data
        .app
        .step(StepId::Translate)
        .is_some_and(|step| step.status.complete())
    {
        return;
    }
    let Some(deploy) = data.app.step_mut(StepId::Deploy) else {
        return;
    };
    if !matches!(deploy.status, StepStatus::Success | StepStatus::Warning) {
        return;
    }
    if matches!(
        deploy.status,
        StepStatus::Running | StepStatus::Failed | StepStatus::Paused | StepStatus::Locked
    ) {
        return;
    }
    deploy.status = StepStatus::Success;
    deploy.last_run = Some(now_iso());
    deploy.duration = Some("00:00".into());
    deploy.locked_reason = None;
    deploy.summary.changes = Some(0);
    deploy.summary.warnings = Some(0);
    data.deploy_applied = true;
    data.deploy_previews.clear();
}

fn deploy_change_count(payload: &Map<String, Value>) -> Option<u64> {
    payload
        .get("summary")
        .and_then(Value::as_object)
        .map(|summary| {
            summary
                .get("copied")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + summary
                    .get("created")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
        })
}

fn deploy_changes(payload: &Map<String, Value>) -> Vec<DeployChange> {
    let mut changes = Vec::new();
    let mut index = 0usize;
    for (kind, key) in [
        (DeployChangeKind::Copy, "copiedFiles"),
        (DeployChangeKind::Create, "createdInGame"),
        (DeployChangeKind::Skip, "skippedExtraFiles"),
    ] {
        if let Some(files) = payload.get(key).and_then(Value::as_array) {
            for file in files.iter().filter_map(Value::as_str) {
                if changes.len() >= MAX_DEPLOY_CHANGES_UI {
                    return changes;
                }
                changes.push(DeployChange {
                    id: format!("dep-{index}"),
                    kind,
                    file: file.to_owned(),
                });
                index += 1;
            }
        }
    }
    changes
}

fn update_deploy_preview(data: &mut PersistedData, job_id: &str, payload: &Map<String, Value>) {
    data.deploy_previews.insert(
        job_id.to_owned(),
        DeployPreview {
            created_at: now_iso(),
        },
    );
    data.deploy_applied = false;
    data.app.deploy_changes = deploy_changes(payload);
    let change_count = deploy_change_count(payload).unwrap_or(0);
    if let Some(step) = data.app.step_mut(StepId::Deploy) {
        step.summary.changes = Some(change_count);
        step.summary.files = payload
            .get("summary")
            .and_then(Value::as_object)
            .and_then(|summary| summary.get("total"))
            .and_then(Value::as_u64);
        step.summary.warnings = Some(
            payload
                .get("errors")
                .and_then(Value::as_array)
                .map(|errors| errors.len() as u64)
                .unwrap_or(0),
        );
    }
}

fn update_translate_result(data: &mut PersistedData, payload: &Map<String, Value>) {
    let stats = payload.get("stats").and_then(Value::as_object);
    if let Some(step) = data.app.step_mut(StepId::Translate) {
        step.summary.files = stats
            .and_then(|stats| stats.get("filesProcessed"))
            .and_then(Value::as_u64);
        step.summary.translated = stats
            .and_then(|stats| stats.get("itemsTranslated"))
            .and_then(Value::as_u64);
        step.summary.skipped = stats
            .and_then(|stats| stats.get("itemsSkipped"))
            .and_then(Value::as_u64);
    }
    let issues = payload
        .get("qa")
        .and_then(Value::as_object)
        .and_then(|qa| qa.get("issues"))
        .and_then(Value::as_array);
    let qa_issue_count = payload
        .get("qa")
        .and_then(Value::as_object)
        .and_then(|qa| qa.get("issueCount"))
        .and_then(Value::as_u64);
    if let Some(step) = data.app.step_mut(StepId::Translate) {
        if let Some(count) = qa_issue_count {
            step.summary.warnings = Some(count);
        }
    }
    data.app.qa_issues = issues
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, issue)| issue.as_object().map(|issue| (index, issue)))
        .map(|(index, issue)| QaIssue {
            id: format!("qa-{index}"),
            severity: if issue.get("kind").and_then(Value::as_str) == Some("invalid-file") {
                QaSeverity::Error
            } else {
                QaSeverity::Warning
            },
            rule: issue
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("qa")
                .to_owned(),
            file: issue
                .get("file")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            tag: issue
                .get("tag")
                .or_else(|| issue.get("timing"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            source: issue
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            target: issue
                .get("text")
                .or_else(|| issue.get("target"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    issue.get("tokens").and_then(|tokens| {
                        tokens.as_array().map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                    })
                })
                .or_else(|| {
                    issue
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default(),
        })
        .collect();
}

fn summary_total(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_object)
        .map(|summary| summary.values().filter_map(Value::as_u64).sum())
}

fn step_status_after_completion(payload_warning: bool, summary_warnings: Option<u64>) -> StepStatus {
    if payload_warning || summary_warnings.unwrap_or(0) > 0 {
        StepStatus::Warning
    } else {
        StepStatus::Success
    }
}

fn result_summary(command: &str, payload: &Map<String, Value>) -> String {
    match command {
        "export" => format!(
            "{} file",
            payload
                .get("filesCopied")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ),
        "sync-preview" | "sync-apply" => format!(
            "{} thay đổi",
            summary_total(payload.get("summary")).unwrap_or(0)
        ),
        "deploy-preview" | "deploy-apply" => format!(
            "{} file sẽ ghi",
            deploy_change_count(payload).unwrap_or(0)
        ),
        "translate" => format!(
            "{} mục đã dịch",
            payload
                .get("stats")
                .and_then(Value::as_object)
                .and_then(|stats| stats.get("itemsTranslated"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ),
        _ => "Đã tạo report".into(),
    }
}

fn command_step(command: &str) -> StepId {
    match command {
        "export" => StepId::Export,
        "inspect" => StepId::Inspect,
        "sync-preview" | "sync-apply" => StepId::Sync,
        "deploy-preview" | "deploy-apply" => StepId::Deploy,
        _ => StepId::Translate,
    }
}

fn emit_synthetic_failure(
    app: &AppHandle,
    state: &AppState,
    step: StepId,
    job_id: &str,
    seq: u64,
    message: String,
) {
    let mut payload = Map::new();
    payload.insert("message".into(), Value::String(message));
    let event = JobEventEnvelope {
        protocol_version: PROTOCOL_VERSION,
        job_id: job_id.to_owned(),
        seq,
        step,
        timestamp: now_iso(),
        event_type: FrontendEventType::Failed,
        payload,
    };
    let _ = apply_frontend_event(app, state, "", None, event, Instant::now());
}

fn maybe_notify(app: &AppHandle, state: &AppState, event: &JobEventEnvelope) {
    let Ok(data) = state.data() else {
        return;
    };
    let config = &data.app.config.notifications;
    if !config.enabled {
        return;
    }
    let allowed = match event.event_type {
        FrontendEventType::Completed => config.completed,
        FrontendEventType::Paused => config.paused,
        FrontendEventType::Failed => config.failed,
        _ => false,
    };
    if allowed {
        let _ = app
            .notification()
            .builder()
            .title("CIV7 Localization Tool")
            .body(
                event
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(event.event_type.as_str()),
            )
            .show();
    }
}

fn ensure_sidecar_runtime(app: &AppHandle, executable: &Path) -> CommandResult<()> {
    let Some(parent) = executable.parent() else {
        return Err(CommandError::new(
            "sidecar_runtime_missing",
            "Không xác định được thư mục chứa sidecar",
        ));
    };
    let runtime = parent.join("_internal");
    if runtime.is_dir() {
        return Ok(());
    }

    // NSIS/Tauri place bundle resources under `$RESOURCE` (…/resources/_internal),
    // while PyInstaller requires `_internal` next to the sidecar executable.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("_internal");
        if bundled.is_dir() {
            if let Err(error) = materialize_sidecar_runtime(&bundled, &runtime) {
                return Err(CommandError::new(
                    "sidecar_runtime_missing",
                    format!(
                        "Không tạo được _internal cạnh sidecar ({} → {}): {error}",
                        bundled.display(),
                        runtime.display()
                    ),
                ));
            }
            if runtime.is_dir() {
                return Ok(());
            }
        }
    }

    Err(CommandError::new(
        "sidecar_runtime_missing",
        format!(
            "Thiếu thư mục PyInstaller _internal cạnh sidecar ({}). Cài lại bản build có bundle engine, hoặc chạy npm run build:engine khi dev.",
            runtime.display()
        ),
    ))
}

fn materialize_sidecar_runtime(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() || dst.is_symlink() {
        let meta = fs::symlink_metadata(dst)?;
        if meta.file_type().is_symlink() || is_path_reparse_point(&meta) {
            fs::remove_dir(dst)?;
        } else if meta.is_dir() {
            return Ok(());
        } else {
            fs::remove_file(dst)?;
        }
    }

    #[cfg(windows)]
    {
        let mut link = Command::new("cmd");
        link.args(["/C", "mklink", "/J"]).arg(dst).arg(src);
        hide_console_window(&mut link);
        if link
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }

    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(src, dst).is_ok() {
            return Ok(());
        }
    }

    copy_dir_recursive(src, dst)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn is_path_reparse_point(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

fn resolve_sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("CIV7_LOCALIZATION_ENGINE_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return path.canonicalize().ok();
        }
    }
    let executable = format!("{SIDECAR_NAME}{}", std::env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&executable));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(&executable));
        }
    }
    #[cfg(debug_assertions)]
    {
        let target = if cfg!(all(target_arch = "x86_64", windows)) {
            "x86_64-pc-windows-msvc"
        } else if cfg!(all(target_arch = "aarch64", windows)) {
            "aarch64-pc-windows-msvc"
        } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
            "x86_64-unknown-linux-gnu"
        } else if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
            "aarch64-apple-darwin"
        } else {
            ""
        };
        if !target.is_empty() {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries")
                    .join(format!(
                        "{SIDECAR_NAME}-{target}{}",
                        std::env::consts::EXE_SUFFIX
                    )),
            );
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn open_path(app: &AppHandle, path: &Path) -> CommandResult<()> {
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| CommandError::new("open_path_failed", error.to_string()))
}

fn resolve_translation_cache_path(
    state: &AppState,
    input: &CachePathInput,
) -> CommandResult<PathBuf> {
    let data = state.data()?;
    let mut config = data.app.config.clone();
    if !input.cache_path.is_empty() {
        config.cache_path = PathBuf::from(&input.cache_path);
    }
    if !input.report_path.is_empty() {
        config.report_path = PathBuf::from(&input.report_path);
    }
    Ok(config.resolved_cache_path())
}

fn ensure_translation_cache_parent(path: &Path) -> CommandResult<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| CommandError::io("Tạo thư mục cache dịch", error))?;
        }
    }
    Ok(())
}

fn ensure_translation_cache_file(path: &Path) -> CommandResult<()> {
    if path.is_file() {
        return Ok(());
    }
    ensure_translation_cache_parent(path)?;
    fs::write(path, "{}\n").map_err(|error| CommandError::io("Tạo file cache dịch", error))?;
    Ok(())
}

fn count_translation_cache_entries(path: &Path) -> u64 {
    let Ok(raw) = fs::read_to_string(path) else {
        return 0;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return 0;
    };
    match value {
        Value::Object(map) => {
            if let Some(Value::Object(items)) = map.get("items") {
                return items.len() as u64;
            }
            map.keys()
                .filter(|key| *key != "version")
                .count() as u64
        }
        _ => 0,
    }
}

fn read_translation_cache_info(path: &Path) -> TranslationCacheInfo {
    let exists = path.is_file();
    let size_bytes = if exists {
        fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
    } else {
        0
    };
    let entries = if exists {
        count_translation_cache_entries(path)
    } else {
        0
    };
    TranslationCacheInfo {
        path: path.to_string_lossy().into_owned(),
        exists,
        entries,
        size_bytes,
    }
}

fn allowed_open_path(state: &AppState, path: &Path) -> CommandResult<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|error| CommandError::io("Mở file", error))?;
    let data = state.data()?;
    let roots = [
        &data.app.config.game_path,
        &data.app.config.export_path,
        &data.app.config.mod_path,
        &data.app.config.report_path,
        &data.app.config.glossary_path,
    ];
    let cache_path = data.app.config.resolved_cache_path();
    let mut allowed = roots.iter().any(|root| {
        !root.as_os_str().is_empty()
            && root
                .canonicalize()
                .ok()
                .is_some_and(|root| canonical == root || canonical.starts_with(&root))
    }) || canonical.starts_with(
        backup_directory(&state.app_data_dir)
            .canonicalize()
            .unwrap_or_else(|_| backup_directory(&state.app_data_dir)),
    );
    if !allowed && !cache_path.as_os_str().is_empty() {
        allowed = canonical == cache_path
            || cache_path
                .parent()
                .and_then(|parent| parent.canonicalize().ok())
                .is_some_and(|parent| canonical.starts_with(&parent));
    }
    if allowed {
        Ok(canonical)
    } else {
        Err(CommandError::new(
            "open_path_not_allowed",
            "Đường dẫn nằm ngoài phạm vi ứng dụng",
        ))
    }
}

fn reject_while_running(state: &AppState) -> CommandResult<()> {
    if state.job_gate.load(Ordering::Acquire) {
        Err(CommandError::new(
            "job_already_running",
            "Không thể thay đổi dữ liệu khi job đang chạy",
        ))
    } else {
        Ok(())
    }
}

fn validate_label(label: &str) -> CommandResult<()> {
    if label.trim().is_empty() || label.len() > 96 || label.chars().any(char::is_control) {
        Err(CommandError::new(
            "invalid_label",
            "Nhãn API key không hợp lệ",
        ))
    } else {
        Ok(())
    }
}

fn find_key_mut<'a>(keys: &'a mut [ApiKeyMeta], key_id: &str) -> CommandResult<&'a mut ApiKeyMeta> {
    if !valid_key_id(key_id) {
        return Err(CommandError::new("invalid_key_id", "keyId không hợp lệ"));
    }
    keys.iter_mut()
        .find(|key| key.id == key_id)
        .ok_or_else(|| CommandError::new("api_key_not_found", "Không tìm thấy API key"))
}

fn normalize_priorities(keys: &mut [ApiKeyMeta]) {
    keys.sort_by_key(|key| key.priority);
    for (index, key) in keys.iter_mut().enumerate() {
        key.priority = index as u32 + 1;
    }
}

fn enforce_internal_gates(data: &mut PersistedData) {
    publish_gate_flags(data);
    if !data.sync_applied {
        if let Some(translate) = data.app.step_mut(StepId::Translate) {
            if !matches!(
                translate.status,
                StepStatus::Running | StepStatus::Failed | StepStatus::Paused
            ) {
                translate.status = StepStatus::Locked;
                translate.locked_reason = Some("Cần áp dụng bản xem trước Đồng bộ.".into());
            }
        }
    } else {
        skip_translate_when_sync_delete_only(data);
    }
    skip_deploy_when_nothing_to_apply(data);
}

fn invalidate_pipeline_from(
    data: &mut PersistedData,
    first: StepId,
    preserve_staged_changes: bool,
) {
    data.app.invalidate_from(first);
    if first <= StepId::Sync {
        if preserve_staged_changes && first == StepId::Sync {
            // sync-apply: giữ sync_changes từ preview để bước Dịch biết còn mục mới.
            data.sync_applied = false;
        } else {
            data.sync_previews.clear();
            data.sync_applied = false;
            data.app.sync_changes.clear();
            data.app.sync_preview = None;
        }
    }
    if first <= StepId::Inspect {
        data.app.inspect_snapshot = None;
    }
    if first <= StepId::Translate {
        data.app.qa_issues.clear();
    }
    if first <= StepId::Deploy {
        if preserve_staged_changes && first == StepId::Deploy {
            data.deploy_applied = false;
        } else {
            data.deploy_previews.clear();
            data.deploy_applied = false;
            data.app.deploy_changes.clear();
        }
    }
    publish_gate_flags(data);
}

fn publish_gate_flags(data: &mut PersistedData) {
    data.app.sync_applied = data.sync_applied;
    data.app.deploy_applied = data.deploy_applied;
    data.app.sync_preview = data
        .sync_previews
        .values()
        .max_by(|left, right| left.created_at.cmp(&right.created_at))
        .map(|preview| crate::models::SyncPreviewInfo {
            fingerprint: preview.fingerprint.clone(),
            created_at: preview.created_at.clone(),
        });
}

fn clear_process(state: &AppState, job_id: &str) {
    if let Ok(mut process) = state.process.lock() {
        if process.as_ref().is_some_and(|item| item.job_id == job_id) {
            process.take();
        }
    }
    state.job_gate.store(false, Ordering::Release);
}

fn config_invalidation(old: &AppConfig, new: &AppConfig) -> Option<StepId> {
    if old.game_path != new.game_path || old.export_path != new.export_path {
        Some(StepId::Export)
    } else if old.mod_path != new.mod_path {
        Some(StepId::Inspect)
    } else if old.glossary_path != new.glossary_path
        || old.model != new.model
        || old.fallback_models != new.fallback_models
        || old.delay_ms != new.delay_ms
        || old.timeout_seconds != new.timeout_seconds
        || old.batch_size != new.batch_size
        || old.max_files != new.max_files
        || old.max_api_calls != new.max_api_calls
    {
        Some(StepId::Translate)
    } else if old.deploy_backup != new.deploy_backup
        || old.deploy_only_existing != new.deploy_only_existing
    {
        Some(StepId::Deploy)
    } else {
        None
    }
}

fn format_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn redact_value_map(map: &mut Map<String, Value>, secrets: &[String]) {
    for value in map.values_mut() {
        redact_value(value, secrets, 0);
    }
}

fn redact_value(value: &mut Value, secrets: &[String], depth: usize) {
    if depth > 32 {
        *value = Value::String("[REDACTED]".into());
        return;
    }
    match value {
        Value::String(text) => {
            for secret in secrets {
                if secret.len() >= 4 && text.contains(secret) {
                    *text = text.replace(secret, "[REDACTED]");
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_value(item, secrets, depth + 1);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                redact_value(item, secrets, depth + 1);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_progress_uses_processed_file_count() {
        let mut payload = Map::from_iter([
            ("processed".into(), Value::from(250u64)),
            ("total".into(), Value::from(500u64)),
        ]);
        normalize_progress(&mut payload);
        assert_eq!(payload.get("progress").and_then(Value::as_f64), Some(50.0));
    }

    #[test]
    fn command_mapping_matches_engine_contract() {
        assert_eq!(
            StepId::Export.engine_command(JobMode::Run).expect("export"),
            "export"
        );
        assert_eq!(
            StepId::Inspect
                .engine_command(JobMode::Run)
                .expect("inspect"),
            "inspect"
        );
        assert_eq!(
            StepId::Sync
                .engine_command(JobMode::DryRun)
                .expect("preview"),
            "sync-preview"
        );
        assert_eq!(
            StepId::Translate
                .engine_command(JobMode::Resume)
                .expect("translate"),
            "translate"
        );
        assert_eq!(
            StepId::Deploy
                .engine_command(JobMode::DryRun)
                .expect("deploy preview"),
            "deploy-preview"
        );
    }

    #[test]
    fn engine_event_maps_to_frontend_step_and_type() {
        let raw = EngineEventEnvelope {
            protocol_version: 1,
            job_id: "job-1".into(),
            seq: 1,
            event_type: "result".into(),
            step: "sync-preview".into(),
            timestamp: now_iso(),
            payload: Map::from_iter([("fingerprint".into(), Value::String("abc".into()))]),
        };
        let mapped = adapt_engine_event(&raw, StepId::Sync, "job-1");
        assert_eq!(mapped.step, StepId::Sync);
        assert_eq!(mapped.event_type, FrontendEventType::Report);
        assert_eq!(mapped.payload["previewId"], "job-1");
        assert_eq!(mapped.payload["command"], "sync-preview");
    }

    #[test]
    fn step_status_after_completion_respects_latest_warnings() {
        assert_eq!(
            step_status_after_completion(false, Some(0)),
            StepStatus::Success
        );
        assert_eq!(
            step_status_after_completion(false, Some(3)),
            StepStatus::Warning
        );
        assert_eq!(
            step_status_after_completion(true, Some(0)),
            StepStatus::Warning
        );
        assert_eq!(step_status_after_completion(false, None), StepStatus::Success);
    }

    #[test]
    fn inspect_snapshot_maps_diff_files() {
        let payload = Map::from_iter([
            (
                "english".into(),
                Value::Object(Map::from_iter([
                    ("xmlFiles".into(), Value::Number(10.into())),
                    ("vttFiles".into(), Value::Number(2.into())),
                    ("rows".into(), Value::Number(100.into())),
                    ("replaces".into(), Value::Number(5.into())),
                    ("cues".into(), Value::Number(3.into())),
                    ("invalid".into(), Value::Array(vec![])),
                ])),
            ),
            (
                "vietnamese".into(),
                Value::Object(Map::from_iter([
                    ("xmlFiles".into(), Value::Number(9.into())),
                    ("invalid".into(), Value::Array(vec![Value::Object(Map::new())])),
                ])),
            ),
            (
                "diff".into(),
                Value::Object(Map::from_iter([
                    ("differentFiles".into(), Value::Number(2.into())),
                    (
                        "files".into(),
                        Value::Array(vec![
                            Value::Object(Map::from_iter([
                                (
                                    "file".into(),
                                    Value::String("Base/Text.xml".into()),
                                ),
                                ("status".into(), Value::String("english-only".into())),
                            ])),
                            Value::Object(Map::from_iter([
                                (
                                    "file".into(),
                                    Value::String("DLC/Text.xml".into()),
                                ),
                                ("status".into(), Value::String("different".into())),
                                (
                                    "missingInVietnamese".into(),
                                    Value::Array(vec![Value::Object(Map::from_iter([
                                        ("type".into(), Value::String("Row".into())),
                                        ("tag".into(), Value::String("LOC_NEW".into())),
                                        ("count".into(), Value::Number(1.into())),
                                    ]))]),
                                ),
                            ])),
                        ]),
                    ),
                ])),
            ),
        ]);
        let snapshot = build_inspect_snapshot(&payload);
        assert_eq!(snapshot.diffs.len(), 2);
        assert_eq!(snapshot.english_only, 1);
        assert_eq!(snapshot.different_files, 2);
        assert_eq!(snapshot.diffs[1].missing_in_vietnamese[0].tag.as_deref(), Some("LOC_NEW"));
    }

    #[test]
    fn sync_changes_maps_item_text_field() {
        let payload = Map::from_iter([(
            "actions".into(),
            Value::Array(vec![Value::Object(Map::from_iter([
                ("operation".into(), Value::String("update".into())),
                ("path".into(), Value::String("Base/RootText.xml".into())),
                (
                    "items".into(),
                    Value::Array(vec![
                        Value::Object(Map::from_iter([
                            ("change".into(), Value::String("add".into())),
                            ("type".into(), Value::String("Row".into())),
                            ("tag".into(), Value::String("LOC_EMPTY".into())),
                            ("text".into(), Value::String(String::new())),
                        ])),
                        Value::Object(Map::from_iter([
                            ("change".into(), Value::String("delete".into())),
                            ("type".into(), Value::String("Row".into())),
                            ("tag".into(), Value::String("LOC_OLD".into())),
                            ("text".into(), Value::String("Xin chao".into())),
                        ])),
                    ]),
                ),
            ]))]),
        )]);
        let (changes, total) = sync_changes(&payload);
        assert_eq!(total, 2);
        assert_eq!(changes[0].text.as_deref(), Some(""));
        assert_eq!(changes[0].after.as_deref(), Some(""));
        assert_eq!(changes[1].text.as_deref(), Some("Xin chao"));
        assert_eq!(changes[1].before.as_deref(), Some("Xin chao"));
    }

    #[test]
    fn sync_apply_invalidation_preserves_preview_changes() {
        let mut data = PersistedData::default();
        data.sync_applied = true;
        data.app.sync_changes.push(SyncChange {
            id: "add-1".into(),
            kind: SyncChangeKind::Add,
            file: "Base/Text.xml".into(),
            tag: "LOC_NEW".into(),
            text: None,
            before: None,
            after: Some("New line".into()),
        });

        invalidate_pipeline_from(&mut data, StepId::Sync, true);

        assert_eq!(data.app.sync_changes.len(), 1);
        assert!(!data.sync_applied);
        assert!(sync_requires_translation(&data.app.sync_changes));
    }

    #[test]
    fn sync_preview_invalidation_clears_stale_changes() {
        let mut data = PersistedData::default();
        data.app.sync_changes.push(SyncChange {
            id: "add-1".into(),
            kind: SyncChangeKind::Add,
            file: "Base/Text.xml".into(),
            tag: "LOC_NEW".into(),
            text: None,
            before: None,
            after: Some("New line".into()),
        });

        invalidate_pipeline_from(&mut data, StepId::Sync, false);

        assert!(data.app.sync_changes.is_empty());
    }

    #[test]
    fn sync_requires_translation_only_for_add_or_update() {
        let (changes, _) = sync_changes(&Map::from_iter([(
            "actions".into(),
            Value::Array(vec![Value::Object(Map::from_iter([
                ("operation".into(), Value::String("update".into())),
                ("path".into(), Value::String("Base/RootText.xml".into())),
                (
                    "items".into(),
                    Value::Array(vec![Value::Object(Map::from_iter([
                        ("change".into(), Value::String("delete".into())),
                        ("type".into(), Value::String("Row".into())),
                        ("tag".into(), Value::String("LOC_OLD".into())),
                        ("text".into(), Value::String("Xin chao".into())),
                    ]))]),
                ),
            ]))]),
        )]));
        assert!(!sync_requires_translation(&changes));
        assert!(sync_change_requires_translation(&SyncChange {
            id: "add".into(),
            kind: SyncChangeKind::Add,
            file: "a.xml".into(),
            tag: "TAG".into(),
            text: None,
            before: None,
            after: Some("English".into()),
        }));
    }

    #[test]
    fn skipped_translate_unlocks_deploy_immediately() {
        let mut data = PersistedData::default();
        data.app.config.game_path = std::env::current_dir().expect("cwd");
        data.app.config.export_path = std::env::temp_dir().join("civ7-export");
        data.app.config.mod_path = std::env::temp_dir().join("civ7-mod");
        data.app.config.report_path = std::env::temp_dir().join("civ7-reports");
        data.app.normalize_gates();
        data.sync_applied = true;
        data.app.sync_changes.clear();
        data.app.step_mut(StepId::Export).expect("export").status = StepStatus::Success;
        data.app.step_mut(StepId::Inspect).expect("inspect").status = StepStatus::Success;
        data.app.step_mut(StepId::Sync).expect("sync").status = StepStatus::Success;
        data.app
            .step_mut(StepId::Translate)
            .expect("translate")
            .status = StepStatus::Locked;
        data.app.step_mut(StepId::Deploy).expect("deploy").status = StepStatus::Locked;

        skip_translate_when_sync_delete_only(&mut data);

        assert_eq!(
            data.app.step(StepId::Translate).expect("translate").status,
            StepStatus::Success
        );
        assert_eq!(
            data.app.step(StepId::Deploy).expect("deploy").status,
            StepStatus::Ready
        );
        assert!(data.app.gate(StepId::Deploy).is_ok());
    }

    #[test]
    fn jsonl_reader_rejects_oversized_line_before_parsing() {
        let bytes = vec![b'x'; MAX_EVENT_LINE_BYTES + 1];
        let mut reader = BufReader::new(bytes.as_slice());
        let mut output = Vec::new();
        assert_eq!(
            read_bounded_line(&mut reader, &mut output)
                .expect_err("oversized")
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn hydrate_spilled_result_reads_trusted_file() {
        let directory = std::env::temp_dir().join(format!(
            "civ7-spill-test-{}",
            now_millis()
        ));
        fs::create_dir_all(&directory).expect("mkdir");
        let path = directory.join("result.json");
        fs::write(
            &path,
            r#"{"fingerprint":"abc","actions":[{"operation":"add","path":"a.xml","items":[]}]}"#,
        )
        .expect("write");
        let mut payload = Map::from_iter([
            ("spilled".into(), Value::Bool(true)),
            (
                "resultPath".into(),
                Value::String(path.to_string_lossy().into_owned()),
            ),
            ("fingerprint".into(), Value::String("stale".into())),
        ]);
        hydrate_spilled_result_payload(&mut payload, &[std::env::temp_dir()])
            .expect("hydrate");
        assert_eq!(payload["fingerprint"], "abc");
        assert!(payload.get("actions").and_then(Value::as_array).is_some());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn compact_report_strips_heavy_collections() {
        let mut payload = Map::from_iter([
            (
                "detail".into(),
                Value::Object(Map::from_iter([(
                    "actions".into(),
                    Value::Array(vec![Value::String("x".into())]),
                )])),
            ),
            (
                "actions".into(),
                Value::Array(vec![Value::String("x".into())]),
            ),
            ("fingerprint".into(), Value::String("abc".into())),
        ]);
        compact_report_event_payload(&mut payload);
        assert!(payload.get("actions").is_none());
        assert_eq!(payload["fingerprint"], "abc");
        assert!(payload["detail"]
            .as_object()
            .expect("detail")
            .get("actions")
            .is_none());
    }
}
