from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
# Khớp với src-tauri/src/models.rs — mỗi dòng JSONL stdout không được vượt giới hạn này.
MAX_EVENT_LINE_BYTES = 1024 * 1024
Reporter = Callable[[str, str, Mapping[str, Any]], None]


class ProgressThrottle:
    """Giới hạn tần suất event progress để tránh flood stdout/UI."""

    def __init__(self, *, min_interval_s: float = 0.25, min_step: int = 25) -> None:
        self._min_interval_s = min_interval_s
        self._min_step = min_step
        self._last_processed = -1
        self._last_time = 0.0

    def should_emit(self, processed: int, *, total: int | None = None) -> bool:
        if self._last_processed < 0:
            return True
        if total is not None and processed >= total:
            return True
        now = time.monotonic()
        if now - self._last_time >= self._min_interval_s:
            return True
        return processed - self._last_processed >= self._min_step

    def mark(self, processed: int) -> None:
        self._last_processed = processed
        self._last_time = time.monotonic()


def _warning_copy(payload: Mapping[str, Any]) -> tuple[str, str]:
    phase = str(payload.get("phase", ""))
    if phase == "endpoint-switch":
        return (
            "Đổi model hoặc API key",
            (
                f"{payload.get('reason', 'Endpoint hiện tại không khả dụng')} · "
                f"Key {payload.get('keyIndex', '?')}/{payload.get('keyCount', '?')} · "
                f"{payload.get('model', '')}"
            ).strip(" · "),
        )
    if phase == "retry":
        return (
            "Đang thử lại API",
            f"Lần {payload.get('attempt', '?')} · chờ {payload.get('waitSeconds', '?')} giây",
        )
    if phase == "item-fallback":
        return (
            "Fallback dịch từng mục",
            f"ID {payload.get('id', '?')} · {payload.get('error', 'Không dịch được batch')}",
        )
    if phase == "qa-summary":
        counts = payload.get("issueCounts")
        if isinstance(counts, Mapping):
            summary = ", ".join(
                f"{key}: {value}" for key, value in sorted(counts.items())
            )[:240]
        else:
            summary = str(payload.get("issueCount", 0))
        return (
            "QA phát hiện cảnh báo",
            f"{payload.get('issueCount', 0)} vấn đề · {summary}",
        )
    message = payload.get("message") or payload.get("reason") or "Cảnh báo"
    description = payload.get("description") or payload.get("error") or ""
    return str(message), str(description)


def report_warning(
    reporter: Reporter,
    step: str,
    payload: Mapping[str, Any],
) -> None:
    enriched = dict(payload)
    if "title" not in enriched or "description" not in enriched:
        title, description = _warning_copy(payload)
        enriched.setdefault("title", title)
        enriched.setdefault("description", description)
    reporter("warning", step, enriched)


def report_progress(
    reporter: Reporter,
    step: str,
    payload: Mapping[str, Any],
    throttle: ProgressThrottle,
    *,
    force: bool = False,
) -> None:
    processed = int(payload.get("processed", 0))
    total_value = payload.get("total")
    total = int(total_value) if total_value is not None else None
    if force or throttle.should_emit(processed, total=total):
        throttle.mark(processed)
        title = payload.get("title")
        progress_payload = {
            key: value
            for key, value in payload.items()
            if key not in {"title", "description"}
        }
        if (
            "progress" not in progress_payload
            and total is not None
            and total > 0
            and processed <= total
        ):
            progress_payload["progress"] = round(processed * 100 / total)
        reporter("progress", step, progress_payload)
        if title:
            reporter(
                "log",
                step,
                {
                    "title": str(title),
                    "description": str(payload.get("description") or ""),
                },
            )


class EngineError(RuntimeError):
    """Base class for expected engine failures."""


class ValidationError(EngineError):
    """The caller supplied invalid or unsafe state."""


class CancelledError(EngineError):
    """The operation was cooperatively cancelled."""


class StalePreviewError(ValidationError):
    """The sync source or target changed after preview."""


class RestoreFingerprintConflict(StalePreviewError):
    """The restore target changed after the selected backup."""


class QuotaExhaustedError(EngineError):
    """All configured Gemini key/model combinations exhausted quota."""


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def is_cancelled(self) -> bool:
        """Alias tương thích — một số bản build cũ gọi method này thay vì property."""
        return self.cancelled

    def cancel(self) -> None:
        self._event.set()

    def check(self) -> None:
        if self.cancelled:
            raise CancelledError("Tác vụ đã bị hủy")

    def wait(self, seconds: float) -> None:
        if seconds > 0 and self._event.wait(seconds):
            self.check()


def null_reporter(_event_type: str, _step: str, _payload: Mapping[str, Any]) -> None:
    return None


@dataclass(frozen=True)
class FileInventory:
    xml_files: int = 0
    vtt_files: int = 0
    rows: int = 0
    replaces: int = 0
    deletes: int = 0
    cues: int = 0
    invalid: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "xmlFiles": self.xml_files,
            "vttFiles": self.vtt_files,
            "rows": self.rows,
            "replaces": self.replaces,
            "deletes": self.deletes,
            "cues": self.cues,
            "invalid": list(self.invalid),
        }


@dataclass(frozen=True)
class SyncPlan:
    source: Path
    target: Path
    fingerprint: str
    actions: tuple[dict[str, Any], ...]
    summary: Mapping[str, int]
    errors: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": str(self.source),
            "target": str(self.target),
            "fingerprint": self.fingerprint,
            "actions": list(self.actions),
            "summary": dict(self.summary),
            "errors": list(self.errors),
        }


@dataclass
class TranslationStats:
    files_processed: int = 0
    files_changed: int = 0
    items_translated: int = 0
    items_skipped: int = 0
    cache_hits: int = 0
    api_calls: int = 0
    keys_used: int = 0
    model_switches: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "filesProcessed": self.files_processed,
            "filesChanged": self.files_changed,
            "itemsTranslated": self.items_translated,
            "itemsSkipped": self.items_skipped,
            "cacheHits": self.cache_hits,
            "apiCalls": self.api_calls,
            "keysUsed": self.keys_used,
            "modelSwitches": self.model_switches,
            "errors": self.errors,
        }
