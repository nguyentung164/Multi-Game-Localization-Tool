from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence

from ..common.language import has_han

# Tên người 1–4 chữ Hán: phiên từ điển, không nhờ model (model hay nuốt Ng/Nh/H vì nghĩ pinyin).
_NAME_SEPARATORS = set("·・．. ")
HAN_VIET: dict[str, str] = {
    "鄂": "Ngạc",
    "焕": "Hoán",
    "煥": "Hoán",

    "奚": "Hề",
    "泥": "Nê",

    "吴": "Ngô",
    "吳": "Ngô",
    "魏": "Ngụy",
    "阮": "Nguyễn",
    "伍": "Ngũ",
    "五": "Ngũ",
    "吾": "Ngô",
    "午": "Ngọ",
    "悟": "Ngộ",
    "误": "Ngộ",
    "誤": "Ngộ",

    "鱼": "Ngư",
    "魚": "Ngư",
    "渔": "Ngư",
    "漁": "Ngư",
    "虞": "Ngu",

    "宜": "Nghi",
    "仪": "Nghi",
    "儀": "Nghi",

    "义": "Nghĩa",
    "義": "Nghĩa",
    "谊": "Nghị",
    "誼": "Nghị",
    "毅": "Nghị",

    "艺": "Nghệ",
    "藝": "Nghệ",

    "倪": "Nghê",
    "霓": "Nghê",

    "颜": "Nhan",
    "顏": "Nhan",

    "彦": "Ngạn",
    "彥": "Ngạn",

    "雁": "Nhạn",
    "言": "Ngôn",

    "严": "Nghiêm",
    "嚴": "Nghiêm",

    "研": "Nghiên",

    "乐": "Nhạc",
    "樂": "Nhạc",
    "岳": "Nhạc",

    "兮": "Hề",

    "侯": "Hầu",
    "后": "Hậu",
    "後": "Hậu",

    "何": "Hà",
    "河": "Hà",

    "和": "Hòa",

    "贺": "Hạ",
    "賀": "Hạ",

    "郝": "Hác",

    "韩": "Hàn",
    "韓": "Hàn",

    "汉": "Hán",
    "漢": "Hán",

    "胡": "Hồ",
    "湖": "Hồ",
    "虎": "Hổ",

    "许": "Hứa",
    "許": "Hứa",

    "徐": "Từ",

    "蒯": "Khoái",
    "越": "Việt",

    "刘": "Lưu",
    "劉": "Lưu",

    "关": "Quan",
    "關": "Quan",

    "张": "Trương",
    "張": "Trương",

    "赵": "Triệu",
    "趙": "Triệu",

    "曹": "Tào",

    "孙": "Tôn",
    "孫": "Tôn",

    "诸": "Chư",
    "諸": "Chư",

    "葛": "Cát",

    "司": "Tư",

    "马": "Mã",
    "馬": "Mã",

    "吕": "Lữ",
    "呂": "Lữ",

    "董": "Đổng",
    "袁": "Viên",

    "黄": "Hoàng",
    "黃": "Hoàng",

    "蜀": "Thục",

    "冯": "Phùng",
    "馮": "Phùng",

    "陈": "Trần",
    "陳": "Trần",

    "夏": "Hạ",

    "荀": "Tuân",
    "程": "Trình",
    "于": "Vu",
    "姜": "Khương",

    "邓": "Đặng",
    "鄧": "Đặng",

    "庞": "Bàng",
    "龐": "Bàng",

    "贾": "Giả",
    "賈": "Giả",

    "蒋": "Tưởng",
    "蔣": "Tưởng",

    "蔡": "Thái",
    "高": "Cao",
    "孟": "Mạnh",
    "华": "Hoa",
    "華": "Hoa",

    "周": "Chu",
    "王": "Vương",
    "李": "Lý",
    "杨": "Dương",
    "楊": "Dương",
    "朱": "Chu",

    "林": "Lâm",
    "罗": "La",
    "羅": "La",

    "梁": "Lương",
    "宋": "Tống",
    "唐": "Đường",

    "萧": "Tiêu",
    "蕭": "Tiêu",

    "傅": "Phó",
    "沈": "Thẩm",
    "彭": "Bành",

    "苏": "Tô",
    "蘇": "Tô",

    "卢": "Lư",
    "盧": "Lư",

    "丁": "Đinh",
    "薛": "Tiết",

    "叶": "Diệp",
    "葉": "Diệp",

    "阎": "Diêm",
    "閻": "Diêm",

    "余": "Dư",
    "潘": "Phan",
    "杜": "Đỗ",
    "戴": "Đái",

    "钟": "Chung",
    "鍾": "Chung",
    "鐘": "Chung",

    "田": "Điền",

    "任": "Nhậm",

    "范": "Phạm",
    "方": "Phương",
    "石": "Thạch",
    "姚": "Diêu",

    "谭": "Đàm",
    "譚": "Đàm",

    "廖": "Liêu",

    "邹": "Trâu",
    "鄒": "Trâu",

    "熊": "Hùng",
    "金": "Kim",

    "陆": "Lục",
    "陸": "Lục",

    "孔": "Khổng",
    "白": "Bạch",
    "崔": "Thôi",
    "康": "Khang",
    "毛": "Mao",
    "邱": "Khâu",
    "秦": "Tần",
    "江": "Giang",
    "史": "Sử",

    "顾": "Cố",
    "顧": "Cố",

    "邵": "Thiệu",
    "龙": "Long",
    "龍": "Long",

    "万": "Vạn",
    "萬": "Vạn",

    "段": "Đoàn",
    "雷": "Lôi",

    "钱": "Tiền",
    "錢": "Tiền",

    "汤": "Thang",
    "湯": "Thang",

    "尹": "Doãn",
    "黎": "Lê",
    "武": "Vũ",
    "乔": "Kiều",
    "喬": "Kiều",

    "文": "Văn",
    "备": "Bị",
    "備": "Bị",
    "飞": "Phi",
    "飛": "Phi",
    "云": "Vân",
    "雲": "Vân",

    "操": "Tháo",
    "亮": "Lượng",
    "权": "Quyền",
    "權": "Quyền",
    "懿": "Ý",
    "布": "Bố",

    "羽": "Vũ",
    "超": "Siêu",

    "肃": "Túc",
    "肅": "Túc",

    "瑜": "Du",
    "逊": "Tốn",
    "遜": "Tốn",

    "统": "Thống",
    "統": "Thống",

    "策": "Sách",
    "坚": "Kiên",
    "堅": "Kiên",

    "禅": "Thiện",
    "禪": "Thiện",

    "丕": "Phi",
    "植": "Thực",
    "仁": "Nhân",
    "忠": "Trung",

    "维": "Duy",
    "維": "Duy",

    "延": "Diên",

    "会": "Hội",
    "會": "Hội",

    "昭": "Chiêu",
    "朗": "Lãng",
    "艾": "Ngải",

    "绮": "Khởi",
    "綺": "Khởi",

    "凡": "Phàm",

    "雪": "Tuyết",
    "莹": "Oánh",
    "瑩": "Oánh",

    "绍": "Thiệu",
    "紹": "Thiệu",
    "巢": "Sào",
    "乌": "Ô",
    "烏": "Ô",

    "奉": "Phụng",
    "宠": "Sủng",
    "寵": "Sủng",
    "宫": "Cung",
    "宮": "Cung",
    "满": "Mãn",
    "滿": "Mãn",
    "晃": "Hoảng",
    "官": "Quan",
    "渡": "Độ",
    "赤": "Xích",
    "壁": "Bích",
    "渭": "Vị",
    "水": "Thủy",
    "中": "Trung",
    "襄": "Tương",
    "樊": "Phàn",
    "达": "Đạt",
    "達": "Đạt",
    "荆": "Kinh",
    "荊": "Kinh",
    "州": "Châu",
}

# Cụm 2–4 chữ lấy từ câu nguồn → glossary batch. Không thay từng chữ trên bản dịch.
# 诸葛 không cộng âm (Chư Cát) — phải là Gia Cát.
_PHRASE_OVERRIDES = {
    "诸葛": "Gia Cát",
    "諸葛": "Gia Cát",
    "诸葛亮": "Gia Cát Lượng",
    "諸葛亮": "Gia Cát Lượng",
}
_PHRASE_KEYS = (
    "袁绍",
    "袁紹",
    "曹魏",
    "乌巢",
    "烏巢",
    "司马懿",
    "司馬懿",
    "诸葛亮",
    "諸葛亮",
    "诸葛",
    "諸葛",
    "官渡",
    "赤壁",
    "汉中",
    "漢中",
    "襄樊",
    "渭水",
    "吕布",
    "呂布",
    "关羽",
    "關羽",
    "曹仁",
    "曹操",
    "满宠",
    "滿寵",
    "杨奉",
    "楊奉",
    "陈宫",
    "陳宮",
    "孟达",
    "孟達",
    "徐晃",
    "刘备",
    "劉备",
    "劉備",
    "荆州",
    "荊州",
)


def _phrase_reading(phrase: str) -> str:
    override = _PHRASE_OVERRIDES.get(phrase)
    if override:
        return override
    return " ".join(HAN_VIET[character] for character in phrase)


HAN_VIET_PHRASES = {key: _phrase_reading(key) for key in _PHRASE_KEYS}

# Item / skill / tên game — không phiên từng chữ. User glossary thắng.
LEGEND_FIXED_TERMS = {
    "青龙偃月刀": "Thanh Long Yển Nguyệt Đao",
    "青龍偃月刀": "Thanh Long Yển Nguyệt Đao",
    "方天画戟": "Phương Thiên Họa Kích",
    "方天畫戟": "Phương Thiên Họa Kích",
    "洞悉之符": "Phù Thấu Thị",
    "化仇之符": "Phù Hóa Thù",
    "火计": "Hỏa Kế",
    "火計": "Hỏa Kế",
    "大戟士统领": "Đại Kích Sĩ Thống Lĩnh",
    "大戟士統領": "Đại Kích Sĩ Thống Lĩnh",
    "冯绮凡": "Phùng Khởi Phàm",
    "馮綺凡": "Phùng Khởi Phàm",
    "鄂焕": "Ngạc Hoán",
    "鄂煥": "Ngạc Hoán",
    "奚泥": "Hề Nê",
    "[瞬]": "[Tức]",
}

# Vai term: required = lỗi blocking; preferred = cảnh báo trong câu kể.
# Nhãn đúng cụm nguồn (source == 火计, hoặc 火计{0}) vẫn bắt buộc.
# Glossary / locked luôn required. Không dùng đồng nghĩa trong matcher.
PREFERRED_FIXED_SOURCES = frozenset({"火计", "火計"})
TERM_ROLE_REQUIRED = "required"
TERM_ROLE_PREFERRED = "preferred"

_SKIP_IN_SOURCE = re.compile(r"\{[^{}\r\n]*\}|<[^>\r\n]+>")


def build_term_bank(
    glossary: Mapping[str, str] | None = None,
    locked: Mapping[str, str] | None = None,
) -> dict[str, str]:
    bank = {key: value for key, value in HAN_VIET_PHRASES.items() if key and value}
    bank.update(
        {key: value for key, value in LEGEND_FIXED_TERMS.items() if key and value}
    )
    if locked:
        bank.update({key: value for key, value in locked.items() if key and value})
    if glossary:
        bank.update({key: value for key, value in glossary.items() if key and value})
    return bank


# none, huyền, sắc, hỏi, ngã, nặng — thủy/thuỷ, hòa/hoà, khỏe/khoẻ.
_U_TONES = "uùúủũụ"
_Y_TONES = "yỳýỷỹỵ"
_O_TONES = "oòóỏõọ"
_A_TONES = "aàáảãạ"
_E_TONES = "eèéẻẽẹ"
_Y_TONE_TO_I = str.maketrans(
    {
        "ý": "í",
        "ỳ": "ì",
        "ỷ": "ỉ",
        "ỹ": "ĩ",
        "ỵ": "ị",
        "Ý": "Í",
        "Ỳ": "Ì",
        "Ỷ": "Ỉ",
        "Ỹ": "Ĩ",
        "Ỵ": "Ị",
    }
)


def _diphthong_tone_folds() -> tuple[tuple[str, str], ...]:
    mapping: dict[str, str] = {}
    for first, second in ((_U_TONES, _Y_TONES), (_O_TONES, _A_TONES), (_O_TONES, _E_TONES)):
        for index in range(1, 6):
            left = first[index] + second[0]
            right = first[0] + second[index]
            for source, dest in (
                (left, right),
                (left.upper(), right.upper()),
                (left.capitalize(), right.capitalize()),
            ):
                if source != dest:
                    mapping[source] = dest
    return tuple(
        sorted(mapping.items(), key=lambda item: len(item[0]), reverse=True)
    )


_DIPHTHONG_TONE_FOLDS = _diphthong_tone_folds()


def fold_vietnamese_term(text: str) -> str:
    """Cùng âm: Thủy/Thuỷ, hòa/hoà, Kỳ/Kì. Giữ nguyên thanh điệu."""
    folded = unicodedata.normalize("NFC", text or "")
    folded = re.sub(r"[\ufeff\u200b-\u200d\ufeef\ufffe]+", "", folded)
    folded = re.sub(r"\s+", "", folded)
    for source, dest in _DIPHTHONG_TONE_FOLDS:
        folded = folded.replace(source, dest)
    return folded.translate(_Y_TONE_TO_I)


def _reading_words_present(target: str, reading: str) -> bool:
    parts = _folded_syllables(reading)
    if len(parts) < 2:
        return False
    words = _folded_syllables(target)
    if len(words) < len(parts):
        return False
    for index in range(len(words) - len(parts) + 1):
        if words[index : index + len(parts)] == parts:
            return True
    return False


def contains_vietnamese_term(target: str, reading: str) -> bool:
    if not reading:
        return True
    folded_reading = fold_vietnamese_term(reading).casefold()
    if not folded_reading:
        return True
    folded_target = fold_vietnamese_term(target or "").casefold()
    if folded_reading in folded_target:
        return True
    return _reading_words_present(target or "", reading)


_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
_HAN_RUN_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_MARKUP_IN_READING = frozenset("<>{}[]\\")


def _folded_syllables(text: str) -> list[str]:
    return [
        fold_vietnamese_term(part).casefold()
        for part in _WORD.findall(text or "")
        if part
    ]


def _standin_score(span: str, reading: str) -> int:
    """Điểm khớp tiếng: đúng cả tiếng > cùng chữ cái đầu. Không đồng nghĩa."""
    left = _folded_syllables(span)
    right = _folded_syllables(reading)
    if len(left) != len(right) or not left:
        return 0
    score = 0
    for actual, expected in zip(left, right, strict=True):
        if actual == expected:
            score += 2
        elif actual[:1] and actual[:1] == expected[:1]:
            score += 1
    return score


def _keep_readings_from_source(
    source: str,
    terms: Mapping[str, str],
    skip_reading: str,
) -> list[str]:
    """Bản Việt của cụm Hán khác trong câu nguồn — term bank rồi tên 2–4 chữ."""
    skip = fold_vietnamese_term(skip_reading).casefold() if skip_reading else ""
    keep: list[str] = []
    seen: set[str] = set()

    def add(reading: str) -> None:
        if not reading:
            return
        folded = fold_vietnamese_term(reading).casefold()
        if not folded or folded == skip or folded in seen:
            return
        seen.add(folded)
        keep.append(reading)

    for _, reading in match_terms(source, terms):
        add(reading)
    for run in _HAN_RUN_PATTERN.findall(source or ""):
        length = len(run)
        for size in range(min(4, length), 1, -1):
            for start in range(0, length - size + 1):
                piece = run[start : start + size]
                add(terms.get(piece) or transliterate_han_viet_name(piece) or "")
    return keep


def vietnamese_term_standin(
    target: str,
    reading: str,
    keep_readings: Sequence[str] = (),
) -> str | None:
    """Cụm Việt trên đích có thể là bản sai của reading.

    Cùng số tiếng, cùng tiếng đầu; không đụng reading của term khác trong câu nguồn.
    Một cụm thì lấy; nhiều cụm thì chỉ lấy khi có đúng một cụm khớp tiếng hơn
    (cùng chữ cái các tiếng sau). Hòa điểm thì không đoán.
    """
    if not target or not reading:
        return None
    if any(character in reading for character in _MARKUP_IN_READING):
        return None
    if contains_vietnamese_term(target, reading):
        return None
    parts = reading.split()
    if not 2 <= len(parts) <= 6:
        return None
    first = fold_vietnamese_term(parts[0]).casefold()
    if not first:
        return None
    words = list(_WORD.finditer(target))
    count = len(parts)
    found: dict[str, str] = {}
    for index in range(len(words) - count + 1):
        if fold_vietnamese_term(words[index].group(0)).casefold() != first:
            continue
        span = target[words[index].start() : words[index + count - 1].end()]
        if any(
            contains_vietnamese_term(span, keep) for keep in keep_readings if keep
        ):
            continue
        if contains_vietnamese_term(span, reading):
            continue
        folded = fold_vietnamese_term(span).casefold()
        if not folded:
            continue
        found.setdefault(folded, span)
    if not found:
        return None
    if len(found) == 1:
        return next(iter(found.values()))
    ranked: dict[int, list[str]] = {}
    for span in found.values():
        ranked.setdefault(_standin_score(span, reading), []).append(span)
    best = max(ranked)
    winners = ranked[best]
    if best <= 2 or len(winners) != 1:
        return None
    return winners[0]


def term_suggestion_payloads(
    source: str,
    target: str,
    terms: Mapping[str, str],
    pairs: Sequence[tuple[str, str]],
) -> list[dict[str, str]]:
    payloads: list[dict[str, str]] = []
    for phrase, reading in pairs:
        if not phrase or not reading:
            continue
        item = {"source": phrase, "reading": reading}
        keep = _keep_readings_from_source(source, terms, reading)
        standin = vietnamese_term_standin(target, reading, keep)
        if standin:
            item["replace"] = standin
        payloads.append(item)
    return payloads


def source_is_term_label(source: str, phrase: str) -> bool:
    """Cả dòng nguồn là đúng cụm (nhãn UI), không phải cụm nằm trong câu kể."""
    if not source or not phrase:
        return False
    if source.strip() == phrase:
        return True
    stripped = _SKIP_IN_SOURCE.sub("", source).strip()
    return stripped == phrase


def _embedded_preferred_in_short_label(source: str, phrase: str) -> bool:
    """火计 trong nhãn ghép ngắn (强火计) — coi cả dòng là một tên, không cảnh báo subterm."""
    if phrase not in PREFERRED_FIXED_SOURCES or phrase not in source:
        return False
    if source.strip() == phrase or source_is_term_label(source, phrase):
        return False
    han = "".join(_HAN_RUN_PATTERN.findall(source))
    return 2 < len(han) <= 4 and phrase in han and han != phrase


def term_role(
    phrase: str,
    *,
    locked: Mapping[str, str] | None = None,
    glossary: Mapping[str, str] | None = None,
) -> str:
    if locked and phrase in locked:
        return TERM_ROLE_REQUIRED
    if glossary and phrase in glossary:
        return TERM_ROLE_REQUIRED
    if phrase in PREFERRED_FIXED_SOURCES:
        return TERM_ROLE_PREFERRED
    return TERM_ROLE_REQUIRED


def _skip_spans(source: str) -> list[tuple[int, int]]:
    return [(match.start(), match.end()) for match in _SKIP_IN_SOURCE.finditer(source)]


def _skip_end(index: int, spans: Sequence[tuple[int, int]]) -> int | None:
    for start, end in spans:
        if start <= index < end:
            return end
    return None


def _overlaps_skip(start: int, end: int, spans: Sequence[tuple[int, int]]) -> bool:
    return any(start < skip_end and end > skip_start for skip_start, skip_end in spans)


def code_switch_source(
    source: str, terms: Mapping[str, str]
) -> tuple[str, list[tuple[str, str]]]:
    """Thay cụm nguồn bằng bản duyệt (longest-first). Model dịch phần còn lại."""
    if not source or not terms:
        return source, []
    max_len = max(len(key) for key in terms)
    min_len = min(len(key) for key in terms)
    if max_len <= 0:
        return source, []
    spans = _skip_spans(source)
    pieces: list[str] = []
    matches: list[tuple[str, str]] = []
    index = 0
    length = len(source)
    while index < length:
        skip_to = _skip_end(index, spans)
        if skip_to is not None:
            pieces.append(source[index:skip_to])
            index = skip_to
            continue
        matched = False
        upper = min(max_len, length - index)
        for size in range(upper, min_len - 1, -1):
            end = index + size
            if _overlaps_skip(index, end, spans):
                continue
            chunk = source[index:end]
            reading = terms.get(chunk)
            if not reading:
                continue
            pieces.append(reading)
            matches.append((chunk, reading))
            index = end
            matched = True
            break
        if not matched:
            pieces.append(source[index])
            index += 1
    return "".join(pieces), matches


def match_terms(
    source: str, terms: Mapping[str, str]
) -> list[tuple[str, str]]:
    return code_switch_source(source, terms)[1]


def missing_required_terms(
    target: str, matches: Sequence[tuple[str, str]]
) -> list[str]:
    missing: list[str] = []
    seen: set[str] = set()
    for _, reading in matches:
        if not reading or reading in seen:
            continue
        seen.add(reading)
        if contains_vietnamese_term(target, reading):
            continue
        missing.append(reading)
    return missing


def classify_term_gaps(
    source: str,
    target: str,
    matches: Sequence[tuple[str, str]],
    *,
    locked: Mapping[str, str] | None = None,
    glossary: Mapping[str, str] | None = None,
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Thiếu term: (lỗi bắt buộc, cảnh báo ưu tiên) dạng (chữ Hán, bản Việt)."""
    errors: list[tuple[str, str]] = []
    warnings: list[tuple[str, str]] = []
    seen: set[str] = set()
    for phrase, reading in matches:
        if not reading or reading in seen:
            continue
        seen.add(reading)
        if contains_vietnamese_term(target, reading):
            continue
        if _embedded_preferred_in_short_label(source, phrase):
            continue
        required = (
            term_role(phrase, locked=locked, glossary=glossary) == TERM_ROLE_REQUIRED
            or source_is_term_label(source, phrase)
        )
        pair = (phrase, reading)
        if required:
            errors.append(pair)
        else:
            warnings.append(pair)
    return errors, warnings


def format_term_gap(phrase: str, reading: str) -> str:
    if phrase == reading:
        return f"Đề xuất dịch thành {reading}"
    return f"Dịch {phrase} thành {reading}"


def suggested_han_replacements(
    text: str,
    terms: Mapping[str, str],
) -> list[tuple[str, str]]:
    """Cụm Hán còn trong đích → bản Việt (term bank, rồi tên 2–4 chữ). Không đoán 1 chữ lẻ."""
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    if not text:
        return pairs
    _, matches = code_switch_source(text, terms)
    for phrase, reading in matches:
        if (
            not phrase
            or not reading
            or phrase in seen
            or not has_han(phrase)
            or reading == phrase
        ):
            continue
        seen.add(phrase)
        pairs.append((phrase, reading))
    for run in _HAN_RUN_PATTERN.findall(text):
        if run in seen or len(run) < 2:
            continue
        reading = transliterate_han_viet_name(run)
        if not reading or reading == run:
            continue
        seen.add(run)
        pairs.append((run, reading))
    return pairs


def transliterate_han_viet_name(source: str) -> str | None:
    text = (source or "").strip()
    if not text:
        return None
    chars: list[str] = []
    for character in text:
        if character in _NAME_SEPARATORS:
            continue
        if not has_han(character):
            return None
        chars.append(character)
    if not 1 <= len(chars) <= 4:
        return None
    syllables: list[str] = []
    for character in chars:
        reading = HAN_VIET.get(character)
        if not reading:
            return None
        syllables.append(reading)
    return " ".join(syllables)


def han_viet_overrides(
    sources: list[str], locked: dict[str, str]
) -> dict[str, str]:
    overrides = {source: locked[source] for source in sources if source in locked}
    for source in sources:
        if source in overrides:
            continue
        mapped = transliterate_han_viet_name(source)
        if mapped:
            overrides[source] = mapped
    return overrides


def glossary_hints_from_sources(
    sources: list[str],
    glossary: Mapping[str, str] | None = None,
    locked: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Cụm khớp câu nguồn (không chồng lấn) — glossary batch, không vá chữ đích."""
    if not sources:
        return {}
    terms = build_term_bank(glossary, locked)
    hints: dict[str, str] = {}
    for source in sources:
        for phrase, reading in match_terms(source, terms):
            hints[phrase] = reading
    return hints
