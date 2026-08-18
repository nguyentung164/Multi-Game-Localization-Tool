from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

TOOL_DIR = ".localization-tool"
LEGACY_TOOL_DIR = ".civ7-tool"
BACKUP_SUFFIX = "-backups"
DEPLOY_BACKUP_SUFFIX = "-deploy-backups"
EVENTS_DIR_NAME = "localization-tool-events"


def _migrate_directory(parent: Path, current_name: str, legacy_name: str) -> None:
    current = parent / current_name
    legacy = parent / legacy_name
    if current.exists() or not legacy.is_dir():
        return

    staging = parent / f"{current_name}.migrate-{uuid.uuid4().hex}"
    try:
        shutil.copytree(legacy, staging)
        os.replace(staging, current)
    except OSError:
        if current.exists():
            shutil.rmtree(staging, ignore_errors=True)
            return
        shutil.rmtree(staging, ignore_errors=True)
        raise


def migrate_legacy_tool_dir(parent: Path) -> None:
    _migrate_directory(parent, TOOL_DIR, LEGACY_TOOL_DIR)


def tool_dir(parent: Path, *, for_write: bool = False) -> Path:
    if for_write:
        migrate_legacy_tool_dir(parent)
        return parent / TOOL_DIR

    current = parent / TOOL_DIR
    if current.exists():
        return current
    legacy = parent / LEGACY_TOOL_DIR
    return legacy if legacy.exists() else current


def tool_cache_path(parent: Path, filename: str, *, for_write: bool = False) -> Path:
    return tool_dir(parent, for_write=for_write) / filename


def backup_dir(parent: Path, *, deploy: bool = False, for_write: bool = False) -> Path:
    suffix = DEPLOY_BACKUP_SUFFIX if deploy else BACKUP_SUFFIX
    current_name = f"{TOOL_DIR}{suffix}"
    legacy_name = f"{LEGACY_TOOL_DIR}{suffix}"
    if for_write:
        _migrate_directory(parent, current_name, legacy_name)
        return parent / current_name

    current = parent / current_name
    if current.exists():
        return current
    legacy = parent / legacy_name
    return legacy if legacy.exists() else current
