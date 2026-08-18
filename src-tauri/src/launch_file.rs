use std::{
    path::PathBuf,
    sync::Mutex,
};

pub const OPEN_LEGEND_FILE_EVENT: &str = "open-legend-file";

pub struct PendingLaunchFile(pub Mutex<Option<String>>);

pub fn extract_legend_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .find_map(|arg| normalize_legend_file_arg(arg))
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
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let normalized = crate::tool_paths::simplify_windows_path(&canonical);
    if normalized.to_string_lossy().contains('\0') {
        return None;
    }
    Some(normalized.to_string_lossy().into_owned())
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

        let args = vec!["localization-tool.exe".into(), file.to_string_lossy().into()];
        assert_eq!(
            extract_legend_file_arg(&args).map(PathBuf::from),
            Some(crate::tool_paths::simplify_windows_path(&canonical))
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
