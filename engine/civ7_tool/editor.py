from __future__ import annotations

from pathlib import Path
from typing import Any

from .formats import (
    LOCALIZED_ENTRY_TYPES,
    collect_files,
    entry_key,
    entry_text,
    parse_vtt,
    parse_xml,
    set_entry_text,
    set_vtt_cue_text,
    tagged_entries,
    vtt_cues,
    write_vtt_atomic,
    write_xml_atomic,
)
from .search import (
    DEFAULT_LIST_MAX_RESULTS,
    LIST_MAX_RESULTS_LIMIT,
    _iter_localization_matches,
)
from .types import (
    CancellationToken,
    ProgressThrottle,
    Reporter,
    ValidationError,
    null_reporter,
    report_progress,
)


def list_localization(
    english_dir: Path | None,
    vietnamese_dir: Path | None,
    *,
    max_results: int = DEFAULT_LIST_MAX_RESULTS,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    unlimited = max_results <= 0
    if not unlimited and (max_results < 1 or max_results > LIST_MAX_RESULTS_LIMIT):
        raise ValidationError(
            f"maxResults phải là 0 (không giới hạn) hoặc nằm trong 1..={LIST_MAX_RESULTS_LIMIT}"
        )

    english_files = (
        collect_files(english_dir) if english_dir is not None and english_dir.is_dir() else {}
    )
    vietnamese_files = (
        collect_files(vietnamese_dir)
        if vietnamese_dir is not None and vietnamese_dir.is_dir()
        else {}
    )
    if not english_files and not vietnamese_files:
        raise ValidationError("Cần ít nhất một thư mục export hoặc mod hợp lệ")

    all_keys = sorted(set(english_files) | set(vietnamese_files))
    matches: list[dict[str, Any]] = []
    truncated = False
    progress = ProgressThrottle()

    for index, match in enumerate(
        _iter_localization_matches(
            english_dir,
            vietnamese_dir,
            english_files,
            vietnamese_files,
            all_keys,
            cancel,
        )
    ):
        matches.append(match)
        if not unlimited and len(matches) >= max_results:
            truncated = True
            break
        report_progress(
            reporter,
            "list-tags",
            {
                "processed": index + 1,
                "total": len(all_keys),
                "file": match["file"],
            },
            progress,
        )

    if truncated:
        matches = matches[:max_results]

    result = {
        "scannedFiles": len(all_keys),
        "totalMatches": len(matches),
        "truncated": truncated,
        "matches": matches,
    }
    reporter("result", "list-tags", result)
    return result


def update_localization_entry(
    vietnamese_dir: Path,
    *,
    file: str,
    tag: str,
    entry_type: str,
    vietnamese: str,
    timing: str | None = None,
    reporter: Reporter = null_reporter,
) -> dict[str, Any]:
    if not vietnamese_dir.is_dir():
        raise ValidationError("Thư mục mod không hợp lệ")

    relative = Path(file.replace("\\", "/"))
    target_path = vietnamese_dir / relative
    if not target_path.is_file():
        raise ValidationError(f"Không tìm thấy file mod: {file}")

    normalized_type = (entry_type or "").strip()
    if normalized_type == "VTT":
        timing_value = (timing or tag or "").strip()
        if not timing_value:
            raise ValidationError("Thiếu timing cho mục VTT")
        blocks = parse_vtt(target_path)
        updated = False
        for block in vtt_cues(blocks):
            if block.timing == timing_value:
                set_vtt_cue_text(block, vietnamese)
                updated = True
                break
        if not updated:
            raise ValidationError(f"Không tìm thấy cue VTT: {timing_value}")
        write_vtt_atomic(blocks, target_path)
    else:
        if not tag.strip():
            raise ValidationError("Thiếu tag cho mục XML")
        tree = parse_xml(target_path)
        updated = False
        for element in tagged_entries(tree, LOCALIZED_ENTRY_TYPES):
            if entry_key(element) == (normalized_type, tag):
                set_entry_text(element, vietnamese)
                updated = True
                break
        if not updated:
            raise ValidationError(f"Không tìm thấy tag {tag} ({normalized_type})")
        write_xml_atomic(tree, target_path)

    result = {
        "file": relative.as_posix(),
        "tag": tag,
        "entryType": normalized_type,
        "vietnamese": vietnamese,
        "timing": timing,
    }
    reporter("result", "update-tag", result)
    return result
