from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any

from .formats import (
    collect_files,
    entry_key,
    iter_localized_text,
    parse_vtt,
    parse_xml,
    vtt_cues,
    vtt_structure,
    xml_structure,
)
from .language import is_proper_name_file, missing_tokens, needs_translation
from .types import (
    CancellationToken,
    ProgressThrottle,
    Reporter,
    ValidationError,
    null_reporter,
    report_progress,
)


def run_qa(
    target_dir: Path,
    english_dir: Path | None = None,
    *,
    max_issues: int = 10_000,
    reporter: Reporter = null_reporter,
    cancel: CancellationToken | None = None,
) -> dict[str, Any]:
    cancel = cancel or CancellationToken()
    target = target_dir.resolve()
    english = english_dir.resolve() if english_dir else None
    if not target.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục Vietnam: {target}")
    if english and not english.is_dir():
        raise ValidationError(f"Không tìm thấy thư mục English: {english}")

    target_files = collect_files(target)
    english_files = collect_files(english) if english else {}
    issues: list[dict[str, Any]] = []
    issue_counts: Counter[str] = Counter()

    def add_issue(kind: str, **payload: Any) -> None:
        issue_counts[kind] += 1
        if len(issues) < max_issues:
            issues.append({"kind": kind, **payload})

    if english:
        for key in sorted(set(english_files) - set(target_files)):
            add_issue("missing-file", file=english_files[key].as_posix())
        for key in sorted(set(target_files) - set(english_files)):
            add_issue("extra-file", file=target_files[key].as_posix())

    progress = ProgressThrottle()
    target_keys = sorted(target_files)
    for index, key in enumerate(target_keys, start=1):
        cancel.check()
        relative = target_files[key]
        target_path = target / relative
        english_path = (
            english / english_files[key] if english and key in english_files else None
        )
        try:
            if target_path.suffix.lower() == ".xml":
                target_tree = parse_xml(target_path)
                english_tree = parse_xml(english_path) if english_path else None
                if english_tree and xml_structure(target_tree) != xml_structure(
                    english_tree
                ):
                    add_issue("xml-structure", file=relative.as_posix())
                english_lookup: defaultdict[tuple[str, str], deque[str]] = defaultdict(
                    deque
                )
                if english_tree:
                    for element, text_element in iter_localized_text(english_tree):
                        english_lookup[entry_key(element)].append(
                            text_element.text or ""
                        )
                for element, text_element in iter_localized_text(target_tree):
                    target_text = text_element.text or ""
                    source_text = (
                        english_lookup[entry_key(element)].popleft()
                        if english_lookup[entry_key(element)]
                        else target_text
                    )
                    if not is_proper_name_file(relative) and needs_translation(
                        target_text, source_text if english_tree else None
                    ):
                        add_issue(
                            "untranslated",
                            file=relative.as_posix(),
                            tag=element.get("Tag"),
                            source=source_text[:300],
                            text=target_text[:300],
                        )
                    missing = missing_tokens(source_text, target_text)
                    if missing:
                        add_issue(
                            "missing-token",
                            file=relative.as_posix(),
                            tag=element.get("Tag"),
                            source=source_text[:300],
                            text=target_text[:300],
                            tokens=missing,
                        )
            else:
                target_blocks = parse_vtt(target_path)
                english_blocks = parse_vtt(english_path) if english_path else None
                if english_blocks and vtt_structure(target_blocks) != vtt_structure(
                    english_blocks
                ):
                    add_issue("vtt-structure", file=relative.as_posix())
                english_by_timing: defaultdict[str, deque[str]] = defaultdict(deque)
                if english_blocks:
                    for cue in vtt_cues(english_blocks):
                        if cue.timing:
                            english_by_timing[cue.timing].append(cue.text)
                for cue in vtt_cues(target_blocks):
                    source_text = (
                        english_by_timing[cue.timing].popleft()
                        if cue.timing and english_by_timing[cue.timing]
                        else cue.text
                    )
                    if needs_translation(
                        cue.text, source_text if english_blocks else None
                    ):
                        add_issue(
                            "untranslated",
                            file=relative.as_posix(),
                            timing=cue.timing,
                            source=source_text[:300],
                            text=cue.text[:300],
                        )
                    missing = missing_tokens(source_text, cue.text)
                    if missing:
                        add_issue(
                            "missing-token",
                            file=relative.as_posix(),
                            timing=cue.timing,
                            source=source_text[:300],
                            text=cue.text[:300],
                            tokens=missing,
                        )
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            add_issue("invalid-file", file=relative.as_posix(), error=str(error))
        report_progress(
            reporter,
            "qa",
            {
                "processed": index,
                "total": len(target_keys),
                "file": relative.as_posix(),
            },
            progress,
        )

    result = {
        "target": str(target),
        "english": str(english) if english else None,
        "filesChecked": len(target_files),
        "passed": not issue_counts,
        "issueCount": sum(issue_counts.values()),
        "issueCounts": dict(sorted(issue_counts.items())),
        "issues": issues,
        "truncated": len(issues) < sum(issue_counts.values()),
    }
    reporter("result", "qa", result)
    return result
