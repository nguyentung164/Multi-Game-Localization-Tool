from translate_tool.common.language import (
    has_han,
    is_translatable_bracket_tag,
    missing_tokens,
)
from translate_tool.legend.pipeline import _protected_tokens


def test_has_han_detects_mixed_vietnamese() -> None:
    assert has_han("Tây X川")
    assert not has_han("Tây Xuyên")
    assert not has_han("")


def test_cjk_skill_tags_are_translatable_but_ascii_tags_are_not() -> None:
    assert is_translatable_bracket_tag("[瞬]")
    assert is_translatable_bracket_tag("[被动]")
    assert is_translatable_bracket_tag("<诸侯讨董>")
    assert is_translatable_bracket_tag("<七星宝刀>")
    assert not is_translatable_bracket_tag("[TIP:x]")
    assert not is_translatable_bracket_tag("[b]")
    assert not is_translatable_bracket_tag("{0}")
    assert not is_translatable_bracket_tag("<b>")
    assert not is_translatable_bracket_tag("</b>")
    assert not is_translatable_bracket_tag("<color=#00f500>")
    assert not is_translatable_bracket_tag("<Chư Hầu Thảo Đổng>")
    assert is_translatable_bracket_tag("<与庞德关系等级至少为2级>")


def test_missing_tokens_allows_translated_cjk_brackets() -> None:
    assert missing_tokens("[瞬]斩击", "[Tức] Chém") == []
    assert missing_tokens("{0}[瞬]", "{0}[Tức]") == []
    assert missing_tokens("[瞬]斩击", "Chém") == ["[瞬]"]
    assert missing_tokens("[TIP:x] hi", "xin chào") == ["[TIP:x]"]
    assert missing_tokens("伤害{0}", "Sát thương") == ["{0}"]
    assert missing_tokens(
        "【<刘备势力><与庞德关系等级至少为2级>收庞德为家将】",
        "【<Thế lực Lưu Bị><Cấp độ quan hệ với Bàng Đức ít nhất là cấp 2> thu Bàng Đức làm gia tướng】",
    ) == []


def test_legend_protected_tokens_ignore_translated_skill_tags() -> None:
    assert not (
        _protected_tokens("[瞬]斩击{0}") - _protected_tokens("[Tức] Chém{0}")
    )
    assert not (
        _protected_tokens("选择 <诸侯讨董> 剧本")
        - _protected_tokens("Chọn kịch bản <Chư Hầu Thảo Đổng>")
    )
    missing_html = _protected_tokens(r"^武将\d+<b>{0}</b>$") - _protected_tokens(
        "Võ tướng"
    )
    assert "<b>" in missing_html
    assert "{0}" in missing_html
