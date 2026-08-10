from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from civ7_tool.formats import parse_vtt, parse_xml, tagged_entries, vtt_cues
from civ7_tool.qa import run_qa
from civ7_tool.translate import (
    GeminiTranslator,
    TranslationConfig,
    translate_localization,
)
from civ7_tool.types import CancellationToken, CancelledError


class FakeModels:
    def __init__(self, handler):
        self.handler = handler
        self.calls = 0

    def generate_content(self, **kwargs):
        self.calls += 1
        return self.handler(kwargs)


class FakeClient:
    def __init__(self, handler):
        self.models = FakeModels(handler)


def translating_handler(kwargs):
    items = json.loads(kwargs["contents"].rsplit("Dữ liệu:\n", 1)[1])
    return SimpleNamespace(
        text=json.dumps(
            [{"id": item["id"], "text": f"Đã dịch {item['text']}"} for item in items],
            ensure_ascii=False,
        )
    )


def test_translate_xml_vtt_skips_names_and_runs_qa(
    tmp_path: Path, write_xml, write_vtt
) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    write_xml(english / "text.xml", [("Row", "A", "Hello {1_name}")])
    write_xml(vietnamese / "text.xml", [("Row", "A", "Hello {1_name}")])
    write_xml(english / "CityNamesText.xml", [("Row", "CITY", "London")])
    write_xml(vietnamese / "CityNamesText.xml", [("Row", "CITY", "London")])
    write_vtt(
        english / "voice.vtt",
        [("00:00.000 --> 00:01.000", "Welcome [ICON:GOLD]")],
    )
    write_vtt(
        vietnamese / "voice.vtt",
        [("00:00.000 --> 00:01.000", "Welcome [ICON:GOLD]")],
    )
    client = FakeClient(translating_handler)
    config = TranslationConfig(
        api_keys=("secret-key",),
        models=("model-a",),
        cache_path=tmp_path / "cache.json",
        delay_seconds=0,
        timeout_seconds=5,
    )

    result = translate_localization(
        english,
        vietnamese,
        config,
        client_factory=lambda _key, _timeout: client,
    )

    assert result["stats"]["itemsTranslated"] == 2
    assert result["qa"]["passed"] is True
    xml_entry = tagged_entries(parse_xml(vietnamese / "text.xml"))[0]
    assert next(child.text for child in xml_entry if child.tag == "Text") == (
        "Đã dịch Hello {1_name}"
    )
    name_entry = tagged_entries(parse_xml(vietnamese / "CityNamesText.xml"))[0]
    assert next(child.text for child in name_entry if child.tag == "Text") == "London"
    assert vtt_cues(parse_vtt(vietnamese / "voice.vtt"))[0].text == (
        "Đã dịch Welcome [ICON:GOLD]"
    )


def test_translation_cache_resumes_without_api_call(tmp_path: Path) -> None:
    cache_path = tmp_path / "cache.json"
    first_client = FakeClient(translating_handler)
    config = TranslationConfig(
        api_keys=("key",),
        models=("model",),
        cache_path=cache_path,
        delay_seconds=0,
        timeout_seconds=5,
    )
    first = GeminiTranslator(config, client_factory=lambda _key, _timeout: first_client)
    items = [{"id": "1", "text": "Hello {x}"}]
    assert first.translate_items(items, "game", "file.xml")["1"] == (
        "Đã dịch Hello {x}"
    )
    assert first_client.models.calls == 1

    fail_client = FakeClient(
        lambda _kwargs: (_ for _ in ()).throw(AssertionError("API must not run"))
    )
    resumed = GeminiTranslator(
        config, client_factory=lambda _key, _timeout: fail_client
    )
    assert resumed.translate_items(items, "game", "file.xml")["1"] == (
        "Đã dịch Hello {x}"
    )
    assert fail_client.models.calls == 0


def test_gemini_falls_back_from_exhausted_key(tmp_path: Path) -> None:
    created: list[str] = []

    def factory(key: str, _timeout: float):
        created.append(key)
        if key == "key-1":
            return FakeClient(
                lambda _kwargs: (_ for _ in ()).throw(
                    RuntimeError("429 RESOURCE_EXHAUSTED perDay limit: 0")
                )
            )
        return FakeClient(translating_handler)

    translator = GeminiTranslator(
        TranslationConfig(
            api_keys=("key-1", "key-2"),
            models=("model",),
            cache_path=tmp_path / "cache.json",
            delay_seconds=0,
            timeout_seconds=5,
        ),
        client_factory=factory,
    )

    result = translator.translate_items(
        [{"id": "1", "text": "Hello"}], "game", "file.xml"
    )

    assert result["1"] == "Đã dịch Hello"
    assert created == ["key-1", "key-2"]
    assert translator.stats.keys_used == 2


def test_cancelled_translation_stops_before_api(tmp_path: Path) -> None:
    token = CancellationToken()
    token.cancel()
    client = FakeClient(translating_handler)
    translator = GeminiTranslator(
        TranslationConfig(
            api_keys=("key",),
            models=("model",),
            cache_path=tmp_path / "cache.json",
            delay_seconds=0,
            timeout_seconds=5,
        ),
        cancel=token,
        client_factory=lambda _key, _timeout: client,
    )
    with pytest.raises(CancelledError):
        translator.translate_items([{"id": "1", "text": "Hello"}], "game", "x")
    assert client.models.calls == 0


def test_inflight_translation_cancels_without_waiting_for_request(
    tmp_path: Path,
) -> None:
    token = CancellationToken()
    release = threading.Event()
    client = FakeClient(
        lambda _kwargs: (release.wait(1), translating_handler(_kwargs))[1]
    )
    translator = GeminiTranslator(
        TranslationConfig(
            api_keys=("key",),
            models=("model",),
            cache_path=tmp_path / "cache.json",
            delay_seconds=0,
            timeout_seconds=5,
        ),
        cancel=token,
        client_factory=lambda _key, _timeout: client,
    )
    timer = threading.Timer(0.05, token.cancel)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(CancelledError):
            translator.translate_items([{"id": "1", "text": "Hello"}], "game", "x")
        assert time.monotonic() - started < 0.5
    finally:
        release.set()
        timer.cancel()


def test_qa_reports_untranslated_and_missing_token(tmp_path: Path, write_xml) -> None:
    english = tmp_path / "en"
    vietnamese = tmp_path / "vi"
    write_xml(english / "text.xml", [("Row", "A", "Gain {amount} Gold")])
    write_xml(vietnamese / "text.xml", [("Row", "A", "Gain Gold")])

    result = run_qa(vietnamese, english)

    assert result["passed"] is False
    assert result["issueCounts"]["untranslated"] == 1
    assert result["issueCounts"]["missing-token"] == 1
    by_kind = {item["kind"]: item for item in result["issues"]}
    assert by_kind["untranslated"]["source"] == "Gain {amount} Gold"
    assert by_kind["untranslated"]["text"] == "Gain Gold"
    assert by_kind["missing-token"]["source"] == "Gain {amount} Gold"
    assert by_kind["missing-token"]["text"] == "Gain Gold"
    assert by_kind["missing-token"]["tokens"] == ["{amount}"]
