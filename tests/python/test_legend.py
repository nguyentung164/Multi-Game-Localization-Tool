from __future__ import annotations

import io
import json
import sys
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from translate_tool import cli
from translate_tool.common.translation_core import TranslationConfig, translation_glossary_hash
from translate_tool.common.types import StalePreviewError, ValidationError
from translate_tool.legend import pipeline as legend_module
from translate_tool.legend.han_viet import (
    LEGEND_FIXED_TERMS,
    build_term_bank,
    code_switch_source,
)
from translate_tool.legend.pipeline import (
    LEGEND_PROFILE,
    apply_legend,
    estimate_legend,
    inspect_legend,
    list_legend_entries,
    parse_legend_file,
    rebuild_legend_preview,
    restore_legend_backup,
    retranslate_legend_preview,
    sync_legend_staged,
    translate_legend,
)
from translate_tool.legend.qa import run_legend_qa


class LegendModels:
    def __init__(self, translations: dict[str, str]) -> None:
        self.translations = translations
        self.calls: list[dict[str, object]] = []

    def generate_content(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        prompt = str(kwargs["contents"])
        items = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
        rows = [
            {"id": item["id"], "text": self.translations[item["text"]]}
            for item in items
        ]
        return SimpleNamespace(text=json.dumps(rows, ensure_ascii=False))


class LegendClient:
    def __init__(self, translations: dict[str, str]) -> None:
        self.models = LegendModels(translations)


class SequenceLegendModels:
    def __init__(self, responses: list[dict[str, str]]) -> None:
        self.responses = responses
        self.calls: list[dict[str, object]] = []
        self.index = 0

    def generate_content(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        prompt = str(kwargs["contents"])
        items = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
        table = self.responses[min(self.index, len(self.responses) - 1)]
        self.index += 1
        rows = [
            {"id": item["id"], "text": table[item["text"]]}
            for item in items
        ]
        return SimpleNamespace(text=json.dumps(rows, ensure_ascii=False))


class SequenceLegendClient:
    def __init__(self, responses: list[dict[str, str]]) -> None:
        self.models = SequenceLegendModels(responses)


class InvalidResponseModels:
    def generate_content(self, **_kwargs: object) -> object:
        return SimpleNamespace(text="not-json")


class InvalidResponseClient:
    def __init__(self) -> None:
        self.models = InvalidResponseModels()


def _translation_config(tmp_path: Path) -> TranslationConfig:
    return TranslationConfig(
        api_keys=("mock-key",),
        models=("gemini-mock",),
        cache_path=tmp_path / "legend-cache.json",
        delay_seconds=0,
        timeout_seconds=2,
    )


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
@pytest.mark.parametrize("bom", [False, True])
def test_parser_and_render_preserve_bom_and_line_endings(
    tmp_path: Path, ending: str, bom: bool
) -> None:
    source = tmp_path / "legend-translations.txt"
    body = f"武将=武将{ending}{ending}# comment{ending}"
    data = body.encode("utf-8")
    source.write_bytes((legend_module.UTF8_BOM if bom else b"") + data)
    document = parse_legend_file(source)
    assert document.bom is bom
    assert [line.ending for line in document.lines] == [ending, ending, ending]
    assert document.render({"武将": "武将"}) == source.read_bytes()


def test_parser_handles_escaped_equals_invalid_comments_regex_and_duplicates(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend-translations.txt"
    source.write_text(
        "# a=b\n"
        "等号\\=测试=old\n"
        "^武将\\d+<b>{0}</b>$=regex-old\n"
        "重复=one\n"
        "重复=two\n"
        "invalid\n"
        "\n",
        encoding="utf-8",
        newline="",
    )
    document = parse_legend_file(source)
    assert [line.kind for line in document.lines] == [
        "comment",
        "entry",
        "entry",
        "entry",
        "entry",
        "invalid",
        "blank",
    ]
    assert document.entries[0].left == r"等号\=测试"
    assert document.entries[0].source == "等号=测试"
    assert document.entries[1].source == r"^武将\d+<b>{0}</b>$"
    assert len(document.warnings) == 1
    result = inspect_legend(source)
    assert result["inspection"]["duplicates"] == 1
    assert result["inspection"]["comments"] == 1
    assert result["inspection"]["invalidLines"] == 1


def test_parser_treats_trailing_escaped_equals_as_separator() -> None:
    line = legend_module._parse_line(
        1,
        "攻击力提高20%，每只箭点燃附近的概率15%，点燃范围\\=Tăng sức tấn công 20%\n",
    )
    assert line.kind == "entry"
    assert line.source == "攻击力提高20%，每只箭点燃附近的概率15%，点燃范围="
    assert line.right == "Tăng sức tấn công 20%"
    assert line.left == r"攻击力提高20%，每只箭点燃附近的概率15%，点燃范围\="


def test_render_escapes_raw_line_breaks_to_preserve_structure(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("key=old\\r\\r\\n\r\n", encoding="utf-8")
    document = legend_module.parse_legend_file(source)
    entry = document.entries[0]
    staged = tmp_path / "staged.txt"
    staged.write_bytes(
        document.render_line_targets({entry.number: "new" + "\r\r\n"})
    )
    assert legend_module._structure_matches(document, staged)
    rendered = staged.read_text(encoding="utf-8")
    assert rendered.startswith("key=new\\r\\r\\n")
    assert "\r" not in rendered.replace("\r\n", "")


def test_historical_profile_contains_required_terminology() -> None:
    instruction = LEGEND_PROFILE.system_instruction
    assert "Phân loại từng text theo thứ tự 1→5" in instruction
    assert "không phân biệt hoa/thường" in instruction
    assert "hoa từng tiếng" in instruction
    assert "Lưu Bị" in instruction
    assert "Hán-Việt" in instruction
    assert "Tam Quốc" in instruction
    assert "chữ Quốc ngữ" in instruction
    assert "X之Y" in instruction
    assert "loại vật phẩm lên trước" in instruction
    assert "Phù Thấu Thị" in instruction
    assert "Động Tất Chi Phù" in instruction
    assert "sau đó / giữa / con của" in instruction
    assert "开山大斧" in instruction
    assert "đại phủ" in instruction
    assert "[瞬]" in instruction
    assert "[Tức]" in instruction
    assert "Tây Xuyên" in instruction
    assert "Tây X川" in instruction
    assert "Dấu câu Trung → Việt" in instruction
    assert "20%" in instruction
    assert "đã chứa tên tiếng Việt" in instruction
    assert "Dịch lại TOÀN BỘ" in LEGEND_PROFILE.style_rules["legend_retry"]
    assert "Tên Việt đã có trong nguồn" in LEGEND_PROFILE.style_rules["legend"]
    assert "X之Y" in LEGEND_PROFILE.style_rules["legend"]
    assert LEGEND_FIXED_TERMS["青龙偃月刀"] == "Thanh Long Yển Nguyệt Đao"
    assert LEGEND_FIXED_TERMS["方天画戟"] == "Phương Thiên Họa Kích"
    assert LEGEND_FIXED_TERMS["洞悉之符"] == "Phù Thấu Thị"
    assert LEGEND_FIXED_TERMS["化仇之符"] == "Phù Hóa Thù"
    assert LEGEND_FIXED_TERMS["火计"] == "Hỏa Kế"
    assert LEGEND_FIXED_TERMS["大戟士统领"] == "Đại Kích Sĩ Thống Lĩnh"
    assert LEGEND_FIXED_TERMS["冯绮凡"] == "Phùng Khởi Phàm"
    assert LEGEND_FIXED_TERMS["鄂焕"] == "Ngạc Hoán"
    assert LEGEND_FIXED_TERMS["奚泥"] == "Hề Nê"
    assert LEGEND_FIXED_TERMS["[瞬]"] == "[Tức]"


def test_translate_dedupes_sources_preserves_structure_and_does_not_touch_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend-translations.txt"
    original = (
        legend_module.UTF8_BOM
        + (
            "# keep\r\n"
            "大戟士统领=大戟士统领\r\n"
            "大戟士统领=大戟士统领\r\n"
            "等号\\=测试=等号\\=测试\r\n"
            "^武将\\d+<b>{0}</b>$=^武将\\d+<b>{0}</b>$\r\n"
            "invalid\r\n"
            "\r\n"
        ).encode("utf-8")
    )
    source.write_bytes(original)
    preview = tmp_path / "preview.json"
    client = LegendClient(
        {
            "等号=测试": "Dấu bằng=kiểm thử",
            r"^武将\d+<b>{0}</b>$": r"^Võ tướng\d+<b>{0}</b>$",
        }
    )
    events: list[tuple[str, str, dict[str, object]]] = []
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        reporter=lambda event, step, payload: events.append(
            (event, step, dict(payload))
        ),
        client_factory=lambda _key, _timeout: client,
    )
    assert source.read_bytes() == original
    assert len(client.models.calls) == 1
    prompt = str(client.models.calls[0]["contents"])
    sent_items = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
    assert len(sent_items) == 2
    generated = client.models.calls[0]["config"]
    instruction = (
        generated["system_instruction"]
        if isinstance(generated, dict)
        else generated.system_instruction
    )
    assert "1→5" in str(instruction)
    staged = Path(result["stagedPath"]).read_bytes()
    assert staged.startswith(legend_module.UTF8_BOM)
    text = staged[len(legend_module.UTF8_BOM) :].decode("utf-8")
    assert "大戟士统领=Đại Kích Sĩ Thống Lĩnh\r\n" in text
    assert text.count("大戟士统领=Đại Kích Sĩ Thống Lĩnh") == 2
    assert r"等号\=测试=Dấu bằng\=kiểm thử" in text
    assert r"^武将\d+<b>{0}</b>$=^Võ tướng\d+<b>{0}</b>$" in text
    assert "invalid\r\n\r\n" in text
    assert result["stats"]["duplicates"] == 1
    assert result["stats"]["uniqueSources"] == 3
    assert any(event == "warning" for event, _step, _payload in events)
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    assert artifact["previewId"] == result["previewId"]


def test_translation_failure_never_replaces_existing_target_with_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend-translations.txt"
    preview = tmp_path / "preview.json"
    source.write_text("武将=武将\n", encoding="utf-8")

    with pytest.raises(ValidationError, match="Không dịch được mục"):
        translate_legend(
            source,
            preview,
            _translation_config(tmp_path),
            client_factory=lambda _key, _timeout: InvalidResponseClient(),
        )

    assert source.read_text(encoding="utf-8") == "武将=武将\n"
    assert not preview.exists()
    assert not legend_module._staged_path(preview, source).exists()


def _create_preview(tmp_path: Path) -> tuple[Path, Path, dict[str, object]]:
    source = tmp_path / "legend-translations.txt"
    source.write_bytes(legend_module.UTF8_BOM + "黄巾渠帅=黄巾渠帅\r\n".encode("utf-8"))
    preview = tmp_path / "preview.json"
    client = LegendClient({"黄巾渠帅": "Khăn vàng Cừ soái"})
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    return source, preview, result


def test_apply_rejects_stale_source_fingerprint(tmp_path: Path) -> None:
    source, preview, result = _create_preview(tmp_path)
    source.write_text("changed=changed\n", encoding="utf-8")
    with pytest.raises(StalePreviewError):
        apply_legend(
            source,
            preview,
            tmp_path / "backups",
            expected_preview_id=str(result["previewId"]),
            current_glossary_hash=str(result["glossaryHash"]),
        )


def test_translate_rejects_artifact_path_that_would_overwrite_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend-translations.txt"
    source.write_text("武将=武将\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="sourcePath"):
        translate_legend(
            source,
            source,
            _translation_config(tmp_path),
            client_factory=lambda _key, _timeout: LegendClient({"武将": "Võ tướng"}),
        )
    assert source.read_text(encoding="utf-8") == "武将=武将\n"


def test_apply_rejects_empty_preview_id(tmp_path: Path) -> None:
    source, preview, _result = _create_preview(tmp_path)
    payload = json.loads(preview.read_text(encoding="utf-8"))
    payload["previewId"] = ""
    preview.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValidationError, match="previewId"):
        apply_legend(source, preview, tmp_path / "backups")


def test_apply_accepts_legacy_preview_id_after_staged_path_drift(tmp_path: Path) -> None:
    source, preview, translation = _create_preview(tmp_path)
    payload = json.loads(preview.read_text(encoding="utf-8"))
    payload["previewId"] = legend_module._preview_identity_legacy(payload)
    payload["stagedPath"] = str(tmp_path / "legacy-appdata" / "preview.staged.txt")
    payload["stagedFingerprint"] = "drifted-after-sync"
    preview.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
    assert not legend_module._preview_id_matches(payload, str(payload["previewId"]))
    apply_legend(
        source,
        preview,
        tmp_path / "backups",
        expected_preview_id=str(payload["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )


def test_apply_fresh_qa_passes_glossary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, preview, result = _create_preview(tmp_path)
    captured: dict[str, object] = {}
    original_qa = legend_module.run_legend_qa

    def recording_qa(*args: object, **kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return original_qa(*args, **kwargs)

    monkeypatch.setattr(legend_module, "run_legend_qa", recording_qa)
    glossary = {"custom-term": "Custom Term"}
    apply_legend(
        source,
        preview,
        tmp_path / "backups",
        expected_preview_id=str(result["previewId"]),
        current_glossary_hash=str(result["glossaryHash"]),
        glossary=glossary,
    )
    assert captured.get("glossary") == glossary


def test_apply_creates_backup_manifest_and_uses_atomic_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, preview, translation = _create_preview(tmp_path)
    original = source.read_bytes()
    real_atomic_write = legend_module.atomic_bytes_write
    destinations: list[Path] = []

    def recording_atomic_write(destination: Path, data: bytes) -> None:
        destinations.append(destination)
        real_atomic_write(destination, data)

    monkeypatch.setattr(legend_module, "atomic_bytes_write", recording_atomic_write)
    result = apply_legend(
        source,
        preview,
        tmp_path / "backups",
        expected_preview_id=str(translation["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )
    assert source in destinations
    assert source.read_bytes() == Path(str(translation["stagedPath"])).read_bytes()
    manifest = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
    assert manifest["complete"] is True
    assert manifest["previewId"] == translation["previewId"]
    backup_file = Path(manifest["backupFile"])
    assert backup_file.read_bytes() == original
    assert result["stats"]["changed"] == 1


def test_apply_regenerates_stale_staged_from_preview_json(tmp_path: Path) -> None:
    source, preview, translation = _create_preview(tmp_path)
    payload = json.loads(preview.read_text(encoding="utf-8"))
    staged = Path(str(payload["stagedPath"]))
    staged.write_bytes(legend_module.UTF8_BOM + b"\xe9\xbb\x84\xe5\xb7\xbe\xe6\xb8\xa0\xe5\xb8\x85=STALE\r\n")
    result = apply_legend(
        source,
        preview,
        tmp_path / "backups",
        expected_preview_id=str(translation["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )
    assert source.read_bytes() == _render_staged_bytes_from_preview(preview, source)
    assert staged.read_bytes() == source.read_bytes()
    assert result["stats"]["changed"] == 1


def _render_staged_bytes_from_preview(preview_path: Path, source_path: Path) -> bytes:
    payload = json.loads(preview_path.read_text(encoding="utf-8"))
    document = parse_legend_file(source_path)
    targets = {
        int(row["line"]): str(row.get("editedAfter") or row["target"])
        for row in payload["diffs"]
        if row.get("selected", True)
    }
    return document.render_line_targets(targets)


def test_sync_legend_staged_rewrites_staged_file(tmp_path: Path) -> None:
    source, preview, translation = _create_preview(tmp_path)
    payload = json.loads(preview.read_text(encoding="utf-8"))
    staged = Path(str(payload["stagedPath"]))
    staged.write_bytes(b"stale=content\n")
    synced = sync_legend_staged(
        preview,
        expected_preview_id=str(translation["previewId"]),
    )
    expected = _render_staged_bytes_from_preview(preview, source)
    assert staged.read_bytes() == expected
    refreshed = json.loads(preview.read_text(encoding="utf-8"))
    assert synced["stagedFingerprint"] == refreshed["stagedFingerprint"]


def test_targets_from_diffs_accepts_line_number_alias() -> None:
    targets = legend_module._targets_from_diffs(
        [{"lineNumber": 3, "selected": True, "target": "Việt"}]
    )
    assert targets[3] == "Việt"


def test_sync_staged_ignores_legacy_appdata_path(tmp_path: Path) -> None:
    source, preview, translation = _create_preview(tmp_path)
    payload = json.loads(preview.read_text(encoding="utf-8"))
    legacy_dir = tmp_path / "com.nqt.civ7-localization-tool" / "previews"
    legacy_dir.mkdir(parents=True)
    legacy_staged = legacy_dir / "legend.staged.txt"
    legacy_staged.write_bytes(b"stale-legacy\n")
    payload["stagedPath"] = str(legacy_staged)
    preview.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    synced = sync_legend_staged(
        preview,
        expected_preview_id=str(translation["previewId"]),
    )
    sibling = legend_module._staged_path(preview.resolve(), source.resolve())
    assert Path(str(synced["stagedPath"])) == sibling
    assert sibling.is_file()
    assert sibling.read_bytes() != b"stale-legacy\n"
    assert legacy_staged.read_bytes() == b"stale-legacy\n"


def test_sync_legend_staged_allows_source_target_drift_when_diffs_align(
    tmp_path: Path,
) -> None:
    source, preview, translation = _create_preview(tmp_path)
    payload = json.loads(preview.read_text(encoding="utf-8"))
    old_fingerprint = payload["fingerprint"]
    source.write_bytes(
        legend_module.UTF8_BOM + "黄巾渠帅=NEW_RIGHT\r\n".encode("utf-8")
    )
    synced = sync_legend_staged(
        preview,
        expected_preview_id=str(translation["previewId"]),
    )
    refreshed = json.loads(preview.read_text(encoding="utf-8"))
    assert refreshed["fingerprint"] != old_fingerprint
    assert synced["stagedFingerprint"] == refreshed["stagedFingerprint"]


def test_apply_deploys_staged_file_to_game_folder(tmp_path: Path) -> None:
    source = tmp_path / "workspace" / "legend-translations.txt"
    source.parent.mkdir(parents=True)
    source.write_bytes(legend_module.UTF8_BOM + "黄巾渠帅=黄巾渠帅\r\n".encode("utf-8"))
    preview = tmp_path / "preview.json"
    client = LegendClient({"黄巾渠帅": "Khăn vàng Cừ soái"})
    translation = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    game_dir = tmp_path / "BepInEx" / "Translation" / "vi" / "Text"
    game_dir.mkdir(parents=True)
    game_file = game_dir / legend_module.LEGEND_DEPLOY_FILENAME
    game_file.write_text("old game=old\n", encoding="utf-8")
    original_game = game_file.read_bytes()

    result = apply_legend(
        source,
        preview,
        tmp_path / "backups",
        deploy_path=game_dir,
        expected_preview_id=str(translation["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )

    staged = Path(str(translation["stagedPath"]))
    assert game_file.read_bytes() == staged.read_bytes()
    assert result["deployPath"] == str(game_file)
    manifest = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
    deploy_backup = Path(str(manifest["deployBackupFile"]))
    assert deploy_backup.read_bytes() == original_game


def test_apply_skips_duplicate_deploy_when_source_is_game_file(tmp_path: Path) -> None:
    game_dir = tmp_path / "Text"
    game_dir.mkdir()
    source = game_dir / legend_module.LEGEND_DEPLOY_FILENAME
    source.write_bytes(legend_module.UTF8_BOM + "黄巾渠帅=黄巾渠帅\r\n".encode("utf-8"))
    preview = tmp_path / "preview.json"
    client = LegendClient({"黄巾渠帅": "Khăn vàng Cừ soái"})
    translation = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    result = apply_legend(
        source,
        preview,
        tmp_path / "backups",
        deploy_path=game_dir,
        expected_preview_id=str(translation["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )
    assert "deployPath" not in result
    assert source.read_bytes() == Path(str(translation["stagedPath"])).read_bytes()


def test_legend_inspect_cli_emits_jsonl_with_rust_compatible_step(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert cli.EVENT_STEPS == {
        "legend-inspect": "inspect",
        "legend-translate": "translate",
        "legend-estimate": "translate",
        "legend-rebuild": "translate",
        "legend-list-entries": "inspect",
        "legend-retranslate": "translate",
        "legend-sync-staged": "inspect",
        "legend-apply": "sync-apply",
            "legend-restore": "restore",
            "legend-json-scan": "inspect",
            "legend-json-list": "inspect",
            "legend-json-set-rule": "inspect",
            "legend-json-estimate": "translate",
            "legend-json-translate": "translate",
            "legend-json-preview": "sync-preview",
            "legend-json-apply": "sync-apply",
            "legend-json-restore": "restore",
            "legend-json-list-backups": "restore",
        }
    source = tmp_path / "legend-translations.txt"
    source.write_text("武将=武将\n", encoding="utf-8")
    request = {
        "protocolVersion": 1,
        "jobId": "legend-inspect-test",
        "command": "legend-inspect",
        "config": {"sourcePath": str(source), "sampleSize": 1},
    }
    output = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    monkeypatch.setattr(sys, "stdout", output)
    assert cli.main(["legend-inspect"]) == 0
    events = [json.loads(line) for line in output.getvalue().splitlines()]
    assert {event["step"] for event in events} == {"inspect"}
    assert [event["type"] for event in events] == ["started", "result", "completed"]
    result = next(event for event in events if event["type"] == "result")
    assert result["payload"]["fingerprint"]
    assert result["payload"]["sample"][0]["source"] == "武将"


def test_glossary_v2_and_legacy_are_compatible() -> None:
    glossary, locked = cli._normalize_glossary(
        {
            "version": 2,
            "profileId": "legend",
            "entries": [
                {
                    "source": "黄巾渠帅",
                    "target": "Khăn vàng Cừ soái",
                    "locked": True,
                    "note": "Chức tước",
                }
            ],
        }
    )
    assert glossary == {"黄巾渠帅": "Khăn vàng Cừ soái"}
    assert locked == glossary
    assert cli._normalize_glossary({"武将": "Võ tướng"}) == (
        {"武将": "Võ tướng"},
        {},
    )


def test_locked_exact_glossary_skips_gemini(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("黄巾渠帅=黄巾渠帅\n", encoding="utf-8")
    config = replace(
        _translation_config(tmp_path),
        locked_glossary={"黄巾渠帅": "Khăn vàng Cừ soái"},
    )
    client = LegendClient({})
    result = translate_legend(
        source,
        tmp_path / "preview.json",
        config,
        client_factory=lambda _key, _timeout: client,
    )
    assert not client.models.calls
    assert "黄巾渠帅=Khăn vàng Cừ soái" in Path(result["stagedPath"]).read_text(
        encoding="utf-8"
    )


def test_preview_id_matches_legacy_and_current_hashes() -> None:
    payload = {
        "version": 2,
        "diffs": [{"line": 1, "source": "武将"}],
        "fingerprint": "abc",
        "stagedPath": "x.staged.txt",
        "stagedFingerprint": "def",
    }
    current = legend_module._preview_identity(payload)
    legacy = legend_module._preview_identity_legacy(payload)
    assert current != legacy
    assert legend_module._preview_id_matches({**payload, "previewId": current}, current)
    assert legend_module._preview_id_matches({**payload, "previewId": legacy}, legacy)


def test_translate_rejects_trial_mode(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("武将=武将\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="toàn bộ"):
        translate_legend(
            source,
            tmp_path / "preview.json",
            _translation_config(tmp_path),
            mode="trial",
            trial_limit=20,
            client_factory=lambda _key, _timeout: LegendClient({"武将": "Võ tướng"}),
        )


def test_estimate_probes_cache_and_locked_entries(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("武将=武将\n黄巾渠帅=黄巾渠帅\n谋士=谋士\n", encoding="utf-8")
    config = replace(
        _translation_config(tmp_path),
        batch_size=1,
        locked_glossary={"黄巾渠帅": "Khăn vàng Cừ soái"},
    )
    translate_legend(
        source,
        tmp_path / "preview.json",
        config,
        client_factory=lambda _key, _timeout: LegendClient(
            {"武将": "Võ tướng", "谋士": "Mưu sĩ"}
        ),
    )
    estimate = estimate_legend(source, config)
    assert estimate == {
        "items": 3,
        "doneItems": 0,
        "reusedItems": 0,
        "cachedItems": 2,
        "lockedItems": 1,
        "pendingItems": 0,
        "actionableItems": 3,
        "unverifiedItems": 0,
        "fileFilledItems": 0,
        "workersUsed": 0,
        "spareKeys": 1,
        "estimatedBatches": 0,
        "estimatedApiCalls": 0,
    }


def test_selective_rebuild_preserves_before_and_tracks_revision(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("武将=武将\n谋士=谋士\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient(
            {"武将": "Võ tướng", "谋士": "Mưu sĩ"}
        ),
    )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    first, second = artifact["diffs"]
    rebuilt = rebuild_legend_preview(
        preview,
        expected_preview_id=str(result["previewId"]),
        edits=[
            {"lineNumber": first["line"], "selected": False},
            {
                "lineNumber": second["line"],
                "selected": True,
                "editedAfter": "Quân sư",
            },
        ],
    )
    staged = Path(artifact["stagedPath"]).read_text(encoding="utf-8")
    assert "武将=武将" in staged
    assert "谋士=Quân sư" in staged
    assert rebuilt["revision"] == 2
    assert rebuilt["qa"]["revision"] == 2
    assert rebuilt["previewId"] != result["previewId"]


def test_rebuild_preserves_rejected_bytes_and_whitespace_edit(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_bytes(
        b"\xef\xbb\xbf" + "武将=武将  \r\n谋士=谋士\n".encode("utf-8")
    )
    preview = tmp_path / "preview.json"
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient(
            {"武将": "Võ tướng", "谋士": "Mưu sĩ"}
        ),
    )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    first, second = artifact["diffs"]
    rebuild_legend_preview(
        preview,
        expected_preview_id=str(result["previewId"]),
        edits=[
            {"lineNumber": first["line"], "selected": False},
            {
                "lineNumber": second["line"],
                "selected": True,
                "editedAfter": "  Quân sư  ",
            },
        ],
    )
    staged = Path(artifact["stagedPath"]).read_bytes()
    assert staged.startswith(b"\xef\xbb\xbf")
    assert "武将=武将  \r\n".encode("utf-8") in staged
    assert "谋士=  Quân sư  \n".encode("utf-8") in staged


def test_qa_uses_proposed_target_when_unselected() -> None:
    report = run_legend_qa(
        [
            {
                "line": 1,
                "source": r"武将 {0}",
                "oldTarget": "OLD",
                "target": "Võ tướng {0}",
                "selected": False,
            }
        ],
        revision=2,
    )
    assert report["blocking"] is False
    assert not any(issue["rule"] == "missing-token" for issue in report["issues"])


def test_apply_rejects_changed_glossary_hash(tmp_path: Path) -> None:
    source, preview, translation = _create_preview(tmp_path)
    with pytest.raises(ValidationError, match="Glossary"):
        apply_legend(
            source,
            preview,
            tmp_path / "backups",
            expected_preview_id=str(translation["previewId"]),
            current_glossary_hash="different",
        )


def test_qa_blocks_missing_tokens_and_locked_glossary() -> None:
    report = run_legend_qa(
        [
            {
                "line": 3,
                "source": r"黄巾渠帅 ^武将\d+<b>{0}</b>$",
                "oldTarget": "OLD",
                "target": "Cừ soái",
                "selected": True,
            }
        ],
        revision=2,
        locked_glossary={"黄巾渠帅": "Khăn vàng Cừ soái"},
    )
    assert report["blocking"] is True
    assert {issue["rule"] for issue in report["issues"]} >= {
        "missing-token",
        "locked-glossary",
    }
    locked = next(
        issue for issue in report["issues"] if issue["rule"] == "locked-glossary"
    )
    assert "Dịch 黄巾渠帅 thành Khăn vàng Cừ soái" in locked["detail"]
    assert locked["suggestions"] == [
        {"source": "黄巾渠帅", "reading": "Khăn vàng Cừ soái"}
    ]


def test_qa_blocks_remaining_han_in_vietnamese() -> None:
    report = run_legend_qa(
        [
            {
                "line": 8,
                "source": "西川",
                "oldTarget": "OLD",
                "target": "Tây X川",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert report["blocking"] is True
    han = next(
        issue for issue in report["issues"] if issue["rule"] == "han-remaining"
    )
    assert han.get("suggestions") in (None, [])
    assert "Tây Xuyên" not in han["detail"]


def test_qa_suggests_han_remaining_and_untranslated_source() -> None:
    leftover = run_legend_qa(
        [
            {
                "line": 21,
                "source": "介绍雪莹",
                "oldTarget": "OLD",
                "target": "giới thiệu 雪莹",
                "selected": True,
            }
        ],
        revision=1,
    )
    han_issue = next(
        issue for issue in leftover["issues"] if issue["rule"] == "han-remaining"
    )
    assert "Dịch 雪莹 thành Tuyết Oánh" in han_issue["detail"]
    assert {"source": "雪莹", "reading": "Tuyết Oánh"} in han_issue["suggestions"]

    same = run_legend_qa(
        [
            {
                "line": 22,
                "source": "雪莹",
                "oldTarget": "OLD",
                "target": "雪莹",
                "selected": True,
            }
        ],
        revision=1,
    )
    warning = next(
        issue
        for issue in same["issues"]
        if issue["rule"] == "source-equals-target"
    )
    assert {"source": "雪莹", "reading": "Tuyết Oánh"} in warning["suggestions"]
    assert "Dịch 雪莹 thành Tuyết Oánh" in warning["detail"]


def test_qa_skips_source_equals_target_when_source_has_no_han() -> None:
    report = run_legend_qa(
        [
            {
                "line": 6377,
                "source": "2v2",
                "oldTarget": "OLD",
                "target": "2v2",
                "selected": True,
            },
            {
                "line": 6378,
                "source": "3v3",
                "oldTarget": "OLD",
                "target": "3v3",
                "selected": True,
            },
        ],
        revision=1,
    )
    assert not any(
        issue["rule"] == "source-equals-target" for issue in report["issues"]
    )


def test_qa_suggests_translated_skill_bracket_when_missing() -> None:
    report = run_legend_qa(
        [
            {
                "line": 23,
                "source": "[瞬]斩击",
                "oldTarget": "OLD",
                "target": "Chém",
                "selected": True,
            }
        ],
        revision=1,
    )
    token = next(
        issue for issue in report["issues"] if issue["rule"] == "missing-token"
    )
    assert "Dịch [瞬] thành [Tức]" in token["detail"]
    assert token["suggestions"] == [{"source": "[瞬]", "reading": "[Tức]"}]


def test_qa_suggests_empty_target_when_source_is_a_name() -> None:
    report = run_legend_qa(
        [
            {
                "line": 24,
                "source": "刘备",
                "oldTarget": "OLD",
                "target": "   ",
                "selected": True,
            }
        ],
        revision=1,
    )
    empty = next(
        issue for issue in report["issues"] if issue["rule"] == "empty-target"
    )
    assert "Dịch 刘备 thành Lưu Bị" in empty["detail"]
    assert empty["suggestions"] == [{"source": "刘备", "reading": "Lưu Bị"}]


def test_qa_does_not_duplicate_han_remaining_when_term_already_suggested() -> None:
    report = run_legend_qa(
        [
            {
                "line": 26,
                "source": "刘备来了",
                "oldTarget": "OLD",
                "target": "刘备 đến rồi",
                "selected": True,
            }
        ],
        revision=1,
    )
    rules = [issue["rule"] for issue in report["issues"]]
    assert "term-success" in rules
    assert "han-remaining" not in rules
    term = next(
        issue for issue in report["issues"] if issue["rule"] == "term-success"
    )
    assert {"source": "刘备", "reading": "Lưu Bị"} in term["suggestions"]


def test_qa_attaches_unique_vietnamese_standin_for_missing_term() -> None:
    report = run_legend_qa(
        [
            {
                "line": 896,
                "source": "先事刘璋，后为刘备谋士",
                "oldTarget": "OLD",
                "target": "Phò tá Lưu Chương, sau đó làm mưu sĩ. Nhậm chức cho Lưu Biện.",
                "selected": True,
            }
        ],
        revision=1,
    )
    term = next(
        issue for issue in report["issues"] if issue["rule"] == "term-success"
    )
    suggestion = next(
        item for item in term["suggestions"] if item["source"] == "刘备"
    )
    assert suggestion["reading"] == "Lưu Bị"
    assert suggestion["replace"] == "Lưu Biện"


def test_qa_han_remaining_only_lists_uncovered_leftover() -> None:
    report = run_legend_qa(
        [
            {
                "line": 27,
                "source": "刘备介绍雪莹",
                "oldTarget": "OLD",
                "target": "刘备 giới thiệu 雪莹",
                "selected": True,
            }
        ],
        revision=1,
    )
    term = next(
        issue for issue in report["issues"] if issue["rule"] == "term-success"
    )
    han = next(
        issue for issue in report["issues"] if issue["rule"] == "han-remaining"
    )
    assert {"source": "刘备", "reading": "Lưu Bị"} in term["suggestions"]
    assert {"source": "雪莹", "reading": "Tuyết Oánh"} in han["suggestions"]
    assert all(item["source"] != "刘备" for item in han["suggestions"])


def test_qa_does_not_guess_empty_target_for_full_sentences() -> None:
    report = run_legend_qa(
        [
            {
                "line": 25,
                "source": "介绍雪莹并击败袁绍",
                "oldTarget": "OLD",
                "target": "",
                "selected": True,
            }
        ],
        revision=1,
    )
    empty = next(
        issue for issue in report["issues"] if issue["rule"] == "empty-target"
    )
    assert empty.get("suggestions") in (None, [])
    assert empty["detail"] == "Output hiệu lực đang rỗng."


def test_qa_allows_translated_skill_bracket_tags() -> None:
    report = run_legend_qa(
        [
            {
                "line": 4,
                "source": "[瞬]斩击",
                "oldTarget": "OLD",
                "target": "[Tức] Chém",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert report["blocking"] is False
    assert not any(issue["rule"] == "missing-token" for issue in report["issues"])


def test_qa_allows_translated_han_angle_titles() -> None:
    report = run_legend_qa(
        [
            {
                "line": 9128,
                "source": "选择你在 <诸侯讨董> 剧本中所扮演 武将",
                "oldTarget": "OLD",
                "target": "Chọn võ tướng bạn đóng vai trong kịch bản <Chư Hầu Thảo Đổng>",
                "selected": True,
            },
            {
                "line": 9133,
                "source": "暂时无法触发 <七星宝刀> 、 <连环计> 剧情",
                "oldTarget": "OLD",
                "target": "Tạm thời không thể kích hoạt cốt truyện <Thất Tinh Bảo Đao> <Liên Hoàn Kế>",
                "selected": True,
            },
        ],
        revision=1,
    )
    assert not any(issue["rule"] == "missing-token" for issue in report["issues"])


def test_qa_allows_translated_han_angle_tags_with_digits() -> None:
    report = run_legend_qa(
        [
            {
                "line": 120,
                "source": "【<刘备势力><与庞德关系等级至少为2级>收庞德为家将】",
                "oldTarget": "OLD",
                "target": "【<Thế lực Lưu Bị><Cấp độ quan hệ với Bàng Đức ít nhất là cấp 2> thu Bàng Đức làm gia tướng】",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert not any(issue["rule"] == "missing-token" for issue in report["issues"])


def test_restore_creates_safety_backup_and_verifies_fingerprint(
    tmp_path: Path,
) -> None:
    source, preview, translation = _create_preview(tmp_path)
    original = source.read_bytes()
    applied = apply_legend(
        source,
        preview,
        tmp_path / "backups",
        expected_preview_id=str(translation["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )
    source.write_text("manual=change\n", encoding="utf-8")
    with pytest.raises(StalePreviewError):
        restore_legend_backup(
            Path(applied["backup"]), expected_source_path=source
        )
    restored = restore_legend_backup(
        Path(applied["backup"]), expected_source_path=source, force=True
    )
    assert source.read_bytes() == original
    safety = Path(restored["safetyBackup"])
    assert (safety / "manifest.json").is_file()
    assert (safety / "files" / source.name).read_text(encoding="utf-8") == (
        "manual=change\n"
    )


def test_restore_rejects_unexpected_source_before_copy(tmp_path: Path) -> None:
    source, preview, translation = _create_preview(tmp_path)
    applied = apply_legend(
        source,
        preview,
        tmp_path / "backups",
        expected_preview_id=str(translation["previewId"]),
        current_glossary_hash=str(translation["glossaryHash"]),
    )
    other = tmp_path / "other.txt"
    other.write_text("untouched\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="không khớp"):
        restore_legend_backup(
            Path(applied["backup"]), expected_source_path=other, force=True
        )
    assert other.read_text(encoding="utf-8") == "untouched\n"


def test_retranslate_skips_cache_for_han_lines(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("西川=西川\n武将=武将\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    config = _translation_config(tmp_path)
    first = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: LegendClient(
            {"西川": "Tây X川", "武将": "Võ tướng"}
        ),
    )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    han_line = next(row["line"] for row in artifact["diffs"] if row["source"] == "西川")
    retry_client = LegendClient({"西川": "Tây Xuyên"})
    retried = retranslate_legend_preview(
        preview,
        config,
        expected_preview_id=str(first["previewId"]),
        line_numbers=[han_line],
        client_factory=lambda _key, _timeout: retry_client,
    )
    by_source = {row["source"]: row["target"] for row in retried["diffs"]}
    assert by_source["西川"] == "Tây Xuyên"
    assert by_source["武将"] == "Võ tướng"
    assert "西川=Tây Xuyên" in Path(artifact["stagedPath"]).read_text(encoding="utf-8")
    assert retried["revision"] == 2
    assert retried["retranslated"] == 1
    assert retry_client.models.calls


def test_retranslate_checkpoints_each_batch(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("西川=西川\n南川=南川\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    config = replace(_translation_config(tmp_path), batch_size=1)
    first = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: LegendClient(
            {"西川": "Tây X川", "南川": "Nam X川"}
        ),
    )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    lines = [int(row["line"]) for row in artifact["diffs"]]
    retried = retranslate_legend_preview(
        preview,
        config,
        expected_preview_id=str(first["previewId"]),
        line_numbers=lines,
        client_factory=lambda _key, _timeout: LegendClient(
            {"西川": "Tây Xuyên", "南川": "Nam Xuyên"}
        ),
    )
    by_source = {row["source"]: row["target"] for row in retried["diffs"]}
    assert by_source["西川"] == "Tây Xuyên"
    assert by_source["南川"] == "Nam Xuyên"
    assert retried["revision"] == 3


def test_retranslate_progress_uses_overall_line_total(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("西川=西川\n南川=南川\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    config = replace(_translation_config(tmp_path), batch_size=1)
    first = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: LegendClient(
            {"西川": "Tây X川", "南川": "Nam X川"}
        ),
    )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    events: list[object] = []

    def reporter(event_type: str, _step: str, payload: object) -> None:
        if event_type == "progress":
            events.append(payload)

    retranslate_legend_preview(
        preview,
        config,
        expected_preview_id=str(first["previewId"]),
        line_numbers=[int(row["line"]) for row in artifact["diffs"]],
        client_factory=lambda _key, _timeout: LegendClient(
            {"西川": "Tây Xuyên", "南川": "Nam Xuyên"}
        ),
        reporter=reporter,
    )
    totals = [
        payload.get("itemsTotal")
        for payload in events
        if isinstance(payload, dict) and payload.get("phase") == "api"
    ]
    assert totals
    assert all(total == 2 for total in totals)
    assert any(
        isinstance(payload, dict) and payload.get("itemsProcessed") == 2
        for payload in events
    )


def test_retranslate_retries_until_clean(tmp_path: Path) -> None:
    source_text = "曾跟随杨奉并击败袁绍于乌巢"
    source = tmp_path / "legend.txt"
    source.write_text(f"{source_text}={source_text}\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    switched, _ = code_switch_source(source_text, build_term_bank())
    leftover = "từng theo Dương Phụng, đánh bại Viên绍 tại Ô Th巢"
    first = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: SequenceLegendClient(
            [{switched: leftover}, {switched: leftover}]
        ),
    )
    client = SequenceLegendClient(
        [
            {switched: leftover},
            {
                switched: "Từng theo Dương Phụng, đánh bại Viên Thiệu tại Ô Sào."
            },
        ]
    )
    retried = retranslate_legend_preview(
        preview,
        _translation_config(tmp_path),
        expected_preview_id=str(first["previewId"]),
        client_factory=lambda _key, _timeout: client,
    )
    assert len(client.models.calls) == 2
    assert "绍" not in retried["diffs"][0]["target"]
    assert "Viên Thiệu" in retried["diffs"][0]["target"]


def test_retranslate_auto_includes_term_gap_without_han(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("刘备来了=刘备来了\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    config = _translation_config(tmp_path)
    switched, _ = code_switch_source("刘备来了", build_term_bank())
    first = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: LegendClient(
            {switched: "Lưu Biện đến rồi"}
        ),
    )
    assert any(
        issue["rule"] == "term-success" for issue in first["qa"]["issues"]
    )
    retry_client = LegendClient({switched: "Lưu Bị đến rồi"})
    retried = retranslate_legend_preview(
        preview,
        config,
        expected_preview_id=str(first["previewId"]),
        client_factory=lambda _key, _timeout: retry_client,
    )
    assert retried["diffs"][0]["target"] == "Lưu Bị đến rồi"
    assert retry_client.models.calls


def test_retranslate_result_event_omits_diffs(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("西川=西川\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    first = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient({"西川": "Tây X川"}),
    )
    events: list[tuple[str, object]] = []

    def reporter(event_type: str, _step: str, payload: object) -> None:
        events.append((event_type, payload))

    retried = retranslate_legend_preview(
        preview,
        _translation_config(tmp_path),
        expected_preview_id=str(first["previewId"]),
        client_factory=lambda _key, _timeout: LegendClient({"西川": "Tây Xuyên"}),
        reporter=reporter,
    )
    assert "diffs" in retried
    result_events = [payload for kind, payload in events if kind == "result"]
    assert result_events
    emitted = result_events[0]
    assert isinstance(emitted, dict)
    assert "diffs" not in emitted
    assert emitted["retranslated"] == 1


def test_retranslate_uses_locked_glossary_without_api(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("西川=西川\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    first = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient({"西川": "Tây X川"}),
    )
    calls = {"count": 0}

    def factory(_key: str, _timeout: float) -> LegendClient:
        calls["count"] += 1
        return LegendClient({"西川": "Không được gọi"})

    config = replace(
        _translation_config(tmp_path),
        locked_glossary={"西川": "Tây Xuyên"},
    )
    retried = retranslate_legend_preview(
        preview,
        config,
        expected_preview_id=str(first["previewId"]),
        client_factory=factory,
    )
    assert calls["count"] == 0
    assert retried["diffs"][0]["target"] == "Tây Xuyên"


def test_retranslate_rejects_trial_and_empty_han(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("武将=武将\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    config = _translation_config(tmp_path)
    first = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: LegendClient({"武将": "Võ tướng"}),
    )
    with pytest.raises(ValidationError, match="chữ Hán"):
        retranslate_legend_preview(
            preview,
            config,
            expected_preview_id=str(first["previewId"]),
        )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    artifact["mode"] = "trial"
    artifact["previewId"] = legend_module._preview_identity(artifact)
    preview.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with pytest.raises(ValidationError, match="dịch thử"):
        retranslate_legend_preview(
            preview,
            config,
            expected_preview_id=str(artifact["previewId"]),
            line_numbers=[1],
        )


def test_token_fallback_does_not_restore_han_source() -> None:
    translations = {"(?:西川)": "Tây Xuyên"}
    warnings: list[object] = []
    legend_module._apply_token_fallback(translations, warnings, lambda *_args: None)
    assert translations["(?:西川)"] == "Tây Xuyên"
    assert warnings


def test_token_fallback_patches_missing_placeholder() -> None:
    translations = {"Hello {0}": "Xin chào"}
    warnings: list[object] = []
    legend_module._apply_token_fallback(translations, warnings, lambda *_args: None)
    assert translations["Hello {0}"] == "Xin chào {0}"
    assert warnings[0]["patched"] is True


def test_token_fallback_restores_when_patch_fails() -> None:
    translations = {"Hello {0} world": "Xin chào"}
    warnings: list[object] = []
    legend_module._apply_token_fallback(translations, warnings, lambda *_args: None)
    assert translations["Hello {0} world"] == "Hello {0} world"


def test_translate_keeps_vietnamese_when_regex_token_missing(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("(?:西川)=(?:西川)\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient(
            {"(?:西川)": "Tây Xuyên"}
        ),
    )
    assert result["diffs"][0]["target"] == "Tây Xuyên"
    assert "西川" not in result["diffs"][0]["target"]


def test_han_viet_names_skip_api_and_keep_initials(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("鄂焕=鄂焕\n奚泥=奚泥\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    client = LegendClient({})
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    by_source = {row["source"]: row["target"] for row in result["diffs"]}
    assert by_source["鄂焕"] == "Ngạc Hoán"
    assert by_source["奚泥"] == "Hề Nê"
    assert client.models.calls == []


def test_list_legend_entries_paginates_from_python_parser(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text(
        "武将=武将-1\n"
        "重复=one\n"
        "重复=two\n"
        "invalid\n",
        encoding="utf-8",
    )
    page = list_legend_entries(source, offset=0, limit=1, kind="entry")
    assert page["total"] == 3
    assert page["entryTotal"] == 3
    assert page["duplicateTotal"] == 2
    assert len(page["entries"]) == 1
    page_two = list_legend_entries(source, offset=1, limit=1, kind="entry")
    assert len(page_two["entries"]) == 1
    assert page_two["entries"][0]["source"] == "重复"
    duplicates = list_legend_entries(source, kind="duplicate")
    assert duplicates["total"] == 2
    assert all(item.get("occurrence") == 2 for item in duplicates["entries"])


def test_list_legend_entries_emits_result_event(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("武将=one\n白马=two\n", encoding="utf-8")
    emitted: list[dict[str, object]] = []

    def recording_reporter(
        event_type: str, _step: str, payload: Mapping[str, object]
    ) -> None:
        if event_type == "result":
            emitted.append(dict(payload))

    page = list_legend_entries(
        source,
        offset=1,
        limit=1,
        kind="entry",
        reporter=recording_reporter,
    )
    assert len(page["entries"]) == 1
    assert page["entries"][0]["source"] == "白马"
    assert len(emitted) == 1
    assert emitted[0]["entries"] == page["entries"]


def test_translate_includes_quality_metrics(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("武将=武将\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient({"武将": "Võ tướng"}),
    )
    assert "qaPassedFirstPass" in result["stats"]
    assert "topFailedRules" in result["stats"]
    assert "topIssueRules" in result["stats"]


def test_canonical_terms_skip_api_and_code_switch_in_sentence(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend.txt"
    source.write_text(
        "洞悉之符=洞悉之符\n"
        "青龙偃月刀=青龙偃月刀\n"
        "[瞬]=[瞬]\n"
        "获得洞悉之符。=获得洞悉之符。\n",
        encoding="utf-8",
    )
    preview = tmp_path / "preview.json"
    config = _translation_config(tmp_path)
    estimate = estimate_legend(source, config)
    assert estimate["lockedItems"] == 3
    assert estimate["pendingItems"] == 1
    switched, _ = code_switch_source("获得洞悉之符。", build_term_bank())
    client = LegendClient({switched: "Nhận được Phù Thấu Thị."})
    result = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: client,
    )
    by_source = {row["source"]: row["target"] for row in result["diffs"]}
    assert by_source["洞悉之符"] == "Phù Thấu Thị"
    assert by_source["青龙偃月刀"] == "Thanh Long Yển Nguyệt Đao"
    assert by_source["[瞬]"] == "[Tức]"
    assert by_source["获得洞悉之符。"] == "Nhận được Phù Thấu Thị."
    assert len(client.models.calls) == 1
    payload = json.loads(
        str(client.models.calls[0]["contents"]).split("Dữ liệu:\n", 1)[1]
    )
    assert payload[0]["text"] == switched
    assert "洞悉之符" not in payload[0]["text"]
    assert "Phù Thấu Thị" in payload[0]["text"]


def test_user_glossary_overrides_canonical_term(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("洞悉之符=洞悉之符\n", encoding="utf-8")
    config = replace(
        _translation_config(tmp_path),
        glossary={"洞悉之符": "Bùa Nhìn Thấu"},
    )
    client = LegendClient({})
    result = translate_legend(
        source,
        tmp_path / "preview.json",
        config,
        client_factory=lambda _key, _timeout: client,
    )
    assert result["diffs"][0]["target"] == "Bùa Nhìn Thấu"
    assert client.models.calls == []


def test_qa_requires_canonical_item_term() -> None:
    report = run_legend_qa(
        [
            {
                "line": 3,
                "source": "获得洞悉之符",
                "oldTarget": "OLD",
                "target": "nhận được bùa",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert report["blocking"] is True
    detail = next(
        issue["detail"]
        for issue in report["issues"]
        if issue["rule"] == "term-success"
    )
    assert "Dịch 洞悉之符 thành Phù Thấu Thị" in detail


def test_qa_blocks_missing_required_terms() -> None:
    report = run_legend_qa(
        [
            {
                "line": 9,
                "source": "于乌巢击败袁绍",
                "oldTarget": "OLD",
                "target": "đánh bại kẻ địch tại doanh trại",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert report["blocking"] is True
    detail = next(
        issue["detail"]
        for issue in report["issues"]
        if issue["rule"] == "term-success"
    )
    assert "Dịch 袁绍 thành Viên Thiệu" in detail
    assert "Dịch 乌巢 thành Ô Sào" in detail


def test_qa_accepts_vietnamese_uy_tone_placement() -> None:
    report = run_legend_qa(
        [
            {
                "line": 12,
                "source": "渭水",
                "oldTarget": "OLD",
                "target": "Vị Thuỷ",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert not any(issue["rule"] == "term-success" for issue in report["issues"])


def test_qa_accepts_lowercase_fixed_term_in_narrative() -> None:
    report = run_legend_qa(
        [
            {
                "line": 14,
                "source": "负责执行诸葛亮的火计",
                "oldTarget": "OLD",
                "target": "chịu trách nhiệm thực thi hỏa kế của Gia Cát Lượng",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert report["blocking"] is False
    assert not any(issue["rule"] == "term-success" for issue in report["issues"])
    assert not any(issue["rule"] == "term-preferred" for issue in report["issues"])


def test_qa_accepts_compound_fire_skill_names_with_hoa_ke() -> None:
    for line, source, target in (
        (9880, "强火计", "Cường Hỏa Kế"),
        (9926, "烈火计", "Liệt Hỏa Kế"),
        (28427, "神火计", "Thần Hỏa Kế"),
    ):
        report = run_legend_qa(
            [
                {
                    "line": line,
                    "source": source,
                    "oldTarget": "OLD",
                    "target": target,
                    "selected": True,
                }
            ],
            revision=1,
        )
        assert not any(
            issue["rule"] == "term-preferred" for issue in report["issues"]
        ), line


def test_qa_warns_preferred_term_in_narrative_but_errors_on_label() -> None:
    narrative = run_legend_qa(
        [
            {
                "line": 15,
                "source": "助使火计大获成功",
                "oldTarget": "OLD",
                "target": "giúp hỏa công đại thắng",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert narrative["blocking"] is False
    preferred = [issue for issue in narrative["issues"] if issue["rule"] == "term-preferred"]
    assert preferred
    assert preferred[0]["severity"] == "warning"
    assert "Dịch 火计 thành Hỏa Kế" in preferred[0]["detail"]
    assert preferred[0]["suggestions"] == [
        {"source": "火计", "reading": "Hỏa Kế", "replace": "hỏa công"}
    ]
    assert not any(issue["rule"] == "term-success" for issue in narrative["issues"])

    label = run_legend_qa(
        [
            {
                "line": 16,
                "source": "火计",
                "oldTarget": "OLD",
                "target": "hỏa công",
                "selected": True,
            }
        ],
        revision=1,
    )
    assert label["blocking"] is True
    label_detail = next(
        issue["detail"]
        for issue in label["issues"]
        if issue["rule"] == "term-success"
    )
    assert "Dịch 火计 thành Hỏa Kế" in label_detail


def test_translate_code_switches_source_and_keeps_user_glossary(
    tmp_path: Path,
) -> None:
    source_text = "曾跟随杨奉并击败袁绍于乌巢"
    source = tmp_path / "legend.txt"
    source.write_text(f"{source_text}={source_text}\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    config = replace(
        _translation_config(tmp_path),
        glossary={"袁绍": "Viên Thiệu (user)"},
    )
    switched, _ = code_switch_source(source_text, build_term_bank(config.glossary))
    client = LegendClient(
        {
            switched: (
                "Từng theo Dương Phụng, đánh bại Viên Thiệu (user) tại Ô Sào."
            )
        }
    )
    result = translate_legend(
        source,
        preview,
        config,
        client_factory=lambda _key, _timeout: client,
    )
    prompt = str(client.models.calls[0]["contents"])
    payload = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
    assert payload[0]["text"] == switched
    assert "袁绍" not in payload[0]["text"]
    assert "Viên Thiệu (user)" in payload[0]["text"]
    assert '"袁绍" -> "Viên Thiệu (user)"' in prompt
    assert '"乌巢" -> "Ô Sào"' in prompt
    target = result["diffs"][0]["target"]
    assert "绍" not in target
    assert "巢" not in target
    assert "Viên Thiệu (user)" in target
    assert "Ô Sào" in target
    assert result["glossaryHash"] == translation_glossary_hash(config.glossary, None)
    assert len(client.models.calls) == 1


def test_translate_retries_whole_sentence_when_terms_or_han_fail(
    tmp_path: Path,
) -> None:
    source_text = "曾跟随杨奉并击败袁绍于乌巢"
    source = tmp_path / "legend.txt"
    source.write_text(f"{source_text}={source_text}\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    switched, _ = code_switch_source(source_text, build_term_bank())
    client = SequenceLegendClient(
        [
            {switched: "từng theo Dương Phụng, đánh bại Viên绍 tại Ô Th巢"},
            {
                switched: (
                    "Từng theo Dương Phụng, đánh bại Viên Thiệu tại Ô Sào."
                )
            },
        ]
    )
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    target = result["diffs"][0]["target"]
    assert len(client.models.calls) == 2
    assert "Dịch lại TOÀN BỘ" in str(client.models.calls[1]["contents"])
    assert "绍" not in target
    assert "巢" not in target
    assert "Viên Thiệu" in target
    assert "Ô Sào" in target


def test_translate_retries_multiple_passes_until_clean(tmp_path: Path) -> None:
    source_text = "曾跟随杨奉并击败袁绍于乌巢"
    source = tmp_path / "legend.txt"
    source.write_text(f"{source_text}={source_text}\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    switched, _ = code_switch_source(source_text, build_term_bank())
    leftover = "từng theo Dương Phụng, đánh bại Viên绍 tại Ô Th巢"
    good = "Từng theo Dương Phụng, đánh bại Viên Thiệu tại Ô Sào."
    client = SequenceLegendClient(
        [{switched: leftover}, {switched: leftover}, {switched: good}]
    )
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    target = result["diffs"][0]["target"]
    assert len(client.models.calls) == 3
    assert "绍" not in target
    assert "Viên Thiệu" in target


def test_translate_does_not_char_replace_if_retry_still_has_han(
    tmp_path: Path,
) -> None:
    source_text = "曾跟随杨奉并击败袁绍于乌巢"
    source = tmp_path / "legend.txt"
    source.write_text(f"{source_text}={source_text}\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    switched, _ = code_switch_source(source_text, build_term_bank())
    leftover = "từng theo Dương Phụng, đánh bại Viên绍 tại Ô Th巢"
    client = SequenceLegendClient([{switched: leftover}, {switched: leftover}])
    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: client,
    )
    target = result["diffs"][0]["target"]
    assert len(client.models.calls) == 1 + legend_module.LEGEND_RETRY_MAX_PASSES
    assert "绍" in target
    assert "巢" in target
    assert "Ô Th Sào" not in target
    assert any(issue["rule"] == "han-remaining" for issue in result["qa"]["issues"])


def test_retranslate_fixes_dropped_initial_without_han(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("鄂焕=鄂焕\n", encoding="utf-8")
    preview = tmp_path / "preview.json"
    first = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient({}),
    )
    artifact = json.loads(preview.read_text(encoding="utf-8"))
    artifact["diffs"][0]["target"] = "ạc Hoán"
    artifact["diffs"][0]["effectiveTarget"] = "ạc Hoán"
    artifact["diffs"][0]["effectiveAfter"] = "ạc Hoán"
    artifact["previewId"] = legend_module._preview_identity(artifact)
    preview.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    client = LegendClient({"鄂焕": "Không được gọi"})
    retried = retranslate_legend_preview(
        preview,
        _translation_config(tmp_path),
        expected_preview_id=str(artifact["previewId"]),
        line_numbers=[int(artifact["diffs"][0]["line"])],
        client_factory=lambda _key, _timeout: client,
    )
    assert retried["diffs"][0]["target"] == "Ngạc Hoán"
    assert client.models.calls == []
    assert first["previewId"] != retried["previewId"]


def test_legend_workset_for_selected_lines() -> None:
    lines = (
        legend_module.LegendLine(1, "刘备=Lưu Bị", "\n", "entry", "刘备", "Lưu Bị", "刘备"),
        legend_module.LegendLine(2, "刘备=刘备", "\n", "entry", "刘备", "刘备", "刘备"),
        legend_module.LegendLine(3, "西川=西川", "\n", "entry", "西川", "西川", "西川"),
        legend_module.LegendLine(4, "Hello=Hello", "\n", "entry", "Hello", "Hello", "Hello"),
    )
    workset, skip_cache = legend_module._workset_for_selected_lines(
        lines,
        [2, 3],
        force_retranslate=False,
        config=None,
        translator=None,
    )
    assert workset.pending_line_numbers == frozenset({2, 3})
    assert workset.api_sources == ("西川",)
    assert workset.reuse_targets[2] == "Lưu Bị"
    assert not skip_cache

    forced, skip_cache_forced = legend_module._workset_for_selected_lines(
        lines,
        [1],
        force_retranslate=False,
        config=None,
        translator=None,
    )
    assert forced.pending_line_numbers == frozenset({1})
    assert forced.api_sources == ("刘备",)
    assert skip_cache_forced


def test_legend_workset_for_selected_lines_reuses_sibling_translation() -> None:
    lines = (
        legend_module.LegendLine(1, "刘备=Lưu Bị", "\n", "entry", "刘备", "Lưu Bị", "刘备"),
        legend_module.LegendLine(2, "刘备=刘备", "\n", "entry", "刘备", "刘备", "刘备"),
    )
    workset, skip_cache = legend_module._workset_for_selected_lines(
        lines,
        [2],
        force_retranslate=False,
        config=None,
        translator=None,
    )
    assert workset.pending_line_numbers == frozenset({2})
    assert workset.api_sources == ()
    assert workset.reuse_targets == {2: "Lưu Bị"}
    assert not skip_cache


def test_legend_row_done_and_classify_incremental_rules() -> None:
    assert legend_module.legend_row_done("刘备", "Lưu Bị")
    assert legend_module.legend_row_has_file_target("刘备", "Lưu Bị")
    assert not legend_module.legend_row_done("刘备", "刘备")
    assert legend_module.legend_row_is_placeholder("刘备", "刘备")
    assert legend_module.legend_row_is_placeholder("刘备", "")
    assert not legend_module.legend_row_done("西川", "Tây X川")
    assert legend_module.legend_row_done("Hello", "Hello")
    assert not legend_module.legend_row_done("Key", "")

    lines = (
        legend_module.LegendLine(1, "刘备=Lưu Bị", "\n", "entry", "刘备", "Lưu Bị", "刘备"),
        legend_module.LegendLine(2, "刘备=刘备", "\n", "entry", "刘备", "刘备", "刘备"),
        legend_module.LegendLine(3, "西川=西川", "\n", "entry", "西川", "西川", "西川"),
        legend_module.LegendLine(4, "Hello=Hello", "\n", "entry", "Hello", "Hello", "Hello"),
    )
    workset = legend_module.classify_legend_entries(lines, force=False)
    assert workset.done_line_numbers == frozenset({1, 4})
    assert workset.pending_line_numbers == frozenset({2, 3})
    assert workset.reuse_targets[2] == "Lưu Bị"
    assert workset.api_sources == ("西川",)
    assert workset.done_items == 1
    assert workset.placeholder_items == 2
    assert workset.reused_items == 1

    forced = legend_module.classify_legend_entries(lines, force=True)
    assert forced.api_sources == ("刘备", "西川", "Hello")
    assert forced.pending_line_numbers == frozenset({1, 2, 3, 4})
    assert forced.reuse_targets == {}


def test_unescape_legend_value_reverses_file_encoding() -> None:
    logical = "Quan hệ của <color=#00e5ee>Lương Tập</color> với ngươi +8"
    encoded = legend_module._escape_legend_value(logical)
    assert "\\=" in encoded
    assert legend_module._unescape_legend_value(encoded) == logical
    multiline = "Thông tin MOD:\nline1\nline2"
    encoded_multiline = legend_module._escape_legend_value(multiline)
    assert "\\n" in encoded_multiline
    assert legend_module._unescape_legend_value(encoded_multiline) == multiline


def test_verified_after_apply_style_color_and_newlines(tmp_path: Path) -> None:
    config = _translation_config(tmp_path)
    translator = legend_module._legend_cache_translator(config)
    cases = (
        (
            "<color=#00e5ee>梁习</color>与你的关系+8",
            "Quan hệ của <color=#00e5ee>Lương Tập</color> với ngươi +8",
        ),
        (
            "MOD信息：\\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "Thông tin MOD:\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        ),
    )
    lines: list[str] = []
    for source, target in cases:
        terms = build_term_bank(config.glossary, config.locked_glossary)
        switched, _ = code_switch_source(source, terms)
        translator._store_cached(switched, "legend", target)
        file_key = source.replace("=", r"\=")
        lines.append(f"{file_key}={legend_module._escape_legend_value(target)}")
    translator.save_cache()
    source = tmp_path / "legend.txt"
    source.write_text("\n".join(lines) + "\n", encoding="utf-8")
    document = parse_legend_file(source)
    workset = legend_module.classify_legend_entries(document.entries, config=config)
    assert workset.done_items == len(cases)
    assert workset.unverified_items == 0
    assert workset.placeholder_items == 0
    assert not workset.pending_line_numbers


def test_unverified_game_vi_without_tool_cache(tmp_path: Path) -> None:
    from translate_tool.common.translation_core import TranslationConfig

    lines = (
        legend_module.LegendLine(
            1, "梁习居=Lương Tậpcư", "\n", "entry", "梁习居", "Lương Tậpcư", "梁习居"
        ),
    )
    cache_path = tmp_path / "legend-cache.json"
    cache_path.write_text("{}", encoding="utf-8")
    config = TranslationConfig(
        api_keys=("test-key",),
        models=("gemini-test",),
        cache_path=cache_path,
        batch_size=10,
    )
    workset = legend_module.classify_legend_entries(lines, config=config)
    assert workset.unverified_items == 1
    assert workset.done_items == 1
    assert workset.pending_line_numbers == frozenset()
    assert workset.api_sources == ()
    source = tmp_path / "legend.txt"
    source.write_text("梁习居=Lương Tậpcư\n", encoding="utf-8")
    estimate = estimate_legend(source, config, worker_key_count=6)
    assert estimate["pendingItems"] == 0
    assert estimate["workersUsed"] == 0
    assert estimate["items"] == 1
    assert estimate["unverifiedItems"] == 1


def test_incremental_skips_done_reuses_sibling_and_keeps_bytes(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legend.txt"
    original = (
        "刘备=Lưu Bị\r\n"
        "刘备=刘备\r\n"
        "西川=西川\r\n"
        "Hello=Hello\r\n"
    ).encode("utf-8")
    source.write_bytes(original)
    preview = tmp_path / "preview.json"
    client = LegendClient({"西川": "Tây Xuyên"})
    calls = {"n": 0}

    def factory(_key: str, _timeout: float) -> LegendClient:
        calls["n"] += 1
        return client

    result = translate_legend(
        source,
        preview,
        _translation_config(tmp_path),
        client_factory=factory,
    )
    assert calls["n"] == 1
    assert len(client.models.calls) == 1
    staged = Path(result["stagedPath"]).read_bytes()
    assert staged.startswith("刘备=Lưu Bị\r\n".encode("utf-8"))
    text = staged.decode("utf-8")
    assert text.splitlines()[0] == "刘备=Lưu Bị"
    assert text.count("刘备=Lưu Bị") == 2
    assert "西川=Tây Xuyên" in text
    assert "Hello=Hello" in text
    assert all(diff["line"] != 1 for diff in result["diffs"])
    assert {diff["line"] for diff in result["diffs"]} == {2, 3}
    estimate = estimate_legend(source, _translation_config(tmp_path))
    assert estimate["doneItems"] == 1
    assert estimate["reusedItems"] == 1
    assert estimate["pendingItems"] == 0
    assert estimate["cachedItems"] == 1
    assert estimate["actionableItems"] == 2


def test_incremental_raises_when_everything_done(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text("刘备=Lưu Bị\nHello=Hi\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="Không còn câu cần dịch"):
        translate_legend(
            source,
            tmp_path / "preview.json",
            _translation_config(tmp_path),
            client_factory=lambda _key, _timeout: LegendClient({}),
        )


def test_force_retranslate_skips_cache(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    config = _translation_config(tmp_path)
    source.write_text("测试句子=测试句子\n", encoding="utf-8")
    translate_legend(
        source,
        tmp_path / "preview1.json",
        config,
        client_factory=lambda _key, _timeout: LegendClient(
            {"测试句子": "Bản dịch cũ"}
        ),
    )
    source.write_text("测试句子=Bản dịch cũ\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="Không còn câu cần dịch"):
        translate_legend(
            source,
            tmp_path / "preview2.json",
            config,
            client_factory=lambda _key, _timeout: LegendClient(
                {"测试句子": "Bản dịch mới"}
            ),
        )
    client = LegendClient({"测试句子": "Bản dịch mới"})
    forced = translate_legend(
        source,
        tmp_path / "preview3.json",
        config,
        force_retranslate=True,
        client_factory=lambda _key, _timeout: client,
    )
    assert len(client.models.calls) == 1
    assert forced["diffs"][0]["target"] == "Bản dịch mới"
    force_estimate = estimate_legend(source, config, force_retranslate=True)
    incr_estimate = estimate_legend(source, config, force_retranslate=False)
    assert incr_estimate["pendingItems"] == 0
    assert force_estimate["pendingItems"] == 1
    assert force_estimate["doneItems"] == 0


def test_incremental_does_not_apply_glossary_to_done_rows(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    original = "西川=Tây Xuyên cũ\n南川=南川\n".encode("utf-8")
    source.write_bytes(original)
    result = translate_legend(
        source,
        tmp_path / "preview.json",
        replace(
            _translation_config(tmp_path),
            locked_glossary={"西川": "Tây Xuyên khóa", "南川": "Nam Xuyên"},
        ),
        client_factory=lambda _key, _timeout: LegendClient({}),
    )
    staged = Path(result["stagedPath"]).read_bytes()
    assert staged.startswith("西川=Tây Xuyên cũ\n".encode("utf-8"))
    assert "南川=Nam Xuyên\n".encode("utf-8") in staged
    assert all(diff["source"] != "西川" for diff in result["diffs"])


def test_reuse_only_skips_client_and_preserves_done_bytes(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    original = "刘备=Lưu Bị\r\n刘备=刘备\r\n".encode("utf-8")
    source.write_bytes(original)
    calls = {"n": 0}

    def factory(_key: str, _timeout: float) -> LegendClient:
        calls["n"] += 1
        return LegendClient({})

    result = translate_legend(
        source,
        tmp_path / "preview.json",
        _translation_config(tmp_path),
        client_factory=factory,
    )
    assert calls["n"] == 0
    staged = Path(result["stagedPath"]).read_bytes()
    assert staged.startswith("刘备=Lưu Bị\r\n".encode("utf-8"))
    assert staged == "刘备=Lưu Bị\r\n刘备=Lưu Bị\r\n".encode("utf-8")
    assert [diff["line"] for diff in result["diffs"]] == [2]
    estimate = estimate_legend(source, _translation_config(tmp_path))
    assert estimate["pendingItems"] == 0
    assert estimate["reusedItems"] == 1
    assert estimate["actionableItems"] == 1


def test_reuse_last_win_prefers_later_done_sibling(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    source.write_text(
        "刘备=Lưu Bị cũ\n刘备=Lưu Bị mới\n刘备=刘备\n",
        encoding="utf-8",
    )
    result = translate_legend(
        source,
        tmp_path / "preview.json",
        _translation_config(tmp_path),
        client_factory=lambda _key, _timeout: LegendClient({}),
    )
    staged = Path(result["stagedPath"]).read_text(encoding="utf-8")
    assert staged.splitlines() == [
        "刘备=Lưu Bị cũ",
        "刘备=Lưu Bị mới",
        "刘备=Lưu Bị mới",
    ]
    assert [diff["line"] for diff in result["diffs"]] == [3]
    assert result["diffs"][0]["target"] == "Lưu Bị mới"


def test_perf_logic_many_done_rows_one_reuse_no_client(tmp_path: Path) -> None:
    source = tmp_path / "legend.txt"
    chunks = [f"武将{i}=Võ tướng {i}\n" for i in range(3) for _ in range(20)]
    chunks.append("西川=西川\n")
    # Make 西川 reuse from a done sibling instead of API
    chunks.append("西川=Tây Xuyên\n")
    source.write_text("".join(chunks), encoding="utf-8")
    calls = {"n": 0}

    def factory(_key: str, _timeout: float) -> LegendClient:
        calls["n"] += 1
        return LegendClient({})

    result = translate_legend(
        source,
        tmp_path / "preview.json",
        _translation_config(tmp_path),
        client_factory=factory,
    )
    assert calls["n"] == 0
    assert result["stats"]["reusedItems"] == 1
    assert all(diff["source"] == "西川" for diff in result["diffs"])


def test_noop_translation_does_not_create_empty_preview(tmp_path: Path) -> None:
    """Bản dịch trùng vế phải → không ghi staged/preview rỗng."""
    source = tmp_path / "legend.txt"
    source.write_text("测试=测试\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="Không còn câu cần dịch"):
        translate_legend(
            source,
            tmp_path / "preview.json",
            _translation_config(tmp_path),
            client_factory=lambda _key, _timeout: LegendClient({"测试": "测试"}),
        )
