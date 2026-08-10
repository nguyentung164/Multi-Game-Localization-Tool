from __future__ import annotations

import hashlib
import json
import shutil
import uuid
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .formats import (
    atomic_copy,
    atomic_text_write,
    collect_files,
    entry_key,
    entry_text,
    file_sha256,
    merge_vtt,
    merge_xml,
    parse_vtt,
    parse_xml,
    tagged_entries,
    unmatched_cues,
    unmatched_tagged_entries,
    vtt_cues,
    vtt_structure,
    write_vtt_atomic,
    write_xml_atomic,
    xml_structure,
)
from .types import (
    CancellationToken,
    ProgressThrottle,
    Reporter,
    StalePreviewError,
    SyncPlan,
    ValidationError,
    null_reporter,
    report_progress,
)


def _validate_roots(source: Path, target: Path) -> tuple[Path, Path]:
    source = source.resolve()
    target = target.resolve()
    if not source.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục English: {source}")
    if not target.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục Vietnam: {target}")
    if source == target:
        raise ValidationError("English và Vietnam không được là cùng một thư mục")
    try:
        target.relative_to(source)
        raise ValidationError("English và Vietnam không được lồng nhau")
    except ValueError:
        pass
    try:
        source.relative_to(target)
        raise ValidationError("English và Vietnam không được lồng nhau")
    except ValueError:
        pass
    return source, target


def _xml_entry_detail(change: str, element: ET.Element) -> dict[str, Any]:
    """Preview 1 entry: text EN khi thêm, text VN khi xóa — không phải đè bản dịch."""
    kind, tag = entry_key(element)
    return {
        "change": change,
        "type": kind,
        "tag": tag,
        "text": entry_text(element),
    }


def _xml_details(
    source: Path, target: Path | None
) -> tuple[list[dict[str, Any]], bool]:
    source_tree = parse_xml(source)
    if target is None:
        # File mới từ EN: mọi dòng sẽ được copy sang VN (text EN, chờ dịch sau).
        return (
            [
                _xml_entry_detail("add", element)
                for element in tagged_entries(source_tree)
            ],
            True,
        )
    target_tree = parse_xml(target)
    # Chỉ các Tag thừa/thiếu theo cấu trúc EN; Tag khớp giữ nguyên text VN khi merge.
    added = unmatched_tagged_entries(source_tree, target_tree)
    removed = unmatched_tagged_entries(target_tree, source_tree)
    details = [_xml_entry_detail("add", element) for element in added] + [
        _xml_entry_detail("delete", element) for element in removed
    ]
    return details, xml_structure(source_tree) != xml_structure(target_tree)


def _vtt_details(
    source: Path, target: Path | None
) -> tuple[list[dict[str, Any]], bool]:
    source_blocks = parse_vtt(source)
    if target is None:
        return (
            [
                {"change": "add", "timing": cue.timing, "text": cue.text}
                for cue in vtt_cues(source_blocks)
            ],
            True,
        )
    target_blocks = parse_vtt(target)
    added = unmatched_cues(source_blocks, target_blocks)
    removed = unmatched_cues(target_blocks, source_blocks)
    details = [
        {"change": "add", "timing": cue.timing, "text": cue.text} for cue in added
    ] + [
        {"change": "delete", "timing": cue.timing, "text": cue.text} for cue in removed
    ]
    return details, vtt_structure(source_blocks) != vtt_structure(target_blocks)


def _state_rows(root: Path, files: dict[str, Path]) -> list[dict[str, str]]:
    return [
        {"path": key, "sha256": file_sha256(root / files[key])} for key in sorted(files)
    ]


def preview_sync(
    source_dir: Path,
    target_dir: Path,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> SyncPlan:
    cancel = cancel or CancellationToken()
    source, target = _validate_roots(source_dir, target_dir)
    source_files = collect_files(source)
    target_files = collect_files(target)
    actions: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    keys = sorted(set(source_files) | set(target_files))
    progress = ProgressThrottle()

    for index, key in enumerate(keys, start=1):
        cancel.check()
        source_relative = source_files.get(key)
        target_relative = target_files.get(key)
        relative = source_relative or target_relative
        assert relative is not None
        try:
            if source_relative is None:
                target_path = target / target_relative  # type: ignore[operator]
                if target_path.suffix.lower() == ".xml":
                    details = [
                        _xml_entry_detail("delete", element)
                        for element in tagged_entries(parse_xml(target_path))
                    ]
                else:
                    details = [
                        {
                            "change": "delete",
                            "timing": cue.timing,
                            "text": cue.text,
                        }
                        for cue in vtt_cues(parse_vtt(target_path))
                    ]
                actions.append(
                    {
                        "operation": "delete",
                        "path": relative.as_posix(),
                        "items": details,
                    }
                )
            elif target_relative is None:
                source_path = source / source_relative
                if source_path.suffix.lower() == ".xml":
                    details, _ = _xml_details(source_path, None)
                else:
                    details, _ = _vtt_details(source_path, None)
                actions.append(
                    {"operation": "add", "path": relative.as_posix(), "items": details}
                )
            else:
                source_path = source / source_relative
                target_path = target / target_relative
                if source_path.suffix.lower() == ".xml":
                    details, changed = _xml_details(source_path, target_path)
                else:
                    details, changed = _vtt_details(source_path, target_path)
                if changed:
                    actions.append(
                        {
                            "operation": "update",
                            "path": source_relative.as_posix(),
                            "targetPath": target_relative.as_posix(),
                            "items": details,
                        }
                    )
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            errors.append({"file": relative.as_posix(), "error": str(error)})
        report_progress(
            reporter,
            "sync-preview",
            {
                "processed": index,
                "total": len(keys),
                "current": relative.as_posix(),
            },
            progress,
        )

    state = {
        "source": _state_rows(source, source_files),
        "target": _state_rows(target, target_files),
        "actions": actions,
        "errors": errors,
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            state, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    summary = Counter(action["operation"] for action in actions)
    plan = SyncPlan(
        source=source,
        target=target,
        fingerprint=fingerprint,
        actions=tuple(actions),
        summary={
            "add": summary["add"],
            "update": summary["update"],
            "delete": summary["delete"],
            "unchanged": len(set(source_files) & set(target_files)) - summary["update"],
        },
        errors=tuple(errors),
    )
    reporter("result", "sync-preview", plan.to_dict())
    return plan


def _safe_path(root: Path, relative: str) -> Path:
    result = (root / Path(relative)).resolve()
    try:
        result.relative_to(root.resolve())
    except ValueError as error:
        raise ValidationError(
            f"Đường dẫn không an toàn trong manifest: {relative}"
        ) from error
    return result


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    atomic_text_write(
        path, json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)
    )


def restore_backup(
    backup_dir: Path,
    target_override: Path | None = None,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    backup_dir = backup_dir.resolve()
    manifest_path = backup_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"Backup manifest không hợp lệ: {error}") from error
    target = (target_override or Path(manifest.get("target", ""))).resolve()
    if not target.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục cần restore: {target}")
    restored = removed = 0
    files = list(manifest.get("files", []))
    progress = ProgressThrottle()
    for index, item in enumerate(files, start=1):
        cancel.check()
        relative = str(item.get("path", ""))
        destination = _safe_path(target, relative)
        if item.get("existed"):
            backup_file = _safe_path(backup_dir / "files", relative)
            if not backup_file.is_file():
                raise ValidationError(f"Thiếu file backup: {relative}")
            atomic_copy(backup_file, destination)
            restored += 1
        elif destination.exists():
            destination.unlink()
            removed += 1
        report_progress(
            reporter,
            "restore",
            {"processed": index, "total": len(files), "path": relative},
            progress,
        )
    result = {
        "backup": str(backup_dir),
        "target": str(target),
        "restored": restored,
        "removed": removed,
    }
    reporter("result", "restore", result)
    return result


def _verify_sync(source: Path, target: Path) -> list[str]:
    errors: list[str] = []
    source_files = collect_files(source)
    target_files = collect_files(target)
    for key in sorted(set(source_files) - set(target_files)):
        errors.append(f"Thiếu file Vietnam: {source_files[key].as_posix()}")
    for key in sorted(set(target_files) - set(source_files)):
        errors.append(f"Dư file Vietnam: {target_files[key].as_posix()}")
    for key in sorted(set(source_files) & set(target_files)):
        source_relative = source_files[key]
        target_relative = target_files[key]
        try:
            if source_relative.suffix.lower() == ".xml":
                left = xml_structure(parse_xml(source / source_relative))
                right = xml_structure(parse_xml(target / target_relative))
            else:
                left = vtt_structure(parse_vtt(source / source_relative))
                right = vtt_structure(parse_vtt(target / target_relative))
            if left != right:
                errors.append(f"Cấu trúc chưa khớp: {source_relative.as_posix()}")
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            errors.append(f"Lỗi xác minh {source_relative.as_posix()}: {error}")
    return errors


def apply_sync(
    source_dir: Path,
    target_dir: Path,
    expected_fingerprint: str,
    backup_root: Path,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    if not expected_fingerprint:
        raise ValidationError("sync-apply bắt buộc có fingerprint từ sync-preview")
    plan = preview_sync(source_dir, target_dir, reporter=reporter, cancel=cancel)
    if plan.fingerprint != expected_fingerprint:
        raise StalePreviewError(
            "Dữ liệu đã thay đổi sau preview; hãy chạy sync-preview lại"
        )
    if plan.errors:
        raise ValidationError("Không thể apply khi preview còn file lỗi")

    source, target = plan.source, plan.target
    resolved_backup_root = backup_root.resolve()
    for protected_root in (source, target):
        try:
            resolved_backup_root.relative_to(protected_root)
            raise ValidationError(
                "Thư mục backup không được nằm trong English hoặc Vietnam"
            )
        except ValueError:
            pass
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = resolved_backup_root / f"backup-{timestamp}-{uuid.uuid4().hex[:8]}"
    files_dir = backup_dir / "files"
    files_dir.mkdir(parents=True)
    manifest_files: list[dict[str, Any]] = []
    for action in plan.actions:
        cancel.check()
        target_relative = action.get("targetPath", action["path"])
        target_path = _safe_path(target, target_relative)
        existed = target_path.is_file()
        if existed:
            backup_path = _safe_path(files_dir, target_relative)
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target_path, backup_path)
        manifest_files.append(
            {
                "path": target_relative,
                "existed": existed,
                "sha256": file_sha256(target_path) if existed else None,
            }
        )
    manifest = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": str(source),
        "target": str(target),
        "fingerprint": plan.fingerprint,
        "complete": False,
        "files": manifest_files,
    }
    _write_manifest(backup_dir / "manifest.json", manifest)

    try:
        progress = ProgressThrottle()
        for index, action in enumerate(plan.actions, start=1):
            cancel.check()
            relative = action["path"]
            source_path = _safe_path(source, relative)
            target_path = _safe_path(target, action.get("targetPath", relative))
            operation = action["operation"]
            if operation == "delete":
                target_path.unlink(missing_ok=True)
            elif operation == "add":
                atomic_copy(source_path, target_path)
            elif source_path.suffix.lower() == ".xml":
                write_xml_atomic(
                    merge_xml(parse_xml(source_path), parse_xml(target_path)),
                    target_path,
                )
            else:
                write_vtt_atomic(
                    merge_vtt(parse_vtt(source_path), parse_vtt(target_path)),
                    target_path,
                )
            report_progress(
                reporter,
                "sync-apply",
                {
                    "processed": index,
                    "total": len(plan.actions),
                    "operation": operation,
                    "path": relative,
                },
                progress,
            )
        verification_errors = _verify_sync(source, target)
        if verification_errors:
            raise ValidationError("; ".join(verification_errors))
    except BaseException:
        restore_backup(
            backup_dir, target, reporter=reporter, cancel=CancellationToken()
        )
        raise

    manifest["complete"] = True
    _write_manifest(backup_dir / "manifest.json", manifest)
    result = {
        "fingerprint": plan.fingerprint,
        "backup": str(backup_dir),
        "summary": dict(plan.summary),
        "verificationErrors": [],
    }
    reporter("result", "sync-apply", result)
    return result
