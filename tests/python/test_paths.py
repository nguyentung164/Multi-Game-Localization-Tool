from __future__ import annotations

from translate_tool.common.paths import (
    LEGACY_TOOL_DIR,
    TOOL_DIR,
    backup_dir,
    tool_cache_path,
    tool_dir,
)


def test_read_falls_back_to_legacy_tool_directory(tmp_path) -> None:
    legacy = tmp_path / LEGACY_TOOL_DIR
    legacy.mkdir()

    assert tool_dir(tmp_path) == legacy
    assert tool_cache_path(tmp_path, "translation-cache.json") == (
        legacy / "translation-cache.json"
    )


def test_write_migrates_legacy_tool_directory(tmp_path) -> None:
    legacy_cache = tmp_path / LEGACY_TOOL_DIR / "translation-cache.json"
    legacy_cache.parent.mkdir()
    legacy_cache.write_text('{"source":"legacy"}', encoding="utf-8")

    migrated = tool_cache_path(tmp_path, "translation-cache.json", for_write=True)

    assert migrated == tmp_path / TOOL_DIR / "translation-cache.json"
    assert migrated.read_text(encoding="utf-8") == '{"source":"legacy"}'
    assert legacy_cache.is_file()


def test_current_tool_directory_wins_without_touching_legacy(tmp_path) -> None:
    current = tmp_path / TOOL_DIR
    legacy = tmp_path / LEGACY_TOOL_DIR
    current.mkdir()
    legacy.mkdir()
    (current / "current.txt").write_text("current", encoding="utf-8")
    (legacy / "legacy.txt").write_text("legacy", encoding="utf-8")

    assert tool_dir(tmp_path, for_write=True) == current
    assert (current / "current.txt").read_text(encoding="utf-8") == "current"
    assert not (current / "legacy.txt").exists()
    assert (legacy / "legacy.txt").is_file()


def test_backup_write_migrates_legacy_directory(tmp_path) -> None:
    legacy_backup = tmp_path / ".civ7-tool-backups" / "manifest.json"
    legacy_backup.parent.mkdir()
    legacy_backup.write_text("{}", encoding="utf-8")

    current = backup_dir(tmp_path, for_write=True)

    assert current == tmp_path / ".localization-tool-backups"
    assert (current / "manifest.json").is_file()
