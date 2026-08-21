use crate::tool_paths::translation_cache_candidates as tool_translation_cache_candidates;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const PROTOCOL_VERSION: u16 = 1;
pub const APP_DISPLAY_NAME: &str = "Multi-Game Localization Tool";
pub const MAX_EVENT_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_SPILLED_RESULT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SYNC_CHANGES_UI: usize = 10_000;
pub const MAX_DEPLOY_CHANGES_UI: usize = 10_000;
pub const MAX_INSPECT_DIFFS_UI: usize = 10_000;
pub const EVENT_RING_CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn io(context: &str, error: impl std::fmt::Display) -> Self {
        Self::new("io_error", format!("{context}: {error}"))
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationConfig {
    pub enabled: bool,
    pub completed: bool,
    pub paused: bool,
    pub failed: bool,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            completed: true,
            paused: true,
            failed: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreset {
    Zinc,
    #[default]
    Indigo,
    Emerald,
    Rose,
    Sky,
    Aurora,
    #[serde(alias = "amber")]
    Sunset,
    Ocean,
    Violet,
    Nord,
}

pub const TRANSLATION_REPORTS_DIR: &str = "translation_reports";
pub const TRANSLATION_CACHE_FILENAME: &str = "translation_cache_gemini.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub game_path: PathBuf,
    pub export_path: PathBuf,
    pub mod_path: PathBuf,
    pub report_path: PathBuf,
    #[serde(default)]
    pub cache_path: PathBuf,
    pub glossary_path: PathBuf,
    pub model: String,
    pub fallback_models: Vec<String>,
    pub delay_ms: u64,
    pub timeout_seconds: u64,
    pub batch_size: u32,
    #[serde(default)]
    pub max_files: u32,
    #[serde(default)]
    pub max_api_calls: u32,
    #[serde(default = "default_legend_selected")]
    pub deploy_backup: bool,
    #[serde(default)]
    pub deploy_only_existing: bool,
    pub theme: Theme,
    #[serde(default)]
    pub theme_preset: ThemePreset,
    #[serde(default = "default_theme_gradients")]
    pub theme_gradients: bool,
    pub notifications: NotificationConfig,
}

fn default_legend_selected() -> bool {
    true
}

fn default_theme_gradients() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            game_path: PathBuf::new(),
            export_path: PathBuf::new(),
            mod_path: PathBuf::new(),
            report_path: PathBuf::new(),
            cache_path: PathBuf::new(),
            glossary_path: PathBuf::new(),
            model: "gemini-3.5-flash-lite".to_owned(),
            fallback_models: vec![
                "gemini-3.1-flash-lite".to_owned(),
                "gemini-3.6-flash".to_owned(),
                "gemini-3.5-flash".to_owned(),
            ],
            delay_ms: 500,
            timeout_seconds: 180,
            batch_size: 40,
            max_files: 0,
            max_api_calls: 0,
            deploy_backup: true,
            deploy_only_existing: false,
            theme: Theme::System,
            theme_preset: ThemePreset::default(),
            theme_gradients: true,
            notifications: NotificationConfig::default(),
        }
    }
}

impl AppConfig {
    pub fn validate(&self, require_existing: bool) -> PathValidation {
        let mut errors = BTreeMap::new();
        validate_directory(
            "gamePath",
            &self.game_path,
            require_existing,
            false,
            &mut errors,
        );
        validate_directory("exportPath", &self.export_path, false, true, &mut errors);
        validate_directory(
            "modPath",
            &self.mod_path,
            require_existing,
            true,
            &mut errors,
        );
        validate_directory("reportPath", &self.report_path, false, true, &mut errors);
        validate_optional_file(
            "glossaryPath",
            &self.glossary_path,
            require_existing,
            &mut errors,
        );
        if self.game_path == self.export_path
            || self.game_path == self.mod_path
            || self.export_path == self.mod_path
        {
            errors.insert(
                "paths".to_owned(),
                "gamePath, exportPath và modPath phải khác nhau".to_owned(),
            );
        }
        if !valid_text(&self.model, 128) {
            errors.insert("model".to_owned(), "Model không hợp lệ".to_owned());
        }
        if self.fallback_models.len() > 16
            || self
                .fallback_models
                .iter()
                .any(|model| !valid_text(model, 128))
        {
            errors.insert(
                "fallbackModels".to_owned(),
                "Danh sách fallback model không hợp lệ".to_owned(),
            );
        }
        if self.delay_ms > 300_000 {
            errors.insert("delayMs".to_owned(), "delayMs phải <= 300000".to_owned());
        }
        if !(1..=3_600).contains(&self.timeout_seconds) {
            errors.insert(
                "timeoutSeconds".to_owned(),
                "timeoutSeconds phải nằm trong 1..=3600".to_owned(),
            );
        }
        if !(1..=10_000).contains(&self.batch_size) {
            errors.insert(
                "batchSize".to_owned(),
                "batchSize phải nằm trong 1..=10000".to_owned(),
            );
        }
        if self.max_files > 1_000_000 {
            errors.insert("maxFiles".to_owned(), "maxFiles phải <= 1000000".to_owned());
        }
        if self.max_api_calls > 1_000_000 {
            errors.insert(
                "maxApiCalls".to_owned(),
                "maxApiCalls phải <= 1000000".to_owned(),
            );
        }
        PathValidation {
            valid: errors.is_empty(),
            errors,
        }
    }

    pub fn engine_config(
        &self,
        backup_dir: &Path,
        cache_path: &Path,
        dry_run: bool,
        fingerprint: Option<&str>,
    ) -> Value {
        let mut config = Map::new();
        config.insert("gameDir".into(), path_value(&self.game_path));
        config.insert("stagingDir".into(), path_value(&self.export_path));
        config.insert("englishDir".into(), path_value(&self.export_path));
        config.insert("targetDir".into(), path_value(&self.mod_path));
        config.insert("backupDir".into(), path_value(backup_dir));
        if !self.glossary_path.as_os_str().is_empty() {
            config.insert("glossaryPath".into(), path_value(&self.glossary_path));
        }
        config.insert("cachePath".into(), path_value(cache_path));
        config.insert("model".into(), Value::String(self.model.clone()));
        config.insert(
            "fallbackModels".into(),
            serde_json::to_value(&self.fallback_models).unwrap_or(Value::Array(Vec::new())),
        );
        config.insert(
            "delaySeconds".into(),
            Value::from(self.delay_ms as f64 / 1000.0),
        );
        config.insert("timeoutSeconds".into(), Value::from(self.timeout_seconds));
        config.insert("batchSize".into(), Value::from(self.batch_size));
        config.insert("maxFiles".into(), Value::from(self.max_files));
        config.insert("maxApiCalls".into(), Value::from(self.max_api_calls));
        config.insert("deployBackup".into(), Value::Bool(self.deploy_backup));
        config.insert(
            "onlyExisting".into(),
            Value::Bool(self.deploy_only_existing),
        );
        config.insert("dryRun".into(), Value::Bool(dry_run));
        if let Some(fingerprint) = fingerprint {
            config.insert("fingerprint".into(), Value::String(fingerprint.to_owned()));
        }
        Value::Object(config)
    }

    /// Các vị trí cache CIV7 cũ (reportPath/modPath) dùng khi migrate sang AppData.
    pub fn legacy_translation_cache_candidates(&self) -> Vec<PathBuf> {
        let cache_name = PathBuf::from(TRANSLATION_CACHE_FILENAME);
        if self.report_path.as_os_str().is_empty() {
            if self.mod_path.as_os_str().is_empty() {
                return vec![cache_name];
            }
            let mod_root = self.mod_path.parent().unwrap_or(&self.mod_path);
            return tool_translation_cache_candidates(mod_root);
        }
        let nested = self
            .report_path
            .join(TRANSLATION_REPORTS_DIR)
            .join(&cache_name);
        let flat = self.report_path.join(&cache_name);
        let inside_reports_dir = self
            .report_path
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(TRANSLATION_REPORTS_DIR));
        if inside_reports_dir {
            vec![flat, nested]
        } else {
            vec![nested, flat]
        }
    }
}

fn path_value(path: &Path) -> Value {
    Value::String(path.to_string_lossy().into_owned())
}

fn valid_text(value: &str, max_len: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
}

fn validate_directory(
    field: &str,
    path: &Path,
    require_existing: bool,
    writable_parent: bool,
    errors: &mut BTreeMap<String, String>,
) {
    if !valid_absolute_path(path) {
        errors.insert(field.to_owned(), "Phải là đường dẫn tuyệt đối".to_owned());
        return;
    }
    if require_existing && !path.is_dir() {
        errors.insert(field.to_owned(), "Không tìm thấy thư mục".to_owned());
        return;
    }
    if writable_parent && !path.exists() {
        let parent_exists = path.parent().is_some_and(Path::is_dir);
        if !parent_exists {
            errors.insert(field.to_owned(), "Thư mục cha không tồn tại".to_owned());
        }
    }
}

fn validate_optional_file(
    field: &str,
    path: &Path,
    require_existing: bool,
    errors: &mut BTreeMap<String, String>,
) {
    if path.as_os_str().is_empty() {
        return;
    }
    if !valid_absolute_path(path) {
        errors.insert(field.to_owned(), "Phải là đường dẫn tuyệt đối".to_owned());
    } else if require_existing && !path.is_file() {
        errors.insert(field.to_owned(), "Không tìm thấy file".to_owned());
    }
}

fn valid_absolute_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && !path.to_string_lossy().contains('\0')
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathConfigInput {
    pub game_path: PathBuf,
    pub export_path: PathBuf,
    pub mod_path: PathBuf,
}

impl PathConfigInput {
    pub fn validate(&self) -> PathValidation {
        let mut errors = BTreeMap::new();
        validate_directory("gamePath", &self.game_path, true, false, &mut errors);
        validate_directory("exportPath", &self.export_path, false, true, &mut errors);
        validate_directory("modPath", &self.mod_path, true, true, &mut errors);
        if self.game_path == self.export_path
            || self.game_path == self.mod_path
            || self.export_path == self.mod_path
        {
            errors.insert("paths".to_owned(), "Ba thư mục phải khác nhau".to_owned());
        }
        PathValidation {
            valid: errors.is_empty(),
            errors,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    pub valid: bool,
    pub errors: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationCacheInfo {
    pub path: String,
    pub exists: bool,
    pub entries: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationCacheClearResult {
    pub path: String,
    pub cleared_entries: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepId {
    Export,
    Inspect,
    Sync,
    Translate,
    Deploy,
}

impl StepId {
    pub const ALL: [Self; 5] = [
        Self::Export,
        Self::Inspect,
        Self::Sync,
        Self::Translate,
        Self::Deploy,
    ];

    pub fn prerequisite(self) -> Option<Self> {
        match self {
            Self::Export => None,
            Self::Inspect => Some(Self::Export),
            Self::Sync => Some(Self::Inspect),
            Self::Translate => Some(Self::Sync),
            Self::Deploy => Some(Self::Translate),
        }
    }

    pub fn engine_command(self, mode: JobMode) -> CommandResult<&'static str> {
        match (self, mode) {
            (Self::Export, _) => Ok("export"),
            (Self::Inspect, _) => Ok("inspect"),
            (Self::Sync, JobMode::DryRun) => Ok("sync-preview"),
            (Self::Sync, _) => Err(CommandError::new(
                "sync_preview_required",
                "Bước sync phải chạy dry-run trước rồi gọi apply_sync",
            )),
            (Self::Translate, _) => Ok("translate"),
            (Self::Deploy, JobMode::DryRun) => Ok("deploy-preview"),
            (Self::Deploy, _) => Err(CommandError::new(
                "deploy_preview_required",
                "Bước deploy phải chạy dry-run trước rồi gọi apply",
            )),
        }
    }
}

impl std::fmt::Display for StepId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Export => "export",
            Self::Inspect => "inspect",
            Self::Sync => "sync",
            Self::Translate => "translate",
            Self::Deploy => "deploy",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobMode {
    Run,
    DryRun,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Locked,
    Ready,
    Running,
    Success,
    Warning,
    Failed,
    Paused,
}

impl StepStatus {
    pub fn complete(self) -> bool {
        matches!(self, Self::Success | Self::Warning)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StepSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translated: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    pub id: StepId,
    pub title: String,
    pub short_title: String,
    pub description: String,
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_reason: Option<String>,
    pub summary: StepSummary,
}

fn default_steps() -> Vec<PipelineStep> {
    vec![
        PipelineStep {
            id: StepId::Export,
            title: "Export dữ liệu tiếng Anh".into(),
            short_title: "Export".into(),
            description: "Quét dữ liệu gốc và tạo bản export an toàn theo cấu trúc game.".into(),
            status: StepStatus::Locked,
            last_run: None,
            duration: None,
            locked_reason: Some("Hoàn tất thiết lập đường dẫn trước.".into()),
            summary: StepSummary::default(),
        },
        PipelineStep {
            id: StepId::Inspect,
            title: "Kiểm tra & Thống kê".into(),
            short_title: "Kiểm tra".into(),
            description: "Đối chiếu EN–VN, kiểm tra XML/VTT và lập báo cáo chênh lệch.".into(),
            status: StepStatus::Locked,
            last_run: None,
            duration: None,
            locked_reason: Some("Cần hoàn tất Export.".into()),
            summary: StepSummary::default(),
        },
        PipelineStep {
            id: StepId::Sync,
            title: "Đồng bộ nội dung".into(),
            short_title: "Đồng bộ".into(),
            description: "Xem trước thay đổi, tạo backup rồi cập nhật mod VN bằng ghi atomic."
                .into(),
            status: StepStatus::Locked,
            last_run: None,
            duration: None,
            locked_reason: Some("Cần hoàn tất Kiểm tra.".into()),
            summary: StepSummary::default(),
        },
        PipelineStep {
            id: StepId::Translate,
            title: "Dịch bằng Gemini".into(),
            short_title: "Dịch".into(),
            description: "Dịch theo batch với cache/resume, xoay model và API key tự động.".into(),
            status: StepStatus::Locked,
            last_run: None,
            duration: None,
            locked_reason: Some("Cần hoàn tất Đồng bộ.".into()),
            summary: StepSummary::default(),
        },
        PipelineStep {
            id: StepId::Deploy,
            title: "Triển khai vào game".into(),
            short_title: "Deploy".into(),
            description: "Copy file .xml/.vtt từ mod VN sang thư mục game Steam, có backup.".into(),
            status: StepStatus::Locked,
            last_run: None,
            duration: None,
            locked_reason: Some("Cần hoàn tất Dịch.".into()),
            summary: StepSummary::default(),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveJob {
    pub id: String,
    pub step: StepId,
    pub status: ActiveJobStatus,
    pub started_at: String,
    pub elapsed: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta: Option<String>,
    pub progress: f64,
    pub batch_progress: f64,
    pub current_file: String,
    pub processed: u64,
    pub total: u64,
    pub throughput: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workers: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_saving_cache: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActiveJobStatus {
    Running,
    Paused,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: String,
    pub seq: u64,
    pub timestamp: String,
    pub level: EventLevel,
    pub title: String,
    pub description: String,
    pub step: StepId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyStatus {
    Unknown,
    Valid,
    Active,
    RateLimited,
    QuotaExhausted,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyMeta {
    pub id: String,
    pub label: String,
    pub masked_suffix: String,
    pub priority: u32,
    pub enabled: bool,
    pub status: KeyStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
    pub local_requests: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_since: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChange {
    pub id: String,
    pub kind: SyncChangeKind,
    pub file: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncChangeKind {
    Add,
    Delete,
    Update,
    Vtt,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployChange {
    pub id: String,
    pub kind: DeployChangeKind,
    pub file: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeployChangeKind {
    Copy,
    Create,
    Skip,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaIssue {
    pub id: String,
    pub severity: QaSeverity,
    pub rule: String,
    pub file: String,
    pub tag: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QaSeverity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub step: StepId,
    pub title: String,
    pub status: StepStatus,
    pub created_at: String,
    pub duration: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreviewInfo {
    pub fingerprint: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectInventoryStats {
    pub xml_files: u64,
    pub vtt_files: u64,
    pub rows: u64,
    pub replaces: u64,
    pub cues: u64,
    pub invalid_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectTagDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<String>,
    pub count: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InspectDiffStatus {
    EnglishOnly,
    VietnameseOnly,
    Different,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectDiff {
    pub id: String,
    pub file: String,
    pub status: InspectDiffStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_in_vietnamese: Vec<InspectTagDelta>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_in_vietnamese: Vec<InspectTagDelta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub english: Option<InspectInventoryStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vietnamese: Option<InspectInventoryStats>,
    pub diffs: Vec<InspectDiff>,
    pub english_only: u64,
    pub vietnamese_only: u64,
    pub different_files: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryPayload {
    pub path: String,
    pub exists: bool,
    pub entries: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossarySaveResult {
    pub path: String,
    pub entries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSearchMatch {
    pub id: String,
    pub file: String,
    pub tag: String,
    pub entry_type: String,
    pub english: String,
    pub vietnamese: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagListResult {
    pub scanned_files: u64,
    pub total_matches: u64,
    pub truncated: bool,
    pub matches: Vec<TagSearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagUpdateResult {
    pub file: String,
    pub tag: String,
    pub entry_type: String,
    pub vietnamese: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTagsResult {
    pub query: String,
    pub replacement: String,
    pub replaced_occurrences: u64,
    pub updated_rows: u64,
    pub updated_files: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSearchResult {
    pub query: String,
    pub scope: String,
    pub scanned_files: u64,
    pub total_matches: u64,
    pub truncated: bool,
    pub matches: Vec<TagSearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub created_at: String,
    pub step: StepId,
    pub files: u64,
    pub size: String,
    pub valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendAppState {
    pub setup_complete: bool,
    pub steps: Vec<PipelineStep>,
    pub selected_step: StepId,
    pub active_job: Option<ActiveJob>,
    pub events: Vec<JobEvent>,
    pub api_keys: Vec<ApiKeyMeta>,
    pub sync_changes: Vec<SyncChange>,
    #[serde(default)]
    pub deploy_changes: Vec<DeployChange>,
    pub qa_issues: Vec<QaIssue>,
    pub reports: Vec<Report>,
    pub backups: Vec<Backup>,
    pub config: AppConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_preview: Option<SyncPreviewInfo>,
    #[serde(default)]
    pub sync_applied: bool,
    #[serde(default)]
    pub deploy_applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspect_snapshot: Option<InspectSnapshot>,
}

impl Default for FrontendAppState {
    fn default() -> Self {
        Self {
            setup_complete: false,
            steps: default_steps(),
            selected_step: StepId::Export,
            active_job: None,
            events: Vec::new(),
            api_keys: Vec::new(),
            sync_changes: Vec::new(),
            deploy_changes: Vec::new(),
            qa_issues: Vec::new(),
            reports: Vec::new(),
            backups: Vec::new(),
            config: AppConfig::default(),
            sync_preview: None,
            sync_applied: false,
            deploy_applied: false,
            inspect_snapshot: None,
        }
    }
}

impl FrontendAppState {
    pub fn step(&self, id: StepId) -> Option<&PipelineStep> {
        self.steps.iter().find(|step| step.id == id)
    }

    pub fn step_mut(&mut self, id: StepId) -> Option<&mut PipelineStep> {
        self.steps.iter_mut().find(|step| step.id == id)
    }

    pub fn gate(&self, step: StepId) -> CommandResult<()> {
        if self
            .active_job
            .as_ref()
            .is_some_and(|job| matches!(job.status, ActiveJobStatus::Running))
        {
            return Err(CommandError::new(
                "job_already_running",
                "Chỉ được chạy một tác vụ tại một thời điểm",
            ));
        }
        if !self.setup_complete {
            return Err(CommandError::new(
                "setup_incomplete",
                "Cần lưu cấu hình đường dẫn hợp lệ trước",
            ));
        }
        if let Some(prerequisite) = step.prerequisite() {
            if !self
                .step(prerequisite)
                .is_some_and(|item| item.status.complete())
            {
                return Err(CommandError::new(
                    "prerequisite_not_met",
                    format!("Cần hoàn tất bước {prerequisite} trước"),
                ));
            }
        }
        Ok(())
    }

    pub fn invalidate_from(&mut self, first: StepId) {
        for id in StepId::ALL {
            if id >= first {
                if let Some(step) = self.step_mut(id) {
                    step.status = StepStatus::Locked;
                    step.last_run = None;
                    step.duration = None;
                    step.summary = StepSummary::default();
                }
            }
        }
        self.normalize_gates();
    }

    pub fn normalize_gates(&mut self) {
        self.setup_complete = self.config.validate(false).valid;
        let setup_complete = self.setup_complete;
        for id in StepId::ALL {
            let prerequisite_complete = id.prerequisite().is_none_or(|previous| {
                self.step(previous)
                    .is_some_and(|step| step.status.complete())
            });
            if let Some(step) = self.step_mut(id) {
                if !setup_complete {
                    step.status = StepStatus::Locked;
                    step.locked_reason = Some("Hoàn tất thiết lập đường dẫn trước.".into());
                } else if prerequisite_complete {
                    if step.status == StepStatus::Locked {
                        step.status = StepStatus::Ready;
                    }
                    step.locked_reason = None;
                } else if !matches!(
                    step.status,
                    StepStatus::Running | StepStatus::Failed | StepStatus::Paused
                ) {
                    step.status = StepStatus::Locked;
                    step.locked_reason = Some(
                        match id {
                            StepId::Export => "Hoàn tất thiết lập đường dẫn trước.",
                            StepId::Inspect => "Cần hoàn tất Export.",
                            StepId::Sync => "Cần hoàn tất Kiểm tra.",
                            StepId::Translate => "Cần hoàn tất Đồng bộ.",
                            StepId::Deploy => "Cần hoàn tất Dịch.",
                        }
                        .into(),
                    );
                }
            }
        }
    }

    pub fn push_timeline(&mut self, event: &JobEventEnvelope) {
        let level = match event.event_type {
            FrontendEventType::Warning | FrontendEventType::Paused => EventLevel::Warning,
            FrontendEventType::Failed => EventLevel::Error,
            FrontendEventType::Completed => EventLevel::Success,
            _ => EventLevel::Info,
        };
        let title = event
            .payload
            .get("title")
            .or_else(|| event.payload.get("message"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| event.event_type.as_str())
            .to_owned();
        let description = event
            .payload
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.events.insert(
            0,
            JobEvent {
                id: format!("{}-{}", event.job_id, event.seq),
                seq: event.seq,
                timestamp: event.timestamp.clone(),
                level,
                title,
                description,
                step: event.step,
                detail: compact_event_detail(event.payload.get("detail").cloned()),
                count: event.payload.get("count").and_then(Value::as_u64),
            },
        );
        self.events.truncate(EVENT_RING_CAPACITY);
    }

    pub fn sanitize_timeline_events(&mut self) {
        for event in &mut self.events {
            event.detail = compact_event_detail(event.detail.take());
        }
    }
}

const EVENT_DETAIL_HEAVY_KEYS: &[&str] = &[
    "actions",
    "changes",
    "copiedFiles",
    "createdInGame",
    "skippedExtraFiles",
    "unchangedFiles",
    "english",
    "vietnamese",
    "diff",
];

fn compact_event_detail(detail: Option<Value>) -> Option<Value> {
    let Some(Value::Object(mut map)) = detail else {
        return detail.filter(|value| !value.is_null());
    };
    for key in EVENT_DETAIL_HEAVY_KEYS {
        map.remove(*key);
    }
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEventEnvelope {
    pub protocol_version: u16,
    pub job_id: String,
    pub seq: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub step: String,
    pub timestamp: String,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontendEventType {
    Started,
    Log,
    Progress,
    Warning,
    Report,
    Completed,
    Failed,
    Paused,
}

impl FrontendEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Log => "log",
            Self::Progress => "progress",
            Self::Warning => "warning",
            Self::Report => "report",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEventEnvelope {
    pub protocol_version: u16,
    pub job_id: String,
    pub seq: u64,
    pub step: StepId,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub event_type: FrontendEventType,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStartResponse {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRequest<'a> {
    pub protocol_version: u16,
    pub job_id: &'a str,
    pub command: &'a str,
    pub config: &'a Value,
    pub api_keys: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendFileEntry {
    pub line_number: u64,
    pub source: String,
    pub current_target: String,
    #[serde(default = "default_legend_entry_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<u64>,
}

fn default_legend_entry_kind() -> String {
    "entry".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendSearchMatch {
    pub id: String,
    pub line_number: u64,
    pub source: String,
    pub current_target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendSearchResult {
    pub query: String,
    pub scope: String,
    pub source_path: String,
    pub scanned_lines: u64,
    pub total_matches: u64,
    pub truncated: bool,
    pub matches: Vec<LegendSearchMatch>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendLineEdit {
    pub line_number: u64,
    pub current_target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendLineUpdateResult {
    pub source_path: String,
    pub updated_lines: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendFileEntriesPage {
    pub source_path: String,
    pub offset: u64,
    pub limit: u64,
    pub total: u64,
    #[serde(default)]
    pub entry_total: u64,
    #[serde(default)]
    pub invalid_total: u64,
    #[serde(default)]
    pub duplicate_total: u64,
    #[serde(default)]
    pub pending_total: u64,
    #[serde(default)]
    pub done_total: u64,
    #[serde(default)]
    pub warning_reasons: Vec<String>,
    pub entries: Vec<LegendFileEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendFileInspection {
    pub source_path: String,
    pub fingerprint: String,
    pub total_lines: u64,
    pub entry_count: u64,
    pub invalid_lines: u64,
    pub duplicate_sources: u64,
    #[serde(default)]
    pub unique_source_count: u64,
    #[serde(default)]
    pub syntax_source_count: u64,
    #[serde(default)]
    pub pending_entries: u64,
    #[serde(default)]
    pub done_entries: u64,
    #[serde(default)]
    pub placeholder_entries: u64,
    #[serde(default)]
    pub filled_entries: u64,
    #[serde(default)]
    pub done_items: u64,
    #[serde(default)]
    pub filled_items: u64,
    #[serde(default)]
    pub verified_items: u64,
    #[serde(default)]
    pub unverified_items: u64,
    #[serde(default)]
    pub placeholder_items: u64,
    #[serde(default)]
    pub reused_items: u64,
    #[serde(default)]
    pub pending_items: u64,
    pub encoding: String,
    pub newline: String,
    pub has_bom: bool,
    #[serde(default)]
    pub sample: Vec<LegendFileEntry>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendTranslationDiff {
    pub line_number: u64,
    pub source: String,
    pub before: String,
    pub after: String,
    #[serde(default)]
    pub effective_target: String,
    #[serde(default)]
    pub effective_after: String,
    #[serde(default = "default_true")]
    pub selected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_after: Option<String>,
    #[serde(default = "default_legend_diff_status")]
    pub status: String,
}

fn default_true() -> bool {
    true
}

fn default_legend_diff_status() -> String {
    "pending".into()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendTermSuggestion {
    pub source: String,
    pub reading: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendQaIssue {
    pub id: String,
    pub severity: String,
    pub rule: String,
    pub line_number: u64,
    pub source: String,
    pub before: String,
    pub after: String,
    pub detail: String,
    #[serde(default)]
    pub suggestions: Vec<LegendTermSuggestion>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendQaReport {
    pub passed: bool,
    pub blocking: bool,
    pub revision: u64,
    pub errors: u64,
    pub warnings: u64,
    #[serde(default)]
    pub issues: Vec<LegendQaIssue>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendRuleStat {
    pub rule: String,
    pub count: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendTranslationStats {
    pub items_total: u64,
    pub items_translated: u64,
    pub cache_hits: u64,
    pub api_calls: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_switches: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_passed_first_pass: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_blocking_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_issue_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_passes_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retranslated_sources: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_failed_rules: Vec<LegendRuleStat>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_issue_rules: Vec<LegendRuleStat>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendTranslationPreview {
    pub preview_id: String,
    pub source_path: String,
    pub source_fingerprint: String,
    pub created_at: String,
    #[serde(default = "default_legend_revision")]
    pub revision: u64,
    #[serde(default = "default_legend_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glossary_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_stale_reason: Option<String>,
    #[serde(default)]
    pub coverage_translated: u64,
    #[serde(default)]
    pub coverage_total: u64,
    #[serde(default)]
    pub diffs: Vec<LegendTranslationDiff>,
    #[serde(default)]
    pub diff_count: u64,
    #[serde(default)]
    pub selected_count: u64,
    #[serde(default)]
    pub han_count: u64,
    #[serde(default)]
    pub error_count: u64,
    #[serde(default)]
    pub warning_count: u64,
    pub stats: LegendTranslationStats,
    #[serde(default)]
    pub qa: LegendQaReport,
    #[serde(default)]
    pub warnings: Vec<String>,
}

fn default_legend_revision() -> u64 {
    1
}

fn default_legend_mode() -> String {
    "full".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendPreviewSummary {
    pub preview_path: String,
    pub preview_id: String,
    pub created_at: String,
    pub mode: String,
    pub revision: u64,
    pub changed_lines: u64,
    pub source_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendPreviewDiffsPage {
    pub preview_id: String,
    pub filter: String,
    pub offset: u64,
    pub limit: u64,
    pub total: u64,
    pub selected_total: u64,
    pub han_total: u64,
    pub error_total: u64,
    pub warning_total: u64,
    pub entries: Vec<LegendTranslationDiff>,
    #[serde(default)]
    pub issues: Vec<LegendQaIssue>,
    #[serde(default)]
    pub line_refs: Vec<LegendPreviewLineRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendPreviewLineRef {
    pub line_number: u64,
    pub selected: bool,
    #[serde(default)]
    pub error: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendPreviewEdit {
    pub line_number: u64,
    pub selected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendGlossaryEntry {
    pub source: String,
    pub target: String,
    pub locked: bool,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendGlossaryDocument {
    pub version: u16,
    pub profile_id: String,
    pub path: String,
    #[serde(default)]
    pub entries: Vec<LegendGlossaryEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendTranslationEstimate {
    pub items: u64,
    #[serde(default)]
    pub done_items: u64,
    #[serde(default)]
    pub reused_items: u64,
    pub cached_items: u64,
    pub locked_items: u64,
    pub pending_items: u64,
    #[serde(default)]
    pub actionable_items: u64,
    #[serde(default)]
    pub workers_used: u64,
    #[serde(default)]
    pub spare_keys: u64,
    pub estimated_batches: u64,
    pub estimated_api_calls: u64,
    pub estimated_seconds_min: u64,
    pub estimated_seconds_max: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendBackup {
    pub id: String,
    pub created_at: String,
    pub source_path: String,
    pub backup_path: String,
    pub source_fingerprint: String,
    pub applied_fingerprint: String,
    pub valid: bool,
    pub safety: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendDedupeResult {
    pub source_path: String,
    pub removed: u64,
    pub remaining_entries: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegendTranslationApplyResult {
    pub preview_id: String,
    pub source_path: String,
    pub backup_path: String,
    pub updated_lines: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deploy_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deploy_backup_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LegendJobEventType {
    Started,
    Log,
    Progress,
    Warning,
    Result,
    Completed,
    Failed,
    Paused,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendJobEvent {
    pub protocol_version: u16,
    pub job_id: String,
    pub seq: u64,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub event_type: LegendJobEventType,
    pub payload: Map<String, Value>,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn valid_key_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_state() -> FrontendAppState {
        let mut state = FrontendAppState::default();
        state.config.game_path = std::env::current_dir().expect("cwd");
        state.config.export_path = std::env::temp_dir().join("loc-tool-export");
        state.config.mod_path = std::env::temp_dir().join("loc-tool-mod");
        state.config.report_path = std::env::temp_dir().join("loc-tool-reports");
        state.normalize_gates();
        state
    }

    #[test]
    fn pipeline_order_and_gating_are_exact() {
        assert_eq!(
            StepId::ALL,
            [
                StepId::Export,
                StepId::Inspect,
                StepId::Sync,
                StepId::Translate,
                StepId::Deploy,
            ]
        );
        let mut state = configured_state();
        assert!(state.gate(StepId::Export).is_ok());
        assert_eq!(
            state.gate(StepId::Inspect).expect_err("locked").code,
            "prerequisite_not_met"
        );
        state.step_mut(StepId::Export).expect("export").status = StepStatus::Success;
        assert!(state.gate(StepId::Inspect).is_ok());
    }

    #[test]
    fn sync_requires_preview_command() {
        assert_eq!(
            StepId::Sync
                .engine_command(JobMode::DryRun)
                .expect("preview"),
            "sync-preview"
        );
        assert_eq!(
            StepId::Sync
                .engine_command(JobMode::Run)
                .expect_err("must apply")
                .code,
            "sync_preview_required"
        );
    }

    #[test]
    fn deploy_requires_preview_command() {
        assert_eq!(
            StepId::Deploy
                .engine_command(JobMode::DryRun)
                .expect("preview"),
            "deploy-preview"
        );
        assert_eq!(
            StepId::Deploy
                .engine_command(JobMode::Run)
                .expect_err("must apply")
                .code,
            "deploy_preview_required"
        );
    }

    #[test]
    fn legacy_translation_cache_candidates_include_report_nested_file() {
        let base = std::env::temp_dir().join(format!("loc-tool-cache-test-{}", now_millis()));
        let reports = base.join("translation_reports");
        std::fs::create_dir_all(&reports).expect("reports dir");
        let cache_file = reports.join(TRANSLATION_CACHE_FILENAME);
        std::fs::write(&cache_file, b"{}\n").expect("cache file");

        let mut config = AppConfig::default();
        config.report_path = base.clone();
        assert!(config
            .legacy_translation_cache_candidates()
            .contains(&cache_file));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn frontend_state_serializes_required_camel_case_fields() {
        let value = serde_json::to_value(FrontendAppState::default()).expect("serialize");
        assert!(value.get("setupComplete").is_some());
        assert!(value.get("selectedStep").is_some());
        assert_eq!(value["steps"][0]["id"], "export");
        assert!(value["config"].get("fallbackModels").is_some());
        assert_eq!(value["config"]["themePreset"], "indigo");
        assert_eq!(value["config"]["themeGradients"], true);
    }

    #[test]
    fn theme_gradients_defaults_true_for_legacy_config() {
        let json = serde_json::json!({
            "gamePath": "",
            "exportPath": "",
            "modPath": "",
            "reportPath": "",
            "glossaryPath": "",
            "model": "gemini-3.5-flash-lite",
            "fallbackModels": [],
            "delayMs": 500,
            "timeoutSeconds": 180,
            "batchSize": 40,
            "theme": "system",
            "notifications": {
                "enabled": true,
                "completed": true,
                "paused": true,
                "failed": true
            }
        });
        let config: AppConfig = serde_json::from_value(json).expect("legacy config");
        assert!(config.theme_gradients);
    }

    #[test]
    fn legend_types_serialize_with_camel_case_contract() {
        let preview = LegendTranslationPreview {
            preview_id: "legend-1".into(),
            source_path: r"C:\Legend.txt".into(),
            source_fingerprint: "sha256:test".into(),
            created_at: "2026-08-16T00:00:00.000Z".into(),
            revision: 1,
            mode: "full".into(),
            glossary_hash: Some("sha256:glossary".into()),
            qa_stale_reason: None,
            coverage_translated: 1,
            coverage_total: 1,
            diff_count: 1,
            selected_count: 1,
            han_count: 0,
            error_count: 0,
            warning_count: 0,
            diffs: vec![LegendTranslationDiff {
                line_number: 7,
                source: "Hello".into(),
                before: "Hello".into(),
                after: "Xin chào".into(),
                effective_target: "Xin chào".into(),
                effective_after: "Xin chào".into(),
                selected: true,
                edited_after: None,
                status: "pending".into(),
            }],
            stats: LegendTranslationStats {
                items_total: 1,
                items_translated: 1,
                cache_hits: 0,
                api_calls: 1,
                keys_used: Some(1),
                model_switches: Some(0),
                qa_passed_first_pass: None,
                qa_blocking_count: None,
                qa_issue_count: None,
                retry_passes_used: None,
                retranslated_sources: None,
                top_failed_rules: Vec::new(),
                top_issue_rules: Vec::new(),
            },
            qa: LegendQaReport {
                passed: true,
                blocking: false,
                revision: 1,
                ..Default::default()
            },
            warnings: Vec::new(),
        };
        let value = serde_json::to_value(preview).expect("serialize");
        assert_eq!(value["previewId"], "legend-1");
        assert_eq!(value["sourceFingerprint"], "sha256:test");
        assert_eq!(value["diffs"][0]["lineNumber"], 7);
        assert!(value["stats"].get("apiCalls").is_some());
    }
}
