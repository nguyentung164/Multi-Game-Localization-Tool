from translate_tool.legend.han_viet import (
    LEGEND_FIXED_TERMS,
    TERM_ROLE_PREFERRED,
    TERM_ROLE_REQUIRED,
    build_term_bank,
    classify_term_gaps,
    code_switch_source,
    contains_vietnamese_term,
    fold_vietnamese_term,
    glossary_hints_from_sources,
    han_viet_overrides,
    missing_required_terms,
    source_is_term_label,
    suggested_han_replacements,
    term_role,
    term_suggestion_payloads,
    transliterate_han_viet_name,
    vietnamese_term_standin,
)


def test_transliterate_known_three_kingdoms_names() -> None:
    assert transliterate_han_viet_name("鄂焕") == "Ngạc Hoán"
    assert transliterate_han_viet_name("奚泥") == "Hề Nê"
    assert transliterate_han_viet_name("刘备") == "Lưu Bị"
    assert transliterate_han_viet_name("张飞") == "Trương Phi"
    assert transliterate_han_viet_name("蒯越") == "Khoái Việt"
    assert transliterate_han_viet_name("雪莹") == "Tuyết Oánh"


def test_transliterate_rejects_unmapped_or_long_phrases() -> None:
    assert transliterate_han_viet_name("大戟士统领") is None
    assert transliterate_han_viet_name("武将") is None
    assert transliterate_han_viet_name("Hello") is None


def test_glossary_wins_over_dictionary() -> None:
    overrides = han_viet_overrides(["鄂焕"], {"鄂焕": "Tên khóa"})
    assert overrides["鄂焕"] == "Tên khóa"


def test_glossary_hints_come_from_source_phrases_not_single_chars() -> None:
    hints = glossary_hints_from_sources(
        ["曾跟随杨奉，后效力曹操，于乌巢击败袁绍，司马懿与诸葛亮对峙。"]
    )
    assert hints["袁绍"] == "Viên Thiệu"
    assert hints["乌巢"] == "Ô Sào"
    assert hints["曹操"] == "Tào Tháo"
    assert hints["司马懿"] == "Tư Mã Ý"
    assert hints["诸葛亮"] == "Gia Cát Lượng"
    assert hints["杨奉"] == "Dương Phụng"
    assert "征讨" not in hints
    assert "魏" not in hints
    assert glossary_hints_from_sources(["征讨残敌"]) == {}


def test_code_switch_longest_first_user_glossary_and_placeholders() -> None:
    switched, matches = code_switch_source("诸葛亮与司马懿", build_term_bank())
    assert switched == "Gia Cát Lượng与Tư Mã Ý"
    assert matches[0] == ("诸葛亮", "Gia Cát Lượng")
    assert matches[1] == ("司马懿", "Tư Mã Ý")

    custom = build_term_bank({"袁绍": "Viên Thiệu (user)"})
    switched, matches = code_switch_source("击败袁绍于乌巢{0}", custom)
    assert switched == "击败Viên Thiệu (user)于Ô Sào{0}"
    assert ("袁绍", "Viên Thiệu (user)") in matches
    assert "{0}" in switched
    assert code_switch_source("xem {袁绍}", build_term_bank())[0] == "xem {袁绍}"
    switched, matches = code_switch_source("征讨残敌", build_term_bank())
    assert switched == "征讨残敌"
    assert matches == []


def test_legend_fixed_terms_are_in_term_bank_and_code_switch() -> None:
    terms = build_term_bank()
    assert terms["洞悉之符"] == "Phù Thấu Thị"
    assert terms["青龙偃月刀"] == "Thanh Long Yển Nguyệt Đao"
    assert terms["[瞬]"] == "[Tức]"
    switched, matches = code_switch_source("获得洞悉之符[瞬]", terms)
    assert switched == "获得Phù Thấu Thị[Tức]"
    assert ("洞悉之符", "Phù Thấu Thị") in matches
    assert ("[瞬]", "[Tức]") in matches
    overridden = build_term_bank({"洞悉之符": "Bùa Nhìn Thấu"})
    assert overridden["洞悉之符"] == "Bùa Nhìn Thấu"
    assert LEGEND_FIXED_TERMS["化仇之符"] == "Phù Hóa Thù"


def test_missing_required_terms_allows_flexible_spaces() -> None:
    matches = [("袁绍", "Viên Thiệu"), ("乌巢", "Ô Sào")]
    assert missing_required_terms("thắng Viên Thiệu tại Ô Sào", matches) == []
    assert missing_required_terms("thắng ViênThiệu tại ÔSào", matches) == []
    assert missing_required_terms("thắng địch", matches) == ["Viên Thiệu", "Ô Sào"]


def test_missing_required_terms_accepts_uy_tone_placement() -> None:
    matches = [("渭水", "Vị Thủy")]
    assert missing_required_terms("trận Vị Thuỷ", matches) == []
    assert missing_required_terms("trận Vị Thủy", matches) == []
    assert missing_required_terms("trận Vị Thúy", matches) == ["Vị Thủy"]
    assert fold_vietnamese_term("Vị Thủy") == fold_vietnamese_term("Vị Thuỷ")
    assert contains_vietnamese_term("Kì", "Kỳ")


def test_missing_required_terms_ignores_capitalization() -> None:
    matches = [("火计", "Hỏa Kế"), ("洞悉之符", "Phù Thấu Thị")]
    assert missing_required_terms("thực thi hỏa kế của Gia Cát Lượng", matches[:1]) == []
    assert missing_required_terms("thực thi Hỏa Kế", matches[:1]) == []
    assert missing_required_terms("thực thi hỏa công", matches[:1]) == ["Hỏa Kế"]
    assert missing_required_terms("nhận phù thấu thị", matches[1:]) == []
    assert missing_required_terms("nhận bùa", matches[1:]) == ["Phù Thấu Thị"]


def test_term_roles_and_label_vs_narrative() -> None:
    assert term_role("火计") == TERM_ROLE_PREFERRED
    assert term_role("洞悉之符") == TERM_ROLE_REQUIRED
    assert term_role("火计", glossary={"火计": "Hỏa Kế"}) == TERM_ROLE_REQUIRED
    assert term_role("火计", locked={"火计": "Hỏa Kế"}) == TERM_ROLE_REQUIRED
    assert source_is_term_label("火计", "火计")
    assert source_is_term_label("火计{0}", "火计")
    assert not source_is_term_label("负责执行诸葛亮的火计", "火计")


def test_classify_term_gaps_preferred_in_narrative_is_warning() -> None:
    matches = [("火计", "Hỏa Kế")]
    errors, warnings = classify_term_gaps(
        "负责执行诸葛亮的火计",
        "thực thi hỏa công của Gia Cát Lượng",
        matches,
    )
    assert errors == []
    assert warnings == [("火计", "Hỏa Kế")]
    errors, warnings = classify_term_gaps("火计", "hỏa công", matches)
    assert errors == [("火计", "Hỏa Kế")]
    assert warnings == []
    errors, warnings = classify_term_gaps(
        "负责执行诸葛亮的火计",
        "thực thi hỏa kế của Gia Cát Lượng",
        matches,
    )
    assert errors == []
    assert warnings == []


def test_contains_vietnamese_term_accepts_compound_skill_names() -> None:
    assert contains_vietnamese_term("Cường Hỏa Kế", "Hỏa Kế")
    assert contains_vietnamese_term("Liệt Hỏa Kế", "Hỏa Kế")
    assert contains_vietnamese_term("Thần Hỏa Kế", "Hỏa Kế")
    assert contains_vietnamese_term("thi triển hỏa kế", "Hỏa Kế")
    assert contains_vietnamese_term("triển khai Hỏa\u200bKế", "Hỏa Kế")


def test_classify_term_gaps_skips_preferred_subterm_in_short_skill_labels() -> None:
    matches = [("火计", "Hỏa Kế")]
    for source in ("强火计", "烈火计", "神火计"):
        errors, warnings = classify_term_gaps(source, "Cường Hỏa Kế", matches)
        assert errors == []
        assert warnings == []


def test_suggested_han_replacements_uses_term_bank_not_single_chars() -> None:
    terms = build_term_bank()
    pairs = suggested_han_replacements("theo 刘备 và [瞬]", terms)
    assert ("刘备", "Lưu Bị") in pairs
    assert ("[瞬]", "[Tức]") in pairs
    assert all(len(phrase) >= 2 or phrase.startswith("[") for phrase, _ in pairs)


def test_vietnamese_term_standin_unique_first_token_window() -> None:
    assert (
        vietnamese_term_standin(
            "Phò tá Lưu Chương, nhậm chức cho Lưu Biện.",
            "Lưu Bị",
        )
        == "Lưu Biện"
    )
    assert (
        vietnamese_term_standin(
            "Phò tá Lưu Chương, nhậm chức cho Lưu Biện.",
            "Lưu Bị",
            keep_readings=["Lưu Chương"],
        )
        == "Lưu Biện"
    )
    assert (
        vietnamese_term_standin(
            "nhậm chức cho Lưu Biện. Sau khi Lưu Biện bệnh mất",
            "Lưu Bị",
        )
        == "Lưu Biện"
    )
    assert (
        vietnamese_term_standin(
            "giúp hỏa công đại thắng",
            "Hỏa Kế",
        )
        == "hỏa công"
    )
    assert (
        vietnamese_term_standin(
            "giúp hỏa công và hỏa tiễn đại thắng",
            "Hỏa Kế",
        )
        is None
    )
    assert (
        vietnamese_term_standin(
            "Lưu Biện và Lưu Biểu cùng tới",
            "Lưu Bị",
        )
        is None
    )
    assert vietnamese_term_standin("Ngụy đánh", "Ngụy") is None
    assert vietnamese_term_standin("theo Lưu Bị đánh", "Lưu Bị") is None
    assert (
        vietnamese_term_standin(
            "Quan Vân theo Lưu Bị",
            "Quan Vũ",
            keep_readings=["Lưu Bị"],
        )
        == "Quan Vân"
    )
    assert (
        vietnamese_term_standin("[Tức] Chém", "[Tức]", keep_readings=[])
        is None
    )


def test_term_suggestion_payloads_attach_standin_not_han() -> None:
    terms = build_term_bank()
    payloads = term_suggestion_payloads(
        "刘备来了",
        "Lưu Biện đến rồi",
        terms,
        [("刘备", "Lưu Bị")],
    )
    assert payloads == [
        {"source": "刘备", "reading": "Lưu Bị", "replace": "Lưu Biện"}
    ]
    leftover = term_suggestion_payloads(
        "刘备来了",
        "刘备 đến rồi",
        terms,
        [("刘备", "Lưu Bị")],
    )
    assert leftover == [{"source": "刘备", "reading": "Lưu Bị"}]
    mixed = term_suggestion_payloads(
        "先事刘璋，后为刘备谋士",
        "Phò tá Lưu Chương, sau đó làm mưu sĩ. Nhậm chức cho Lưu Biện.",
        terms,
        [("刘备", "Lưu Bị")],
    )
    assert mixed == [
        {"source": "刘备", "reading": "Lưu Bị", "replace": "Lưu Biện"}
    ]
