from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from translate_tool.civ7.state import validate_state
from translate_tool.common.types import ValidationError


def test_validate_state_rejects_invalid_api_key() -> None:
    with patch(
        "translate_tool.civ7.state.validate_gemini_api_key",
        return_value=False,
    ):
        result = validate_state({}, api_keys=("bad-key",))

    assert result["valid"] is False
    assert result["checks"] == [
        {
            "name": "geminiApiKey[0]",
            "ok": False,
            "error": "Gemini từ chối API key này",
        }
    ]


def test_validate_state_accepts_valid_api_key() -> None:
    with patch(
        "translate_tool.civ7.state.validate_gemini_api_key",
        return_value=True,
    ):
        result = validate_state({}, api_keys=("good-key",))

    assert result["valid"] is True
    assert result["checks"] == [{"name": "geminiApiKey[0]", "ok": True}]


def test_validate_state_without_keys_is_invalid() -> None:
    result = validate_state({})

    assert result["valid"] is False
    assert result["checks"][0]["name"] == "geminiApiKeys"
    assert result["checks"][0]["ok"] is False


def test_validate_gemini_api_key_rejects_empty_string() -> None:
    from translate_tool.common.translation_core import validate_gemini_api_key

    assert validate_gemini_api_key("   ") is False


def test_validate_gemini_api_key_rejects_auth_error() -> None:
    from translate_tool.common.translation_core import validate_gemini_api_key

    error = Exception("API key not valid. Please pass a valid API key.")
    error.code = 400  # type: ignore[attr-defined]

    with patch(
        "translate_tool.common.translation_core.default_client_factory"
    ) as factory:
        client = MagicMock()
        client.models.list.side_effect = error
        factory.return_value = client
        assert validate_gemini_api_key("bad-key") is False


def test_validate_gemini_api_key_raises_on_transient_error() -> None:
    from translate_tool.common.translation_core import validate_gemini_api_key

    with patch(
        "translate_tool.common.translation_core.default_client_factory"
    ) as factory:
        client = MagicMock()
        client.models.list.side_effect = TimeoutError("timed out")
        factory.return_value = client
        with pytest.raises(ValidationError, match="lỗi tạm thời"):
            validate_gemini_api_key("maybe-good-key")
