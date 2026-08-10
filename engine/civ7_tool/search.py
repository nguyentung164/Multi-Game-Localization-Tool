from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .formats import (
    collect_files,
    entry_key,
    entry_text,
    parse_vtt,
    parse_xml,
    tagged_entries,
    vtt_cues,
)
from .types import (
    CancellationToken,
    ProgressThrottle,
    Reporter,
    ValidationError,
    null_reporter,
    report_progress,
)

SEARCH_SCOPES = frozenset({"all", "tag", "english", "vietnamese", "file"})
DEFAULT_MAX_RESULTS = 500
MAX_RESULTS_LIMIT = 5000
LIST_MAX_RESULTS_LIMIT = 500_000
DEFAULT_LIST_MAX_RESULTS = 0  # 0 = không giới hạn


def _normalize_query(query: str) -> str:
    return query.strip()


def _display_loc_text(text: str) -> str:
    if not text:
        return text
    text = text.replace("\r\n", "\n")
    text = re.sub(r"\n[\t ]*", " ", text)
    text = text.replace("\t", " ")
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def _build_text_matcher(
    query: str, *, case_sensitive: bool, whole_word: bool
) -> Callable[[str], bool]:
    if not query:
        return lambda _value: False
    flags = re.UNICODE | (0 if case_sensitive else re.IGNORECASE)
    escaped = re.escape(query)
    if whole_word:
        expression = re.compile(
            rf"(?:^|[^\w]){escaped}(?=$|[^\w])",
            flags,
        )
        return lambda value: bool(value and expression.search(value))
    if case_sensitive:
        return lambda value: bool(value and query in value)
    needle = query.casefold()
    return lambda value: bool(value and needle in value.casefold())


def _matches(
    query: str,
    scope: str,
    *,
    file: str,
    tag: str,
    english: str,
    vietnamese: str,
    timing: str | None = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
    matches_text: Callable[[str], bool] | None = None,
) -> bool:
    if not query:
        return False
    contains = matches_text or _build_text_matcher(
        query,
        case_sensitive=case_sensitive,
        whole_word=whole_word,
    )

    if scope == "tag":
        haystacks = [tag]
        if timing:
            haystacks.append(timing)
        return any(contains(value) for value in haystacks if value)
    if scope == "english":
        return contains(_display_loc_text(english))
    if scope == "vietnamese":
        return contains(_display_loc_text(vietnamese))
    if scope == "file":
        return contains(file)
    fields = [file, tag, _display_loc_text(english), _display_loc_text(vietnamese)]
    if timing:
        fields.append(timing)
    return any(contains(value) for value in fields if value)


def _text_by_entry_key(tree) -> dict[tuple[str, str], str]:
    return {entry_key(element): entry_text(element) for element in tagged_entries(tree)}


def _vtt_by_timing(path: Path) -> dict[str, str]:
    return {
        block.timing or "": block.text
        for block in vtt_cues(parse_vtt(path))
        if block.timing
    }


def _iter_localization_matches(
    english_dir: Path | None,
    vietnamese_dir: Path | None,
    english_files: dict[str, Path],
    vietnamese_files: dict[str, Path],
    all_keys: list[str],
    cancel: CancellationToken,
):
    for key in all_keys:
        cancel.check()
        en_relative = english_files.get(key)
        vi_relative = vietnamese_files.get(key)
        display = en_relative or vi_relative
        assert display is not None
        file_path = display.as_posix()

        try:
            if display.suffix.lower() == ".xml":
                en_map: dict[tuple[str, str], str] = {}
                vi_map: dict[tuple[str, str], str] = {}
                if en_relative is not None and english_dir is not None:
                    en_map = _text_by_entry_key(parse_xml(english_dir / en_relative))
                if vi_relative is not None and vietnamese_dir is not None:
                    vi_map = _text_by_entry_key(parse_xml(vietnamese_dir / vi_relative))
                for entry_key_val in sorted(set(en_map) | set(vi_map)):
                    entry_type, tag = entry_key_val
                    yield {
                        "id": f"match-{entry_type}-{tag}-{file_path}",
                        "file": file_path,
                        "tag": tag,
                        "entryType": entry_type,
                        "english": en_map.get(entry_key_val, ""),
                        "vietnamese": vi_map.get(entry_key_val, ""),
                    }
            else:
                en_map: dict[str, str] = {}
                vi_map: dict[str, str] = {}
                if en_relative is not None and english_dir is not None:
                    en_map = _vtt_by_timing(english_dir / en_relative)
                if vi_relative is not None and vietnamese_dir is not None:
                    vi_map = _vtt_by_timing(vietnamese_dir / vi_relative)
                for timing in sorted(set(en_map) | set(vi_map)):
                    yield {
                        "id": f"match-vtt-{timing}-{file_path}",
                        "file": file_path,
                        "tag": timing,
                        "entryType": "VTT",
                        "english": en_map.get(timing, ""),
                        "vietnamese": vi_map.get(timing, ""),
                        "timing": timing,
                    }
        except (OSError, UnicodeError, ValueError):
            continue


def search_localization(
    english_dir: Path | None,
    vietnamese_dir: Path | None,
    query: str,
    *,
    scope: str = "all",
    max_results: int = DEFAULT_MAX_RESULTS,
    case_sensitive: bool = False,
    whole_word: bool = False,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    normalized_query = _normalize_query(query)
    normalized_scope = (scope or "all").strip().casefold()
    if normalized_scope not in SEARCH_SCOPES:
        raise ValidationError(f"scope không hợp lệ: {scope}")
    if max_results < 1 or max_results > MAX_RESULTS_LIMIT:
        raise ValidationError(f"maxResults phải nằm trong 1..={MAX_RESULTS_LIMIT}")

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

    if not normalized_query:
        result = {
            "query": "",
            "scope": normalized_scope,
            "scannedFiles": 0,
            "totalMatches": 0,
            "truncated": False,
            "matches": [],
        }
        reporter("result", "search-tags", result)
        return result

    all_keys = sorted(set(english_files) | set(vietnamese_files))
    matches: list[dict[str, Any]] = []
    truncated = False
    scanned = 0
    progress = ProgressThrottle()
    matches_text = _build_text_matcher(
        normalized_query,
        case_sensitive=case_sensitive,
        whole_word=whole_word,
    )

    for index, key in enumerate(all_keys):
        cancel.check()
        scanned += 1
        en_relative = english_files.get(key)
        vi_relative = vietnamese_files.get(key)
        display = en_relative or vi_relative
        assert display is not None
        file_path = display.as_posix()

        file_matches: list[dict[str, Any]] = []
        try:
            for match in _iter_localization_matches(
                english_dir,
                vietnamese_dir,
                {key: en_relative} if en_relative else {},
                {key: vi_relative} if vi_relative else {},
                [key],
                cancel,
            ):
                if not _matches(
                    normalized_query,
                    normalized_scope,
                    file=match["file"],
                    tag=match["tag"],
                    english=match["english"],
                    vietnamese=match["vietnamese"],
                    timing=match.get("timing"),
                    case_sensitive=case_sensitive,
                    whole_word=whole_word,
                    matches_text=matches_text,
                ):
                    continue
                file_matches.append(match)
        except (OSError, UnicodeError, ValueError):
            continue

        matches.extend(file_matches)

        if len(matches) >= max_results:
            truncated = True
            matches = matches[:max_results]
            break

        report_progress(
            reporter,
            "search-tags",
            {
                "processed": index + 1,
                "total": len(all_keys),
                "file": file_path,
            },
            progress,
        )

    result = {
        "query": normalized_query,
        "scope": normalized_scope,
        "scannedFiles": scanned,
        "totalMatches": len(matches),
        "truncated": truncated,
        "matches": matches,
    }
    reporter("result", "search-tags", result)
    return result
