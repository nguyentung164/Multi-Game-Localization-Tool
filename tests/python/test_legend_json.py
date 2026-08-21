from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3
from pathlib import Path

import pytest

from translate_tool import cli
from translate_tool.common.translation_core import TranslationConfig
from translate_tool.common.types import (
    CancelledError,
    QuotaExhaustedError,
    ValidationError,
)
from translate_tool.legend_json import pipeline as legend_json_pipeline
from translate_tool.legend_json.pipeline import (
    UTF8_BOM,
    _qa_translation,
    apply_pipeline,
    estimate_pipeline,
    extract_record,
    iter_root_array,
    list_backups,
    list_pipeline_entries,
    preview_pipeline,
    restore_pipeline,
    scan_pipeline,
    set_pipeline_rule,
    translate_pipeline,
)


def _write_json(path: Path, records: list[object]) -> None:
    path.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_streaming_root_array_accepts_raw_control_characters(tmp_path: Path) -> None:
    source = tmp_path / "raw.json"
    raw = '[{"id":1,"dialog":"第一行\n第二行\x01"},{"id":2,"name":"英雄"}]'
    source.write_bytes(raw.encode())

    rows = list(iter_root_array(source, chunk_size=7))

    assert rows == [
        (0, {"id": 1, "dialog": "第一行\n第二行\x01"}),
        (1, {"id": 2, "name": "英雄"}),
    ]


def test_extract_record_uses_allowlist_exclusions_and_composite_segments() -> None:
    occurrences = extract_record(
        {
            "id": 7,
            "dialog": "你好",
            "condition1": "人物等级大于十",
            "option": "&签订契约&&1981408&&&#&解除契约&&1980408&&",
            "unknown": "需要人工判断",
            "phaseEffectStr2": "精力增加",
        },
        file_name="Event.json",
        record_index=3,
    )

    by_source = {item.source: item for item in occurrences}
    assert by_source["你好"].classification == "allow"
    assert by_source["人物等级大于十"].classification == "exclude"
    assert by_source["需要人工判断"].classification == "classify"
    assert by_source["签订契约"].extractor == "composite:option"
    assert by_source["解除契约"].extractor == "composite:option"
    assert by_source["精力增加"].extractor == "composite:phaseEffectStr2"
    assert all(item.record_id == "7" for item in occurrences)


def test_composite_parsers_extract_only_display_text() -> None:
    occurrences = extract_record(
        {
            "box": (
                "0.1/0.2/0.3/0.4/第一段说明////;"
                "0.5/0.6/0.7/0.8/第二段说明/分类标题///"
            ),
            "option": (
                "0/玩家资金/>=/5000/0/&直接出钱（5000）&10041102&&&&&&#"
                "&发起舌战&10041002&&&&&&"
            ),
            "aryEffectStr": "精力+200@@@@@&房事中使用可提高效果@@@@@",
            "specialNI": "WJ10011/WJ10012/二弟@@@@@;WJ10011/WJ10013/三弟@@@@@;",
            "specialWO": "WJ10002/俺@@@@@;WJ10012/关某@@@@@;",
            "zuncheng": "WJ10001/曹将军/29/37@@@@@;WJ10001/曹公/38/999@@@@@;",
        },
        file_name="Composite.json",
        record_index=0,
    )

    sources = {item.source for item in occurrences}
    assert {
        "第一段说明",
        "第二段说明",
        "分类标题",
        "直接出钱（5000）",
        "发起舌战",
        "精力+200",
        "房事中使用可提高效果",
        "二弟",
        "三弟",
        "俺",
        "关某",
        "曹将军",
        "曹公",
    } <= sources
    assert not any("WJ100" in source or "0.1/0.2" in source for source in sources)


def test_unknown_composite_format_requires_classification() -> None:
    raw = "WJ10001/无法判断/额外中文/29/37@@@@@;"
    occurrences = extract_record(
        {"zuncheng": raw}, file_name="Composite.json", record_index=0
    )

    assert len(occurrences) == 1
    assert occurrences[0].source == raw
    assert occurrences[0].classification == "classify"
    assert occurrences[0].extractor == "composite-unrecognized"


def test_allow_rule_keeps_specialized_composite_parser(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    raw = "&接受任务&10000600&&&&&&#&拒绝任务&10000700&&&&&&"
    _write_json(source_root / "Event.json", [{"option": raw}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)

    set_pipeline_rule(
        db_path, file_pattern="Event.json", field="option", action="allow"
    )
    _write_json(source_root / "Event.json", [{"id": 1, "option": raw}])
    scan_pipeline(source_root, db_path)

    sources = {
        item["source"] for item in list_pipeline_entries(db_path, status="New")["items"]
    }
    assert sources == {"接受任务", "拒绝任务"}
    assert raw not in sources


def test_incremental_scan_reuses_unchanged_files_and_marks_orphan(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    source = source_root / "Dialog.json"
    db_path = tmp_path / "pipeline.sqlite3"
    _write_json(source, [{"id": 1, "dialog": "你好"}])

    first = scan_pipeline(source_root, db_path)
    second = scan_pipeline(source_root, db_path)
    _write_json(source, [{"id": 2, "dialog": "再见"}])
    third = scan_pipeline(source_root, db_path)

    assert first["parsedFiles"] == 1
    assert second["parsedFiles"] == 0
    assert second["reusedFiles"] == 1
    assert third["parsedFiles"] == 1
    orphaned = list_pipeline_entries(db_path, status="Orphan")
    assert [row["source"] for row in orphaned["items"]] == ["你好"]


def test_unchanged_scan_does_not_rehash_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Dialog.json", [{"dialog": "你好"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)

    def unexpected_hash(_path: Path) -> str:
        raise AssertionError("File không đổi không được hash lại")

    monkeypatch.setattr(legend_json_pipeline, "file_sha256", unexpected_hash)
    result = scan_pipeline(source_root, db_path)

    assert result["parsedFiles"] == 0
    assert result["reusedFiles"] == 1


def test_readded_file_with_same_metadata_is_hashed_before_reuse(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    source = source_root / "Dialog.json"
    keeper = source_root / "Keep.json"
    db_path = tmp_path / "pipeline.sqlite3"
    _write_json(source, [{"dialog": "你好"}])
    _write_json(keeper, [{"id": 1}])
    original_stat = source.stat()
    scan_pipeline(source_root, db_path)

    source.unlink()
    scan_pipeline(source_root, db_path)
    _write_json(source, [{"dialog": "您好"}])
    assert source.stat().st_size == original_stat.st_size
    os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    result = scan_pipeline(source_root, db_path)

    assert result["parsedFiles"] == 1
    assert [
        item["source"] for item in list_pipeline_entries(db_path, status="New")["items"]
    ] == ["您好"]


def test_rule_and_manual_translation_are_persistent(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "People.json", [{"id": 1, "unknown": "刘备"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)
    item = list_pipeline_entries(db_path, status="Needs classification")["items"][0]

    set_pipeline_rule(db_path, file_pattern="People.json", field="unknown", action="allow")
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Lưu Bị",
        accepted=True,
    )
    scan_pipeline(source_root, db_path)

    translated = list_pipeline_entries(db_path, status="Translated")["items"]
    assert translated[0]["target"] == "Lưu Bị"
    assert translated[0]["translationSource"] == "manual"


def test_excluding_accepted_new_text_prevents_append(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    main_path.write_bytes(b"")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Bản dịch",
        accepted=True,
    )
    set_pipeline_rule(db_path, source_hash=item["sourceHash"], action="exclude")

    excluded = list_pipeline_entries(db_path, status="Excluded")
    assert excluded["total"] == 1
    assert excluded["items"][0]["target"] == "Bản dịch"
    assert excluded["items"][0]["accepted"] is True
    preview = preview_pipeline(db_path, source_root, main_path)
    assert preview["changeCount"] == 0


def test_manual_translation_overrides_main_after_rescan_and_apply(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "People.json", [{"name": "刘备"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    main_path.write_text("刘备=Bản cũ\n", encoding="utf-8")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    item = list_pipeline_entries(db_path, status="Translated")["items"][0]
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Lưu Bị",
        accepted=True,
    )

    scan_pipeline(source_root, db_path, main_path=main_path)
    translated = list_pipeline_entries(db_path, status="Translated")["items"][0]
    assert translated["target"] == "Lưu Bị"
    assert translated["translationSource"] == "manual"
    assert translated["explicitUpdate"] is True

    preview = preview_pipeline(db_path, source_root, main_path)
    apply_pipeline(db_path, preview["previewId"], tmp_path / "backups")
    assert main_path.read_text(encoding="utf-8") == "刘备=Lưu Bị\n"
    translated = list_pipeline_entries(db_path, status="Translated")["items"][0]
    assert translated["explicitUpdate"] is False

    scan_pipeline(source_root, db_path, main_path=main_path)
    translated = list_pipeline_entries(db_path, status="Translated")["items"][0]
    assert translated["target"] == "Lưu Bị"
    assert translated["translationSource"] == "manual"
    assert translated["explicitUpdate"] is False


def test_runtime_cache_cannot_be_used_as_main_output(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    runtime_path = tmp_path / "_AutoGeneratedTranslations.txt"
    original = "原文=Runtime\n".encode()
    runtime_path.write_bytes(original)
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)

    with pytest.raises(ValidationError, match="không được dùng"):
        preview_pipeline(db_path, source_root, runtime_path)
    assert runtime_path.read_bytes() == original


def test_preview_apply_and_restore_preserve_format_and_runtime_file(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Dialog.json", [{"dialog": "你好=朋友\n下一行\t结束"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    original = UTF8_BOM + "# giữ comment\r\nruntime-key=runtime-value\r\n".encode()
    main_path.write_bytes(original)
    runtime_path = tmp_path / "_AutoGeneratedTranslations.txt"
    runtime_bytes = "仅运行时=Chỉ runtime\r\n".encode()
    runtime_path.write_bytes(runtime_bytes)
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path, runtime_path=runtime_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Xin chào=bạn\nDòng sau\tHết",
        accepted=True,
    )

    preview = preview_pipeline(db_path, source_root, main_path)
    assert preview["qa"]["blocking"] is False
    result = apply_pipeline(db_path, preview["previewId"], tmp_path / "backups")
    applied = main_path.read_bytes()
    assert applied.startswith(UTF8_BOM)
    assert b"runtime-key=runtime-value\r\n" in applied
    expected = "你好\\=朋友\\n下一行\\t结束=Xin chào\\=bạn\\nDòng sau\\tHết\r\n".encode()
    assert expected in applied
    assert runtime_path.read_bytes() == runtime_bytes

    restored = restore_pipeline(db_path, result["backupId"])
    assert restored["restored"] is True
    assert main_path.read_bytes() == original

    listed = list_backups(db_path)
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == result["backupId"]
    assert listed["items"][0]["valid"] is True


def test_restore_requires_force_when_main_changed_after_apply(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    original = "existing=Giữ nguyên\n"
    main_path.write_text(original, encoding="utf-8")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Bản dịch",
        accepted=True,
    )
    preview = preview_pipeline(db_path, source_root, main_path)
    result = apply_pipeline(db_path, preview["previewId"], tmp_path / "backups")
    main_path.write_text("external=changed\n", encoding="utf-8")

    with pytest.raises(ValidationError, match="cần xác nhận force"):
        restore_pipeline(db_path, result["backupId"])
    restored = restore_pipeline(db_path, result["backupId"], force=True)
    assert restored["restored"] is True
    assert main_path.read_text(encoding="utf-8") == original


def test_apply_blocks_stale_main_and_stale_json(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    source = source_root / "Dialog.json"
    _write_json(source, [{"dialog": "你好"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    main_path.write_text("existing=Giữ nguyên\n", encoding="utf-8")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(db_path, source_hash=item["sourceHash"], target="Xin chào", accepted=True)

    stale_main = preview_pipeline(db_path, source_root, main_path)
    main_path.write_text("external=change\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="File chính đã thay đổi"):
        apply_pipeline(db_path, stale_main["previewId"], tmp_path / "backups-main")

    main_path.write_text("existing=Giữ nguyên\n", encoding="utf-8")
    scan_pipeline(source_root, db_path, main_path=main_path)
    stale_json = preview_pipeline(db_path, source_root, main_path)
    stat = source.stat()
    changed = source.read_bytes().replace("你好".encode(), "您好".encode())
    assert len(changed) == stat.st_size
    source.write_bytes(changed)
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    with pytest.raises(ValidationError, match="Nội dung JSON đã thay đổi"):
        apply_pipeline(db_path, stale_json["previewId"], tmp_path / "backups-json")


def test_qa_blocks_lost_tokens_and_composite_delimiters() -> None:
    issues = _qa_translation("你好 {name}&&下一步", "Xin chào && bước sau")
    assert "protected-token" in {issue["rule"] for issue in issues}
    issues = _qa_translation("你好&&下一步", "Xin chào, bước sau")
    assert "composite-structure" in {issue["rule"] for issue in issues}


def test_qa_allows_translated_angle_labels_but_blocks_removed_labels() -> None:
    source = "遇到<刘禅势力>和<孟获势力>。"
    translated = "Gặp <Thế lực Lưu Thiện> và <Thế lực Mạnh Hoạch>."
    assert "protected-token" not in {
        issue["rule"] for issue in _qa_translation(source, translated)
    }
    assert "protected-token" in {
        issue["rule"] for issue in _qa_translation(source, "Gặp hai thế lực.")
    }
    assert "protected-token" in {
        issue["rule"]
        for issue in _qa_translation(source, "Gặp </Thế lực Lưu Thiện> và <Thế lực Mạnh Hoạch>.")
    }


def test_qa_does_not_flag_long_vietnamese_relative_to_chinese() -> None:
    source = "请选择"
    target = (
        "Hãy chọn một nhân vật phù hợp với chiến thuật của bạn rồi xác nhận quyết định "
        "trước khi bước vào trận chiến tiếp theo trên bản đồ."
    )
    assert len(target) > max(120, len(source) * 3)
    assert "long-target" not in {issue["rule"] for issue in _qa_translation(source, target)}


def test_preview_blocks_entries_that_cannot_roundtrip_as_xunity(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "#标题"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    main_path.write_text("existing=Giữ nguyên\n", encoding="utf-8")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(db_path, source_hash=item["sourceHash"], target="Tiêu đề", accepted=True)

    preview = preview_pipeline(db_path, source_root, main_path)

    assert preview["qa"]["blocking"] is True
    assert "serialization-roundtrip" in {
        issue["rule"] for issue in preview["qa"]["issues"]
    }
    with pytest.raises(ValidationError, match="Không còn dòng OK"):
        apply_pipeline(db_path, preview["previewId"], tmp_path / "backups", skip_errors=True)


def test_apply_skip_errors_writes_only_clean_rows(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(
        source_root / "Game.json",
        [{"dialog": "原文"}, {"dialog": "#标题"}],
    )
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    main_path.write_text("existing=Giữ nguyên\n", encoding="utf-8")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    items = {item["source"]: item for item in list_pipeline_entries(db_path, status="New")["items"]}
    set_pipeline_rule(
        db_path,
        source_hash=items["原文"]["sourceHash"],
        target="Bản dịch",
        accepted=True,
    )
    set_pipeline_rule(
        db_path,
        source_hash=items["#标题"]["sourceHash"],
        target="Tiêu đề",
        accepted=True,
    )

    preview = preview_pipeline(db_path, source_root, main_path)
    assert preview["qa"]["blocking"] is True
    with pytest.raises(ValidationError, match="chặn"):
        apply_pipeline(db_path, preview["previewId"], tmp_path / "backups")

    result = apply_pipeline(
        db_path,
        preview["previewId"],
        tmp_path / "backups",
        skip_errors=True,
    )
    text = main_path.read_text(encoding="utf-8")
    assert "existing=Giữ nguyên" in text
    assert "原文=Bản dịch" in text
    assert "#标题" not in text
    assert result["appliedCount"] == 1
    assert result["skippedCount"] == 1

    translated = list_pipeline_entries(db_path, status="Translated")
    assert translated["total"] == 2
    assert {item["source"] for item in translated["items"]} == {"原文", "#标题"}


def test_scan_never_modifies_json_bytes(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    source = source_root / "Game.json"
    _write_json(source, [{"dialog": "原文"}, {"name": "角色"}])
    before = _sha256(source)
    scan_pipeline(source_root, tmp_path / "pipeline.sqlite3")
    assert _sha256(source) == before


def test_stale_model_translation_becomes_unaccepted(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, profile_fingerprint="old")
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "UPDATE texts SET target='Bản dịch', status='Translated', translation_source='model', accepted=1, model_fingerprint='old'"
        )
        connection.execute(
            "INSERT INTO translation_memory(source_hash, source, target, origin, accepted, profile_fingerprint, updated_at) SELECT source_hash, source, target, 'model', 1, 'old', 'now' FROM texts"
        )
        connection.commit()

    scan_pipeline(source_root, db_path, profile_fingerprint="new")

    reviewed = list_pipeline_entries(db_path, status="Needs review")["items"]
    assert reviewed[0]["accepted"] is False
    with sqlite3.connect(db_path) as connection:
        assert connection.execute("SELECT accepted FROM translation_memory").fetchone()[0] == 0


def test_translate_invalidates_stale_model_memory_without_rescan(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "UPDATE texts SET target='Bản cũ', status='Translated', "
            "translation_source='model', accepted=1, model_fingerprint='old'"
        )
        connection.execute(
            "INSERT INTO translation_memory(source_hash, source, target, origin, accepted, "
            "profile_fingerprint, updated_at) SELECT source_hash, source, target, 'model', "
            "1, 'old', 'now' FROM texts"
        )
        connection.commit()

    result = translate_pipeline(
        db_path,
        TranslationConfig(api_keys=("unused",), cache_path=tmp_path / "cache.json"),
        status="New",
        profile_fingerprint="new",
    )

    assert result["selected"] == 0
    reviewed = list_pipeline_entries(db_path, status="Needs review")["items"]
    assert reviewed[0]["target"] == "Bản cũ"
    with sqlite3.connect(db_path) as connection:
        assert connection.execute("SELECT accepted FROM translation_memory").fetchone()[0] == 0


def test_estimate_reports_default_model_cost(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "这是一段需要翻译的文字"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)

    estimate = estimate_pipeline(db_path, model="gemini-3.5-flash-lite")

    assert estimate["estimatedInputTokens"] > 0
    assert estimate["estimatedOutputTokens"] > 0
    assert estimate["estimatedTokens"] == (
        estimate["estimatedInputTokens"] + estimate["estimatedOutputTokens"]
    )
    assert estimate["estimatedCostUsd"] > 0


def test_cli_scan_and_list_emit_protocol_events(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    db_path = tmp_path / "pipeline.sqlite3"

    def run(command: str, config: dict[str, object]) -> list[dict[str, object]]:
        stdin = io.StringIO(
            json.dumps(
                {
                    "protocolVersion": 1,
                    "jobId": f"test-{command}",
                    "command": command,
                    "config": config,
                }
            )
        )
        stdout = io.StringIO()
        monkeypatch.setattr(cli.sys, "stdin", stdin)
        monkeypatch.setattr(cli.sys, "stdout", stdout)
        assert cli.main([command]) == 0
        return [json.loads(line) for line in stdout.getvalue().splitlines()]

    scan_events = run(
        "legend-json-scan",
        {"sourceRoot": str(source_root), "dbPath": str(db_path)},
    )
    list_events = run(
        "legend-json-list",
        {"dbPath": str(db_path), "status": "New", "offset": 0, "limit": 25},
    )

    assert {event["step"] for event in scan_events} == {"inspect"}
    assert next(event for event in scan_events if event["type"] == "result")["payload"][
        "files"
    ] == 1
    assert next(event for event in list_events if event["type"] == "result")["payload"][
        "total"
    ] == 1


def test_preview_does_not_revalidate_unchanged_authoritative_rows(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文{name}"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    main_path.write_text("原文{name}=Bản dịch\n", encoding="utf-8")
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)

    preview = preview_pipeline(db_path, source_root, main_path)

    assert preview["changeCount"] == 0
    assert preview["qa"]["blocking"] is False
    assert preview["outputFingerprint"] == _sha256(main_path)


def test_force_retranslate_skips_tm_and_marks_explicit_update(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Bản cũ",
        accepted=True,
    )
    calls: dict[str, object] = {}

    class FakeStats:
        def to_dict(self) -> dict[str, int]:
            return {"apiCalls": 1, "cacheHits": 0}

    class FakeTranslator:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.stats = FakeStats()

        def translate_items(
            self,
            items: list[dict[str, str]],
            _style: str,
            _file_hint: str,
            *,
            skip_cache: bool = False,
            on_translated_batch: object = None,
        ) -> dict[str, str]:
            calls["skipCache"] = skip_cache
            result = {row["id"]: "Bản mới" for row in items}
            if callable(on_translated_batch):
                on_translated_batch(result)
            return result

        def save_cache(self) -> None:
            return None

    monkeypatch.setattr(legend_json_pipeline, "GeminiTranslator", FakeTranslator)
    result = translate_pipeline(
        db_path,
        TranslationConfig(api_keys=("test",), cache_path=tmp_path / "cache.json"),
        hashes=[item["sourceHash"]],
        status="Translated",
        profile_fingerprint="new",
        force_retranslate=True,
    )

    translated = list_pipeline_entries(db_path, status="Translated")["items"][0]
    assert result["reused"] == 0
    assert calls["skipCache"] is True
    assert translated["target"] == "Bản mới"
    assert translated["explicitUpdate"] is True


def test_cancelled_translate_keeps_committed_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(
        source_root / "Game.json",
        [{"dialog": "第一句"}, {"name": "第二句"}],
    )
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)
    items = list_pipeline_entries(db_path, status="New")["items"]
    assert len(items) == 2
    hashes = {item["sourceHash"] for item in items}

    class FakeStats:
        def to_dict(self) -> dict[str, int]:
            return {"apiCalls": 1, "cacheHits": 0}

    class FakeTranslator:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.stats = FakeStats()

        def translate_items(
            self,
            rows: list[dict[str, str]],
            _style: str,
            _file_hint: str,
            *,
            skip_cache: bool = False,
            on_translated_batch: object = None,
        ) -> dict[str, str]:
            if callable(on_translated_batch):
                on_translated_batch({rows[0]["id"]: "Một"})
            raise CancelledError("cancelled")

        def save_cache(self) -> None:
            return None

    monkeypatch.setattr(legend_json_pipeline, "GeminiTranslator", FakeTranslator)
    with pytest.raises(CancelledError):
        translate_pipeline(
            db_path,
            TranslationConfig(api_keys=("test",), cache_path=tmp_path / "cache.json"),
            profile_fingerprint="fp",
        )

    translated = list_pipeline_entries(db_path, status="Translated")
    remaining = list_pipeline_entries(db_path, status="New")
    assert translated["total"] == 1
    assert translated["items"][0]["target"] == "Một"
    assert translated["items"][0]["sourceHash"] in hashes
    assert remaining["total"] == 1
    assert remaining["items"][0]["sourceHash"] in hashes
    assert remaining["items"][0]["sourceHash"] != translated["items"][0]["sourceHash"]

    scan_pipeline(source_root, db_path)
    still_translated = list_pipeline_entries(db_path, status="Translated")
    assert still_translated["total"] == 1
    assert still_translated["items"][0]["target"] == "Một"


def test_quota_exhausted_persists_cache_hits_from_partial_translations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(
        source_root / "Game.json",
        [{"dialog": "第一句"}, {"name": "第二句"}, {"dialog": "第三句"}],
    )
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)
    items = list_pipeline_entries(db_path, status="New")["items"]
    assert len(items) == 3
    cached_hash = items[0]["sourceHash"]
    api_hash = items[1]["sourceHash"]
    pending_hash = items[2]["sourceHash"]

    class FakeStats:
        def to_dict(self) -> dict[str, int]:
            return {"apiCalls": 1, "cacheHits": 1}

    class FakeTranslator:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.stats = FakeStats()
            self._partial_translations: dict[str, str] = {}

        def translate_items(
            self,
            rows: list[dict[str, str]],
            _style: str,
            _file_hint: str,
            *,
            skip_cache: bool = False,
            on_translated_batch: object = None,
        ) -> dict[str, str]:
            self._partial_translations = {
                cached_hash: "Từ cache",
                api_hash: "Từ API",
            }
            if callable(on_translated_batch):
                on_translated_batch({api_hash: "Từ API"})
            raise QuotaExhaustedError("Hết model/quota trên tất cả API key")

        def save_cache(self) -> None:
            return None

    monkeypatch.setattr(legend_json_pipeline, "GeminiTranslator", FakeTranslator)
    with pytest.raises(QuotaExhaustedError):
        translate_pipeline(
            db_path,
            TranslationConfig(api_keys=("test",), cache_path=tmp_path / "cache.json"),
            profile_fingerprint="fp",
        )

    translated = list_pipeline_entries(db_path, status="Translated")
    remaining = list_pipeline_entries(db_path, status="New")
    by_hash = {item["sourceHash"]: item["target"] for item in translated["items"]}
    assert translated["total"] == 2
    assert by_hash[cached_hash] == "Từ cache"
    assert by_hash[api_hash] == "Từ API"
    assert remaining["total"] == 1
    assert remaining["items"][0]["sourceHash"] == pending_hash


def test_scan_keeps_saved_translations(tmp_path: Path) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(
        db_path,
        source_hash=item["sourceHash"],
        target="Bản dịch",
        accepted=True,
    )
    scan_pipeline(source_root, db_path)
    translated = list_pipeline_entries(db_path, status="Translated")["items"][0]
    assert translated["target"] == "Bản dịch"


def test_apply_restores_backup_when_post_write_verification_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "Json"
    source_root.mkdir()
    _write_json(source_root / "Game.json", [{"dialog": "原文"}])
    main_path = tmp_path / "AutoGeneratedTranslations.txt"
    original = b"existing=old\n"
    main_path.write_bytes(original)
    db_path = tmp_path / "pipeline.sqlite3"
    scan_pipeline(source_root, db_path, main_path=main_path)
    item = list_pipeline_entries(db_path, status="New")["items"][0]
    set_pipeline_rule(db_path, source_hash=item["sourceHash"], target="Bản dịch", accepted=True)
    preview = preview_pipeline(db_path, source_root, main_path)
    real_atomic_replace = legend_json_pipeline._atomic_replace_bytes
    calls = 0

    def corrupt_first_write(path: Path, content: bytes) -> None:
        nonlocal calls
        calls += 1
        real_atomic_replace(path, b"corrupt" if calls == 1 else content)

    monkeypatch.setattr(legend_json_pipeline, "_atomic_replace_bytes", corrupt_first_write)
    with pytest.raises(ValidationError, match="đã phục hồi backup"):
        apply_pipeline(db_path, preview["previewId"], tmp_path / "backups")
    assert main_path.read_bytes() == original
