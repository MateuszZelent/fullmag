"""FMMQ v2 quality carrier.

The v1 carrier is intentionally kept as a legacy, tet-oriented payload.  This
module defines the bounded v2 carrier used by typed FEM topology.  The format
is deliberately small and boring: a fixed little-endian header, canonical JSON
identity/directory sections, little-endian ``f64`` arrays, ordinal arrays and a
whole-payload SHA-256 seal.  No JSON quality summary is trusted as a substitute
for the element-wise arrays.

The verifier is independent from the writer's publication helper and performs
all range, overflow, ordering, checksum, finite-value and identity checks
before exposing a channel to a consumer.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
from typing import Any, Mapping

import numpy as np

from ._gmsh_types import (
    FEM_CELL_ARITIES,
    _MIXED_CELL_LOCAL_EDGES,
    MeshData,
    _cell_jacobian_determinants,
    _mixed_cell_signed_and_absolute_volume,
)


FMMQ_MAGIC = b"FMMQ"
FMMQ_V2 = 2
FMMQ_ENDIAN_LITTLE = 1
FMMQ_HEADER_LEN = 128
FMMQ_DIGEST_LEN = 32
FMMQ_DTYPE_F64_LE = "f64le"
FMMQ_IDENTITY_SCHEMA = "fmmq_identity.v1"
FMMQ_DIRECTORY_SCHEMA = "fmmq_metric_directory.v1"
_KNOWN_METRIC_UNITS = {
    "cell.max_edge.v1": "m",
    "cell.volume.v1": "m^3",
    "cell.sicn.v1": "1",
    "cell.gamma.v1": "1",
    "adjacent_size_growth.v1": "1",
}


def _expected_metric_unit(metric_id: str) -> str | None:
    """Return the canonical unit for a supported FMMQ metric ID."""
    unit = _KNOWN_METRIC_UNITS.get(metric_id)
    if unit is not None:
        return unit
    for family in FEM_CELL_ARITIES:
        if metric_id == f"signed_jacobian.{family}.v1":
            return "m^3"
        if metric_id in {
            f"scaled_jacobian.{family}.v1",
            f"edge_aspect.{family}.v1",
            f"skewness.{family}.v1",
            f"edge_length_uniformity.{family}.v1",
        }:
            return "1"
    return None

# magic, version, endian, header_len, flags, element_count, family_count,
# metric_count, then five offset/length pairs and a 20-byte reserved area.
_HEADER = struct.Struct("<4sBBHIQIIQQQQQQQQQQ20s")
assert _HEADER.size == FMMQ_HEADER_LEN


class FmmqFormatError(ValueError):
    """Structured fail-closed FMMQ v2 parsing/identity error."""

    def __init__(self, code: str, message: str, *, pointer: str = "/") -> None:
        self.code = code
        self.pointer = pointer
        super().__init__(f"{code} at {pointer}: {message}")


@dataclass(frozen=True, slots=True)
class FmmqMetricChannel:
    """One decoded metric channel and its associated element ordinals."""

    metric_id: str
    unit: str
    values: np.ndarray
    ordinals: np.ndarray
    family: str | None = None


@dataclass(frozen=True, slots=True)
class FmmqV2Verification:
    """Successful structural and identity verification result."""

    identity: dict[str, Any]
    directory: dict[str, Any]
    element_count: int
    metric_ids: tuple[str, ...]
    digest: str


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    """Encode JSON deterministically in the same scalar form as serde_json.

    Python's JSON encoder pads exponents (``1e-07``) while serde_json/ryu
    emits ``1e-7`` (and retains an explicit ``+`` for positive exponents).
    Most identity fields are strings/integers, but sidecar metadata is allowed
    to carry finite floats.  Recursively emitting the shortest Python float
    representation with a normalized exponent keeps the cross-language byte
    contract stable without changing string contents.
    """

    def encode(node: Any) -> str:
        if node is None:
            return "null"
        if node is True:
            return "true"
        if node is False:
            return "false"
        if isinstance(node, str):
            return json.dumps(node, ensure_ascii=False, allow_nan=False)
        if isinstance(node, (int, np.integer)) and not isinstance(node, bool):
            return str(int(node))
        if isinstance(node, (float, np.floating)):
            number = float(node)
            if not np.isfinite(number):
                raise FmmqFormatError("identity_not_serializable", "JSON numbers must be finite")
            rendered = repr(number)
            if "e" in rendered or "E" in rendered:
                mantissa, exponent = rendered.lower().split("e", 1)
                sign = ""
                if exponent.startswith(("+", "-")):
                    sign, exponent = exponent[0], exponent[1:]
                exponent = exponent.lstrip("0") or "0"
                rendered = f"{mantissa}e{sign}{exponent}"
            return rendered
        if isinstance(node, Mapping):
            items = sorted(node.items(), key=lambda item: str(item[0]))
            if any(not isinstance(key, str) for key, _ in items):
                raise FmmqFormatError("identity_not_serializable", "JSON object keys must be strings")
            return "{" + ",".join(
                f"{encode(key)}:{encode(child)}" for key, child in items
            ) + "}"
        if isinstance(node, (list, tuple)):
            return "[" + ",".join(encode(child) for child in node) + "]"
        raise FmmqFormatError("identity_not_serializable", f"unsupported JSON value {type(node).__name__}")

    try:
        return encode(value).encode("utf-8")
    except FmmqFormatError:
        raise
    except (TypeError, ValueError, OverflowError) as exc:
        raise FmmqFormatError("identity_not_serializable", str(exc)) from exc


def _json_pairs_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise FmmqFormatError(
                "duplicate_json_key",
                f"duplicate object key {key!r}",
                pointer="/",
            )
        result[key] = value
    return result


def _sha256(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _fsync_directory(path: Path) -> None:
    """Persist the directory entry when the platform exposes that barrier."""
    try:
        descriptor = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        try:
            os.fsync(descriptor)
        except OSError:
            pass
    finally:
        os.close(descriptor)


def _ordinal_runs(ordinals: list[int] | np.ndarray) -> list[list[int]]:
    """Return sorted, compact inclusive ranges for a family's ordinals."""
    ordered = sorted({int(value) for value in ordinals})
    if not ordered:
        return []
    runs: list[list[int]] = [[ordered[0], ordered[0]]]
    for ordinal in ordered[1:]:
        if ordinal == runs[-1][1] + 1:
            runs[-1][1] = ordinal
        else:
            runs.append([ordinal, ordinal])
    return runs


def _range(payload_len: int, offset: int, length: int, *, pointer: str) -> tuple[int, int]:
    if offset < FMMQ_HEADER_LEN or length < 0:
        raise FmmqFormatError("range_error", "section starts before the header or has a negative length", pointer=pointer)
    end = offset + length
    if end < offset or end > payload_len:
        raise FmmqFormatError("truncated_payload", "section exceeds payload length", pointer=pointer)
    return int(offset), int(end)


def _parse_json_section(payload: bytes, start: int, end: int, *, pointer: str) -> dict[str, Any]:
    try:
        value = json.loads(
            payload[start:end].decode("utf-8"),
            object_pairs_hook=_json_pairs_without_duplicates,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FmmqFormatError("malformed_json", str(exc), pointer=pointer) from exc
    if not isinstance(value, dict):
        raise FmmqFormatError("malformed_json", "section must contain an object", pointer=pointer)
    # Canonical JSON is part of the identity: this rejects nondeterministic
    # key ordering and duplicate semantic encodings before a digest is used.
    if _canonical_json(value) != payload[start:end]:
        raise FmmqFormatError("noncanonical_json", "section is not canonical JSON", pointer=pointer)
    return value


def _normalise_metric(
    metric_id: str,
    values: Any,
    ordinals: Any,
    *,
    unit: str,
    family: str | None = None,
    ordinal_arity: int = 1,
) -> tuple[dict[str, Any], bytes, bytes]:
    if not isinstance(metric_id, str) or not metric_id.strip():
        raise FmmqFormatError("metric_id_error", "metric ID must be a non-empty string", pointer="/metrics")
    canonical_unit = _expected_metric_unit(metric_id)
    if canonical_unit is None:
        raise FmmqFormatError(
            "unknown_metric",
            f"unsupported metric ID {metric_id!r}",
            pointer=f"/metrics/{metric_id}/id",
        )
    if not isinstance(unit, str) or not unit.strip():
        raise FmmqFormatError("metric_unit_error", "metric unit must be a non-empty string", pointer=f"/metrics/{metric_id}/unit")
    if unit != canonical_unit:
        raise FmmqFormatError(
            "metric_unit_error",
            f"expected unit {canonical_unit!r}, got {unit!r}",
            pointer=f"/metrics/{metric_id}/unit",
        )
    if isinstance(ordinal_arity, bool) or not isinstance(ordinal_arity, (int, np.integer)) or int(ordinal_arity) < 1:
        raise FmmqFormatError("ordinal_arity_error", "ordinal arity must be positive", pointer=f"/metrics/{metric_id}/ordinal_arity")
    arity = int(ordinal_arity)
    try:
        raw_values = np.asarray(values)
        if raw_values.dtype.kind not in "iuf":
            raise TypeError(f"unsupported metric dtype {raw_values.dtype}")
        array = np.asarray(values, dtype="<f8").reshape(-1)
    except (TypeError, ValueError) as exc:
        raise FmmqFormatError("metric_value_error", str(exc), pointer=f"/metrics/{metric_id}/values") from exc
    if array.size == 0 or not np.all(np.isfinite(array)):
        raise FmmqFormatError("nonfinite_metric", "metric values must be non-empty and finite", pointer=f"/metrics/{metric_id}/values")
    try:
        raw_ordinals = np.asarray(ordinals)
        if raw_ordinals.dtype.kind not in "iu":
            raise TypeError(f"ordinal dtype must be integral, got {raw_ordinals.dtype}")
        if raw_ordinals.dtype.kind == "i" and np.any(raw_ordinals < 0):
            raise ValueError("ordinal values must be non-negative")
        raw_ordinals = np.asarray(raw_ordinals, dtype="<u8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise FmmqFormatError("ordinal_value_error", str(exc), pointer=f"/metrics/{metric_id}/ordinals") from exc
    if raw_ordinals.ndim == 1:
        ordinal_array = raw_ordinals
    else:
        ordinal_array = raw_ordinals.reshape(-1)
    if ordinal_array.size != array.size * arity:
        raise FmmqFormatError(
            "ordinal_count_error",
            f"expected {array.size * arity} ordinal values, got {ordinal_array.size}",
            pointer=f"/metrics/{metric_id}/ordinals",
        )
    if ordinal_array.size:
        shaped = ordinal_array.reshape(-1, arity)
        if any(
            tuple(int(value) for value in right)
            <= tuple(int(value) for value in left)
            for left, right in zip(shaped[:-1], shaped[1:])
        ):
            raise FmmqFormatError(
                "ordinal_order_error",
                "ordinals must be strictly lexicographically ordered",
                pointer=f"/metrics/{metric_id}/ordinals",
            )
    value_bytes = array.astype("<f8", copy=False).tobytes(order="C")
    ordinal_bytes = ordinal_array.astype("<u8", copy=False).tobytes(order="C")
    descriptor: dict[str, Any] = {
        "id": metric_id,
        "unit": unit,
        "dtype": FMMQ_DTYPE_F64_LE,
        "count": int(array.size),
        "ordinal_arity": arity,
        "ordinal_count": int(ordinal_array.size),
        "family": family,
        "checksum": _sha256(value_bytes),
    }
    return descriptor, value_bytes, ordinal_bytes


def write_fmmq_v2(
    path: str | Path,
    *,
    element_count: int,
    identity: Mapping[str, Any],
    metrics: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Write one FMMQ v2 payload atomically and return its manifest entry.

    ``metrics`` maps a metric ID to ``values``, ``ordinals`` and ``unit``;
    optional ``family`` and ``ordinal_arity`` identify family/pair channels.
    """
    if isinstance(element_count, bool) or not isinstance(element_count, (int, np.integer)) or int(element_count) < 1:
        raise FmmqFormatError("element_count_error", "element_count must be positive", pointer="/element_count")
    n_elements = int(element_count)
    identity_payload = dict(identity)
    identity_payload.setdefault("schema_version", FMMQ_IDENTITY_SCHEMA)
    identity_payload.setdefault("format", "fmmq.v2")
    if identity_payload["schema_version"] != FMMQ_IDENTITY_SCHEMA:
        raise FmmqFormatError(
            "identity_schema_error",
            "identity schema_version must be fmmq_identity.v1",
            pointer="/identity/schema_version",
        )
    if identity_payload["format"] != "fmmq.v2":
        raise FmmqFormatError(
            "identity_schema_error",
            "identity format must be fmmq.v2",
            pointer="/identity/format",
        )
    for field in ("topology_fingerprint", "policy_fingerprint", "mesh_revision"):
        value = identity_payload.get(field)
        if not isinstance(value, str) or not value.strip():
            raise FmmqFormatError(
                "identity_incomplete",
                f"identity field {field} must be a non-empty string",
                pointer=f"/identity/{field}",
            )
    family_rows = identity_payload.get("families")
    if not isinstance(family_rows, list) or not family_rows:
        raise FmmqFormatError(
            "family_table_error",
            "identity families must be a non-empty list",
            pointer="/identity/families",
        )
    identity_bytes = _canonical_json(identity_payload)

    if not isinstance(metrics, Mapping) or not metrics:
        raise FmmqFormatError("metric_directory_empty", "at least one metric channel is required", pointer="/metrics")
    directory_entries: list[dict[str, Any]] = []
    value_sections: list[bytes] = []
    ordinal_sections: list[bytes] = []
    for metric_id in sorted(metrics):
        spec = metrics[metric_id]
        if not isinstance(spec, Mapping):
            raise FmmqFormatError("metric_spec_error", "metric specification must be an object", pointer=f"/metrics/{metric_id}")
        family = spec.get("family")
        if family is not None and (not isinstance(family, str) or not family.strip()):
            raise FmmqFormatError("metric_family_error", "family must be a non-empty string or null", pointer=f"/metrics/{metric_id}/family")
        descriptor, value_bytes, ordinal_bytes = _normalise_metric(
            metric_id,
            spec.get("values"),
            spec.get("ordinals"),
            unit=spec.get("unit", ""),
            family=(family.strip() if isinstance(family, str) else None),
            ordinal_arity=spec.get("ordinal_arity", 1),
        )
        descriptor["ordinal_offset"] = sum(len(part) for part in ordinal_sections)
        descriptor["data_offset"] = sum(len(part) for part in value_sections)
        directory_entries.append(descriptor)
        value_sections.append(value_bytes)
        ordinal_sections.append(ordinal_bytes)

    ordinal_blob = b"".join(ordinal_sections)
    value_blob = b"".join(value_sections)
    # Directory offsets are absolute payload offsets. Their decimal width is
    # part of the canonical JSON length, so solve the tiny fixed-point problem
    # explicitly instead of mutating/rebasing descriptors in-place.
    family_count = len(family_rows)
    directory_offset = FMMQ_HEADER_LEN + len(identity_bytes)
    directory_length = 0
    directory_bytes = b""
    for _ in range(16):
        ordinal_offset = directory_offset + directory_length
        data_offset = ordinal_offset + len(ordinal_blob)
        ordinal_cursor = data_cursor = 0
        resolved_entries: list[dict[str, Any]] = []
        for descriptor in directory_entries:
            resolved = dict(descriptor)
            resolved["ordinal_offset"] = ordinal_offset + ordinal_cursor
            resolved["data_offset"] = data_offset + data_cursor
            resolved_entries.append(resolved)
            ordinal_cursor += int(descriptor["ordinal_count"]) * 8
            data_cursor += int(descriptor["count"]) * 8
        candidate = _canonical_json(
            {"schema_version": FMMQ_DIRECTORY_SCHEMA, "metrics": resolved_entries}
        )
        if len(candidate) == directory_length:
            directory_entries = resolved_entries
            directory_bytes = candidate
            break
        directory_length = len(candidate)
    else:
        raise FmmqFormatError(
            "directory_layout_error",
            "metric directory offsets did not converge",
            pointer="/directory",
        )
    # Recompute once from the converged length and require byte-for-byte
    # stability. This catches descriptor changes that invalidate the layout.
    ordinal_offset = directory_offset + len(directory_bytes)
    data_offset = ordinal_offset + len(ordinal_blob)
    ordinal_cursor = data_cursor = 0
    final_entries: list[dict[str, Any]] = []
    for descriptor in directory_entries:
        resolved = dict(descriptor)
        resolved["ordinal_offset"] = ordinal_offset + ordinal_cursor
        resolved["data_offset"] = data_offset + data_cursor
        final_entries.append(resolved)
        ordinal_cursor += int(descriptor["ordinal_count"]) * 8
        data_cursor += int(descriptor["count"]) * 8
    final_directory = _canonical_json(
        {"schema_version": FMMQ_DIRECTORY_SCHEMA, "metrics": final_entries}
    )
    if final_directory != directory_bytes:
        raise FmmqFormatError(
            "directory_layout_error",
            "metric directory offsets are not stable",
            pointer="/directory",
        )
    directory_entries = final_entries
    directory_bytes = final_directory

    digest_offset = data_offset + len(value_blob)
    header = _HEADER.pack(
        FMMQ_MAGIC,
        FMMQ_V2,
        FMMQ_ENDIAN_LITTLE,
        FMMQ_HEADER_LEN,
        0,
        n_elements,
        family_count,
        len(directory_entries),
        FMMQ_HEADER_LEN,
        len(identity_bytes),
        directory_offset,
        len(directory_bytes),
        ordinal_offset,
        len(ordinal_blob),
        data_offset,
        len(value_blob),
        digest_offset,
        FMMQ_DIGEST_LEN,
        b"\0" * 20,
    )
    unsigned = header + identity_bytes + directory_bytes + ordinal_blob + value_blob
    digest = hashlib.sha256(unsigned).digest()
    payload = unsigned + digest

    # Verify the complete byte payload before it becomes visible.  This keeps
    # the atomic publication boundary honest: a writer bug, malformed family
    # table or unsupported channel can never leave a syntactically complete
    # but semantically unreadable generation at the destination path.
    verify_fmmq_v2(payload)

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    private_dir = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=target.parent))
    temporary = private_dir / "payload.fmmq"
    try:
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if temporary.stat().st_size != len(payload):
            raise FmmqFormatError("publication_size_error", "temporary payload size changed before publication")
        os.replace(temporary, target)
        _fsync_directory(target.parent)
    finally:
        temporary.unlink(missing_ok=True)
        private_dir.rmdir()
    return {
        "kind": "fmmq.v2",
        "schema_version": 2,
        "path": str(target),
        "byte_size": len(payload),
        "element_count": n_elements,
        "metrics": [entry["id"] for entry in directory_entries],
        "topology_fingerprint": identity_payload.get("topology_fingerprint"),
        "policy_fingerprint": identity_payload.get("policy_fingerprint"),
        "mesh_revision": identity_payload.get("mesh_revision"),
        "digest": _sha256(payload[:-FMMQ_DIGEST_LEN]),
        "identity_status": identity_payload.get("identity_status", "unbound"),
    }


def verify_fmmq_v2(
    payload: bytes,
    *,
    expected_identity: Mapping[str, Any] | None = None,
    required_metrics: set[str] | None = None,
) -> FmmqV2Verification:
    """Verify a complete FMMQ v2 payload before exposing any metric."""
    if len(payload) < FMMQ_HEADER_LEN + FMMQ_DIGEST_LEN:
        raise FmmqFormatError("truncated_header", "payload is shorter than the fixed header", pointer="/header")
    try:
        (
            magic,
            version,
            endian,
            header_len,
            _flags,
            element_count,
            family_count,
            metric_count,
            identity_offset,
            identity_len,
            directory_offset,
            directory_len,
            ordinal_offset,
            ordinal_len,
            data_offset,
            data_len,
            digest_offset,
            digest_len,
            _reserved,
        ) = _HEADER.unpack_from(payload)
    except struct.error as exc:
        raise FmmqFormatError("truncated_header", str(exc), pointer="/header") from exc
    if magic != FMMQ_MAGIC:
        raise FmmqFormatError("magic_error", "payload is not FMMQ", pointer="/header/magic")
    if version != FMMQ_V2:
        raise FmmqFormatError("version_error", f"unsupported FMMQ version {version}", pointer="/header/version")
    if endian != FMMQ_ENDIAN_LITTLE or header_len != FMMQ_HEADER_LEN:
        raise FmmqFormatError("header_error", "unsupported endian or header length", pointer="/header")
    if element_count < 1 or family_count < 1 or metric_count < 1:
        raise FmmqFormatError("count_error", "element, family and metric counts must be positive", pointer="/header")
    sections = [
        ("/identity", int(identity_offset), int(identity_len)),
        ("/directory", int(directory_offset), int(directory_len)),
        ("/ordinals", int(ordinal_offset), int(ordinal_len)),
        ("/data", int(data_offset), int(data_len)),
        ("/digest", int(digest_offset), int(digest_len)),
    ]
    ranges = [(name, *_range(len(payload), offset, length, pointer=name)) for name, offset, length in sections]
    if digest_len != FMMQ_DIGEST_LEN or digest_offset + digest_len != len(payload):
        raise FmmqFormatError("digest_range_error", "digest must be the final 32 bytes", pointer="/digest")
    ordered_sections = sorted(ranges, key=lambda item: (item[1], item[2], item[0]))
    for previous, current in zip(ordered_sections, ordered_sections[1:]):
        if previous[2] > current[1]:
            raise FmmqFormatError("section_overlap", f"{previous[0]} overlaps {current[0]}", pointer="/header")
    identity_start, identity_end = ranges[0][1], ranges[0][2]
    directory_start, directory_end = ranges[1][1], ranges[1][2]
    identity = _parse_json_section(payload, identity_start, identity_end, pointer="/identity")
    directory = _parse_json_section(payload, directory_start, directory_end, pointer="/directory")
    if identity.get("schema_version") != FMMQ_IDENTITY_SCHEMA or identity.get("format") != "fmmq.v2":
        raise FmmqFormatError("identity_schema_error", "unsupported FMMQ v2 identity schema", pointer="/identity/schema_version")
    topology_fingerprint = identity.get("topology_fingerprint")
    policy_fingerprint = identity.get("policy_fingerprint")
    mesh_revision = identity.get("mesh_revision")
    if not isinstance(topology_fingerprint, str) or not topology_fingerprint.strip():
        raise FmmqFormatError("identity_incomplete", "topology fingerprint is required", pointer="/identity/topology_fingerprint")
    if not isinstance(policy_fingerprint, str) or not policy_fingerprint.strip():
        raise FmmqFormatError("identity_incomplete", "policy fingerprint is required", pointer="/identity/policy_fingerprint")
    if not isinstance(mesh_revision, str) or not mesh_revision.strip():
        raise FmmqFormatError("identity_incomplete", "mesh revision is required", pointer="/identity/mesh_revision")
    family_rows = identity.get("families")
    if not isinstance(family_rows, list) or len(family_rows) != int(family_count):
        raise FmmqFormatError("family_count_error", "identity family table does not match fixed header", pointer="/identity/families")
    family_by_name: dict[str, dict[str, Any]] = {}
    # Keep every contiguous run rather than assuming all cells of a family
    # are adjacent in the mesh ordering.  Gmsh commonly emits family blocks,
    # but a valid typed MeshData may interleave prism/tet cells.
    family_ranges: list[tuple[int, int, str]] = []
    family_total = 0
    for index, family_row in enumerate(family_rows):
        family_pointer = f"/identity/families/{index}"
        if not isinstance(family_row, dict):
            raise FmmqFormatError("family_entry_error", "family table entries must be objects", pointer=family_pointer)
        family = family_row.get("family")
        node_arity = family_row.get("node_arity")
        family_elements = family_row.get("element_count")
        ordinal_min = family_row.get("ordinal_min")
        ordinal_max = family_row.get("ordinal_max")
        if not isinstance(family, str) or not family or family in family_by_name:
            raise FmmqFormatError("family_id_error", "family IDs must be unique non-empty strings", pointer=f"{family_pointer}/family")
        if family not in FEM_CELL_ARITIES:
            raise FmmqFormatError("family_id_error", f"unsupported family {family!r}", pointer=f"{family_pointer}/family")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (node_arity, family_elements, ordinal_min, ordinal_max)):
            raise FmmqFormatError("family_integer_error", "family counts and ordinal bounds must be integers", pointer=family_pointer)
        if node_arity != FEM_CELL_ARITIES[family] or family_elements < 1 or ordinal_min < 0 or ordinal_max < ordinal_min or ordinal_max >= element_count:
            raise FmmqFormatError("family_range_error", "invalid family arity/count/ordinal range", pointer=family_pointer)
        raw_runs = family_row.get("ordinal_ranges")
        if raw_runs is None:
            raw_runs = [[ordinal_min, ordinal_max]]
        if not isinstance(raw_runs, list) or not raw_runs:
            raise FmmqFormatError("family_range_error", "family ordinal_ranges must be a non-empty list", pointer=f"{family_pointer}/ordinal_ranges")
        parsed_runs: list[tuple[int, int]] = []
        for run_index, raw_run in enumerate(raw_runs):
            if (
                not isinstance(raw_run, (list, tuple))
                or len(raw_run) != 2
                or any(isinstance(value, bool) or not isinstance(value, int) for value in raw_run)
            ):
                raise FmmqFormatError("family_range_error", "each ordinal range must contain two integers", pointer=f"{family_pointer}/ordinal_ranges/{run_index}")
            run_start, run_end = int(raw_run[0]), int(raw_run[1])
            if run_start < 0 or run_end < run_start or run_end >= element_count:
                raise FmmqFormatError("family_range_error", "ordinal range is outside the element domain", pointer=f"{family_pointer}/ordinal_ranges/{run_index}")
            parsed_runs.append((run_start, run_end))
        parsed_runs.sort()
        if parsed_runs[0][0] != ordinal_min or parsed_runs[-1][1] != ordinal_max:
            raise FmmqFormatError("family_range_error", "ordinal_min/max do not bound ordinal_ranges", pointer=family_pointer)
        covered = 0
        previous_end = -1
        for run_start, run_end in parsed_runs:
            if run_start <= previous_end:
                raise FmmqFormatError("family_range_error", "family ordinal_ranges overlap or repeat", pointer=f"{family_pointer}/ordinal_ranges")
            covered += run_end - run_start + 1
            previous_end = run_end
            family_ranges.append((run_start, run_end, family))
        if covered != family_elements:
            raise FmmqFormatError("family_count_error", "family ordinal_ranges do not match element_count", pointer=family_pointer)
        family_by_name[family] = family_row
        family_total += family_elements
    if family_total != element_count:
        raise FmmqFormatError("family_count_error", "family element counts do not reconcile with element_count", pointer="/identity/families")
    family_ranges.sort()
    expected_family_start = 0
    for ordinal_min, ordinal_max, family in family_ranges:
        if ordinal_min != expected_family_start:
            raise FmmqFormatError(
                "family_range_error",
                f"family {family!r} leaves a gap or overlaps another family",
                pointer="/identity/families",
            )
        expected_family_start = ordinal_max + 1
    if expected_family_start != element_count:
        raise FmmqFormatError(
            "family_range_error",
            "family ordinal ranges do not cover the complete element domain",
            pointer="/identity/families",
        )
    if expected_identity:
        for key, expected in expected_identity.items():
            actual = identity.get(key)
            if actual != expected:
                raise FmmqFormatError("identity_mismatch", f"expected {expected!r}, got {actual!r}", pointer=f"/identity/{key}")
    if directory.get("schema_version") != FMMQ_DIRECTORY_SCHEMA:
        raise FmmqFormatError("directory_schema_error", "unsupported metric directory schema", pointer="/directory/schema_version")
    entries = directory.get("metrics")
    if not isinstance(entries, list) or len(entries) != int(metric_count):
        raise FmmqFormatError("metric_count_error", "metric directory count does not match fixed header", pointer="/directory/metrics")
    metric_ids: list[str] = []
    data_ranges: list[tuple[int, int, str]] = []
    ordinal_ranges: list[tuple[int, int, str]] = []
    data_start, data_end = ranges[3][1], ranges[3][2]
    ord_start, ord_end = ranges[2][1], ranges[2][2]
    for index, entry in enumerate(entries):
        pointer = f"/directory/metrics/{index}"
        if not isinstance(entry, dict):
            raise FmmqFormatError("metric_entry_error", "metric entry must be an object", pointer=pointer)
        metric_id = entry.get("id")
        if not isinstance(metric_id, str) or not metric_id or metric_id in metric_ids:
            raise FmmqFormatError("metric_id_error", "metric IDs must be unique non-empty strings", pointer=f"{pointer}/id")
        metric_ids.append(metric_id)
        count = entry.get("count")
        ordinal_count = entry.get("ordinal_count")
        arity = entry.get("ordinal_arity")
        data_at = entry.get("data_offset")
        ordinal_at = entry.get("ordinal_offset")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (count, ordinal_count, arity, data_at, ordinal_at)):
            raise FmmqFormatError("metric_integer_error", "metric counts and offsets must be integers", pointer=pointer)
        if count < 1 or arity < 1 or ordinal_count != count * arity:
            raise FmmqFormatError("metric_count_error", "invalid metric count/ordinal arity", pointer=pointer)
        unit = entry.get("unit")
        if not isinstance(unit, str) or not unit.strip():
            raise FmmqFormatError("metric_unit_error", "metric unit must be a non-empty string", pointer=f"{pointer}/unit")
        expected_unit = _expected_metric_unit(metric_id)
        if expected_unit is None:
            raise FmmqFormatError(
                "unknown_metric",
                f"unsupported metric ID {metric_id!r}",
                pointer=f"{pointer}/id",
            )
        if unit != expected_unit:
            raise FmmqFormatError(
                "metric_unit_error",
                f"expected unit {expected_unit!r}, got {unit!r}",
                pointer=f"{pointer}/unit",
            )
        if entry.get("dtype") != FMMQ_DTYPE_F64_LE:
            raise FmmqFormatError(
                "metric_dtype_error",
                "metric dtype must be f64le",
                pointer=f"{pointer}/dtype",
            )
        family_name = entry.get("family")
        is_family_metric = metric_id.startswith(
            ("signed_jacobian.", "scaled_jacobian.", "edge_aspect.", "skewness.", "edge_length_uniformity.")
        )
        if is_family_metric and family_name is None:
            raise FmmqFormatError(
                "metric_family_error",
                "family metric must declare its family",
                pointer=f"{pointer}/family",
            )
        if family_name is not None:
            if not isinstance(family_name, str) or family_name not in family_by_name:
                raise FmmqFormatError("metric_family_error", "metric family is not present in identity family table", pointer=f"{pointer}/family")
            family_row = family_by_name[family_name]
            if is_family_metric:
                if count != int(family_row["element_count"]) or arity != 1:
                    raise FmmqFormatError("family_count_error", "family metric is not a complete per-family vector", pointer=pointer)
        d_start, d_end = _range(len(payload), int(data_at), count * 8, pointer=f"{pointer}/data_offset")
        o_start, o_end = _range(len(payload), int(ordinal_at), ordinal_count * 8, pointer=f"{pointer}/ordinal_offset")
        if not (data_start <= d_start and d_end <= data_end and ord_start <= o_start and o_end <= ord_end):
            raise FmmqFormatError("section_range_error", "metric channel lies outside its section", pointer=pointer)
        data_ranges.append((d_start, d_end, metric_id))
        ordinal_ranges.append((o_start, o_end, metric_id))
        values = np.frombuffer(payload, dtype="<f8", count=count, offset=d_start)
        if not np.all(np.isfinite(values)):
            raise FmmqFormatError("nonfinite_metric", "metric contains non-finite values", pointer=f"{pointer}/values")
        if _sha256(values.tobytes(order="C")) != entry.get("checksum"):
            raise FmmqFormatError("metric_checksum_error", "metric checksum mismatch", pointer=f"{pointer}/checksum")
        ordinals = np.frombuffer(payload, dtype="<u8", count=ordinal_count, offset=o_start)
        if np.any(ordinals >= element_count):
            raise FmmqFormatError("ordinal_range_error", "metric ordinal exceeds element_count", pointer=f"{pointer}/ordinals")
        shaped = ordinals.reshape(-1, arity)
        if any(
            tuple(int(value) for value in right)
            <= tuple(int(value) for value in left)
            for left, right in zip(shaped[:-1], shaped[1:])
        ):
            raise FmmqFormatError("ordinal_order_error", "metric ordinals are not strictly lexicographically ordered", pointer=f"{pointer}/ordinals")
        if family_name is not None and is_family_metric:
            family_row = family_by_name[family_name]
            raw_runs = family_row.get("ordinal_ranges") or [
                [family_row["ordinal_min"], family_row["ordinal_max"]]
            ]
            expected_ordinals = np.concatenate(
                [
                    np.arange(int(run[0]), int(run[1]) + 1, dtype="<u8")
                    for run in raw_runs
                ]
            )
            if arity != 1 or not np.array_equal(ordinals, expected_ordinals):
                raise FmmqFormatError(
                    "family_range_error",
                    "family metric ordinals must cover its complete range",
                    pointer=f"{pointer}/ordinals",
                )
        elif metric_id.startswith("cell.") and arity == 1 and count == element_count:
            expected_ordinals = np.arange(element_count, dtype="<u8")
            if not np.array_equal(ordinals, expected_ordinals):
                raise FmmqFormatError(
                    "ordinal_coverage_error",
                    "complete cell metric must cover every element ordinal exactly once",
                    pointer=f"{pointer}/ordinals",
                )
    for ranges_for_kind, pointer in ((data_ranges, "/directory/metrics/data_offset"), (ordinal_ranges, "/directory/metrics/ordinal_offset")):
        ordered = sorted(ranges_for_kind)
        for previous, current in zip(ordered, ordered[1:]):
            if previous[1] > current[0]:
                raise FmmqFormatError(
                    "channel_overlap",
                    f"metric {previous[2]!r} overlaps {current[2]!r}",
                    pointer=pointer,
                )
    if required_metrics and not required_metrics.issubset(metric_ids):
        missing = sorted(required_metrics.difference(metric_ids))
        raise FmmqFormatError("required_metric_missing", f"missing required metrics: {missing}", pointer="/directory/metrics")
    unsigned = payload[: int(digest_offset)]
    actual_digest = hashlib.sha256(unsigned).digest()
    if payload[int(digest_offset) :] != actual_digest:
        raise FmmqFormatError("payload_digest_error", "whole-payload digest mismatch", pointer="/digest")
    return FmmqV2Verification(
        identity=identity,
        directory=directory,
        element_count=int(element_count),
        metric_ids=tuple(metric_ids),
        digest=_sha256(unsigned),
    )


def read_fmmq_v2_metric(
    payload: bytes,
    metric_id: str,
    *,
    expected_identity: Mapping[str, Any] | None = None,
) -> FmmqMetricChannel:
    """Verify a payload and decode one metric channel."""
    verification = verify_fmmq_v2(payload, expected_identity=expected_identity)
    entries = verification.directory["metrics"]
    entry = next((item for item in entries if item.get("id") == metric_id), None)
    if entry is None:
        raise FmmqFormatError("metric_missing", f"metric {metric_id!r} is not present", pointer="/directory/metrics")
    count = int(entry["count"])
    arity = int(entry["ordinal_arity"])
    values = np.frombuffer(payload, dtype="<f8", count=count, offset=int(entry["data_offset"])).copy()
    ordinals = np.frombuffer(payload, dtype="<u8", count=count * arity, offset=int(entry["ordinal_offset"])).copy()
    if arity > 1:
        ordinals = ordinals.reshape(count, arity)
    return FmmqMetricChannel(
        metric_id=metric_id,
        unit=str(entry["unit"]),
        values=values,
        ordinals=ordinals,
        family=(str(entry["family"]) if entry.get("family") is not None else None),
    )


def _cell_metrics(mesh: MeshData) -> tuple[dict[str, np.ndarray], dict[str, list[int]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute deterministic reference metrics for the typed Python producer."""
    max_edges: list[float] = []
    volumes: list[float] = []
    families: dict[str, list[int]] = {family: [] for family in FEM_CELL_ARITIES}
    signed: dict[str, list[float]] = {family: [] for family in FEM_CELL_ARITIES}
    scaled: dict[str, list[float]] = {family: [] for family in FEM_CELL_ARITIES}
    aspect: dict[str, list[float]] = {family: [] for family in FEM_CELL_ARITIES}
    skew: dict[str, list[float]] = {family: [] for family in FEM_CELL_ARITIES}
    for ordinal, raw_family in enumerate(mesh.cell_types.tolist()):
        family = str(raw_family)
        coordinates = mesh.nodes[mesh.cell_node_ids(ordinal)]
        families.setdefault(family, []).append(ordinal)
        _signed_volume, volume = _mixed_cell_signed_and_absolute_volume(family, coordinates)
        volumes.append(float(volume))
        edge_pairs = _MIXED_CELL_LOCAL_EDGES.get(family)
        if edge_pairs is None:
            raise FmmqFormatError(
                "family_id_error",
                f"unsupported family {family!r}",
                pointer=f"/identity/families/{family}",
            )
        edges = np.asarray(
            [np.linalg.norm(coordinates[left] - coordinates[right]) for left, right in edge_pairs],
            dtype=np.float64,
        )
        max_edge = float(np.max(edges)) if edges.size else float("nan")
        min_edge = float(np.min(edges)) if edges.size else float("nan")
        max_edges.append(max_edge)
        determinants = np.asarray(_cell_jacobian_determinants(family, coordinates), dtype=np.float64)
        signed.setdefault(family, []).append(float(np.min(determinants)))
        scaled.setdefault(family, []).append(
            float(np.min(np.abs(determinants)) / max_edge**3)
            if np.isfinite(max_edge) and max_edge > 0 and determinants.size
            else float("nan")
        )
        aspect.setdefault(family, []).append(
            float(max_edge / min_edge) if np.isfinite(max_edge) and np.isfinite(min_edge) and min_edge > 0 else float("nan")
        )
        coefficient = float(np.std(edges) / np.mean(edges)) if edges.size and np.mean(edges) > 0 else float("nan")
        skew.setdefault(family, []).append(float(1.0 / (1.0 + coefficient)) if np.isfinite(coefficient) else float("nan"))
    family_rows = []
    for family in FEM_CELL_ARITIES:
        ordinals = families.get(family, [])
        if ordinals:
            ordinal_ranges = _ordinal_runs(ordinals)
            family_rows.append({
                "family": family,
                "node_arity": FEM_CELL_ARITIES[family],
                "element_count": len(ordinals),
                "ordinal_min": min(ordinals),
                "ordinal_max": max(ordinals),
                "ordinal_ranges": ordinal_ranges,
            })
    role_values = mesh.cell_mesh_parts.tolist()
    scopes: dict[tuple[int, str], list[int]] = {}
    for ordinal, marker in enumerate(mesh.element_markers.tolist()):
        role = str(role_values[ordinal]) if len(role_values) == mesh.n_elements and str(role_values[ordinal]).strip() else ("air" if int(marker) == 0 else "magnetic")
        scopes.setdefault((int(marker), role), []).append(ordinal)
    scope_rows = [
        {"scope_id": f"marker:{marker}|role:{role}", "marker": marker, "mesh_role": role, "element_count": len(ordinals), "ordinal_min": min(ordinals), "ordinal_max": max(ordinals)}
        for (marker, role), ordinals in sorted(scopes.items())
    ]
    return (
        {
            "cell.max_edge.v1": np.asarray(max_edges, dtype="<f8"),
            "cell.volume.v1": np.asarray(volumes, dtype="<f8"),
            "_signed": signed,
            "_scaled": scaled,
            "_aspect": aspect,
            "_skew": skew,
        },
        families,
        family_rows,
        scope_rows,
    )


def build_fmmq_v2_spec(
    mesh: MeshData,
    *,
    identity: Mapping[str, Any],
    adjacent_growth_report: Any | None = None,
) -> tuple[int, dict[str, Any], dict[str, Mapping[str, Any]]]:
    """Build a writer-ready identity and metric map from a typed mesh."""
    if not isinstance(mesh, MeshData):
        raise TypeError("build_fmmq_v2_spec expects MeshData")
    raw, families, family_rows, scope_rows = _cell_metrics(mesh)
    bound_identity = dict(identity)
    bound_identity.setdefault("topology_fingerprint", mesh.topology_fingerprint_v3())
    bound_identity.setdefault("policy_fingerprint", "unbound")
    bound_identity.setdefault("mesh_revision", "unbound")
    bound_identity.setdefault("identity_status", "unbound")
    bound_identity.update(
        {
            "schema_version": FMMQ_IDENTITY_SCHEMA,
            "format": "fmmq.v2",
            "topology_fingerprint_version": "v3",
            "families": family_rows,
            "scopes": scope_rows,
            "sidecar_identity": dict(bound_identity.get("sidecar_identity", {})),
        }
    )
    metrics: dict[str, Mapping[str, Any]] = {
        "cell.max_edge.v1": {"values": raw["cell.max_edge.v1"], "ordinals": np.arange(mesh.n_elements, dtype="<u8"), "unit": "m"},
        "cell.volume.v1": {"values": raw["cell.volume.v1"], "ordinals": np.arange(mesh.n_elements, dtype="<u8"), "unit": "m^3"},
    }
    # Preserve the Gmsh channels when they are available.  For typed mixed
    # meshes these are optional; the family-native channels below remain the
    # authoritative quality values and are never mislabeled as SICN/gamma.
    quality = getattr(mesh, "quality", None)
    if quality is not None:
        for metric_id, values, unit in (
            ("cell.sicn.v1", getattr(quality, "element_sicn", None), "1"),
            ("cell.gamma.v1", getattr(quality, "element_gamma", None), "1"),
        ):
            if values is not None:
                candidate = np.asarray(values, dtype="<f8").reshape(-1)
                if candidate.size == mesh.n_elements and np.all(np.isfinite(candidate)):
                    metrics[metric_id] = {
                        "values": candidate,
                        "ordinals": np.arange(mesh.n_elements, dtype="<u8"),
                        "unit": unit,
                    }
    for family in FEM_CELL_ARITIES:
        ordinals = np.asarray(families.get(family, []), dtype="<u8")
        if not len(ordinals):
            continue
        metrics[f"signed_jacobian.{family}.v1"] = {"values": np.asarray(raw["_signed"][family], dtype="<f8"), "ordinals": ordinals, "unit": "m^3", "family": family}
        metrics[f"scaled_jacobian.{family}.v1"] = {"values": np.asarray(raw["_scaled"][family], dtype="<f8"), "ordinals": ordinals, "unit": "1", "family": family}
        metrics[f"edge_aspect.{family}.v1"] = {"values": np.asarray(raw["_aspect"][family], dtype="<f8"), "ordinals": ordinals, "unit": "1", "family": family}
        metrics[f"skewness.{family}.v1"] = {"values": np.asarray(raw["_skew"][family], dtype="<f8"), "ordinals": ordinals, "unit": "1", "family": family}
        metrics[f"edge_length_uniformity.{family}.v1"] = {"values": np.asarray(raw["_skew"][family], dtype="<f8"), "ordinals": ordinals, "unit": "1", "family": family}
    if adjacent_growth_report is not None and getattr(adjacent_growth_report, "evaluated_pair_count", 0):
        pair_ordinals = tuple(getattr(adjacent_growth_report, "pair_ordinals", ()))
        pair_ratios = tuple(getattr(adjacent_growth_report, "pair_ratios", ()))
        # FMMQ must carry every evaluated pair.  ``worst_pairs`` is bounded
        # diagnostics only and must never be mistaken for the full channel.
        if (
            len(pair_ordinals) == int(getattr(adjacent_growth_report, "evaluated_pair_count", 0))
            and len(pair_ratios) == len(pair_ordinals)
        ):
            ordered_pairs = sorted(
                zip(pair_ordinals, pair_ratios), key=lambda item: tuple(int(v) for v in item[0])
            )
            metrics["adjacent_size_growth.v1"] = {
                "values": np.asarray([ratio for _, ratio in ordered_pairs], dtype="<f8"),
                "ordinals": np.asarray([ordinals for ordinals, _ in ordered_pairs], dtype="<u8"),
                "ordinal_arity": 2,
                "unit": "1",
            }
    bound_identity.setdefault("sampling", {"full_element_metrics": True, "bounded_worst_pairs": 20})
    return mesh.n_elements, bound_identity, metrics
