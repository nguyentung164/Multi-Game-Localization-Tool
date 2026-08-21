use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const OPEN_LEGEND_FILE_EVENT: &str = "open-legend-file";
const MAX_DROP_JSON_BYTES: u64 = 16 * 1024 * 1024;

pub struct PendingLaunchFile(pub Mutex<Option<String>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DroppedFileKind {
    LegendSource,
    Civ7Glossary,
    LegendGlossary,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedDrop {
    pub path: String,
    pub kind: DroppedFileKind,
}

pub fn extract_legend_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .find_map(|arg| normalize_legend_file_arg(arg))
}

pub fn classify_dropped_path(raw: &str) -> ClassifiedDrop {
    let Some(path) = normalize_dropped_path(raw) else {
        return ClassifiedDrop {
            path: raw.trim().to_owned(),
            kind: DroppedFileKind::Unsupported,
        };
    };

    let kind = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("txt") => DroppedFileKind::LegendSource,
        Some(ext) if ext.eq_ignore_ascii_case("json") => classify_json_file(&path),
        _ => DroppedFileKind::Unsupported,
    };

    ClassifiedDrop {
        path: path.to_string_lossy().into_owned(),
        kind,
    }
}

fn normalize_legend_file_arg(arg: &str) -> Option<String> {
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return None;
    }
    normalize_dropped_path(arg).map(|path| path.to_string_lossy().into_owned())
}

fn normalize_dropped_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let normalized = crate::tool_paths::simplify_windows_path(&canonical);
    if normalized.to_string_lossy().contains('\0') {
        return None;
    }
    Some(normalized)
}

fn classify_json_file(path: &Path) -> DroppedFileKind {
    let metadata = fs::metadata(path).ok();
    if metadata.map(|entry| entry.len()).unwrap_or(0) > MAX_DROP_JSON_BYTES {
        return DroppedFileKind::Unsupported;
    }
    let content = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return DroppedFileKind::Unsupported,
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return DroppedFileKind::Unsupported,
    };
    classify_json_value(&value)
}

fn classify_json_value(value: &serde_json::Value) -> DroppedFileKind {
    let Some(object) = value.as_object() else {
        return DroppedFileKind::Unsupported;
    };

    if object
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .is_some()
    {
        return DroppedFileKind::LegendGlossary;
    }

    let mut has_entry = false;
    for (key, item) in object {
        if key == "version" {
            continue;
        }
        if !item.is_string() {
            return DroppedFileKind::Unsupported;
        }
        has_entry = true;
    }

    if has_entry {
        DroppedFileKind::Civ7Glossary
    } else {
        DroppedFileKind::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ignores_flags_and_executable() {
        let dir = std::env::temp_dir().join("localization-tool-launch-file-flags");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("Legend.txt");
        fs::write(&file, b"test").expect("write temp file");

        let canonical = file.canonicalize().expect("canonicalize temp file");

        let args = vec![
            "localization-tool.exe".into(),
            "--help".into(),
            file.to_string_lossy().into(),
        ];
        assert_eq!(
            extract_legend_file_arg(&args).map(PathBuf::from),
            Some(crate::tool_paths::simplify_windows_path(&canonical))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn accepts_existing_file_path() {
        let dir = std::env::temp_dir().join("localization-tool-launch-file-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("Legend.txt");
        fs::write(&file, b"test").expect("write temp file");
        let canonical = file.canonicalize().expect("canonicalize temp file");

        let args = vec![
            "localization-tool.exe".into(),
            file.to_string_lossy().into(),
        ];
        assert_eq!(
            extract_legend_file_arg(&args).map(PathBuf::from),
            Some(crate::tool_paths::simplify_windows_path(&canonical))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_txt_as_legend_source() {
        let dir = std::env::temp_dir().join("localization-tool-drop-txt");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("Legend.txt");
        fs::write(&file, b"test").expect("write temp file");

        let classified = classify_dropped_path(&file.to_string_lossy());
        assert_eq!(classified.kind, DroppedFileKind::LegendSource);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_flat_json_as_civ7_glossary() {
        let dir = std::env::temp_dir().join("localization-tool-drop-civ7-json");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("glossary.json");
        fs::write(&file, br#"{"version":1,"hello":"xin chao"}"#).expect("write temp file");

        let classified = classify_dropped_path(&file.to_string_lossy());
        assert_eq!(classified.kind, DroppedFileKind::Civ7Glossary);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_entries_json_as_legend_glossary() {
        let dir = std::env::temp_dir().join("localization-tool-drop-legend-json");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("legend-glossary.json");
        fs::write(
            &file,
            br#"{"version":2,"entries":[{"source":"a","target":"b"}]}"#,
        )
        .expect("write temp file");

        let classified = classify_dropped_path(&file.to_string_lossy());
        assert_eq!(classified.kind, DroppedFileKind::LegendGlossary);

        let _ = fs::remove_dir_all(&dir);
    }
}
