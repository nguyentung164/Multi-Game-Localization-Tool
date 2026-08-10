from __future__ import annotations

from pathlib import Path

from civ7_tool.formats import parse_vtt, parse_xml, tagged_entries, vtt_cues


def test_parse_vtt_cp1252_en_dash(tmp_path: Path) -> None:
    path = tmp_path / "legacy.vtt"
    path.write_bytes(
        b"WEBVTT\r\n\r\n"
        b"1\r\n"
        b"00:00.000 --> 00:02.000\r\n"
        b"Britain \x97 economic legacy\r\n"
    )

    cues = vtt_cues(parse_vtt(path))

    assert len(cues) == 1
    assert cues[0].text == "Britain \u2014 economic legacy"


def test_parse_xml_cp1252_when_declaration_mismatches(tmp_path: Path) -> None:
    path = tmp_path / "text.xml"
    path.write_bytes(
        b'<?xml version="1.0" encoding="utf-8"?>\n'
        b'<GameData><EnglishText>'
        b'<Row Tag="TEST"><Text>Dash \x97 here</Text></Row>'
        b"</EnglishText></GameData>"
    )

    entries = tagged_entries(parse_xml(path))

    assert len(entries) == 1
    assert entries[0].find("Text").text == "Dash \u2014 here"
