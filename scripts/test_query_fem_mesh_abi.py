from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import sys

import pytest


SCRIPT = Path(__file__).with_name("query_fem_mesh_abi.py")
SPEC = importlib.util.spec_from_file_location("query_fem_mesh_abi", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
query = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = query
SPEC.loader.exec_module(query)


def record(*, mesh_version=2, mesh_size=232, offset_index=None, fingerprint=None) -> bytes:
    offsets = [0, 4, *range(8, 232, 8)]
    if offset_index is not None:
        offsets[offset_index] += 1
    magic = query.MAGIC + b"\0" * (query.MAGIC_CAPACITY - len(query.MAGIC))
    fingerprint_bytes = (fingerprint or query.REQUIRED_FINGERPRINT).encode()
    fingerprint_raw = fingerprint_bytes + b"\0" * (query.FINGERPRINT_CAPACITY - len(fingerprint_bytes))
    return query.RECORD.pack(
        magic, 1, query.RECORD.size, 0x01020304, 0,
        1, 360, mesh_version, mesh_size, 30, 0,
        *offsets, fingerprint_raw,
    )


def elf(
    payload: bytes | None = None,
    *,
    duplicate_section=False,
    extra_magic=False,
    elf_class=2,
    elf_data=1,
    section_type=1,
    section_alignment=8,
    bad_shstr_bounds=False,
) -> bytes:
    names = b"\0.shstrtab\0.fullmag_fem_abi\0"
    shstr_name = 1
    abi_name = names.index(b".fullmag_fem_abi")
    blob = bytearray(b"\0" * query.ELF_HEADER.size)
    shstr_offset = len(blob)
    blob.extend(names)
    while len(blob) % 8:
        blob.append(0)
    abi_offset = len(blob)
    if payload is not None:
        blob.extend(payload)
    if extra_magic:
        blob.extend(b"unrelated:" + query.MAGIC)
    while len(blob) % 8:
        blob.append(0)
    section_offset = len(blob)
    entries = [(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)]
    entries.append((shstr_name, 3, 0, 0, shstr_offset,
                    1 << 30 if bad_shstr_bounds else len(names), 0, 0, 1, 0))
    if payload is not None:
        abi_entry = (abi_name, section_type, 2, 0, abi_offset, len(payload), 0, 0, section_alignment, 0)
        entries.append(abi_entry)
        if duplicate_section:
            entries.append(abi_entry)
    for entry in entries:
        blob.extend(query.ELF_SECTION.pack(*entry))
    ident = b"\x7fELF" + bytes((elf_class, elf_data, 1)) + b"\0" * 9
    header = query.ELF_HEADER.pack(
        ident, 3, 62, 1, 0, 0, section_offset, 0, query.ELF_HEADER.size,
        0, 0, query.ELF_SECTION.size, len(entries), 1,
    )
    blob[:query.ELF_HEADER.size] = header
    return bytes(blob)


def write(tmp_path: Path, content: bytes) -> Path:
    path = tmp_path / "libfullmag_fem.so"
    path.write_bytes(content)
    return path


def test_exact_launcher_contract_and_unrelated_duplicate_magic(tmp_path: Path) -> None:
    result = query.query_mesh_abi(write(tmp_path, elf(record(), extra_magic=True)))
    assert result["mesh_desc_abi_version"] == 2
    assert result["mesh_desc_field_offsets"] == query.REQUIRED_FIELD_OFFSETS


@pytest.mark.parametrize(
    "payload",
    [
        record(mesh_version=1),
        record(mesh_size=224),
        record(offset_index=17),
        record(fingerprint="wrong-fingerprint"),
    ],
    ids=("old-v1", "wrong-size", "one-wrong-offset", "wrong-fingerprint"),
)
def test_launcher_contract_mismatch_fails_closed(tmp_path: Path, payload: bytes) -> None:
    with pytest.raises(SystemExit, match="launcher-required contract"):
        query.query_mesh_abi(write(tmp_path, elf(payload)))


def test_missing_and_duplicate_sections_fail_closed(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="exactly one"):
        query.query_mesh_abi(write(tmp_path, elf(None)))
    with pytest.raises(SystemExit, match="exactly one"):
        query.query_mesh_abi(write(tmp_path, elf(record(), duplicate_section=True)))


def test_corrupt_record_magic_fails_closed(tmp_path: Path) -> None:
    payload = bytearray(record())
    payload[0] ^= 0x01
    with pytest.raises(SystemExit, match="magic payload mismatch"):
        query.query_mesh_abi(write(tmp_path, elf(bytes(payload))))


@pytest.mark.parametrize("elf_class,elf_data", [(1, 1), (2, 2)])
def test_wrong_elf_class_or_endian_fails_closed(tmp_path: Path, elf_class: int, elf_data: int) -> None:
    with pytest.raises(SystemExit, match="ELF64 little-endian"):
        query.query_mesh_abi(write(tmp_path, elf(record(), elf_class=elf_class, elf_data=elf_data)))


def test_truncated_and_bad_shstr_bounds_fail_closed(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        query.query_mesh_abi(write(tmp_path, elf(record())[:40]))
    with pytest.raises(SystemExit, match="section-name table"):
        query.query_mesh_abi(write(tmp_path, elf(record(), bad_shstr_bounds=True)))


@pytest.mark.parametrize(
    "section_type,section_alignment",
    [(8, 8), (1, 32)],
)
def test_bad_section_type_or_alignment_fails_closed(
    tmp_path: Path, section_type: int, section_alignment: int
) -> None:
    with pytest.raises(SystemExit, match="invalid type, size, or alignment"):
        query.query_mesh_abi(write(
            tmp_path,
            elf(record(), section_type=section_type, section_alignment=section_alignment),
        ))
