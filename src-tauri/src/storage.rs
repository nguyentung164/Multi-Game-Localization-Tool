use crate::models::{
    now_iso, now_millis, Backup, CommandError, CommandResult, FrontendAppState, Report, StepId,
    StepStatus,
};
use crate::tool_paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Component, Path, PathBuf},
};

const PERSISTENCE_SCHEMA_VERSION: u16 = 2;
const MAX_STATE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 10_000;
const MAX_RESTORE_FILES: usize = 200_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    pub fingerprint: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployPreview {
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendPreviewMetadata {
    pub preview_id: String,
    pub source_path: PathBuf,
    pub source_fingerprint: String,
    pub created_at: String,
    pub preview_path: PathBuf,
    #[serde(default = "default_legend_revision")]
    pub revision: u64,
    #[serde(default = "default_legend_mode")]
    pub mode: String,
    #[serde(default)]
    pub glossary_hash: Option<String>,
    #[serde(default)]
    pub qa_stale_reason: Option<String>,
}

fn default_legend_revision() -> u64 {
    1
}

fn default_legend_mode() -> String {
    "full".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedData {
    pub schema_version: u16,
    pub app: FrontendAppState,
    #[serde(default)]
    pub sync_previews: BTreeMap<String, SyncPreview>,
    #[serde(default)]
    pub sync_applied: bool,
    #[serde(default)]
    pub deploy_previews: BTreeMap<String, DeployPreview>,
    #[serde(default)]
    pub deploy_applied: bool,
    #[serde(default)]
    pub report_paths: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub backup_paths: BTreeMap<String, PathBuf>,
    /// Thứ tự key enabled khi bắt đầu job dịch — map keyIndex từ engine.
    #[serde(default)]
    pub translate_session_key_ids: Vec<String>,
    #[serde(default)]
    pub legend_source_path: Option<PathBuf>,
    #[serde(default)]
    pub legend_deploy_path: Option<PathBuf>,
    #[serde(default)]
    pub legend_preview: Option<LegendPreviewMetadata>,
    #[serde(default)]
    pub legend_trial_preview: Option<LegendPreviewMetadata>,
    #[serde(default)]
    pub legend_glossary_path: Option<PathBuf>,
    #[serde(default)]
    pub legend_seconds_per_batch: Option<f64>,
}

impl Default for PersistedData {
    fn default() -> Self {
        Self {
            schema_version: PERSISTENCE_SCHEMA_VERSION,
            app: FrontendAppState::default(),
            sync_previews: BTreeMap::new(),
            sync_applied: false,
            deploy_previews: BTreeMap::new(),
            deploy_applied: false,
            report_paths: BTreeMap::new(),
            backup_paths: BTreeMap::new(),
            translate_session_key_ids: Vec::new(),
            legend_source_path: None,
            legend_deploy_path: None,
            legend_preview: None,
            legend_trial_preview: None,
            legend_glossary_path: None,
            legend_seconds_per_batch: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PersistenceStore {
    path: PathBuf,
}

impl PersistenceStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join("backend-state.json"),
        }
    }

    pub fn load(&self) -> CommandResult<PersistedData> {
        if !self.path.exists() {
            return Ok(PersistedData::default());
        }
        let metadata =
            fs::metadata(&self.path).map_err(|error| CommandError::io("Đọc state", error))?;
        if metadata.len() > MAX_STATE_FILE_BYTES {
            return Err(CommandError::new(
                "state_file_too_large",
                "backend-state.json vượt quá 16 MiB",
            ));
        }
        let bytes = fs::read(&self.path).map_err(|error| CommandError::io("Đọc state", error))?;
        let data: PersistedData = serde_json::from_slice(&bytes).map_err(|error| {
            CommandError::new("state_file_invalid", format!("State JSON lỗi: {error}"))
        })?;
        if data.schema_version != PERSISTENCE_SCHEMA_VERSION {
            return Err(CommandError::new(
                "state_schema_unsupported",
                format!("State schema {} không được hỗ trợ", data.schema_version),
            ));
        }
        Ok(data)
    }

    pub fn quarantine_invalid(&self) -> CommandResult<()> {
        if self.path.exists() {
            let target = self
                .path
                .with_extension(format!("corrupt-{}.json", now_millis()));
            fs::rename(&self.path, target)
                .map_err(|error| CommandError::io("Cách ly state cũ", error))?;
        }
        Ok(())
    }

    pub fn save(&self, data: &PersistedData) -> CommandResult<()> {
        let parent = self.path.parent().ok_or_else(|| {
            CommandError::new("invalid_state_path", "Không xác định được AppData")
        })?;
        fs::create_dir_all(parent).map_err(|error| CommandError::io("Tạo AppData", error))?;
        let temporary = parent.join(format!(
            ".backend-state.{}.{}.tmp",
            std::process::id(),
            now_millis()
        ));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| CommandError::io("Tạo state tạm", error))?;
        let mut writer = BufWriter::new(file);
        if let Err(error) = serde_json::to_writer_pretty(&mut writer, data) {
            drop(writer);
            let _ = fs::remove_file(&temporary);
            return Err(CommandError::new(
                "serialize_state_failed",
                error.to_string(),
            ));
        }
        let result = writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .and_then(|_| writer.get_ref().sync_all());
        drop(writer);
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(CommandError::io("Ghi state tạm", error));
        }
        if let Err(error) = atomic_replace(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> CommandResult<()> {
    use std::os::windows::ffi::OsStrExt;
    const REPLACE: u32 = 0x1;
    const WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    let source = wide(source);
    let destination = wide(destination);
    // SAFETY: Pointers reference live NUL-terminated UTF-16 strings.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            REPLACE | WRITE_THROUGH,
        )
    } == 0
    {
        Err(CommandError::io(
            "Thay file nguyên tử",
            std::io::Error::last_os_error(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> CommandResult<()> {
    fs::rename(source, destination).map_err(|error| CommandError::io("Thay file nguyên tử", error))
}

pub fn report_directory(app_data_dir: &Path, state: &FrontendAppState) -> PathBuf {
    if state.config.report_path.as_os_str().is_empty() {
        app_data_dir.join("reports")
    } else {
        state.config.report_path.clone()
    }
}

pub fn backup_directory(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("backups")
}

pub fn write_report(directory: &Path, id: &str, value: &Value) -> CommandResult<PathBuf> {
    fs::create_dir_all(directory).map_err(|error| CommandError::io("Tạo thư mục report", error))?;
    let destination = directory.join(format!("{id}.json"));
    let temporary = directory.join(format!(".{id}.{}.tmp", now_millis()));
    let file =
        File::create(&temporary).map_err(|error| CommandError::io("Tạo report tạm", error))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value)
        .map_err(|error| CommandError::new("report_serialize_failed", error.to_string()))?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|error| CommandError::io("Ghi report", error))?;
    drop(writer);
    atomic_replace(&temporary, &destination)?;
    Ok(destination)
}

pub fn write_report_text(directory: &Path, id: &str, content: &str) -> CommandResult<PathBuf> {
    fs::create_dir_all(directory).map_err(|error| CommandError::io("Tạo thư mục report", error))?;
    let destination = directory.join(format!("{id}.txt"));
    fs::write(&destination, content).map_err(|error| CommandError::io("Ghi report TXT", error))?;
    Ok(destination)
}

pub fn write_json_atomic(path: &Path, value: &Value) -> CommandResult<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| CommandError::io("Tạo thư mục cho file JSON", error))?;
        }
    }
    let temporary = path.with_extension(format!("{}.tmp", now_millis()));
    let file =
        File::create(&temporary).map_err(|error| CommandError::io("Tạo file JSON tạm", error))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value)
        .map_err(|error| CommandError::new("json_serialize_failed", error.to_string()))?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|error| CommandError::io("Ghi file JSON", error))?;
    drop(writer);
    atomic_replace(&temporary, path)?;
    Ok(())
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> CommandResult<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| CommandError::io("Tạo thư mục khi ghi file", error))?;
        }
    }
    let temporary = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        now_millis()
    ));
    {
        let file =
            File::create(&temporary).map_err(|error| CommandError::io("Tạo file tạm", error))?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .and_then(|_| writer.get_ref().sync_all())
            .map_err(|error| CommandError::io("Ghi file tạm", error))?;
    }
    atomic_replace(&temporary, path)?;
    Ok(())
}

pub fn refresh_artifacts(data: &mut PersistedData, app_data_dir: &Path) -> CommandResult<()> {
    refresh_reports(data, &report_directory(app_data_dir, &data.app))?;
    refresh_backups(data, app_data_dir)?;
    Ok(())
}

fn refresh_reports(data: &mut PersistedData, directory: &Path) -> CommandResult<()> {
    data.app.reports.clear();
    data.report_paths.clear();
    if !directory.exists() {
        return Ok(());
    }
    for (index, entry) in fs::read_dir(directory)
        .map_err(|error| CommandError::io("Đọc reports", error))?
        .enumerate()
    {
        if index >= MAX_ARTIFACTS {
            return Err(CommandError::new("too_many_reports", "Có quá nhiều report"));
        }
        let entry = entry.map_err(|error| CommandError::io("Đọc report", error))?;
        if !entry
            .file_type()
            .map_err(|error| CommandError::io("Đọc loại report", error))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        let id = entry.file_name().to_string_lossy().into_owned();
        let lower = id.to_ascii_lowercase();
        // TXT là artifact kèm theo JSON — không liệt kê thành dòng báo cáo riêng.
        if lower.ends_with(".txt") {
            continue;
        }
        let step = infer_step(&lower);
        let metadata = entry
            .metadata()
            .map_err(|error| CommandError::io("Đọc report", error))?;
        data.report_paths.insert(id.clone(), path);
        data.app.reports.push(Report {
            id,
            step,
            title: step_title(step).to_owned(),
            status: StepStatus::Success,
            created_at: modified_text(&metadata),
            duration: String::new(),
            summary: format_size(metadata.len()),
        });
    }
    data.app
        .reports
        .sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(())
}

pub fn clear_reports(data: &mut PersistedData, directory: &Path) -> CommandResult<()> {
    if directory.exists() {
        for entry in
            fs::read_dir(directory).map_err(|error| CommandError::io("Đọc reports", error))?
        {
            let entry = entry.map_err(|error| CommandError::io("Đọc report", error))?;
            if !entry
                .file_type()
                .map_err(|error| CommandError::io("Đọc loại report", error))?
                .is_file()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".json") || lower.ends_with(".txt") {
                fs::remove_file(entry.path())
                    .map_err(|error| CommandError::io("Xóa report", error))?;
            }
        }
    }
    data.app.reports.clear();
    data.report_paths.clear();
    Ok(())
}

pub fn refresh_backups(data: &mut PersistedData, app_data_dir: &Path) -> CommandResult<()> {
    data.app.backups.clear();
    data.backup_paths.clear();
    let roots = [
        ("pipeline", backup_directory(app_data_dir)),
        ("legend", app_data_dir.join("legend").join("backups")),
    ];
    let mut scanned = 0usize;
    for (root_kind, directory) in roots {
        if !directory.exists() {
            continue;
        }
        for entry in
            fs::read_dir(&directory).map_err(|error| CommandError::io("Đọc backups", error))?
        {
            scanned += 1;
            if scanned > MAX_ARTIFACTS {
                return Err(CommandError::new("too_many_backups", "Có quá nhiều backup"));
            }
            let entry = entry.map_err(|error| CommandError::io("Đọc backup", error))?;
            if !entry
                .file_type()
                .map_err(|error| CommandError::io("Đọc loại backup", error))?
                .is_dir()
            {
                continue;
            }
            let path = entry.path();
            let id = entry.file_name().to_string_lossy().into_owned();
            let manifest_path = path.join("manifest.json");
            let manifest = fs::read(&manifest_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            let valid = manifest
                .as_ref()
                .and_then(|value| value.get("complete"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let files = manifest
                .as_ref()
                .and_then(|value| value.get("files"))
                .and_then(Value::as_array)
                .map_or_else(
                    || {
                        u64::from(
                            manifest
                                .as_ref()
                                .and_then(|value| value.get("backupFile"))
                                .and_then(Value::as_str)
                                .is_some(),
                        )
                    },
                    |items| items.len() as u64,
                );
            let metadata = entry
                .metadata()
                .map_err(|error| CommandError::io("Đọc backup", error))?;
            let internal_key = format!("{root_kind}:{id}");
            let lookup_key = if root_kind == "pipeline" {
                id.clone()
            } else {
                internal_key.clone()
            };
            data.backup_paths.insert(lookup_key, path.clone());
            if root_kind != "pipeline" {
                continue;
            }
            let size = directory_size(&path)?;
            data.app.backups.push(Backup {
                id,
                created_at: manifest
                    .as_ref()
                    .and_then(|value| value.get("createdAt"))
                    .and_then(Value::as_str)
                    .map_or_else(|| modified_text(&metadata), str::to_owned),
                step: StepId::Sync,
                files,
                size: format_size(size),
                valid,
                kind: Some("pipeline".to_owned()),
                product_id: Some("civ7".to_owned()),
                target_path: manifest
                    .as_ref()
                    .and_then(|value| value.get("source").or_else(|| value.get("target")))
                    .and_then(Value::as_str)
                    .map(tool_paths::simplify_windows_path_text),
                source_fingerprint: manifest
                    .as_ref()
                    .and_then(|value| value.get("sourceFingerprint"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                applied_fingerprint: manifest
                    .as_ref()
                    .and_then(|value| value.get("appliedFingerprint"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
    }
    data.app
        .backups
        .sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(())
}

fn infer_step(name: &str) -> StepId {
    if name.contains("translate") {
        StepId::Translate
    } else if name.contains("sync") {
        StepId::Sync
    } else if name.contains("inspect") {
        StepId::Inspect
    } else {
        StepId::Export
    }
}

pub fn step_title(step: StepId) -> &'static str {
    match step {
        StepId::Export => "Export dữ liệu tiếng Anh",
        StepId::Inspect => "Kiểm tra & Thống kê",
        StepId::Sync => "Đồng bộ nội dung",
        StepId::Translate => "Dịch bằng Gemini",
        StepId::Deploy => "Triển khai vào game",
    }
}

fn modified_text(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
        .unwrap_or_default()
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn directory_size(root: &Path) -> CommandResult<u64> {
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    let mut count = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(directory).map_err(|error| CommandError::io("Đọc backup", error))?
        {
            count += 1;
            if count > MAX_RESTORE_FILES {
                return Err(CommandError::new("backup_too_large", "Backup quá lớn"));
            }
            let entry = entry.map_err(|error| CommandError::io("Đọc backup", error))?;
            let file_type = entry
                .file_type()
                .map_err(|error| CommandError::io("Đọc backup", error))?;
            if file_type.is_symlink() {
                return Err(CommandError::new(
                    "backup_symlink_rejected",
                    "Backup chứa symlink",
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                total = total.saturating_add(
                    entry
                        .metadata()
                        .map_err(|error| CommandError::io("Đọc backup", error))?
                        .len(),
                );
            }
        }
    }
    Ok(total)
}

pub fn delete_backup(
    data: &mut PersistedData,
    backup_id: &str,
    backup_root: &Path,
) -> CommandResult<()> {
    let backup = data
        .backup_paths
        .get(backup_id)
        .cloned()
        .ok_or_else(|| CommandError::new("backup_not_found", "Không tìm thấy backup"))?;
    let canonical_backup = backup
        .canonicalize()
        .map_err(|error| CommandError::io("Mở backup", error))?;
    let canonical_root = backup_root
        .canonicalize()
        .map_err(|error| CommandError::io("Mở thư mục backup", error))?;
    if !canonical_backup.starts_with(&canonical_root) {
        return Err(CommandError::new(
            "backup_delete_not_allowed",
            "Không thể xóa backup nằm ngoài thư mục ứng dụng",
        ));
    }
    if canonical_backup.is_dir() {
        fs::remove_dir_all(&canonical_backup)
            .map_err(|error| CommandError::io("Xóa backup", error))?;
    }
    data.backup_paths.remove(backup_id);
    data.app.backups.retain(|item| item.id != backup_id);
    Ok(())
}

pub fn list_backup_files(backup: &Path) -> CommandResult<Vec<String>> {
    let backup = backup
        .canonicalize()
        .map_err(|error| CommandError::io("Mở backup", error))?;
    let manifest_bytes = fs::read(backup.join("manifest.json"))
        .map_err(|error| CommandError::io("Đọc manifest backup", error))?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| CommandError::new("invalid_backup", error.to_string()))?;
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::new("invalid_backup", "Manifest thiếu files"))?;
    if files.len() > MAX_RESTORE_FILES {
        return Err(CommandError::new("backup_too_large", "Backup quá lớn"));
    }
    Ok(files
        .iter()
        .filter_map(|item| item.get("path").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

pub fn create_pre_restore_safety_backup(
    restore_from: &Path,
    target: &Path,
    backup_root: &Path,
) -> CommandResult<PathBuf> {
    let restore_from = restore_from
        .canonicalize()
        .map_err(|error| CommandError::io("Mở backup", error))?;
    let target = target
        .canonicalize()
        .map_err(|error| CommandError::io("Mở modPath", error))?;
    let manifest_bytes = fs::read(restore_from.join("manifest.json"))
        .map_err(|error| CommandError::io("Đọc manifest backup", error))?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| CommandError::new("invalid_backup", error.to_string()))?;
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::new("invalid_backup", "Manifest thiếu files"))?;
    if files.len() > MAX_RESTORE_FILES {
        return Err(CommandError::new("backup_too_large", "Backup quá lớn"));
    }

    fs::create_dir_all(backup_root).map_err(|error| CommandError::io("Tạo backup", error))?;
    let timestamp = now_iso().replace([':', '.'], "-");
    let safety_dir = backup_root.join(format!(
        "safety-restore-{timestamp}-{}",
        &format!("{:08x}", now_millis() % 0x1_0000_0000)[..8]
    ));
    let files_dir = safety_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|error| CommandError::io("Tạo backup", error))?;

    let mut manifest_files = Vec::new();
    for item in files {
        let relative = item
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::new("invalid_backup", "File backup thiếu path"))?;
        let destination = safe_join(&target, relative)?;
        let existed = destination.is_file();
        if existed {
            let source = safe_join(&files_dir, relative)?;
            if let Some(parent) = source.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| CommandError::io("Tạo thư mục backup", error))?;
            }
            fs::copy(&destination, &source)
                .map_err(|error| CommandError::io("Chép safety snapshot", error))?;
        }
        manifest_files.push(serde_json::json!({
            "path": relative,
            "existed": existed,
        }));
    }

    let safety_manifest = serde_json::json!({
        "version": 1,
        "createdAt": now_iso(),
        "target": target.to_string_lossy(),
        "reason": "pre-restore-safety",
        "restoreFrom": restore_from.to_string_lossy(),
        "complete": true,
        "files": manifest_files,
    });
    fs::write(
        safety_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&safety_manifest)
            .map_err(|error| CommandError::new("invalid_backup", error.to_string()))?,
    )
    .map_err(|error| CommandError::io("Ghi safety snapshot", error))?;
    Ok(safety_dir)
}

pub fn restore_backup_manifest(backup: &Path, configured_target: &Path) -> CommandResult<()> {
    let backup = backup
        .canonicalize()
        .map_err(|error| CommandError::io("Mở backup", error))?;
    let manifest_bytes = fs::read(backup.join("manifest.json"))
        .map_err(|error| CommandError::io("Đọc manifest backup", error))?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| CommandError::new("invalid_backup", error.to_string()))?;
    if !manifest
        .get("complete")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(CommandError::new(
            "incomplete_backup",
            "Backup chưa hoàn tất",
        ));
    }
    let target = configured_target
        .canonicalize()
        .map_err(|error| CommandError::io("Mở modPath", error))?;
    let manifest_target = PathBuf::from(
        manifest
            .get("target")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::new("invalid_backup", "Manifest thiếu target"))?,
    )
    .canonicalize()
    .map_err(|error| CommandError::io("Mở manifest target", error))?;
    if target != manifest_target {
        return Err(CommandError::new(
            "backup_target_mismatch",
            "Backup không thuộc modPath hiện tại",
        ));
    }
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::new("invalid_backup", "Manifest thiếu files"))?;
    if files.len() > MAX_RESTORE_FILES {
        return Err(CommandError::new("backup_too_large", "Backup quá lớn"));
    }
    for item in files {
        let relative = item
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::new("invalid_backup", "File backup thiếu path"))?;
        let destination = safe_join(&target, relative)?;
        if item
            .get("existed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let source = safe_join(&backup.join("files"), relative)?;
            if !source.is_file() {
                return Err(CommandError::new(
                    "invalid_backup",
                    format!("Thiếu file backup: {relative}"),
                ));
            }
            atomic_copy(&source, &destination)?;
        } else if destination.is_file() {
            fs::remove_file(&destination)
                .map_err(|error| CommandError::io("Xóa file khi restore", error))?;
        }
    }
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> CommandResult<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CommandError::new(
            "unsafe_backup_path",
            "Backup chứa đường dẫn không an toàn",
        ));
    }
    Ok(root.join(relative))
}

fn atomic_copy(source: &Path, destination: &Path) -> CommandResult<()> {
    let parent = destination.parent().ok_or_else(|| {
        CommandError::new("invalid_restore_path", "Không xác định được thư mục đích")
    })?;
    fs::create_dir_all(parent).map_err(|error| CommandError::io("Tạo thư mục restore", error))?;
    let temporary = parent.join(format!(".restore-{}.tmp", now_millis()));
    fs::copy(source, &temporary).map_err(|error| CommandError::io("Chép backup", error))?;
    File::open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| CommandError::io("Đồng bộ restore", error))?;
    if let Err(error) = atomic_replace(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_legend_metadata_round_trips() {
        let mut data = PersistedData::default();
        data.legend_source_path = Some(PathBuf::from(r"C:\Legend.txt"));
        data.legend_deploy_path = Some(PathBuf::from(
            r"B:\SteamLibrary\steamapps\common\LegendOfHeros\BepInEx\Translation\vi\Text",
        ));
        data.legend_preview = Some(LegendPreviewMetadata {
            preview_id: "legend-1".into(),
            source_path: PathBuf::from(r"C:\Legend.txt"),
            source_fingerprint: "sha256:test".into(),
            created_at: "2026-08-16T00:00:00.000Z".into(),
            preview_path: PathBuf::from(r"C:\AppData\legend\previews\legend-1.json"),
            revision: 1,
            mode: "full".into(),
            glossary_hash: Some("sha256:glossary".into()),
            qa_stale_reason: None,
        });

        let json = serde_json::to_vec(&data).expect("serialize");
        let restored: PersistedData = serde_json::from_slice(&json).expect("deserialize");
        assert_eq!(restored.legend_source_path, data.legend_source_path);
        assert_eq!(restored.legend_deploy_path, data.legend_deploy_path);
        assert_eq!(restored.legend_preview, data.legend_preview);
    }

    #[test]
    fn backup_index_keeps_legend_out_of_civ7_list() {
        let root =
            std::env::temp_dir().join(format!("loc-tool-backup-index-test-{}", now_millis()));
        let pipeline = root.join("backups").join("same-id");
        let legend = root.join("legend").join("backups").join("same-id");
        fs::create_dir_all(pipeline.join("files")).expect("pipeline directory");
        fs::create_dir_all(legend.join("files")).expect("legend directory");
        fs::write(
            pipeline.join("manifest.json"),
            br#"{"version":1,"createdAt":"2026-01-01","target":"\\\\?\\C:\\Civ7","complete":true,"files":[]}"#,
        )
        .expect("pipeline manifest");
        fs::write(legend.join("files").join("Legend.txt"), b"old").expect("legend file");
        fs::write(
            legend.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "createdAt": "2026-01-02",
                "adapter": "legend-three-kingdoms",
                "source": r"C:\Legend.txt",
                "sourceFingerprint": "old",
                "appliedFingerprint": "new",
                "backupFile": legend.join("files").join("Legend.txt"),
                "complete": true,
            }))
            .expect("serialize"),
        )
        .expect("legend manifest");

        let mut data = PersistedData::default();
        refresh_backups(&mut data, &root).expect("refresh");
        assert_eq!(data.app.backups.len(), 1);
        assert_eq!(data.app.backups[0].id, "same-id");
        assert_eq!(data.app.backups[0].product_id.as_deref(), Some("civ7"));
        assert_eq!(data.app.backups[0].target_path.as_deref(), Some(r"C:\Civ7"));
        assert!(data.backup_paths.contains_key("same-id"));
        assert!(data.backup_paths.contains_key("legend:same-id"));
        assert!(data
            .app
            .backups
            .iter()
            .all(|backup| backup.kind.as_deref() != Some("legend")));
        let _ = fs::remove_dir_all(root);
    }
}
