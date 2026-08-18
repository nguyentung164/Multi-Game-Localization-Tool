from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

from .han_viet import (
    build_term_bank,
    classify_term_gaps,
    contains_vietnamese_term,
    format_term_gap,
    match_terms,
    suggested_han_replacements,
    term_suggestion_payloads,
    transliterate_han_viet_name,
)
from ..common.language import has_han, is_translatable_bracket_tag, missing_tokens

_HAN_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_PROTECTED_PATTERN = re.compile(
    r"""
    \{\{|\}\}|
    \{[^{}\r\n]+\}|
    <[^>\r\n]+>|
    \\\\|\\[=nrt]|\\[AbBdDsSwWZzG]|
    \(\?[:=!<]|\\[1-9]|
    \[[^\]\r\n]+\]|
    \^\??|\$\??|
    \(\?:|\(\?P<[^>]+>
    """,
    re.VERBOSE,
)


def _unmapped_leftover_han(target: str, covered_phrases: set[str]) -> bool:
    stripped = target
    for phrase in sorted(covered_phrases, key=len, reverse=True):
        if phrase:
            stripped = stripped.replace(phrase, "")
    return bool(_HAN_PATTERN.search(stripped))


def _proposed_translation_target(diff: Mapping[str, Any]) -> str:
    """Bản dịch đề xuất (cột Sau) — QA luôn kiểm tra text này, không phụ thuộc checkbox Apply."""
    edited = diff.get("editedAfter")
    if edited is not None:
        return str(edited)
    return str(diff.get("target", diff.get("after", "")))


def run_legend_qa(
    diffs: Sequence[Mapping[str, Any]],
    *,
    revision: int,
    locked_glossary: Mapping[str, str] | None = None,
    glossary: Mapping[str, str] | None = None,
    structure_ok: bool = True,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    locked = locked_glossary or {}
    terms = build_term_bank(glossary, locked)
    targets_by_source: dict[str, set[str]] = {}

    def add(
        severity: str,
        rule: str,
        diff: Mapping[str, Any],
        detail: str,
        suggestions: Sequence[Mapping[str, str] | tuple[str, str]] | None = None,
    ) -> None:
        line = int(diff.get("line", diff.get("lineNumber", 0)) or 0)
        issue: dict[str, Any] = {
            "id": f"{rule}-{line}-{len(issues) + 1}",
            "severity": severity,
            "rule": rule,
            "lineNumber": line,
            "source": str(diff.get("source", "")),
            "before": str(diff.get("oldTarget", diff.get("before", ""))),
            "after": str(diff.get("effectiveTarget", diff.get("target", ""))),
            "detail": detail,
        }
        if suggestions:
            payload: list[dict[str, str]] = []
            for item in suggestions:
                if isinstance(item, Mapping):
                    entry = {
                        "source": str(item.get("source", "")),
                        "reading": str(item.get("reading", "")),
                    }
                    replace = item.get("replace")
                    if replace:
                        entry["replace"] = str(replace)
                else:
                    entry = {"source": item[0], "reading": item[1]}
                if entry["source"] and entry["reading"]:
                    payload.append(entry)
            if payload:
                issue["suggestions"] = payload
        issues.append(issue)

    effective_diffs: list[dict[str, Any]] = []
    for diff in diffs:
        source = str(diff.get("source", ""))
        target = _proposed_translation_target(diff)
        effective_diff = {**diff, "effectiveTarget": target}
        effective_diffs.append(effective_diff)
        targets_by_source.setdefault(source, set()).add(target)
        if not target.strip():
            empty_suggestions: list[tuple[str, str]] = []
            if source in terms and has_han(source) and terms[source] != source:
                empty_suggestions = [(source, terms[source])]
            else:
                whole = transliterate_han_viet_name(source)
                if whole:
                    empty_suggestions = [(source, whole)]
            empty_detail = "Output hiệu lực đang rỗng."
            if empty_suggestions:
                empty_detail += " " + ", ".join(
                    format_term_gap(*pair) for pair in empty_suggestions[:8]
                )
            add(
                "error",
                "empty-target",
                effective_diff,
                empty_detail,
                suggestions=empty_suggestions or None,
            )
            continue
        missing = missing_tokens(source, target)
        protected = Counter(
            token
            for token in _PROTECTED_PATTERN.findall(source)
            if not is_translatable_bracket_tag(token)
        )
        translated_protected = Counter(
            token
            for token in _PROTECTED_PATTERN.findall(target)
            if not is_translatable_bracket_tag(token)
        )
        missing.extend(list((protected - translated_protected).elements()))
        token_suggestions = [
            (token, terms[token])
            for token in missing[:8]
            if is_translatable_bracket_tag(token) and token in terms
        ]
        if missing:
            token_detail = []
            suggested_tokens = {phrase for phrase, _ in token_suggestions}
            for token in missing[:8]:
                if token in suggested_tokens:
                    reading = terms[token]
                    token_detail.append(format_term_gap(token, reading))
                else:
                    token_detail.append(token)
            add(
                "error",
                "missing-token",
                effective_diff,
                f"Thiếu token bắt buộc: {', '.join(token_detail)}",
                suggestions=token_suggestions or None,
            )
        locked_missing = {
            locked_target
            for locked_source, locked_target in locked.items()
            if locked_source in source
            and not contains_vietnamese_term(target, locked_target)
        }
        covered_phrases = {phrase for phrase, _ in token_suggestions}
        for locked_source, locked_target in locked.items():
            if locked_source in source and not contains_vietnamese_term(
                target, locked_target
            ):
                add(
                    "error",
                    "locked-glossary",
                    effective_diff,
                    "Phải giữ thuật ngữ khóa: "
                    + format_term_gap(locked_source, locked_target),
                    suggestions=term_suggestion_payloads(
                        source,
                        target,
                        terms,
                        [(locked_source, locked_target)],
                    ),
                )
                covered_phrases.add(locked_source)
        error_terms, preferred_terms = classify_term_gaps(
            source,
            target,
            match_terms(source, terms),
            locked=locked,
            glossary=glossary,
        )
        error_terms = [
            pair
            for pair in error_terms
            if pair[1] not in locked_missing and pair[0] not in covered_phrases
        ]
        preferred_terms = [
            pair
            for pair in preferred_terms
            if pair[1] not in locked_missing and pair[0] not in covered_phrases
        ]
        if error_terms:
            add(
                "error",
                "term-success",
                effective_diff,
                "Thiếu thuật ngữ bắt buộc: "
                + ", ".join(format_term_gap(*pair) for pair in error_terms[:8]),
                suggestions=term_suggestion_payloads(
                    source, target, terms, error_terms[:8]
                ),
            )
            covered_phrases.update(phrase for phrase, _ in error_terms)
        if preferred_terms:
            add(
                "warning",
                "term-preferred",
                effective_diff,
                "Nên dùng thuật ngữ ưu tiên: "
                + ", ".join(format_term_gap(*pair) for pair in preferred_terms[:8]),
                suggestions=term_suggestion_payloads(
                    source, target, terms, preferred_terms[:8]
                ),
            )
            covered_phrases.update(phrase for phrase, _ in preferred_terms)
        leftover_han = [
            pair
            for pair in suggested_han_replacements(target, terms)
            if pair[0] not in covered_phrases
        ]
        if target == source and has_han(source):
            whole = transliterate_han_viet_name(source)
            if (
                whole
                and source not in covered_phrases
                and (source, whole) not in leftover_han
            ):
                leftover_han = [(source, whole), *leftover_han]
            same_detail = "Bản dịch vẫn giống nguyên văn tiếng Trung."
            if leftover_han:
                same_detail += " " + ", ".join(
                    format_term_gap(*pair) for pair in leftover_han[:8]
                )
            add(
                "warning",
                "source-equals-target",
                effective_diff,
                same_detail,
                suggestions=leftover_han[:8] or None,
            )
        elif _HAN_PATTERN.search(target):
            if leftover_han:
                add(
                    "error",
                    "han-remaining",
                    effective_diff,
                    "Bản dịch còn chữ Hán: "
                    + ", ".join(format_term_gap(*pair) for pair in leftover_han[:8]),
                    suggestions=leftover_han[:8],
                )
            elif _unmapped_leftover_han(target, covered_phrases):
                add(
                    "error",
                    "han-remaining",
                    effective_diff,
                    "Bản dịch còn chữ Hán; phải là tiếng Việt (chữ Quốc ngữ) toàn bộ.",
                )

    for source, targets in targets_by_source.items():
        non_empty = {target for target in targets if target}
        if len(non_empty) <= 1:
            continue
        representative = next(
            (
                diff
                for diff in effective_diffs
                if str(diff.get("source", "")) == source
            ),
            {},
        )
        add(
            "warning",
            "duplicate-inconsistent",
            representative,
            f"Cùng nguồn đang có {len(non_empty)} bản dịch khác nhau.",
        )

    if not structure_ok:
        add(
            "error",
            "structure-drift",
            {},
            "Staged output không còn cùng cấu trúc dòng/BOM/newline với file nguồn.",
        )

    counts = Counter(issue["severity"] for issue in issues)
    errors = counts["error"]
    warnings = counts["warning"]
    return {
        "passed": errors == 0,
        "blocking": errors > 0,
        "revision": revision,
        "errors": errors,
        "warnings": warnings,
        "issues": issues,
    }
