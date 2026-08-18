from __future__ import annotations

import hashlib
import re
from difflib import SequenceMatcher
from pathlib import Path

VIETNAMESE_CHARS = set(
    "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩị"
    "òóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
    "ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊ"
    "ÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ"
)
TOKEN_PATTERN = re.compile(r"(\{[^{}]+\}|\[[^\]]+\]|<[^>\r\n]+>)")
PLURAL_PATTERN = re.compile(r"(\{[^{}]+:\s*plural[^}]*\})", re.IGNORECASE)
TIP_PATTERN = re.compile(r"\[TIP:([^\]]+)\](.*?)\[/TIP\]", re.DOTALL)
_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")

CLD3_MIN_LEN = 40
CLD3_MIXED_MIN_LEN = 12
SIMILARITY_THRESHOLD = 0.92
CLD3_EN_PROB = 0.65
CLD3_VI_PROB = 0.65
ASCII_LETTER_THRESHOLD = 0.85
ENGLISH_WORD_REMAINING_RATIO = 0.5

_CLD3_DETECTOR = None


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def has_vietnamese(text: str) -> bool:
    return any(character in VIETNAMESE_CHARS for character in text)


def strip_game_tokens(text: str) -> str:
    cleaned = PLURAL_PATTERN.sub(" ", text or "")
    cleaned = TOKEN_PATTERN.sub(" ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def text_similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left.casefold(), right.casefold()).ratio()


def _ascii_letter_ratio(text: str) -> float:
    letters = [character for character in text if character.isalpha()]
    if not letters:
        return 0.0
    return sum(ord(character) < 128 for character in letters) / len(letters)


def _english_content_words(text: str) -> list[str]:
    return [word.casefold() for word in re.findall(r"[A-Za-z]{3,}", text)]


def _has_remaining_english_words(english: str, target: str) -> bool:
    english_words = _english_content_words(english)
    if not english_words:
        return False
    target_lower = target.casefold()
    remaining = [
        word
        for word in english_words
        if re.search(rf"\b{re.escape(word)}\b", target_lower)
    ]
    if not remaining:
        return False
    if len(remaining) >= 2:
        return len(remaining) / len(english_words) >= ENGLISH_WORD_REMAINING_RATIO
    ascii_words = _english_content_words(target)
    vietnamese_chars = sum(1 for character in target if character in VIETNAMESE_CHARS)
    return len(ascii_words) >= 2 and vietnamese_chars == 0


def _get_cld3_detector():
    global _CLD3_DETECTOR
    if _CLD3_DETECTOR is None:
        try:
            import gcld3
        except ImportError:
            _CLD3_DETECTOR = False
        else:
            _CLD3_DETECTOR = gcld3.NNetLanguageIdentifier(
                min_num_bytes=0,
                max_num_bytes=1000,
            )
    return None if _CLD3_DETECTOR is False else _CLD3_DETECTOR


def _detect_language(text: str) -> tuple[str | None, float]:
    try:
        import cld3
    except ImportError:
        cld3 = None
    if cld3 is not None:
        result = cld3.get_language(text)
        if result is not None:
            return result.language, result.probability

    detector = _get_cld3_detector()
    if detector is None:
        return None, 0.0
    result = detector.FindLanguage(text=text)
    if result is None:
        return None, 0.0
    return result.language, result.probability


def _is_english_by_cld3(text: str, *, min_len: int) -> bool:
    if len(text) < min_len:
        return False
    language, probability = _detect_language(text)
    return language == "en" and probability >= CLD3_EN_PROB


def _is_vietnamese_by_cld3(text: str) -> bool:
    if len(text) < CLD3_MIXED_MIN_LEN:
        return False
    language, probability = _detect_language(text)
    return language == "vi" and probability >= CLD3_VI_PROB


def needs_translation(target_text: str, english_text: str | None = None) -> bool:
    target = (target_text or "").strip()
    if not target:
        return False

    english = (english_text or "").strip() if english_text is not None else None
    if english is not None and target == english:
        return True

    clean = strip_game_tokens(target)
    letters = [character for character in clean if character.isalpha()]
    if not letters:
        return False

    clean_english = strip_game_tokens(english) if english is not None else None
    if clean_english is not None:
        if clean == clean_english and clean:
            return True
        if text_similarity(clean_english, clean) >= SIMILARITY_THRESHOLD:
            return True

    if has_vietnamese(clean):
        if clean_english and _has_remaining_english_words(clean_english, clean):
            return True
        if _is_english_by_cld3(clean, min_len=CLD3_MIXED_MIN_LEN):
            return True
        return False

    if len(clean) < CLD3_MIN_LEN:
        if english is not None:
            return False
        return _ascii_letter_ratio(clean) > ASCII_LETTER_THRESHOLD

    if _is_vietnamese_by_cld3(clean):
        return False
    if _is_english_by_cld3(clean, min_len=CLD3_MIN_LEN):
        return True

    if english is not None:
        return False
    return _ascii_letter_ratio(clean) > ASCII_LETTER_THRESHOLD


def has_han(text: str) -> bool:
    for character in text or "":
        code = ord(character)
        if 0x3400 <= code <= 0x4DBF or 0x4E00 <= code <= 0x9FFF:
            return True
    return False


def is_translatable_bracket_tag(token: str) -> bool:
    """[瞬], <诸侯讨董> là nhãn/tên game — dịch được. Không phải {0}, <b>, [TIP:]."""
    if len(token) < 3:
        return False
    if token.startswith("[") and token.endswith("]"):
        inner = token[1:-1]
    elif token.startswith("<") and token.endswith(">"):
        inner = token[1:-1]
    else:
        return False
    inner = inner.strip()
    if not inner or inner.startswith("/"):
        return False
    return bool(_HAN_RE.search(inner))


def square_bracket_tags(text: str) -> list[str]:
    return [
        match.group(0)
        for match in TOKEN_PATTERN.finditer(text or "")
        if match.group(0).startswith("[")
    ]


def angle_bracket_tags(text: str) -> list[str]:
    return [
        match.group(0)
        for match in TOKEN_PATTERN.finditer(text or "")
        if match.group(0).startswith("<")
    ]


def protected_tokens(text: str) -> list[str]:
    source = text or ""
    tokens: list[str] = []
    seen: set[str] = set()
    plural_ranges: list[tuple[int, int]] = []
    for match in PLURAL_PATTERN.finditer(source):
        token = match.group(0)
        plural_ranges.append(match.span())
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    for match in TOKEN_PATTERN.finditer(source):
        if any(
            start <= match.start() and match.end() <= end
            for start, end in plural_ranges
        ):
            continue
        token = match.group(0)
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens


def _token_preserved(token: str, target: str) -> bool:
    if re.search(r":\s*plural\b", token, re.IGNORECASE):
        variable = re.match(r"\{\s*([^:}]+)\s*:", token)
        return bool(
            variable
            and re.search(
                rf"\{{\s*{re.escape(variable.group(1).strip())}\s*:\s*plural\b",
                target,
                re.IGNORECASE,
            )
        )
    return token in target


def missing_tokens(source: str, target: str) -> list[str]:
    missing = [
        token
        for token in protected_tokens(source)
        if not is_translatable_bracket_tag(token)
        and not _token_preserved(token, target)
    ]
    source_labels = [
        token
        for token in square_bracket_tags(source)
        if is_translatable_bracket_tag(token)
    ]
    target_labels = square_bracket_tags(target)
    if len(target_labels) < len(source_labels):
        missing.extend(source_labels[len(target_labels) :])
    source_angles = [
        token
        for token in angle_bracket_tags(source)
        if is_translatable_bracket_tag(token)
    ]
    target_angles = angle_bracket_tags(target)
    if len(target_angles) < len(source_angles):
        missing.extend(source_angles[len(target_angles) :])
    return missing


def is_proper_name_file(path: Path) -> bool:
    stem = path.stem.casefold()
    return stem in {"citizennamestext", "citynamestext"} or stem.endswith("namestext")


def detect_style(path: Path) -> str:
    normalized = path.as_posix().casefold()
    if "leaderdialog" in normalized or (
        "loadingtext" in normalized and "leader" in normalized
    ):
        return "leader"
    if any(token in normalized for token in ("civilopedia", "narrative", "story")):
        return "lore"
    if any(
        token in normalized
        for token in ("uitext", "shelltext", "optionstext", "ingametext")
    ):
        return "ui"
    return "game"
