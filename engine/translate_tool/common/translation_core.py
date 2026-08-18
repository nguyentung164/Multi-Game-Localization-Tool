from __future__ import annotations

import json
import math
import queue
import random
import re
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .formats import atomic_text_write
from .language import has_han, missing_tokens, text_hash
from .types import (
    CancellationToken,
    CancelledError,
    ProgressThrottle,
    QuotaExhaustedError,
    Reporter,
    TranslationStats,
    ValidationError,
    null_reporter,
    report_progress,
    report_warning,
)

DEFAULT_MODELS = (
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
)
JSON_BLOCK_PATTERN = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
ClientFactory = Callable[[str, float], Any]
BatchGlossaryHints = Callable[[Sequence[Mapping[str, str]]], Mapping[str, str] | None]
THINKING_LEVEL = "high"
CACHE_SAVE_INTERVAL_S = 1.0


def translation_glossary_hash(
    glossary: Mapping[str, str] | None,
    locked_glossary: Mapping[str, str] | None,
) -> str:
    return text_hash(
        json.dumps(
            {
                "entries": glossary or {},
                "locked": locked_glossary or {},
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


@dataclass(frozen=True)
class TranslationProfile:
    id: str
    source_language: str
    target_language: str
    system_instruction: str
    style_rules: Mapping[str, str]
    supports_legacy_cache: bool = False

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("TranslationProfile.id không được rỗng")
        if not self.source_language.strip() or not self.target_language.strip():
            raise ValueError("Ngôn ngữ nguồn/đích không được rỗng")
        if not self.system_instruction.strip():
            raise ValueError("system_instruction không được rỗng")

    @property
    def prompt_hash(self) -> str:
        canonical = json.dumps(
            {
                "id": self.id,
                "sourceLanguage": self.source_language,
                "targetLanguage": self.target_language,
                "systemInstruction": self.system_instruction,
                "styleRules": dict(sorted(self.style_rules.items())),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return text_hash(canonical)

    def style_instruction(self, style: str) -> str:
        return self.style_rules.get(
            style,
            self.style_rules.get("default", "Dịch tự nhiên và nhất quán thuật ngữ."),
        )


@dataclass(frozen=True)
class TranslationConfig:
    api_keys: tuple[str, ...]
    models: tuple[str, ...] = DEFAULT_MODELS
    glossary: Mapping[str, str] | None = None
    locked_glossary: Mapping[str, str] | None = None
    cache_path: Path = Path("translation_cache_gemini.json")
    batch_size: int = 40
    gemma_batch_size: int = 15
    max_retries: int = 6
    delay_seconds: float = 0.5
    timeout_seconds: float = 180.0
    max_api_calls: int = 0
    max_files: int = 0
    dry_run: bool = False

    def validate(self) -> None:
        if not self.api_keys or not all(key.strip() for key in self.api_keys):
            raise ValidationError("Thiếu Gemini API key")
        if not self.models or not all(model.strip() for model in self.models):
            raise ValidationError("Danh sách model không hợp lệ")
        if self.batch_size < 1 or self.gemma_batch_size < 1:
            raise ValidationError("batchSize phải lớn hơn 0")
        if self.max_retries < 1:
            raise ValidationError("maxRetries phải lớn hơn 0")
        if self.timeout_seconds < 1:
            raise ValidationError("timeoutSeconds phải ít nhất 1")


def default_client_factory(api_key: str, timeout_seconds: float) -> Any:
    try:
        from google import genai
        from google.genai import types
    except ImportError as error:
        raise ValidationError(
            "Thiếu google-genai; hãy cài requirements của engine"
        ) from error
    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(
            timeout=int(timeout_seconds * 1000),
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    )


def _thinking_config() -> Any:
    try:
        from google.genai import types
    except ImportError:
        return {"thinking_level": THINKING_LEVEL}
    try:
        return types.ThinkingConfig(thinking_level=THINKING_LEVEL)
    except TypeError:
        return types.ThinkingConfig(thinking_budget=4096)


def response_config(profile: TranslationProfile) -> Any:
    schema = {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "required": ["id", "text"],
            "properties": {
                "id": {"type": "STRING"},
                "text": {"type": "STRING"},
            },
        },
    }
    thinking = _thinking_config()
    payload = {
        "system_instruction": profile.system_instruction,
        "response_mime_type": "application/json",
        "response_schema": schema,
        "temperature": 0.5,
        "thinking_config": thinking,
    }
    try:
        from google.genai import types

        try:
            return types.GenerateContentConfig(**payload)
        except TypeError:
            payload.pop("thinking_config", None)
            return types.GenerateContentConfig(**payload)
    except ImportError:
        return payload


def parse_response(raw: str) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    block = JSON_BLOCK_PATTERN.search(text)
    if block:
        text = block.group(1).strip()
    if not text:
        raise ValueError("Gemini trả về nội dung rỗng")
    data = json.loads(text)
    if isinstance(data, dict) and "items" in data:
        data = data["items"]
    if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
        raise ValueError("Gemini phải trả về JSON array")
    return data


def error_info(error: BaseException) -> dict[str, Any]:
    message = str(error)
    lower = message.casefold()
    code = getattr(error, "code", None) or getattr(error, "status_code", None)
    rate_limited = code == 429 or "429" in lower or "resource_exhausted" in lower
    daily = "perday" in lower.replace("_", "").replace("-", "") or bool(
        re.search(r"limit:\s*0\b", lower)
    )
    model_missing = (
        code == 404
        or "404" in lower
        or "model" in lower
        and "not found" in lower
        or "no longer available" in lower
    )
    transient = (
        isinstance(error, TimeoutError)
        or rate_limited
        or code in {408, 500, 502, 503, 504}
        or any(
            token in lower for token in ("timeout", "timed out", "deadline exceeded")
        )
    )
    retry_match = re.search(r"retry in ([\d.]+)s", lower)
    return {
        "message": message,
        "rateLimited": rate_limited,
        "dailyQuota": daily,
        "modelMissing": model_missing,
        "transient": transient,
        "retrySeconds": float(retry_match.group(1)) if retry_match else None,
    }


def estimate_batches_for_counts(
    item_counts: Sequence[int],
    batch_size: int,
) -> int:
    """Sum ceil(len/batch) per bucket — không gộp xuyên file thành một batch ảo."""
    size = max(1, batch_size)
    return sum(math.ceil(max(0, count) / size) for count in item_counts if count > 0)


def estimate_worker_count(
    pending_items: int,
    key_count: int,
    batch_size: int,
) -> tuple[int, int, int]:
    """Return (workers_used, spare_keys, estimated_batches) for one pending pool."""
    return estimate_worker_count_from_batches(
        estimate_batches_for_counts([pending_items], batch_size),
        key_count,
    )


def estimate_worker_count_from_batches(
    batches: int,
    key_count: int,
) -> tuple[int, int, int]:
    """Return (workers_used, spare_keys, estimated_batches)."""
    keys = max(0, key_count)
    estimated = max(0, batches)
    workers = min(keys, estimated) if estimated and keys else 0
    spare = max(0, keys - workers)
    return workers, spare, estimated


@dataclass
class _WorkerEndpoint:
    key_index: int
    model_index: int = 0
    client: Any | None = None


@dataclass
class _PendingBucket:
    style: str
    file_hint: str
    items: deque[dict[str, str]] = field(default_factory=deque)


class GeminiTranslator:
    def __init__(
        self,
        config: TranslationConfig,
        profile: TranslationProfile,
        *,
        reporter: Reporter = null_reporter,
        cancel: CancellationToken | None = None,
        client_factory: ClientFactory | None = None,
        event_step: str = "translate",
        fail_on_item_error: bool = False,
        batch_glossary_hints: BatchGlossaryHints | None = None,
    ) -> None:
        config.validate()
        self.config = config
        self.profile = profile
        self.reporter = reporter
        self.cancel = cancel or CancellationToken()
        self.client_factory = client_factory or default_client_factory
        self.event_step = event_step
        self.fail_on_item_error = fail_on_item_error
        self.batch_glossary_hints = batch_glossary_hints
        self.stats = TranslationStats(keys_used=0)
        self.key_index = 0
        self.model_index = 0
        self.client: Any | None = None
        self.cache, self.legacy_cache = self._load_cache()
        self.glossary_hash = translation_glossary_hash(
            config.glossary,
            config.locked_glossary,
        )
        self._progress = ProgressThrottle()
        self._response_config: Any | None = None
        self._lock = threading.RLock()
        self._cache_dirty = False
        self._last_cache_save = 0.0
        self._spare_key_indices: deque[int] = deque()
        self._active_workers = 0
        self._workers_used = 0
        self._fatal_error: BaseException | None = None
        self._partial_translations: dict[str, str] = {}
        report_progress(
            self.reporter,
            self.event_step,
            {
                "phase": "endpoint",
                "keyCount": len(config.api_keys),
                "workers": 0,
                "model": self.config.models[0],
            },
            self._progress,
            force=True,
        )

    @property
    def model(self) -> str:
        return self.config.models[self.model_index]

    def _load_cache(self) -> tuple[dict[str, str], dict[str, str]]:
        path = self.config.cache_path
        if not path.is_file():
            return {}, {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if (
                isinstance(data, dict)
                and data.get("version") == 2
                and isinstance(data.get("items"), dict)
            ):
                current = {
                    str(key): str(value) for key, value in data["items"].items()
                }
                legacy_data = data.get("legacyItems")
                legacy = (
                    {
                        str(key): str(value)
                        for key, value in legacy_data.items()
                    }
                    if isinstance(legacy_data, dict)
                    else {}
                )
                return current, legacy
            if isinstance(data, dict) and isinstance(data.get("items"), dict):
                return {}, {
                    str(key): str(value) for key, value in data["items"].items()
                }
            if isinstance(data, dict):
                return {}, {str(key): str(value) for key, value in data.items()}
        except (OSError, json.JSONDecodeError):
            pass
        return {}, {}

    def save_cache(self) -> None:
        with self._lock:
            payload = self._cache_snapshot_unlocked()
            self._cache_dirty = False
            self._last_cache_save = time.monotonic()
        self._write_cache_payload(payload)

    def _cache_snapshot_unlocked(self) -> dict[str, object]:
        snapshot: dict[str, object] = {
            "version": 2,
            "items": dict(self.cache),
        }
        if self.legacy_cache:
            snapshot["legacyItems"] = dict(self.legacy_cache)
        return snapshot

    def _write_cache_payload(self, payload: Mapping[str, object]) -> None:
        atomic_text_write(
            self.config.cache_path,
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
            ),
        )

    def _take_cache_flush_payload(self, *, force: bool = False) -> dict[str, object] | None:
        """Copy cache for disk write. Caller must hold ``_lock``."""
        now = time.monotonic()
        if not self._cache_dirty:
            return None
        if (
            not force
            and self._last_cache_save
            and now - self._last_cache_save < CACHE_SAVE_INTERVAL_S
        ):
            return None
        payload = self._cache_snapshot_unlocked()
        self._cache_dirty = False
        self._last_cache_save = now
        return payload

    def flush_cache(self, *, force: bool = True) -> None:
        with self._lock:
            payload = self._take_cache_flush_payload(force=force)
        if payload is not None:
            self._write_cache_payload(payload)

    def _mark_cache_dirty(self) -> None:
        with self._lock:
            self._cache_dirty = True
            payload = self._take_cache_flush_payload(force=False)
        if payload is not None:
            self._write_cache_payload(payload)

    def _cache_key(self, text: str, style: str) -> str:
        namespace = "\0".join(
            (
                self.profile.id,
                self.profile.prompt_hash,
                style,
                self.glossary_hash,
                text,
            )
        )
        return text_hash(namespace)

    def _cached_if_usable(self, style: str, cached: str) -> str | None:
        if style == "legend" and has_han(cached):
            return None
        return cached

    def _lookup_cached(self, text: str, style: str) -> str | None:
        key = self._cache_key(text, style)
        cached = self.cache.get(key)
        if cached is not None:
            return self._cached_if_usable(style, cached)
        if not self.profile.supports_legacy_cache:
            return None
        legacy_keys = (
            text_hash(f"{style}\0{self.glossary_hash}\0{text}"),
            text_hash((text or "").strip()),
        )
        for legacy_key in legacy_keys:
            cached = self.legacy_cache.get(legacy_key)
            if cached is not None:
                usable = self._cached_if_usable(style, cached)
                if usable is None:
                    return None
                self.cache[key] = cached
                return cached
        return None

    def _store_cached(self, text: str, style: str, value: str) -> None:
        key = self._cache_key(text, style)
        if style == "legend" and has_han(value):
            self.cache.pop(key, None)
            return
        self.cache[key] = value

    def _effective_glossary(
        self, items: Sequence[Mapping[str, str]]
    ) -> Mapping[str, str]:
        base = dict(self.config.glossary or {})
        if not self.batch_glossary_hints:
            return base
        hints = self.batch_glossary_hints(items)
        if not hints:
            return base
        return {**hints, **base}

    def _prompt(
        self, items: Sequence[dict[str, str]], style: str, file_hint: str
    ) -> str:
        glossary = (
            "\n".join(
                f'- "{source}" -> "{target}"'
                for source, target in sorted(
                    self._effective_glossary(items).items(),
                    key=lambda item: len(item[0]),
                    reverse=True,
                )
            )
            or "- Không có glossary bổ sung."
        )
        locked_glossary = (
            "\n".join(
                f'- BẮT BUỘC "{source}" -> "{target}"'
                for source, target in sorted(
                    (self.config.locked_glossary or {}).items(),
                    key=lambda item: len(item[0]),
                    reverse=True,
                )
            )
            or "- Không có thuật ngữ khóa."
        )
        payload = json.dumps(items, ensure_ascii=False)
        return (
            f"Ngôn ngữ nguồn: {self.profile.source_language}\n"
            f"Ngôn ngữ đích: {self.profile.target_language}\n"
            f"Phong cách: {self.profile.style_instruction(style)}\n"
            f"File: {file_hint}\nGlossary:\n{glossary}\n"
            f"Thuật ngữ khóa:\n{locked_glossary}\nDữ liệu:\n{payload}"
        )

    def _prepared_response_config(self) -> Any:
        if self._response_config is None:
            self._response_config = response_config(self.profile)
        return self._response_config

    def _ensure_client(self, endpoint: _WorkerEndpoint) -> Any:
        if endpoint.client is None:
            endpoint.client = self.client_factory(
                self.config.api_keys[endpoint.key_index],
                self.config.timeout_seconds,
            )
            with self._lock:
                self.stats.keys_used = max(
                    self.stats.keys_used, endpoint.key_index + 1
                )
        return endpoint.client

    def _endpoint_model(self, endpoint: _WorkerEndpoint) -> str:
        return self.config.models[endpoint.model_index]

    def _batch_size_for(self, endpoint: _WorkerEndpoint) -> int:
        model = self._endpoint_model(endpoint)
        if model.startswith("gemma-"):
            return max(1, self.config.gemma_batch_size)
        return max(1, self.config.batch_size)

    def _advance_model(self, endpoint: _WorkerEndpoint, reason: str) -> bool:
        if endpoint.model_index + 1 >= len(self.config.models):
            return False
        endpoint.model_index += 1
        with self._lock:
            self.stats.model_switches += 1
        report_warning(
            self.reporter,
            self.event_step,
            {
                "phase": "endpoint-switch",
                "reason": reason[:200],
                "keyIndex": endpoint.key_index + 1,
                "keyCount": len(self.config.api_keys),
                "model": self._endpoint_model(endpoint),
                "switchKind": "model",
            },
        )
        return True

    def _swap_spare(self, endpoint: _WorkerEndpoint, reason: str) -> bool:
        with self._lock:
            if not self._spare_key_indices:
                return False
            next_key = self._spare_key_indices.popleft()
            from_key = endpoint.key_index + 1
            endpoint.key_index = next_key
            endpoint.model_index = 0
            endpoint.client = None
            self.stats.keys_used = max(self.stats.keys_used, next_key + 1)
            to_key = next_key + 1
        report_warning(
            self.reporter,
            self.event_step,
            {
                "phase": "endpoint-switch",
                "reason": reason[:200],
                "fromKeyIndex": from_key,
                "keyIndex": to_key,
                "keyCount": len(self.config.api_keys),
                "model": self._endpoint_model(endpoint),
                "switchKind": "spare",
                "title": f"Key {from_key} hết quota ngày · chuyển sang Key {to_key}",
                "description": reason[:200],
            },
        )
        return True

    def _call(self, endpoint: _WorkerEndpoint, prompt: str) -> Any:
        self.cancel.check()
        client = self._ensure_client(endpoint)
        model = self._endpoint_model(endpoint)
        request_config = self._prepared_response_config()
        outcome: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def invoke() -> None:
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=request_config,
                )
                outcome.put((True, response))
            except Exception as error:  # noqa: BLE001 - forward SDK failures.
                outcome.put((False, error))

        threading.Thread(target=invoke, name="gemini-request", daemon=True).start()
        deadline = time.monotonic() + self.config.timeout_seconds
        while True:
            self.cancel.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    succeeded, value = outcome.get_nowait()
                except queue.Empty:
                    raise TimeoutError(
                        f"Gemini không phản hồi sau {self.config.timeout_seconds:g}s"
                    ) from None
                if succeeded:
                    return value
                raise value
            try:
                succeeded, value = outcome.get(timeout=min(0.25, remaining))
            except queue.Empty:
                continue
            if succeeded:
                return value
            raise value

    def _reserve_api_call(self) -> None:
        with self._lock:
            if (
                self.config.max_api_calls
                and self.stats.api_calls >= self.config.max_api_calls
            ):
                raise QuotaExhaustedError("Đã đạt giới hạn maxApiCalls")
            self.stats.api_calls += 1

    def _request_batch(
        self,
        endpoint: _WorkerEndpoint,
        items: Sequence[dict[str, str]],
        style: str,
        file_hint: str,
    ) -> dict[str, str]:
        prompt = self._prompt(items, style, file_hint)
        last_error: BaseException | None = None
        attempt = 0
        while attempt < self.config.max_retries:
            self.cancel.check()
            try:
                self._reserve_api_call()
                response = self._call(endpoint, prompt)
                parsed = parse_response(getattr(response, "text", "") or str(response))
                source_by_id = {item["id"]: item["text"] for item in items}
                result: dict[str, str] = {}
                for row in parsed:
                    item_id = str(row.get("id", ""))
                    translated = str(row.get("text", "")).strip()
                    if item_id not in source_by_id or not translated:
                        continue
                    missing = missing_tokens(source_by_id[item_id], translated)
                    if missing:
                        raise ValueError(f"Token bị mất ở {item_id}: {missing}")
                    result[item_id] = translated
                missing_ids = [item["id"] for item in items if item["id"] not in result]
                if missing_ids:
                    raise ValueError(f"Thiếu id: {missing_ids[:5]}")
                self.cancel.wait(self.config.delay_seconds)
                return result
            except (ValueError, json.JSONDecodeError) as error:
                last_error = error
                break
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit, CancelledError)):
                    raise
                if isinstance(error, QuotaExhaustedError):
                    raise
                self.cancel.check()
                last_error = error
                info = error_info(error)
                if info["modelMissing"] or (info["rateLimited"] and info["dailyQuota"]):
                    if self._advance_model(endpoint, info["message"]):
                        attempt = 0
                        continue
                    if self._swap_spare(endpoint, info["message"]):
                        attempt = 0
                        continue
                    raise QuotaExhaustedError(
                        "Hết model/quota trên tất cả API key"
                    ) from error
                attempt += 1
                if not info["transient"] or attempt >= self.config.max_retries:
                    break
                wait = info["retrySeconds"] or min(30.0, 2.0**attempt)
                wait += random.uniform(0.0, min(1.5, wait * 0.25))
                report_warning(
                    self.reporter,
                    self.event_step,
                    {
                        "phase": "retry",
                        "attempt": attempt,
                        "waitSeconds": wait,
                        "keyIndex": endpoint.key_index + 1,
                        "keyCount": len(self.config.api_keys),
                    },
                )
                self.cancel.wait(wait)

        if last_error is not None:
            info = error_info(last_error)
            if info["rateLimited"] and not info["dailyQuota"]:
                if self._advance_model(endpoint, info["message"]):
                    return self._request_batch(endpoint, items, style, file_hint)
                if self._swap_spare(endpoint, info["message"]):
                    return self._request_batch(endpoint, items, style, file_hint)
            if info["modelMissing"] or (info["rateLimited"] and info["dailyQuota"]):
                if self._advance_model(endpoint, info["message"]):
                    return self._request_batch(endpoint, items, style, file_hint)
                if self._swap_spare(endpoint, info["message"]):
                    return self._request_batch(endpoint, items, style, file_hint)
        if len(items) == 1:
            report_warning(
                self.reporter,
                self.event_step,
                {
                    "phase": "item-fallback",
                    "id": items[0]["id"],
                    "error": str(last_error)[:300],
                },
            )
            if self.fail_on_item_error:
                raise ValidationError(
                    f"Không dịch được mục {items[0]['id']}: {last_error}"
                ) from last_error
            return {items[0]["id"]: items[0]["text"]}
        middle = len(items) // 2
        result = self._request_batch(endpoint, items[:middle], style, file_hint)
        result.update(self._request_batch(endpoint, items[middle:], style, file_hint))
        return result

    def _pop_batch(
        self, buckets: list[_PendingBucket], batch_size: int
    ) -> tuple[list[dict[str, str]], str, str] | None:
        with self._lock:
            for bucket in buckets:
                if not bucket.items:
                    continue
                chunk: list[dict[str, str]] = []
                while bucket.items and len(chunk) < batch_size:
                    chunk.append(bucket.items.popleft())
                return chunk, bucket.style, bucket.file_hint
        return None

    def _remaining_pending(self, buckets: list[_PendingBucket]) -> int:
        with self._lock:
            return sum(len(bucket.items) for bucket in buckets)

    def translate_items(
        self,
        items: Sequence[dict[str, str]],
        style: str,
        file_hint: str,
        *,
        skip_cache: bool = False,
    ) -> dict[str, str]:
        return self.translate_groups(
            [(items, style, file_hint)],
            skip_cache=skip_cache,
        )

    def translate_groups(
        self,
        groups: Sequence[tuple[Sequence[dict[str, str]], str, str]],
        *,
        skip_cache: bool = False,
    ) -> dict[str, str]:
        """Translate one or more (items, style, file_hint) buckets in parallel.

        Returns a flat id→text map. Callers must use unique ids across groups.
        """
        result: dict[str, str] = {}
        buckets: list[_PendingBucket] = []
        total_items = 0
        for items, style, file_hint in groups:
            pending: deque[dict[str, str]] = deque()
            for item in items:
                total_items += 1
                cached = (
                    None if skip_cache else self._lookup_cached(item["text"], style)
                )
                if cached is not None:
                    result[item["id"]] = cached
                    with self._lock:
                        self.stats.cache_hits += 1
                else:
                    pending.append({"id": item["id"], "text": item["text"]})
            if pending:
                buckets.append(
                    _PendingBucket(style=style, file_hint=file_hint, items=pending)
                )

        pending_count = sum(len(bucket.items) for bucket in buckets)
        if pending_count == 0:
            self.flush_cache(force=True)
            return result

        batch_size = max(1, self.config.batch_size)
        estimated_batches = estimate_batches_for_counts(
            [len(bucket.items) for bucket in buckets],
            batch_size,
        )
        workers_used, _spare, estimated_batches = estimate_worker_count_from_batches(
            estimated_batches,
            len(self.config.api_keys),
        )
        workers_used = max(1, workers_used)
        self._workers_used = workers_used
        self._spare_key_indices = deque(range(workers_used, len(self.config.api_keys)))
        self._fatal_error = None
        self._active_workers = 0

        done_event = threading.Event()

        def emit_progress(*, force: bool = False, phase: str = "api") -> None:
            with self._lock:
                active = self._active_workers
                api_calls = self.stats.api_calls
                processed = len(result)
                spare = len(self._spare_key_indices)
            report_progress(
                self.reporter,
                self.event_step,
                {
                    "phase": phase,
                    "processed": processed,
                    "total": total_items,
                    "itemsProcessed": processed,
                    "itemsTotal": total_items,
                    "itemProgress": round(processed * 100 / max(1, total_items)),
                    "workers": active,
                    "workersUsed": self._workers_used,
                    "keyCount": len(self.config.api_keys),
                    "spareKeys": spare,
                    "estimatedBatches": estimated_batches,
                    "apiCalls": api_calls,
                    "model": self.config.models[0],
                    "title": f"Đang dịch · {active} luồng",
                    "description": (
                        f"{processed}/{total_items} mục · "
                        f"{active}/{self._workers_used} luồng"
                    ),
                },
                self._progress,
                force=force,
            )

        def heartbeat() -> None:
            while not done_event.wait(1.0):
                if self.cancel.cancelled or self._fatal_error is not None:
                    break
                emit_progress(force=True, phase="heartbeat")

        def worker(endpoint: _WorkerEndpoint) -> None:
            with self._lock:
                self._active_workers += 1
            try:
                while True:
                    if self._fatal_error is not None:
                        return
                    self.cancel.check()
                    popped = self._pop_batch(buckets, self._batch_size_for(endpoint))
                    if popped is None:
                        return
                    chunk, style, file_hint = popped
                    try:
                        translated = self._request_batch(
                            endpoint, chunk, style, file_hint
                        )
                    except QuotaExhaustedError:
                        with self._lock:
                            for bucket in buckets:
                                if (
                                    bucket.style == style
                                    and bucket.file_hint == file_hint
                                ):
                                    for item in reversed(chunk):
                                        bucket.items.appendleft(item)
                                    break
                            if self._fatal_error is None:
                                self._fatal_error = QuotaExhaustedError(
                                    "Hết model/quota trên tất cả API key"
                                )
                            self.cancel.cancel()
                        return
                    except (ValidationError, CancelledError) as error:
                        with self._lock:
                            if self._fatal_error is None:
                                self._fatal_error = error
                            self.cancel.cancel()
                        return
                    except BaseException as error:
                        if isinstance(error, (KeyboardInterrupt, SystemExit)):
                            raise
                        with self._lock:
                            if self._fatal_error is None:
                                self._fatal_error = error
                            self.cancel.cancel()
                        return

                    with self._lock:
                        for item in chunk:
                            value = translated[item["id"]]
                            result[item["id"]] = value
                            if value != item["text"]:
                                self._store_cached(item["text"], style, value)
                        self._cache_dirty = True
                        cache_payload = self._take_cache_flush_payload(force=False)
                        self.key_index = endpoint.key_index
                        self.model_index = endpoint.model_index
                        self.client = endpoint.client
                        processed = len(result)
                        active = self._active_workers
                    if cache_payload is not None:
                        self._write_cache_payload(cache_payload)
                    # Một progress phase=api / batch — tránh cộng localRequests hai lần.
                    report_progress(
                        self.reporter,
                        self.event_step,
                        {
                            "phase": "api",
                            "processed": processed,
                            "total": total_items,
                            "itemsProcessed": processed,
                            "itemsTotal": total_items,
                            "itemProgress": round(
                                processed * 100 / max(1, total_items)
                            ),
                            "workers": active,
                            "workersUsed": self._workers_used,
                            "keyIndex": endpoint.key_index + 1,
                            "keyCount": len(self.config.api_keys),
                            "model": self._endpoint_model(endpoint),
                            "file": file_hint,
                            "currentItem": Path(file_hint).name,
                            "title": f"Đang dịch · {active} luồng",
                            "description": (
                                f"{processed}/{total_items} mục · "
                                f"{active}/{self._workers_used} luồng"
                            ),
                        },
                        self._progress,
                        force=True,
                    )
            except CancelledError:
                return
            finally:
                with self._lock:
                    self._active_workers = max(0, self._active_workers - 1)

        emit_progress(force=True, phase="heartbeat")
        heartbeat_thread = threading.Thread(
            target=heartbeat, name="gemini-heartbeat", daemon=True
        )
        heartbeat_thread.start()
        threads = [
            threading.Thread(
                target=worker,
                args=(_WorkerEndpoint(key_index=index),),
                name=f"gemini-worker-{index + 1}",
                daemon=True,
            )
            for index in range(workers_used)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        done_event.set()
        heartbeat_thread.join(timeout=2.0)
        self.flush_cache(force=True)

        if self._fatal_error is not None:
            self._partial_translations = dict(result)
            self.flush_cache(force=True)
            error = self._fatal_error
            if isinstance(error, (QuotaExhaustedError, ValidationError, CancelledError)):
                raise error
            raise ValidationError(str(error)) from error
        self.cancel.check()

        remaining = self._remaining_pending(buckets)
        if remaining:
            self._partial_translations = dict(result)
            self.flush_cache(force=True)
            raise QuotaExhaustedError(
                f"Còn {remaining} mục chưa dịch sau khi hết worker/quota"
            )

        report_progress(
            self.reporter,
            self.event_step,
            {
                "phase": "complete",
                "processed": len(result),
                "total": total_items,
                "itemsProcessed": len(result),
                "itemsTotal": total_items,
                "itemProgress": 100,
                "workers": 0,
                "workersUsed": self._workers_used,
                "keyCount": len(self.config.api_keys),
                "model": self.config.models[min(self.model_index, len(self.config.models) - 1)],
            },
            self._progress,
            force=True,
        )
        return result
