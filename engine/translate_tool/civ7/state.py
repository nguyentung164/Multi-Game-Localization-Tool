from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from ..common.formats import collect_files
from ..common.translation_core import validate_gemini_api_key
from ..common.types import Reporter, null_reporter


def validate_state(
    config: Mapping[str, Any],
    *,
    api_keys: Sequence[str] = (),
    reporter: Reporter = null_reporter,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check_directory(name: str, *, writable: bool = False) -> None:
        value = config.get(name)
        if not value:
            return
        path = Path(str(value)).expanduser().resolve()
        exists = path.is_dir()
        item: dict[str, Any] = {
            "name": name,
            "path": str(path),
            "ok": exists,
            "exists": exists,
        }
        if exists:
            try:
                item["files"] = len(collect_files(path))
            except Exception as error:  # noqa: BLE001 - report every unreadable input.
                item["ok"] = False
                item["error"] = str(error)
            if writable:
                item["writable"] = os.access(path, os.W_OK)
                item["ok"] = item["ok"] and item["writable"]
        checks.append(item)

    check_directory("gameDir")
    check_directory("englishDir")
    check_directory("targetDir", writable=True)
    check_directory("backupDir", writable=True)

    glossary = config.get("glossaryPath")
    if glossary:
        path = Path(str(glossary)).expanduser().resolve()
        item: dict[str, Any] = {
            "name": "glossaryPath",
            "path": str(path),
            "ok": path.is_file(),
        }
        if path.is_file():
            try:
                item["ok"] = isinstance(
                    json.loads(path.read_text(encoding="utf-8")), dict
                )
                if not item["ok"]:
                    item["error"] = "Glossary phải là JSON object"
            except (OSError, json.JSONDecodeError) as error:
                item["ok"] = False
                item["error"] = str(error)
        checks.append(item)

    if api_keys:
        for index, key in enumerate(api_keys):
            item: dict[str, Any] = {
                "name": f"geminiApiKey[{index}]",
                "ok": validate_gemini_api_key(key),
            }
            if not item["ok"]:
                item["error"] = "Gemini từ chối API key này"
            checks.append(item)
    else:
        checks.append(
            {
                "name": "geminiApiKeys",
                "ok": False,
                "configured": 0,
                "error": "Chưa cấu hình API key",
            }
        )
    result = {
        "valid": all(item["ok"] for item in checks),
        "checks": checks,
    }
    reporter("result", "validate-state", result)
    return result
