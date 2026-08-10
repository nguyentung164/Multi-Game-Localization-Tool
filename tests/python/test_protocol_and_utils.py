from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from civ7_tool.cli import JsonlEmitter
from civ7_tool.language import (
    missing_tokens,
    needs_translation,
    protected_tokens,
    strip_game_tokens,
    text_similarity,
)
from civ7_tool.types import MAX_EVENT_LINE_BYTES

ROOT = Path(__file__).resolve().parents[2]


def _run_cli(command: str, request: dict) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "engine")
    return subprocess.run(
        [sys.executable, "-m", "civ7_tool", command],
        cwd=ROOT,
        env=environment,
        input=json.dumps(request, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=20,
        check=False,
    )


def test_cli_emits_only_utf8_jsonl_and_never_secrets() -> None:
    secret = "super-secret-api-key"
    process = _run_cli(
        "validate-state",
        {
            "protocolVersion": 1,
            "jobId": "job-123",
            "apiKeys": [secret],
            "config": {},
        },
    )

    assert process.returncode == 0
    assert process.stderr == ""
    assert secret not in process.stdout
    events = [json.loads(line) for line in process.stdout.splitlines()]
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert events[0]["type"] == "started"
    assert events[-1]["type"] == "completed"
    assert all(
        set(event)
        == {
            "protocolVersion",
            "jobId",
            "seq",
            "type",
            "step",
            "timestamp",
            "payload",
        }
        for event in events
    )
    result = next(event for event in events if event["type"] == "result")
    assert result["payload"]["checks"][-1]["configured"] == 1


def test_cli_bootstrap_error_uses_stderr_only() -> None:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "engine")
    process = subprocess.run(
        [sys.executable, "-m", "civ7_tool", "inspect"],
        cwd=ROOT,
        env=environment,
        input="{not-json",
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert process.returncode == 2
    assert process.stdout == ""
    assert "bootstrap-error" in process.stderr


def test_jsonl_emitter_spills_oversized_result(tmp_path: Path, capsys) -> None:
    emitter = JsonlEmitter("job-spill", [], artifact_dir=tmp_path)
    huge_text = "x" * (MAX_EVENT_LINE_BYTES + 10_000)
    emitter.emit(
        "result",
        "sync-preview",
        {
            "fingerprint": "fp-1",
            "summary": {"add": 1, "update": 0, "delete": 0, "unchanged": 0},
            "actions": [
                {
                    "operation": "add",
                    "path": "demo.xml",
                    "items": [{"type": "Row", "tag": "TAG", "text": huge_text}],
                }
            ],
            "errors": [],
        },
    )
    captured = capsys.readouterr()
    events = [json.loads(line) for line in captured.out.splitlines()]
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["spilled"] is True
    assert payload["fingerprint"] == "fp-1"
    assert payload["actionCount"] == 1
    spilled = Path(payload["resultPath"])
    assert spilled.is_file()
    assert spilled.stat().st_size > MAX_EVENT_LINE_BYTES
    assert len(captured.out.encode("utf-8")) <= MAX_EVENT_LINE_BYTES + 256


def test_token_plural_and_translation_detection() -> None:
    source = "Gain {amount} [ICON:GOLD] in {turns: plural 1?Turn; other?Turns;}"
    translated = "Nhận {amount} [ICON:GOLD] trong {turns: plural 1?Lượt; other?Lượt;}"

    assert protected_tokens(source) == [
        "{turns: plural 1?Turn; other?Turns;}",
        "{amount}",
        "[ICON:GOLD]",
    ]
    assert missing_tokens(source, translated) == []
    assert missing_tokens(source, "Nhận Vàng") == protected_tokens(source)
    assert needs_translation("Hello", "Hello") is True
    assert needs_translation("Xin chào", "Hello") is False
    assert needs_translation("Hello {amount}", "Hello {amount}") is True
    assert needs_translation("{amount}", "Hello {amount}") is False
    assert needs_translation("Gain 100 [ICON:GOLD]", "Gain {amount} [ICON:GOLD]") is False
    assert needs_translation(
        "This is a long English sentence that should be detected as untranslated.",
        "This is a long English sentence that should be detected as untranslated.",
    ) is True
    assert needs_translation(
        "Đây là một câu tiếng Việt đủ dài để kiểm tra phát hiện ngôn ngữ.",
        "This is a long English sentence that should be detected as untranslated.",
    ) is False
    assert needs_translation(
        "Select a Commander để tiếp tục",
        "Select a Commander to continue.",
    ) is True
    assert needs_translation("Hi", "Hello") is False
    assert strip_game_tokens("Gain {amount} [ICON:GOLD]") == "Gain"
    assert text_similarity("Hello world", "Hello world") == 1.0
