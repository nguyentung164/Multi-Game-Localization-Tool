from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..common.formats import (
    collect_files,
    entry_key,
    iter_localized_text,
    parse_vtt,
    parse_xml,
    tagged_entries,
    text_children,
    vtt_cues,
    write_vtt_atomic,
    write_xml_atomic,
)
from ..common.language import detect_style, is_proper_name_file, needs_translation
from .qa import run_qa
from ..common.translation_core import (
    DEFAULT_MODELS,
    ClientFactory,
    GeminiTranslator as CoreGeminiTranslator,
    TranslationConfig,
    TranslationProfile,
    default_client_factory as _default_client_factory,
    error_info as _error_info,
    parse_response as _parse_response,
    response_config as _core_response_config,
)
from ..common.types import (
    CancellationToken,
    CancelledError,
    QuotaExhaustedError,
    Reporter,
    ValidationError,
    null_reporter,
    report_progress,
    report_warning,
    ProgressThrottle,
)


CIV7_PROFILE = TranslationProfile(
    id="civ7-en-vi-v1",
    source_language="English",
    target_language="Tiếng Việt",
    system_instruction=(
        "Dịch localization Civilization VII từ tiếng Anh sang tiếng Việt. "
        "Giữ nguyên tuyệt đối mọi token/placeholder trong {}, [], [TIP] và cú pháp "
        "plural. Không đổi id, không giải thích. Chỉ trả JSON array gồm các object "
        'có dạng {"id":"...","text":"..."}.'
    ),
    style_rules={
        "leader": "Lời thoại lãnh đạo: tự nhiên, mạnh mẽ và nhất quán xưng hô.",
        "lore": "Civilopedia/narrative: trang trọng, mạch lạc, giữ tên riêng.",
        "ui": "UI/menu: ngắn gọn, rõ nghĩa.",
        "game": "Văn bản game chiến lược: tự nhiên và nhất quán thuật ngữ.",
        "default": "Dịch tự nhiên và nhất quán thuật ngữ.",
    },
    supports_legacy_cache=True,
)


def _response_config() -> Any:
    """Alias tương thích cho các caller/test cũ của adapter CIV7."""
    return _core_response_config(CIV7_PROFILE)


class GeminiTranslator(CoreGeminiTranslator):
    """Adapter CIV7 giữ nguyên API khởi tạo trước khi tách translation core."""

    def __init__(
        self,
        config: TranslationConfig,
        *,
        reporter: Reporter = null_reporter,
        cancel: CancellationToken | None = None,
        client_factory: ClientFactory | None = None,
    ) -> None:
        super().__init__(
            config,
            CIV7_PROFILE,
            reporter=reporter,
            cancel=cancel,
            client_factory=client_factory,
            event_step="translate",
        )


def _xml_pending_sources(
    target_path: Path,
    english_path: Path | None,
    id_prefix: str,
) -> list[dict[str, Any]]:
    if is_proper_name_file(target_path):
        return []
    target_tree = parse_xml(target_path)
    english_lookup: defaultdict[tuple[str, str], deque[list[str]]] = defaultdict(deque)
    has_english = bool(english_path and english_path.is_file())
    if has_english:
        assert english_path is not None
        english_tree = parse_xml(english_path)
        for element in tagged_entries(english_tree):
            values = [child.text or "" for child in text_children(element)]
            if values:
                english_lookup[entry_key(element)].append(values)

    pending: list[dict[str, Any]] = []
    sequence = 0
    english_values_by_occurrence: dict[tuple[tuple[str, str], int], deque[str]] = {}
    for element, _text_element in iter_localized_text(target_tree):
        key = entry_key(element)
        identity = id(element)
        marker = (key, identity)
        if marker not in english_values_by_occurrence:
            english_values_by_occurrence[marker] = deque(
                english_lookup[key].popleft() if english_lookup[key] else []
            )
    for element, text_element in iter_localized_text(target_tree):
        key = entry_key(element)
        english_values = english_values_by_occurrence[(key, id(element))]
        source = (
            english_values.popleft() if english_values else (text_element.text or "")
        )
        current = text_element.text or ""
        if not needs_translation(current, source if has_english else None):
            continue
        sequence += 1
        pending.append(
            {
                "id": f"{id_prefix}-xml-{sequence}",
                "text": source.strip(),
                "tag": element.get("Tag"),
                "current": current,
            }
        )
    return pending


def _apply_xml_translations(
    target_path: Path,
    english_path: Path | None,
    translations: Mapping[str, str],
    id_prefix: str,
    *,
    dry_run: bool,
) -> tuple[int, list[dict[str, Any]]]:
    pending = _xml_pending_sources(target_path, english_path, id_prefix)
    if not pending:
        return 0, []
    target_tree = parse_xml(target_path)
    english_lookup: defaultdict[tuple[str, str], deque[list[str]]] = defaultdict(deque)
    has_english = bool(english_path and english_path.is_file())
    if has_english:
        assert english_path is not None
        english_tree = parse_xml(english_path)
        for element in tagged_entries(english_tree):
            values = [child.text or "" for child in text_children(element)]
            if values:
                english_lookup[entry_key(element)].append(values)
    english_values_by_occurrence: dict[tuple[tuple[str, str], int], deque[str]] = {}
    for element, _text_element in iter_localized_text(target_tree):
        key = entry_key(element)
        identity = id(element)
        marker = (key, identity)
        if marker not in english_values_by_occurrence:
            english_values_by_occurrence[marker] = deque(
                english_lookup[key].popleft() if english_lookup[key] else []
            )
    sequence = 0
    changes: list[dict[str, Any]] = []
    for element, text_element in iter_localized_text(target_tree):
        key = entry_key(element)
        english_values = english_values_by_occurrence[(key, id(element))]
        source = (
            english_values.popleft() if english_values else (text_element.text or "")
        )
        current = text_element.text or ""
        if not needs_translation(current, source if has_english else None):
            continue
        sequence += 1
        item_id = f"{id_prefix}-xml-{sequence}"
        translated = translations.get(item_id)
        if translated is None or translated == current:
            continue
        changes.append(
            {
                "tag": element.get("Tag"),
                "source": source.strip()[:300],
                "target": translated[:300],
            }
        )
        if not dry_run:
            text_element.text = translated
    if changes and not dry_run:
        write_xml_atomic(target_tree, target_path)
    return len(changes), changes


def _vtt_pending_sources(
    target_path: Path,
    english_path: Path | None,
    id_prefix: str,
) -> list[dict[str, Any]]:
    target_blocks = parse_vtt(target_path)
    english_by_timing: defaultdict[str, deque[str]] = defaultdict(deque)
    if english_path and english_path.is_file():
        for cue in vtt_cues(parse_vtt(english_path)):
            if cue.timing:
                english_by_timing[cue.timing].append(cue.text)
    pending: list[dict[str, Any]] = []
    for sequence, cue in enumerate(vtt_cues(target_blocks), start=1):
        source = (
            english_by_timing[cue.timing].popleft()
            if cue.timing and english_by_timing[cue.timing]
            else cue.text
        )
        if not needs_translation(cue.text, source):
            continue
        pending.append(
            {
                "id": f"{id_prefix}-vtt-{sequence}",
                "text": source.strip(),
                "timing": cue.timing,
                "current": cue.text,
            }
        )
    return pending


def _apply_vtt_translations(
    target_path: Path,
    english_path: Path | None,
    translations: Mapping[str, str],
    id_prefix: str,
    *,
    dry_run: bool,
) -> tuple[int, list[dict[str, Any]]]:
    pending = _vtt_pending_sources(target_path, english_path, id_prefix)
    if not pending:
        return 0, []
    target_blocks = parse_vtt(target_path)
    english_by_timing: defaultdict[str, deque[str]] = defaultdict(deque)
    if english_path and english_path.is_file():
        for cue in vtt_cues(parse_vtt(english_path)):
            if cue.timing:
                english_by_timing[cue.timing].append(cue.text)
    changes: list[dict[str, Any]] = []
    for sequence, cue in enumerate(vtt_cues(target_blocks), start=1):
        source = (
            english_by_timing[cue.timing].popleft()
            if cue.timing and english_by_timing[cue.timing]
            else cue.text
        )
        if not needs_translation(cue.text, source):
            continue
        item_id = f"{id_prefix}-vtt-{sequence}"
        translated = translations.get(item_id)
        if translated is None or translated == cue.text:
            continue
        changes.append(
            {
                "timing": cue.timing,
                "source": source.strip()[:300],
                "target": translated[:300],
            }
        )
        if not dry_run:
            assert cue.timing_index is not None
            cue.lines = cue.lines[: cue.timing_index + 1] + translated.splitlines()
    if changes and not dry_run:
        write_vtt_atomic(target_blocks, target_path)
    return len(changes), changes


def _translate_xml(
    target_path: Path,
    english_path: Path | None,
    translator: GeminiTranslator,
) -> tuple[int, list[dict[str, Any]]]:
    pending = _xml_pending_sources(target_path, english_path, "solo")
    if not pending:
        if is_proper_name_file(target_path):
            translator.stats.items_skipped += 1
        return 0, []
    translations = translator.translate_items(
        [{"id": item["id"], "text": item["text"]} for item in pending],
        detect_style(target_path),
        target_path.as_posix(),
    )
    return _apply_xml_translations(
        target_path,
        english_path,
        translations,
        "solo",
        dry_run=translator.config.dry_run,
    )


def _translate_vtt(
    target_path: Path,
    english_path: Path | None,
    translator: GeminiTranslator,
) -> tuple[int, list[dict[str, Any]]]:
    pending = _vtt_pending_sources(target_path, english_path, "solo")
    if not pending:
        return 0, []
    translations = translator.translate_items(
        [{"id": item["id"], "text": item["text"]} for item in pending],
        "lore",
        target_path.as_posix(),
    )
    return _apply_vtt_translations(
        target_path,
        english_path,
        translations,
        "solo",
        dry_run=translator.config.dry_run,
    )


def translate_localization(
    english_dir: Path,
    target_dir: Path,
    config: TranslationConfig,
    *,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
    client_factory: ClientFactory | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    english = english_dir.resolve()
    target = target_dir.resolve()
    if not english.is_dir() or not target.is_dir():
        raise ValidationError("English và Vietnam phải là thư mục tồn tại")
    if english == target:
        raise ValidationError("English và Vietnam không được là cùng một thư mục")
    try:
        target.relative_to(english)
        raise ValidationError("English và Vietnam không được lồng nhau")
    except ValueError:
        pass
    try:
        english.relative_to(target)
        raise ValidationError("English và Vietnam không được lồng nhau")
    except ValueError:
        pass
    translator = GeminiTranslator(
        config, reporter=reporter, cancel=cancel, client_factory=client_factory
    )
    english_files = collect_files(english)
    target_files = collect_files(target)
    changes: list[dict[str, Any]] = []
    quota_error: str | None = None
    progress = ProgressThrottle()
    target_keys = sorted(target_files)

    jobs: list[dict[str, Any]] = []
    for index, key in enumerate(target_keys, start=1):
        cancel.check()
        if config.max_files and len(jobs) >= config.max_files:
            break
        relative = target_files[key]
        target_path = target / relative
        english_path = english / english_files[key] if key in english_files else None
        report_progress(
            reporter,
            "translate",
            {
                "phase": "file",
                "processed": index,
                "total": len(target_keys),
                "file": relative.as_posix(),
                "index": index,
                "title": f"Thu thập {index}/{len(target_keys)}",
                "description": relative.as_posix(),
            },
            progress,
            force=True,
        )
        try:
            id_prefix = f"f{len(jobs) + 1}"
            if target_path.suffix.lower() == ".xml":
                if is_proper_name_file(target_path):
                    translator.stats.items_skipped += 1
                    translator.stats.files_processed += 1
                    continue
                pending = _xml_pending_sources(target_path, english_path, id_prefix)
                style = detect_style(target_path)
                kind = "xml"
            else:
                pending = _vtt_pending_sources(target_path, english_path, id_prefix)
                style = "lore"
                kind = "vtt"
            translator.stats.files_processed += 1
            if not pending:
                continue
            jobs.append(
                {
                    "idPrefix": id_prefix,
                    "relative": relative.as_posix(),
                    "targetPath": target_path,
                    "englishPath": english_path,
                    "style": style,
                    "kind": kind,
                    "pending": pending,
                }
            )
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            translator.stats.errors.append(
                {"file": relative.as_posix(), "error": str(error)}
            )

    if jobs:
        groups = [
            (
                [{"id": item["id"], "text": item["text"]} for item in job["pending"]],
                job["style"],
                job["targetPath"].as_posix(),
            )
            for job in jobs
        ]
        try:
            translations = translator.translate_groups(groups)
        except QuotaExhaustedError as error:
            quota_error = str(error)
            translations = dict(getattr(translator, "_partial_translations", {}))
            for job in jobs:
                style = job["style"]
                for item in job["pending"]:
                    if item["id"] in translations:
                        continue
                    cached = translator._lookup_cached(item["text"], style)
                    if cached is not None:
                        translations[item["id"]] = cached
        except CancelledError:
            raise
        except ValidationError:
            raise

        for job in jobs:
            cancel.check()
            ids = [item["id"] for item in job["pending"]]
            if not all(item_id in translations for item_id in ids):
                continue
            try:
                if job["kind"] == "xml":
                    changed, file_changes = _apply_xml_translations(
                        job["targetPath"],
                        job["englishPath"],
                        translations,
                        job["idPrefix"],
                        dry_run=config.dry_run,
                    )
                else:
                    changed, file_changes = _apply_vtt_translations(
                        job["targetPath"],
                        job["englishPath"],
                        translations,
                        job["idPrefix"],
                        dry_run=config.dry_run,
                    )
                if changed:
                    translator.stats.files_changed += 1
                    translator.stats.items_translated += changed
                    changes.append({"file": job["relative"], "items": file_changes})
                report_progress(
                    reporter,
                    "translate",
                    {
                        "phase": "file",
                        "file": job["relative"],
                        "title": f"Đã ghi {job['relative']}",
                        "description": f"{changed} thay đổi",
                    },
                    progress,
                    force=True,
                )
            except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
                translator.stats.errors.append(
                    {"file": job["relative"], "error": str(error)}
                )

    translator.flush_cache(force=True)
    qa = run_qa(target, english, reporter=reporter, cancel=cancel)
    if not qa.get("passed"):
        report_warning(
            reporter,
            "translate",
            {
                "phase": "qa-summary",
                "issueCount": qa.get("issueCount", 0),
                "issueCounts": qa.get("issueCounts", {}),
            },
        )
    result = {
        "english": str(english),
        "target": str(target),
        "dryRun": config.dry_run,
        "models": list(config.models),
        "stats": translator.stats.to_dict(),
        "changes": changes,
        "quotaExhausted": quota_error,
        "qa": qa,
        "workersUsed": getattr(translator, "_workers_used", 0),
    }
    reporter("result", "translate", result)
    return result
