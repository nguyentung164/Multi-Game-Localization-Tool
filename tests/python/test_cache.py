from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from civ7_tool.language import text_hash
from civ7_tool.translate import GeminiTranslator, TranslationConfig


class _FakeModels:
    def generate_content(self, **_kwargs):
        return SimpleNamespace(text="{}")


class _FakeClient:
    models = _FakeModels()


def test_legacy_cache_key_is_reused(tmp_path: Path) -> None:
    cache_file = tmp_path / "translation_cache_gemini.json"
    source = "Gain {1_Amount} Combat Strength near a Coast."
    legacy_key = text_hash(source)
    cache_file.write_text(
        json.dumps({legacy_key: "Nhận sức mạnh chiến đấu gần bờ biển."}, ensure_ascii=False),
        encoding="utf-8",
    )

    translator = GeminiTranslator(
        TranslationConfig(
            api_keys=("secret",),
            models=("model",),
            cache_path=cache_file,
            delay_seconds=0,
            timeout_seconds=5,
        ),
        client_factory=lambda _key, _timeout: _FakeClient(),
    )

    cached = translator._lookup_cached(source, "game")
    assert cached == "Nhận sức mạnh chiến đấu gần bờ biển."


def test_save_cache_writes_flat_json(tmp_path: Path) -> None:
    cache_file = tmp_path / "translation_cache_gemini.json"
    translator = GeminiTranslator(
        TranslationConfig(
            api_keys=("secret",),
            models=("model",),
            cache_path=cache_file,
            delay_seconds=0,
            timeout_seconds=5,
        ),
        client_factory=lambda _key, _timeout: _FakeClient(),
    )
    translator._store_cached("Hello", "game", "Xin chào")
    translator.save_cache()

    data = json.loads(cache_file.read_text(encoding="utf-8"))
    assert "items" not in data
    assert isinstance(data, dict)
    assert any(value == "Xin chào" for value in data.values())
