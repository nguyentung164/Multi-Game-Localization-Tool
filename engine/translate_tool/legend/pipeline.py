from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import uuid
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.formats import atomic_bytes_write, atomic_copy, atomic_text_write, file_sha256
from .han_viet import (
    build_term_bank,
    classify_term_gaps,
    code_switch_source,
    glossary_hints_from_sources,
    han_viet_overrides,
)
from ..common.language import has_han, is_translatable_bracket_tag
from .qa import run_legend_qa
from ..common.translation_core import (
    ClientFactory,
    GeminiTranslator,
    TranslationConfig,
    TranslationProfile,
    estimate_worker_count,
    translation_glossary_hash,
)
from ..common.types import (
    CancellationToken,
    ProgressThrottle,
    Reporter,
    RestoreFingerprintConflict,
    StalePreviewError,
    TranslationStats,
    ValidationError,
    null_reporter,
    report_progress,
    report_warning,
)

UTF8_BOM = b"\xef\xbb\xbf"
LEGEND_PROFILE = TranslationProfile(
    id="legend-three-kingdoms-zh-vi-v1",
    source_language="Tiếng Trung",
    target_language="Tiếng Việt",
    system_instruction=(
        "Bạn là dịch giả Việt hóa game Legend of Heroes: Three Kingdoms (Tam Quốc). "
        "Dịch Trung → Việt, chữ Quốc ngữ. "
        "Thuật ngữ khóa trong user prompt thắng mọi luật dưới đây.\n"
        "Nếu nguồn đã chứa tên tiếng Việt: giữ nguyên đúng chính tả, không dịch lại. "
        "CẤM sót chữ Hán. CẤM pinyin. CẤM nuốt phụ âm đầu Ng/Nh/H.\n"
        "Phân loại từng text theo thứ tự 1→5, rồi dịch:\n"
        "1) Tên người / tự / địa danh lịch sử → âm Hán-Việt, hoa từng tiếng; "
        "không dịch nghĩa. Tên đã có trong sử sách Việt thì dùng đúng tên định danh. "
        "刘备 → Lưu Bị. 西川 → Tây Xuyên (cấm: Tây X川).\n"
        "2) Binh khí / bảo vật / ngựa đã có tên riêng (glossary hoặc danh hiệu cố định) "
        "→ Hán-Việt định danh, hoa từng tiếng.\n"
        "3) Vật phẩm / kỹ năng generic dạng X之Y / X的Y (符/药/术/…) và danh xưng đơn vị "
        "→ dịch nghĩa cả cụm, loại vật phẩm lên trước, hoa từng tiếng. "
        "Không dịch 之/的 thành chi/đích. "
        "洞悉之符 → Phù Thấu Thị (cấm: Động Tất Chi Phù). "
        "之/的 trong câu kể (之后/之间/之子) → sau đó / giữa / con của.\n"
        "4) Câu kể / tiểu sử / mô tả → văn Việt tự nhiên, ngắt câu. "
        "Chức tước trong câu viết thường. "
        "Vũ khí hoặc vật phẩm chỉ mô tả — dịch nghĩa, không phiên từng chữ. "
        "开山大斧 → đại phủ (cấm: Khai Sơn Đại Rìu).\n"
        "5) UI / nhãn ngắn → hoa chữ cái đầu. Nhãn kỹ năng giữ []: [瞬] → [Tức].\n"
        "Viết hoa: tiếng Trung không phân biệt hoa/thường — bản Việt tự quyết. "
        "Danh xưng riêng: hoa từng tiếng. Danh từ chung trong câu: viết thường. "
        "Đầu câu/UI: hoa chữ cái đầu.\n"
        "Dấu câu Trung → Việt: ，；：。！？、 → , ; : . ! ? , "
        "Fullwidth （）％【】 → ()%[]. "
        "Giữ nguyên số, 20%, +15, x2, Lv.3, {0}/{name}, regex, HTML, [TIP:], \\n, \\t. "
        "Không đổi id, không giải thích; chỉ trả JSON array gồm object id/text."
        "Trường text chỉ là tiếng Việt (chữ Quốc ngữ); không Trung, không Anh, không pinyin, không chú thích."
    ),
    style_rules={
        "legend": (
            "Áp dụng cây phân loại 1→5. "
            "Tên: Hán-Việt, không sót Hán, không nuốt Ng/Nh/H. "
            "Tên Việt đã có trong nguồn: giữ nguyên. "
            "Item X之Y: loại lên trước, không dịch 之 thành chi. "
            "Câu kể: văn Việt; vũ khí mô tả dịch nghĩa. "
            "Giữ {0}, regex, HTML; đổi dấu câu Trung sang Việt."
        ),
        "legend_retry": (
            "Dịch lại TOÀN BỘ câu. Nguồn đã nhúng tên Hán-Việt — giữ nguyên các tên đó. "
            "CẤM sót chữ Hán. CẤM thiếu tên đã có trong nguồn. "
            "Giữ {0}, regex, HTML; đổi dấu câu Trung sang Việt."
        ),
        "default": (
            "Dịch lịch sử Tam Quốc tự nhiên, Hán-Việt chuẩn, viết hoa tên riêng đúng "
            "quy tắc tiếng Việt."
        ),
    },
)

LEGEND_RETRY_MAX_PASSES = 3

_COMMENT_PREFIXES = ("#", ";", "//")
_PROTECTED_PATTERN = re.compile(
    r"(\\.|</?[^>\r\n]+>|\{[^{}\r\n]*\}|\[[^\]\r\n]*\]|"
    r"%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]|\(\?[<!=:]?|[.^$|*+?()])"
)


@dataclass(frozen=True)
class LegendLine:
    number: int
    body: str
    ending: str
    kind: str
    left: str | None = None
    right: str | None = None
    source: str | None = None
    warning: str | None = None

    @property
    def raw(self) -> str:
        return self.body + self.ending


@dataclass(frozen=True)
class LegendDocument:
    source_path: Path
    bom: bool
    lines: tuple[LegendLine, ...]
    fingerprint: str

    @property
    def entries(self) -> tuple[LegendLine, ...]:
        return tuple(line for line in self.lines if line.kind == "entry")

    @property
    def warnings(self) -> tuple[dict[str, Any], ...]:
        return tuple(
            {"line": line.number, "message": line.warning, "raw": line.body}
            for line in self.lines
            if line.warning
        )

    def render(self, translations: Mapping[str, str]) -> bytes:
        chunks: list[str] = []
        for line in self.lines:
            if line.kind == "entry":
                assert line.left is not None and line.source is not None
                chunks.append(
                    f"{line.left}={_escape_legend_value(translations.get(line.source, line.source))}{line.ending}"
                )
            else:
                chunks.append(line.raw)
        payload = "".join(chunks).encode("utf-8")
        return (UTF8_BOM if self.bom else b"") + payload

    def render_line_targets(self, targets: Mapping[int, str]) -> bytes:
        chunks: list[str] = []
        for line in self.lines:
            if line.kind == "entry" and line.number in targets:
                assert line.left is not None
                chunks.append(
                    f"{line.left}={_escape_legend_value(targets[line.number])}{line.ending}"
                )
            else:
                chunks.append(line.raw)
        payload = "".join(chunks).encode("utf-8")
        return (UTF8_BOM if self.bom else b"") + payload


def _line_parts(raw: str) -> tuple[str, str]:
    if raw.endswith("\r\n"):
        return raw[:-2], "\r\n"
    if raw.endswith(("\n", "\r")):
        return raw[:-1], raw[-1]
    return raw, ""


def _equals_slash_count(text: str, index: int) -> int:
    slash_count = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        slash_count += 1
        cursor -= 1
    return slash_count


def _first_unescaped_equals(text: str) -> int | None:
    for index, character in enumerate(text):
        if character == "=" and _equals_slash_count(text, index) % 2 == 0:
            return index
    return None


def _last_escaped_equals(text: str) -> int | None:
    last = None
    for index, character in enumerate(text):
        if character == "=" and _equals_slash_count(text, index) % 2 == 1:
            last = index
    return last


def _split_legend_kv(body: str) -> tuple[str, str] | None:
    separator = _first_unescaped_equals(body)
    if separator is not None:
        return body[:separator], body[separator + 1 :]
    separator = _last_escaped_equals(body)
    if separator is None:
        return None
    return body[: separator + 1], body[separator + 1 :]


def _escape_unescaped_equals(text: str) -> str:
    """Escape literal equals in generated values without double-escaping existing ones."""
    chunks: list[str] = []
    for index, character in enumerate(text):
        if character != "=":
            chunks.append(character)
            continue
        slash_count = 0
        cursor = index - 1
        while cursor >= 0 and text[cursor] == "\\":
            slash_count += 1
            cursor -= 1
        if slash_count % 2 == 0:
            chunks.append("\\")
        chunks.append(character)
    return "".join(chunks)


def _escape_legend_value(text: str) -> str:
    """Giữ value trên một dòng vật lý: CR/LF/tab thật → literal \\r \\n \\t."""
    chunks: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        if text[index] == "\\" and index + 1 < length and text[index + 1] in "rnt":
            chunks.append(text[index : index + 2])
            index += 2
            continue
        character = text[index]
        if character == "\r":
            chunks.append("\\r")
        elif character == "\n":
            chunks.append("\\n")
        elif character == "\t":
            chunks.append("\\t")
        else:
            chunks.append(character)
        index += 1
    return _escape_unescaped_equals("".join(chunks))


def _parse_line(number: int, raw: str) -> LegendLine:
    body, ending = _line_parts(raw)
    stripped = body.lstrip()
    if not stripped:
        return LegendLine(number, body, ending, "blank")
    if stripped.startswith(_COMMENT_PREFIXES):
        return LegendLine(number, body, ending, "comment")
    split = _split_legend_kv(body)
    if split is None:
        return LegendLine(
            number,
            body,
            ending,
            "invalid",
            warning="Không tìm thấy dấu = chưa escape",
        )
    left, right = split
    if not left.strip():
        return LegendLine(
            number,
            body,
            ending,
            "invalid",
            warning="Key trước dấu = bị rỗng",
        )
    return LegendLine(
        number,
        body,
        ending,
        "entry",
        left=left,
        right=right,
        source=left.replace(r"\=", "="),
    )


def parse_legend_file(source_path: Path) -> LegendDocument:
    source = source_path.expanduser().resolve()
    if not source.is_file():
        raise ValidationError(f"Không tìm thấy file bản dịch: {source}")
    data = source.read_bytes()
    bom = data.startswith(UTF8_BOM)
    payload = data[len(UTF8_BOM) :] if bom else data
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValidationError("Legend adapter chỉ hỗ trợ UTF-8/UTF-8 BOM") from error
    raw_lines = text.splitlines(keepends=True)
    if text and not raw_lines:
        raw_lines = [text]
    lines = tuple(_parse_line(index, raw) for index, raw in enumerate(raw_lines, 1))
    return LegendDocument(source, bom, lines, hashlib.sha256(data).hexdigest())


def _inspection(document: LegendDocument, sample_size: int) -> dict[str, Any]:
    entries = document.entries
    counts = Counter(line.source for line in entries)
    endings = Counter(
        {"\r\n": "CRLF", "\n": "LF", "\r": "CR"}.get(line.ending, "none")
        for line in document.lines
    )
    workset = classify_legend_entries(entries, force=False)
    return {
        "source": str(document.source_path),
        "fingerprint": document.fingerprint,
        "inspection": {
            "encoding": "utf-8-sig" if document.bom else "utf-8",
            "bom": document.bom,
            "lineEndings": dict(sorted(endings.items())),
            "lines": len(document.lines),
            "entries": len(entries),
            "uniqueSources": len(counts),
            "syntaxSources": sum(
                bool(_PROTECTED_PATTERN.search(line.source or "")) for line in entries
            ),
            "duplicates": sum(count - 1 for count in counts.values()),
            "comments": sum(line.kind == "comment" for line in document.lines),
            "blankLines": sum(line.kind == "blank" for line in document.lines),
            "invalidLines": sum(line.kind == "invalid" for line in document.lines),
            "pendingEntries": len(workset.pending_line_numbers),
            "doneEntries": len(workset.done_line_numbers),
            "doneItems": workset.done_items,
            "reusedItems": workset.reused_items,
            "pendingItems": len(workset.api_sources),
        },
        "sample": [
            {
                "line": line.number,
                "key": line.left,
                "source": line.source,
                "currentTarget": line.right,
            }
            for line in entries[: max(0, sample_size)]
        ],
        "warnings": list(document.warnings),
    }


def inspect_legend(
    source_path: Path,
    *,
    sample_size: int = 20,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    document = parse_legend_file(source_path)
    result = _inspection(document, sample_size)
    for warning in document.warnings:
        report_warning(
            reporter,
            "inspect",
            {
                "phase": "legend-parse",
                "message": warning["message"],
                "description": f"Dòng {warning['line']}: {warning['raw']}",
                **warning,
            },
        )
    reporter("result", "inspect", result)
    return result


LEGEND_LIST_KINDS = frozenset(
    {"entry", "invalid", "duplicate", "all", "pending", "done"}
)
LEGEND_LIST_PAGE_MAX = 500


def list_legend_entries(
    source_path: Path,
    *,
    offset: int = 0,
    limit: int = 100,
    kind: str = "entry",
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    if kind not in LEGEND_LIST_KINDS:
        raise ValidationError(
            "kind phải là entry, invalid, duplicate, pending, done hoặc all"
        )
    if offset < 0:
        raise ValidationError("offset phải >= 0")
    limit = max(1, min(limit, LEGEND_LIST_PAGE_MAX))
    document = parse_legend_file(source_path)
    workset = classify_legend_entries(document.entries, force=False)
    parsed: list[dict[str, Any]] = []
    source_counts: Counter[str] = Counter()
    warning_reasons: list[str] = []
    entry_total = 0
    invalid_total = 0
    for line in document.lines:
        if line.kind not in {"entry", "invalid"}:
            continue
        source = line.source if line.kind == "entry" else line.body.strip()
        current_target = line.right or ""
        warning = line.warning
        if line.kind == "entry" and source:
            entry_total += 1
            source_counts[source] += 1
        elif line.kind == "invalid":
            invalid_total += 1
            if warning and warning not in warning_reasons:
                warning_reasons.append(warning)
        parsed.append(
            {
                "lineNumber": line.number,
                "source": source,
                "currentTarget": current_target,
                "kind": line.kind,
                "warning": warning,
            }
        )
    duplicate_total = sum(
        1
        for item in parsed
        if item["kind"] == "entry" and source_counts.get(str(item["source"]), 0) > 1
    )
    pending_total = sum(
        1
        for item in parsed
        if item["kind"] == "entry" and int(item["lineNumber"]) in workset.pending_line_numbers
    )
    done_total = sum(
        1
        for item in parsed
        if item["kind"] == "entry" and int(item["lineNumber"]) in workset.done_line_numbers
    )

    def matches(item: Mapping[str, Any]) -> bool:
        if kind == "all":
            return True
        if kind == "invalid":
            return item["kind"] == "invalid"
        if kind == "duplicate":
            return (
                item["kind"] == "entry"
                and source_counts.get(str(item["source"]), 0) > 1
            )
        if kind == "pending":
            return (
                item["kind"] == "entry"
                and int(item["lineNumber"]) in workset.pending_line_numbers
            )
        if kind == "done":
            return (
                item["kind"] == "entry"
                and int(item["lineNumber"]) in workset.done_line_numbers
            )
        return item["kind"] == "entry"

    filtered: list[dict[str, Any]] = []
    total = 0
    for item in parsed:
        if not matches(item):
            continue
        row = dict(item)
        if kind == "duplicate" and row["kind"] == "entry":
            row["occurrence"] = source_counts.get(str(row["source"]), 0)
        if total >= offset and len(filtered) < limit:
            filtered.append(row)
        total += 1
    result = {
        "sourcePath": str(document.source_path),
        "offset": offset,
        "limit": limit,
        "total": total,
        "entryTotal": entry_total,
        "invalidTotal": invalid_total,
        "duplicateTotal": duplicate_total,
        "pendingTotal": pending_total,
        "doneTotal": done_total,
        "warningReasons": warning_reasons,
        "entries": filtered,
    }
    reporter("result", "inspect", result)
    return result


def _protected_tokens(text: str) -> Counter[str]:
    return Counter(
        match.group(0)
        for match in _PROTECTED_PATTERN.finditer(text)
        if not is_translatable_bracket_tag(match.group(0))
    )


def _patch_missing_tokens(
    source: str, translated: str, missing: Counter[str]
) -> str | None:
    """Chèn token bảo vệ còn thiếu vào bản dịch. Không vá nếu không chắc vị trí."""
    patched = translated
    for token in missing.elements():
        if token in patched:
            continue
        if source.rstrip().endswith(token):
            if token[:1] in "{[<(" and patched and not patched.endswith((" ", "-", ":", ";")):
                patched = f"{patched} {token}"
            else:
                patched = patched + token
            continue
        if token not in source:
            return None
        return None
    if _protected_tokens(source) - _protected_tokens(patched):
        return None
    return patched


def _apply_token_fallback(
    translations: dict[str, str],
    warnings: list[Any],
    reporter: Reporter,
) -> None:
    for source, translated in list(translations.items()):
        missing = _protected_tokens(source) - _protected_tokens(translated)
        if not missing:
            continue
        restore_source = not has_han(source)
        patched = (
            _patch_missing_tokens(source, translated, missing)
            if restore_source
            else None
        )
        if restore_source and patched is not None:
            translations[source] = patched
            message = "Bản dịch làm mất regex/token; đã vá token vào bản dịch"
        elif restore_source:
            translations[source] = source
            message = "Bản dịch làm mất regex/token; đã giữ nguyên nguồn"
        else:
            message = (
                "Bản dịch làm mất regex/token; giữ bản dịch (không hoàn nguyên chữ Hán)"
            )
        warning = {
            "message": message,
            "source": source,
            "missing": list(missing.elements()),
            "patched": patched is not None,
        }
        warnings.append(warning)
        report_warning(
            reporter,
            "translate",
            {
                "phase": "legend-token-fallback",
                "description": source[:240],
                **warning,
            },
        )


def _preview_identity_from(
    payload: Mapping[str, Any], *, exclude: set[str]
) -> str:
    canonical = {
        key: value for key, value in payload.items() if key not in exclude
    }
    return hashlib.sha256(
        json.dumps(
            canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def _preview_identity(payload: Mapping[str, Any]) -> str:
    return _preview_identity_from(
        payload,
        exclude={
            "previewId",
            "createdAt",
            "fingerprint",
            "stagedPath",
            "stagedFingerprint",
        },
    )


def _preview_identity_legacy(payload: Mapping[str, Any]) -> str:
    return _preview_identity_from(payload, exclude={"previewId", "createdAt"})


def _preview_id_matches(payload: Mapping[str, Any], preview_id: str) -> bool:
    return preview_id in {
        _preview_identity(payload),
        _preview_identity_legacy(payload),
    }


def _staged_path(preview_path: Path, source_path: Path) -> Path:
    suffix = source_path.suffix or ".txt"
    return preview_path.with_name(f"{preview_path.stem}.staged{suffix}")


def _structure_matches(source: LegendDocument, staged_path: Path) -> bool:
    try:
        staged = parse_legend_file(staged_path)
    except ValidationError:
        return False
    if source.bom != staged.bom or len(source.lines) != len(staged.lines):
        return False
    return all(
        left.kind == right.kind
        and left.left == right.left
        and left.ending == right.ending
        for left, right in zip(source.lines, staged.lines, strict=True)
    )


def _config_with_source_hints(
    config: TranslationConfig, sources: list[str]
) -> TranslationConfig:
    hints = glossary_hints_from_sources(
        sources, config.glossary, config.locked_glossary
    )
    if not hints:
        return config
    return replace(config, glossary={**hints, **dict(config.glossary or {})})


def _batch_glossary_hints(
    config: TranslationConfig,
    origin_by_id: Mapping[str, str],
) -> Callable[[Sequence[Mapping[str, str]]], dict[str, str]]:
    locked = dict(config.locked_glossary or {})

    def provider(items: Sequence[Mapping[str, str]]) -> dict[str, str]:
        sources = [
            origin_by_id[str(item["id"])]
            for item in items
            if item.get("id") in origin_by_id
        ]
        return glossary_hints_from_sources(sources, config.glossary, locked)

    return provider


def _quality_metrics(
    qa: Mapping[str, Any],
    *,
    retry_passes: int = 0,
    retranslated_sources: int = 0,
) -> dict[str, Any]:
    issues = qa.get("issues")
    issue_rows = issues if isinstance(issues, list) else []
    rule_counts = Counter(
        str(issue.get("rule", "")) for issue in issue_rows if issue.get("rule")
    )
    blocking_rules = Counter(
        str(issue.get("rule", ""))
        for issue in issue_rows
        if issue.get("severity") == "error" and issue.get("rule")
    )
    return {
        "qaPassedFirstPass": bool(qa.get("passed")) and retry_passes == 0,
        "qaBlockingCount": sum(
            1 for issue in issue_rows if issue.get("severity") == "error"
        ),
        "qaIssueCount": len(issue_rows),
        "retryPassesUsed": retry_passes,
        "retranslatedSources": retranslated_sources,
        "topFailedRules": [
            {"rule": rule, "count": count}
            for rule, count in blocking_rules.most_common(8)
        ],
        "topIssueRules": [
            {"rule": rule, "count": count} for rule, count in rule_counts.most_common(8)
        ],
    }


def legend_row_done(source: str, right: str | None) -> bool:
    """True when the right-hand side is already a finished Vietnamese target."""
    target = right or ""
    if not has_han(source) and not has_han(target):
        return bool(target.strip())
    return bool(target.strip()) and not has_han(target) and target != source


@dataclass(frozen=True)
class LegendWorkset:
    done_line_numbers: frozenset[int]
    pending_line_numbers: frozenset[int]
    reuse_targets: Mapping[int, str]
    api_sources: tuple[str, ...]
    unique_sources: tuple[str, ...]
    done_items: int
    reused_items: int


def classify_legend_entries(
    entries: Sequence[LegendLine],
    *,
    force: bool = False,
) -> LegendWorkset:
    """Single source of truth for incremental vs force work selection."""
    by_source: dict[str, list[LegendLine]] = {}
    unique_order: list[str] = []
    for line in entries:
        if line.source is None:
            continue
        if line.source not in by_source:
            by_source[line.source] = []
            unique_order.append(line.source)
        by_source[line.source].append(line)

    done_line_numbers: set[int] = set()
    pending_line_numbers: set[int] = set()
    reuse_targets: dict[int, str] = {}
    api_sources: list[str] = []
    done_items = 0
    reused_items = 0

    for source in unique_order:
        rows = by_source[source]
        if force:
            for row in rows:
                pending_line_numbers.add(row.number)
            api_sources.append(source)
            continue

        done_rows: list[LegendLine] = []
        pending_rows: list[LegendLine] = []
        for row in rows:
            if legend_row_done(source, row.right):
                done_rows.append(row)
            else:
                pending_rows.append(row)
        for row in done_rows:
            done_line_numbers.add(row.number)
        if not pending_rows:
            done_items += 1
            continue
        for row in pending_rows:
            pending_line_numbers.add(row.number)
        if done_rows:
            reuse_value = done_rows[-1].right or ""
            for row in pending_rows:
                reuse_targets[row.number] = reuse_value
            reused_items += 1
        else:
            api_sources.append(source)

    return LegendWorkset(
        done_line_numbers=frozenset(done_line_numbers),
        pending_line_numbers=frozenset(pending_line_numbers),
        reuse_targets=reuse_targets,
        api_sources=tuple(api_sources),
        unique_sources=tuple(unique_order),
        done_items=done_items,
        reused_items=reused_items,
    )


def _resolved_without_model(
    sources: list[str], config: TranslationConfig
) -> dict[str, str]:
    locked = dict(config.locked_glossary or {})
    resolved = han_viet_overrides(sources, locked)
    terms = build_term_bank(config.glossary, locked)
    for source in sources:
        if source in resolved:
            continue
        switched, matches = code_switch_source(source, terms)
        if matches and not has_han(switched):
            resolved[source] = switched
    return resolved


def _pending_legend_jobs(
    sources: list[str],
    config: TranslationConfig,
    *,
    id_prefix: str,
) -> tuple[dict[str, str], list[dict[str, str]], dict[str, list[tuple[str, str]]], dict[str, str]]:
    """Resolve locked/full-switch once; remaining sources become API pending."""
    locked = dict(config.locked_glossary or {})
    resolved = han_viet_overrides(sources, locked)
    terms = build_term_bank(config.glossary, locked)
    pending: list[dict[str, str]] = []
    matches_by_origin: dict[str, list[tuple[str, str]]] = {}
    origin_by_id: dict[str, str] = {}
    for index, source in enumerate(sources, 1):
        if source in resolved:
            continue
        switched, matches = code_switch_source(source, terms)
        if matches and not has_han(switched):
            resolved[source] = switched
            continue
        item_id = f"{id_prefix}-{index}"
        pending.append({"id": item_id, "text": switched})
        origin_by_id[item_id] = source
        matches_by_origin[source] = matches
    return resolved, pending, matches_by_origin, origin_by_id


def _needs_legend_retry(
    source: str,
    target: str,
    matches: list[tuple[str, str]],
    config: TranslationConfig,
) -> bool:
    if has_han(target):
        return True
    errors, _ = classify_term_gaps(
        source,
        target,
        matches,
        locked=config.locked_glossary,
        glossary=config.glossary,
    )
    return bool(errors)


def _translations_from_ids(
    pending: list[dict[str, str]],
    by_id: Mapping[str, str],
    origin_by_id: Mapping[str, str],
) -> dict[str, str]:
    return {origin_by_id[item["id"]]: by_id[item["id"]] for item in pending}


def _retry_failed_legend(
    translator: GeminiTranslator,
    pending: list[dict[str, str]],
    translations: dict[str, str],
    matches_by_origin: Mapping[str, list[tuple[str, str]]],
    origin_by_id: Mapping[str, str],
    file_hint: str,
    config: TranslationConfig,
    *,
    max_passes: int = LEGEND_RETRY_MAX_PASSES,
) -> int:
    """Dịch lại các dòng còn Hán hoặc thiếu term bắt buộc. Trả về số lần gọi API."""
    passes = 0
    for _ in range(max(1, max_passes)):
        retry_items = [
            item
            for item in pending
            if _needs_legend_retry(
                origin_by_id[item["id"]],
                translations[origin_by_id[item["id"]]],
                matches_by_origin[origin_by_id[item["id"]]],
                config,
            )
        ]
        if not retry_items:
            break
        passes += 1
        retry_by_id = translator.translate_items(
            retry_items, "legend_retry", file_hint, skip_cache=True
        )
        for item in retry_items:
            origin = origin_by_id[item["id"]]
            value = retry_by_id[item["id"]]
            translations[origin] = value
            if not _needs_legend_retry(
                origin, value, matches_by_origin[origin], config
            ):
                translator._store_cached(item["text"], "legend", value)
    return passes


def estimate_legend(
    source_path: Path,
    config: TranslationConfig,
    *,
    mode: str = "full",
    trial_limit: int = 30,
    force_retranslate: bool = False,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    document = parse_legend_file(source_path)
    if mode != "full":
        raise ValidationError("Legend chỉ hỗ trợ dịch toàn bộ")
    _ = trial_limit
    workset = classify_legend_entries(document.entries, force=force_retranslate)
    selected = list(workset.api_sources)
    locked = _resolved_without_model(selected, config) if selected else {}
    locked_items = sum(source in locked for source in selected)
    cache_candidates = [source for source in selected if source not in locked]
    cached_items = 0
    if cache_candidates and not force_retranslate:
        terms = build_term_bank(config.glossary, config.locked_glossary)
        origin_by_id = {
            f"estimate-{index}": source
            for index, source in enumerate(cache_candidates, 1)
        }
        translator = GeminiTranslator(
            config,
            LEGEND_PROFILE,
            reporter=reporter,
            cancel=cancel,
            client_factory=lambda _key, _timeout: object(),
            event_step="translate",
            fail_on_item_error=True,
            batch_glossary_hints=_batch_glossary_hints(config, origin_by_id),
        )
        cached_items = sum(
            translator._lookup_cached(code_switch_source(source, terms)[0], "legend")
            is not None
            for source in cache_candidates
        )
    pending = max(0, len(selected) - locked_items - cached_items)
    done_items = 0 if force_retranslate else workset.done_items
    reused_items = 0 if force_retranslate else workset.reused_items
    # Unique sources that translate will actually process (preview/diffs).
    actionable = reused_items + len(selected)
    effective_batch = max(1, config.batch_size)
    workers_used, spare_keys, batches = estimate_worker_count(
        pending, len(config.api_keys), effective_batch
    )
    result = {
        "items": len(workset.unique_sources),
        "doneItems": done_items,
        "reusedItems": reused_items,
        "cachedItems": cached_items,
        "lockedItems": locked_items,
        "pendingItems": pending,
        "actionableItems": actionable,
        "workersUsed": workers_used,
        "spareKeys": spare_keys,
        "estimatedBatches": batches,
        "estimatedApiCalls": batches,
    }
    reporter("result", "translate", result)
    return result


def translate_legend(
    source_path: Path,
    preview_path: Path,
    config: TranslationConfig,
    *,
    mode: str = "full",
    trial_limit: int = 30,
    force_retranslate: bool = False,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
    client_factory: ClientFactory | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    resolved_source = source_path.expanduser().resolve()
    resolved_preview = preview_path.expanduser().resolve()
    staged = _staged_path(resolved_preview, resolved_source)
    resolved_cache = config.cache_path.expanduser().resolve()
    artifact_paths = (resolved_preview, staged, resolved_cache)
    if resolved_source in artifact_paths or len(set(artifact_paths)) != len(artifact_paths):
        raise ValidationError(
            "sourcePath, previewPath, staged output và cachePath phải là các file khác nhau"
        )
    document = parse_legend_file(source_path)
    for warning in document.warnings:
        report_warning(
            reporter,
            "translate",
            {
                "phase": "legend-parse",
                "message": warning["message"],
                "description": f"Dòng {warning['line']}: {warning['raw']}",
                **warning,
            },
        )
    entries = document.entries
    if mode != "full":
        raise ValidationError("Legend chỉ hỗ trợ dịch toàn bộ")
    _ = trial_limit
    workset = classify_legend_entries(entries, force=force_retranslate)
    unique_sources = list(workset.unique_sources)
    if not force_retranslate and not workset.pending_line_numbers:
        raise ValidationError("Không còn câu cần dịch")
    selected_sources = list(workset.api_sources)
    locked = dict(config.locked_glossary or {})
    user_glossary_hash = translation_glossary_hash(config.glossary, locked)
    (
        locked_translations,
        pending_items,
        matches_by_origin,
        origin_by_id,
    ) = _pending_legend_jobs(selected_sources, config, id_prefix="legend")
    translations: dict[str, str] = dict(locked_translations)
    retry_passes = 0
    translator_stats: dict[str, Any] = TranslationStats().to_dict()
    workers_used = 0
    if pending_items:
        translator = GeminiTranslator(
            config,
            LEGEND_PROFILE,
            reporter=reporter,
            cancel=cancel,
            client_factory=client_factory,
            event_step="translate",
            fail_on_item_error=True,
            batch_glossary_hints=_batch_glossary_hints(config, origin_by_id),
        )
        by_id = translator.translate_items(
            pending_items,
            "legend",
            document.source_path.as_posix(),
            skip_cache=force_retranslate,
        )
        translations.update(
            _translations_from_ids(pending_items, by_id, origin_by_id)
        )
        retry_passes = _retry_failed_legend(
            translator,
            pending_items,
            translations,
            matches_by_origin,
            origin_by_id,
            document.source_path.as_posix(),
            config,
        )
        translator_stats = translator.stats.to_dict()
        workers_used = getattr(translator, "_workers_used", 0)
    warnings = list(document.warnings)
    _apply_token_fallback(translations, warnings, reporter)

    line_targets: dict[int, str] = {}
    lines_by_number = {line.number: line for line in entries}
    for number, target in workset.reuse_targets.items():
        line = lines_by_number.get(number)
        if line is None or line.right == target:
            continue
        line_targets[number] = target
    for number in workset.pending_line_numbers:
        if number in line_targets:
            continue
        line = lines_by_number.get(number)
        if line is None or line.source is None:
            continue
        target = translations.get(line.source)
        if target is None or line.right == target:
            continue
        line_targets[number] = target
    if not force_retranslate and not line_targets:
        raise ValidationError("Không còn câu cần dịch")
    staged_bytes = document.render_line_targets(line_targets)
    atomic_bytes_write(staged, staged_bytes)
    staged_fingerprint = hashlib.sha256(staged_bytes).hexdigest()
    diffs = []
    for number, target in line_targets.items():
        line = lines_by_number.get(number)
        if line is None or line.right == target:
            continue
        diffs.append(
            {
                "line": line.number,
                "key": line.left,
                "source": line.source,
                "oldTarget": line.right,
                "target": target,
                "effectiveTarget": target,
                "effectiveAfter": target,
                "selected": True,
                "editedAfter": None,
                "status": "pending",
            }
        )
    qa = run_legend_qa(
        diffs,
        revision=1,
        locked_glossary=locked,
        glossary=config.glossary,
        structure_ok=_structure_matches(document, staged),
    )
    quality = _quality_metrics(qa, retry_passes=retry_passes)
    handled_unique = (
        workset.reused_items
        + len(selected_sources)
        if not force_retranslate
        else len(unique_sources)
    )
    stats = {
        **translator_stats,
        "lines": len(document.lines),
        "entries": len(entries),
        "uniqueSources": len(unique_sources),
        "duplicates": len(entries) - len(unique_sources),
        "changed": len(diffs),
        "invalid": len(document.warnings),
        "doneItems": 0 if force_retranslate else workset.done_items,
        "reusedItems": 0 if force_retranslate else workset.reused_items,
        "itemsTranslated": sum(
            translations.get(source, source) != source for source in selected_sources
        ),
        **quality,
    }
    payload: dict[str, Any] = {
        "version": 2,
        "adapter": "legend-three-kingdoms",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": str(document.source_path),
        "fingerprint": document.fingerprint,
        "revision": 1,
        "mode": mode,
        "forceRetranslate": force_retranslate,
        "coverageTranslated": handled_unique,
        "coverageTotal": len(unique_sources),
        "stagedPath": str(staged),
        "stagedFingerprint": staged_fingerprint,
        "profile": {
            "id": LEGEND_PROFILE.id,
            "promptHash": LEGEND_PROFILE.prompt_hash,
            "sourceLanguage": LEGEND_PROFILE.source_language,
            "targetLanguage": LEGEND_PROFILE.target_language,
        },
        "diffs": diffs,
        "stats": stats,
        "qa": qa,
        "lockedGlossary": locked,
        "glossaryHash": user_glossary_hash,
        "warnings": warnings,
    }
    payload["previewId"] = _preview_identity(payload)
    atomic_text_write(
        resolved_preview,
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
    )
    result = {
        "previewId": payload["previewId"],
        "previewPath": str(resolved_preview),
        "stagedPath": str(staged),
        "fingerprint": document.fingerprint,
        "revision": 1,
        "mode": mode,
        "forceRetranslate": force_retranslate,
        "coverageTranslated": handled_unique,
        "coverageTotal": len(unique_sources),
        "workersUsed": workers_used,
        "diffs": diffs,
        "stats": stats,
        "qa": qa,
        "glossaryHash": user_glossary_hash,
        "warnings": warnings,
    }
    reporter(
        "result",
        "translate",
        {
            key: value
            for key, value in result.items()
            if key not in {"diffs", "qa"}
        }
        | {
            "qa": {
                "passed": qa.get("passed"),
                "blocking": qa.get("blocking"),
                "revision": qa.get("revision"),
                "errors": qa.get("errors"),
                "warnings": qa.get("warnings"),
            }
        },
    )
    return result


def _read_preview(preview_path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(preview_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"Preview Legend không hợp lệ: {error}") from error
    if not isinstance(payload, dict) or payload.get("version") not in {1, 2}:
        raise ValidationError("Preview Legend không đúng version")
    preview_id = payload.get("previewId")
    if not isinstance(preview_id, str) or not preview_id.strip():
        raise ValidationError("previewId Legend không hợp lệ")
    return payload


def _preview_source_fingerprint(payload: Mapping[str, Any]) -> str:
    raw = payload.get("fingerprint")
    if raw is None:
        raw = payload.get("sourceFingerprint")
    return str(raw or "")


def _diffs_align_with_document(document: LegendDocument, diffs: Any) -> bool:
    if not isinstance(diffs, list) or not diffs:
        return False
    lines_by_number = {line.number: line for line in document.lines}
    checked = 0
    for row in diffs:
        if not isinstance(row, Mapping):
            continue
        line_number = int(row.get("line") or row.get("lineNumber") or 0)
        if not line_number:
            continue
        line = lines_by_number.get(line_number)
        if line is None or line.kind != "entry":
            return False
        expected_source = str(row.get("source", ""))
        if expected_source and line.source != expected_source:
            return False
        checked += 1
    return checked > 0


def _assert_sync_source_current(document: LegendDocument, payload: Mapping[str, Any]) -> None:
    preview_fingerprint = _preview_source_fingerprint(payload)
    if preview_fingerprint and document.fingerprint == preview_fingerprint:
        return
    if _diffs_align_with_document(document, payload.get("diffs")):
        return
    current = document.fingerprint[:12]
    expected = preview_fingerprint[:12] if preview_fingerprint else "?"
    raise StalePreviewError(
        "File nguồn đã thay đổi sau preview "
        f"(preview {expected}…, hiện tại {current}…). "
        "Kiểm tra lại file nguồn hoặc dịch lại nếu file đã bị sửa/apply."
    )


def _row_needs_legend_retranslate(
    row: Mapping[str, Any],
    config: TranslationConfig,
    terms: Mapping[str, str],
) -> bool:
    """Dòng cần dịch lại: còn Hán hoặc thiếu term bắt buộc (kể cả không còn Hán)."""
    if not bool(row.get("selected", True)):
        return False
    source = str(row.get("source", ""))
    if not source:
        return False
    target = _effective_diff_target(row)
    if has_han(target):
        return True
    _, matches = code_switch_source(source, terms)
    return _needs_legend_retry(source, target, matches, config)


def _effective_diff_target(row: Mapping[str, Any]) -> str:
    if not bool(row.get("selected", True)):
        return str(row.get("oldTarget", ""))
    edited = row.get("editedAfter")
    if edited is not None:
        return str(edited)
    return str(row.get("effectiveTarget") or row.get("target") or "")


def _targets_from_diffs(diffs: Any) -> dict[int, str]:
    targets: dict[int, str] = {}
    if not isinstance(diffs, list):
        return targets
    for row in diffs:
        if not isinstance(row, Mapping):
            continue
        line_number = int(row.get("line") or row.get("lineNumber") or 0)
        if not line_number or not bool(row.get("selected", True)):
            continue
        targets[line_number] = _effective_diff_target(row)
    return targets


def _render_staged_bytes(document: LegendDocument, diffs: Any) -> bytes:
    return document.render_line_targets(_targets_from_diffs(diffs))


def _resolve_staged_path(payload: Mapping[str, Any], preview_path: Path) -> Path:
    preview = preview_path.expanduser().resolve()
    source_raw = payload.get("source")
    source = (
        Path(str(source_raw)).expanduser().resolve()
        if isinstance(source_raw, str) and source_raw.strip()
        else preview
    )
    sibling = _staged_path(preview, source)
    staged_raw = payload.get("stagedPath")
    if not isinstance(staged_raw, str) or not staged_raw.strip():
        return sibling
    candidate = Path(staged_raw).expanduser()
    try:
        candidate = candidate.resolve()
    except OSError:
        return sibling
    if candidate.parent == preview.parent:
        return candidate
    return sibling


def _sync_staged_artifact(
    payload: dict[str, Any],
    document: LegendDocument,
    preview_path: Path,
    *,
    persist_preview: bool = True,
) -> tuple[Path, bytes, str]:
    staged = _resolve_staged_path(payload, preview_path)
    staged_bytes = _render_staged_bytes(document, payload.get("diffs", []))
    staged_fingerprint = hashlib.sha256(staged_bytes).hexdigest()
    atomic_bytes_write(staged, staged_bytes)
    payload["stagedPath"] = str(staged)
    payload["stagedFingerprint"] = staged_fingerprint
    payload["fingerprint"] = document.fingerprint
    if persist_preview:
        atomic_text_write(
            preview_path,
            json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
        )
    return staged, staged_bytes, staged_fingerprint


def sync_legend_staged(
    preview_path: Path,
    *,
    expected_preview_id: str | None = None,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    preview = preview_path.expanduser().resolve()
    payload = _read_preview(preview)
    preview_id = str(payload["previewId"])
    if expected_preview_id and expected_preview_id != preview_id:
        raise StalePreviewError("previewId không khớp preview đã chọn")
    source = Path(str(payload.get("source", ""))).resolve()
    document = parse_legend_file(source)
    _assert_sync_source_current(document, payload)
    staged, _staged_bytes, staged_fingerprint = _sync_staged_artifact(
        payload,
        document,
        preview,
    )
    result = {
        "previewId": payload["previewId"],
        "previewPath": str(preview),
        "stagedPath": str(staged),
        "stagedFingerprint": staged_fingerprint,
        "revision": int(payload.get("revision", 1)),
    }
    reporter("result", "inspect", result)
    return result


# Dịch lại chữ Hán / term-gap: batch nhỏ để mỗi lệnh Gemini kịp timeoutSeconds
# và ghi preview giữa chừng nếu sidecar bị cắt.
LEGEND_RETRANSLATE_BATCH_CAP = 15


def _legend_retranslate_batch_size(config: TranslationConfig) -> int:
    return max(1, min(config.batch_size, LEGEND_RETRANSLATE_BATCH_CAP))


def _legend_retranslate_progress_reporter(
    reporter: Reporter, origin_offset: int, total: int
) -> Reporter:
    def wrapped(event_type: str, step: str, payload: object) -> None:
        if event_type != "progress" or not isinstance(payload, Mapping):
            reporter(event_type, step, payload)
            return
        inner_done = int(payload.get("itemsProcessed") or payload.get("processed") or 0)
        done = min(total, origin_offset + inner_done)
        adapted = dict(payload)
        adapted["itemsProcessed"] = done
        adapted["itemsTotal"] = total
        adapted["processed"] = done
        adapted["total"] = total
        adapted["itemProgress"] = round(done * 100 / max(1, total))
        adapted.pop("batchProgress", None)
        reporter(event_type, step, adapted)

    return wrapped


def _apply_retranslate_rows(
    diffs: list[Any],
    retry_lines: set[int],
    translations: Mapping[str, str],
) -> None:
    for row in diffs:
        if not isinstance(row, dict):
            continue
        if int(row.get("line", 0) or 0) not in retry_lines:
            continue
        source_text = str(row.get("source", ""))
        if source_text not in translations:
            continue
        translated = translations[source_text]
        row["target"] = translated
        row["editedAfter"] = None
        row["selected"] = True
        row["status"] = "pending"
        row["effectiveTarget"] = translated
        row["effectiveAfter"] = translated


def _persist_legend_retranslate(
    payload: dict[str, Any],
    *,
    document: LegendDocument,
    diffs: list[Any],
    preview: Path,
    locked: Mapping[str, str],
    glossary: Mapping[str, str] | None,
) -> int:
    targets: dict[int, str] = {}
    for row in diffs:
        if not isinstance(row, Mapping):
            continue
        line_number = int(row.get("line", 0) or 0)
        if not line_number:
            continue
        effective_target = _effective_diff_target(row)
        if bool(row.get("selected", True)):
            targets[line_number] = effective_target
        if isinstance(row, dict):
            row["effectiveTarget"] = effective_target
            row["effectiveAfter"] = effective_target
    staged = _resolve_staged_path(payload, preview)
    staged_bytes = document.render_line_targets(targets)
    atomic_bytes_write(staged, staged_bytes)
    revision = int(payload.get("revision", 1)) + 1
    glossary_hash = translation_glossary_hash(glossary, locked)
    payload["version"] = 2
    payload["revision"] = revision
    payload["stagedFingerprint"] = hashlib.sha256(staged_bytes).hexdigest()
    payload["qa"] = run_legend_qa(
        diffs,
        revision=revision,
        locked_glossary=dict(locked),
        glossary=glossary,
        structure_ok=_structure_matches(document, staged),
    )
    prior_stats = dict(payload.get("stats") or {})
    payload["stats"] = {
        **prior_stats,
        **_quality_metrics(
            payload["qa"],
            retry_passes=int(prior_stats.get("retryPassesUsed") or 0),
            retranslated_sources=int(prior_stats.get("retranslatedSources") or 0),
        ),
    }
    payload["lockedGlossary"] = dict(locked)
    payload["glossaryHash"] = glossary_hash
    payload["previewId"] = _preview_identity(payload)
    atomic_text_write(
        preview,
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
    )
    return revision


def retranslate_legend_preview(
    preview_path: Path,
    config: TranslationConfig,
    *,
    expected_preview_id: str,
    line_numbers: Any = None,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
    client_factory: ClientFactory | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    preview = preview_path.expanduser().resolve()
    payload = _read_preview(preview)
    if payload.get("mode", "full") != "full":
        raise ValidationError("Không thể dịch lại từ bản dịch thử")
    if expected_preview_id and payload.get("previewId") != expected_preview_id:
        raise StalePreviewError("Preview đã thay đổi; hãy tải lại trước khi dịch lại")
    source = Path(str(payload.get("source", ""))).resolve()
    document = parse_legend_file(source)
    if document.fingerprint != payload.get("fingerprint"):
        raise StalePreviewError("File nguồn đã thay đổi sau preview")
    diffs = payload.get("diffs")
    if not isinstance(diffs, list):
        raise ValidationError("Preview Legend thiếu diffs")
    wanted: set[int] | None = None
    if line_numbers is not None:
        if not isinstance(line_numbers, list):
            raise ValidationError("lineNumbers phải là mảng")
        wanted = set()
        for item in line_numbers:
            try:
                wanted.add(int(item))
            except (TypeError, ValueError) as error:
                raise ValidationError("lineNumbers phải là mảng số") from error
    locked = dict(
        config.locked_glossary
        if config.locked_glossary is not None
        else payload.get("lockedGlossary") or {}
    )
    retry_config = replace(config, locked_glossary=locked)
    terms = build_term_bank(config.glossary, locked)
    rows = [
        row
        for row in diffs
        if isinstance(row, dict)
        and row.get("source")
        and (wanted is None or int(row.get("line", 0) or 0) in wanted)
        and (
            wanted is not None
            or _row_needs_legend_retranslate(row, retry_config, terms)
        )
    ]
    unique_sources = list(
        dict.fromkeys(str(row["source"]) for row in rows if row.get("source"))
    )
    if not unique_sources:
        raise ValidationError(
            "Không có dòng để dịch lại"
            if wanted is not None
            else "Không có dòng còn chữ Hán hoặc thiếu thuật ngữ để dịch lại"
        )
    retry_lines = {int(row.get("line", 0) or 0) for row in rows}
    (
        locked_translations,
        pending_items,
        matches_by_origin,
        origin_by_id,
    ) = _pending_legend_jobs(unique_sources, retry_config, id_prefix="legend-retry")
    translations = dict(locked_translations)
    warnings = list(payload.get("warnings") or [])
    if pending_items:
        translator = GeminiTranslator(
            retry_config,
            LEGEND_PROFILE,
            reporter=reporter,
            cancel=cancel,
            client_factory=client_factory,
            event_step="translate",
            fail_on_item_error=True,
            batch_glossary_hints=_batch_glossary_hints(retry_config, origin_by_id),
        )
        batch_size = _legend_retranslate_batch_size(retry_config)
        file_hint = document.source_path.as_posix()
        total_pending = len(pending_items)
        for start in range(0, len(pending_items), batch_size):
            cancel.check()
            chunk = pending_items[start : start + batch_size]
            translator.reporter = _legend_retranslate_progress_reporter(
                reporter, start, total_pending
            )
            by_id = translator.translate_items(
                chunk,
                "legend_retry",
                file_hint,
                skip_cache=True,
            )
            chunk_translations = _translations_from_ids(chunk, by_id, origin_by_id)
            _retry_failed_legend(
                translator,
                chunk,
                chunk_translations,
                matches_by_origin,
                origin_by_id,
                file_hint,
                retry_config,
            )
            _apply_token_fallback(chunk_translations, warnings, reporter)
            translations.update(chunk_translations)
            payload["stats"] = {
                **dict(payload.get("stats") or {}),
                **translator.stats.to_dict(),
                "retranslatedSources": len(unique_sources),
            }
            payload["warnings"] = warnings
            _apply_retranslate_rows(diffs, retry_lines, translations)
            _persist_legend_retranslate(
                payload,
                document=document,
                diffs=diffs,
                preview=preview,
                locked=locked,
                glossary=config.glossary,
            )
    else:
        _apply_token_fallback(translations, warnings, reporter)
        payload["warnings"] = warnings
        payload["stats"] = {
            **dict(payload.get("stats") or {}),
            "retranslatedSources": len(unique_sources),
        }
        _apply_retranslate_rows(diffs, retry_lines, translations)
        _persist_legend_retranslate(
            payload,
            document=document,
            diffs=diffs,
            preview=preview,
            locked=locked,
            glossary=config.glossary,
        )
    revision = int(payload.get("revision", 1))
    glossary_hash = str(payload.get("glossaryHash") or "")
    result = {
        "previewId": payload["previewId"],
        "previewPath": str(preview),
        "revision": revision,
        "diffs": diffs,
        "qa": payload["qa"],
        "stats": payload.get("stats", {}),
        "warnings": payload.get("warnings", []),
        "mode": payload.get("mode", "full"),
        "coverageTranslated": payload.get("coverageTranslated", 0),
        "coverageTotal": payload.get("coverageTotal", 0),
        "fingerprint": payload.get("fingerprint", ""),
        "createdAt": payload.get("createdAt", ""),
        "glossaryHash": glossary_hash,
        "retranslated": len(unique_sources),
    }
    qa = payload["qa"] if isinstance(payload.get("qa"), Mapping) else {}
    reporter(
        "result",
        "translate",
        {
            "previewId": result["previewId"],
            "previewPath": result["previewPath"],
            "revision": revision,
            "retranslated": result["retranslated"],
            "mode": result["mode"],
            "fingerprint": result["fingerprint"],
            "glossaryHash": glossary_hash,
            "stats": result["stats"],
            "qa": {
                "passed": qa.get("passed"),
                "blocking": qa.get("blocking"),
                "revision": qa.get("revision"),
                "errors": qa.get("errors"),
                "warnings": qa.get("warnings"),
            },
        },
    )
    return result


def rebuild_legend_preview(
    preview_path: Path,
    *,
    edits: Any,
    expected_preview_id: str,
    glossary: Mapping[str, str] | None = None,
    locked_glossary: Mapping[str, str] | None = None,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    preview = preview_path.expanduser().resolve()
    payload = _read_preview(preview)
    if payload.get("mode", "full") != "full":
        raise ValidationError("Không thể sửa production preview từ bản dịch thử")
    if expected_preview_id and payload.get("previewId") != expected_preview_id:
        raise StalePreviewError("Preview đã thay đổi; hãy tải lại trước khi sửa")
    if not isinstance(edits, list):
        raise ValidationError("edits phải là mảng")

    source = Path(str(payload.get("source", ""))).resolve()
    document = parse_legend_file(source)
    if document.fingerprint != payload.get("fingerprint"):
        raise StalePreviewError("File nguồn đã thay đổi sau preview")
    diffs = payload.get("diffs")
    if not isinstance(diffs, list):
        raise ValidationError("Preview Legend thiếu diffs")
    by_line = {
        int(row.get("line", 0)): row for row in diffs if isinstance(row, dict)
    }
    for edit in edits:
        if not isinstance(edit, Mapping):
            raise ValidationError("Mỗi edit phải là object")
        line_number = int(edit.get("lineNumber", 0) or 0)
        row = by_line.get(line_number)
        if row is None:
            raise ValidationError(f"Không tìm thấy diff dòng {line_number}")
        selected = bool(edit.get("selected", True))
        edited = edit.get("editedAfter")
        edited_text = str(edited) if edited is not None else None
        if selected and edited_text is not None and not edited_text.strip():
            raise ValidationError(f"Bản sửa dòng {line_number} không được rỗng")
        row["selected"] = selected
        row["editedAfter"] = edited_text
        row["status"] = (
            "rejected" if not selected else "edited" if edited_text is not None else "accepted"
        )

    targets: dict[int, str] = {}
    for row in diffs:
        if not isinstance(row, Mapping):
            continue
        line_number = int(row.get("line", 0) or 0)
        if not line_number:
            continue
        effective_target = _effective_diff_target(row)
        if bool(row.get("selected", True)):
            targets[line_number] = effective_target
        if isinstance(row, dict):
            row["effectiveTarget"] = effective_target
            row["effectiveAfter"] = effective_target

    staged = _resolve_staged_path(payload, preview)
    staged_bytes = document.render_line_targets(targets)
    atomic_bytes_write(staged, staged_bytes)
    revision = int(payload.get("revision", 1)) + 1
    locked = dict(locked_glossary or payload.get("lockedGlossary") or {})
    glossary_hash = translation_glossary_hash(glossary, locked)
    payload["version"] = 2
    payload["revision"] = revision
    payload["stagedFingerprint"] = hashlib.sha256(staged_bytes).hexdigest()
    payload["qa"] = run_legend_qa(
        diffs,
        revision=revision,
        locked_glossary=locked,
        glossary=glossary,
        structure_ok=_structure_matches(document, staged),
    )
    prior_stats = dict(payload.get("stats") or {})
    payload["stats"] = {
        **prior_stats,
        **_quality_metrics(
            payload["qa"],
            retry_passes=int(prior_stats.get("retryPassesUsed") or 0),
            retranslated_sources=int(prior_stats.get("retranslatedSources") or 0),
        ),
    }
    payload["lockedGlossary"] = locked
    payload["glossaryHash"] = glossary_hash
    payload["previewId"] = _preview_identity(payload)
    atomic_text_write(
        preview,
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
    )
    result = {
        "previewId": payload["previewId"],
        "previewPath": str(preview),
        "revision": revision,
        "diffs": diffs,
        "qa": payload["qa"],
        "stats": payload.get("stats", {}),
        "warnings": payload.get("warnings", []),
        "mode": payload.get("mode", "full"),
        "coverageTranslated": payload.get("coverageTranslated", 0),
        "coverageTotal": payload.get("coverageTotal", 0),
        "fingerprint": payload.get("fingerprint", ""),
        "createdAt": payload.get("createdAt", ""),
        "glossaryHash": glossary_hash,
    }
    qa = payload["qa"] if isinstance(payload.get("qa"), Mapping) else {}
    reporter(
        "result",
        "translate",
        {
            key: value
            for key, value in result.items()
            if key not in {"diffs", "qa"}
        }
        | {
            "qa": {
                "passed": qa.get("passed"),
                "blocking": qa.get("blocking"),
                "revision": qa.get("revision"),
                "errors": qa.get("errors"),
                "warnings": qa.get("warnings"),
            }
        },
    )
    return result


LEGEND_DEPLOY_FILENAME = "_AutoGeneratedTranslations.txt"


def apply_legend(
    source_path: Path,
    preview_path: Path,
    backup_root: Path,
    *,
    deploy_path: Path | None = None,
    expected_preview_id: str | None = None,
    current_glossary_hash: str | None = None,
    glossary: Mapping[str, str] | None = None,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    source = source_path.expanduser().resolve()
    preview = preview_path.expanduser().resolve()
    payload = _read_preview(preview)
    preview_id = str(payload["previewId"])
    if expected_preview_id and expected_preview_id != preview_id:
        raise StalePreviewError("previewId không khớp preview đã chọn")
    if payload.get("mode", "full") != "full":
        raise ValidationError("Bản dịch thử không được phép áp dụng")
    preview_glossary_hash = str(payload.get("glossaryHash", ""))
    if (
        not current_glossary_hash
        or not preview_glossary_hash
        or current_glossary_hash != preview_glossary_hash
    ):
        raise ValidationError("Glossary đã thay đổi; phải rebuild và chạy QA lại")
    qa = payload.get("qa")
    revision = int(payload.get("revision", 1))
    if (
        not isinstance(qa, Mapping)
        or int(qa.get("revision", 0)) != revision
        or bool(qa.get("blocking", True))
    ):
        raise ValidationError("QA Legend chưa hợp lệ hoặc còn lỗi blocking")
    if Path(str(payload.get("source", ""))).resolve() != source:
        raise ValidationError("sourcePath không khớp preview")
    document = parse_legend_file(source)
    if document.fingerprint != payload.get("fingerprint"):
        raise StalePreviewError(
            "File nguồn đã thay đổi sau preview; hãy chạy legend-translate lại"
        )
    staged = _resolve_staged_path(payload, preview)
    if staged == source or preview == source:
        raise ValidationError("Preview/staged output không được trùng sourcePath")
    staged, staged_bytes, staged_fingerprint = _sync_staged_artifact(
        payload,
        document,
        preview,
        persist_preview=False,
    )
    fresh_qa = run_legend_qa(
        payload.get("diffs", []),
        revision=revision,
        locked_glossary=payload.get("lockedGlossary", {}),
        glossary=glossary,
        structure_ok=_structure_matches(document, staged),
    )
    if fresh_qa["blocking"]:
        raise ValidationError("QA Legend phát hiện lỗi blocking ngay trước Apply")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = (
        backup_root.expanduser().resolve()
        / f"legend-backup-{timestamp}-{uuid.uuid4().hex[:8]}"
    )
    files_dir = backup / "files"
    files_dir.mkdir(parents=True)
    backup_file = files_dir / source.name
    shutil.copy2(source, backup_file)
    manifest_path = backup / "manifest.json"
    manifest: dict[str, Any] = {
        "version": 2,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "adapter": "legend-three-kingdoms",
        "previewId": preview_id,
        "source": str(source),
        "sourceFingerprint": document.fingerprint,
        "backupFile": str(backup_file),
        "complete": False,
    }
    atomic_text_write(
        manifest_path,
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2),
    )
    deploy_target: Path | None = None
    deploy_backup_file: Path | None = None
    if deploy_path is not None:
        deploy_dir = deploy_path.expanduser().resolve()
        if not deploy_dir.is_dir():
            raise ValidationError("deployPath không phải thư mục hợp lệ")
        deploy_target = deploy_dir / LEGEND_DEPLOY_FILENAME
        if deploy_target.resolve() == source.resolve():
            deploy_target = None

    try:
        cancel.check()
        atomic_bytes_write(source, staged_bytes)
        if file_sha256(source) != staged_fingerprint:
            raise ValidationError("Xác minh file sau apply thất bại")
        if deploy_target is not None:
            cancel.check()
            deploy_backup_file = files_dir / f"game-{LEGEND_DEPLOY_FILENAME}"
            if deploy_target.is_file():
                shutil.copy2(deploy_target, deploy_backup_file)
                manifest["deployBackupFile"] = str(deploy_backup_file)
            manifest["deployTarget"] = str(deploy_target)
            atomic_bytes_write(deploy_target, staged_bytes)
            if file_sha256(deploy_target) != staged_fingerprint:
                raise ValidationError("Xác minh file deploy sau apply thất bại")
    except BaseException:
        atomic_copy(backup_file, source)
        if deploy_target is not None and deploy_backup_file is not None:
            if deploy_backup_file.is_file():
                atomic_copy(deploy_backup_file, deploy_target)
            elif deploy_target.is_file():
                deploy_target.unlink()
        raise
    manifest["complete"] = True
    manifest["appliedFingerprint"] = staged_fingerprint
    atomic_text_write(
        manifest_path,
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2),
    )
    report_progress(
        reporter,
        "sync-apply",
        {"processed": 1, "total": 1, "path": str(source)},
        ProgressThrottle(),
        force=True,
    )
    result: dict[str, Any] = {
        "source": str(source),
        "previewId": preview_id,
        "backup": str(backup),
        "manifest": str(manifest_path),
        "stats": dict(payload.get("stats", {})),
    }
    if deploy_target is not None:
        result["deployPath"] = str(deploy_target)
        if deploy_backup_file is not None and deploy_backup_file.is_file():
            result["deployBackupPath"] = str(deploy_backup_file)
    reporter("result", "sync-apply", result)
    return result


def restore_legend_backup(
    backup_path: Path,
    *,
    expected_source_path: Path,
    force: bool = False,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    cancel.check()
    backup = backup_path.expanduser().resolve()
    manifest_path = backup / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"Backup Legend không hợp lệ: {error}") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("adapter") != "legend-three-kingdoms"
        or not manifest.get("complete")
    ):
        raise ValidationError("Backup Legend chưa hoàn tất hoặc sai adapter")
    source = Path(str(manifest.get("source", ""))).resolve()
    backup_file = Path(str(manifest.get("backupFile", ""))).resolve()
    if not backup_file.is_file() or backup not in backup_file.parents:
        raise ValidationError("backupFile Legend không hợp lệ")
    expected_source = expected_source_path.expanduser().resolve()
    if source != expected_source:
        raise ValidationError(
            "Source trong backup không khớp file Legend đang được chọn"
        )
    current_fingerprint = file_sha256(source) if source.is_file() else ""
    applied_fingerprint = str(manifest.get("appliedFingerprint", ""))
    if (
        current_fingerprint
        and applied_fingerprint
        and current_fingerprint != applied_fingerprint
        and not force
    ):
        raise RestoreFingerprintConflict(
            "File Legend đã thay đổi sau backup; cần xác nhận force restore"
        )

    safety = (
        backup.parent
        / f"legend-safety-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    )
    safety_files = safety / "files"
    safety_files.mkdir(parents=True)
    safety_file = safety_files / source.name
    if source.is_file():
        shutil.copy2(source, safety_file)
    safety_manifest = {
        "version": 2,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "adapter": "legend-three-kingdoms",
        "reason": "pre-restore-safety",
        "source": str(source),
        "sourceFingerprint": current_fingerprint,
        "backupFile": str(safety_file),
        "complete": source.is_file(),
        "appliedFingerprint": current_fingerprint,
    }
    atomic_text_write(
        safety / "manifest.json",
        json.dumps(safety_manifest, ensure_ascii=False, sort_keys=True, indent=2),
    )
    cancel.check()
    atomic_copy(backup_file, source)
    restored_fingerprint = file_sha256(source)
    expected = str(manifest.get("sourceFingerprint", ""))
    if expected and restored_fingerprint != expected:
        if safety_file.is_file():
            atomic_copy(safety_file, source)
        raise ValidationError("Xác minh fingerprint sau restore Legend thất bại")
    result = {
        "source": str(source),
        "backup": str(backup),
        "safetyBackup": str(safety),
        "restoredFingerprint": restored_fingerprint,
    }
    reporter("result", "restore", result)
    return result
