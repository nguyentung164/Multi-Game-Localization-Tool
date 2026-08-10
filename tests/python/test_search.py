from __future__ import annotations

from pathlib import Path

import pytest

from civ7_tool.search import search_localization
from civ7_tool.types import ValidationError


def test_search_by_tag(write_xml, tmp_path: Path) -> None:
    english = tmp_path / "english"
    vietnamese = tmp_path / "vietnamese"
    write_xml(
        english / "AbilityText.xml",
        [
            ("Row", "LOC_ABILITY_A", "Gain strength."),
            ("Row", "LOC_ABILITY_B", "Other text."),
        ],
    )
    write_xml(
        vietnamese / "AbilityText.xml",
        [
            ("Row", "LOC_ABILITY_A", "Nhận sức mạnh."),
            ("Row", "LOC_ABILITY_B", "Khác."),
        ],
    )

    result = search_localization(english, vietnamese, "LOC_ABILITY_A", scope="tag")

    assert result["totalMatches"] == 1
    assert result["matches"][0]["tag"] == "LOC_ABILITY_A"
    assert result["matches"][0]["english"] == "Gain strength."
    assert result["matches"][0]["vietnamese"] == "Nhận sức mạnh."


def test_search_by_english_content(write_xml, tmp_path: Path) -> None:
    english = tmp_path / "english"
    vietnamese = tmp_path / "vietnamese"
    write_xml(
        english / "Text.xml",
        [("Row", "LOC_ONE", "Unique English phrase")],
    )
    write_xml(
        vietnamese / "Text.xml",
        [("Row", "LOC_ONE", "Cụm tiếng Việt")],
    )

    result = search_localization(
        english, vietnamese, "unique english", scope="english"
    )

    assert result["totalMatches"] == 1
    assert result["matches"][0]["tag"] == "LOC_ONE"


def test_search_supports_case_sensitive_matching(write_xml, tmp_path: Path) -> None:
    english = tmp_path / "english"
    write_xml(
        english / "Text.xml",
        [("Row", "LOC_ONE", "Unique English phrase")],
    )

    lower = search_localization(
        english,
        None,
        "unique",
        scope="english",
        case_sensitive=True,
    )
    exact = search_localization(
        english,
        None,
        "Unique",
        scope="english",
        case_sensitive=True,
    )

    assert lower["totalMatches"] == 0
    assert exact["totalMatches"] == 1


def test_search_supports_whole_word_matching(write_xml, tmp_path: Path) -> None:
    english = tmp_path / "english"
    write_xml(
        english / "Text.xml",
        [("Row", "LOC_COMMANDER", "Select a Commander.")],
    )

    whole = search_localization(
        english,
        None,
        "Commander",
        scope="english",
        whole_word=True,
    )
    partial = search_localization(
        english,
        None,
        "Command",
        scope="english",
        whole_word=True,
    )
    tag_prefix = search_localization(
        english,
        None,
        "LOC",
        scope="tag",
        whole_word=True,
    )

    assert whole["totalMatches"] == 1
    assert partial["totalMatches"] == 0
    assert tag_prefix["totalMatches"] == 0


def test_search_supports_vietnamese_case_sensitive_matching(
    write_xml, tmp_path: Path
) -> None:
    vietnamese = tmp_path / "vietnamese"
    write_xml(
        vietnamese / "Text.xml",
        [
            ("Row", "LOC_UPPER", "Lãnh đục"),
            ("Row", "LOC_LOWER", "lãnh đục"),
        ],
    )

    lower_query = search_localization(
        None,
        vietnamese,
        "lãnh đục",
        scope="vietnamese",
        case_sensitive=True,
    )
    assert lower_query["totalMatches"] == 1
    assert lower_query["matches"][0]["tag"] == "LOC_LOWER"


def test_search_by_file_name(write_xml, tmp_path: Path) -> None:
    english = tmp_path / "english"
    vietnamese = tmp_path / "vietnamese"
    write_xml(english / "Folder/UnitText.xml", [("Row", "LOC_UNIT", "Unit")])
    write_xml(vietnamese / "Folder/UnitText.xml", [("Row", "LOC_UNIT", "Đơn vị")])

    result = search_localization(
        english, vietnamese, "unittext.xml", scope="file"
    )

    assert result["totalMatches"] == 1
    assert result["matches"][0]["file"].endswith("Folder/UnitText.xml")


def test_search_empty_query_skips_scan(write_xml, tmp_path: Path) -> None:
    english = tmp_path / "english"
    write_xml(english / "Text.xml", [("Row", "LOC_ONE", "Hello")])

    result = search_localization(english, None, "   ")

    assert result["totalMatches"] == 0
    assert result["scannedFiles"] == 0


def test_search_requires_at_least_one_directory(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        search_localization(tmp_path / "missing-en", tmp_path / "missing-vi", "LOC")
