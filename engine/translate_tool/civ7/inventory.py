from __future__ import annotations

import errno
import os
import re
import shutil
import time
import uuid
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any

from ..common.formats import (
    collect_files,
    entry_keys,
    local_name,
    parse_vtt,
    parse_xml,
    tagged_entries,
    vtt_cues,
)
from ..common.types import (
    CancellationToken,
    FileInventory,
    ProgressThrottle,
    Reporter,
    ValidationError,
    null_reporter,
    report_progress,
)

ENGLISH_TEXT_PATTERN = re.compile(rb"<EnglishText(?:\s|>)")
_TRANSIENT_WINERRORS = {5, 32, 33}  # ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION


def _contains_english_text(path: Path) -> bool:
    overlap = b""
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            data = overlap + chunk
            if ENGLISH_TEXT_PATTERN.search(data):
                return True
            overlap = data[-32:]
    return False


def _same_or_nested(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _is_transient_fs_error(error: BaseException) -> bool:
    if not isinstance(error, OSError):
        return False
    winerror = getattr(error, "winerror", None)
    if winerror in _TRANSIENT_WINERRORS:
        return True
    return error.errno in {
        errno.EACCES,
        errno.EPERM,
        errno.EBUSY,
        errno.EAGAIN,
    }


def _rename_with_retry(
    source: Path,
    destination: Path,
    *,
    attempts: int = 10,
    delay: float = 0.05,
) -> None:
    last_error: OSError | None = None
    wait = delay
    for _ in range(attempts):
        try:
            os.replace(source, destination)
            return
        except OSError as error:
            if not _is_transient_fs_error(error):
                raise
            last_error = error
            time.sleep(wait)
            wait = min(wait * 2, 1.0)
    assert last_error is not None
    raise last_error


def _rmtree_with_retry(path: Path, *, attempts: int = 8, delay: float = 0.05) -> None:
    wait = delay
    last_error: OSError | None = None
    for _ in range(attempts):
        try:
            if not path.exists():
                return
            shutil.rmtree(path)
            return
        except OSError as error:
            if not path.exists():
                return
            if not _is_transient_fs_error(error):
                raise
            last_error = error
            time.sleep(wait)
            wait = min(wait * 2, 1.0)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    if path.exists() and last_error is not None:
        raise last_error


def _copytree_with_retry(
    source: Path,
    destination: Path,
    *,
    attempts: int = 8,
    delay: float = 0.05,
) -> None:
    wait = delay
    last_error: OSError | None = None
    for _ in range(attempts):
        try:
            if destination.exists():
                _rmtree_with_retry(destination)
            shutil.copytree(source, destination)
            return
        except OSError as error:
            if not _is_transient_fs_error(error):
                raise
            last_error = error
            if destination.exists():
                shutil.rmtree(destination, ignore_errors=True)
            time.sleep(wait)
            wait = min(wait * 2, 1.0)
    assert last_error is not None
    raise last_error


def _publish_directory(staging: Path, destination: Path, previous: Path) -> None:
    """Đưa staging thành destination; trên Windows tránh phụ thuộc rename thư mục."""
    try:
        if destination.exists():
            if previous.exists():
                _rmtree_with_retry(previous)
            try:
                _rename_with_retry(destination, previous)
            except OSError:
                # Explorer/AV có thể chặn rename; xóa tại chỗ rồi publish bản mới.
                _rmtree_with_retry(destination)

        published = False
        if not destination.exists():
            try:
                _rename_with_retry(staging, destination)
                published = True
            except OSError:
                published = False

        if not published:
            # Fallback chắc hơn rename: copy nội dung rồi dọn staging.
            _copytree_with_retry(staging, destination)
            _rmtree_with_retry(staging)

        if previous.exists():
            _rmtree_with_retry(previous)
    except OSError as error:
        if previous.exists() and not destination.exists():
            try:
                _rename_with_retry(previous, destination)
            except OSError:
                pass
        if _is_transient_fs_error(error):
            raise ValidationError(
                "Không thể cập nhật thư mục export vì Windows đang khóa đường dẫn "
                f"({destination}). Đóng cửa sổ Explorer đang mở thư mục này rồi thử lại."
            ) from error
        raise


def export_game_files(
    game_dir: Path,
    destination: Path,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    game_dir = game_dir.resolve()
    destination = destination.resolve()
    if not game_dir.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục game: {game_dir}")
    if _same_or_nested(destination, game_dir) or _same_or_nested(game_dir, destination):
        raise ValidationError("Thư mục game và export không được lồng nhau")

    destination.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    staging = destination.parent / f".{destination.name}.staging-{token}"
    previous = destination.parent / f".{destination.name}.previous-{token}"
    copied_xml = copied_vtt = scanned = 0
    pending: list[tuple[Path, Path]] = []
    staging.mkdir()
    progress = ProgressThrottle()
    reporter("progress", "export", {"phase": "scan", "gameDir": str(game_dir)})

    try:
        for current, directories, names in os.walk(game_dir):
            cancel.check()
            directories[:] = sorted(
                (name for name in directories if name.casefold() != "l10n"),
                key=str.casefold,
            )
            for name in sorted(names, key=str.casefold):
                cancel.check()
                source = Path(current) / name
                suffix = source.suffix.lower()
                if suffix not in {".xml", ".vtt"}:
                    continue
                scanned += 1
                if suffix == ".xml" and not _contains_english_text(source):
                    continue
                relative = source.relative_to(game_dir)
                pending.append((source, relative))

        total = len(pending)
        reporter(
            "progress",
            "export",
            {
                "phase": "scan",
                "processed": 0,
                "total": total,
                "gameDir": str(game_dir),
            },
        )

        for index, (source, relative) in enumerate(pending, start=1):
            cancel.check()
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            if source.suffix.lower() == ".xml":
                copied_xml += 1
            else:
                copied_vtt += 1
            report_progress(
                reporter,
                "export",
                {
                    "phase": "copy",
                    "path": relative.as_posix(),
                    "processed": index,
                    "total": total,
                    "copied": index,
                },
                progress,
            )

        _publish_directory(staging, destination, previous)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if previous.exists() and destination.exists():
            shutil.rmtree(previous, ignore_errors=True)

    result = {
        "destination": str(destination),
        "scannedCandidates": scanned,
        "xmlFiles": copied_xml,
        "vttFiles": copied_vtt,
        "filesCopied": copied_xml + copied_vtt,
    }
    reporter("result", "export", result)
    return result


def inventory_folder(
    root: Path,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> FileInventory:
    cancel = cancel or CancellationToken()
    root = root.resolve()
    if not root.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục: {root}")
    files = collect_files(root)
    xml_files = vtt_files = rows = replaces = deletes = cues = 0
    invalid: list[dict[str, Any]] = []
    progress = ProgressThrottle()
    for relative in files.values():
        cancel.check()
        path = root / relative
        try:
            if path.suffix.lower() == ".xml":
                xml_files += 1
                tree = parse_xml(path)
                counts = Counter(
                    local_name(element.tag) for element in tagged_entries(tree)
                )
                rows += counts["Row"]
                replaces += counts["Replace"]
                deletes += counts["Delete"]
            else:
                vtt_files += 1
                cues += len(vtt_cues(parse_vtt(path)))
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            invalid.append({"file": relative.as_posix(), "error": str(error)})
        report_progress(
            reporter,
            "inspect",
            {
                "phase": "inventory",
                "processed": xml_files + vtt_files,
                "total": len(files),
            },
            progress,
        )
    return FileInventory(
        xml_files=xml_files,
        vtt_files=vtt_files,
        rows=rows,
        replaces=replaces,
        deletes=deletes,
        cues=cues,
        invalid=tuple(invalid),
    )


def _counter_items(counter: Counter[tuple[str, str]]) -> list[dict[str, Any]]:
    return [
        {"type": entry_type, "tag": tag, "count": count}
        for (entry_type, tag), count in sorted(counter.items())
        if count > 0
    ]


def inspect_localization(
    english_dir: Path,
    vietnamese_dir: Path | None = None,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    english = inventory_folder(english_dir, reporter=reporter, cancel=cancel)
    result: dict[str, Any] = {"english": english.to_dict(), "diff": None}
    if vietnamese_dir is None:
        reporter("result", "inspect", result)
        return result

    vietnamese = inventory_folder(vietnamese_dir, reporter=reporter, cancel=cancel)
    english_files = collect_files(english_dir)
    vietnamese_files = collect_files(vietnamese_dir)
    file_diffs: list[dict[str, Any]] = []
    all_keys = sorted(set(english_files) | set(vietnamese_files))
    for key in all_keys:
        cancel.check()
        en_relative = english_files.get(key)
        vi_relative = vietnamese_files.get(key)
        display = en_relative or vi_relative
        assert display is not None
        if en_relative is None:
            file_diffs.append({"file": display.as_posix(), "status": "vietnamese-only"})
            continue
        if vi_relative is None:
            file_diffs.append({"file": display.as_posix(), "status": "english-only"})
            continue
        try:
            if en_relative.suffix.lower() == ".xml":
                en_counter = Counter(entry_keys(parse_xml(english_dir / en_relative)))
                vi_counter = Counter(
                    entry_keys(parse_xml(vietnamese_dir / vi_relative))
                )
                added = _counter_items(en_counter - vi_counter)
                removed = _counter_items(vi_counter - en_counter)
            else:
                en_counter = Counter(
                    cue.timing for cue in vtt_cues(parse_vtt(english_dir / en_relative))
                )
                vi_counter = Counter(
                    cue.timing
                    for cue in vtt_cues(parse_vtt(vietnamese_dir / vi_relative))
                )
                added = [
                    {"timing": timing, "count": count}
                    for timing, count in sorted((en_counter - vi_counter).items())
                ]
                removed = [
                    {"timing": timing, "count": count}
                    for timing, count in sorted((vi_counter - en_counter).items())
                ]
            if added or removed:
                file_diffs.append(
                    {
                        "file": display.as_posix(),
                        "status": "different",
                        "missingInVietnamese": added,
                        "extraInVietnamese": removed,
                    }
                )
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            file_diffs.append(
                {"file": display.as_posix(), "status": "invalid", "error": str(error)}
            )

    result["vietnamese"] = vietnamese.to_dict()
    result["diff"] = {
        "files": file_diffs,
        "differentFiles": len(file_diffs),
        "englishOnly": sum(item["status"] == "english-only" for item in file_diffs),
        "vietnameseOnly": sum(
            item["status"] == "vietnamese-only" for item in file_diffs
        ),
    }
    reporter("result", "inspect", result)
    return result
