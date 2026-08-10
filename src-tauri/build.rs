use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    sync_pyinstaller_runtime();
    tauri_build::build();
}

/// PyInstaller onedir loads `python313.dll` from `<exe-dir>/_internal`.
/// Tauri copies only the externalBin executable into `target/<profile>/`,
/// so we must also place `_internal` next to that sidecar for `tauri dev`.
fn sync_pyinstaller_runtime() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let stamp = manifest_dir.join("binaries").join(".engine-runtime-stamp");
    // Watch a tiny stamp file only — never the whole `_internal` tree (can be locked / huge).
    println!("cargo:rerun-if-changed={}", stamp.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    // OUT_DIR = target/<profile>/build/<crate>/out  (or target/<triple>/<profile>/...)
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        println!("cargo:warning=Không suy ra được target profile dir từ OUT_DIR");
        return;
    };
    let dest = profile_dir.join("_internal");

    // Release builds embed `binaries/_internal` as bundle resources (see tauri.release.conf.json).
    // A junction at target/release/_internal aliases the same files and makes Tauri's
    // resource copy hit ERROR_SHARING_VIOLATION (os error 32) on Windows.
    let is_release = env::var("PROFILE").map(|p| p == "release").unwrap_or(false);
    if is_release {
        if dest_is_reparse_point(&dest) {
            if let Err(error) = remove_path(&dest) {
                println!(
                    "cargo:warning=Không gỡ được junction _internal tại {}: {error}",
                    dest.display()
                );
            }
        }
        return;
    }

    let runtime_src = [
        manifest_dir.join("binaries").join("_internal"),
        manifest_dir.join("resources").join("_internal"),
    ]
    .into_iter()
    .find(|path| path.is_dir());

    let Some(runtime_src) = runtime_src else {
        println!("cargo:warning=Chưa có PyInstaller _internal; chạy npm run build:engine trước khi Start job");
        return;
    };

    if same_path(&runtime_src, &dest) {
        return;
    }
    if let Err(error) = mirror_dir(&runtime_src, &dest) {
        println!(
            "cargo:warning=Không sync được PyInstaller _internal tới {}: {error}",
            dest.display()
        );
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn mirror_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    remove_path(dst)?;

    #[cfg(windows)]
    {
        if try_junction(src, dst) {
            return Ok(());
        }
    }

    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(src, dst).is_ok() {
            return Ok(());
        }
    }

    copy_dir_all(src, dst)
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || is_reparse_point(&meta) {
        fs::remove_dir(path)
    } else if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn dest_is_reparse_point(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink() || is_reparse_point(&meta))
        .unwrap_or(false)
}

#[cfg(windows)]
fn try_junction(src: &Path, dst: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(dst)
        .arg(src)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
