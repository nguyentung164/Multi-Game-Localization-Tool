from __future__ import annotations

import errno
from pathlib import Path

import pytest
from civ7_tool.inventory import export_game_files, inspect_localization
from civ7_tool.types import ValidationError


def test_export_filters_and_atomically_replaces_destination(
    tmp_path: Path, write_xml, write_vtt
) -> None:
    game = tmp_path / "game"
    destination = tmp_path / "staging"
    write_xml(game / "base" / "text.xml", [("Row", "A", "Hello")])
    (game / "base" / "ignored.xml").write_text(
        "<GameData><Rows /></GameData>", encoding="utf-8"
    )
    write_vtt(game / "audio" / "line.vtt", [("00:00.000 --> 00:01.000", "Hi")])
    write_xml(game / "l10n" / "localized.xml", [("Row", "L", "Localized")])
    write_vtt(game / "L10N" / "localized.vtt", [("00:00.000 --> 00:01.000", "No")])
    destination.mkdir()
    (destination / "stale.txt").write_text("old", encoding="utf-8")

    progress: list[dict] = []

    def capture(event: str, step: str, payload: dict) -> None:
        if event == "progress" and step == "export":
            progress.append(payload)

    result = export_game_files(game, destination, reporter=capture)

    assert result["xmlFiles"] == 1
    assert result["vttFiles"] == 1
    assert (destination / "base" / "text.xml").is_file()
    assert (destination / "audio" / "line.vtt").is_file()
    assert not (destination / "base" / "ignored.xml").exists()
    assert not (destination / "l10n").exists()
    assert not (destination / "stale.txt").exists()
    assert any(
        item.get("phase") == "scan"
        and item.get("processed") == 0
        and item.get("total") == 2
        for item in progress
    )
    copy_events = [item for item in progress if item.get("phase") == "copy"]
    assert len(copy_events) == 2
    assert {item["path"] for item in copy_events} == {
        "audio/line.vtt",
        "base/text.xml",
    }
    assert copy_events[-1]["processed"] == 2
    assert copy_events[-1]["total"] == 2
    assert copy_events[-1]["copied"] == 2


def test_inspect_inventory_and_en_vi_diff(tmp_path: Path, write_xml, write_vtt) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    write_xml(
        english / "text.xml",
        [
            ("Row", "A", "Hello"),
            ("Replace", "B", "World"),
            ("Delete", "C", ""),
        ],
    )
    write_xml(vietnamese / "text.xml", [("Row", "A", "Xin chào")])
    write_vtt(
        english / "voice.vtt",
        [
            ("00:00.000 --> 00:01.000", "One"),
            ("00:02.000 --> 00:03.000", "Two"),
        ],
    )
    write_vtt(
        vietnamese / "voice.vtt",
        [("00:00.000 --> 00:01.000", "Một")],
    )
    (vietnamese / "broken.xml").write_text("<GameData><EnglishText>", encoding="utf-8")

    result = inspect_localization(english, vietnamese)

    assert result["english"] == {
        "xmlFiles": 1,
        "vttFiles": 1,
        "rows": 1,
        "replaces": 1,
        "deletes": 1,
        "cues": 2,
        "invalid": [],
    }
    assert result["vietnamese"]["xmlFiles"] == 2
    assert len(result["vietnamese"]["invalid"]) == 1
    statuses = {item["file"]: item["status"] for item in result["diff"]["files"]}
    assert statuses["text.xml"] == "different"
    assert statuses["voice.vtt"] == "different"
    assert statuses["broken.xml"] == "vietnamese-only"


def test_export_rejects_overlapping_roots(tmp_path: Path) -> None:
    game = tmp_path / "game"
    game.mkdir()
    with pytest.raises(ValidationError):
        export_game_files(game, game / "export")
    with pytest.raises(ValidationError):
        export_game_files(game, tmp_path)


def test_publish_directory_falls_back_to_copytree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from civ7_tool.inventory import _publish_directory

    staging = tmp_path / ".english.staging-test"
    destination = tmp_path / "english"
    previous = tmp_path / ".english.previous-test"
    staging.mkdir()
    (staging / "a.xml").write_text("<GameData />", encoding="utf-8")
    destination.mkdir()
    (destination / "old.xml").write_text("old", encoding="utf-8")

    def denied_replace(src: object, dst: object) -> None:
        raise PermissionError(errno.EACCES, "Access is denied")

    monkeypatch.setattr("civ7_tool.inventory.os.replace", denied_replace)
    monkeypatch.setattr("civ7_tool.inventory.time.sleep", lambda _: None)

    _publish_directory(staging, destination, previous)

    assert destination.is_dir()
    assert (destination / "a.xml").is_file()
    assert not (destination / "old.xml").exists()
    assert not staging.exists()
    assert not previous.exists()
