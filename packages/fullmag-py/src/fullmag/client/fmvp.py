"""Decoder for FMVP field-vector payloads (ADR 0053, spec python-live-client-v1 §6).

Mirrors the Control Room decoder (``kernel/api/codecs/fieldVectorCodec.ts`` and
``artifactFieldVectorCodec.ts``) and the Rust producer in
``crates/fullmag-api/src/field_store.rs``: versions 2-5 (live/observation
fields) and 6 (artifact inspection carriers).  Every structural check of the
TypeScript decoder is kept, so a payload accepted here is accepted there.
"""
from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from typing import Optional

import numpy as np

__all__ = ["FieldVector", "FieldVectorDecodeError", "decode_field_vector"]

HEADER_LEN = 48
KIND_F64 = 1
_FIXED_LEN = {3: 68, 4: 80, 5: 88}
_METADATA_VERSION = {3: 2, 4: 3, 5: 4}
_INDEXING = {0: "full_domain", 1: "explicit_node_indices", 2: "sampled_node_indices", 3: "legacy_count_only"}
_ARTIFACT_INDEXING = {4: "source_nodes", 5: "sample_nodes", 6: "point_samples", 7: "tet4_cell_local_nodes", 8: "cell_centers"}
_SCOPE_KINDS = frozenset({"airbox", "full", "magnetic_only", "layer", "object", "part", "region", "selection"})
_SOURCE_KINDS = frozenset({"live", "observation_frame"})
_CONTROL = re.compile("[\u0000-\u001f\u007f-\u009f]")
_DIGEST = re.compile(r"^(sha256:)?[0-9a-f]{64}$")
_FIELD_GENERATION = re.compile(r"^sha256:[0-9a-f]{64}$")
_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024


class FieldVectorDecodeError(ValueError):
    """The payload is not a well-formed FMVP document."""


@dataclass(frozen=True)
class FieldVector:
    """A decoded field sample set; ``values`` has shape ``(point_count, n_comp)``."""

    format_version: int
    quantity_id: str
    n_comp: int
    grid: tuple[int, int, int]
    values: np.ndarray
    indexing: str
    node_indices: Optional[np.ndarray] = None
    domain_generation_id: Optional[str] = None
    field_generation_id: Optional[str] = None
    mesh_topology_revision: Optional[str] = None
    mesh_topology_hash: Optional[str] = None
    scope_kind: Optional[str] = None
    scope_id: Optional[str] = None
    source_kind: Optional[str] = None
    source_id: Optional[str] = None
    source_revision: Optional[str] = None
    artifact_identity_ids: Optional[np.ndarray] = None

    @property
    def point_count(self) -> int:
        return int(self.values.shape[0])

    def to_numpy(self) -> np.ndarray:
        """Return the ``(point_count, n_comp)`` sample array (SI units)."""
        return self.values

    def as_grid(self) -> np.ndarray:
        """Return a full-domain FDM field as ``(nz, ny, nx, n_comp)`` (x varies fastest)."""
        if self.indexing not in {"full_domain", "legacy_count_only"}:
            raise ValueError(f"{self.indexing} samples do not cover a regular grid")
        nx, ny, nz = self.grid
        return self.values.reshape(nz, ny, nx, self.n_comp)

    def as_complex(self) -> np.ndarray:
        """Return interleaved (re, im) components as ``(point_count, n_comp // 2)`` complex values."""
        if self.n_comp < 2 or self.n_comp % 2:
            raise ValueError(f"{self.n_comp} components cannot form complex pairs")
        return self.values[:, 0::2] + 1j * self.values[:, 1::2]


def decode_field_vector(payload: bytes) -> FieldVector:
    """Decode an FMVP v2-v6 payload; raise :class:`FieldVectorDecodeError` when malformed."""
    data = memoryview(payload).cast("B")
    if len(data) < HEADER_LEN:
        raise FieldVectorDecodeError(f"FMVP buffer too short: {len(data)} bytes, need at least {HEADER_LEN}")
    if bytes(data[0:4]) != b"FMVP":
        raise FieldVectorDecodeError(f"invalid FMVP magic: {bytes(data[0:4])!r}")
    version = data[4]
    if version == 6:
        return _decode_artifact(data)
    if version not in {2, 3, 4, 5}:
        raise FieldVectorDecodeError(f"unsupported FMVP version {version}")
    if data[5] != KIND_F64:
        raise FieldVectorDecodeError(f"unsupported FMVP value kind {data[5]}")
    n_comp = data[6]
    if n_comp < 1:
        raise FieldVectorDecodeError("FMVP component count must be at least 1")
    metadata_length = _u32(data, 8) if version >= 3 else 0
    if version >= 3 and metadata_length < _FIXED_LEN[version]:
        raise FieldVectorDecodeError(f"FMVP metadata block too short: {metadata_length} bytes")
    value_count = _u32(data, 12)
    grid = (_u32(data, 16), _u32(data, 20), _u32(data, 24))
    value_offset = HEADER_LEN + metadata_length
    if len(data) != value_offset + value_count * 8:
        raise FieldVectorDecodeError(f"FMVP buffer size mismatch: expected {value_offset + value_count * 8}, got {len(data)}")
    if value_offset % 8:
        raise FieldVectorDecodeError(f"FMVP metadata length is not 8-byte aligned: {metadata_length}")
    point_count = grid[0] * grid[1] * grid[2]
    if value_count != point_count * n_comp:
        raise FieldVectorDecodeError(f"FMVP element count mismatch: expected {point_count * n_comp}, got {value_count}")
    values = _values(data, value_offset, value_count, n_comp)
    header_id = bytes(data[28:44])
    if version == 2:
        return FieldVector(2, _header_quantity(header_id), n_comp, grid, values, "legacy_count_only")
    return _decode_metadata(data, version, metadata_length, point_count, n_comp, grid, values, header_id)


def _decode_metadata(
    data: memoryview,
    version: int,
    metadata_length: int,
    point_count: int,
    n_comp: int,
    grid: tuple[int, int, int],
    values: np.ndarray,
    header_id: bytes,
) -> FieldVector:
    start = HEADER_LEN
    end = start + metadata_length
    fixed = _FIXED_LEN[version]
    if bytes(data[start : start + 4]) != b"FMMI":
        raise FieldVectorDecodeError("invalid FMVP metadata magic")
    if _u16(data, start + 4) != _METADATA_VERSION[version]:
        raise FieldVectorDecodeError(f"unsupported FMVP metadata version {_u16(data, start + 4)}")
    if _u16(data, start + 6) != 0:
        raise FieldVectorDecodeError("FMVP metadata reserved flags must be zero")
    domain_length = _u16(data, start + 8)
    if domain_length == 0:
        raise FieldVectorDecodeError("FMVP domain generation identity must not be empty")
    source_kind_length = _u16(data, start + 10) if version >= 4 else 0
    source_id_length = _u16(data, start + 12) if version >= 4 else 0
    field_generation_length = _u16(data, start + 14) if version >= 4 else 0
    source_revision = _u64(data, start + 68) if version >= 4 else 0
    source_lengths = (source_kind_length, source_id_length, field_generation_length)
    if version == 4 and 0 in source_lengths:
        raise FieldVectorDecodeError("FMVP v4 source and field generation identities must not be empty")
    if version == 5:
        unqualified = all(length == 0 for length in source_lengths)
        if not unqualified and 0 in source_lengths:
            raise FieldVectorDecodeError("FMVP v5 source identity must be wholly qualified or empty")
        if unqualified and source_revision != 0:
            raise FieldVectorDecodeError("FMVP v5 unqualified source revision must be zero")
    if version == 3 and any(data[start + 10 : start + 16]):
        raise FieldVectorDecodeError("FMVP metadata reserved bytes must be zero")
    topology_revision = _u64(data, start + 16)
    topology_hash_bytes = bytes(data[start + 24 : start + 56])
    indexing_code = _u32(data, start + 56)
    if indexing_code not in _INDEXING:
        raise FieldVectorDecodeError(f"unsupported FMVP indexing code {indexing_code}")
    indexing = _INDEXING[indexing_code]
    node_count = _u32(data, start + 60)
    revision_text: Optional[str] = str(topology_revision)
    hash_text: Optional[str] = topology_hash_bytes.hex()
    if version == 5 and indexing == "legacy_count_only":
        if node_count or topology_revision or any(topology_hash_bytes):
            raise FieldVectorDecodeError("FMVP v5 absent-topology sentinel must have zero nodes and topology")
        revision_text = hash_text = None
    scope_kind_length = _u16(data, start + 64)
    scope_id_length = _u16(data, start + 66)
    if version >= 4 and any(data[start + 76 : start + 80]):
        raise FieldVectorDecodeError(f"FMVP v{version} metadata reserved bytes must be zero")
    quantity_length = _u16(data, start + 80) if version == 5 else 0
    if version == 5:
        if quantity_length == 0:
            raise FieldVectorDecodeError("FMVP v5 full quantity identity must not be empty")
        if any(data[start + 82 : start + 88]):
            raise FieldVectorDecodeError("FMVP v5 metadata reserved bytes must be zero")
    lengths = (scope_kind_length, scope_id_length, domain_length, source_kind_length, source_id_length, field_generation_length, quantity_length)
    offset = start + fixed
    texts = []
    for length in lengths:
        if offset + length > end:
            raise FieldVectorDecodeError("FMVP metadata string lengths exceed metadata block")
        texts.append(_utf8(data[offset : offset + length]))
        offset += length
    scope_kind, scope_id, domain_id, source_kind, source_id, field_generation, quantity = texts
    nodes_end = offset + node_count * 4
    if nodes_end > end:
        raise FieldVectorDecodeError("FMVP metadata node indices exceed metadata block")
    if end - nodes_end >= 8:
        raise FieldVectorDecodeError("FMVP metadata contains excess trailing bytes")
    if any(data[nodes_end:end]):
        raise FieldVectorDecodeError("FMVP metadata padding bytes must be zero")
    if version == 5:
        if not quantity or _CONTROL.search(quantity):
            raise FieldVectorDecodeError("FMVP v5 full quantity identity is empty or contains control characters")
        if quantity.encode("utf-8")[:16].ljust(16, b"\0") != header_id:
            raise FieldVectorDecodeError("FMVP v5 quantity prefix does not match full metadata quantity identity")
    if indexing in {"explicit_node_indices", "sampled_node_indices"} and node_count != point_count:
        raise FieldVectorDecodeError(f"FMVP node index count mismatch: expected {point_count}, got {node_count}")
    if indexing in {"full_domain", "legacy_count_only"} and node_count:
        raise FieldVectorDecodeError(f"FMVP {indexing} payload must not include node indices")
    if version == 5 and source_kind and (not source_id or not field_generation):
        raise FieldVectorDecodeError("FMVP v5 qualified source identities must not be empty")
    if scope_kind and scope_kind not in _SCOPE_KINDS:
        raise FieldVectorDecodeError(f"unsupported FMVP scope_kind {scope_kind!r}")
    if source_kind and source_kind not in _SOURCE_KINDS:
        raise FieldVectorDecodeError(f"unsupported FMVP source_kind {source_kind!r}")
    node_indices = np.frombuffer(data, dtype="<u4", count=node_count, offset=offset).copy() if node_count else None
    return FieldVector(
        format_version=version,
        quantity_id=quantity if version == 5 else _header_quantity(header_id),
        n_comp=n_comp,
        grid=grid,
        values=values,
        indexing=indexing,
        node_indices=node_indices,
        domain_generation_id=domain_id,
        field_generation_id=field_generation or None,
        mesh_topology_revision=revision_text,
        mesh_topology_hash=hash_text,
        scope_kind=scope_kind or None,
        scope_id=scope_id or None,
        source_kind=source_kind or None,
        source_id=source_id or None,
        source_revision=str(source_revision) if version >= 4 and source_kind else None,
    )


def _decode_artifact(data: memoryview) -> FieldVector:
    start, fixed = HEADER_LEN, 88

    def fail(message: str) -> FieldVectorDecodeError:
        return FieldVectorDecodeError(f"FMVP v6: {message}")

    if len(data) < start + fixed or len(data) > _MAX_ARTIFACT_BYTES:
        raise fail("bounded header/payload length")
    if data[5] != KIND_F64 or data[7] != 0 or _u32(data, 44) != 0:
        raise fail("header kind/reserved")
    n_comp, metadata_length, value_count = data[6], _u32(data, 8), _u32(data, 12)
    count, value_start = _u32(data, 16), start + _u32(data, 8)
    if not n_comp or not count or _u32(data, 20) != 1 or _u32(data, 24) != 1 or count * n_comp != value_count:
        raise fail("grid/component count")
    if metadata_length < fixed or metadata_length % 8 or value_start + value_count * 8 != len(data):
        raise fail("metadata/value lengths")
    if bytes(data[start : start + 4]) != b"FMMI" or _u16(data, start + 4) != 4 or _u16(data, start + 6) != 0 or _u32(data, start + 84) != 0:
        raise fail("metadata version/reserved")
    code, mapping_count, stride = _u32(data, start + 56), _u32(data, start + 60), _u32(data, start + 76)
    indexing = _ARTIFACT_INDEXING.get(code)
    if indexing is None or _u32(data, start + 80) != code or mapping_count != count or stride != (24 if code == 7 else 8) or (code == 7 and count % 4):
        raise fail("mapping code/count/stride")
    revision, source_revision = _u64(data, start + 16), _u64(data, start + 68)
    if revision == 0:
        raise fail("empty carrier revision")
    digest = bytes(data[start + 24 : start + 56]).hex()
    if revision != _u64(data, start + 24):
        raise fail("content-derived carrier revision differs")
    offset = start + fixed
    strings = []
    for index, field_offset in enumerate((64, 66, 8, 10, 12, 14)):
        length = _u16(data, start + field_offset)
        if offset + length > value_start:
            raise fail("string length exceeds metadata")
        value = _utf8(data[offset : offset + length])
        offset += length
        if (not value and index != 1) or "\0" in value:
            raise fail("empty or NUL owner string")
        strings.append(value)
    scope_kind, scope_id, generation, source_kind, source_id, field_generation = strings
    if not ((scope_kind == "object" and scope_id) or (scope_kind == "full" and not scope_id)):
        raise fail("scope binding")
    if source_kind != "artifact_inspection" or generation != digest or not _DIGEST.match(source_id) or not _FIELD_GENERATION.match(field_generation):
        raise fail("source/digest binding")
    mapping_end = offset + count * stride
    if mapping_end > value_start or value_start - mapping_end >= 8 or any(data[mapping_end:value_start]):
        raise fail("mapping length or padding")
    raw = np.frombuffer(data, dtype="<u8", count=count * stride // 8, offset=offset).reshape(count, stride // 8)
    if code == 7:
        local = np.frombuffer(data, dtype="u1", count=count * stride, offset=offset).reshape(count, stride)
        if np.any(local[:, 8] != np.arange(count) % 4) or np.any(local[:, 9:16]):
            raise fail("incomplete Tet4 trace order")
        elements = raw[:, 0].reshape(-1, 4)
        if np.any(elements != elements[:, :1]):
            raise fail("mixed Tet4 source element")
        identity = raw[:, 2].copy()
        if any(len(set(group)) != 4 for group in identity.reshape(-1, 4).tolist()):
            raise fail("duplicate Tet4 stable vertex")
        if len(np.unique(elements[:, 0])) != len(elements):
            raise fail("duplicate mapping identity")
    else:
        identity = raw[:, 0].copy()
        if code in {5, 6} and np.any(identity != np.arange(count, dtype=np.uint64)):
            raise fail("sample ordinal differs")
        if len(np.unique(identity)) != count:
            raise fail("duplicate mapping identity")
    values = _values(data, value_start, value_count, n_comp)
    if not np.all(np.isfinite(values)):
        raise fail("non-finite field values")
    header_id = bytes(data[28:44])
    zero = header_id.find(b"\0")
    if zero == 0 or (zero > 0 and any(header_id[zero:])):
        raise fail("quantity ID padding")
    return FieldVector(
        format_version=6,
        quantity_id=_utf8(header_id[: zero if zero >= 0 else 16]),
        n_comp=n_comp,
        grid=(count, 1, 1),
        values=values,
        indexing=indexing,
        domain_generation_id=generation,
        field_generation_id=field_generation,
        mesh_topology_revision=str(revision),
        mesh_topology_hash=digest,
        scope_kind=scope_kind,
        scope_id=scope_id or None,
        source_kind=source_kind,
        source_id=source_id,
        source_revision=str(source_revision),
        artifact_identity_ids=identity,
    )


def _values(data: memoryview, offset: int, count: int, n_comp: int) -> np.ndarray:
    values = np.frombuffer(data, dtype="<f8", count=count, offset=offset).astype(np.float64, copy=True)
    return values.reshape(-1, n_comp)


def _header_quantity(header_id: bytes) -> str:
    end = header_id.find(b"\0")
    return header_id[: end if end >= 0 else 16].decode("utf-8", errors="strict")


def _utf8(raw: memoryview | bytes) -> str:
    try:
        return bytes(raw).decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise FieldVectorDecodeError(f"FMVP metadata text is not valid UTF-8: {error}") from error


def _u16(data: memoryview, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def _u32(data: memoryview, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _u64(data: memoryview, offset: int) -> int:
    return struct.unpack_from("<Q", data, offset)[0]
