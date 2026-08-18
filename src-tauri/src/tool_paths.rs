use std::path::{Path, PathBuf};

pub const TOOL_DIR: &str = ".localization-tool";
pub const LEGACY_TOOL_DIR: &str = ".civ7-tool";

/// Windows `canonicalize()` prefixes paths with `\\?\` (or `\\?\UNC\`).
/// Strip that for UI/storage when the remaining path is a normal DOS/UNC path.
pub fn simplify_windows_path_text(text: &str) -> String {
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    const VERBATIM: &str = r"\\?\";
    if let Some(rest) = text.strip_prefix(VERBATIM_UNC) {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(VERBATIM) {
        if rest.len() < 260 {
            return rest.to_string();
        }
    }
    text.to_string()
}

pub fn simplify_windows_path(path: &Path) -> PathBuf {
    PathBuf::from(simplify_windows_path_text(&path.to_string_lossy()))
}

pub fn display_windows_path(path: &Path) -> String {
    simplify_windows_path_text(&path.to_string_lossy())
}

pub fn translation_cache_candidates(mod_root: &Path) -> Vec<PathBuf> {
    [TOOL_DIR, LEGACY_TOOL_DIR]
        .into_iter()
        .map(|directory| mod_root.join(directory).join("translation-cache.json"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_cache_candidates_prefer_current_then_legacy() {
        let root = Path::new("game-mods");

        assert_eq!(
            translation_cache_candidates(root),
            vec![
                root.join(".localization-tool")
                    .join("translation-cache.json"),
                root.join(".civ7-tool").join("translation-cache.json"),
            ]
        );
    }

    #[test]
    fn simplify_windows_path_strips_verbatim_prefix() {
        assert_eq!(
            simplify_windows_path_text(r"\\?\B:\SteamLibrary\game\file.txt"),
            r"B:\SteamLibrary\game\file.txt"
        );
        assert_eq!(
            simplify_windows_path_text(r"\\?\UNC\server\share\file.txt"),
            r"\\server\share\file.txt"
        );
        assert_eq!(
            simplify_windows_path_text(r"B:\SteamLibrary\game\file.txt"),
            r"B:\SteamLibrary\game\file.txt"
        );
    }
}
