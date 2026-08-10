from __future__ import annotations

from pathlib import Path

import civ7_tool.sync as sync_module
import pytest
from civ7_tool.formats import (
    collect_files,
    parse_vtt,
    parse_xml,
    tagged_entries,
    vtt_cues,
)
from civ7_tool.sync import apply_sync, preview_sync, restore_backup
from civ7_tool.types import StalePreviewError, ValidationError


def _snapshot(root: Path) -> dict[str, bytes]:
    return {
        relative.as_posix(): (root / relative).read_bytes()
        for relative in collect_files(root).values()
    }


def test_sync_preview_apply_verify_and_restore(
    tmp_path: Path, write_xml, write_vtt
) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    backups = tmp_path / "backups"
    write_xml(
        english / "text.xml",
        [
            ("Row", "A", "Hello"),
            ("Row", "C", "New"),
            ("Delete", "D", ""),
        ],
    )
    write_xml(
        vietnamese / "text.xml",
        [("Row", "A", "Xin chào"), ("Row", "B", "Cũ")],
    )
    write_xml(english / "new.xml", [("Row", "N", "New file")])
    write_xml(vietnamese / "obsolete.xml", [("Row", "O", "Old file")])
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
    before = _snapshot(vietnamese)

    preview = preview_sync(english, vietnamese)
    assert preview.summary == {"add": 1, "update": 2, "delete": 1, "unchanged": 0}
    assert not preview.errors
    assert preview.fingerprint == preview_sync(english, vietnamese).fingerprint

    # Preview mang text đúng phía: EN khi thêm, VN khi xóa — không đè bản dịch.
    by_tag = {
        (item.get("change"), item.get("tag") or item.get("timing")): item
        for action in preview.actions
        for item in action["items"]
    }
    assert by_tag[("add", "C")]["text"] == "New"
    assert by_tag[("delete", "B")]["text"] == "Cũ"
    assert by_tag[("add", "N")]["text"] == "New file"
    assert by_tag[("delete", "O")]["text"] == "Old file"
    assert by_tag[("add", "00:02.000 --> 00:03.000")]["text"] == "Two"
    assert ("update", "A") not in by_tag  # Tag khớp: giữ VN, không có trong preview

    result = apply_sync(english, vietnamese, preview.fingerprint, backups)

    assert result["verificationErrors"] == []
    assert not (vietnamese / "obsolete.xml").exists()
    assert (vietnamese / "new.xml").is_file()
    entries = {
        (element.tag, element.get("Tag")): next(
            (child.text or "" for child in element if child.tag == "Text"), ""
        )
        for element in tagged_entries(parse_xml(vietnamese / "text.xml"))
    }
    assert entries[("Row", "A")] == "Xin chào"
    assert entries[("Row", "C")] == "New"
    assert ("Row", "B") not in entries
    cues = vtt_cues(parse_vtt(vietnamese / "voice.vtt"))
    assert [cue.text for cue in cues] == ["Một", "Two"]

    restore_backup(Path(result["backup"]))
    assert _snapshot(vietnamese) == before


def test_sync_apply_rejects_stale_fingerprint(tmp_path: Path, write_xml) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    write_xml(english / "text.xml", [("Row", "A", "Hello")])
    write_xml(vietnamese / "text.xml", [("Row", "A", "Xin chào")])
    preview = preview_sync(english, vietnamese)
    write_xml(
        english / "text.xml",
        [("Row", "A", "Hello"), ("Row", "B", "Changed after preview")],
    )

    with pytest.raises(StalePreviewError):
        apply_sync(
            english,
            vietnamese,
            preview.fingerprint,
            tmp_path / "backups",
        )


def test_sync_updates_attributes_and_rolls_back_write_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    english.mkdir()
    vietnamese.mkdir()
    (english / "text.xml").write_text(
        '<GameData><EnglishText><Row Tag="A" Context="new">'
        "<Text>Hello</Text></Row></EnglishText></GameData>",
        encoding="utf-8",
    )
    (vietnamese / "text.xml").write_text(
        '<GameData><EnglishText><Row Tag="A" Context="old">'
        "<Text>Xin chào</Text></Row></EnglishText></GameData>",
        encoding="utf-8",
    )
    before = _snapshot(vietnamese)
    preview = preview_sync(english, vietnamese)
    assert preview.summary["update"] == 1

    def fail_write(*_args, **_kwargs):
        raise OSError("simulated write failure")

    monkeypatch.setattr(sync_module, "write_xml_atomic", fail_write)
    with pytest.raises(OSError, match="simulated"):
        apply_sync(
            english,
            vietnamese,
            preview.fingerprint,
            tmp_path / "backups",
        )
    assert _snapshot(vietnamese) == before


def test_sync_rejects_backup_inside_target(tmp_path: Path, write_xml) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    write_xml(english / "new.xml", [("Row", "A", "Hello")])
    vietnamese.mkdir()
    preview = preview_sync(english, vietnamese)

    with pytest.raises(ValidationError, match="backup"):
        apply_sync(
            english,
            vietnamese,
            preview.fingerprint,
            vietnamese / "backups",
        )
