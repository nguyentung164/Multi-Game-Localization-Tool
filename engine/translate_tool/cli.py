from __future__ import annotations

import json
import math
import multiprocessing
import signal
import sys
import tempfile
import threading
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .civ7.deploy import deploy_to_game
from .civ7.editor import list_localization, replace_localization_vietnamese, update_localization_entry
from .civ7.inventory import export_game_files, inspect_localization
from .civ7.qa import run_qa
from .civ7.search import search_localization
from .civ7.state import validate_state
from .civ7.sync import apply_sync, preview_sync, restore_backup
from .civ7.translate import DEFAULT_MODELS, TranslationConfig, translate_localization
from .common.paths import EVENTS_DIR_NAME, backup_dir, tool_cache_path, tool_dir
from .common.translation_core import translation_glossary_hash
from .common.types import (
    MAX_EVENT_LINE_BYTES,
    PROTOCOL_VERSION,
    CancellationToken,
    CancelledError,
    EngineError,
    RestoreFingerprintConflict,
    ValidationError,
)
from .legend.pipeline import (
    apply_legend,
    estimate_legend,
    inspect_legend,
    list_legend_entries,
    rebuild_legend_preview,
    restore_legend_backup,
    retranslate_legend_preview,
    sync_legend_staged,
    translate_legend,
)

# Giữ biên an toàn cho envelope JSONL (jobId, timestamp, …).
_EVENT_LINE_SOFT_LIMIT = MAX_EVENT_LINE_BYTES - 8_192
_SMALL_RESULT_KEYS = (
    "fingerprint",
    "summary",
    "source",
    "target",
    "status",
    "stats",
    "quotaExhausted",
    "filesCopied",
    "qa",
    "previewId",
    "previewPath",
    "stagedPath",
    "backup",
    "manifest",
)

COMMANDS = {
    "export",
    "inspect",
    "sync-preview",
    "sync-apply",
    "translate",
    "deploy-preview",
    "deploy-apply",
    "qa",
    "validate-state",
    "restore",
    "search-tags",
    "list-tags",
    "update-tag",
    "replace-tags",
    "legend-inspect",
    "legend-list-entries",
    "legend-translate",
    "legend-estimate",
    "legend-rebuild",
    "legend-retranslate",
    "legend-apply",
    "legend-sync-staged",
    "legend-restore",
}

EVENT_STEPS = {
    "legend-inspect": "inspect",
    "legend-list-entries": "inspect",
    "legend-translate": "translate",
    "legend-estimate": "translate",
    "legend-rebuild": "translate",
    "legend-retranslate": "translate",
    "legend-apply": "sync-apply",
    "legend-sync-staged": "inspect",
    "legend-restore": "restore",
}


class JsonlEmitter:
    def __init__(
        self,
        job_id: str,
        secrets: list[str],
        artifact_dir: Path | None = None,
    ) -> None:
        self.job_id = job_id
        self.secrets = [secret for secret in secrets if secret]
        self.artifact_dir = artifact_dir
        self.sequence = 0
        self.lock = threading.Lock()

    def _sanitize_text(self, value: str) -> str:
        result = value
        for secret in self.secrets:
            result = result.replace(secret, "***")
        return result

    def _sanitize(self, value: Any) -> Any:
        if isinstance(value, str):
            return self._sanitize_text(value)
        if isinstance(value, Mapping):
            return {str(key): self._sanitize(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._sanitize(item) for item in value]
        return value

    def _artifact_root(self) -> Path:
        if self.artifact_dir is not None:
            return self.artifact_dir
        return Path(tempfile.gettempdir()) / EVENTS_DIR_NAME

    def _spill_result_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        root = self._artifact_root()
        root.mkdir(parents=True, exist_ok=True)
        path = root / f"{self.job_id}-result-{self.sequence}.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        compact: dict[str, Any] = {
            "spilled": True,
            "resultPath": str(path.resolve()),
        }
        for key in _SMALL_RESULT_KEYS:
            if key in payload:
                compact[key] = payload[key]
        errors = payload.get("errors")
        if isinstance(errors, list):
            compact["errors"] = errors[:50]
            compact["errorCount"] = len(errors)
        elif errors is not None:
            compact["errors"] = errors
        actions = payload.get("actions")
        if isinstance(actions, list):
            compact["actionCount"] = len(actions)
        changes = payload.get("changes")
        if isinstance(changes, list):
            compact["changeCount"] = len(changes)
        return compact

    def emit(self, event_type: str, step: str, payload: Mapping[str, Any]) -> None:
        with self.lock:
            self.sequence += 1
            sanitized = self._sanitize(dict(payload))
            envelope = {
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": self.job_id,
                "seq": self.sequence,
                "type": event_type,
                "step": step,
                "timestamp": datetime.now(timezone.utc)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
                "payload": sanitized,
            }
            line = json.dumps(envelope, ensure_ascii=False)
            if len(line.encode("utf-8")) > _EVENT_LINE_SOFT_LIMIT:
                if event_type != "result":
                    raise EngineError(
                        f"Engine event '{event_type}' vượt quá giới hạn JSONL "
                        f"({MAX_EVENT_LINE_BYTES} bytes)"
                    )
                envelope["payload"] = self._spill_result_payload(sanitized)
                line = json.dumps(envelope, ensure_ascii=False)
                if len(line.encode("utf-8")) > MAX_EVENT_LINE_BYTES:
                    envelope["payload"] = {
                        "spilled": True,
                        "resultPath": envelope["payload"].get("resultPath"),
                        "message": "Payload kết quả quá lớn; đã ghi ra file",
                    }
                    line = json.dumps(envelope, ensure_ascii=False)
            sys.stdout.write(line + "\n")
            sys.stdout.flush()


def _configure_streams() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="strict")


def _path(
    config: Mapping[str, Any], name: str, *, required: bool = True
) -> Path | None:
    value = config.get(name)
    if value in (None, ""):
        if required:
            raise ValidationError(f"Thiếu config.{name}")
        return None
    return Path(str(value)).expanduser()


def _api_keys(request: Mapping[str, Any], config: Mapping[str, Any]) -> list[str]:
    candidates = request.get("apiKeys")
    if candidates is None and isinstance(request.get("secrets"), Mapping):
        candidates = request["secrets"].get("geminiApiKeys")  # type: ignore[index]
    if candidates is None:
        candidates = config.get("apiKeys", [])
    if isinstance(candidates, str):
        candidates = [candidates]
    if not isinstance(candidates, list):
        raise ValidationError("apiKeys phải là mảng chuỗi")
    result: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, str):
            raise ValidationError("apiKeys phải là mảng chuỗi")
        key = candidate.strip()
        if key and key not in result:
            result.append(key)
    return result


def _normalize_glossary(data: Any) -> tuple[dict[str, str], dict[str, str]]:
    if not isinstance(data, Mapping):
        raise ValidationError("Glossary phải là JSON object")
    entries = data.get("entries")
    if isinstance(entries, list):
        glossary: dict[str, str] = {}
        locked: dict[str, str] = {}
        for row in entries:
            if not isinstance(row, Mapping):
                raise ValidationError("Glossary entries phải là mảng object")
            source = str(row.get("source", "")).strip()
            target = str(row.get("target", "")).strip()
            if not source or not target:
                raise ValidationError("Glossary source/target không được rỗng")
            glossary[source] = target
            if bool(row.get("locked", False)):
                locked[source] = target
        return glossary, locked
    ignored = {"version", "profileId"}
    return (
        {
            str(key): str(value)
            for key, value in data.items()
            if key not in ignored and isinstance(value, str)
        },
        {},
    )


def _load_glossary_document(
    config: Mapping[str, Any],
) -> tuple[dict[str, str], dict[str, str]]:
    inline = config.get("glossary")
    if inline is not None:
        return _normalize_glossary(inline)
    path = _path(config, "glossaryPath", required=False)
    if path is None:
        return {}, {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"Không đọc được glossary: {error}") from error
    return _normalize_glossary(data)


def _load_glossary(config: Mapping[str, Any]) -> Mapping[str, str]:
    glossary, _locked = _load_glossary_document(config)
    return glossary


def _models(config: Mapping[str, Any]) -> tuple[str, ...]:
    configured = config.get("models")
    if configured is None:
        primary = config.get("model")
        fallbacks = config.get("fallbackModels", [])
        configured = ([primary] if primary else []) + (
            fallbacks if isinstance(fallbacks, list) else []
        )
    if not configured:
        return DEFAULT_MODELS
    if not isinstance(configured, list) or not all(
        isinstance(model, str) and model.strip() for model in configured
    ):
        raise ValidationError("config.models phải là mảng model")
    return tuple(dict.fromkeys(model.strip() for model in configured))


def _int_config(
    config: Mapping[str, Any], name: str, default: int, minimum: int = 0
) -> int:
    value = config.get(name, default)
    if isinstance(value, bool) or (isinstance(value, float) and not value.is_integer()):
        raise ValidationError(f"config.{name} phải là số nguyên")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValidationError(f"config.{name} phải là số nguyên") from error
    if not math.isfinite(parsed) or parsed < minimum:
        raise ValidationError(f"config.{name} phải >= {minimum}")
    return parsed


def _float_config(
    config: Mapping[str, Any], name: str, default: float, minimum: float = 0
) -> float:
    value = config.get(name, default)
    if isinstance(value, bool):
        raise ValidationError(f"config.{name} phải là số")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ValidationError(f"config.{name} phải là số") from error
    if not math.isfinite(parsed) or parsed < minimum:
        raise ValidationError(f"config.{name} phải >= {minimum}")
    return parsed


def _bool_config(config: Mapping[str, Any], name: str, default: bool = False) -> bool:
    value = config.get(name, default)
    if not isinstance(value, bool):
        raise ValidationError(f"config.{name} phải là boolean")
    return value


def _dispatch(
    command: str,
    request: Mapping[str, Any],
    config: Mapping[str, Any],
    keys: list[str],
    emitter: JsonlEmitter,
    cancel: CancellationToken,
) -> dict[str, Any]:
    reporter = emitter.emit
    if command == "legend-inspect":
        return inspect_legend(
            _path(config, "sourcePath"),  # type: ignore[arg-type]
            sample_size=_int_config(config, "sampleSize", 20),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-list-entries":
        return list_legend_entries(
            _path(config, "sourcePath"),  # type: ignore[arg-type]
            offset=_int_config(config, "offset", 0, minimum=0),
            limit=_int_config(config, "limit", 100, minimum=1),
            kind=str(config.get("kind", "entry")),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-translate":
        source = _path(config, "sourcePath")
        assert source is not None
        cache_path = _path(config, "cachePath", required=False)
        if cache_path is None:
            cache_path = tool_cache_path(
                source.parent, "legend-translation-cache.json", for_write=True
            )
        glossary, locked_glossary = _load_glossary_document(config)
        translation_config = TranslationConfig(
            api_keys=tuple(keys),
            models=_models(config),
            glossary=glossary,
            locked_glossary=locked_glossary,
            cache_path=cache_path,
            batch_size=_int_config(config, "batchSize", 40, minimum=1),
            gemma_batch_size=_int_config(config, "gemmaBatchSize", 15, minimum=1),
            max_retries=_int_config(config, "maxRetries", 6, minimum=1),
            delay_seconds=_float_config(config, "delaySeconds", 0.5),
            timeout_seconds=_float_config(config, "timeoutSeconds", 180, minimum=1),
            max_api_calls=_int_config(config, "maxApiCalls", 0),
        )
        return translate_legend(
            source,
            _path(config, "previewPath"),  # type: ignore[arg-type]
            translation_config,
            mode=str(config.get("mode", "full")),
            trial_limit=_int_config(config, "trialLimit", 30, minimum=1),
            force_retranslate=bool(config.get("forceRetranslate", False)),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-estimate":
        keys = _api_keys(request, config)
        glossary, locked_glossary = _load_glossary_document(config)
        translation_config = TranslationConfig(
            api_keys=tuple(keys),
            models=_models(config),
            glossary=glossary,
            locked_glossary=locked_glossary,
            cache_path=_path(config, "cachePath") or Path("legend-cache.json"),
            batch_size=_int_config(config, "batchSize", 40, minimum=1),
            delay_seconds=0,
            timeout_seconds=_float_config(
                config, "timeoutSeconds", 180.0, minimum=1.0
            ),
        )
        return estimate_legend(
            _path(config, "sourcePath"),  # type: ignore[arg-type]
            translation_config,
            mode=str(config.get("mode", "full")),
            trial_limit=_int_config(config, "trialLimit", 30, minimum=1),
            force_retranslate=bool(config.get("forceRetranslate", False)),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-rebuild":
        glossary, locked_glossary = _load_glossary_document(config)
        return rebuild_legend_preview(
            _path(config, "previewPath"),  # type: ignore[arg-type]
            edits=config.get("edits", []),
            expected_preview_id=str(config.get("previewId", "")),
            glossary=glossary,
            locked_glossary=locked_glossary,
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-retranslate":
        cache_path = _path(config, "cachePath", required=False)
        if cache_path is None:
            cache_path = Path("legend-cache.json")
        glossary, locked_glossary = _load_glossary_document(config)
        translation_config = TranslationConfig(
            api_keys=tuple(keys),
            models=_models(config),
            glossary=glossary,
            locked_glossary=locked_glossary,
            cache_path=cache_path,
            batch_size=_int_config(config, "batchSize", 40, minimum=1),
            gemma_batch_size=_int_config(config, "gemmaBatchSize", 15, minimum=1),
            max_retries=_int_config(config, "maxRetries", 6, minimum=1),
            delay_seconds=_float_config(config, "delaySeconds", 0.5),
            timeout_seconds=_float_config(config, "timeoutSeconds", 180, minimum=1),
            max_api_calls=_int_config(config, "maxApiCalls", 0),
        )
        return retranslate_legend_preview(
            _path(config, "previewPath"),  # type: ignore[arg-type]
            translation_config,
            expected_preview_id=str(config.get("previewId", "")),
            line_numbers=config.get("lineNumbers"),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-sync-staged":
        preview_id = config.get("previewId")
        if preview_id is not None and not isinstance(preview_id, str):
            raise ValidationError("config.previewId phải là chuỗi")
        return sync_legend_staged(
            _path(config, "previewPath"),  # type: ignore[arg-type]
            expected_preview_id=preview_id,
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-apply":
        preview_id = config.get("previewId")
        if preview_id is not None and not isinstance(preview_id, str):
            raise ValidationError("config.previewId phải là chuỗi")
        glossary, locked_glossary = _load_glossary_document(config)
        deploy_path = _path(config, "deployPath") if config.get("deployPath") else None
        return apply_legend(
            _path(config, "sourcePath"),  # type: ignore[arg-type]
            _path(config, "previewPath"),  # type: ignore[arg-type]
            _path(config, "backupDir"),  # type: ignore[arg-type]
            deploy_path=deploy_path,
            expected_preview_id=preview_id,
            current_glossary_hash=translation_glossary_hash(
                glossary, locked_glossary
            ),
            glossary=glossary,
            reporter=reporter,
            cancel=cancel,
        )
    if command == "legend-restore":
        return restore_legend_backup(
            _path(config, "backupPath"),  # type: ignore[arg-type]
            expected_source_path=_path(config, "expectedSourcePath"),  # type: ignore[arg-type]
            force=_bool_config(config, "force", False),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "export":
        return export_game_files(
            _path(config, "gameDir"),  # type: ignore[arg-type]
            _path(config, "stagingDir"),  # type: ignore[arg-type]
            reporter=reporter,
            cancel=cancel,
        )
    if command == "inspect":
        return inspect_localization(
            _path(config, "englishDir"),  # type: ignore[arg-type]
            _path(config, "targetDir", required=False),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "sync-preview":
        return preview_sync(
            _path(config, "englishDir"),  # type: ignore[arg-type]
            _path(config, "targetDir"),  # type: ignore[arg-type]
            reporter=reporter,
            cancel=cancel,
        ).to_dict()
    if command == "sync-apply":
        target = _path(config, "targetDir")
        backup_root = _path(config, "backupDir", required=False)
        if backup_root is None:
            assert target is not None
            backup_root = backup_dir(target.parent, for_write=True)
        return apply_sync(
            _path(config, "englishDir"),  # type: ignore[arg-type]
            target,  # type: ignore[arg-type]
            str(config.get("fingerprint", "")),
            backup_root,
            reporter=reporter,
            cancel=cancel,
        )
    if command == "restore":
        return restore_backup(
            _path(config, "backupPath"),  # type: ignore[arg-type]
            _path(config, "targetDir", required=False),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "qa":
        return run_qa(
            _path(config, "targetDir"),  # type: ignore[arg-type]
            _path(config, "englishDir", required=False),
            max_issues=_int_config(config, "maxIssues", 10_000),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "search-tags":
        query = str(config.get("query", "")).strip()
        scope = str(config.get("scope", "all")).strip() or "all"
        max_results = _int_config(config, "maxResults", 500, minimum=1)
        return search_localization(
            _path(config, "englishDir", required=False),
            _path(config, "targetDir", required=False),
            query,
            scope=scope,
            max_results=max_results,
            case_sensitive=_bool_config(config, "caseSensitive", False),
            whole_word=_bool_config(config, "wholeWord", False),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "list-tags":
        configured = config.get("maxResults")
        if configured is None:
            max_results = 0
        else:
            max_results = _int_config(config, "maxResults", 0, minimum=0)
        return list_localization(
            _path(config, "englishDir", required=False),
            _path(config, "targetDir", required=False),
            max_results=max_results,
            reporter=reporter,
            cancel=cancel,
        )
    if command == "update-tag":
        target = _path(config, "targetDir")
        assert target is not None
        file = str(config.get("file", "")).strip()
        tag = str(config.get("tag", "")).strip()
        entry_type = str(config.get("entryType", "")).strip()
        vietnamese = str(config.get("vietnamese", ""))
        timing = config.get("timing")
        timing_value = str(timing).strip() if timing is not None else None
        if not file:
            raise ValidationError("Thiếu file")
        if not entry_type:
            raise ValidationError("Thiếu entryType")
        return update_localization_entry(
            target,
            file=file,
            tag=tag,
            entry_type=entry_type,
            vietnamese=vietnamese,
            timing=timing_value or None,
            reporter=reporter,
        )
    if command == "replace-tags":
        target = _path(config, "targetDir")
        assert target is not None
        query = str(config.get("query", "")).strip()
        replacement = str(config.get("replacement", ""))
        return replace_localization_vietnamese(
            _path(config, "englishDir", required=False),
            target,
            query,
            replacement,
            case_sensitive=_bool_config(config, "caseSensitive", False),
            whole_word=_bool_config(config, "wholeWord", False),
            reporter=reporter,
            cancel=cancel,
        )
    if command == "validate-state":
        return validate_state(config, key_count=len(keys), reporter=reporter)
    if command == "translate":
        target = _path(config, "targetDir")
        assert target is not None
        cache_path = _path(config, "cachePath", required=False)
        if cache_path is None:
            cache_path = tool_cache_path(
                target.parent, "translation-cache.json", for_write=True
            )
        translation_config = TranslationConfig(
            api_keys=tuple(keys),
            models=_models(config),
            glossary=_load_glossary(config),
            cache_path=cache_path,
            batch_size=_int_config(config, "batchSize", 40, minimum=1),
            gemma_batch_size=_int_config(config, "gemmaBatchSize", 15, minimum=1),
            max_retries=_int_config(config, "maxRetries", 6, minimum=1),
            delay_seconds=_float_config(config, "delaySeconds", 0.5),
            timeout_seconds=_float_config(config, "timeoutSeconds", 180, minimum=1),
            max_api_calls=_int_config(config, "maxApiCalls", 0),
            max_files=_int_config(config, "maxFiles", 0),
            dry_run=_bool_config(config, "dryRun"),
        )
        return translate_localization(
            _path(config, "englishDir"),  # type: ignore[arg-type]
            target,
            translation_config,
            reporter=reporter,
            cancel=cancel,
        )
    if command in {"deploy-preview", "deploy-apply"}:
        dry_run = command == "deploy-preview"
        backup_root = _path(config, "backupDir", required=False)
        if not dry_run and backup_root is None:
            mod = _path(config, "targetDir")
            assert mod is not None
            backup_root = backup_dir(mod.parent, deploy=True, for_write=True)
        return deploy_to_game(
            _path(config, "targetDir"),  # type: ignore[arg-type]
            _path(config, "gameDir"),  # type: ignore[arg-type]
            backup_root=backup_root,
            dry_run=dry_run,
            backup=_bool_config(config, "deployBackup", True) and not dry_run,
            only_existing=_bool_config(config, "onlyExisting", False),
            reporter=reporter,
            cancel=cancel,
        )
    raise ValidationError(f"Command không được hỗ trợ: {command}")


def _bootstrap_request() -> dict[str, Any]:
    try:
        request = json.load(sys.stdin)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"JSON request stdin không hợp lệ: {error}") from error
    if not isinstance(request, dict):
        raise ValidationError("JSON request phải là object")
    return request


def main(argv: list[str] | None = None) -> int:
    multiprocessing.freeze_support()
    _configure_streams()
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        request = _bootstrap_request()
    except RestoreFingerprintConflict as error:
        emitter.emit(
            "error",
            event_step,
            {"message": str(error), "code": "FINGERPRINT_CONFLICT"},
        )
        emitter.emit("completed", event_step, {"status": "failed"})
        return 2
    except ValidationError as error:
        sys.stderr.write(f"bootstrap-error: {error}\n")
        return 2

    command = argv[0] if argv else request.get("command")
    event_step = EVENT_STEPS.get(str(command), str(command or "bootstrap"))
    job_id = request.get("jobId")
    if not isinstance(job_id, str) or not job_id.strip():
        sys.stderr.write("bootstrap-error: thiếu jobId\n")
        return 2
    raw_config = request.get("config", {})
    config = raw_config if isinstance(raw_config, dict) else {}
    artifact_dir: Path | None = None
    staging = config.get("stagingDir")
    if isinstance(staging, str) and staging.strip():
        artifact_dir = (
            tool_dir(Path(staging).expanduser(), for_write=True) / "engine-events"
        )
    try:
        keys = _api_keys(request, config)
    except ValidationError as error:
        keys = []
        emitter = JsonlEmitter(job_id, [], artifact_dir=artifact_dir)
        emitter.emit(
            "error",
            event_step,
            {"message": str(error), "code": "INVALID_REQUEST"},
        )
        return 2
    emitter = JsonlEmitter(job_id, keys, artifact_dir=artifact_dir)
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        emitter.emit(
            "error",
            event_step,
            {
                "message": f"protocolVersion phải là {PROTOCOL_VERSION}",
                "code": "UNSUPPORTED_PROTOCOL",
            },
        )
        return 2
    if not isinstance(raw_config, dict):
        emitter.emit(
            "error",
            event_step,
            {"message": "config phải là object", "code": "INVALID_REQUEST"},
        )
        return 2
    if command not in COMMANDS or len(argv) > 1:
        emitter.emit(
            "error",
            event_step,
            {"message": "Command không hợp lệ", "code": "INVALID_COMMAND"},
        )
        return 2

    cancel = CancellationToken()

    def cancel_handler(_signum: int, _frame: Any) -> None:
        cancel.cancel()

    signal.signal(signal.SIGINT, cancel_handler)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, cancel_handler)

    emitter.emit("started", event_step, {"command": command})
    try:
        result = _dispatch(command, request, config, keys, emitter, cancel)
        failed = bool(
            command == "translate"
            and (
                result.get("stats", {}).get("errors")
                or result.get("quotaExhausted")
                or not result.get("qa", {}).get("passed", False)
            )
            or command in {"sync-preview", "deploy-preview", "deploy-apply"}
            and (
                result.get("errors")
                or (
                    isinstance(result.get("summary"), dict)
                    and result.get("summary", {}).get("errors")
                )
            )
        )
        emitter.emit(
            "completed",
            event_step,
            {"status": "partial" if failed else "success"},
        )
        return 1 if failed else 0
    except CancelledError as error:
        emitter.emit("error", event_step, {"message": str(error), "code": "CANCELLED"})
        emitter.emit("completed", event_step, {"status": "cancelled"})
        return 130
    except ValidationError as error:
        emitter.emit(
            "error", event_step, {"message": str(error), "code": "VALIDATION_ERROR"}
        )
        emitter.emit("completed", event_step, {"status": "failed"})
        return 2
    except EngineError as error:
        emitter.emit(
            "error", event_step, {"message": str(error), "code": "OPERATION_FAILED"}
        )
        emitter.emit("completed", event_step, {"status": "failed"})
        return 1
    except Exception as error:  # noqa: BLE001 - CLI boundary must emit structured errors.
        emitter.emit(
            "error",
            event_step,
            {"message": str(error), "code": "INTERNAL_ERROR"},
        )
        emitter.emit("completed", event_step, {"status": "failed"})
        return 1
