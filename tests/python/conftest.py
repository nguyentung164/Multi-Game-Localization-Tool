from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "engine"
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))


@pytest.fixture
def write_xml():
    def factory(path: Path, entries: list[tuple[str, str, str]]) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        body = "\n".join(
            f'    <{kind} Tag="{tag}"><Text>{text}</Text></{kind}>'
            for kind, tag, text in entries
        )
        path.write_text(
            f'<?xml version="1.0" encoding="utf-8"?>\n'
            f"<GameData><EnglishText>\n{body}\n</EnglishText></GameData>\n",
            encoding="utf-8",
        )
        return path

    return factory


@pytest.fixture
def write_vtt():
    def factory(path: Path, cues: list[tuple[str, str]]) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        blocks = ["WEBVTT"] + [
            f"{index}\n{timing}\n{text}"
            for index, (timing, text) in enumerate(cues, start=1)
        ]
        path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
        return path

    return factory
