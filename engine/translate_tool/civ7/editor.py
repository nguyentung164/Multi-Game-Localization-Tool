from __future__ import annotations

from pathlib import Path
from typing import Any

from ..common.formats import (
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
    _build_text_matcher,
    _display_loc_text,
    _iter_localization_matches,
    _replace_text_matches,
)
from ..common.types import (
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
    progress = ProgressThrottle(min_step=1)

    report_progress(
        reporter,
        "list-tags",
        {
            "processed": 0,
            "total": len(all_keys),
            "progress": 0,
            "file": "",
        },
        progress,
        force=True,
    )

    for file_index, key in enumerate(all_keys):
        cancel.check()
        en_relative = english_files.get(key)
        vi_relative = vietnamese_files.get(key)
        display = en_relative or vi_relative
        assert display is not None
        file_path = display.as_posix()

        for match in _iter_localization_matches(
            english_dir,
            vietnamese_dir,
            {key: en_relative} if en_relative else {},
            {key: vi_relative} if vi_relative else {},
            [key],
            cancel,
        ):
            matches.append(match)
            if not unlimited and len(matches) >= max_results:
                truncated = True
                break

        report_progress(
            reporter,
            "list-tags",
            {
                "processed": file_index + 1,
                "total": len(all_keys),
                "file": file_path,
            },
            progress,
        )

        if truncated:
            break

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


def replace_localization_vietnamese(
    english_dir: Path | None,
    vietnamese_dir: Path,
    query: str,
    replacement: str,
    *,
    case_sensitive: bool = False,
    whole_word: bool = False,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    normalized_query = query.strip()
    if not normalized_query:
        raise ValidationError("Thiếu query thay thế")
    if not vietnamese_dir.is_dir():
        raise ValidationError("Thư mục mod không hợp lệ")

    english_files = (
        collect_files(english_dir) if english_dir is not None and english_dir.is_dir() else {}
    )
    vietnamese_files = collect_files(vietnamese_dir)
    if not vietnamese_files:
        raise ValidationError("Không có file mod để thay thế")

    all_keys = sorted(set(english_files) | set(vietnamese_files))
    matches_text = _build_text_matcher(
        normalized_query,
        case_sensitive=case_sensitive,
        whole_word=whole_word,
    )
    pending_xml: dict[str, dict[tuple[str, str], str]] = {}
    pending_vtt: dict[str, dict[str, str]] = {}
    replaced_occurrences = 0
    updated_rows = 0
    progress = ProgressThrottle()
    candidates = 0

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
        cancel.check()
        vietnamese = match.get("vietnamese", "")
        if not matches_text(_display_loc_text(vietnamese)):
            continue
        candidates += 1
        next_text, count = _replace_text_matches(
            vietnamese,
            normalized_query,
            replacement,
            case_sensitive=case_sensitive,
            whole_word=whole_word,
        )
        if count == 0:
            continue
        file_path = match["file"]
        entry_type = match.get("entryType", "")
        if entry_type == "VTT":
            timing = str(match.get("timing") or match.get("tag") or "").strip()
            if not timing:
                continue
            pending_vtt.setdefault(file_path, {})[timing] = next_text
        else:
            tag = str(match.get("tag") or "").strip()
            if not tag:
                continue
            pending_xml.setdefault(file_path, {})[(entry_type, tag)] = next_text
        replaced_occurrences += count
        updated_rows += 1
        report_progress(
            reporter,
            "replace-tags",
            {
                "replaced": updated_rows,
                "replaceTotal": max(updated_rows, candidates),
                "processed": index + 1,
                "total": len(all_keys),
                "file": file_path,
            },
            progress,
        )

    for file_path, updates in pending_xml.items():
        target_path = vietnamese_dir / Path(file_path.replace("\\", "/"))
        if not target_path.is_file():
            raise ValidationError(f"Không tìm thấy file mod: {file_path}")
        tree = parse_xml(target_path)
        applied = 0
        for element in tagged_entries(tree, LOCALIZED_ENTRY_TYPES):
            key = entry_key(element)
            if key in updates:
                set_entry_text(element, updates[key])
                applied += 1
        if applied != len(updates):
            missing = len(updates) - applied
            raise ValidationError(
                f"Không cập nhật đủ tag trong {file_path} (thiếu {missing})"
            )
        write_xml_atomic(tree, target_path)

    for file_path, updates in pending_vtt.items():
        target_path = vietnamese_dir / Path(file_path.replace("\\", "/"))
        if not target_path.is_file():
            raise ValidationError(f"Không tìm thấy file mod: {file_path}")
        blocks = parse_vtt(target_path)
        applied = 0
        for block in vtt_cues(blocks):
            if block.timing in updates:
                set_vtt_cue_text(block, updates[block.timing])
                applied += 1
        if applied != len(updates):
            missing = len(updates) - applied
            raise ValidationError(
                f"Không cập nhật đủ cue VTT trong {file_path} (thiếu {missing})"
            )
        write_vtt_atomic(blocks, target_path)

    result = {
        "query": normalized_query,
        "replacement": replacement,
        "replacedOccurrences": replaced_occurrences,
        "updatedRows": updated_rows,
        "updatedFiles": len(pending_xml) + len(pending_vtt),
    }
    reporter("result", "replace-tags", result)
    return result
