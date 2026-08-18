from __future__ import annotations

import filecmp
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.types import (
    CancellationToken,
    ProgressThrottle,
    Reporter,
    ValidationError,
    null_reporter,
    report_progress,
)

SKIP_DIR_NAMES = {"l10n"}
SUPPORTED_EXTENSIONS = {".xml", ".vtt"}


def collect_deploy_files(root_dir: Path) -> dict[str, Path]:
    """Thu thập file .xml/.vtt theo đường dẫn tương đối, bỏ qua thư mục l10n."""
    if not root_dir.is_dir():
        return {}
    files: dict[str, Path] = {}
    for current, dir_names, file_names in os.walk(root_dir):
        dir_names[:] = [
            name for name in dir_names if name.lower() not in SKIP_DIR_NAMES
        ]
        for name in file_names:
            path = Path(current) / name
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            relative = path.relative_to(root_dir)
            key = str(relative).replace("/", "\\").lower()
            if key in files:
                raise ValidationError(
                    f"Trùng đường dẫn không phân biệt hoa thường: {relative}"
                )
            files[key] = relative
    return files


def _validate_roots(source_dir: Path, game_dir: Path) -> tuple[Path, Path]:
    source = source_dir.resolve()
    game = game_dir.resolve()
    if not source.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục nguồn (mod): {source}")
    if not game.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục game: {game}")
    if source == game:
        raise ValidationError("Mod và game không được là cùng một thư mục")
    for left, right in ((source, game), (game, source)):
        try:
            left.relative_to(right)
            raise ValidationError("Mod và game không được lồng nhau")
        except ValueError:
            pass
    return source, game


def _backup_file(source_path: Path, relative_path: Path, backup_root: Path) -> None:
    backup_path = backup_root / relative_path
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, backup_path)


def deploy_to_game(
    source_dir: Path,
    game_dir: Path,
    *,
    backup_root: Path | None = None,
    dry_run: bool = False,
    backup: bool = True,
    only_existing: bool = False,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    source, game = _validate_roots(source_dir, game_dir)
    reporter(
        "progress",
        "deploy",
        {
            "processed": 0,
            "total": 0,
            "currentFile": "Đang quét thư mục Việt hóa…",
        },
    )
    source_files = collect_deploy_files(source)
    if not source_files:
        raise ValidationError(f"Không tìm thấy file .xml/.vtt trong: {source}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    deploy_backup = backup_root / f"deploy-backup-{timestamp}" if backup_root else None
    if backup and not dry_run and deploy_backup is None:
        raise ValidationError("Thiếu backupDir khi deploy thật")

    report: dict[str, Any] = {
        "dryRun": dry_run,
        "onlyExisting": only_existing,
        "source": str(source),
        "target": str(game),
        "backup": str(deploy_backup) if backup and not dry_run else None,
        "timestamp": timestamp,
        "copiedFiles": [],
        "createdInGame": [],
        "skippedExtraFiles": [],
        "unchangedFiles": [],
        "errors": [],
    }

    keys = sorted(source_files)
    total = len(keys)
    progress = ProgressThrottle()

    for index, key in enumerate(keys, start=1):
        if cancel is not None:
            cancel.check()

        relative_path = source_files[key]
        source_path = source / relative_path
        target_path = game / relative_path
        relative_text = str(relative_path).replace("/", "\\")
        target_exists = target_path.exists()

        if not target_exists and only_existing:
            report["skippedExtraFiles"].append(relative_text)
            reporter(
                "log",
                "deploy",
                {"message": f"Bỏ qua (không có trong game): {relative_text}"},
            )
        elif target_exists and filecmp.cmp(source_path, target_path, shallow=False):
            report["unchangedFiles"].append(relative_text)
        elif not target_exists:
            if dry_run:
                report["createdInGame"].append(relative_text)
            else:
                try:
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, target_path)
                    report["createdInGame"].append(relative_text)
                except OSError as error:
                    report["errors"].append(
                        {"file": relative_text, "error": str(error)}
                    )
        else:
            if dry_run:
                report["copiedFiles"].append(relative_text)
            else:
                try:
                    if backup and deploy_backup is not None:
                        _backup_file(target_path, relative_path, deploy_backup)
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, target_path)
                    report["copiedFiles"].append(relative_text)
                except OSError as error:
                    report["errors"].append(
                        {"file": relative_text, "error": str(error)}
                    )

        report_progress(
            reporter,
            "deploy",
            {
                "processed": index,
                "total": total,
                "currentFile": relative_text,
                "file": relative_text,
            },
            progress,
        )

    summary = {
        "copied": len(report["copiedFiles"]),
        "created": len(report["createdInGame"]),
        "skipped": len(report["skippedExtraFiles"]),
        "unchanged": len(report["unchangedFiles"]),
        "errors": len(report["errors"]),
        "total": total,
    }
    report["summary"] = summary
    reporter("result", "deploy", report)
    return report
