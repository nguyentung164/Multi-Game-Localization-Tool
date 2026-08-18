from __future__ import annotations

import copy
import hashlib
import os
import shutil
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict, deque
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from io import StringIO
from pathlib import Path

from .types import ValidationError

SUPPORTED_EXTENSIONS = {".xml", ".vtt"}
_TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")
LOCALIZED_ENTRY_TYPES = {"Row", "Replace"}
STRUCTURAL_ENTRY_TYPES = {"Delete"}
SUPPORTED_ENTRY_TYPES = LOCALIZED_ENTRY_TYPES | STRUCTURAL_ENTRY_TYPES


def local_name(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def read_text_file(path: Path) -> str:
    """Đọc file text, thử UTF-8 trước rồi fallback sang Windows-1252/Latin-1."""
    data = path.read_bytes()
    for encoding in _TEXT_ENCODINGS:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def parse_xml(path: Path) -> ET.ElementTree:
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    try:
        return ET.parse(path, parser=parser)
    except (UnicodeDecodeError, ET.ParseError):
        fallback = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
        return ET.parse(StringIO(read_text_file(path)), parser=fallback)


def tagged_entries(
    tree: ET.ElementTree,
    entry_types: set[str] = SUPPORTED_ENTRY_TYPES,
) -> list[ET.Element]:
    return [
        element
        for element in tree.getroot().iter()
        if local_name(element.tag) in entry_types and element.get("Tag")
    ]


def entry_key(element: ET.Element) -> tuple[str, str]:
    return local_name(element.tag), element.get("Tag", "")


def entry_keys(tree: ET.ElementTree) -> list[tuple[str, str]]:
    return [entry_key(element) for element in tagged_entries(tree)]


def xml_structure(tree: ET.ElementTree) -> tuple[object, ...]:
    """Describe XML structure/attributes while ignoring localized Text content."""

    def visit(element: ET.Element) -> tuple[object, ...]:
        name = local_name(element.tag)
        attributes = tuple(sorted(element.attrib.items()))
        content = "" if name == "Text" else (element.text or "").strip()
        return (
            name,
            attributes,
            content,
            tuple(visit(child) for child in element if isinstance(child.tag, str)),
        )

    return visit(tree.getroot())


def text_children(element: ET.Element) -> list[ET.Element]:
    return [child for child in element if local_name(child.tag) == "Text"]


def entry_text(element: ET.Element) -> str:
    """Ghép nội dung các thẻ Text trong Row/Replace/Delete (có thể rỗng)."""
    return "\n".join(child.text or "" for child in text_children(element))


def set_entry_text(element: ET.Element, text: str) -> None:
    """Ghi nội dung đã ghép trở lại các thẻ Text con."""
    children = text_children(element)
    if not children:
        return
    if len(children) == 1:
        children[0].text = text
        return
    parts = text.split("\n")
    for index, child in enumerate(children):
        child.text = parts[index] if index < len(parts) else ""


def set_vtt_cue_text(block: VttBlock, text: str) -> None:
    if block.timing_index is None:
        raise ValueError("VTT block không có timing")
    block.lines = block.lines[: block.timing_index + 1] + text.split("\n")


def unmatched_tagged_entries(
    primary: ET.ElementTree,
    other: ET.ElementTree | None = None,
) -> list[ET.Element]:
    """Các entry bên primary vượt số lần xuất hiện bên other (giống counted_difference)."""
    other_counts = Counter(entry_keys(other)) if other is not None else Counter()
    seen: Counter[tuple[str, str]] = Counter()
    result: list[ET.Element] = []
    for element in tagged_entries(primary):
        key = entry_key(element)
        seen[key] += 1
        if seen[key] > other_counts[key]:
            result.append(element)
    return result


def collect_files(root: Path) -> dict[str, Path]:
    if not root.is_dir():
        return {}
    result: dict[str, Path] = {}
    for current, directories, names in os.walk(root):
        directories.sort(key=str.casefold)
        for name in sorted(names, key=str.casefold):
            path = Path(current) / name
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            relative = path.relative_to(root)
            key = relative.as_posix().casefold()
            if key in result:
                raise ValidationError(
                    f"Trùng đường dẫn không phân biệt hoa thường: {result[key]} và {relative}"
                )
            result[key] = relative
    return result


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_bytes_write(destination: Path, data: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)


def atomic_text_write(destination: Path, text: str) -> None:
    atomic_bytes_write(destination, text.encode("utf-8"))


def atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temp_path = Path(temp_name)
    try:
        shutil.copy2(source, temp_path)
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)


def xml_bytes(tree: ET.ElementTree) -> bytes:
    ET.indent(tree, space="\t")
    with tempfile.SpooledTemporaryFile() as stream:
        tree.write(
            stream,
            encoding="utf-8",
            xml_declaration=True,
            short_empty_elements=True,
        )
        stream.seek(0)
        return stream.read()


def write_xml_atomic(tree: ET.ElementTree, destination: Path) -> None:
    data = xml_bytes(tree)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".xml.tmp", dir=destination.parent
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        parse_xml(temp_path)
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)


@dataclass
class VttBlock:
    lines: list[str]
    timing_index: int | None

    @property
    def timing(self) -> str | None:
        if self.timing_index is None:
            return None
        return self.lines[self.timing_index].strip()

    @property
    def text(self) -> str:
        if self.timing_index is None:
            return ""
        return "\n".join(self.lines[self.timing_index + 1 :])

    def copy(self) -> VttBlock:
        return VttBlock(list(self.lines), self.timing_index)


def parse_vtt(path: Path) -> list[VttBlock]:
    raw = read_text_file(path)
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if not normalized.startswith("WEBVTT"):
        raise ValueError("File không bắt đầu bằng WEBVTT")
    blocks: list[VttBlock] = []
    for raw_block in normalized.strip().split("\n\n"):
        lines = raw_block.splitlines()
        timing_index = next(
            (index for index, line in enumerate(lines) if "-->" in line), None
        )
        blocks.append(VttBlock(lines, timing_index))
    return blocks


def vtt_cues(blocks: Iterable[VttBlock]) -> list[VttBlock]:
    return [block for block in blocks if block.timing is not None]


def vtt_text(blocks: Sequence[VttBlock]) -> str:
    return "\n\n".join("\n".join(block.lines) for block in blocks) + "\n"


def write_vtt_atomic(blocks: Sequence[VttBlock], destination: Path) -> None:
    content = vtt_text(blocks)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".vtt.tmp", dir=destination.parent
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        parse_vtt(temp_path)
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)


def counted_difference(
    primary: Iterable[tuple[str, str]],
    other: Iterable[tuple[str, str]],
) -> list[tuple[str, str]]:
    other_counts = Counter(other)
    seen: Counter[tuple[str, str]] = Counter()
    result: list[tuple[str, str]] = []
    for item in primary:
        seen[item] += 1
        if seen[item] > other_counts[item]:
            result.append(item)
    return result


def unmatched_cues(
    primary: Sequence[VttBlock], other: Sequence[VttBlock]
) -> list[VttBlock]:
    other_counts = Counter(block.timing for block in vtt_cues(other))
    seen: Counter[str | None] = Counter()
    result: list[VttBlock] = []
    for block in vtt_cues(primary):
        seen[block.timing] += 1
        if seen[block.timing] > other_counts[block.timing]:
            result.append(block)
    return result


def vtt_structure(blocks: Sequence[VttBlock]) -> list[tuple[str, tuple[str, ...]]]:
    result: list[tuple[str, tuple[str, ...]]] = []
    for block in blocks:
        if block.timing_index is None:
            result.append(("metadata", tuple(block.lines)))
        else:
            result.append(("cue", tuple(block.lines[: block.timing_index + 1])))
    return result


def merge_vtt(
    source_blocks: Sequence[VttBlock], target_blocks: Sequence[VttBlock]
) -> list[VttBlock]:
    translated: defaultdict[str, deque[VttBlock]] = defaultdict(deque)
    for block in vtt_cues(target_blocks):
        if block.timing is not None:
            translated[block.timing].append(block)
    merged: list[VttBlock] = []
    for source in source_blocks:
        result = source.copy()
        if source.timing and translated[source.timing]:
            target = translated[source.timing].popleft()
            assert source.timing_index is not None
            assert target.timing_index is not None
            result.lines = (
                source.lines[: source.timing_index + 1]
                + target.lines[target.timing_index + 1 :]
            )
        merged.append(result)
    return merged


def _merge_translated_text(source: ET.Element, target: ET.Element) -> ET.Element:
    merged = copy.deepcopy(source)
    target_texts = deque(text_children(target))
    for index, child in enumerate(list(merged)):
        if local_name(child.tag) != "Text" or not target_texts:
            continue
        translated = copy.deepcopy(child)
        target_text = target_texts.popleft()
        translated.text = target_text.text
        translated[:] = [copy.deepcopy(nested) for nested in target_text]
        translated.tail = child.tail
        merged.remove(child)
        merged.insert(index, translated)
    merged.tail = source.tail
    return merged


def merge_xml(
    source_tree: ET.ElementTree, target_tree: ET.ElementTree
) -> ET.ElementTree:
    result = copy.deepcopy(source_tree)
    target_by_key: defaultdict[tuple[str, str], deque[ET.Element]] = defaultdict(deque)
    for element in tagged_entries(target_tree, LOCALIZED_ENTRY_TYPES):
        target_by_key[entry_key(element)].append(element)
    for parent in result.getroot().iter():
        for index, child in enumerate(list(parent)):
            key = entry_key(child)
            if local_name(child.tag) not in LOCALIZED_ENTRY_TYPES:
                continue
            if not key[1] or not target_by_key[key]:
                continue
            parent.remove(child)
            parent.insert(
                index, _merge_translated_text(child, target_by_key[key].popleft())
            )
    return result


def iter_localized_text(
    tree: ET.ElementTree,
) -> Iterator[tuple[ET.Element, ET.Element]]:
    for element in tagged_entries(tree, LOCALIZED_ENTRY_TYPES):
        for child in text_children(element):
            yield element, child
