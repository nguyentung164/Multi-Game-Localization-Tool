from __future__ import annotations

import json
import threading
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from translate_tool.civ7.translate import (
    CIV7_PROFILE,
    GeminiTranslator as Civ7Translator,
    translate_localization,
)
from translate_tool.common import translation_core
from translate_tool.common.language import text_hash
from translate_tool.common.translation_core import (
    GeminiTranslator,
    TranslationConfig,
    TranslationProfile,
    estimate_batches_for_counts,
    estimate_worker_count,
    response_config,
)
from translate_tool.common.types import CancellationToken, QuotaExhaustedError


class FakeModels:
    def __init__(self, translations: dict[str, str] | None = None) -> None:
        self.translations = translations or {}
        self.calls: list[dict[str, object]] = []

    def generate_content(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        prompt = str(kwargs["contents"])
        items = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
        rows = [
            {"id": item["id"], "text": self.translations.get(item["text"], item["text"])}
            for item in items
        ]
        return SimpleNamespace(text=json.dumps(rows, ensure_ascii=False))


class FakeClient:
    def __init__(self, translations: dict[str, str] | None = None) -> None:
        self.models = FakeModels(translations)


def _config(cache_path: Path) -> TranslationConfig:
    return TranslationConfig(
        api_keys=("test-key",),
        models=("gemini-test",),
        cache_path=cache_path,
        delay_seconds=0,
        timeout_seconds=2,
    )


def test_profile_prompt_hash_tracks_prompt_and_styles() -> None:
    first = TranslationProfile("game", "zh", "vi", "instruction", {"default": "a"})
    same = TranslationProfile("game", "zh", "vi", "instruction", {"default": "a"})
    changed = TranslationProfile("game", "zh", "vi", "instruction", {"default": "b"})
    assert first.prompt_hash == same.prompt_hash
    assert first.prompt_hash != changed.prompt_hash


def test_generate_config_uses_system_instruction_and_json_schema() -> None:
    config = response_config(CIV7_PROFILE)
    if isinstance(config, dict):
        assert config["system_instruction"] == CIV7_PROFILE.system_instruction
        assert config["response_mime_type"] == "application/json"
        thinking = config["thinking_config"]
        assert thinking["thinking_level"] == "high"
    else:
        assert config.system_instruction == CIV7_PROFILE.system_instruction
        assert config.response_mime_type == "application/json"
        assert config.response_schema is not None
        thinking = config.thinking_config
        assert thinking is not None
        level = getattr(thinking, "thinking_level", None)
        budget = getattr(thinking, "thinking_budget", None)
        assert level in {"high", "HIGH"} or (
            level is not None and str(level).lower().endswith("high")
        ) or budget == 4096
        assert getattr(thinking, "include_thoughts", None) not in {True}


def test_cache_is_namespaced_and_legacy_cache_is_ignored(tmp_path: Path) -> None:
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps({"legacy-hash": "legacy", "items": {}}), encoding="utf-8")
    client = FakeClient()
    first = GeminiTranslator(
        _config(cache),
        TranslationProfile("first", "zh", "vi", "one", {"default": "style"}),
        client_factory=lambda _key, _timeout: client,
    )
    second = GeminiTranslator(
        _config(cache),
        TranslationProfile("second", "zh", "vi", "one", {"default": "style"}),
        client_factory=lambda _key, _timeout: client,
    )
    assert first.cache == {}
    assert first._cache_key("text", "default") != second._cache_key("text", "default")

    first._store_cached("text", "default", "dịch")
    first.save_cache()
    stored = json.loads(cache.read_text(encoding="utf-8"))
    assert stored["version"] == 2
    assert list(stored["items"].values()) == ["dịch"]


def test_civ7_adapter_keeps_old_constructor_and_translation_behavior(
    tmp_path: Path,
) -> None:
    client = FakeClient({"Hello {PLAYER}": "Xin chào {PLAYER}"})
    translator = Civ7Translator(
        _config(tmp_path / "cache.json"),
        client_factory=lambda _key, _timeout: client,
    )
    result = translator.translate_items(
        [{"id": "1", "text": "Hello {PLAYER}"}], "game", "GameText.xml"
    )
    assert result == {"1": "Xin chào {PLAYER}"}
    call = client.models.calls[0]
    generated = call["config"]
    instruction = (
        generated["system_instruction"]
        if isinstance(generated, dict)
        else generated.system_instruction
    )
    assert "Civilization VII" in str(instruction)


def test_civ7_migrates_legacy_cache_without_leaking_to_other_profiles(
    tmp_path: Path,
) -> None:
    cache = tmp_path / "cache.json"
    source = "Legacy text"
    legacy_key = text_hash(source)
    cache.write_text(
        json.dumps({legacy_key: "Bản dịch cũ"}, ensure_ascii=False),
        encoding="utf-8",
    )
    civ7_client = FakeClient()
    civ7 = Civ7Translator(
        _config(cache),
        client_factory=lambda _key, _timeout: civ7_client,
    )
    assert civ7.translate_items(
        [{"id": "civ7", "text": source}], "game", "GameText.xml"
    ) == {"civ7": "Bản dịch cũ"}
    assert civ7_client.models.calls == []

    other_client = FakeClient({source: "Bản dịch mới"})
    other = GeminiTranslator(
        _config(cache),
        TranslationProfile("other", "zh", "vi", "other", {"default": "style"}),
        client_factory=lambda _key, _timeout: other_client,
    )
    assert other.translate_items(
        [{"id": "other", "text": source}], "default", "Other.txt"
    ) == {"other": "Bản dịch mới"}
    assert len(other_client.models.calls) == 1


def test_response_config_is_prepared_before_timed_api_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_response_config = translation_core.response_config

    def slow_response_config(profile: TranslationProfile) -> object:
        time.sleep(1.2)
        return real_response_config(profile)

    monkeypatch.setattr(translation_core, "response_config", slow_response_config)
    client = FakeClient({"Hello": "Xin chào"})
    translator = GeminiTranslator(
        TranslationConfig(
            api_keys=("test-key",),
            models=("gemini-test",),
            cache_path=tmp_path / "cache.json",
            delay_seconds=0,
            timeout_seconds=1,
            max_retries=1,
        ),
        TranslationProfile("game", "zh", "vi", "instruction", {"default": "style"}),
        client_factory=lambda _key, _timeout: client,
    )
    assert translator.translate_items(
        [{"id": "1", "text": "Hello"}], "default", "file.txt"
    ) == {"1": "Xin chào"}
    assert len(client.models.calls) == 1


def test_skip_cache_bypasses_existing_entry(tmp_path: Path) -> None:
    cache = tmp_path / "cache.json"
    first_client = FakeClient({"Hello": "Xin chào"})
    translator = GeminiTranslator(
        _config(cache),
        TranslationProfile("game", "zh", "vi", "instruction", {"default": "style"}),
        client_factory=lambda _key, _timeout: first_client,
    )
    assert translator.translate_items(
        [{"id": "1", "text": "Hello"}], "default", "file.txt"
    ) == {"1": "Xin chào"}

    second_client = FakeClient({"Hello": "Chào lại"})
    retry = GeminiTranslator(
        _config(cache),
        TranslationProfile("game", "zh", "vi", "instruction", {"default": "style"}),
        client_factory=lambda _key, _timeout: second_client,
    )
    assert retry.translate_items(
        [{"id": "1", "text": "Hello"}], "default", "file.txt"
    ) == {"1": "Xin chào"}
    assert second_client.models.calls == []
    assert retry.translate_items(
        [{"id": "1", "text": "Hello"}], "default", "file.txt", skip_cache=True
    ) == {"1": "Chào lại"}
    assert len(second_client.models.calls) == 1


def test_legend_style_does_not_cache_or_reuse_han_leftovers(tmp_path: Path) -> None:
    cache = tmp_path / "cache.json"
    profile = TranslationProfile(
        "legend-test", "zh", "vi", "instruction", {"legend": "style"}
    )
    first = GeminiTranslator(
        _config(cache),
        profile,
        client_factory=lambda _key, _timeout: FakeClient({"西川": "Tây X川"}),
    )
    assert first.translate_items(
        [{"id": "1", "text": "西川"}], "legend", "file.txt"
    ) == {"1": "Tây X川"}
    stored = json.loads(cache.read_text(encoding="utf-8"))
    assert list(stored.get("items", {}).values()) == []

    second_client = FakeClient({"西川": "Tây Xuyên"})
    retry = GeminiTranslator(
        _config(cache),
        profile,
        client_factory=lambda _key, _timeout: second_client,
    )
    assert retry.translate_items(
        [{"id": "1", "text": "西川"}], "legend", "file.txt"
    ) == {"1": "Tây Xuyên"}
    assert len(second_client.models.calls) == 1

    third_client = FakeClient({"西川": "Không được gọi"})
    cached = GeminiTranslator(
        _config(cache),
        profile,
        client_factory=lambda _key, _timeout: third_client,
    )
    assert cached.translate_items(
        [{"id": "1", "text": "西川"}], "legend", "file.txt"
    ) == {"1": "Tây Xuyên"}
    assert third_client.models.calls == []


def test_token_repair_preserves_translated_angle_label_tags(tmp_path: Path) -> None:
    class RepairModels(FakeModels):
        def generate_content(self, **kwargs: object) -> object:
            self.calls.append(kwargs)
            prompt = str(kwargs["contents"])
            items = json.loads(prompt.split("Dữ liệu:\n", 1)[1].split("\n\nSỬA KẾT QUẢ:", 1)[0])
            if len(self.calls) == 1:
                rows = [{"id": items[0]["id"], "text": "Gặp hai thế lực."}]
            else:
                rows = [
                    {
                        "id": items[0]["id"],
                        "text": "Gặp <Thế lực Lưu Thiện> và <Thế lực Mạnh Hoạch>.",
                    }
                ]
            return SimpleNamespace(text=json.dumps(rows, ensure_ascii=False))

    class RepairClient:
        def __init__(self) -> None:
            self.models = RepairModels()

    client = RepairClient()
    translator = GeminiTranslator(
        _config(tmp_path / "cache.json"),
        TranslationProfile("legend-test", "zh", "vi", "instruction", {"legend": "style"}),
        client_factory=lambda _key, _timeout: client,
    )

    assert translator.translate_items(
        [{"id": "token-tag", "text": "遇到<刘禅势力>和<孟获势力>。"}],
        "legend",
        "Legend JSON",
    ) == {"token-tag": "Gặp <Thế lực Lưu Thiện> và <Thế lực Mạnh Hoạch>."}
    assert len(client.models.calls) == 2
    assert "SỬA KẾT QUẢ" in str(client.models.calls[1]["contents"])
    assert "<刘禅势力>" in str(client.models.calls[1]["contents"])


def _profile() -> TranslationProfile:
    return TranslationProfile("game", "zh", "vi", "instruction", {"default": "style"})


def test_estimate_worker_count_matches_min_keys_batches() -> None:
    assert estimate_worker_count(4, 5, 40) == (1, 4, 1)
    assert estimate_worker_count(160, 5, 40) == (4, 1, 4)
    assert estimate_worker_count(0, 5, 40) == (0, 5, 0)
    # 3 file × 10 câu, batch 40: mỗi file 1 batch → 3 luồng (không gộp thành 1).
    assert estimate_batches_for_counts([10, 10, 10], 40) == 3
    assert estimate_batches_for_counts([30], 40) == 1


def test_two_keys_run_batches_in_parallel(tmp_path: Path) -> None:
    barrier = threading.Barrier(2, timeout=5)
    in_flight = 0
    peak = 0
    lock = threading.Lock()

    class ParallelModels(FakeModels):
        def generate_content(self, **kwargs: object) -> object:
            nonlocal in_flight, peak
            with lock:
                in_flight += 1
                peak = max(peak, in_flight)
            barrier.wait()
            try:
                return super().generate_content(**kwargs)
            finally:
                with lock:
                    in_flight -= 1

    class ParallelClient(FakeClient):
        def __init__(self) -> None:
            self.models = ParallelModels(
                {f"Text {index}": f"VN {index}" for index in range(1, 3)}
            )

    config = replace(
        _config(tmp_path / "parallel-cache.json"),
        api_keys=("key-a", "key-b"),
        batch_size=1,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=lambda _key, _timeout: ParallelClient(),
    )
    result = translator.translate_items(
        [{"id": "1", "text": "Text 1"}, {"id": "2", "text": "Text 2"}],
        "default",
        "file.txt",
    )
    assert result == {"1": "VN 1", "2": "VN 2"}
    assert peak >= 2
    assert translator._workers_used == 2


def test_five_keys_four_items_only_one_worker_calls_api(tmp_path: Path) -> None:
    created: list[str] = []
    clients: dict[str, FakeClient] = {}

    def factory(api_key: str, _timeout: float) -> FakeClient:
        created.append(api_key)
        client = FakeClient({f"Item {index}": f"VN {index}" for index in range(1, 5)})
        clients[api_key] = client
        return client

    config = replace(
        _config(tmp_path / "spare-idle.json"),
        api_keys=tuple(f"key-{index}" for index in range(1, 6)),
        batch_size=40,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=factory,
    )
    items = [{"id": str(index), "text": f"Item {index}"} for index in range(1, 5)]
    result = translator.translate_items(items, "default", "file.txt")
    assert result == {str(index): f"VN {index}" for index in range(1, 5)}
    assert translator._workers_used == 1
    assert len(created) == 1
    assert sum(len(client.models.calls) for client in clients.values()) == 1


def test_cross_file_buckets_spawn_one_worker_per_file_batch(tmp_path: Path) -> None:
    """3 file × 10 câu, batch_size=40 → 3 batch (không gộp thành 1)."""
    created: list[str] = []
    api_phases = 0

    def reporter(level: str, _step: str, payload: dict[str, object]) -> None:
        nonlocal api_phases
        if level == "progress" and payload.get("phase") == "api":
            api_phases += 1

    class FileAwareModels(FakeModels):
        def generate_content(self, **kwargs: object) -> object:
            prompt = str(kwargs["contents"])
            items = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
            rows = [{"id": item["id"], "text": f"VN-{item['text']}"} for item in items]
            return SimpleNamespace(text=json.dumps(rows, ensure_ascii=False))

    class FileAwareClient(FakeClient):
        def __init__(self) -> None:
            self.models = FileAwareModels()

    def factory(api_key: str, _timeout: float) -> FileAwareClient:
        created.append(api_key)
        return FileAwareClient()

    config = replace(
        _config(tmp_path / "buckets.json"),
        api_keys=tuple(f"key-{index}" for index in range(1, 6)),
        batch_size=40,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        reporter=reporter,
        client_factory=factory,
    )
    groups = [
        (
            [
                {"id": f"f{file_idx}-{item}", "text": f"T{file_idx}-{item}"}
                for item in range(10)
            ],
            "default",
            f"file{file_idx}.xml",
        )
        for file_idx in range(1, 4)
    ]
    result = translator.translate_groups(groups)
    assert len(result) == 30
    assert translator._workers_used == 3
    assert len(set(created)) == 3
    # Một phase=api mỗi batch — không emit trùng làm localRequests x2.
    assert api_phases == 3


def test_spare_key_swaps_in_thread_on_daily_quota(tmp_path: Path) -> None:
    warnings: list[dict[str, object]] = []

    def reporter(level: str, _step: str, payload: dict[str, object]) -> None:
        if level == "warning":
            warnings.append(payload)

    class QuotaModels(FakeModels):
        def __init__(self, api_key: str) -> None:
            super().__init__({"Hello": "Xin chào"})
            self.api_key = api_key

        def generate_content(self, **kwargs: object) -> object:
            if self.api_key == "key-1":
                raise RuntimeError("429 RESOURCE_EXHAUSTED perday Limit: 0")
            return super().generate_content(**kwargs)

    class QuotaClient(FakeClient):
        def __init__(self, api_key: str) -> None:
            self.models = QuotaModels(api_key)

    config = replace(
        _config(tmp_path / "spare-swap.json"),
        api_keys=("key-1", "key-2"),
        batch_size=40,
        models=("gemini-test",),
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        reporter=reporter,
        client_factory=lambda key, _timeout: QuotaClient(key),
    )
    assert translator.translate_items(
        [{"id": "1", "text": "Hello"}], "default", "file.txt"
    ) == {"1": "Xin chào"}
    spare_events = [
        item
        for item in warnings
        if item.get("phase") == "endpoint-switch" and item.get("switchKind") == "spare"
    ]
    assert spare_events
    assert spare_events[0]["fromKeyIndex"] == 1
    assert spare_events[0]["keyIndex"] == 2


@pytest.mark.parametrize("key_count", [3, 8, 12])
def test_single_bucket_uses_every_active_key(tmp_path: Path, key_count: int) -> None:
    created: list[str] = []

    def factory(api_key: str, _timeout: float) -> FakeClient:
        created.append(api_key)
        return FakeClient(
            {f"T{index}": f"V{index}" for index in range(1, key_count + 1)}
        )

    config = replace(
        _config(tmp_path / f"keys-{key_count}.json"),
        api_keys=tuple(f"key-{index}" for index in range(1, key_count + 1)),
        batch_size=1,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=factory,
    )
    items = [
        {"id": str(index), "text": f"T{index}"} for index in range(1, key_count + 1)
    ]
    result = translator.translate_items(items, "default", "file.txt")
    assert len(result) == key_count
    assert translator._workers_used == key_count
    assert set(created) == {f"key-{index}" for index in range(1, key_count + 1)}


def test_one_key_quota_lets_remaining_keys_finish_job(tmp_path: Path) -> None:
    key_count = 8
    created: list[str] = []
    warnings: list[dict[str, object]] = []

    def reporter(level: str, _step: str, payload: dict[str, object]) -> None:
        if level == "warning":
            warnings.append(payload)

    class QuotaModels(FakeModels):
        def __init__(self, api_key: str) -> None:
            super().__init__(
                {f"T{index}": f"V{index}" for index in range(1, key_count + 1)}
            )
            self.api_key = api_key

        def generate_content(self, **kwargs: object) -> object:
            if self.api_key == "key-1":
                raise RuntimeError("429 RESOURCE_EXHAUSTED perday Limit: 0")
            return super().generate_content(**kwargs)

    class QuotaClient(FakeClient):
        def __init__(self, api_key: str) -> None:
            self.models = QuotaModels(api_key)

    def factory(api_key: str, _timeout: float) -> QuotaClient:
        created.append(api_key)
        return QuotaClient(api_key)

    config = replace(
        _config(tmp_path / "retire-key.json"),
        api_keys=tuple(f"key-{index}" for index in range(1, key_count + 1)),
        batch_size=1,
        models=("gemini-test",),
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        reporter=reporter,
        client_factory=factory,
    )
    items = [
        {"id": str(index), "text": f"T{index}"} for index in range(1, key_count + 1)
    ]
    result = translator.translate_items(items, "default", "file.txt")
    assert len(result) == key_count
    assert "key-1" in created
    assert len(set(created) - {"key-1"}) >= 2
    assert any(
        item.get("switchKind") == "retire" and item.get("keyIndex") == 1
        for item in warnings
    )


def test_idle_workers_wait_for_requeued_batch_after_key_quota(
    tmp_path: Path,
) -> None:
    created: list[str] = []
    lock = threading.Lock()
    key1_started = threading.Event()

    class DelayedQuotaModels(FakeModels):
        def __init__(self, api_key: str) -> None:
            super().__init__({"A": "Một", "B": "Hai"})
            self.api_key = api_key

        def generate_content(self, **kwargs: object) -> object:
            if self.api_key == "key-1":
                key1_started.set()
                time.sleep(0.35)
                raise RuntimeError("429 RESOURCE_EXHAUSTED perday Limit: 0")
            key1_started.wait(timeout=2)
            return super().generate_content(**kwargs)

    class DelayedQuotaClient(FakeClient):
        def __init__(self, api_key: str) -> None:
            self.models = DelayedQuotaModels(api_key)

    def factory(api_key: str, _timeout: float) -> DelayedQuotaClient:
        with lock:
            created.append(api_key)
        return DelayedQuotaClient(api_key)

    config = replace(
        _config(tmp_path / "requeue-wait.json"),
        api_keys=("key-1", "key-2"),
        batch_size=1,
        models=("gemini-test",),
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=factory,
    )
    result = translator.translate_items(
        [{"id": "1", "text": "A"}, {"id": "2", "text": "B"}],
        "default",
        "file.txt",
    )
    assert result == {"1": "Một", "2": "Hai"}
    assert "key-1" in created
    assert "key-2" in created


def test_cancel_stops_parallel_workers(tmp_path: Path) -> None:
    cancel = CancellationToken()
    started = threading.Event()

    class SlowModels(FakeModels):
        def generate_content(self, **kwargs: object) -> object:
            started.set()
            time.sleep(0.4)
            return super().generate_content(**kwargs)

    class SlowClient(FakeClient):
        def __init__(self) -> None:
            self.models = SlowModels({"A": "1", "B": "2", "C": "3", "D": "4"})

    config = replace(
        _config(tmp_path / "cancel.json"),
        api_keys=("k1", "k2"),
        batch_size=1,
        timeout_seconds=5,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        cancel=cancel,
        client_factory=lambda _key, _timeout: SlowClient(),
    )

    def run() -> None:
        try:
            translator.translate_items(
                [
                    {"id": "1", "text": "A"},
                    {"id": "2", "text": "B"},
                    {"id": "3", "text": "C"},
                    {"id": "4", "text": "D"},
                ],
                "default",
                "file.txt",
            )
        except Exception:
            pass

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert started.wait(timeout=3)
    cancel.cancel()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert translator.stats.api_calls < 4


def test_max_api_calls_is_atomic_across_workers(tmp_path: Path) -> None:
    config = replace(
        _config(tmp_path / "budget.json"),
        api_keys=("k1", "k2"),
        batch_size=1,
        max_api_calls=1,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=lambda _key, _timeout: FakeClient(
            {f"T{index}": f"V{index}" for index in range(1, 5)}
        ),
    )
    with pytest.raises(QuotaExhaustedError):
        translator.translate_items(
            [{"id": str(index), "text": f"T{index}"} for index in range(1, 5)],
            "default",
            "file.txt",
        )
    assert translator.stats.api_calls == 1


def test_cache_hits_flush_to_on_translated_batch_before_api(tmp_path: Path) -> None:
    cache = tmp_path / "cache.json"
    translator = GeminiTranslator(
        _config(cache),
        _profile(),
        client_factory=lambda _key, _timeout: FakeClient({"B": "Hai"}),
    )
    translator._store_cached("A", "default", "Một")
    received: list[dict[str, str]] = []
    result = translator.translate_items(
        [{"id": "1", "text": "A"}, {"id": "2", "text": "B"}],
        "default",
        "file.txt",
        on_translated_batch=received.append,
    )
    assert result == {"1": "Một", "2": "Hai"}
    assert received[0] == {"1": "Một"}
    assert {"2": "Hai"} in received


def test_quota_keeps_cache_hits_in_partial_translations(tmp_path: Path) -> None:
    config = replace(
        _config(tmp_path / "quota-cache.json"),
        api_keys=("k1",),
        batch_size=1,
        max_api_calls=1,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=lambda _key, _timeout: FakeClient(
            {"B": "Hai", "C": "Ba"}
        ),
    )
    translator._store_cached("A", "default", "Một")
    received: list[dict[str, str]] = []
    with pytest.raises(QuotaExhaustedError):
        translator.translate_items(
            [
                {"id": "1", "text": "A"},
                {"id": "2", "text": "B"},
                {"id": "3", "text": "C"},
            ],
            "default",
            "file.txt",
            on_translated_batch=received.append,
        )
    assert received[0] == {"1": "Một"}
    assert translator._partial_translations["1"] == "Một"
    assert "2" in translator._partial_translations
    assert "3" not in translator._partial_translations


def test_batch_glossary_hints_apply_per_batch_when_parallel(tmp_path: Path) -> None:
    seen_batches: list[list[str]] = []

    def hints(items: list[dict[str, str]]) -> dict[str, str]:
        seen_batches.append([item["text"] for item in items])
        return {item["text"]: f"Hint-{item['text']}" for item in items}

    prompts: list[str] = []

    class CaptureModels(FakeModels):
        def generate_content(self, **kwargs: object) -> object:
            prompts.append(str(kwargs["contents"]))
            return super().generate_content(**kwargs)

    class CaptureClient(FakeClient):
        def __init__(self) -> None:
            self.models = CaptureModels(
                {"Alpha": "Một", "Beta": "Hai", "Gamma": "Ba", "Delta": "Bốn"}
            )

    config = replace(
        _config(tmp_path / "hints.json"),
        api_keys=("k1", "k2"),
        batch_size=2,
    )
    translator = GeminiTranslator(
        config,
        _profile(),
        client_factory=lambda _key, _timeout: CaptureClient(),
        batch_glossary_hints=hints,
    )
    result = translator.translate_items(
        [
            {"id": "1", "text": "Alpha"},
            {"id": "2", "text": "Beta"},
            {"id": "3", "text": "Gamma"},
            {"id": "4", "text": "Delta"},
        ],
        "default",
        "file.txt",
    )
    assert len(result) == 4
    assert len(seen_batches) == 2
    assert all(len(batch) == 2 for batch in seen_batches)
    assert any('Hint-Alpha' in prompt or 'Hint-Gamma' in prompt for prompt in prompts)


def test_civ7_cross_file_uses_multiple_keys_and_keeps_file_batches(
    tmp_path: Path,
) -> None:
    english = tmp_path / "en"
    vietnam = tmp_path / "vi"
    english.mkdir()
    vietnam.mkdir()

    def write_xml(folder: Path, name: str, prefix: str) -> None:
        rows = "\n".join(
            f'    <Row Tag="LOC_{prefix}_{index}">'
            f"<Text>Source {prefix} {index}</Text></Row>"
            for index in range(1, 11)
        )
        (folder / name).write_text(
            "<GameData>\n  <BaseGameText>\n"
            f"{rows}\n"
            "  </BaseGameText>\n</GameData>\n",
            encoding="utf-8",
        )

    for index in range(1, 4):
        write_xml(english, f"file{index}.xml", f"F{index}")
        write_xml(vietnam, f"file{index}.xml", f"F{index}")

    created: list[str] = []
    call_files: list[str] = []
    lock = threading.Lock()

    class TrackingModels(FakeModels):
        def generate_content(self, **kwargs: object) -> object:
            prompt = str(kwargs["contents"])
            file_line = next(
                (
                    line.removeprefix("File: ").strip()
                    for line in prompt.splitlines()
                    if line.startswith("File: ")
                ),
                "",
            )
            with lock:
                call_files.append(file_line)
            payload = json.loads(prompt.split("Dữ liệu:\n", 1)[1])
            rows = [
                {"id": item["id"], "text": f"VN-{item['text']}"} for item in payload
            ]
            return SimpleNamespace(text=json.dumps(rows, ensure_ascii=False))

    class TrackingClient(FakeClient):
        def __init__(self) -> None:
            self.models = TrackingModels()

    def factory(api_key: str, _timeout: float) -> TrackingClient:
        created.append(api_key)
        return TrackingClient()

    config = replace(
        TranslationConfig(
            api_keys=tuple(f"key-{index}" for index in range(1, 6)),
            models=("gemini-test",),
            cache_path=tmp_path / "civ7-cache.json",
            delay_seconds=0,
            timeout_seconds=5,
            # batch 40 nhưng mỗi file chỉ 10 câu → 3 bucket = 3 batch song song.
            batch_size=40,
        ),
    )
    result = translate_localization(
        english,
        vietnam,
        config,
        client_factory=factory,
    )
    assert result["stats"]["filesProcessed"] >= 3
    assert result.get("workersUsed", 0) >= 2
    assert len(created) >= 2
    assert len(call_files) >= 2
    for path in call_files:
        assert path.count("file") >= 1
        # One request stays inside one file path.
        assert path.endswith(".xml")
    for index in range(1, 4):
        text = (vietnam / f"file{index}.xml").read_text(encoding="utf-8")
        assert "VN-Source" in text
