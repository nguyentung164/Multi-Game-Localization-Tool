from __future__ import annotations

import json
import queue
import re
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .formats import (
    atomic_text_write,
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
from .language import (
    detect_style,
    is_proper_name_file,
    missing_tokens,
    needs_translation,
    text_hash,
)
from .qa import run_qa
from .types import (
    CancellationToken,
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


@dataclass(frozen=True)
class TranslationConfig:
    api_keys: tuple[str, ...]
    models: tuple[str, ...] = DEFAULT_MODELS
    glossary: Mapping[str, str] | None = None
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


def _default_client_factory(api_key: str, timeout_seconds: float) -> Any:
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


def _response_config() -> Any:
    try:
        from google.genai import types

        return types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema={
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "required": ["id", "text"],
                    "properties": {
                        "id": {"type": "STRING"},
                        "text": {"type": "STRING"},
                    },
                },
            },
        )
    except ImportError:
        return {
            "response_mime_type": "application/json",
            "response_schema": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "text"],
                    "properties": {
                        "id": {"type": "string"},
                        "text": {"type": "string"},
                    },
                },
            },
        }


def _parse_response(raw: str) -> list[dict[str, Any]]:
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


def _error_info(error: BaseException) -> dict[str, Any]:
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


class GeminiTranslator:
    def __init__(
        self,
        config: TranslationConfig,
        *,
        reporter: Reporter = null_reporter,
        cancel: CancellationToken | None = None,
        client_factory: ClientFactory | None = None,
    ) -> None:
        config.validate()
        self.config = config
        self.reporter = reporter
        self.cancel = cancel or CancellationToken()
        self.client_factory = client_factory or _default_client_factory
        self.stats = TranslationStats(keys_used=1)
        self.key_index = 0
        self.model_index = 0
        self.client = self.client_factory(
            config.api_keys[self.key_index], config.timeout_seconds
        )
        self.cache = self._load_cache()
        self.glossary_hash = text_hash(
            json.dumps(config.glossary or {}, ensure_ascii=False, sort_keys=True)
        )
        self._progress = ProgressThrottle()
        report_progress(
            self.reporter,
            "translate",
            {
                "phase": "endpoint",
                "keyIndex": 1,
                "keyCount": len(config.api_keys),
                "model": self.model,
            },
            self._progress,
            force=True,
        )

    @property
    def model(self) -> str:
        return self.config.models[self.model_index]

    def _load_cache(self) -> dict[str, str]:
        path = self.config.cache_path
        if not path.is_file():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("items"), dict):
                return {str(key): str(value) for key, value in data["items"].items()}
            if isinstance(data, dict):
                return {str(key): str(value) for key, value in data.items()}
        except (OSError, json.JSONDecodeError):
            pass
        return {}

    def save_cache(self) -> None:
        atomic_text_write(
            self.config.cache_path,
            json.dumps(
                self.cache,
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
            ),
        )

    def _cache_key(self, text: str, style: str) -> str:
        return text_hash(f"{style}\0{self.glossary_hash}\0{text}")

    def _legacy_cache_key(self, text: str) -> str:
        return text_hash((text or "").strip())

    def _lookup_cached(self, text: str, style: str) -> str | None:
        key = self._cache_key(text, style)
        if key in self.cache:
            return self.cache[key]
        legacy = self._legacy_cache_key(text)
        if legacy in self.cache:
            return self.cache[legacy]
        return None

    def _store_cached(self, text: str, style: str, value: str) -> None:
        key = self._cache_key(text, style)
        self.cache[key] = value
        legacy = self._legacy_cache_key(text)
        if legacy != key:
            self.cache[legacy] = value

    def _advance_endpoint(self, reason: str) -> bool:
        if self.model_index + 1 < len(self.config.models):
            self.model_index += 1
            self.stats.model_switches += 1
        elif self.key_index + 1 < len(self.config.api_keys):
            self.key_index += 1
            self.model_index = 0
            self.stats.keys_used = max(self.stats.keys_used, self.key_index + 1)
            self.client = self.client_factory(
                self.config.api_keys[self.key_index], self.config.timeout_seconds
            )
        else:
            return False
        report_warning(
            self.reporter,
            "translate",
            {
                "phase": "endpoint-switch",
                "reason": reason[:200],
                "keyIndex": self.key_index + 1,
                "keyCount": len(self.config.api_keys),
                "model": self.model,
            },
        )
        return True

    def _style_instruction(self, style: str) -> str:
        return {
            "leader": "Lời thoại lãnh đạo: tự nhiên, mạnh mẽ và nhất quán xưng hô.",
            "lore": "Civilopedia/narrative: trang trọng, mạch lạc, giữ tên riêng.",
            "ui": "UI/menu: ngắn gọn, rõ nghĩa.",
            "game": "Văn bản game chiến lược: tự nhiên và nhất quán thuật ngữ.",
        }.get(style, "Dịch tự nhiên và nhất quán thuật ngữ.")

    def _prompt(
        self, items: Sequence[dict[str, str]], style: str, file_hint: str
    ) -> str:
        glossary = (
            "\n".join(
                f'- "{source}" -> "{target}"'
                for source, target in sorted(
                    (self.config.glossary or {}).items(),
                    key=lambda item: len(item[0]),
                    reverse=True,
                )
            )
            or "- Không có glossary bổ sung."
        )
        payload = json.dumps(items, ensure_ascii=False)
        return (
            "Dịch localization Civilization VII từ tiếng Anh sang tiếng Việt.\n"
            "Giữ nguyên tuyệt đối mọi token/placeholder trong {}, [], [TIP] và cú pháp plural. "
            'Không đổi id, không giải thích. Chỉ trả JSON array [{"id":"...","text":"..."}].\n'
            f"Phong cách: {self._style_instruction(style)}\n"
            f"File: {file_hint}\nGlossary:\n{glossary}\nDữ liệu:\n{payload}"
        )

    def _call(self, prompt: str) -> Any:
        self.cancel.check()
        outcome: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def invoke() -> None:
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=prompt,
                    config=_response_config(),
                )
                outcome.put((True, response))
            except Exception as error:  # noqa: BLE001 - forward SDK failures to caller.
                outcome.put((False, error))

        threading.Thread(target=invoke, name="gemini-request", daemon=True).start()
        deadline = time.monotonic() + self.config.timeout_seconds
        while True:
            self.cancel.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"Gemini không phản hồi sau {self.config.timeout_seconds:g}s"
                )
            try:
                succeeded, value = outcome.get(timeout=min(0.25, remaining))
            except queue.Empty:
                continue
            if succeeded:
                return value
            raise value

    def _ensure_budget(self) -> None:
        if (
            self.config.max_api_calls
            and self.stats.api_calls >= self.config.max_api_calls
        ):
            raise QuotaExhaustedError("Đã đạt giới hạn maxApiCalls")

    def _request_batch(
        self, items: Sequence[dict[str, str]], style: str, file_hint: str
    ) -> dict[str, str]:
        prompt = self._prompt(items, style, file_hint)
        last_error: BaseException | None = None
        attempt = 0
        while attempt < self.config.max_retries:
            self.cancel.check()
            self._ensure_budget()
            try:
                self.stats.api_calls += 1
                response = self._call(prompt)
                parsed = _parse_response(getattr(response, "text", "") or str(response))
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
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                self.cancel.check()
                last_error = error
                info = _error_info(error)
                if info["modelMissing"] or (info["rateLimited"] and info["dailyQuota"]):
                    if self._advance_endpoint(info["message"]):
                        attempt = 0
                        continue
                    raise QuotaExhaustedError(
                        "Hết model/quota trên tất cả API key"
                    ) from error
                attempt += 1
                if not info["transient"] or attempt >= self.config.max_retries:
                    break
                wait = info["retrySeconds"] or min(30.0, 2.0**attempt)
                report_warning(
                    self.reporter,
                    "translate",
                    {"phase": "retry", "attempt": attempt, "waitSeconds": wait},
                )
                self.cancel.wait(wait)

        if last_error is not None:
            info = _error_info(last_error)
            if info["rateLimited"] and self._advance_endpoint(info["message"]):
                return self._request_batch(items, style, file_hint)
        if len(items) == 1:
            report_warning(
                self.reporter,
                "translate",
                {
                    "phase": "item-fallback",
                    "id": items[0]["id"],
                    "error": str(last_error)[:300],
                },
            )
            return {items[0]["id"]: items[0]["text"]}
        middle = len(items) // 2
        result = self._request_batch(items[:middle], style, file_hint)
        result.update(self._request_batch(items[middle:], style, file_hint))
        return result

    def translate_items(
        self, items: Sequence[dict[str, str]], style: str, file_hint: str
    ) -> dict[str, str]:
        result: dict[str, str] = {}
        pending: list[dict[str, str]] = []
        for item in items:
            cached = self._lookup_cached(item["text"], style)
            if cached is not None:
                result[item["id"]] = cached
                self.stats.cache_hits += 1
            else:
                pending.append(item)
        start = 0
        batch_number = 0
        while start < len(pending):
            self.cancel.check()
            batch_size = (
                self.config.gemma_batch_size
                if self.model.startswith("gemma-")
                else self.config.batch_size
            )
            chunk = pending[start : start + batch_size]
            batch_number += 1
            total_batches = max(1, (len(pending) + batch_size - 1) // batch_size)
            file_name = Path(file_hint).name
            report_progress(
                self.reporter,
                "translate",
                {
                    "phase": "api",
                    "file": file_hint,
                    "batch": batch_number,
                    "batchTotal": total_batches,
                    "batchProgress": round(batch_number * 100 / total_batches),
                    "items": len(chunk),
                    "model": self.model,
                    "title": f"Đang dịch {file_name}",
                    "description": (
                        f"Batch {batch_number}/{total_batches} · "
                        f"{len(chunk)} mục · {self.model}"
                    ),
                },
                self._progress,
                force=batch_number in {1, total_batches},
            )
            translated = self._request_batch(chunk, style, file_hint)
            for item in chunk:
                value = translated[item["id"]]
                result[item["id"]] = value
                if value != item["text"]:
                    self._store_cached(item["text"], style, value)
            self.save_cache()
            start += len(chunk)
        return result


def _translate_xml(
    target_path: Path,
    english_path: Path | None,
    translator: GeminiTranslator,
) -> tuple[int, list[dict[str, Any]]]:
    if is_proper_name_file(target_path):
        translator.stats.items_skipped += 1
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
                "id": f"xml-{sequence}",
                "text": source.strip(),
                "tag": element.get("Tag"),
                "textElement": text_element,
                "current": current,
            }
        )
    if not pending:
        return 0, []
    translations = translator.translate_items(
        [{"id": item["id"], "text": item["text"]} for item in pending],
        detect_style(target_path),
        target_path.as_posix(),
    )
    changes: list[dict[str, Any]] = []
    for item in pending:
        translated = translations[item["id"]]
        if translated == item["current"]:
            continue
        changes.append(
            {
                "tag": item["tag"],
                "source": item["text"][:300],
                "target": translated[:300],
            }
        )
        if not translator.config.dry_run:
            item["textElement"].text = translated
    if changes and not translator.config.dry_run:
        write_xml_atomic(target_tree, target_path)
    return len(changes), changes


def _translate_vtt(
    target_path: Path,
    english_path: Path | None,
    translator: GeminiTranslator,
) -> tuple[int, list[dict[str, Any]]]:
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
                "id": f"vtt-{sequence}",
                "text": source.strip(),
                "timing": cue.timing,
                "block": cue,
                "current": cue.text,
            }
        )
    if not pending:
        return 0, []
    translations = translator.translate_items(
        [{"id": item["id"], "text": item["text"]} for item in pending],
        "lore",
        target_path.as_posix(),
    )
    changes: list[dict[str, Any]] = []
    for item in pending:
        translated = translations[item["id"]]
        if translated == item["current"]:
            continue
        changes.append(
            {
                "timing": item["timing"],
                "source": item["text"][:300],
                "target": translated[:300],
            }
        )
        if not translator.config.dry_run:
            block = item["block"]
            assert block.timing_index is not None
            block.lines = (
                block.lines[: block.timing_index + 1] + translated.splitlines()
            )
    if changes and not translator.config.dry_run:
        write_vtt_atomic(target_blocks, target_path)
    return len(changes), changes


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
    files_with_work = 0
    progress = ProgressThrottle()
    target_keys = sorted(target_files)
    for index, key in enumerate(target_keys, start=1):
        cancel.check()
        if config.max_files and files_with_work >= config.max_files:
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
                "title": f"File {index}/{len(target_keys)}",
                "description": relative.as_posix(),
            },
            progress,
            force=True,
        )
        try:
            if target_path.suffix.lower() == ".xml":
                changed, file_changes = _translate_xml(
                    target_path, english_path, translator
                )
            else:
                changed, file_changes = _translate_vtt(
                    target_path, english_path, translator
                )
            translator.stats.files_processed += 1
            if changed:
                files_with_work += 1
                translator.stats.files_changed += 1
                translator.stats.items_translated += changed
                changes.append({"file": relative.as_posix(), "items": file_changes})
        except QuotaExhaustedError as error:
            quota_error = str(error)
            break
        except (ET.ParseError, OSError, UnicodeError, ValueError) as error:
            translator.stats.errors.append(
                {"file": relative.as_posix(), "error": str(error)}
            )
    translator.save_cache()
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
    }
    reporter("result", "translate", result)
    return result
