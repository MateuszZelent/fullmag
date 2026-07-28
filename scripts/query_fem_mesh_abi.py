#!/usr/bin/env python3
"""Read the immutable mesh ABI record embedded in a built libfullmag_fem."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import struct


FIELD_NAMES = (
    "abi_version", "struct_size", "nodes_xyz", "nodes_xyz_len",
    "cell_types", "cell_types_len", "cell_offsets", "cell_offsets_len",
    "cell_nodes", "cell_nodes_len", "cell_global_ordinals",
    "cell_global_ordinals_len", "cell_markers", "cell_markers_len",
    "facet_types", "facet_types_len", "facet_roles", "facet_roles_len",
    "facet_offsets", "facet_offsets_len", "facet_nodes", "facet_nodes_len",
    "facet_global_ordinals", "facet_global_ordinals_len", "facet_markers",
    "facet_markers_len", "periodic_node_pairs", "periodic_node_pairs_len",
    "periodic_boundary_pair_markers", "periodic_boundary_pair_markers_len",
)
MAGIC = b"FULLMAG_FEM_MESH_ABI_RECORD_V1"
MAGIC_CAPACITY = 40
FINGERPRINT_CAPACITY = 96
RECORD = struct.Struct(f"<40s10I{len(FIELD_NAMES)}Q96s")
ELF_HEADER = struct.Struct("<16sHHIQQQIHHHHHH")
ELF_SECTION = struct.Struct("<IIQQQQIIQQ")
SECTION_NAME = b".fullmag_fem_abi"
REQUIRED_MESH_VERSION = 2
REQUIRED_MESH_SIZE = 232
REQUIRED_FIELD_OFFSETS = dict(
    zip(FIELD_NAMES, (0, 4, *range(8, 232, 8)), strict=True)
)
REQUIRED_FINGERPRINT = (
    "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals"
)


def zero_terminated_text(raw: bytes, label: str) -> str:
    nul = raw.find(b"\0")
    if nul < 0 or any(raw[nul + 1 :]):
        raise SystemExit(f"{label} is not NUL-terminated with a zero-filled tail")
    try:
        value = raw[:nul].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SystemExit(f"{label} is not valid UTF-8") from exc
    if not value:
        raise SystemExit(f"{label} is empty")
    return value


def checked_span(offset: int, size: int, total: int, label: str) -> tuple[int, int]:
    if offset < 0 or size < 0 or offset > total or size > total - offset:
        raise SystemExit(f"{label} extends beyond the built library")
    return offset, offset + size


def elf_abi_section(binary: bytes) -> bytes:
    if len(binary) < ELF_HEADER.size:
        raise SystemExit("built libfullmag_fem has a truncated ELF header")
    header = ELF_HEADER.unpack_from(binary)
    ident = header[0]
    if ident[:4] != b"\x7fELF":
        raise SystemExit("built libfullmag_fem is not an ELF binary")
    if ident[4] != 2 or ident[5] != 1 or ident[6] != 1:
        raise SystemExit("built libfullmag_fem must be ELF64 little-endian version 1")
    section_offset = header[6]
    section_entry_size = header[11]
    section_count = header[12]
    shstr_index = header[13]
    if section_entry_size != ELF_SECTION.size or section_count == 0:
        raise SystemExit("invalid ELF64 section table shape")
    table_start, _ = checked_span(
        section_offset, section_entry_size * section_count, len(binary), "ELF section table"
    )
    if shstr_index >= section_count:
        raise SystemExit("ELF section-name table index is out of bounds")

    def section(index: int) -> tuple[int, ...]:
        return ELF_SECTION.unpack_from(binary, table_start + index * section_entry_size)

    shstr = section(shstr_index)
    shstr_start, shstr_end = checked_span(shstr[4], shstr[5], len(binary), "ELF section-name table")
    names = binary[shstr_start:shstr_end]

    def section_name(name_offset: int) -> bytes:
        if name_offset >= len(names):
            raise SystemExit("ELF section name offset is out of bounds")
        end = names.find(b"\0", name_offset)
        if end < 0:
            raise SystemExit("ELF section name is not NUL-terminated")
        return names[name_offset:end]

    matches = []
    for index in range(section_count):
        entry = section(index)
        if section_name(entry[0]) == SECTION_NAME:
            matches.append(entry)
    if len(matches) != 1:
        raise SystemExit(
            f"built libfullmag_fem must contain exactly one {SECTION_NAME.decode()} section, found {len(matches)}"
        )
    entry = matches[0]
    if entry[1] != 1 or entry[5] != RECORD.size or entry[8] != 8:
        raise SystemExit("mesh ABI ELF section has invalid type, size, or alignment")
    start, end = checked_span(entry[4], entry[5], len(binary), "mesh ABI ELF section")
    return binary[start:end]


def query_mesh_abi(library: Path) -> dict[str, object]:
    section = elf_abi_section(library.read_bytes())
    values = RECORD.unpack(section)
    magic_raw = values[0]
    integers = values[1:11]
    field_offsets = values[11:11 + len(FIELD_NAMES)]
    fingerprint_raw = values[-1]
    (
        record_version, record_size, endian_tag, record_reserved,
        layout_version, layout_size, mesh_version, mesh_size,
        field_count, layout_reserved,
    ) = integers
    if zero_terminated_text(magic_raw, "mesh ABI record magic").encode() != MAGIC:
        raise SystemExit("mesh ABI record magic payload mismatch")
    if record_version != 1 or record_size != RECORD.size:
        raise SystemExit("unsupported mesh ABI record version or size")
    if endian_tag != 0x01020304:
        raise SystemExit("mesh ABI record endian tag mismatch")
    if record_reserved != 0 or layout_reserved != 0:
        raise SystemExit("mesh ABI record reserved fields must be zero")
    if layout_version != 1 or layout_size != 360 or field_count != len(FIELD_NAMES):
        raise SystemExit("unsupported mesh ABI query layout version, size, or field count")
    fingerprint = zero_terminated_text(fingerprint_raw, "mesh ABI fingerprint")
    actual = {
        "mesh_desc_abi_version": mesh_version,
        "mesh_desc_struct_size": mesh_size,
        "mesh_desc_layout_fingerprint": fingerprint,
        "mesh_desc_field_offsets": dict(zip(FIELD_NAMES, field_offsets)),
    }
    required = {
        "mesh_desc_abi_version": REQUIRED_MESH_VERSION,
        "mesh_desc_struct_size": REQUIRED_MESH_SIZE,
        "mesh_desc_layout_fingerprint": REQUIRED_FINGERPRINT,
        "mesh_desc_field_offsets": REQUIRED_FIELD_OFFSETS,
    }
    if actual != required:
        raise SystemExit(
            "built libfullmag_fem mesh ABI does not match the launcher-required contract: "
            f"actual={json.dumps(actual, sort_keys=True)} required={json.dumps(required, sort_keys=True)}"
        )
    return actual


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("library", type=Path)
    args = parser.parse_args()
    print(json.dumps(query_mesh_abi(args.library), sort_keys=True))


if __name__ == "__main__":
    main()
