use crate::{
    credentials,
    models::{
        now_iso, now_millis, valid_key_id, ActiveJob, ActiveJobStatus, ApiKeyMeta, AppConfig,
        CachePathInput, CommandError, CommandResult, DeployChange, DeployChangeKind,
        EngineEventEnvelope, EngineRequest, FrontendAppState, FrontendEventType, GlossaryPayload,
        GlossarySaveResult, InspectDiff, InspectDiffStatus, InspectInventoryStats, InspectSnapshot,
        InspectTagDelta, JobEventEnvelope, JobMode, JobStartResponse, KeyStatus, LegendBackup,
        LegendDedupeResult, LegendFileEntriesPage, LegendFileEntry, LegendFileInspection,
        LegendLineEdit, LegendLineUpdateResult, LegendSearchMatch, LegendSearchResult,
        LegendGlossaryDocument,
        LegendGlossaryEntry,
        LegendJobEvent, LegendJobEventType,         LegendPreviewDiffsPage, LegendPreviewEdit, LegendPreviewLineRef, LegendQaIssue, LegendQaReport,
        LegendPreviewSummary,
        LegendTermSuggestion, LegendTranslationApplyResult, LegendTranslationDiff,
        LegendTranslationEstimate, LegendRuleStat,
        LegendTranslationPreview, LegendTranslationStats, PathConfigInput, PathValidation, QaIssue,
        QaSeverity, Report, StepId, StepStatus, SyncChange, SyncChangeKind, TagListResult,
        TagSearchResult, TagUpdateResult, ReplaceTagsResult, TranslationCacheClearResult, TranslationCacheInfo,
        MAX_DEPLOY_CHANGES_UI, MAX_EVENT_LINE_BYTES, MAX_INSPECT_DIFFS_UI,
        MAX_SPILLED_RESULT_BYTES, MAX_SYNC_CHANGES_UI, APP_DISPLAY_NAME, PROTOCOL_VERSION,
    },
    process_tree::{soft_cancel, JobObject},
    protocol::ProtocolValidator,
    storage::{
        backup_directory, clear_reports as clear_report_files, create_pre_restore_safety_backup,
        delete_backup as remove_backup_entry, list_backup_files as read_backup_manifest_files,
        refresh_artifacts, refresh_backups, report_directory, restore_backup_manifest, step_title,
        write_bytes_atomic, write_json_atomic, write_report, write_report_text, DeployPreview,
        LegendPreviewMetadata,
        PersistedData, PersistenceStore, SyncPreview,
    },
    tool_paths,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
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
use zeroize::{Zeroize, Zeroizing};

const SIDECAR_NAME: &str = "localization-engine";
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
    starting_job: Arc<Mutex<Option<StartingJob>>>,
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

struct StartingJob {
    job_id: String,
    cancel_requested: Arc<AtomicBool>,
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
            starting_job: Arc::new(Mutex::new(None)),
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

    fn starting_job(&self) -> CommandResult<MutexGuard<'_, Option<StartingJob>>> {
        self.starting_job.lock().map_err(|_| {
            CommandError::new("starting_job_lock_poisoned", "Starting job lock bị lỗi")
        })
    }

    fn save_snapshot(&self) -> CommandResult<()> {
        let snapshot = self.data().map_err(|error| error)?.clone();
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

    fn should_run_progress_action(slot: &Arc<Mutex<Option<Instant>>>, interval: Duration) -> bool {
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

    pub fn shutdown(&self) -> CommandResult<()> {
        let mut running = self.process.lock().map_err(|_| {
            CommandError::new(
                "sidecar_shutdown_failed",
                "Không tắt được engine dịch (process lock).",
            )
        })?;
        if let Some(process) = running.as_mut() {
            if let Some(job) = process.job_object.as_ref() {
                job.terminate();
            }
            if let Ok(mut child) = process.child.lock() {
                let _ = child.kill();
            }
        }
        running.take();
        drop(running);

        let mut starting = self.starting_job.lock().map_err(|_| {
            CommandError::new(
                "sidecar_shutdown_failed",
                "Không tắt được engine dịch (starting lock).",
            )
        })?;
        starting.take();
        self.job_gate.store(false, Ordering::Release);
        Ok(())
    }
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, AppState>) -> CommandResult<FrontendAppState> {
    let state = (*state).clone();
    spawn_command(move || get_app_state_sync(&state)).await
}

fn get_app_state_sync(state: &AppState) -> CommandResult<FrontendAppState> {
    let mut data = state.data()?;
    trim_deploy_changes_for_ui(&mut data);
    data.app.sanitize_timeline_events();
    data.app.normalize_gates();
    publish_gate_flags(&mut data);
    enforce_internal_gates(&mut data);
    Ok(data.app.clone())
}

#[tauri::command]
pub async fn save_app_config(
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
    let state = (*state).clone();
    spawn_command(move || save_app_config_sync(&state, config)).await
}

fn save_app_config_sync(state: &AppState, config: AppConfig) -> CommandResult<FrontendAppState> {
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
        return start_engine_job(&app, &state, StepId::Deploy, "deploy-apply", false, None);
    }
    let command = step.engine_command(mode)?;
    start_engine_job(&app, &state, step, command, mode == JobMode::DryRun, None)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_job(job_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    let running = {
        let process = state.process()?;
        match process.as_ref() {
            Some(running) if running.job_id != job_id => {
                return Err(CommandError::new(
                    "job_id_mismatch",
                    "jobId không khớp job đang chạy",
                ));
            }
            Some(running) => {
                running.cancel_requested.store(true, Ordering::Release);
                Some((
                    running.process_id,
                    Arc::clone(&running.child),
                    Arc::clone(&running.cancel_requested),
                ))
            }
            None => None,
        }
    };
    let Some((process_id, child, requested)) = running else {
        if request_starting_job_cancel(&state, &job_id)? {
            return Ok(());
        }
        return Err(CommandError::new("no_active_job", "Không có job đang chạy"));
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

fn request_starting_job_cancel(state: &AppState, job_id: &str) -> CommandResult<bool> {
    let starting = state.starting_job()?;
    let Some(pending) = starting.as_ref() else {
        return Ok(false);
    };
    if pending.job_id != job_id {
        return Err(CommandError::new(
            "job_id_mismatch",
            "jobId không khớp job đang khởi động",
        ));
    }
    pending.cancel_requested.store(true, Ordering::Release);
    Ok(true)
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
pub async fn clear_reports(state: State<'_, AppState>) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    let state = (*state).clone();
    spawn_command(move || clear_reports_sync(&state)).await
}

fn clear_reports_sync(state: &AppState) -> CommandResult<FrontendAppState> {
    {
        let mut data = state.data()?;
        let directory = report_directory(&state.app_data_dir, &data.app);
        clear_report_files(&mut data, &directory)?;
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn clear_job_events(
    step: StepId,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    let state = (*state).clone();
    spawn_command(move || clear_job_events_sync(&state, step)).await
}

fn clear_job_events_sync(state: &AppState, step: StepId) -> CommandResult<FrontendAppState> {
    {
        let mut data = state.data()?;
        data.app.events.retain(|event| event.step != step);
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_translation_cache_info(
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
    spawn_command(move || Ok(read_translation_cache_info(&path))).await
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
pub async fn clear_translation_cache(
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
    spawn_command(move || {
        let before = read_translation_cache_info(&path);
        ensure_translation_cache_parent(&path)?;
        fs::write(&path, "{}\n").map_err(|error| CommandError::io("Xóa cache dịch", error))?;
        Ok(TranslationCacheClearResult {
            path: path.to_string_lossy().into_owned(),
            cleared_entries: before.entries,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_glossary(
    glossary_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<GlossaryPayload> {
    let path = resolve_glossary_path(&state, glossary_path)?;
    spawn_command(move || {
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
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_glossary(
    entries: BTreeMap<String, String>,
    glossary_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<GlossarySaveResult> {
    reject_while_running(&state)?;
    let path = allowed_glossary_write_path(&state, &resolve_glossary_path(&state, glossary_path)?)?;
    validate_glossary_entries(&entries)?;
    spawn_command(move || {
        let json_entries: Map<String, Value> = entries
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect();
        write_json_atomic(&path, &Value::Object(json_entries))?;
        Ok(GlossarySaveResult {
            path: path.to_string_lossy().into_owned(),
            entries: entries.len() as u64,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn search_tags(
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
        let mut config = data.app.config.engine_config(&backup_root, false, None);
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
        object.insert("wholeWord".into(), Value::Bool(whole_word.unwrap_or(false)));
        (config, data.app.config.clone())
    };
    let state = (*state).clone();
    spawn_command(move || {
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
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_tags(
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
        let mut config = data.app.config.engine_config(&backup_root, false, None);
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
    let state = (*state).clone();
    spawn_command(move || {
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
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_tag(
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
        let mut config = data.app.config.engine_config(&backup_root, false, None);
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
    let state = (*state).clone();
    spawn_command(move || {
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
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn replace_tags(
    query: String,
    replacement: String,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<ReplaceTagsResult> {
    reject_while_running(&state)?;
    let (config, app_config) = {
        let data = state.data()?;
        if data.app.config.mod_path.as_os_str().is_empty() {
            return Err(CommandError::new(
                "replace_mod_path_missing",
                "Cần cấu hình modPath trước khi thay thế",
            ));
        }
        let backup_root = backup_directory(&state.app_data_dir);
        let mut config = data.app.config.engine_config(&backup_root, false, None);
        let object = config.as_object_mut().ok_or_else(|| {
            CommandError::new("replace_config_invalid", "Không tạo được config engine")
        })?;
        object.insert("query".into(), Value::String(query));
        object.insert("replacement".into(), Value::String(replacement));
        object.insert(
            "caseSensitive".into(),
            Value::Bool(case_sensitive.unwrap_or(false)),
        );
        object.insert("wholeWord".into(), Value::Bool(whole_word.unwrap_or(false)));
        (config, data.app.config.clone())
    };
    let state = (*state).clone();
    spawn_command(move || {
        let payload = run_engine_sync(
            &app,
            &state,
            "replace-tags",
            &config,
            &app_config,
            &[],
            900,
            false,
        )?;
        serde_json::from_value(Value::Object(payload)).map_err(|error| {
            CommandError::new(
                "replace_result_invalid",
                format!("Engine trả về kết quả thay thế không hợp lệ: {error}"),
            )
        })
    })
    .await
}

#[tauri::command]
pub fn open_file(path: String, app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let path = PathBuf::from(path);
    let allowed = allowed_open_path(&state, &path)?;
    open_path(&app, &allowed)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn restore_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    if backup_id.starts_with("legend:") {
        return Err(CommandError::new(
            "backup_product_mismatch",
            "Backup Legend chỉ khôi phục từ Lịch sử & hoàn tác",
        ));
    }
    let state = (*state).clone();
    spawn_command(move || restore_backup_sync(&state, &backup_id)).await
}

fn restore_backup_sync(state: &AppState, backup_id: &str) -> CommandResult<FrontendAppState> {
    let (backup, target, backup_root) = {
        let data = state.data()?;
        let backup = data
            .backup_paths
            .get(backup_id)
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
pub async fn list_backup_files(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    let backup = state
        .data()?
        .backup_paths
        .get(&backup_id)
        .cloned()
        .ok_or_else(|| CommandError::new("backup_not_found", "Không tìm thấy backup"))?;
    let is_legend = backup_id.starts_with("legend:");
    spawn_command(move || {
        if is_legend {
            let manifest: Value = serde_json::from_slice(
                &fs::read(backup.join("manifest.json"))
                    .map_err(|error| CommandError::io("Đọc manifest backup Legend", error))?,
            )
            .map_err(|error| CommandError::new("invalid_backup", error.to_string()))?;
            Ok(manifest
                .get("backupFile")
                .and_then(Value::as_str)
                .map(|path| vec![tool_paths::simplify_windows_path_text(path)])
                .unwrap_or_default())
        } else {
            read_backup_manifest_files(&backup)
        }
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<FrontendAppState> {
    reject_while_running(&state)?;
    if backup_id.starts_with("legend:") {
        return Err(CommandError::new(
            "backup_product_mismatch",
            "Backup Legend chỉ xóa từ Lịch sử & hoàn tác",
        ));
    }
    let state = (*state).clone();
    spawn_command(move || delete_backup_sync(&state, &backup_id)).await
}

fn delete_backup_sync(state: &AppState, backup_id: &str) -> CommandResult<FrontendAppState> {
    {
        let mut data = state.data()?;
        let backup_root = backup_directory(&state.app_data_dir);
        remove_backup_entry(&mut data, backup_id, &backup_root)?;
    }
    state.save_snapshot()?;
    Ok(state.data()?.app.clone())
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
pub async fn test_api_key(
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
    let state = (*state).clone();
    let key_id_for_sync = key_id.clone();
    spawn_command(move || {
        let valid = run_api_key_validation(&app, &state, &secret)?;
        secret.zeroize();
        let updated = {
            let mut data = state.data()?;
            let key = find_key_mut(&mut data.app.api_keys, &key_id_for_sync)?;
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
    })
    .await
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
        let finished = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        if timeout_secs > 0 {
            let watchdog_child = Arc::clone(&child);
            let watchdog_finished = Arc::clone(&finished);
            let watchdog_timed_out = Arc::clone(&timed_out);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(timeout_secs));
                if !watchdog_finished.load(Ordering::Acquire) {
                    watchdog_timed_out.store(true, Ordering::Release);
                    if let Ok(mut child) = watchdog_child.lock() {
                        let _ = child.kill();
                    }
                }
            });
        }
        let spill_roots = spill_allowed_roots(state, app_config);
        let mut validator = ProtocolValidator::new(&job_id);
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut result_payload: Option<Map<String, Value>> = None;
        let mut last_error: Option<(String, String)> = None;
        while read_bounded_line(&mut reader, &mut line)
            .map_err(|error| CommandError::io("Đọc kết quả engine sync", error))?
        {
            let event = validator.parse_line(&line)?;
            if !engine_event_step_matches(command, &event.step) {
                return Err(CommandError::new(
                    "protocol_step_mismatch",
                    format!("Engine event thuộc '{}', mong đợi '{command}'", event.step),
                ));
            }
            if command.starts_with("legend-")
                && !matches!(
                    event.event_type.as_str(),
                    "result" | "error" | "completed"
                )
            {
                let mut adapted = adapt_legend_event(&event);
                adapted
                    .payload
                    .insert("command".into(), Value::String(command.to_owned()));
                let _ = app.emit("legend-job-event", &adapted);
            } else if event.event_type == "progress" {
                let progress_event = Map::from_iter([
                    ("command".into(), Value::String(command.to_owned())),
                    ("step".into(), Value::String(event.step.clone())),
                    (
                        "payload".into(),
                        Value::Object(event.payload.clone()),
                    ),
                ]);
                let _ = app.emit("sync-progress", &progress_event);
            }
            if event.event_type == "result" {
                let mut payload = event.payload;
                // Retranslate đọc preview trên disk; không hydrate diffs khổng lồ.
                if command != "legend-retranslate" {
                    hydrate_spilled_result_payload(&mut payload, &spill_roots)?;
                }
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
                let message = match message {
                    Some(message) if code == "INVALID_COMMAND" => format!(
                        "{message}. Sidecar có thể đã cũ — chạy `npm run build:engine` rồi khởi động lại app."
                    ),
                    Some(message) => message,
                    None => format!("Engine báo lỗi ({code})"),
                };
                last_error = Some((code.to_ascii_lowercase(), message));
            }
        }
        finished.store(true, Ordering::Release);
        if let Ok(mut child) = child.lock() {
            let _ = child.wait();
        }
        drop(job_object);
        if let Some(payload) = result_payload {
            if command.starts_with("legend-") {
                notify_legend_sync_outcome(
                    app,
                    state,
                    command,
                    TerminalNotifyKind::Completed,
                    &format!("Hoàn tất {}.", legend_sync_command_label(command)),
                );
            }
            return Ok(payload);
        }
        if let Some((code, message)) = last_error {
            if command.starts_with("legend-") {
                let kind = if code == "cancelled" {
                    TerminalNotifyKind::Paused
                } else {
                    TerminalNotifyKind::Failed
                };
                notify_legend_sync_outcome(app, state, command, kind, &message);
            }
            return Err(CommandError::new(code, message));
        }
        if timed_out.load(Ordering::Acquire) {
            if command.starts_with("legend-") {
                notify_legend_sync_outcome(
                    app,
                    state,
                    command,
                    TerminalNotifyKind::Failed,
                    &format!(
                        "Engine hết thời gian chờ sau {timeout_secs}s khi chạy {}.",
                        legend_sync_command_label(command)
                    ),
                );
            }
            return Err(CommandError::new(
                "engine_timeout",
                format!(
                    "Engine hết thời gian chờ sau {timeout_secs}s khi chạy {command}."
                ),
            ));
        }
        if command.starts_with("legend-") {
            notify_legend_sync_outcome(
                app,
                state,
                command,
                TerminalNotifyKind::Failed,
                &format!(
                    "Engine không trả về kết quả khi chạy {}.",
                    legend_sync_command_label(command)
                ),
            );
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

async fn spawn_command<T, F>(operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| {
            CommandError::new(
                "join_failed",
                format!("Không hoàn tất tác vụ nền: {error}"),
            )
        })?
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
            emit_synthetic_failure(&app, &state, step, &thread_job_id, 1, error.message);
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
        let keys: Vec<_> = data.app.api_keys.iter().filter(|key| key.enabled).collect();
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
            workers: None,
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
            emit_synthetic_failure(&app, &state, step, &thread_job_id, 1, error.message);
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
                if let Err(error) =
                    apply_engine_event(&app, &state, &thread_command, &raw, event, started_at)
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
        let _ = apply_frontend_event(&app, &state, &thread_command, None, event, started_at);
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

fn engine_event_step_matches(command: &str, event_step: &str) -> bool {
    event_step == command
        || matches!(
            (command, event_step),
            ("legend-inspect", "inspect")
                | ("legend-list-entries", "inspect")
                | ("legend-sync-staged", "inspect")
                | ("legend-translate", "translate")
                | ("legend-estimate", "translate")
                | ("legend-rebuild", "translate")
                | ("legend-retranslate", "translate")
                | ("legend-apply", "sync-apply")
                | ("legend-restore", "restore")
        )
}

fn spill_allowed_roots(state: &AppState, config: &AppConfig) -> Vec<PathBuf> {
    let mut roots = vec![
        state.app_data_dir.clone(),
        std::env::temp_dir(),
        config.export_path.clone(),
        config.mod_path.clone(),
        config.report_path.clone(),
    ];
    if let Ok(data) = state.data() {
        if let Some(source_path) = data.legend_source_path.as_ref() {
            roots.push(source_path.clone());
        }
        if let Some(preview) = data.legend_preview.as_ref() {
            roots.push(preview.preview_path.clone());
        }
    }
    roots.push(legend_root(state));
    roots.push(legend_backup_directory(state));
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
    let metadata = fs::metadata(&path)
        .map_err(|error| CommandError::io("Đọc metadata result spilled", error))?;
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
    let text =
        fs::read_to_string(&path).map_err(|error| CommandError::io("Đọc result spilled", error))?;
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
            let switch_kind = payload
                .get("switchKind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if switch_kind == "spare" {
                let from_key = payload
                    .get("fromKeyIndex")
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "?".into());
                (
                    format!("Key {from_key} hết quota ngày · chuyển sang Key {key_index}"),
                    format!("{reason} · {model}"),
                )
            } else if switch_kind == "model" {
                (
                    "Đổi model trên cùng API key".into(),
                    format!("{reason} · Key {key_index}/{key_count} · {model}"),
                )
            } else {
                (
                    "Đổi model hoặc API key".into(),
                    format!("{reason} · Key {key_index}/{key_count} · {model}"),
                )
            }
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
            let key_index = payload
                .get("keyIndex")
                .and_then(Value::as_u64)
                .map(|value| value.to_string());
            let key_count = payload
                .get("keyCount")
                .and_then(Value::as_u64)
                .map(|value| value.to_string());
            let key_part = match (key_index, key_count) {
                (Some(index), Some(count)) => format!(" · Key {index}/{count}"),
                (Some(index), None) => format!(" · Key {index}"),
                _ => String::new(),
            };
            (
                "Đang thử lại API".into(),
                format!("Lần {attempt} · chờ {wait} giây{key_part}"),
            )
        }
        "item-fallback" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("?");
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
                        .filter_map(|(key, value)| Some(format!("{key}: {}", value.as_u64()?)))
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
        if let Some(item_progress) = payload.get("itemProgress").and_then(Value::as_f64) {
            payload.insert("batchProgress".into(), Value::from(item_progress.round()));
        } else if let (Some(batch), Some(total)) = (
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
        }
        // Parallel workers: do not demote other Active keys to Valid.
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
    if let Some(workers) = payload.get("workers").and_then(Value::as_u64) {
        active.workers = Some(workers);
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
                // Parallel: mọi key vừa xong batch đều Active (không demote key khác).
                apply_translate_key_active(data, key_id);
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
            "{APP_DISPLAY_NAME} — Báo cáo\nID: {report_id}\nBước: {}\nThời gian: {}\nTóm tắt: {summary}\n",
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
            r#type: item.get("type").and_then(Value::as_str).map(str::to_owned),
            tag: item.get("tag").and_then(Value::as_str).map(str::to_owned),
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
    let vietnamese = inspect_inventory_stats(payload.get("vietnamese").and_then(Value::as_object));
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
                        entry.get("missingInVietnamese").and_then(Value::as_array),
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
                let text = item.get("text").and_then(Value::as_str).map(str::to_owned);
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
    data.app
        .deploy_changes
        .retain(|change| !matches!(change.kind, DeployChangeKind::Unchanged));
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
            summary.get("copied").and_then(Value::as_u64).unwrap_or(0)
                + summary.get("created").and_then(Value::as_u64).unwrap_or(0)
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

fn step_status_after_completion(
    payload_warning: bool,
    summary_warnings: Option<u64>,
) -> StepStatus {
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
        "deploy-preview" | "deploy-apply" => {
            format!("{} file sẽ ghi", deploy_change_count(payload).unwrap_or(0))
        }
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

fn notification_message_from_payload(payload: &Map<String, Value>, fallback: &str) -> String {
    payload
        .get("message")
        .or_else(|| payload.get("title"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalNotifyKind {
    Completed,
    Paused,
    Failed,
}

fn notify_terminal_event(
    app: &AppHandle,
    state: &AppState,
    kind: TerminalNotifyKind,
    message: &str,
) {
    let Ok(data) = state.data() else {
        return;
    };
    let config = &data.app.config.notifications;
    if !config.enabled {
        return;
    }
    let allowed = match kind {
        TerminalNotifyKind::Completed => config.completed,
        TerminalNotifyKind::Paused => config.paused,
        TerminalNotifyKind::Failed => config.failed,
    };
    if !allowed {
        return;
    }
    if let Err(error) = app
        .notification()
        .builder()
        .title(APP_DISPLAY_NAME)
        .body(message)
        .show()
    {
        #[cfg(debug_assertions)]
        eprintln!("[notification] failed to show: {error}");
    }
}

fn maybe_notify(app: &AppHandle, state: &AppState, event: &JobEventEnvelope) {
    let kind = match event.event_type {
        FrontendEventType::Completed => Some(TerminalNotifyKind::Completed),
        FrontendEventType::Paused => Some(TerminalNotifyKind::Paused),
        FrontendEventType::Failed => Some(TerminalNotifyKind::Failed),
        _ => None,
    };
    let Some(kind) = kind else {
        return;
    };
    let message = notification_message_from_payload(&event.payload, event.event_type.as_str());
    notify_terminal_event(app, state, kind, &message);
}

fn maybe_notify_legend(app: &AppHandle, state: &AppState, event: &LegendJobEvent) {
    let kind = match event.event_type {
        LegendJobEventType::Completed => Some(TerminalNotifyKind::Completed),
        LegendJobEventType::Paused => Some(TerminalNotifyKind::Paused),
        LegendJobEventType::Failed => Some(TerminalNotifyKind::Failed),
        _ => None,
    };
    let Some(kind) = kind else {
        return;
    };
    let fallback = match event.event_type {
        LegendJobEventType::Completed => "completed",
        LegendJobEventType::Paused => "paused",
        LegendJobEventType::Failed => "failed",
        _ => "legend",
    };
    let message = notification_message_from_payload(&event.payload, fallback);
    notify_terminal_event(app, state, kind, &message);
}

fn legend_sync_command_label(command: &str) -> &str {
    match command {
        "legend-inspect" => "Inspect Legend",
        "legend-translate" => "Dịch Legend",
        "legend-retranslate" => "Dịch lại Legend",
        "legend-dedupe" => "Dedupe Legend",
        "legend-update-lines" => "Cập nhật dòng Legend",
        _ => "Legend",
    }
}

fn notify_legend_sync_outcome(
    app: &AppHandle,
    state: &AppState,
    command: &str,
    kind: TerminalNotifyKind,
    message: &str,
) {
    if !command.starts_with("legend-") {
        return;
    }
    notify_terminal_event(app, state, kind, message);
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
    if let Some(path) = std::env::var_os("LOCALIZATION_ENGINE_PATH") {
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
            map.keys().filter(|key| *key != "version").count() as u64
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
    if !allowed {
        if let Some(source_path) = data.legend_source_path.as_ref() {
            allowed = source_path
                .canonicalize()
                .ok()
                .is_some_and(|source| canonical == source);
        }
    }
    if !allowed {
        let root = legend_root(state);
        allowed = root
            .canonicalize()
            .ok()
            .is_some_and(|root| canonical == root || canonical.starts_with(root));
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

const LEGEND_DIRECTORY: &str = "legend";
const LEGEND_CACHE_FILENAME: &str = "translation-cache.json";

fn legend_root(state: &AppState) -> PathBuf {
    state.app_data_dir.join(LEGEND_DIRECTORY)
}

fn legend_preview_directory(state: &AppState) -> PathBuf {
    legend_root(state).join("previews")
}

fn legend_trial_directory(state: &AppState) -> PathBuf {
    legend_root(state).join("trials")
}

fn legend_preview_trusted_root(state: &AppState, trial: bool) -> PathBuf {
    if trial {
        legend_trial_directory(state)
    } else {
        legend_preview_directory(state)
    }
}

fn legend_glossary_path(state: &AppState) -> PathBuf {
    state
        .data()
        .ok()
        .and_then(|data| data.legend_glossary_path.clone())
        .unwrap_or_else(|| legend_root(state).join("glossary.json"))
}

fn legend_backup_directory(state: &AppState) -> PathBuf {
    legend_root(state).join("backups")
}

fn ensure_legend_directories(state: &AppState) -> CommandResult<()> {
    for directory in [
        legend_root(state).join("staging"),
        legend_preview_directory(state),
        legend_root(state).join("cache"),
        legend_backup_directory(state),
    ] {
        fs::create_dir_all(&directory)
            .map_err(|error| CommandError::io("Tạo thư mục Legend trong AppData", error))?;
    }
    let glossary = legend_root(state).join("glossary.json");
    if !glossary.exists() {
        write_json_atomic(
            &glossary,
            &serde_json::json!({
                "version": 2,
                "profileId": "legend-three-kingdoms-zh-vi-v1",
                "entries": [],
            }),
        )?;
    }
    Ok(())
}

fn validate_legend_source(source_path: &Path) -> CommandResult<PathBuf> {
    if source_path.as_os_str().is_empty()
        || !source_path.is_absolute()
        || source_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || source_path.to_string_lossy().contains('\0')
    {
        return Err(CommandError::new(
            "legend_source_invalid",
            "sourcePath Legend phải là đường dẫn file tuyệt đối hợp lệ",
        ));
    }
    let canonical = source_path
        .canonicalize()
        .map_err(|error| CommandError::io("Mở sourcePath Legend", error))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| CommandError::io("Đọc sourcePath Legend", error))?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            "legend_source_invalid",
            "sourcePath Legend không phải file",
        ));
    }
    Ok(tool_paths::simplify_windows_path(&canonical))
}

fn validate_legend_deploy_path(deploy_path: &Path) -> CommandResult<PathBuf> {
    if deploy_path.as_os_str().is_empty()
        || !deploy_path.is_absolute()
        || deploy_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || deploy_path.to_string_lossy().contains('\0')
    {
        return Err(CommandError::new(
            "legend_deploy_invalid",
            "deployPath Legend phải là thư mục tuyệt đối hợp lệ",
        ));
    }
    let canonical = deploy_path
        .canonicalize()
        .map_err(|error| CommandError::io("Mở deployPath Legend", error))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| CommandError::io("Đọc deployPath Legend", error))?;
    if !metadata.is_dir() {
        return Err(CommandError::new(
            "legend_deploy_invalid",
            "deployPath Legend không phải thư mục",
        ));
    }
    Ok(tool_paths::simplify_windows_path(&canonical))
}

fn legend_inspect_config(source_path: &Path) -> Value {
    serde_json::json!({
        "sourcePath": source_path.to_string_lossy(),
        "sampleSize": 20,
    })
}

fn legend_list_entries_config(
    source_path: &Path,
    offset: u64,
    limit: u64,
    kind: &str,
) -> Value {
    serde_json::json!({
        "sourcePath": source_path.to_string_lossy(),
        "offset": offset,
        "limit": limit,
        "kind": kind,
    })
}

fn legend_translate_config(
    source_path: &Path,
    preview_path: &Path,
    cache_path: &Path,
    glossary_path: &Path,
    config: &AppConfig,
    mode: &str,
    trial_limit: u64,
    force_retranslate: bool,
) -> Value {
    serde_json::json!({
        "sourcePath": source_path.to_string_lossy(),
        "previewPath": preview_path.to_string_lossy(),
        "cachePath": cache_path.to_string_lossy(),
        "glossaryPath": glossary_path.to_string_lossy(),
        "mode": mode,
        "trialLimit": trial_limit,
        "forceRetranslate": force_retranslate,
        "model": config.model,
        "fallbackModels": config.fallback_models,
        "delaySeconds": config.delay_ms as f64 / 1000.0,
        "timeoutSeconds": config.timeout_seconds,
        "batchSize": config.batch_size,
        "maxApiCalls": config.max_api_calls,
    })
}

fn legend_apply_config(
    source_path: &Path,
    preview_path: &Path,
    backup_dir: &Path,
    preview_id: &str,
    glossary_path: &Path,
    deploy_path: Option<&Path>,
) -> Value {
    let mut config = serde_json::json!({
        "sourcePath": source_path.to_string_lossy(),
        "previewPath": preview_path.to_string_lossy(),
        "backupDir": backup_dir.to_string_lossy(),
        "previewId": preview_id,
        "glossaryPath": glossary_path.to_string_lossy(),
    });
    if let Some(deploy_path) = deploy_path {
        config["deployPath"] = Value::String(deploy_path.to_string_lossy().into_owned());
    }
    config
}

fn legend_sync_staged_config(preview_path: &Path, preview_id: &str) -> Value {
    serde_json::json!({
        "previewPath": preview_path.to_string_lossy(),
        "previewId": preview_id,
    })
}

fn legend_rebuild_config(
    preview_path: &Path,
    glossary_path: &Path,
    preview_id: &str,
    edits: &[LegendPreviewEdit],
) -> Value {
    serde_json::json!({
        "previewPath": preview_path.to_string_lossy(),
        "glossaryPath": glossary_path.to_string_lossy(),
        "previewId": preview_id,
        "edits": edits,
    })
}

const LEGEND_RETRANSLATE_BATCH_CAP: u32 = 15;
/// 0 = không cắt cả process; mỗi lệnh Gemini vẫn dùng timeoutSeconds.
const LEGEND_RETRANSLATE_PROCESS_TIMEOUT_SECS: u64 = 0;

fn legend_retranslate_batch_size(config: &AppConfig) -> u32 {
    config.batch_size.max(1).min(LEGEND_RETRANSLATE_BATCH_CAP)
}

fn legend_retranslate_config(
    preview_path: &Path,
    cache_path: &Path,
    glossary_path: &Path,
    preview_id: &str,
    line_numbers: &[u64],
    config: &AppConfig,
) -> Value {
    serde_json::json!({
        "previewPath": preview_path.to_string_lossy(),
        "cachePath": cache_path.to_string_lossy(),
        "glossaryPath": glossary_path.to_string_lossy(),
        "previewId": preview_id,
        "lineNumbers": line_numbers,
        "model": config.model,
        "fallbackModels": config.fallback_models,
        "delaySeconds": config.delay_ms as f64 / 1000.0,
        "timeoutSeconds": config.timeout_seconds,
        "batchSize": legend_retranslate_batch_size(config),
        "maxApiCalls": config.max_api_calls,
    })
}

fn legend_estimate_config(
    source_path: &Path,
    cache_path: &Path,
    glossary_path: &Path,
    config: &AppConfig,
    mode: &str,
    trial_limit: u64,
    force_retranslate: bool,
) -> Value {
    serde_json::json!({
        "sourcePath": source_path.to_string_lossy(),
        "cachePath": cache_path.to_string_lossy(),
        "glossaryPath": glossary_path.to_string_lossy(),
        "model": config.model,
        "fallbackModels": config.fallback_models,
        "timeoutSeconds": config.timeout_seconds,
        "batchSize": config.batch_size,
        "mode": mode,
        "trialLimit": trial_limit,
        "forceRetranslate": force_retranslate,
    })
}

fn legend_restore_config(backup_path: &Path, expected_source_path: &Path, force: bool) -> Value {
    serde_json::json!({
        "backupPath": backup_path.to_string_lossy(),
        "expectedSourcePath": expected_source_path.to_string_lossy(),
        "force": force,
    })
}

fn legend_warning_messages(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|warning| match warning {
            Value::String(message) => Some(message.clone()),
            Value::Object(object) => object
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn parse_legend_rule_stats(value: Option<&Value>) -> Vec<LegendRuleStat> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|item| {
            Some(LegendRuleStat {
                rule: item.get("rule")?.as_str()?.to_owned(),
                count: item.get("count").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

fn parse_legend_translation_stats(stats: Option<&Value>) -> LegendTranslationStats {
    LegendTranslationStats {
        items_total: stats
            .and_then(|value| {
                value
                    .get("itemsTotal")
                    .or_else(|| value.get("uniqueSources"))
            })
            .and_then(Value::as_u64)
            .unwrap_or(0),
        items_translated: stats
            .and_then(|value| value.get("itemsTranslated"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_hits: stats
            .and_then(|value| value.get("cacheHits"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        api_calls: stats
            .and_then(|value| value.get("apiCalls"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        keys_used: stats
            .and_then(|value| value.get("keysUsed"))
            .and_then(Value::as_u64),
        model_switches: stats
            .and_then(|value| value.get("modelSwitches"))
            .and_then(Value::as_u64),
        qa_passed_first_pass: stats
            .and_then(|value| value.get("qaPassedFirstPass"))
            .and_then(Value::as_bool),
        qa_blocking_count: stats
            .and_then(|value| value.get("qaBlockingCount"))
            .and_then(Value::as_u64),
        qa_issue_count: stats
            .and_then(|value| value.get("qaIssueCount"))
            .and_then(Value::as_u64),
        retry_passes_used: stats
            .and_then(|value| value.get("retryPassesUsed"))
            .and_then(Value::as_u64),
        retranslated_sources: stats
            .and_then(|value| value.get("retranslatedSources"))
            .and_then(Value::as_u64),
        top_failed_rules: parse_legend_rule_stats(stats.and_then(|value| value.get("topFailedRules"))),
        top_issue_rules: parse_legend_rule_stats(stats.and_then(|value| value.get("topIssueRules"))),
    }
}

fn parse_legend_entries_page(
    payload: &Map<String, Value>,
    source_path: &Path,
) -> CommandResult<LegendFileEntriesPage> {
    let entries = payload
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|entry| LegendFileEntry {
            line_number: entry
                .get("lineNumber")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            source: entry
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            current_target: entry
                .get("currentTarget")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            kind: entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("entry")
                .to_owned(),
            warning: entry
                .get("warning")
                .and_then(Value::as_str)
                .map(str::to_owned),
            occurrence: entry.get("occurrence").and_then(Value::as_u64),
        })
        .collect();
    Ok(LegendFileEntriesPage {
        source_path: source_path.to_string_lossy().into_owned(),
        offset: payload.get("offset").and_then(Value::as_u64).unwrap_or(0),
        limit: payload.get("limit").and_then(Value::as_u64).unwrap_or(100),
        total: payload.get("total").and_then(Value::as_u64).unwrap_or(0),
        entry_total: payload
            .get("entryTotal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        invalid_total: payload
            .get("invalidTotal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        duplicate_total: payload
            .get("duplicateTotal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        pending_total: payload
            .get("pendingTotal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        done_total: payload
            .get("doneTotal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        warning_reasons: payload
            .get("warningReasons")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        entries,
    })
}

fn parse_legend_inspection(
    payload: &Map<String, Value>,
    source_path: &Path,
) -> CommandResult<LegendFileInspection> {
    let inspection = payload
        .get("inspection")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CommandError::new(
                "legend_inspect_result_invalid",
                "Kết quả legend-inspect thiếu inspection",
            )
        })?;
    let endings: Vec<String> = inspection
        .get("lineEndings")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|items| items.iter())
        .filter(|(ending, count)| *ending != "none" && count.as_u64().unwrap_or(0) > 0)
        .map(|(ending, _)| ending.to_ascii_lowercase())
        .collect();
    let newline = match endings.as_slice() {
        [] => "unknown".to_owned(),
        [ending] => ending.clone(),
        _ => "mixed".to_owned(),
    };
    let sample = payload
        .get("sample")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|entry| LegendFileEntry {
            line_number: entry.get("line").and_then(Value::as_u64).unwrap_or(0),
            source: entry
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            current_target: entry
                .get("currentTarget")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            kind: "entry".into(),
            warning: None,
            occurrence: None,
        })
        .collect();
    let fingerprint = payload
        .get("fingerprint")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new(
                "legend_inspect_result_invalid",
                "Kết quả legend-inspect thiếu fingerprint",
            )
        })?;
    Ok(LegendFileInspection {
        source_path: source_path.to_string_lossy().into_owned(),
        fingerprint: fingerprint.to_owned(),
        total_lines: inspection.get("lines").and_then(Value::as_u64).unwrap_or(0),
        entry_count: inspection
            .get("entries")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        invalid_lines: inspection
            .get("invalidLines")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        duplicate_sources: inspection
            .get("duplicates")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        unique_source_count: inspection
            .get("uniqueSources")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        syntax_source_count: inspection
            .get("syntaxSources")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        pending_entries: inspection
            .get("pendingEntries")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        done_entries: inspection
            .get("doneEntries")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        done_items: inspection
            .get("doneItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reused_items: inspection
            .get("reusedItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        pending_items: inspection
            .get("pendingItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        encoding: inspection
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or("utf-8")
            .to_owned(),
        newline,
        has_bom: inspection
            .get("bom")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        sample,
        warnings: legend_warning_messages(payload.get("warnings")),
    })
}

fn legend_text_has_han(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}'))
}

fn legend_diff_effective_target(diff: &LegendTranslationDiff) -> &str {
    if !diff.selected {
        return diff.before.as_str();
    }
    if let Some(edited) = diff.edited_after.as_deref() {
        return edited;
    }
    if !diff.effective_target.is_empty() {
        return diff.effective_target.as_str();
    }
    diff.after.as_str()
}

fn parse_legend_diff(diff: &Map<String, Value>) -> LegendTranslationDiff {
    LegendTranslationDiff {
        line_number: diff
            .get("lineNumber")
            .or_else(|| diff.get("line"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        source: diff
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        before: diff
            .get("before")
            .or_else(|| diff.get("oldTarget"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        after: diff
            .get("after")
            .or_else(|| diff.get("target"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        effective_target: diff
            .get("effectiveTarget")
            .or_else(|| diff.get("target"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        effective_after: diff
            .get("effectiveAfter")
            .or_else(|| diff.get("effectiveTarget"))
            .or_else(|| diff.get("target"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        selected: diff
            .get("selected")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        edited_after: diff
            .get("editedAfter")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status: diff
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending")
            .to_owned(),
    }
}

fn parse_legend_qa_issue(issue: &Map<String, Value>) -> LegendQaIssue {
    LegendQaIssue {
        id: issue
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        severity: issue
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("warning")
            .to_owned(),
        rule: issue
            .get("rule")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line_number: issue.get("lineNumber").and_then(Value::as_u64).unwrap_or(0),
        source: issue
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        before: issue
            .get("before")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        after: issue
            .get("after")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        detail: issue
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        suggestions: issue
            .get("suggestions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter_map(|item| {
                Some(LegendTermSuggestion {
                    source: item.get("source")?.as_str()?.to_owned(),
                    reading: item.get("reading")?.as_str()?.to_owned(),
                    replace: item
                        .get("replace")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                })
            })
            .collect(),
    }
}

fn parse_legend_line_filter(raw: &str) -> Option<std::collections::HashSet<u64>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut wanted = std::collections::HashSet::new();
    for token in trimmed.split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';')) {
        let token = token
            .trim()
            .trim_start_matches(|ch: char| !ch.is_ascii_digit());
        if token.is_empty() {
            continue;
        }
        if let Some((start, end)) = token.split_once('-') {
            let Ok(start) = start.trim().parse::<u64>() else {
                continue;
            };
            let Ok(end) = end.trim().parse::<u64>() else {
                continue;
            };
            let (lo, hi) = if start <= end {
                (start, end)
            } else {
                (end, start)
            };
            if hi.saturating_sub(lo) > 20_000 {
                continue;
            }
            wanted.extend(lo..=hi);
            continue;
        }
        if let Ok(line) = token.parse::<u64>() {
            wanted.insert(line);
        }
    }
    if wanted.is_empty() {
        None
    } else {
        Some(wanted)
    }
}

fn parse_legend_preview(
    payload: &Map<String, Value>,
    source_path: &Path,
) -> CommandResult<LegendTranslationPreview> {
    parse_legend_preview_with_rows(payload, source_path, false)
}

fn parse_legend_preview_with_rows(
    payload: &Map<String, Value>,
    source_path: &Path,
    include_rows: bool,
) -> CommandResult<LegendTranslationPreview> {
    let preview_id = payload
        .get("previewId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| {
            CommandError::new(
                "legend_preview_result_invalid",
                "Kết quả legend-translate thiếu previewId hợp lệ",
            )
        })?;
    let source_fingerprint = payload
        .get("sourceFingerprint")
        .or_else(|| payload.get("fingerprint"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new(
                "legend_preview_result_invalid",
                "Kết quả legend-translate thiếu fingerprint",
            )
        })?;
    let qa_value = payload.get("qa").and_then(Value::as_object);
    let mut error_lines = std::collections::HashSet::new();
    let mut warning_lines = std::collections::HashSet::new();
    let mut file_issues = Vec::new();
    if let Some(issues) = qa_value
        .and_then(|qa| qa.get("issues"))
        .and_then(Value::as_array)
    {
        for issue in issues.iter().filter_map(Value::as_object) {
            let parsed = parse_legend_qa_issue(issue);
            if parsed.line_number == 0 {
                file_issues.push(parsed);
                continue;
            }
            if parsed.severity == "error" {
                error_lines.insert(parsed.line_number);
            } else {
                warning_lines.insert(parsed.line_number);
            }
            if include_rows {
                file_issues.push(parsed);
            }
        }
    }
    let mut diffs = Vec::new();
    let mut diff_count = 0u64;
    let mut selected_count = 0u64;
    let mut han_count = 0u64;
    if let Some(rows) = payload.get("diffs").and_then(Value::as_array) {
        for row in rows.iter().filter_map(Value::as_object) {
            let diff = parse_legend_diff(row);
            diff_count += 1;
            if diff.selected {
                selected_count += 1;
            }
            if legend_text_has_han(legend_diff_effective_target(&diff)) {
                han_count += 1;
            }
            if include_rows {
                diffs.push(diff);
            }
        }
    }
    let stats_value = payload.get("stats");
    let revision = payload.get("revision").and_then(Value::as_u64).unwrap_or(1);
    Ok(LegendTranslationPreview {
        preview_id: preview_id.to_owned(),
        source_path: source_path.to_string_lossy().into_owned(),
        source_fingerprint: source_fingerprint.to_owned(),
        created_at: payload
            .get("createdAt")
            .and_then(Value::as_str)
            .map_or_else(now_iso, str::to_owned),
        revision,
        mode: payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("full")
            .to_owned(),
        glossary_hash: payload
            .get("glossaryHash")
            .and_then(Value::as_str)
            .map(str::to_owned),
        qa_stale_reason: None,
        coverage_translated: payload
            .get("coverageTranslated")
            .and_then(Value::as_u64)
            .unwrap_or(diff_count),
        coverage_total: payload
            .get("coverageTotal")
            .and_then(Value::as_u64)
            .unwrap_or(diff_count),
        diffs,
        diff_count,
        selected_count,
        han_count,
        error_count: error_lines.len() as u64,
        warning_count: warning_lines.len() as u64,
        stats: parse_legend_translation_stats(stats_value),
        qa: LegendQaReport {
            passed: qa_value
                .and_then(|qa| qa.get("passed"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            blocking: qa_value
                .and_then(|qa| qa.get("blocking"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
            revision: qa_value
                .and_then(|qa| qa.get("revision"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            errors: qa_value
                .and_then(|qa| qa.get("errors"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            warnings: qa_value
                .and_then(|qa| qa.get("warnings"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            issues: file_issues,
        },
        warnings: legend_warning_messages(payload.get("warnings")),
    })
}

fn parse_legend_apply_result(
    payload: &Map<String, Value>,
    preview_id: &str,
    source_path: &Path,
) -> CommandResult<LegendTranslationApplyResult> {
    let returned_preview_id = payload
        .get("previewId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::new(
                "legend_apply_result_invalid",
                "Kết quả legend-apply thiếu previewId",
            )
        })?;
    if returned_preview_id != preview_id {
        return Err(CommandError::new(
            "legend_preview_stale",
            "Engine apply trả về previewId không khớp",
        ));
    }
    let backup_path = payload
        .get("backupPath")
        .or_else(|| payload.get("backup"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new(
                "legend_apply_result_invalid",
                "Kết quả legend-apply thiếu backupPath",
            )
        })?;
    let updated_lines = payload
        .get("updatedLines")
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .get("stats")
                .and_then(Value::as_object)
                .and_then(|stats| stats.get("changed"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    Ok(LegendTranslationApplyResult {
        preview_id: preview_id.to_owned(),
        source_path: source_path.to_string_lossy().into_owned(),
        backup_path: backup_path.to_owned(),
        updated_lines,
        deploy_path: payload
            .get("deployPath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        deploy_backup_path: payload
            .get("deployBackupPath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

fn legend_enabled_key_ids(data: &PersistedData) -> CommandResult<Vec<String>> {
    let mut keys = data.app.api_keys.clone();
    keys.sort_by_key(|key| key.priority);
    let ids: Vec<String> = keys
        .into_iter()
        .filter(|key| key.enabled)
        .map(|key| key.id)
        .collect();
    if ids.is_empty() {
        Err(CommandError::new(
            "api_key_required",
            "Dịch Legend cần ít nhất một API key đang bật",
        ))
    } else {
        Ok(ids)
    }
}

fn parse_legend_glossary(value: &Value, path: &Path) -> CommandResult<LegendGlossaryDocument> {
    let object = value.as_object().ok_or_else(|| {
        CommandError::new("legend_glossary_invalid", "Glossary phải là JSON object")
    })?;
    let entries = if let Some(rows) = object.get("entries").and_then(Value::as_array) {
        rows.iter()
            .map(|row| {
                let row = row.as_object().ok_or_else(|| {
                    CommandError::new(
                        "legend_glossary_invalid",
                        "Mỗi glossary entry phải là object",
                    )
                })?;
                let source = row
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                let target = row
                    .get("target")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if source.is_empty() || target.is_empty() {
                    return Err(CommandError::new(
                        "legend_glossary_invalid",
                        "Source/target glossary không được rỗng",
                    ));
                }
                Ok(LegendGlossaryEntry {
                    source,
                    target,
                    locked: row.get("locked").and_then(Value::as_bool).unwrap_or(false),
                    note: row
                        .get("note")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
            })
            .collect::<CommandResult<Vec<_>>>()?
    } else {
        object
            .iter()
            .filter(|(key, value)| {
                !matches!(key.as_str(), "version" | "profileId") && value.is_string()
            })
            .map(|(source, target)| LegendGlossaryEntry {
                source: source.clone(),
                target: target.as_str().unwrap_or_default().to_owned(),
                locked: false,
                note: String::new(),
            })
            .collect()
    };
    let mut seen = std::collections::BTreeSet::new();
    if entries.len() > 20_000
        || entries
            .iter()
            .any(|entry| !seen.insert(entry.source.clone()))
    {
        return Err(CommandError::new(
            "legend_glossary_invalid",
            "Glossary vượt giới hạn hoặc có source trùng",
        ));
    }
    Ok(LegendGlossaryDocument {
        version: 2,
        profile_id: "legend-three-kingdoms-zh-vi-v1".into(),
        path: path.to_string_lossy().into_owned(),
        entries,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_legend_glossary(
    path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<LegendGlossaryDocument> {
    ensure_legend_directories(&state)?;
    let path = path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| legend_glossary_path(&state));
    spawn_command(move || get_legend_glossary_sync(&path)).await
}

fn get_legend_glossary_sync(path: &Path) -> CommandResult<LegendGlossaryDocument> {
    if !path.exists() {
        return Ok(LegendGlossaryDocument {
            version: 2,
            profile_id: "legend-three-kingdoms-zh-vi-v1".into(),
            path: path.to_string_lossy().into_owned(),
            entries: Vec::new(),
        });
    }
    let bytes = fs::read(path).map_err(|error| CommandError::io("Đọc glossary Legend", error))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(CommandError::new(
            "legend_glossary_too_large",
            "Glossary Legend vượt quá 16 MiB",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::new(
            "legend_glossary_invalid",
            format!("Glossary JSON không hợp lệ: {error}"),
        )
    })?;
    parse_legend_glossary(&value, path)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_legend_glossary(
    entries: Vec<LegendGlossaryEntry>,
    path: Option<String>,
    set_active: Option<bool>,
    state: State<'_, AppState>,
) -> CommandResult<LegendGlossaryDocument> {
    reject_while_running(&state)?;
    ensure_legend_directories(&state)?;
    let path = path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| legend_glossary_path(&state));
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err(CommandError::new(
            "legend_glossary_path_invalid",
            "Glossary phải là file JSON với đường dẫn tuyệt đối",
        ));
    }
    let set_active = set_active.unwrap_or(true);
    let state = (*state).clone();
    spawn_command(move || save_legend_glossary_sync(&state, entries, path, set_active)).await
}

fn save_legend_glossary_sync(
    state: &AppState,
    entries: Vec<LegendGlossaryEntry>,
    path: PathBuf,
    set_active: bool,
) -> CommandResult<LegendGlossaryDocument> {
    let value = serde_json::json!({
        "version": 2,
        "profileId": "legend-three-kingdoms-zh-vi-v1",
        "entries": entries,
    });
    let document = parse_legend_glossary(&value, &path)?;
    write_json_atomic(&path, &value)?;
    if set_active {
        let mut data = state.data()?;
        data.legend_glossary_path = Some(path);
        if let Some(preview) = data.legend_preview.as_mut() {
            preview.qa_stale_reason =
                Some("Glossary đã thay đổi; bấm Rebuild preview + QA.".to_owned());
        }
        if let Some(preview) = data.legend_trial_preview.as_mut() {
            preview.qa_stale_reason =
                Some("Glossary đã thay đổi; bấm Rebuild preview + QA.".to_owned());
        }
        drop(data);
        state.save_snapshot()?;
    }
    Ok(document)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_legend_glossary(
    entries: Vec<LegendGlossaryEntry>,
    path: String,
    format: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    reject_while_running(&state)?;
    let path = PathBuf::from(path);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err(CommandError::new(
            "legend_glossary_path_invalid",
            "Glossary export phải là file JSON với đường dẫn tuyệt đối",
        ));
    }
    spawn_command(move || export_legend_glossary_sync(entries, path, format)).await
}

fn export_legend_glossary_sync(
    entries: Vec<LegendGlossaryEntry>,
    path: PathBuf,
    format: String,
) -> CommandResult<()> {
    let validated = serde_json::json!({
        "version": 2,
        "profileId": "legend-three-kingdoms-zh-vi-v1",
        "entries": entries,
    });
    let document = parse_legend_glossary(&validated, &path)?;
    let value = match format.as_str() {
        "v2" => validated,
        "flat" => Value::Object(Map::from_iter(
            document
                .entries
                .into_iter()
                .map(|entry| (entry.source, Value::String(entry.target))),
        )),
        _ => {
            return Err(CommandError::new(
                "legend_glossary_format_invalid",
                "format phải là v2 hoặc flat",
            ));
        }
    };
    write_json_atomic(&path, &value)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_legend_file(
    source_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LegendFileInspection> {
    let source_path = validate_legend_source(Path::new(&source_path))?;
    let state = (*state).clone();
    spawn_command(move || inspect_legend_file_sync(&app, &state, source_path)).await
}

fn inspect_legend_file_sync(
    app: &AppHandle,
    state: &AppState,
    source_path: PathBuf,
) -> CommandResult<LegendFileInspection> {
    let app_config = state.data()?.app.config.clone();
    let payload = run_engine_sync(
        app,
        state,
        "legend-inspect",
        &legend_inspect_config(&source_path),
        &app_config,
        &[],
        app_config.timeout_seconds,
        false,
    )?;
    let inspection = parse_legend_inspection(&payload, &source_path)?;
    {
        let mut data = state.data()?;
        if data.legend_source_path.as_ref() != Some(&source_path)
            || data
                .legend_preview
                .as_ref()
                .is_some_and(|preview| preview.source_fingerprint != inspection.fingerprint)
        {
            data.legend_preview = None;
        }
        data.legend_source_path = Some(source_path);
    }
    state.save_snapshot()?;
    Ok(inspection)
}

const LEGEND_COMMENT_PREFIXES: &[&str] = &["#", ";", "//"];
const LEGEND_ENTRIES_PAGE_MAX: u64 = 500;

fn equals_slash_count(bytes: &[u8], index: usize) -> usize {
    let mut slash_count = 0usize;
    let mut cursor = index;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        slash_count += 1;
        cursor -= 1;
    }
    slash_count
}

fn first_unescaped_equals(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'=' && equals_slash_count(bytes, index) % 2 == 0 {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn last_escaped_equals(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut last = None;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'=' && equals_slash_count(bytes, index) % 2 == 1 {
            last = Some(index);
        }
        index += 1;
    }
    last
}

fn split_legend_kv(body: &str) -> Option<(&str, &str)> {
    if let Some(separator) = first_unescaped_equals(body) {
        return Some((&body[..separator], &body[separator + 1..]));
    }
    let separator = last_escaped_equals(body)?;
    Some((&body[..=separator], &body[separator + 1..]))
}

fn parse_legend_line(number: u64, body: &str) -> Option<LegendFileEntry> {
    let stripped = body.trim_start();
    if stripped.is_empty()
        || LEGEND_COMMENT_PREFIXES
            .iter()
            .any(|prefix| stripped.starts_with(prefix))
    {
        return None;
    }
    match split_legend_kv(body) {
        None => Some(LegendFileEntry {
            line_number: number,
            source: body.to_owned(),
            current_target: String::new(),
            kind: "invalid".into(),
            warning: Some("Không tìm thấy dấu = chưa escape".into()),
            occurrence: None,
        }),
        Some((left, right)) => {
            if left.trim().is_empty() {
                return Some(LegendFileEntry {
                    line_number: number,
                    source: body.to_owned(),
                    current_target: String::new(),
                    kind: "invalid".into(),
                    warning: Some("Key trước dấu = bị rỗng".into()),
                    occurrence: None,
                });
            }
            Some(LegendFileEntry {
                line_number: number,
                source: left.replace("\\=", "="),
                current_target: right.to_owned(),
                kind: "entry".into(),
                warning: None,
                occurrence: None,
            })
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_legend_file_entries(
    source_path: String,
    offset: u64,
    limit: u64,
    kind: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LegendFileEntriesPage> {
    let source_path = validate_legend_source(Path::new(&source_path))?;
    let kind = kind.unwrap_or_else(|| "entry".into());
    if !matches!(
        kind.as_str(),
        "entry" | "invalid" | "duplicate" | "all" | "pending" | "done"
    ) {
        return Err(CommandError::new(
            "legend_list_kind_invalid",
            "kind phải là entry, invalid, duplicate, pending, done hoặc all",
        ));
    }
    let limit = limit.clamp(1, LEGEND_ENTRIES_PAGE_MAX);
    let state = (*state).clone();
    spawn_command(move || {
        list_legend_file_entries_sync(&app, &state, source_path, offset, limit, kind)
    })
    .await
}

fn list_legend_file_entries_sync(
    app: &AppHandle,
    state: &AppState,
    source_path: PathBuf,
    offset: u64,
    limit: u64,
    kind: String,
) -> CommandResult<LegendFileEntriesPage> {
    let app_config = state.data()?.app.config.clone();
    let payload = run_engine_sync(
        app,
        state,
        "legend-list-entries",
        &legend_list_entries_config(&source_path, offset, limit, &kind),
        &app_config,
        &[],
        app_config.timeout_seconds,
        false,
    )?;
    parse_legend_entries_page(&payload, &source_path)
}

const LEGEND_SEARCH_MAX: u64 = 500;

fn is_legend_word_char(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

fn legend_text_matches(haystack: &str, needle: &str, case_sensitive: bool, whole_word: bool) -> bool {
    if needle.is_empty() || haystack.is_empty() {
        return false;
    }
    let hay = if case_sensitive {
        haystack.to_string()
    } else {
        haystack.to_lowercase()
    };
    let nee = if case_sensitive {
        needle.to_string()
    } else {
        needle.to_lowercase()
    };
    if !whole_word {
        return hay.contains(&nee);
    }
    let mut start = 0usize;
    while let Some(pos) = hay[start..].find(&nee) {
        let abs = start + pos;
        let before_ok = abs == 0
            || !hay[..abs]
                .chars()
                .next_back()
                .is_some_and(is_legend_word_char);
        let end = abs + nee.len();
        let after_ok = end >= hay.len()
            || !hay[end..].chars().next().is_some_and(is_legend_word_char);
        if before_ok && after_ok {
            return true;
        }
        start = abs + nee.chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
        if start <= abs {
            break;
        }
    }
    false
}

fn escape_unescaped_equals(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 8);
    for (index, character) in text.char_indices() {
        if character == '=' && equals_slash_count(bytes, index) % 2 == 0 {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

fn escape_legend_value(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] == '\\'
            && index + 1 < chars.len()
            && matches!(chars[index + 1], 'r' | 'n' | 't')
        {
            out.push('\\');
            out.push(chars[index + 1]);
            index += 2;
            continue;
        }
        match chars[index] {
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
        index += 1;
    }
    escape_unescaped_equals(&out)
}

fn resolve_legend_source_path(
    source_path: Option<String>,
    state: &AppState,
) -> CommandResult<PathBuf> {
    if let Some(path) = source_path.filter(|value| !value.trim().is_empty()) {
        return validate_legend_source(Path::new(&path));
    }
    let stored = state
        .data()?
        .legend_source_path
        .clone()
        .ok_or_else(|| {
            CommandError::new(
                "legend_source_missing",
                "Chưa chọn file nguồn XUnity. Vào Cài đặt để chọn file.",
            )
        })?;
    validate_legend_source(&stored)
}

fn read_legend_source_text(source_path: &Path) -> CommandResult<(bool, String)> {
    let original =
        fs::read(source_path).map_err(|error| CommandError::io("Đọc file Legend", error))?;
    let bom = original.starts_with(UTF8_BOM);
    let payload = if bom {
        &original[UTF8_BOM.len()..]
    } else {
        original.as_slice()
    };
    let text = String::from_utf8(payload.to_vec()).map_err(|_| {
        CommandError::new(
            "legend_source_invalid",
            "Legend adapter chỉ hỗ trợ UTF-8/UTF-8 BOM",
        )
    })?;
    Ok((bom, text))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn search_legend_file(
    query: String,
    scope: Option<String>,
    max_results: Option<u64>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    source_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<LegendSearchResult> {
    let source_path = resolve_legend_source_path(source_path, &state)?;
    let scope = scope.unwrap_or_else(|| "all".into());
    if !matches!(scope.as_str(), "all" | "chinese" | "vietnamese" | "line") {
        return Err(CommandError::new(
            "legend_search_scope_invalid",
            "scope phải là all, chinese, vietnamese hoặc line",
        ));
    }
    let max_results = max_results.unwrap_or(LEGEND_SEARCH_MAX).clamp(1, LEGEND_SEARCH_MAX);
    let case_sensitive = case_sensitive.unwrap_or(false);
    let whole_word = whole_word.unwrap_or(false);
    let trimmed = query.trim().to_string();
    spawn_command(move || {
        search_legend_file_sync(
            &source_path,
            scope,
            max_results,
            case_sensitive,
            whole_word,
            trimmed,
        )
    })
    .await
}

fn search_legend_file_sync(
    source_path: &Path,
    scope: String,
    max_results: u64,
    case_sensitive: bool,
    whole_word: bool,
    trimmed: String,
) -> CommandResult<LegendSearchResult> {
    let (_, text) = read_legend_source_text(source_path)?;
    let raw_lines = split_preserving_endings(&text);
    let mut matches = Vec::new();
    let mut scanned_lines = 0u64;
    let mut total_matches = 0u64;
    for (index, (body, _)) in raw_lines.iter().enumerate() {
        let Some(entry) = parse_legend_line((index + 1) as u64, body) else {
            continue;
        };
        if entry.kind != "entry" {
            continue;
        }
        scanned_lines += 1;
        let matched = if trimmed.is_empty() {
            true
        } else {
            let line_text = entry.line_number.to_string();
            match scope.as_str() {
                "chinese" => {
                    legend_text_matches(&entry.source, &trimmed, case_sensitive, whole_word)
                }
                "vietnamese" => legend_text_matches(
                    &entry.current_target,
                    &trimmed,
                    case_sensitive,
                    whole_word,
                ),
                "line" => legend_text_matches(&line_text, &trimmed, case_sensitive, false),
                _ => {
                    legend_text_matches(&entry.source, &trimmed, case_sensitive, whole_word)
                        || legend_text_matches(
                            &entry.current_target,
                            &trimmed,
                            case_sensitive,
                            whole_word,
                        )
                        || legend_text_matches(&line_text, &trimmed, case_sensitive, false)
                }
            }
        };
        if !matched {
            continue;
        }
        total_matches += 1;
        if (matches.len() as u64) < max_results {
            matches.push(LegendSearchMatch {
                id: format!("legend-line-{}", entry.line_number),
                line_number: entry.line_number,
                source: entry.source,
                current_target: entry.current_target,
            });
        }
    }
    Ok(LegendSearchResult {
        query: trimmed,
        scope,
        source_path: tool_paths::display_windows_path(source_path),
        scanned_lines,
        total_matches,
        truncated: total_matches > max_results,
        matches,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_legend_lines(
    edits: Vec<LegendLineEdit>,
    source_path: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<LegendLineUpdateResult> {
    reject_while_running(&state)?;
    if edits.is_empty() {
        return Err(CommandError::new(
            "legend_update_empty",
            "Không có dòng nào để cập nhật.",
        ));
    }
    let source_path = resolve_legend_source_path(source_path, &state)?;
    let state = (*state).clone();
    spawn_command(move || update_legend_lines_sync(&state, source_path, edits)).await
}

fn update_legend_lines_sync(
    state: &AppState,
    source_path: PathBuf,
    edits: Vec<LegendLineEdit>,
) -> CommandResult<LegendLineUpdateResult> {
    let (bom, text) = read_legend_source_text(&source_path)?;
    let raw_lines = split_preserving_endings(&text);
    let mut wanted = BTreeMap::new();
    for edit in edits {
        wanted.insert(edit.line_number, edit.current_target);
    }
    let mut output = if bom {
        UTF8_BOM.to_vec()
    } else {
        Vec::new()
    };
    let mut updated = 0u64;
    for (index, (body, ending)) in raw_lines.iter().enumerate() {
        let line_number = (index + 1) as u64;
        if let Some(next_target) = wanted.remove(&line_number) {
            let Some((left, _)) = split_legend_kv(body) else {
                return Err(CommandError::new(
                    "legend_update_line_invalid",
                    format!("Dòng {line_number} không phải mục Trung=Việt."),
                ));
            };
            if left.trim().is_empty() {
                return Err(CommandError::new(
                    "legend_update_line_invalid",
                    format!("Dòng {line_number} có key rỗng."),
                ));
            }
            output.extend_from_slice(left.as_bytes());
            output.push(b'=');
            output.extend_from_slice(escape_legend_value(&next_target).as_bytes());
            output.extend_from_slice(ending.as_bytes());
            updated += 1;
            continue;
        }
        output.extend_from_slice(body.as_bytes());
        output.extend_from_slice(ending.as_bytes());
    }
    if !wanted.is_empty() {
        let missing = wanted.keys().copied().next().unwrap_or(0);
        return Err(CommandError::new(
            "legend_update_line_missing",
            format!("Không tìm thấy dòng {missing} trong file."),
        ));
    }
    if updated == 0 {
        return Err(CommandError::new(
            "legend_update_empty",
            "Không có dòng nào để cập nhật.",
        ));
    }
    write_bytes_atomic(&source_path, &output)?;
    {
        let mut data = state.data()?;
        data.legend_preview = None;
        data.legend_source_path = Some(source_path.clone());
    }
    state.save_snapshot()?;
    Ok(LegendLineUpdateResult {
        source_path: tool_paths::display_windows_path(&source_path),
        updated_lines: updated,
    })
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn split_preserving_endings(text: &str) -> Vec<(&str, &str)> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let (body_end, ending) = if index > start && bytes[index - 1] == b'\r' {
                (index - 1, "\r\n")
            } else {
                (index, "\n")
            };
            lines.push((&text[start..body_end], ending));
            index += 1;
            start = index;
        } else {
            index += 1;
        }
    }
    if start < text.len() {
        if text.as_bytes()[text.len() - 1] == b'\r' {
            lines.push((&text[start..text.len() - 1], "\r"));
        } else {
            lines.push((&text[start..], ""));
        }
    }
    lines
}

fn dedupe_legend_text(text: &str) -> (String, u64, u64) {
    let raw_lines = split_preserving_endings(text);
    let mut last_index = BTreeMap::new();
    for (index, (body, _)) in raw_lines.iter().enumerate() {
        if let Some(entry) = parse_legend_line((index + 1) as u64, body) {
            if entry.kind == "entry" {
                last_index.insert(entry.source, index);
            }
        }
    }
    let mut kept = String::new();
    let mut removed = 0u64;
    let mut remaining_entries = 0u64;
    for (index, (body, ending)) in raw_lines.iter().enumerate() {
        if let Some(entry) = parse_legend_line((index + 1) as u64, body) {
            if entry.kind == "entry" && last_index.get(&entry.source) != Some(&index) {
                removed += 1;
                continue;
            }
            if entry.kind == "entry" {
                remaining_entries += 1;
            }
        }
        kept.push_str(body);
        kept.push_str(ending);
    }
    (kept, removed, remaining_entries)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn dedupe_legend_file(
    source_path: String,
    state: State<'_, AppState>,
) -> CommandResult<LegendDedupeResult> {
    reject_while_running(&state)?;
    let source_path = validate_legend_source(Path::new(&source_path))?;
    let state = (*state).clone();
    spawn_command(move || dedupe_legend_file_sync(&state, source_path)).await
}

fn dedupe_legend_file_sync(
    state: &AppState,
    source_path: PathBuf,
) -> CommandResult<LegendDedupeResult> {
    let original = fs::read(&source_path).map_err(|error| CommandError::io("Đọc file Legend", error))?;
    let bom = original.starts_with(UTF8_BOM);
    let payload = if bom {
        &original[UTF8_BOM.len()..]
    } else {
        original.as_slice()
    };
    let text = String::from_utf8(payload.to_vec()).map_err(|_| {
        CommandError::new(
            "legend_source_invalid",
            "Legend adapter chỉ hỗ trợ UTF-8/UTF-8 BOM",
        )
    })?;
    let (deduped, removed, remaining_entries) = dedupe_legend_text(&text);
    if removed == 0 {
        return Ok(LegendDedupeResult {
            source_path: source_path.to_string_lossy().into_owned(),
            removed: 0,
            remaining_entries,
            backup_path: None,
        });
    }
    ensure_legend_directories(&state)?;
    let original_hash = sha256_hex(&original);
    let mut output = if bom {
        UTF8_BOM.to_vec()
    } else {
        Vec::new()
    };
    output.extend_from_slice(deduped.as_bytes());
    let applied_hash = sha256_hex(&output);
    let backup_id = format!("legend-backup-{}-{}", now_millis(), &original_hash[..8]);
    let backup_dir = legend_backup_directory(&state).join(&backup_id);
    let files_dir = backup_dir.join("files");
    fs::create_dir_all(&files_dir)
        .map_err(|error| CommandError::io("Tạo thư mục backup Legend", error))?;
    let backup_file = files_dir.join(
        source_path
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("legend.txt")),
    );
    fs::write(&backup_file, &original)
        .map_err(|error| CommandError::io("Ghi bản sao Legend", error))?;
    let manifest_path = backup_dir.join("manifest.json");
    let mut manifest = serde_json::json!({
        "version": 2,
        "createdAt": now_iso(),
        "adapter": "legend-three-kingdoms",
        "reason": "dedupe-sources",
        "source": source_path.to_string_lossy(),
        "sourceFingerprint": original_hash,
        "backupFile": backup_file.to_string_lossy(),
        "complete": false,
    });
    write_json_atomic(&manifest_path, &manifest)?;
    if let Err(error) = write_bytes_atomic(&source_path, &output) {
        let _ = fs::write(&source_path, &original);
        return Err(error);
    }
    manifest["complete"] = Value::Bool(true);
    manifest["appliedFingerprint"] = Value::String(applied_hash);
    write_json_atomic(&manifest_path, &manifest)?;
    {
        let mut data = state.data()?;
        data.legend_preview = None;
        data.legend_source_path = Some(source_path.clone());
        refresh_backups(&mut data, &state.app_data_dir)?;
    }
    state.save_snapshot()?;
    Ok(LegendDedupeResult {
        source_path: source_path.to_string_lossy().into_owned(),
        removed,
        remaining_entries,
        backup_path: Some(backup_dir.to_string_lossy().into_owned()),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn estimate_legend_translation(
    source_path: String,
    mode: Option<String>,
    trial_limit: Option<u64>,
    force_retranslate: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LegendTranslationEstimate> {
    let _ = (mode, trial_limit);
    let force_retranslate = force_retranslate.unwrap_or(false);
    let source_path = validate_legend_source(Path::new(&source_path))?;
    ensure_legend_directories(&state)?;
    let state = (*state).clone();
    spawn_command(move || {
        estimate_legend_translation_sync(&app, &state, source_path, force_retranslate)
    })
    .await
}

fn estimate_legend_translation_sync(
    app: &AppHandle,
    state: &AppState,
    source_path: PathBuf,
    force_retranslate: bool,
) -> CommandResult<LegendTranslationEstimate> {
    let data = state.data()?;
    let config = data.app.config.clone();
    let seconds_per_batch = data.legend_seconds_per_batch.unwrap_or(10.0);
    drop(data);
    let payload = run_engine_sync(
        app,
        state,
        "legend-estimate",
        &legend_estimate_config(
            &source_path,
            &legend_root(state)
                .join("cache")
                .join(LEGEND_CACHE_FILENAME),
            &legend_glossary_path(state),
            &config,
            "full",
            30,
            force_retranslate,
        ),
        &config,
        &["estimate-no-api".into()],
        config.timeout_seconds,
        false,
    )?;
    let batches = payload
        .get("estimatedBatches")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let workers_used = payload
        .get("workersUsed")
        .and_then(Value::as_u64)
        .unwrap_or(if batches > 0 { 1 } else { 0 });
    let wall_batches = if workers_used > 0 {
        (batches as f64 / workers_used as f64).ceil()
    } else {
        0.0
    };
    let expected = wall_batches * seconds_per_batch;
    Ok(LegendTranslationEstimate {
        items: payload.get("items").and_then(Value::as_u64).unwrap_or(0),
        done_items: payload
            .get("doneItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reused_items: payload
            .get("reusedItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cached_items: payload
            .get("cachedItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        locked_items: payload
            .get("lockedItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        pending_items: payload
            .get("pendingItems")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        actionable_items: payload
            .get("actionableItems")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                payload
                    .get("reusedItems")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    + payload
                        .get("pendingItems")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                    + payload
                        .get("cachedItems")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                    + payload
                        .get("lockedItems")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
            }),
        workers_used,
        spare_keys: payload
            .get("spareKeys")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        estimated_batches: batches,
        estimated_api_calls: payload
            .get("estimatedApiCalls")
            .and_then(Value::as_u64)
            .unwrap_or(batches),
        estimated_seconds_min: (expected * 0.7).ceil() as u64,
        estimated_seconds_max: (expected * 1.5).ceil() as u64,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn start_legend_translation(
    source_path: String,
    mode: Option<String>,
    trial_limit: Option<u64>,
    force_retranslate: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<JobStartResponse> {
    let _ = (mode, trial_limit);
    let force_retranslate = force_retranslate.unwrap_or(false);
    let source_path = validate_legend_source(Path::new(&source_path))?;
    let mode = "full".to_owned();
    ensure_legend_directories(&state)?;
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
    if let Err(error) = state.data().and_then(|data| legend_enabled_key_ids(&data)) {
        state.job_gate.store(false, Ordering::Release);
        return Err(error);
    }

    let job_id = state.unique_id("legend");
    let prepare_result = (|| -> CommandResult<()> {
        let mut data = state.data()?;
        data.legend_source_path = Some(source_path.clone());
        drop(data);
        state.save_snapshot()
    })();
    if let Err(error) = prepare_result {
        state.job_gate.store(false, Ordering::Release);
        return Err(error);
    }
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let register_result = (|| -> CommandResult<()> {
        let mut starting = state.starting_job()?;
        *starting = Some(StartingJob {
            job_id: job_id.clone(),
            cancel_requested: Arc::clone(&cancel_requested),
        });
        Ok(())
    })();
    if let Err(error) = register_result {
        state.job_gate.store(false, Ordering::Release);
        return Err(error);
    }

    let started = LegendJobEvent {
        protocol_version: PROTOCOL_VERSION,
        job_id: job_id.clone(),
        seq: 0,
        timestamp: now_iso(),
        event_type: LegendJobEventType::Started,
        payload: Map::from_iter([
            ("command".into(), Value::String("legend-translate".into())),
            ("title".into(), Value::String("Bắt đầu dịch Legend".into())),
            (
                "sourcePath".into(),
                Value::String(source_path.to_string_lossy().into_owned()),
            ),
            ("mode".into(), Value::String(mode.clone())),
            ("forceRetranslate".into(), Value::Bool(force_retranslate)),
        ]),
    };
    let _ = app.emit("legend-job-event", &started);

    let thread_app = app.clone();
    let thread_state = state.inner().clone();
    let thread_job_id = job_id.clone();
    let thread_cancel_requested = Arc::clone(&cancel_requested);
    let thread_mode = mode.clone();
    std::thread::spawn(move || {
        if let Err(error) = run_legend_translation(
            &thread_app,
            &thread_state,
            &thread_job_id,
            &source_path,
            &thread_mode,
            force_retranslate,
            Arc::clone(&thread_cancel_requested),
        ) {
            if thread_cancel_requested.load(Ordering::Acquire) {
                emit_legend_paused(&thread_app, &thread_state, &thread_job_id, 1);
            } else {
                emit_legend_failure(
                    &thread_app,
                    &thread_state,
                    &thread_job_id,
                    1,
                    error.code,
                    error.message,
                );
            }
            clear_process(&thread_state, &thread_job_id);
        }
    });
    Ok(JobStartResponse { job_id })
}

fn run_legend_translation(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    source_path: &Path,
    mode: &str,
    force_retranslate: bool,
    cancel_requested: Arc<AtomicBool>,
) -> CommandResult<()> {
    let job_started_at = Instant::now();
    if cancel_requested.load(Ordering::Acquire) {
        return Err(CommandError::new(
            "job_cancelled",
            "Job Legend đã được hủy khi đang khởi động",
        ));
    }
    let (config, secrets) = {
        let data = state.data()?;
        let key_ids = legend_enabled_key_ids(&data)?;
        let mut secrets = Zeroizing::new(Vec::with_capacity(key_ids.len()));
        for key_id in &key_ids {
            secrets.push(credentials::get_secret(key_id)?);
        }
        (data.app.config.clone(), secrets)
    };
    if cancel_requested.load(Ordering::Acquire) {
        return Err(CommandError::new(
            "job_cancelled",
            "Job Legend đã được hủy khi đang khởi động",
        ));
    }
    let preview_path = legend_preview_directory(state).join(format!("{job_id}.json"));
    let cache_path = legend_root(state).join("cache").join(LEGEND_CACHE_FILENAME);
    let glossary_path = legend_glossary_path(state);
    let engine_config = legend_translate_config(
        source_path,
        &preview_path,
        &cache_path,
        &glossary_path,
        &config,
        mode,
        30,
        force_retranslate,
    );
    let request = EngineRequest {
        protocol_version: PROTOCOL_VERSION,
        job_id,
        command: "legend-translate",
        config: &engine_config,
        api_keys: &secrets,
    };
    let request_bytes = Zeroizing::new(
        serde_json::to_vec(&request)
            .map_err(|error| CommandError::new("request_serialize_failed", error.to_string()))?,
    );
    let redactions = Zeroizing::new(secrets.to_vec());
    drop(secrets);

    let executable = resolve_sidecar_path(app).ok_or_else(|| {
        CommandError::new(
            "sidecar_not_found",
            format!("Không tìm thấy externalBin {SIDECAR_NAME}"),
        )
    })?;
    ensure_sidecar_runtime(app, &executable)?;

    let mut command = Command::new(&executable);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| CommandError::io("Khởi chạy sidecar Legend", error))?;
    let process_id = child.id();
    let job_object = JobObject::attach(process_id).ok().flatten();
    let mut stdin = child.stdin.take().ok_or_else(|| {
        CommandError::new("sidecar_stdin_unavailable", "Không mở được stdin sidecar")
    })?;
    let write_result = stdin
        .write_all(request_bytes.as_slice())
        .and_then(|_| stdin.flush());
    drop(stdin);
    if let Err(error) = write_result {
        let _ = child.kill();
        return Err(CommandError::io("Gửi request Legend", error));
    }
    let stdout = child.stdout.take().ok_or_else(|| {
        CommandError::new("sidecar_stdout_unavailable", "Không mở được stdout sidecar")
    })?;
    let child = Arc::new(Mutex::new(child));
    {
        let mut process = state.process()?;
        *process = Some(RunningProcess {
            job_id: job_id.to_owned(),
            process_id,
            child: Arc::clone(&child),
            cancel_requested: Arc::clone(&cancel_requested),
            job_object,
        });
    }
    if let Ok(mut starting) = state.starting_job.lock() {
        if starting
            .as_ref()
            .is_some_and(|pending| pending.job_id == job_id)
        {
            starting.take();
        }
    }
    if cancel_requested.load(Ordering::Acquire) {
        let _ = soft_cancel(process_id);
    }

    let mut validator = ProtocolValidator::new(job_id);
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut terminal_seen = false;
    let stream_result = (|| -> CommandResult<()> {
        while read_bounded_line(&mut reader, &mut line)
            .map_err(|error| CommandError::io("Đọc engine Legend", error))?
        {
            if line.is_empty() {
                continue;
            }
            let mut raw = validator.parse_line(&line)?;
            if !engine_event_step_matches("legend-translate", &raw.step) {
                return Err(CommandError::new(
                    "protocol_step_mismatch",
                    "Engine event không thuộc command legend-translate",
                ));
            }
            redact_value_map(&mut raw.payload, redactions.as_slice());
            if raw.event_type == "result" {
                hydrate_spilled_result_payload(
                    &mut raw.payload,
                    &[
                        state.app_data_dir.clone(),
                        std::env::temp_dir(),
                        source_path.to_path_buf(),
                    ],
                )?;
                raw.payload.remove("diffs");
                if let Some(qa) = raw.payload.get_mut("qa") {
                    if let Some(object) = qa.as_object_mut() {
                        object.remove("issues");
                    }
                }
                let returned_path = raw
                    .payload
                    .get("previewPath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        CommandError::new(
                            "legend_preview_result_invalid",
                            "Kết quả legend-translate thiếu previewPath",
                        )
                    })?;
                if returned_path.canonicalize().ok() != preview_path.canonicalize().ok() {
                    return Err(CommandError::new(
                        "legend_preview_untrusted",
                        "Engine trả về previewPath khác đường dẫn AppData đã cấp",
                    ));
                }
                let bytes = fs::read(&preview_path)
                    .map_err(|error| CommandError::io("Đọc preview Legend", error))?;
                if bytes.len() as u64 > MAX_SPILLED_RESULT_BYTES {
                    return Err(CommandError::new(
                        "legend_preview_too_large",
                        "Preview Legend vượt quá giới hạn 64 MiB",
                    ));
                }
                let artifact: Value = serde_json::from_slice(&bytes).map_err(|error| {
                    CommandError::new(
                        "legend_preview_invalid",
                        format!("Preview Legend không phải JSON hợp lệ: {error}"),
                    )
                })?;
                let artifact = artifact.as_object().ok_or_else(|| {
                    CommandError::new(
                        "legend_preview_invalid",
                        "Preview Legend phải là JSON object",
                    )
                })?;
                let preview = parse_legend_preview(artifact, source_path)?;
                if raw.payload.get("previewId").and_then(Value::as_str)
                    != Some(preview.preview_id.as_str())
                {
                    return Err(CommandError::new(
                        "legend_preview_stale",
                        "previewId trong result không khớp artifact",
                    ));
                }
                {
                    let mut data = state.data()?;
                    data.legend_source_path = Some(source_path.to_path_buf());
                    let metadata = LegendPreviewMetadata {
                        preview_id: preview.preview_id.clone(),
                        source_path: source_path.to_path_buf(),
                        source_fingerprint: preview.source_fingerprint.clone(),
                        created_at: preview.created_at.clone(),
                        preview_path: preview_path.clone(),
                        revision: preview.revision,
                        mode: preview.mode.clone(),
                        glossary_hash: preview.glossary_hash.clone(),
                        qa_stale_reason: None,
                    };
                    if preview.mode != "trial" {
                        data.legend_preview = Some(metadata);
                    }
                    if preview.stats.api_calls > 0 {
                        let workers_used = raw
                            .payload
                            .get("workersUsed")
                            .and_then(Value::as_u64)
                            .or_else(|| {
                                raw.payload.get("workers").and_then(Value::as_u64)
                            })
                            .unwrap_or(1)
                            .max(1) as f64;
                        let sample = job_started_at.elapsed().as_secs_f64() * workers_used
                            / preview.stats.api_calls as f64;
                        data.legend_seconds_per_batch = Some(
                            data.legend_seconds_per_batch
                                .map_or(sample, |previous| previous * 0.7 + sample * 0.3),
                        );
                    }
                }
                state.save_snapshot()?;
                raw.payload
                    .insert("previewId".into(), Value::String(preview.preview_id));
                raw.payload.insert(
                    "sourcePath".into(),
                    Value::String(source_path.to_string_lossy().into_owned()),
                );
                raw.payload.insert(
                    "sourceFingerprint".into(),
                    Value::String(preview.source_fingerprint),
                );
            }
            let event = adapt_legend_event(&raw);
            terminal_seen |= matches!(
                event.event_type,
                LegendJobEventType::Completed
                    | LegendJobEventType::Failed
                    | LegendJobEventType::Paused
            );
            app.emit("legend-job-event", &event)
                .map_err(|error| CommandError::new("event_emit_failed", error.to_string()))?;
            maybe_notify_legend(app, state, &event);
        }
        Ok(())
    })();
    if let Err(error) = stream_result {
        emit_legend_failure(
            app,
            state,
            job_id,
            validator.next_seq(),
            error.code,
            error.message,
        );
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        clear_process(state, job_id);
        return Ok(());
    }
    if let Ok(mut child) = child.lock() {
        let _ = child.wait();
    }
    clear_process(state, job_id);
    if !terminal_seen {
        let cancelled = cancel_requested.load(Ordering::Acquire);
        let event = LegendJobEvent {
            protocol_version: PROTOCOL_VERSION,
            job_id: job_id.to_owned(),
            seq: validator.next_seq(),
            timestamp: now_iso(),
            event_type: if cancelled {
                LegendJobEventType::Paused
            } else {
                LegendJobEventType::Failed
            },
            payload: Map::from_iter([
                ("command".into(), Value::String("legend-translate".into())),
                (
                    "message".into(),
                    Value::String(if cancelled {
                        "Job Legend đã được hủy".into()
                    } else {
                        "Engine Legend thoát mà không gửi terminal event".into()
                    }),
                ),
            ]),
        };
        let _ = app.emit("legend-job-event", &event);
        maybe_notify_legend(app, state, &event);
    }
    Ok(())
}

fn adapt_legend_event(raw: &EngineEventEnvelope) -> LegendJobEvent {
    let mut payload = raw.payload.clone();
    let event_type = match raw.event_type.as_str() {
        "started" => LegendJobEventType::Started,
        "progress" => LegendJobEventType::Progress,
        "warning" => LegendJobEventType::Warning,
        "result" => LegendJobEventType::Result,
        "error" if payload.get("code").and_then(Value::as_str) == Some("CANCELLED") => {
            LegendJobEventType::Paused
        }
        "error" => LegendJobEventType::Failed,
        "completed" => match payload.get("status").and_then(Value::as_str) {
            Some("cancelled") => LegendJobEventType::Paused,
            Some("failed") => LegendJobEventType::Failed,
            _ => LegendJobEventType::Completed,
        },
        _ => LegendJobEventType::Log,
    };
    payload.insert("command".into(), Value::String("legend-translate".into()));
    LegendJobEvent {
        protocol_version: raw.protocol_version,
        job_id: raw.job_id.clone(),
        seq: raw.seq,
        timestamp: raw.timestamp.clone(),
        event_type,
        payload,
    }
}

fn emit_legend_failure(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    seq: u64,
    code: impl Into<String>,
    message: impl Into<String>,
) {
    let message = message.into();
    let event = LegendJobEvent {
        protocol_version: PROTOCOL_VERSION,
        job_id: job_id.to_owned(),
        seq,
        timestamp: now_iso(),
        event_type: LegendJobEventType::Failed,
        payload: Map::from_iter([
            ("command".into(), Value::String("legend-translate".into())),
            ("code".into(), Value::String(code.into())),
            ("message".into(), Value::String(message.clone())),
        ]),
    };
    let _ = app.emit("legend-job-event", &event);
    maybe_notify_legend(app, state, &event);
}

fn emit_legend_paused(app: &AppHandle, state: &AppState, job_id: &str, seq: u64) {
    let event = LegendJobEvent {
        protocol_version: PROTOCOL_VERSION,
        job_id: job_id.to_owned(),
        seq,
        timestamp: now_iso(),
        event_type: LegendJobEventType::Paused,
        payload: Map::from_iter([
            ("command".into(), Value::String("legend-translate".into())),
            (
                "message".into(),
                Value::String("Job Legend đã được hủy".into()),
            ),
        ]),
    };
    let _ = app.emit("legend-job-event", &event);
    maybe_notify_legend(app, state, &event);
}

fn scan_legend_preview_json_files(dir: &Path) -> CommandResult<Vec<PathBuf>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)
        .map_err(|error| CommandError::io("Đọc thư mục preview Legend", error))?
    {
        let entry = entry
            .map_err(|error| CommandError::io("Đọc entry preview Legend", error))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            files.push(path);
        }
    }
    files.sort_by(|left, right| {
        let left_modified = fs::metadata(left)
            .and_then(|meta| meta.modified())
            .ok();
        let right_modified = fs::metadata(right)
            .and_then(|meta| meta.modified())
            .ok();
        right_modified.cmp(&left_modified)
    });
    Ok(files)
}

fn legend_preview_summary_from_path(path: &Path, trial: bool) -> LegendPreviewSummary {
    let preview_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("preview")
        .to_owned();
    LegendPreviewSummary {
        preview_path: path.to_string_lossy().into_owned(),
        preview_id,
        created_at: String::new(),
        mode: if trial { "trial".into() } else { "full".into() },
        revision: 0,
        changed_lines: 0,
        source_path: String::new(),
    }
}

fn legend_preview_metadata_from_file(
    preview_path: &Path,
) -> CommandResult<LegendPreviewMetadata> {
    let bytes = fs::read(preview_path)
        .map_err(|error| CommandError::io("Đọc preview Legend", error))?;
    if bytes.len() as u64 > MAX_SPILLED_RESULT_BYTES {
        return Err(CommandError::new(
            "legend_preview_too_large",
            "Preview Legend vượt quá giới hạn 64 MiB",
        ));
    }
    let artifact: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::new(
            "legend_preview_invalid",
            format!("Preview Legend không hợp lệ: {error}"),
        )
    })?;
    let artifact = artifact.as_object().ok_or_else(|| {
        CommandError::new(
            "legend_preview_invalid",
            "Preview Legend phải là JSON object",
        )
    })?;
    let preview_id = artifact
        .get("previewId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new("legend_preview_invalid", "Preview Legend thiếu previewId")
        })?;
    let source_path = artifact
        .get("source")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| {
            CommandError::new("legend_preview_invalid", "Preview Legend thiếu source")
        })?;
    let source_fingerprint = artifact
        .get("sourceFingerprint")
        .or_else(|| artifact.get("fingerprint"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new(
                "legend_preview_invalid",
                "Preview Legend thiếu fingerprint",
            )
        })?;
    Ok(LegendPreviewMetadata {
        preview_id: preview_id.to_owned(),
        source_path,
        source_fingerprint: source_fingerprint.to_owned(),
        created_at: artifact
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        preview_path: preview_path.to_path_buf(),
        revision: artifact
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(1),
        mode: artifact
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("full")
            .to_owned(),
        glossary_hash: artifact
            .get("glossaryHash")
            .and_then(Value::as_str)
            .map(str::to_owned),
        qa_stale_reason: None,
    })
}

fn load_legend_preview(
    state: &AppState,
    expected_preview_id: Option<&str>,
    trial: bool,
) -> CommandResult<LegendTranslationPreview> {
    let data = state.data()?;
    let metadata = if trial {
        data.legend_trial_preview.clone()
    } else {
        data.legend_preview.clone()
    }
    .ok_or_else(|| {
        CommandError::new(
            "legend_preview_not_found",
            "Chưa có bản xem trước dịch Legend hợp lệ",
        )
    })?;
    drop(data);
    if expected_preview_id.is_some_and(|id| id != metadata.preview_id) {
        return Err(CommandError::new(
            "legend_preview_stale",
            "previewId không còn là bản xem trước Legend mới nhất",
        ));
    }
    if !path_under_roots(
        &metadata.preview_path,
        std::slice::from_ref(&legend_preview_trusted_root(state, trial)),
    ) {
        return Err(CommandError::new(
            "legend_preview_untrusted",
            "Metadata preview Legend nằm ngoài AppData",
        ));
    }
    let bytes = fs::read(&metadata.preview_path)
        .map_err(|error| CommandError::io("Đọc preview Legend", error))?;
    if bytes.len() as u64 > MAX_SPILLED_RESULT_BYTES {
        return Err(CommandError::new(
            "legend_preview_too_large",
            "Preview Legend vượt quá giới hạn 64 MiB",
        ));
    }
    let artifact: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::new(
            "legend_preview_invalid",
            format!("Preview Legend không hợp lệ: {error}"),
        )
    })?;
    let artifact = artifact.as_object().ok_or_else(|| {
        CommandError::new(
            "legend_preview_invalid",
            "Preview Legend phải là JSON object",
        )
    })?;
    let artifact_source = artifact
        .get("source")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| {
            CommandError::new("legend_preview_invalid", "Preview Legend thiếu source")
        })?;
    if artifact_source.canonicalize().ok() != metadata.source_path.canonicalize().ok() {
        return Err(CommandError::new(
            "legend_preview_stale",
            "source trong preview không khớp metadata",
        ));
    }
    let mut preview = parse_legend_preview(artifact, &metadata.source_path)?;
    if expected_preview_id.is_some_and(|id| id != preview.preview_id) {
        return Err(CommandError::new(
            "legend_preview_stale",
            "previewId không còn là bản xem trước Legend mới nhất",
        ));
    }
    let metadata_stale = preview.preview_id != metadata.preview_id
        || PathBuf::from(&preview.source_path) != metadata.source_path
        || preview.source_fingerprint != metadata.source_fingerprint
        || preview.created_at != metadata.created_at
        || preview.revision != metadata.revision
        || preview.mode != metadata.mode
        || preview.glossary_hash != metadata.glossary_hash;
    if metadata_stale {
        let repaired = LegendPreviewMetadata {
            preview_id: preview.preview_id.clone(),
            source_path: PathBuf::from(&preview.source_path),
            source_fingerprint: preview.source_fingerprint.clone(),
            created_at: preview.created_at.clone(),
            preview_path: metadata.preview_path.clone(),
            revision: preview.revision,
            mode: preview.mode.clone(),
            glossary_hash: preview.glossary_hash.clone(),
            qa_stale_reason: None,
        };
        let mut data = state.data()?;
        if trial {
            data.legend_trial_preview = Some(repaired);
        } else {
            data.legend_preview = Some(repaired);
        }
        state.save_snapshot()?;
    }
    preview.qa_stale_reason = metadata.qa_stale_reason.or_else(|| {
        if preview.glossary_hash.is_none() || metadata.glossary_hash.is_none() {
            Some("Preview cũ chưa có glossary hash; cần chạy lại QA".to_owned())
        } else if preview.glossary_hash != metadata.glossary_hash {
            Some("Glossary hash của preview không khớp metadata".to_owned())
        } else {
            None
        }
    });
    Ok(preview)
}

#[tauri::command]
pub async fn get_legend_translation_preview(
    mode: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Option<LegendTranslationPreview>> {
    let _ = mode;
    if state.data()?.legend_preview.is_none() {
        return Ok(None);
    }
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || load_legend_preview(&state, None, false).map(Some))
        .await
        .map_err(|error| {
            CommandError::new(
                "join_failed",
                format!("Không tải được preview Legend: {error}"),
            )
        })?
}

const LEGEND_DIFFS_PAGE_MAX: u64 = 100;

fn legend_diff_matches_filter(
    diff: &LegendTranslationDiff,
    filter: &str,
    error_lines: &std::collections::HashSet<u64>,
    warning_lines: &std::collections::HashSet<u64>,
    line_filter: Option<&std::collections::HashSet<u64>>,
) -> bool {
    if let Some(wanted) = line_filter {
        if !wanted.contains(&diff.line_number) {
            return false;
        }
    }
    match filter {
        "han" => legend_text_has_han(legend_diff_effective_target(diff)),
        "error" => error_lines.contains(&diff.line_number),
        "warning" => {
            warning_lines.contains(&diff.line_number) && !error_lines.contains(&diff.line_number)
        }
        _ => true,
    }
}

fn read_active_legend_preview_value(
    state: &AppState,
) -> CommandResult<(LegendPreviewMetadata, Value)> {
    let metadata = state.data()?.legend_preview.clone().ok_or_else(|| {
        CommandError::new("legend_preview_not_found", "Không tìm thấy preview")
    })?;
    if !path_under_roots(
        &metadata.preview_path,
        std::slice::from_ref(&legend_preview_trusted_root(state, false)),
    ) {
        return Err(CommandError::new(
            "legend_preview_untrusted",
            "Metadata preview Legend nằm ngoài AppData",
        ));
    }
    let bytes = fs::read(&metadata.preview_path)
        .map_err(|error| CommandError::io("Đọc preview Legend", error))?;
    if bytes.len() as u64 > MAX_SPILLED_RESULT_BYTES {
        return Err(CommandError::new(
            "legend_preview_too_large",
            "Preview Legend vượt quá giới hạn 64 MiB",
        ));
    }
    let artifact: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::new(
            "legend_preview_invalid",
            format!("Preview Legend không hợp lệ: {error}"),
        )
    })?;
    if !artifact.is_object() {
        return Err(CommandError::new(
            "legend_preview_invalid",
            "Preview Legend phải là JSON object",
        ));
    }
    Ok((metadata, artifact))
}

fn legend_preview_qa_line_index(
    object: &Map<String, Value>,
) -> (
    std::collections::HashSet<u64>,
    std::collections::HashSet<u64>,
    std::collections::HashMap<u64, Vec<LegendQaIssue>>,
) {
    let mut error_lines = std::collections::HashSet::new();
    let mut warning_lines = std::collections::HashSet::new();
    let mut issues_by_line: std::collections::HashMap<u64, Vec<LegendQaIssue>> =
        std::collections::HashMap::new();
    if let Some(issues) = object
        .get("qa")
        .and_then(Value::as_object)
        .and_then(|qa| qa.get("issues"))
        .and_then(Value::as_array)
    {
        for issue in issues.iter().filter_map(Value::as_object) {
            let parsed = parse_legend_qa_issue(issue);
            if parsed.line_number == 0 {
                continue;
            }
            if parsed.severity == "error" {
                error_lines.insert(parsed.line_number);
            } else {
                warning_lines.insert(parsed.line_number);
            }
            issues_by_line
                .entry(parsed.line_number)
                .or_default()
                .push(parsed);
        }
    }
    (error_lines, warning_lines, issues_by_line)
}

fn list_legend_preview_diffs_sync(
    state: &AppState,
    filter: &str,
    offset: u64,
    limit: u64,
    line_filter: Option<&str>,
    include_line_refs: bool,
) -> CommandResult<LegendPreviewDiffsPage> {
    let (metadata, artifact) = read_active_legend_preview_value(state)?;
    let object = artifact.as_object().ok_or_else(|| {
        CommandError::new(
            "legend_preview_invalid",
            "Preview Legend phải là JSON object",
        )
    })?;
    let (error_lines, warning_lines, mut issues_by_line) = legend_preview_qa_line_index(object);
    let wanted = line_filter.and_then(parse_legend_line_filter);
    let mut selected_total = 0u64;
    let mut han_total = 0u64;
    let mut matched_index = 0u64;
    let mut entries = Vec::new();
    let mut line_refs = Vec::new();
    let take = (limit.clamp(1, LEGEND_DIFFS_PAGE_MAX)) as usize;
    if let Some(rows) = object.get("diffs").and_then(Value::as_array) {
        for row in rows.iter().filter_map(Value::as_object) {
            let diff = parse_legend_diff(row);
            if diff.selected {
                selected_total += 1;
            }
            if legend_text_has_han(legend_diff_effective_target(&diff)) {
                han_total += 1;
            }
            if !legend_diff_matches_filter(
                &diff,
                filter,
                &error_lines,
                &warning_lines,
                wanted.as_ref(),
            ) {
                continue;
            }
            if include_line_refs {
                line_refs.push(LegendPreviewLineRef {
                    line_number: diff.line_number,
                    selected: diff.selected,
                    error: error_lines.contains(&diff.line_number),
                });
            }
            if matched_index >= offset && entries.len() < take {
                entries.push(diff);
            }
            matched_index += 1;
        }
    }
    let mut issues = Vec::new();
    for diff in &entries {
        if let Some(list) = issues_by_line.remove(&diff.line_number) {
            issues.extend(list);
        }
    }
    let preview_id = object
        .get("previewId")
        .and_then(Value::as_str)
        .unwrap_or(&metadata.preview_id)
        .to_owned();
    Ok(LegendPreviewDiffsPage {
        preview_id,
        filter: filter.to_owned(),
        offset,
        limit: take as u64,
        total: matched_index,
        selected_total,
        han_total,
        error_total: error_lines.len() as u64,
        warning_total: warning_lines.len() as u64,
        entries,
        issues,
        line_refs,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_legend_preview_diffs(
    filter: Option<String>,
    offset: Option<u64>,
    limit: Option<u64>,
    line_filter: Option<String>,
    include_line_refs: Option<bool>,
    state: State<'_, AppState>,
) -> CommandResult<LegendPreviewDiffsPage> {
    let filter = filter.unwrap_or_else(|| "all".into());
    if !matches!(filter.as_str(), "all" | "han" | "error" | "warning") {
        return Err(CommandError::new(
            "legend_preview_filter_invalid",
            "filter phải là all, han, error hoặc warning",
        ));
    }
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(25);
    let include_line_refs = include_line_refs.unwrap_or(false);
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_legend_preview_diffs_sync(
            &state,
            &filter,
            offset,
            limit,
            line_filter.as_deref(),
            include_line_refs,
        )
    })
    .await
    .map_err(|error| {
        CommandError::new(
            "join_failed",
            format!("Không tải được trang diff Legend: {error}"),
        )
    })?
}

#[tauri::command]
pub async fn list_legend_preview_han_lines(
    state: State<'_, AppState>,
) -> CommandResult<Vec<u64>> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let refs = list_legend_preview_line_refs_sync(&state, "han", None)?;
        Ok(refs.into_iter().map(|row| row.line_number).collect())
    })
    .await
    .map_err(|error| {
        CommandError::new(
            "join_failed",
            format!("Không liệt kê được dòng còn Hán: {error}"),
        )
    })?
}

fn list_legend_preview_line_refs_sync(
    state: &AppState,
    filter: &str,
    line_filter: Option<&str>,
) -> CommandResult<Vec<LegendPreviewLineRef>> {
    let (_metadata, artifact) = read_active_legend_preview_value(state)?;
    let object = artifact.as_object().ok_or_else(|| {
        CommandError::new(
            "legend_preview_invalid",
            "Preview Legend phải là JSON object",
        )
    })?;
    let (error_lines, warning_lines, _) = legend_preview_qa_line_index(object);
    let wanted = line_filter.and_then(parse_legend_line_filter);
    let mut refs = Vec::new();
    if let Some(rows) = object.get("diffs").and_then(Value::as_array) {
        for row in rows.iter().filter_map(Value::as_object) {
            let diff = parse_legend_diff(row);
            if !legend_diff_matches_filter(
                &diff,
                filter,
                &error_lines,
                &warning_lines,
                wanted.as_ref(),
            ) {
                continue;
            }
            refs.push(LegendPreviewLineRef {
                line_number: diff.line_number,
                selected: diff.selected,
                error: error_lines.contains(&diff.line_number),
            });
        }
    }
    Ok(refs)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_legend_preview_line_refs(
    filter: Option<String>,
    line_filter: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<LegendPreviewLineRef>> {
    let filter = filter.unwrap_or_else(|| "all".into());
    if !matches!(filter.as_str(), "all" | "han" | "error" | "warning") {
        return Err(CommandError::new(
            "legend_preview_filter_invalid",
            "filter phải là all, han, error hoặc warning",
        ));
    }
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_legend_preview_line_refs_sync(&state, &filter, line_filter.as_deref())
    })
    .await
    .map_err(|error| {
        CommandError::new(
            "join_failed",
            format!("Không liệt kê được dòng preview Legend: {error}"),
        )
    })?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_legend_previews(
    mode: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<LegendPreviewSummary>> {
    let _ = mode;
    let state = (*state).clone();
    spawn_command(move || list_legend_previews_sync(&state)).await
}

fn list_legend_previews_sync(state: &AppState) -> CommandResult<Vec<LegendPreviewSummary>> {
    let dir = legend_preview_directory(state);
    Ok(scan_legend_preview_json_files(&dir)?
        .into_iter()
        .map(|path| legend_preview_summary_from_path(&path, false))
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn adopt_legend_preview_from_path(
    preview_path: String,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<LegendTranslationPreview> {
    let _ = mode;
    let trial = false;
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        adopt_legend_preview_from_path_sync(preview_path, trial, &state)
    })
    .await
    .map_err(|error| {
        CommandError::new(
            "join_failed",
            format!("Không adopt được preview Legend: {error}"),
        )
    })?
}

fn adopt_legend_preview_from_path_sync(
    preview_path: String,
    trial: bool,
    state: &AppState,
) -> CommandResult<LegendTranslationPreview> {
    let path = PathBuf::from(preview_path.trim());
    if path.as_os_str().is_empty() {
        return Err(CommandError::new(
            "legend_preview_invalid",
            "previewPath không được để trống",
        ));
    }
    if !path_under_roots(
        &path,
        std::slice::from_ref(&legend_preview_trusted_root(state, trial)),
    ) {
        return Err(CommandError::new(
            "legend_preview_untrusted",
            "Preview Legend phải nằm trong AppData",
        ));
    }
    let metadata = legend_preview_metadata_from_file(&path)?;
    if metadata.mode == "trial" || trial {
        return Err(CommandError::new(
            "legend_preview_invalid",
            "Bản dịch thử không còn được hỗ trợ; hãy dịch lại toàn bộ rồi duyệt từng câu",
        ));
    }
    {
        let mut data = state.data()?;
        data.legend_source_path = Some(metadata.source_path.clone());
        if trial {
            data.legend_trial_preview = Some(metadata);
        } else {
            data.legend_preview = Some(metadata);
        }
    }
    state.save_snapshot()?;
    load_legend_preview(state, None, trial)
}

#[tauri::command]
pub fn get_legend_source_path(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    Ok(state
        .data()?
        .legend_source_path
        .as_ref()
        .map(|path| tool_paths::display_windows_path(path)))
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_legend_deploy_path(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    Ok(state
        .data()?
        .legend_deploy_path
        .as_ref()
        .map(|path| tool_paths::display_windows_path(path)))
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_legend_deploy_path(
    deploy_path: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<String>> {
    let trimmed = deploy_path.trim();
    let resolved = if trimmed.is_empty() {
        None
    } else {
        Some(validate_legend_deploy_path(Path::new(trimmed))?)
    };
    {
        let mut data = state.data()?;
        data.legend_deploy_path = resolved.clone();
    }
    state.save_snapshot()?;
    Ok(resolved.map(|path| tool_paths::display_windows_path(&path)))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sync_legend_staged(
    preview_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let app = app.clone();
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || sync_legend_staged_sync(preview_id, app, &state))
        .await
        .map_err(|error| {
            CommandError::new(
                "join_failed",
                format!("Không đồng bộ được staged Legend: {error}"),
            )
        })?
}

fn sync_legend_staged_sync(
    preview_id: String,
    app: AppHandle,
    state: &AppState,
) -> CommandResult<String> {
    reject_while_running(state)?;
    let metadata =
        state.data()?.legend_preview.clone().ok_or_else(|| {
            CommandError::new("legend_preview_not_found", "Không tìm thấy preview")
        })?;
    if metadata.preview_id != preview_id {
        return Err(CommandError::new(
            "legend_preview_stale",
            "previewId không khớp preview Legend hiện tại",
        ));
    }
    let app_config = state.data()?.app.config.clone();
    let payload = run_engine_sync(
        &app,
        state,
        "legend-sync-staged",
        &legend_sync_staged_config(&metadata.preview_path, &preview_id),
        &app_config,
        &[],
        app_config.timeout_seconds,
        false,
    )?;
    let staged_path = payload
        .get("stagedPath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            CommandError::new(
                "legend_staged_missing",
                "Engine không trả về đường dẫn file staged",
            )
        })?;
    if !path_under_roots(
        &staged_path,
        std::slice::from_ref(&legend_preview_directory(state)),
    ) {
        return Err(CommandError::new(
            "legend_staged_untrusted",
            "File staged Legend nằm ngoài AppData",
        ));
    }
    let repaired = legend_preview_metadata_from_file(&metadata.preview_path)?;
    let mut data = state.data()?;
    if data
        .legend_preview
        .as_ref()
        .is_some_and(|current| current.preview_id == preview_id)
    {
        data.legend_preview = Some(repaired);
    }
    state.save_snapshot()?;
    Ok(staged_path.to_string_lossy().into_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_legend_translation_preview(
    preview_id: String,
    edits: Vec<LegendPreviewEdit>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LegendTranslationPreview> {
    let app = app.clone();
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        update_legend_translation_preview_sync(preview_id, edits, app, &state)
    })
    .await
    .map_err(|error| {
        CommandError::new(
            "join_failed",
            format!("Không cập nhật được preview Legend: {error}"),
        )
    })?
}

fn update_legend_translation_preview_sync(
    preview_id: String,
    edits: Vec<LegendPreviewEdit>,
    app: AppHandle,
    state: &AppState,
) -> CommandResult<LegendTranslationPreview> {
    reject_while_running(state)?;
    let current = load_legend_preview(state, Some(&preview_id), false)?;
    let metadata =
        state.data()?.legend_preview.clone().ok_or_else(|| {
            CommandError::new("legend_preview_not_found", "Không tìm thấy preview")
        })?;
    let app_config = state.data()?.app.config.clone();
    run_engine_sync(
        &app,
        state,
        "legend-rebuild",
        &legend_rebuild_config(
            &metadata.preview_path,
            &legend_glossary_path(state),
            &preview_id,
            &edits,
        ),
        &app_config,
        &[],
        app_config.timeout_seconds,
        false,
    )?;
    let bytes = fs::read(&metadata.preview_path)
        .map_err(|error| CommandError::io("Đọc preview Legend đã sửa", error))?;
    if bytes.len() as u64 > MAX_SPILLED_RESULT_BYTES {
        return Err(CommandError::new(
            "legend_preview_too_large",
            "Preview Legend vượt quá giới hạn 64 MiB",
        ));
    }
    let artifact: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::new(
            "legend_preview_invalid",
            format!("Preview không hợp lệ: {error}"),
        )
    })?;
    let object = artifact
        .as_object()
        .ok_or_else(|| CommandError::new("legend_preview_invalid", "Preview phải là object"))?;
    let updated = parse_legend_preview(object, Path::new(&current.source_path))?;
    {
        let mut data = state.data()?;
        data.legend_preview = Some(LegendPreviewMetadata {
            preview_id: updated.preview_id.clone(),
            source_path: PathBuf::from(&updated.source_path),
            source_fingerprint: updated.source_fingerprint.clone(),
            created_at: updated.created_at.clone(),
            preview_path: metadata.preview_path,
            revision: updated.revision,
            mode: updated.mode.clone(),
            glossary_hash: updated.glossary_hash.clone(),
            qa_stale_reason: None,
        });
    }
    state.save_snapshot()?;
    Ok(updated)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn retranslate_legend_preview(
    preview_id: String,
    line_numbers: Vec<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LegendTranslationPreview> {
    let app = app.clone();
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        retranslate_legend_preview_sync(preview_id, line_numbers, app, &state)
    })
    .await
    .map_err(|error| {
        CommandError::new(
            "join_failed",
            format!("Không hoàn tất dịch lại chữ Hán: {error}"),
        )
    })?
}

fn retranslate_legend_preview_sync(
    preview_id: String,
    line_numbers: Vec<u64>,
    app: AppHandle,
    state: &AppState,
) -> CommandResult<LegendTranslationPreview> {
    reject_while_running(state)?;
    if line_numbers.is_empty() {
        return Err(CommandError::new(
            "legend_retranslate_empty",
            "Không có dòng còn chữ Hán để dịch lại",
        ));
    }
    let current = load_legend_preview(state, Some(&preview_id), false)?;
    if current.mode != "full" {
        return Err(CommandError::new(
            "legend_trial_retranslate_forbidden",
            "Không thể dịch lại từ bản dịch thử",
        ));
    }
    let metadata =
        state.data()?.legend_preview.clone().ok_or_else(|| {
            CommandError::new("legend_preview_not_found", "Không tìm thấy preview")
        })?;
    let (app_config, secrets) = {
        let data = state.data()?;
        let key_ids = legend_enabled_key_ids(&data)?;
        let mut secrets = Zeroizing::new(Vec::with_capacity(key_ids.len()));
        for key_id in &key_ids {
            secrets.push(credentials::get_secret(key_id)?);
        }
        (data.app.config.clone(), secrets)
    };
    let timeout_secs = LEGEND_RETRANSLATE_PROCESS_TIMEOUT_SECS;
    let sync_result = run_engine_sync(
        &app,
        state,
        "legend-retranslate",
        &legend_retranslate_config(
            &metadata.preview_path,
            &legend_root(state)
                .join("cache")
                .join(LEGEND_CACHE_FILENAME),
            &legend_glossary_path(state),
            &preview_id,
            &line_numbers,
            &app_config,
        ),
        &app_config,
        &secrets,
        timeout_secs,
        false,
    );
    drop(secrets);
    let preview_update = (|| -> CommandResult<LegendTranslationPreview> {
        let bytes = fs::read(&metadata.preview_path)
            .map_err(|error| CommandError::io("Đọc preview Legend đã dịch lại", error))?;
        if bytes.len() as u64 > MAX_SPILLED_RESULT_BYTES {
            return Err(CommandError::new(
                "legend_preview_too_large",
                "Preview Legend vượt quá giới hạn 64 MiB",
            ));
        }
        let artifact: Value = serde_json::from_slice(&bytes).map_err(|error| {
            CommandError::new(
                "legend_preview_invalid",
                format!("Preview không hợp lệ: {error}"),
            )
        })?;
        let object = artifact.as_object().ok_or_else(|| {
            CommandError::new("legend_preview_invalid", "Preview phải là object")
        })?;
        parse_legend_preview(object, Path::new(&current.source_path))
    })();
    let updated = match (sync_result, preview_update) {
        (Ok(_), Ok(updated)) => updated,
        (Err(error), Ok(updated))
            if matches!(error.code.as_str(), "engine_result_missing" | "engine_timeout")
                && updated.revision > current.revision =>
        {
            updated
        }
        (Err(error), _) => return Err(error),
        (Ok(_), Err(error)) => return Err(error),
    };
    {
        let mut data = state.data()?;
        data.legend_preview = Some(LegendPreviewMetadata {
            preview_id: updated.preview_id.clone(),
            source_path: PathBuf::from(&updated.source_path),
            source_fingerprint: updated.source_fingerprint.clone(),
            created_at: updated.created_at.clone(),
            preview_path: metadata.preview_path,
            revision: updated.revision,
            mode: updated.mode.clone(),
            glossary_hash: updated.glossary_hash.clone(),
            qa_stale_reason: None,
        });
    }
    state.save_snapshot()?;
    Ok(updated)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn apply_legend_translation(
    preview_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LegendTranslationApplyResult> {
    reject_while_running(&state)?;
    let app = app.clone();
    let state = (*state).clone();
    spawn_command(move || apply_legend_translation_sync(&app, &state, preview_id)).await
}

fn apply_legend_translation_sync(
    app: &AppHandle,
    state: &AppState,
    preview_id: String,
) -> CommandResult<LegendTranslationApplyResult> {
    let preview = load_legend_preview(&state, Some(&preview_id), false)?;
    if preview.mode != "full" {
        return Err(CommandError::new(
            "legend_trial_apply_forbidden",
            "Bản dịch thử không được phép áp dụng",
        ));
    }
    if preview.qa.blocking
        || preview.qa.revision != preview.revision
        || preview.qa_stale_reason.is_some()
        || preview.glossary_hash.is_none()
    {
        return Err(CommandError::new(
            "legend_qa_blocking",
            "QA Legend còn lỗi hoặc đã stale; hãy sửa trước khi áp dụng",
        ));
    }
    let source_path = validate_legend_source(Path::new(&preview.source_path))?;
    ensure_legend_directories(&state)?;
    let metadata =
        state.data()?.legend_preview.clone().ok_or_else(|| {
            CommandError::new("legend_preview_not_found", "Không tìm thấy preview")
        })?;
    let backup_dir = legend_backup_directory(&state);
    let app_config = state.data()?.app.config.clone();
    let deploy_path = state.data()?.legend_deploy_path.clone();
    let payload = run_engine_sync(
        &app,
        &state,
        "legend-apply",
        &legend_apply_config(
            &source_path,
            &metadata.preview_path,
            &backup_dir,
            &preview_id,
            &legend_glossary_path(&state),
            deploy_path.as_deref(),
        ),
        &app_config,
        &[],
        app_config.timeout_seconds,
        false,
    )?;
    let result = parse_legend_apply_result(&payload, &preview_id, &source_path)?;
    let backup_path = PathBuf::from(&result.backup_path);
    if !path_under_roots(&backup_path, std::slice::from_ref(&backup_dir)) {
        return Err(CommandError::new(
            "legend_backup_untrusted",
            "Engine trả về backupPath nằm ngoài AppData",
        ));
    }
    {
        let mut data = state.data()?;
        if data
            .legend_preview
            .as_ref()
            .is_none_or(|current| current.preview_id != preview_id)
        {
            return Err(CommandError::new(
                "legend_preview_stale",
                "Preview Legend đã thay đổi trong lúc apply",
            ));
        }
        data.legend_source_path = Some(source_path);
        data.legend_preview = None;
        refresh_backups(&mut data, &state.app_data_dir)?;
    }
    state.save_snapshot()?;
    Ok(result)
}

#[tauri::command]
pub async fn list_legend_backups(state: State<'_, AppState>) -> CommandResult<Vec<LegendBackup>> {
    ensure_legend_directories(&state)?;
    let state = (*state).clone();
    spawn_command(move || list_legend_backups_sync(&state)).await
}

fn list_legend_backups_sync(state: &AppState) -> CommandResult<Vec<LegendBackup>> {
    {
        let mut data = state.data()?;
        refresh_backups(&mut data, &state.app_data_dir)?;
    }
    let root = legend_backup_directory(state);
    let mut backups = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|error| CommandError::io("Đọc backup Legend", error))?
    {
        let path = entry
            .map_err(|error| CommandError::io("Đọc backup Legend", error))?
            .path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let Ok(bytes) = fs::read(&manifest_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let Some(manifest) = value.as_object() else {
            continue;
        };
        if manifest.get("adapter").and_then(Value::as_str) != Some("legend-three-kingdoms") {
            continue;
        }
        backups.push(LegendBackup {
            id: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_owned(),
            created_at: manifest
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            source_path: tool_paths::simplify_windows_path_text(
                manifest
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ),
            backup_path: tool_paths::display_windows_path(&path),
            source_fingerprint: manifest
                .get("sourceFingerprint")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            applied_fingerprint: manifest
                .get("appliedFingerprint")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            valid: manifest
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            safety: manifest.get("reason").and_then(Value::as_str) == Some("pre-restore-safety"),
        });
    }
    backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(backups)
}

fn trusted_legend_backup(state: &AppState, backup_id: &str) -> CommandResult<PathBuf> {
    if backup_id.is_empty()
        || backup_id.contains(['/', '\\'])
        || backup_id == "."
        || backup_id == ".."
    {
        return Err(CommandError::new(
            "legend_backup_invalid",
            "backupId không hợp lệ",
        ));
    }
    let root = legend_backup_directory(state);
    let path = root.join(backup_id);
    if !path_under_roots(&path, std::slice::from_ref(&root)) || !path.is_dir() {
        return Err(CommandError::new(
            "legend_backup_not_found",
            "Không tìm thấy backup Legend",
        ));
    }
    Ok(path)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn restore_legend_backup(
    backup_id: String,
    force: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    reject_while_running(&state)?;
    let app = app.clone();
    let state = (*state).clone();
    spawn_command(move || restore_legend_backup_sync(&app, &state, backup_id, force)).await
}

fn restore_legend_backup_sync(
    app: &AppHandle,
    state: &AppState,
    backup_id: String,
    force: Option<bool>,
) -> CommandResult<String> {
    let backup = trusted_legend_backup(&state, &backup_id)?;
    let manifest_path = backup.join("manifest.json");
    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|error| CommandError::io("Đọc manifest backup Legend", error))?,
    )
    .map_err(|error| {
        CommandError::new(
            "legend_backup_invalid",
            format!("Manifest backup Legend không hợp lệ: {error}"),
        )
    })?;
    let manifest = manifest.as_object().ok_or_else(|| {
        CommandError::new("legend_backup_invalid", "Manifest backup phải là object")
    })?;
    if manifest.get("adapter").and_then(Value::as_str) != Some("legend-three-kingdoms") {
        return Err(CommandError::new(
            "legend_backup_adapter_mismatch",
            "Backup không thuộc adapter Legend",
        ));
    }
    let manifest_source = PathBuf::from(
        manifest
            .get("source")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CommandError::new("legend_backup_invalid", "Manifest backup thiếu source")
            })?,
    );
    let backup_file = PathBuf::from(
        manifest
            .get("backupFile")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CommandError::new("legend_backup_invalid", "Manifest backup thiếu backupFile")
            })?,
    );
    if !path_under_roots(&backup_file, std::slice::from_ref(&backup)) || !backup_file.is_file() {
        return Err(CommandError::new(
            "legend_backup_untrusted",
            "backupFile nằm ngoài thư mục backup tin cậy",
        ));
    }
    let data = state.data()?;
    let expected_source = data.legend_source_path.clone().ok_or_else(|| {
        CommandError::new(
            "legend_restore_source_required",
            "Hãy chọn và kiểm tra đúng file đích trước khi restore",
        )
    })?;
    let config = data.app.config.clone();
    drop(data);
    let manifest_source_canonical = manifest_source
        .canonicalize()
        .map_err(|error| CommandError::io("Xác minh source trong backup Legend", error))?;
    let expected_source_canonical = expected_source
        .canonicalize()
        .map_err(|error| CommandError::io("Xác minh file Legend đang chọn", error))?;
    if manifest_source_canonical != expected_source_canonical {
        return Err(CommandError::new(
            "legend_restore_source_mismatch",
            "Backup không thuộc file đang được chọn; hãy mở đúng file trước khi restore",
        ));
    }
    let payload = run_engine_sync(
        &app,
        &state,
        "legend-restore",
        &legend_restore_config(&backup, &expected_source, force.unwrap_or(false)),
        &config,
        &[],
        config.timeout_seconds,
        false,
    )?;
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::new(
                "legend_restore_result_invalid",
                "Engine restore thiếu source",
            )
        })?
        .to_owned();
    {
        let mut data = state.data()?;
        data.legend_source_path = Some(PathBuf::from(&source));
        data.legend_preview = None;
        data.legend_trial_preview = None;
        refresh_backups(&mut data, &state.app_data_dir)?;
    }
    state.save_snapshot()?;
    Ok(source)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_legend_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    reject_while_running(&state)?;
    let state = (*state).clone();
    spawn_command(move || delete_legend_backup_sync(&state, &backup_id)).await
}

fn delete_legend_backup_sync(state: &AppState, backup_id: &str) -> CommandResult<()> {
    let backup = trusted_legend_backup(state, backup_id)?;
    fs::remove_dir_all(&backup).map_err(|error| CommandError::io("Xóa backup Legend", error))?;
    {
        let mut data = state.data()?;
        refresh_backups(&mut data, &state.app_data_dir)?;
    }
    state.save_snapshot()
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_legend_backup_folder(
    backup_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let backup = trusted_legend_backup(&state, &backup_id)?;
    app.opener()
        .open_path(backup.to_string_lossy(), None::<&str>)
        .map_err(|error| CommandError::new("open_failed", error.to_string()))
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
    if let Ok(mut starting) = state.starting_job.lock() {
        if starting
            .as_ref()
            .is_some_and(|pending| pending.job_id == job_id)
        {
            starting.take();
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
        assert_eq!(
            step_status_after_completion(false, None),
            StepStatus::Success
        );
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
                    (
                        "invalid".into(),
                        Value::Array(vec![Value::Object(Map::new())]),
                    ),
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
                                ("file".into(), Value::String("Base/Text.xml".into())),
                                ("status".into(), Value::String("english-only".into())),
                            ])),
                            Value::Object(Map::from_iter([
                                ("file".into(), Value::String("DLC/Text.xml".into())),
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
        assert_eq!(
            snapshot.diffs[1].missing_in_vietnamese[0].tag.as_deref(),
            Some("LOC_NEW")
        );
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
        data.app.config.export_path = std::env::temp_dir().join("loc-tool-export");
        data.app.config.mod_path = std::env::temp_dir().join("loc-tool-mod");
        data.app.config.report_path = std::env::temp_dir().join("loc-tool-reports");
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
        let directory = std::env::temp_dir().join(format!("loc-tool-spill-test-{}", now_millis()));
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
        hydrate_spilled_result_payload(&mut payload, &[std::env::temp_dir()]).expect("hydrate");
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

    #[test]
    fn legend_translate_config_matches_python_contract() {
        let mut config = AppConfig::default();
        config.model = "model-primary".into();
        config.fallback_models = vec!["model-fallback".into()];
        config.delay_ms = 1_250;
        config.timeout_seconds = 90;
        config.batch_size = 25;
        config.max_api_calls = 12;
        let value = legend_translate_config(
            Path::new(r"C:\Legend.txt"),
            Path::new(r"C:\AppData\legend\previews\p1.json"),
            Path::new(r"C:\AppData\legend\cache\translation-cache.json"),
            Path::new(r"C:\AppData\legend\glossary.json"),
            &config,
            "full",
            30,
            true,
        );

        assert_eq!(value["model"], "model-primary");
        assert_eq!(value["fallbackModels"][0], "model-fallback");
        assert_eq!(value["delaySeconds"], 1.25);
        assert_eq!(value["timeoutSeconds"], 90);
        assert_eq!(value["batchSize"], 25);
        assert_eq!(value["maxApiCalls"], 12);
        assert_eq!(value["mode"], "full");
        assert_eq!(value["trialLimit"], 30);
        assert_eq!(value["forceRetranslate"], true);
        assert_eq!(value["glossaryPath"], r"C:\AppData\legend\glossary.json");
        assert!(value.get("gameDir").is_none());
        assert!(value.get("targetDir").is_none());
    }

    #[test]
    fn legend_retranslate_runs_without_process_watchdog() {
        assert_eq!(LEGEND_RETRANSLATE_PROCESS_TIMEOUT_SECS, 0);
    }

    #[test]
    fn legend_retranslate_caps_api_batch_at_15() {
        let mut config = AppConfig::default();
        config.batch_size = 40;
        assert_eq!(legend_retranslate_batch_size(&config), 15);
        config.batch_size = 8;
        assert_eq!(legend_retranslate_batch_size(&config), 8);
    }

    #[test]
    fn legend_retranslate_config_matches_python_contract() {
        let mut config = AppConfig::default();
        config.model = "model-primary".into();
        config.fallback_models = vec!["model-fallback".into()];
        config.delay_ms = 1_250;
        config.timeout_seconds = 90;
        config.batch_size = 25;
        config.max_api_calls = 12;
        let value = legend_retranslate_config(
            Path::new(r"C:\AppData\legend\previews\p1.json"),
            Path::new(r"C:\AppData\legend\cache\translation-cache.json"),
            Path::new(r"C:\AppData\legend\glossary.json"),
            "preview-1",
            &[2, 7],
            &config,
        );

        assert_eq!(value["previewId"], "preview-1");
        assert_eq!(value["lineNumbers"][0], 2);
        assert_eq!(value["lineNumbers"][1], 7);
        assert_eq!(value["model"], "model-primary");
        assert_eq!(value["fallbackModels"][0], "model-fallback");
        assert_eq!(value["delaySeconds"], 1.25);
        assert_eq!(value["timeoutSeconds"], 90);
        assert_eq!(value["batchSize"], 15);
        assert_eq!(value["maxApiCalls"], 12);
        assert_eq!(
            value["cachePath"],
            r"C:\AppData\legend\cache\translation-cache.json"
        );
        assert_eq!(value["glossaryPath"], r"C:\AppData\legend\glossary.json");
    }

    #[test]
    fn legend_python_results_map_to_tauri_contract() {
        let source = Path::new(r"C:\Legend.txt");
        let inspection = parse_legend_inspection(
            &Map::from_iter([
                ("fingerprint".into(), Value::String("source-hash".into())),
                (
                    "inspection".into(),
                    serde_json::json!({
                        "encoding": "utf-8-sig",
                        "bom": true,
                        "lineEndings": {"CRLF": 4},
                        "lines": 4,
                        "entries": 3,
                        "duplicates": 1,
                        "invalidLines": 0
                    }),
                ),
                (
                    "sample".into(),
                    serde_json::json!([{
                        "line": 2,
                        "source": "源",
                        "currentTarget": "Cũ"
                    }]),
                ),
                (
                    "warnings".into(),
                    serde_json::json!([{"message": "Cảnh báo"}]),
                ),
            ]),
            source,
        )
        .expect("inspection");
        assert_eq!(inspection.source_path, r"C:\Legend.txt");
        assert_eq!(inspection.newline, "crlf");
        assert!(inspection.has_bom);
        assert_eq!(inspection.sample[0].line_number, 2);
        assert_eq!(inspection.warnings, ["Cảnh báo"]);

        let payload = serde_json::json!({
            "previewId": "preview-hash",
            "createdAt": "2026-08-16T00:00:00Z",
            "fingerprint": "source-hash",
            "diffs": [{
                "line": 2,
                "source": "源",
                "oldTarget": "Cũ",
                "target": "Mới"
            }],
            "stats": {
                "uniqueSources": 3,
                "itemsTranslated": 2,
                "cacheHits": 1,
                "apiCalls": 1
            },
            "warnings": []
        });
        let object = payload.as_object().expect("object");
        let header = parse_legend_preview(object, source).expect("header");
        assert_eq!(header.preview_id, "preview-hash");
        assert!(header.diffs.is_empty());
        assert_eq!(header.diff_count, 1);
        assert_eq!(header.selected_count, 1);
        let preview = parse_legend_preview_with_rows(object, source, true).expect("preview");
        assert_eq!(preview.diffs[0].before, "Cũ");
        assert_eq!(preview.diffs[0].after, "Mới");
        assert!(preview.diffs[0].selected);
        assert_eq!(preview.mode, "full");
        assert!(preview.qa.blocking);
        assert_eq!(preview.stats.items_total, 3);

        let applied = parse_legend_apply_result(
            serde_json::json!({
                "previewId": "preview-hash",
                "backup": r"C:\AppData\legend\backups\b1",
                "stats": {"changed": 1}
            })
            .as_object()
            .expect("object"),
            "preview-hash",
            source,
        )
        .expect("apply");
        assert_eq!(applied.updated_lines, 1);
        assert_eq!(applied.backup_path, r"C:\AppData\legend\backups\b1");
    }

    #[test]
    fn legend_text_matches_supports_case_and_whole_word() {
        assert!(legend_text_matches("Lưu Bị đánh", "lưu bị", false, false));
        assert!(!legend_text_matches("Lưu Bị đánh", "lưu bị", true, false));
        assert!(legend_text_matches("Lưu Bị đánh", "Lưu Bị", true, true));
        assert!(!legend_text_matches("Lưu Biện", "Lưu Bị", false, true));
    }

    #[test]
    fn escape_legend_value_keeps_literal_escapes() {
        assert_eq!(escape_legend_value("Tây Xuyên"), "Tây Xuyên");
        assert_eq!(escape_legend_value("a=b"), r"a\=b");
        assert_eq!(escape_legend_value("đã có\\n"), "đã có\\n");
        assert_eq!(escape_legend_value("dòng\nmới"), "dòng\\nmới");
    }

    #[test]
    fn parse_legend_line_skips_escaped_equals_in_key() {
        assert!(first_unescaped_equals(r"a\=b").is_none());
        assert_eq!(first_unescaped_equals(r"a\\=b"), Some(3));
        assert_eq!(
            parse_legend_line(1, r"left=right").unwrap().source,
            "left"
        );
    }

    #[test]
    fn parse_legend_line_filter_ignores_non_numeric_tokens() {
        assert!(parse_legend_line_filter("abc").is_none());
        assert!(parse_legend_line_filter("   ").is_none());
        let wanted = parse_legend_line_filter("12, abc, 20-21").expect("numeric tokens");
        assert!(wanted.contains(&12));
        assert!(wanted.contains(&20));
        assert!(wanted.contains(&21));
        assert_eq!(wanted.len(), 3);
    }

    #[test]
    fn dedupe_legend_text_keeps_last_source_and_non_entries() {
        let text = "# comment\r\n武将=old\r\n\r\n白马=ngựa\r\n武将=new\r\ninvalid line\r\n武将=latest\r\n";
        let (kept, removed, remaining) = dedupe_legend_text(text);
        assert_eq!(removed, 2);
        assert_eq!(remaining, 2);
        assert_eq!(
            kept,
            "# comment\r\n\r\n白马=ngựa\r\ninvalid line\r\n武将=latest\r\n"
        );
    }

    #[test]
    fn trailing_escaped_equals_is_a_separator() {
        let line = parse_legend_line(
            1,
            r"攻击力提高20%，每只箭点燃附近的概率15%，点燃范围\=Tăng sức tấn công 20%",
        )
        .expect("entry");
        assert_eq!(line.kind, "entry");
        assert_eq!(
            line.source,
            "攻击力提高20%，每只箭点燃附近的概率15%，点燃范围="
        );
        assert_eq!(line.current_target, "Tăng sức tấn công 20%");
    }

    #[test]
    fn legend_protocol_accepts_python_event_step_aliases() {
        assert!(engine_event_step_matches("legend-inspect", "inspect"));
        assert!(engine_event_step_matches("legend-translate", "translate"));
        assert!(engine_event_step_matches("legend-estimate", "translate"));
        assert!(engine_event_step_matches("legend-rebuild", "translate"));
        assert!(engine_event_step_matches("legend-retranslate", "translate"));
        assert!(engine_event_step_matches("legend-sync-staged", "inspect"));
        assert!(engine_event_step_matches("legend-apply", "sync-apply"));
        assert!(engine_event_step_matches("legend-restore", "restore"));
        assert!(!engine_event_step_matches("legend-translate", "inspect"));
    }

    #[test]
    fn legend_translation_requires_enabled_key() {
        let mut data = PersistedData::default();
        assert_eq!(
            legend_enabled_key_ids(&data).expect_err("no key").code,
            "api_key_required"
        );
        data.app.api_keys.push(ApiKeyMeta {
            id: "key-1".into(),
            label: "Key 1".into(),
            masked_suffix: "1234".into(),
            priority: 1,
            enabled: false,
            status: KeyStatus::Unknown,
            last_used: None,
            local_requests: 0,
            active_since: None,
        });
        assert_eq!(
            legend_enabled_key_ids(&data)
                .expect_err("disabled key")
                .code,
            "api_key_required"
        );
    }

    #[test]
    fn global_job_gate_rejects_concurrent_legend_job() {
        let gate = AtomicBool::new(false);
        assert!(gate
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok());
        assert!(gate
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err());
    }

    #[test]
    fn legend_starting_job_can_be_cancelled_before_process_registration() {
        let app_data =
            std::env::temp_dir().join(format!("loc-tool-legend-cancel-test-{}", now_millis()));
        let state = AppState::initialize(app_data.clone()).expect("state");
        let requested = Arc::new(AtomicBool::new(false));
        {
            let mut starting = state.starting_job().expect("starting job");
            *starting = Some(StartingJob {
                job_id: "legend-starting".into(),
                cancel_requested: Arc::clone(&requested),
            });
        }

        assert!(request_starting_job_cancel(&state, "legend-starting").expect("cancel"));
        assert!(requested.load(Ordering::Acquire));
        assert_eq!(
            request_starting_job_cancel(&state, "other")
                .expect_err("mismatch")
                .code,
            "job_id_mismatch"
        );
        let _ = fs::remove_dir_all(app_data);
    }

    #[test]
    fn stale_legend_preview_id_is_rejected() {
        let app_data =
            std::env::temp_dir().join(format!("loc-tool-legend-stale-test-{}", now_millis()));
        let state = AppState::initialize(app_data.clone()).expect("state");
        {
            let mut data = state.data().expect("data");
            data.legend_preview = Some(LegendPreviewMetadata {
                preview_id: "new-preview".into(),
                source_path: PathBuf::from(r"C:\Legend.txt"),
                source_fingerprint: "sha256:test".into(),
                created_at: now_iso(),
                preview_path: legend_preview_directory(&state).join("new-preview.json"),
                revision: 1,
                mode: "full".into(),
                glossary_hash: Some("sha256:glossary".into()),
                qa_stale_reason: None,
            });
        }
        assert_eq!(
            load_legend_preview(&state, Some("old-preview"), false)
                .expect_err("stale")
                .code,
            "legend_preview_stale"
        );
        let _ = fs::remove_dir_all(app_data);
    }

    #[test]
    fn preview_is_trusted_under_previews_dir() {
        let app_data =
            std::env::temp_dir().join(format!("loc-tool-legend-preview-root-{}", now_millis()));
        let state = AppState::initialize(app_data.clone()).expect("state");
        ensure_legend_directories(&state).expect("dirs");
        let preview_path = legend_preview_directory(&state).join("legend-preview.json");
        fs::write(&preview_path, "{}").expect("write preview");

        assert!(path_under_roots(
            &preview_path,
            std::slice::from_ref(&legend_preview_trusted_root(&state, false)),
        ));
        let _ = fs::remove_dir_all(app_data);
    }
}
