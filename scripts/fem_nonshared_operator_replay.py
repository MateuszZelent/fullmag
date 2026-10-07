"""Replay the published non-shared Floquet operator sidecars.

The Rust producer writes exact UTF-8 JSON bytes for the source state, operator
input and matrix pencil.  This adapter checks those bytes, their references and
the relationships that can be checked without reconstructing the native FEM
assembly.  It deliberately does not claim native execution, a native pencil
digest, residual convergence, or scientific agreement with COMSOL/TetraX.

The module never reserializes a Python object to reproduce a Rust digest.  The
raw SHA-256 values are calculated from the bytes read from the bundle.  The
frozen literal regression in ``test_fem_nonshared_operator_replay.py`` protects
the byte/hash convention independently of the fixture builder.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
from typing import Any, Mapping


_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

try:
    from fem_equilibrium_identity_replay import replay_preimage_json
except ModuleNotFoundError:  # pragma: no cover - package import fallback
    from scripts.fem_equilibrium_identity_replay import replay_preimage_json


IDENTITY_SCHEMA = "nonshared_floquet_operator_identity.v1"
SOURCE_STATE_SCHEMA = "nonshared_floquet_source_state.v1"
IDENTITY_PREIMAGE_SCHEMA = "nonshared_floquet_operator_identity_preimage.v1"
EXACT_REFS_SCHEMA = "nonshared_floquet_exact_replay_refs.v1"
SOURCE_STATE_PREIMAGE_SCHEMA = "nonshared_floquet_source_state_preimage.v1"
OPERATOR_INPUT_PREIMAGE_SCHEMA = "nonshared_floquet_operator_input_preimage.v1"
MATRIX_PENCIL_PREIMAGE_SCHEMA = "nonshared_floquet_matrix_pencil_preimage.v1"
MESH_PAYLOAD_PREIMAGE_SCHEMA = "nonshared_floquet_mesh_payload.v1"
PHYSICAL_SOURCE_PREIMAGE_SCHEMA = "nonshared_floquet_physical_source_preimage.v1"
NATIVE_INPUT_DIAGNOSTICS_SCHEMA = "nonshared_floquet_native_input_diagnostics.v1"
NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA = (
    "nonshared_floquet_native_input_diagnostics_preimage.v1"
)
NATIVE_INPUT_DIAGNOSTICS_REFS_SCHEMA = (
    "nonshared_floquet_native_input_diagnostics_refs.v1"
)
NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD = (
    "nonshared_floquet_native_input_diagnostics_sha256"
)
NATIVE_INPUT_DIAGNOSTICS_FILENAME = "native_input_operator_diagnostics.v1.json"
NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_FILENAME = (
    "native_input_operator_diagnostics_preimage.v1.json"
)
NATIVE_INPUT_DIAGNOSTICS_REFS_FIELD = (
    "nonshared_floquet_native_input_diagnostics_exact_refs"
)

_SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_RAW_SOURCE_SNAPSHOT_RE = re.compile(r"[0-9a-f]{64}\Z")
_MAX_JSON_DEPTH = 128
_REL_TOL = 5.0e-11
_ABS_TOL = 1.0e-12

_IDENTITY_REQUIRED = frozenset(
    {
        "schema_version",
        "content_sha256",
        "sample_index",
        "variant",
        "source_replay_qualified",
        "source_replay_available",
        "source_replay_status",
        "source_field_origins_verified",
        "source_field_lengths_verified",
        "source_mesh_node_count",
        "exact_replay_refs",
        "source_state_sha256",
        "operator_input_signature_sha256",
        "matrix_pencil_sha256",
        "mesh_topology_sha256",
        "source_mesh_topology_sha256",
        "mesh_payload_kind",
        "mesh_payload_sha256",
        "mesh_payload_path",
        "producer_plan_snapshot",
        "material_signature",
        "physics_signature",
        "boundary_signature",
        "damping_policy",
        "alpha",
        "k_vector_rad_m",
        "phase_convention",
        "floquet_pairs",
        "consumer_build_identity",
        "producer_build_identity",
        "source_handoff_sha256",
        "status",
    }
)
_IDENTITY_PREIMAGE_FIELDS = frozenset(
    {
        "schema_version",
        "identity_schema",
        "identity_preimage_json",
        "identity_preimage_sha256",
        "identity_content_sha256",
    }
)
_SOURCE_REQUIRED = frozenset(
    {
        "schema_version",
        "content_sha256",
        "variant",
        "sample_index",
        "source_replay_available",
        "source_replay_qualified",
        "source_replay_status",
        "source_field_origins_verified",
        "source_field_lengths_verified",
        "source_mesh_node_count",
        "exact_replay_refs",
        "mesh",
        "equilibrium",
        "material",
        "static_physics",
        "boundary",
        "damping",
        "k_sampling",
        "operator",
        "status",
    }
)
_OPERATOR_INPUT_REQUIRED = frozenset(
    {
        "schema_version",
        "assembly_kind",
        "matrix_equation",
        "source_equilibrium_sha256",
        "source_m0_sha256",
        "source_m0_origin",
        "mesh_topology_sha256",
        "mesh_topology_v6",
        "source_mesh_topology_sha256",
        "mesh_payload_kind",
        "mesh_payload_sha256",
        "mesh_payload_path",
        "producer_plan_snapshot",
        "material_signature",
        "physics_signature",
        "boundary_signature",
        "source_equilibrium_material_signature",
        "source_equilibrium_static_physics_signature",
        "source_equilibrium_boundary_signature",
        "source_material_provenance_signature",
        "source_replay_status",
        "damping_policy",
        "alpha",
        "k_vector_rad_m",
        "spin_wave_bc_kind",
        "phase_convention",
        "floquet_pairs",
        "matrix_pencil_sha256",
        "matrix_pencil_shape",
        "operator_diagnostics_sha256",
        "operator_diagnostics_schema",
        "active_node_count",
        "tangent_dof_count",
        "equilibrium_source_kind",
        "include_exchange",
        "include_demag",
    }
)
_MATRIX_REQUIRED = frozenset(
    {
        "schema_version",
        "row_major",
        "dimension",
        "active_node_count",
        "tangent_dof_count",
        "embedding",
        "stiffness_field_a_per_m",
        "stiffness_omega_rad_s",
        "gyrotropic",
        "tangent_mass",
    }
)


class NonSharedReplayError(ValueError):
    """A non-shared sidecar bundle is incomplete or internally inconsistent."""


@dataclass(frozen=True)
class NonSharedOperatorReplayReport:
    """Interpreted result of exact sidecar and matrix-contract replay."""

    status: str
    scientific_qualification: str
    sample_index: int
    operator_identity_sha256: str
    source_state_sha256: str
    operator_input_sha256: str
    matrix_pencil_sha256: str
    dimension: int
    embedding: str
    gamma0_rad_s_per_A_m: float | None
    alpha: float
    k_vector_rad_m: tuple[float, float, float]
    floquet_pair_count: int
    relation_metrics: Mapping[str, float | str | bool | None]
    exact_refs_verified: tuple[str, ...]
    source_replay_status: str
    gaps: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "scientific_qualification": self.scientific_qualification,
            "sample_index": self.sample_index,
            "operator_identity_sha256": self.operator_identity_sha256,
            "source_state_sha256": self.source_state_sha256,
            "operator_input_sha256": self.operator_input_sha256,
            "matrix_pencil_sha256": self.matrix_pencil_sha256,
            "dimension": self.dimension,
            "embedding": self.embedding,
            "gamma0_rad_s_per_A_m": self.gamma0_rad_s_per_A_m,
            "alpha": self.alpha,
            "k_vector_rad_m": list(self.k_vector_rad_m),
            "floquet_pair_count": self.floquet_pair_count,
            "relation_metrics": dict(self.relation_metrics),
            "exact_refs_verified": list(self.exact_refs_verified),
            "source_replay_status": self.source_replay_status,
            "gaps": list(self.gaps),
        }


def _fail(message: str) -> None:
    raise NonSharedReplayError(message)


def _reject_duplicate_keys(items: list[tuple[str, Any]], label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            _fail(f"{label}: duplicate key {key!r}")
        result[key] = value
    return result


def _reject_nonfinite(token: str, label: str) -> None:
    _fail(f"{label}: non-JSON number {token}")


def _validate_json_values(value: Any, label: str, depth: int = 0) -> None:
    if depth > _MAX_JSON_DEPTH:
        _fail(f"{label}: JSON nesting limit exceeded")
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise NonSharedReplayError(f"{label}: invalid Unicode string") from error
    elif type(value) is float and not math.isfinite(value):
        _fail(f"{label}: non-finite number")
    elif type(value) is dict:
        for key, item in value.items():
            _validate_json_values(key, label, depth + 1)
            _validate_json_values(item, f"{label}.{key}", depth + 1)
    elif type(value) is list:
        for index, item in enumerate(value):
            _validate_json_values(item, f"{label}[{index}]", depth + 1)


def _json_object(raw: bytes, label: str) -> dict[str, Any]:
    if type(raw) is not bytes:
        _fail(f"{label}: expected exact bytes")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=lambda items: _reject_duplicate_keys(items, label),
            parse_constant=lambda token: _reject_nonfinite(token, label),
            parse_int=lambda token: int(token),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        if isinstance(error, NonSharedReplayError):
            raise
        raise NonSharedReplayError(f"{label}: invalid UTF-8 JSON") from error
    if type(value) is not dict:
        _fail(f"{label}: expected object")
    _validate_json_values(value, label)
    return value


def _same_typed_json(left: Any, right: Any, label: str) -> None:
    if type(left) is not type(right):
        _fail(f"{label}: JSON type mismatch")
    if type(left) is dict:
        if left.keys() != right.keys():
            _fail(f"{label}: field set mismatch")
        for key in left:
            _same_typed_json(left[key], right[key], f"{label}.{key}")
    elif type(left) is list:
        if len(left) != len(right):
            _fail(f"{label}: array length mismatch")
        for index, (a, b) in enumerate(zip(left, right)):
            _same_typed_json(a, b, f"{label}[{index}]")
    elif left != right:
        _fail(f"{label}: value mismatch")


def _fields(value: Mapping[str, Any], required: frozenset[str], label: str) -> None:
    missing = sorted(required - set(value))
    if missing:
        _fail(f"{label}: missing fields {','.join(missing)}")


def _digest(value: Any, label: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        _fail(f"{label}: expected sha256:<64 lowercase hex>")
    return value


def raw_sha256(raw: bytes) -> str:
    """Return the Rust ``raw_sha256`` spelling for exact bytes."""

    return "sha256:" + hashlib.sha256(raw).hexdigest()


def framed_sha256(namespace: str, raw: bytes) -> str:
    """Return Fullmag's namespace/NUL/u64-little-endian framed digest."""

    if not isinstance(namespace, str) or not namespace:
        _fail("framed digest namespace must be non-empty")
    return "sha256:" + hashlib.sha256(
        namespace.encode("utf-8") + b"\0" + struct.pack("<Q", len(raw)) + raw
    ).hexdigest()


def _finite(value: Any, label: str) -> float:
    if type(value) not in (int, float) or isinstance(value, bool):
        _fail(f"{label}: expected finite number")
    try:
        converted = float(value)
    except (OverflowError, ValueError) as error:
        raise NonSharedReplayError(f"{label}: expected finite number") from error
    if not math.isfinite(converted):
        _fail(f"{label}: expected finite number")
    return converted


def _integer(value: Any, label: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        _fail(f"{label}: expected integer >= {minimum}")
    return value


def _boolean(value: Any, label: str) -> bool:
    if type(value) is not bool:
        _fail(f"{label}: expected boolean")
    return value


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label}: expected object")
    return value


def _damping_record(source_state: Mapping[str, Any]) -> Mapping[str, Any]:
    damping = _mapping(source_state.get("damping"), "source_state.damping")
    _fields(damping, frozenset({"policy", "alpha"}), "source_state.damping")
    if type(damping["policy"]) is not str or not damping["policy"]:
        _fail("source_state.damping.policy: expected non-empty string")
    _finite(damping["alpha"], "source_state.damping.alpha")
    return damping


def _operator_record(source_state: Mapping[str, Any]) -> Mapping[str, Any]:
    operator = _mapping(source_state.get("operator"), "source_state.operator")
    _fields(
        operator,
        frozenset({"input_signature_sha256", "matrix_pencil_sha256"}),
        "source_state.operator",
    )
    _digest(
        operator["input_signature_sha256"],
        "source_state.operator.input_signature_sha256",
    )
    _digest(
        operator["matrix_pencil_sha256"],
        "source_state.operator.matrix_pencil_sha256",
    )
    return operator


def _digest_or_null(value: Any, label: str) -> str | None:
    if value is None:
        return None
    return _digest(value, label)


def _safe_relative_path(root: Path, relative: Any, label: str) -> tuple[Path, str]:
    if type(relative) is not str or not relative or "\\" in relative:
        _fail(f"{label}: expected non-empty POSIX relative path")
    # Path normalizes '.' and empty components before we can inspect them.
    # Validate the signed spelling first so one sidecar has one path identity.
    if any(part in ("", ".", "..") for part in relative.split("/")):
        _fail(f"{label}: noncanonical POSIX path component")
    candidate_relative = Path(relative)
    if candidate_relative.is_absolute() or ".." in candidate_relative.parts:
        _fail(f"{label}: path traversal or absolute path")
    root_resolved = root.resolve()
    candidate = (root_resolved / candidate_relative).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as error:
        raise NonSharedReplayError(f"{label}: path escapes replay root") from error
    return candidate, relative


def _require_sample_path(relative: Any, sample_index: int, label: str) -> str:
    if type(relative) is not str or not relative.startswith(_sample_prefix(sample_index)):
        _fail(f"{label}: path is not bound to sample_{sample_index:04d}")
    return relative


def _read_relative(root: Path, relative: Any, label: str) -> tuple[bytes, str]:
    path, normalized = _safe_relative_path(root, relative, label)
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise NonSharedReplayError(f"{label}: cannot read {normalized}") from error
    return raw, normalized


def _read_optional_relative(root: Path, relative: Any, label: str) -> tuple[bytes, str] | None:
    path, normalized = _safe_relative_path(root, relative, label)
    if not path.exists():
        return None
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise NonSharedReplayError(f"{label}: cannot read {normalized}") from error
    return raw, normalized


def _check_ref_shape(ref: Any, label: str, *, namespace_required: bool = False) -> Mapping[str, Any]:
    if not isinstance(ref, Mapping):
        _fail(f"{label}: expected object")
    required = {"schema_version", "path", "encoding", "byte_length", "raw_sha256"}
    if namespace_required:
        required.add("semantic_namespace")
    _fields(ref, frozenset(required), label)
    if type(ref["schema_version"]) is not str or not ref["schema_version"]:
        _fail(f"{label}.schema_version: expected string")
    if ref["encoding"] != "utf-8-json-bytes":
        _fail(f"{label}.encoding: unsupported encoding")
    _integer(ref["byte_length"], f"{label}.byte_length")
    _digest(ref["raw_sha256"], f"{label}.raw_sha256")
    if "semantic_signature" in ref:
        _digest(ref["semantic_signature"], f"{label}.semantic_signature")
    if namespace_required:
        if type(ref["semantic_namespace"]) is not str or not ref["semantic_namespace"]:
            _fail(f"{label}.semantic_namespace: expected non-empty string")
    return ref


def _read_ref(root: Path, ref: Mapping[str, Any], label: str) -> tuple[bytes, dict[str, Any]]:
    raw, _ = _read_relative(root, ref["path"], f"{label}.path")
    if len(raw) != ref["byte_length"]:
        _fail(f"{label}: byte length mismatch")
    actual = raw_sha256(raw)
    if actual != ref["raw_sha256"]:
        _fail(f"{label}: raw SHA-256 mismatch")
    parsed = _json_object(raw, label)
    return raw, parsed


def _replace_empty_digest(value: Mapping[str, Any], field: str, label: str) -> dict[str, Any]:
    expected = dict(value)
    expected[field] = ""
    return expected


def _sample_prefix(sample_index: int) -> str:
    return f"eigen/metadata/sample_{sample_index:04d}/"


def _validate_identity_preimage(
    identity: Mapping[str, Any], sidecar_raw: bytes
) -> str:
    sidecar = _json_object(sidecar_raw, "operator identity preimage sidecar")
    if set(sidecar) != _IDENTITY_PREIMAGE_FIELDS:
        _fail("operator identity preimage sidecar: invalid field set")
    if sidecar["schema_version"] != IDENTITY_PREIMAGE_SCHEMA:
        _fail("operator identity preimage sidecar: unsupported schema")
    if sidecar["identity_schema"] != IDENTITY_SCHEMA:
        _fail("operator identity preimage sidecar: identity schema mismatch")
    declared = _digest(identity["content_sha256"], "identity.content_sha256")
    if sidecar["identity_content_sha256"] != declared:
        _fail("operator identity preimage sidecar: content digest mismatch")
    text = sidecar["identity_preimage_json"]
    if type(text) is not str:
        _fail("operator identity preimage sidecar: preimage must be string")
    try:
        preimage_raw = text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise NonSharedReplayError("operator identity preimage sidecar: invalid UTF-8") from error
    declared_raw = _digest(sidecar["identity_preimage_sha256"], "identity preimage digest")
    if raw_sha256(preimage_raw) != declared_raw:
        _fail("operator identity preimage sidecar: raw digest mismatch")
    parsed = _json_object(preimage_raw, "operator identity preimage")
    _same_typed_json(parsed, _replace_empty_digest(identity, "content_sha256", "identity"), "identity preimage")
    if raw_sha256(preimage_raw) != declared:
        _fail("operator identity: content_sha256 is not the raw preimage digest")
    return declared


def _validate_refs_object(
    refs: Mapping[str, Any], label: str
) -> Mapping[str, Any]:
    _fields(refs, frozenset({"schema_version", "operator_input", "matrix_pencil", "physical_source"}), label)
    if refs["schema_version"] != EXACT_REFS_SCHEMA:
        _fail(f"{label}.schema_version: unsupported schema")
    _check_ref_shape(refs["operator_input"], f"{label}.operator_input")
    _check_ref_shape(refs["matrix_pencil"], f"{label}.matrix_pencil")
    if "mesh_payload" in refs:
        mesh_ref = _check_ref_shape(refs["mesh_payload"], f"{label}.mesh_payload")
        if mesh_ref["schema_version"] != MESH_PAYLOAD_PREIMAGE_SCHEMA:
            _fail(f"{label}.mesh_payload: unsupported schema")
    physical = refs["physical_source"]
    if physical is not None:
        if not isinstance(physical, Mapping):
            _fail(f"{label}.physical_source: expected object or null")
        expected = frozenset(
            {"equilibrium_material", "equilibrium_static_physics", "equilibrium_boundary", "material_provenance"}
        )
        _fields(physical, expected, f"{label}.physical_source")
        for key in expected:
            _check_ref_shape(physical[key], f"{label}.physical_source.{key}", namespace_required=True)
    return refs


def _validate_source_ref_subset(source_refs: Mapping[str, Any], identity_refs: Mapping[str, Any]) -> None:
    for key in ("schema_version", "operator_input", "matrix_pencil", "physical_source"):
        if key not in source_refs or key not in identity_refs:
            _fail(f"exact replay refs: missing {key}")
        _same_typed_json(source_refs[key], identity_refs[key], f"exact replay refs.{key}")
    source_has_mesh = "mesh_payload" in source_refs
    identity_has_mesh = "mesh_payload" in identity_refs
    if source_has_mesh != identity_has_mesh:
        _fail("exact replay refs: mesh_payload presence mismatch")
    if source_has_mesh:
        _same_typed_json(
            source_refs["mesh_payload"],
            identity_refs["mesh_payload"],
            "exact replay refs.mesh_payload",
        )


def _validate_mesh_payload_ref(
    root: Path,
    ref: Mapping[str, Any],
    identity: Mapping[str, Any],
    sample_index: int,
    label: str,
) -> bytes:
    """Validate the exact mesh bytes and their binding to one computed sample."""

    _check_ref_shape(ref, label)
    if ref["schema_version"] != MESH_PAYLOAD_PREIMAGE_SCHEMA:
        _fail(f"{label}: unsupported schema")
    _integer(ref.get("sample_index"), f"{label}.sample_index")
    if ref["sample_index"] != sample_index:
        _fail(f"{label}.sample_index: mismatch")
    ref_path = _require_sample_path(ref["path"], sample_index, f"{label}.path")
    identity_path = _require_sample_path(
        identity["mesh_payload_path"], sample_index, "identity.mesh_payload_path"
    )
    if ref_path != identity_path:
        _fail(f"{label}.path: does not match identity.mesh_payload_path")
    expected_sha = _digest(identity["mesh_payload_sha256"], "identity.mesh_payload_sha256")
    if ref.get("semantic_signature") != expected_sha:
        _fail(f"{label}.semantic_signature: does not match identity.mesh_payload_sha256")
    raw, _ = _read_ref(root, ref, label)
    if raw_sha256(raw) != expected_sha:
        _fail(f"{label}: raw SHA-256 does not match identity.mesh_payload_sha256")
    return raw


def _validate_build_identity(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label}: expected object")
    if "source_snapshot_sha256" not in value:
        _fail(f"{label}: source_snapshot_sha256 missing")
    if (
        type(value["source_snapshot_sha256"]) is not str
        or _RAW_SOURCE_SNAPSHOT_RE.fullmatch(value["source_snapshot_sha256"]) is None
    ):
        _fail(
            f"{label}.source_snapshot_sha256: expected 64 lowercase hexadecimal characters without sha256: prefix"
        )
    return value


def _validate_plan_snapshot(
    root: Path, value: Any, label: str, *, sample_index: int | None = None
) -> Mapping[str, Any] | None:
    """Validate the producer plan bytes referenced by the non-shared record."""

    if value is None:
        return None
    if not isinstance(value, Mapping):
        _fail(f"{label}: expected object or null")
    required = frozenset({"namespace", "encoding", "path", "raw_sha256", "framed_sha256"})
    _fields(value, required, label)
    if type(value["namespace"]) is not str or not value["namespace"]:
        _fail(f"{label}.namespace: expected non-empty string")
    if value["encoding"] != "utf-8-json-bytes":
        _fail(f"{label}.encoding: unsupported encoding")
    _digest(value["raw_sha256"], f"{label}.raw_sha256")
    _digest(value["framed_sha256"], f"{label}.framed_sha256")
    if sample_index is not None:
        _require_sample_path(value["path"], sample_index, f"{label}.path")
    raw, _ = _read_relative(root, value["path"], f"{label}.path")
    if raw_sha256(raw) != value["raw_sha256"]:
        _fail(f"{label}: raw SHA-256 mismatch")
    # Producer plan snapshots are exact JSON bytes.  Their framed digest uses
    # the same namespace/NUL/u64 convention as the relaxation producer.
    if framed_sha256(value["namespace"], raw) != value["framed_sha256"]:
        _fail(f"{label}: framed SHA-256 mismatch")
    _json_object(raw, f"{label}.preimage")
    return value


def _validate_vector(value: Any, label: str, length: int = 3) -> tuple[float, ...]:
    if type(value) is not list or len(value) != length:
        _fail(f"{label}: expected vector of length {length}")
    return tuple(_finite(item, f"{label}[{index}]") for index, item in enumerate(value))


def _max_abs_difference(left: list[float], right: list[float], scale: float = 1.0) -> float:
    if len(left) != len(right):
        _fail("matrix relation: length mismatch")
    return max((abs(a - b) for a, b in zip(left, right)), default=0.0) / max(scale, 1.0)


def _close(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=_REL_TOL, abs_tol=_ABS_TOL)


def _matrix_close(left: float, right: float) -> bool:
    # Mass-weighted FEM entries may be far below unity in SI. A fixed
    # unit-sized absolute floor would certify an arbitrarily wrong pencil.
    return math.isclose(left, right, rel_tol=_REL_TOL, abs_tol=0.0)


def _validate_matrix(
    matrix: Mapping[str, Any],
    source_state: Mapping[str, Any],
    operator_input: Mapping[str, Any],
) -> tuple[int, str, float | None, float, Mapping[str, float | str | bool | None]]:
    _fields(matrix, _MATRIX_REQUIRED, "matrix pencil")
    if matrix["schema_version"] != "nonshared_floquet_matrix_pencil.v1":
        _fail("matrix pencil: unsupported schema")
    if matrix["row_major"] is not True:
        _fail("matrix pencil: row_major must be true")
    dimension = _integer(matrix["dimension"], "matrix.dimension", 1)
    active_nodes = _integer(matrix["active_node_count"], "matrix.active_node_count", 1)
    if _integer(matrix["tangent_dof_count"], "matrix.tangent_dof_count", 1) != dimension:
        _fail("matrix pencil: tangent_dof_count/dimension mismatch")
    embedding = matrix["embedding"]
    if type(embedding) is not str or embedding not in {
        "direct_real_tangent",
        "complex_bloch_real_embedding",
    }:
        _fail("matrix pencil: unsupported embedding")
    expected_length = dimension * dimension
    arrays: dict[str, list[float]] = {}
    for key in ("stiffness_field_a_per_m", "stiffness_omega_rad_s", "gyrotropic", "tangent_mass"):
        value = matrix[key]
        if type(value) is not list or len(value) != expected_length:
            _fail(f"matrix.{key}: expected {expected_length} row-major values")
        arrays[key] = [_finite(item, f"matrix.{key}[{index}]") for index, item in enumerate(value)]
    field = arrays["stiffness_field_a_per_m"]
    omega = arrays["stiffness_omega_rad_s"]
    physics = source_state.get("static_physics")
    plan = physics.get("plan") if isinstance(physics, Mapping) else None
    gamma = _finite(plan["gyromagnetic_ratio"], "source_state.static_physics.plan.gyromagnetic_ratio") if isinstance(plan, Mapping) and "gyromagnetic_ratio" in plan else None
    omega_error: float | None = None
    gamma_status: str = "NOT_VERIFIED_gamma_missing"
    if gamma is not None:
        expected_omega = [value * gamma for value in field]
        omega_error = max((abs(actual - expected) for actual, expected in zip(omega, expected_omega)), default=0.0)
        if not all(_matrix_close(actual, expected) for actual, expected in zip(omega, expected_omega)):
            _fail(f"matrix pencil: K_omega != gamma*K_field (max_abs={omega_error})")
        gamma_status = "verified"
    if operator_input.get("tangent_dof_count") != dimension:
        _fail("operator input: tangent_dof_count does not match matrix")
    shape = operator_input.get("matrix_pencil_shape")
    if not isinstance(shape, Mapping) or shape.get("rows") != dimension or shape.get("columns") != dimension or shape.get("ordering") != "row_major":
        _fail("operator input: matrix_pencil_shape does not match matrix")

    # G/B is expected to be skew-symmetric for both real representations.  A
    # direct 2N representation additionally has the exact repeated-M block
    # relationship emitted by gyrotropic_matrix_row_major_from_tangent_mass.
    b = arrays["gyrotropic"]
    skew_error = max((abs(b[row * dimension + col] + b[col * dimension + row])
                      for row in range(dimension) for col in range(dimension)), default=0.0)
    scale = max((abs(value) for value in b), default=0.0)
    skew_verified = all(
        _matrix_close(b[row * dimension + col], -b[col * dimension + row])
        for row in range(dimension)
        for col in range(dimension)
    )
    block_status = "skew_symmetric_only"
    if embedding == "direct_real_tangent":
        if dimension != active_nodes * 2:
            _fail("matrix pencil: direct embedding dimension must be 2*active_node_count")
        n = active_nodes
        mass = arrays["tangent_mass"]
        tol = _REL_TOL * max((abs(value) for value in mass), default=0.0)
        for row in range(n):
            for col in range(n):
                if abs(mass[row * dimension + col + n]) > tol or abs(mass[(row + n) * dimension + col]) > tol:
                    _fail("matrix pencil: tangent mass has a nonzero cross-component block")
                if abs(mass[row * dimension + col] - mass[(row + n) * dimension + col + n]) > tol:
                    _fail("matrix pencil: tangent mass diagonal blocks differ")
                if abs(b[row * dimension + col]) > tol or abs(b[(row + n) * dimension + col + n]) > tol:
                    _fail("matrix pencil: direct gyrotropic diagonal blocks must be zero")
                expected_upper = mass[row * dimension + col]
                expected_lower = -expected_upper
                if not _matrix_close(b[row * dimension + col + n], expected_upper) or not _matrix_close(b[(row + n) * dimension + col], expected_lower):
                    _fail("matrix pencil: direct gyrotropic block does not match tangent mass")
        block_status = "direct_G_equals_0_M_minus_M_0_verified"
    else:
        if dimension != active_nodes * 4:
            _fail("matrix pencil: complex Bloch embedding dimension must be 4*active_node_count")
        if not skew_verified:
            _fail(f"matrix pencil: complex gyrotropic B is not skew-symmetric (max_abs={skew_error})")
        block_status = "complex_embedding_skew_structure_verified"
    damping = _damping_record(source_state)
    return dimension, embedding, gamma, float(damping["alpha"]), {
        "k_omega_minus_gamma_k_field_max_abs": omega_error,
        "gamma_relation": gamma_status,
        "gyrotropic_skew_max_abs": skew_error,
        "gyrotropic_scale": scale,
        "gyrotropic_skew_structure": "verified" if skew_verified else "NOT_VERIFIED_non_skew_direct_mass",
        "gyrotropic_block_structure": block_status,
    }


def _validate_pairs(
    pairs: Any,
    k_vector: tuple[float, float, float],
    phase_convention: Any,
) -> int:
    if type(pairs) is not list:
        _fail("operator input.floquet_pairs: expected array")
    seen: set[str] = set()
    for index, pair in enumerate(pairs):
        if not isinstance(pair, Mapping):
            _fail(f"floquet_pairs[{index}]: expected object")
        for key in ("pair_id", "node_a", "node_b", "translation_m", "phase_rad", "phase_convention"):
            if key not in pair:
                _fail(f"floquet_pairs[{index}]: missing {key}")
        pair_id = pair["pair_id"]
        if type(pair_id) is not str or not pair_id:
            _fail(f"floquet_pairs[{index}].pair_id: duplicate or invalid")
        if pair_id in seen:
            _fail(f"floquet_pairs[{index}].pair_id: duplicate or invalid")
        seen.add(pair_id)
        _integer(pair["node_a"], f"floquet_pairs[{index}].node_a")
        _integer(pair["node_b"], f"floquet_pairs[{index}].node_b")
        translation = _validate_vector(pair["translation_m"], f"floquet_pairs[{index}].translation_m")
        phase = _finite(pair["phase_rad"], f"floquet_pairs[{index}].phase_rad")
        expected_phase = -sum(k * delta for k, delta in zip(k_vector, translation))
        if not _close(phase, expected_phase):
            _fail(f"floquet_pairs[{index}]: phase does not equal -k dot translation")
        if pair["phase_convention"] != phase_convention:
            _fail(f"floquet_pairs[{index}]: phase convention mismatch")
    return len(pairs)


def _validate_operator_input(
    operator_input: Mapping[str, Any], source_state: Mapping[str, Any], matrix_ref: Mapping[str, Any]
) -> tuple[tuple[float, float, float], float, int]:
    _fields(operator_input, _OPERATOR_INPUT_REQUIRED, "operator input")
    if operator_input["schema_version"] != "nonshared_floquet_operator_input.v1":
        _fail("operator input: unsupported schema")
    if operator_input["assembly_kind"] != "runner_full_2x2_bloch_floquet":
        _fail("operator input: non-Floquet assembly kind")
    if operator_input["matrix_equation"] != "K_omega(k) q = lambda B(k) q":
        _fail("operator input: unsupported matrix equation")
    if operator_input["spin_wave_bc_kind"] != "floquet":
        _fail("operator input: spin_wave_bc_kind is not floquet")
    _boolean(operator_input["include_exchange"], "operator input.include_exchange")
    _boolean(operator_input["include_demag"], "operator input.include_demag")
    k_vector = _validate_vector(operator_input["k_vector_rad_m"], "operator input.k_vector_rad_m")
    alpha = _finite(operator_input["alpha"], "operator input.alpha")
    damping_policy = operator_input["damping_policy"]
    if type(damping_policy) is not str or damping_policy not in {"ignore", "include"}:
        _fail("operator input: unsupported damping_policy")
    _digest(
        operator_input["operator_diagnostics_sha256"],
        "operator input.operator_diagnostics_sha256",
    )
    if operator_input["operator_diagnostics_schema"] != "frequency_domain_operator_diagnostics.v1":
        _fail("operator input: unsupported operator diagnostics schema")
    matrix_ref_signature = matrix_ref.get("semantic_signature")
    _digest(operator_input["matrix_pencil_sha256"], "operator input.matrix_pencil_sha256")
    if matrix_ref_signature != operator_input["matrix_pencil_sha256"]:
        _fail("operator input: matrix signature does not match exact ref")
    damping = _damping_record(source_state)
    if damping["alpha"] != operator_input["alpha"]:
        _fail("operator input: alpha differs from source state")
    pair_count = _validate_pairs(operator_input["floquet_pairs"], k_vector, operator_input["phase_convention"])
    return k_vector, alpha, pair_count


def _validate_physical_refs(root: Path, refs: Any) -> bool:
    if refs is None:
        return False
    if not isinstance(refs, Mapping):
        _fail("exact replay refs.physical_source: expected object or null")
    kinds = {
        "equilibrium_material": "equilibrium_material",
        "equilibrium_static_physics": "static_physics",
        "equilibrium_boundary": "boundary",
        "material_provenance": "raw_material",
    }
    for key, kind in kinds.items():
        ref = refs[key]
        _check_ref_shape(ref, f"physical_source.{key}", namespace_required=True)
        raw, _ = _read_ref(root, ref, f"physical_source.{key}")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise NonSharedReplayError(f"physical_source.{key}: invalid UTF-8") from error
        try:
            actual = replay_preimage_json(text, ref["semantic_signature"], kind)
        except Exception as error:
            raise NonSharedReplayError(f"physical_source.{key}: semantic preimage rejected: {error}") from error
        if actual != ref["semantic_signature"]:
            _fail(f"physical_source.{key}: semantic digest mismatch")
        expected_namespace = {
            "equilibrium_material": "EquilibriumMaterialSignaturePreimage.v1",
            "static_physics": "EquilibriumStaticPhysicsSignaturePreimage.v1",
            "boundary": "EquilibriumBoundarySignaturePreimage.v1",
            "raw_material": "material_signature",
        }[kind]
        if ref["semantic_namespace"] != expected_namespace:
            _fail(f"physical_source.{key}: semantic namespace mismatch")
    return True


def replay_nonshared_operator(
    root: Path,
    *,
    sample_index: int,
    identity_path: Path | None = None,
    identity_preimage_path: Path | None = None,
    source_state_path: Path | None = None,
    operator_diagnostics: Mapping[str, Any] | None = None,
) -> NonSharedOperatorReplayReport:
    """Replay one published sample under ``root``.

    The default paths match ``NonSharedFloquetProvenance.identity_sidecars``.
    Explicit paths are provided for callers that consume a manifest, but every
    reference inside the identity remains authoritative and is checked against
    ``root``.  Missing exact bytes or any mismatch raises
    :class:`NonSharedReplayError` instead of returning a partial pass.
    """

    if type(sample_index) is not int or sample_index < 0:
        _fail("sample_index must be a non-negative integer")
    root = Path(root)
    prefix = _sample_prefix(sample_index)
    identity_rel = identity_path or Path(prefix + "nonshared_floquet_operator_identity.v1.json")
    identity_preimage_rel = identity_preimage_path or Path(prefix + "nonshared_floquet_operator_identity_preimage.v1.json")
    source_state_rel = source_state_path or Path(prefix + "nonshared_floquet_source_state.v1.json")
    identity_rel_string = str(identity_rel).replace("\\", "/")
    identity_preimage_rel_string = str(identity_preimage_rel).replace("\\", "/")
    source_state_rel_string = str(source_state_rel).replace("\\", "/")
    _require_sample_path(identity_rel_string, sample_index, "operator identity path")
    _require_sample_path(identity_preimage_rel_string, sample_index, "operator identity preimage path")
    _require_sample_path(source_state_rel_string, sample_index, "source state path")
    identity_raw, _ = _read_relative(root, identity_rel_string, "operator identity path")
    identity = _json_object(identity_raw, "operator identity")
    _fields(identity, _IDENTITY_REQUIRED, "operator identity")
    if identity["schema_version"] != IDENTITY_SCHEMA or identity["variant"] != "nonshared_floquet":
        _fail("operator identity: unsupported schema or variant")
    _integer(identity["sample_index"], "identity.sample_index")
    for key in (
        "source_replay_qualified",
        "source_replay_available",
        "source_field_origins_verified",
        "source_field_lengths_verified",
    ):
        _boolean(identity[key], f"identity.{key}")
    if identity["source_mesh_node_count"] is not None:
        _integer(identity["source_mesh_node_count"], "identity.source_mesh_node_count", 1)
    if identity["sample_index"] != sample_index:
        _fail("operator identity: sample_index mismatch")
    identity_preimage_raw, _ = _read_relative(root, identity_preimage_rel_string, "operator identity preimage path")
    identity_digest = _validate_identity_preimage(identity, identity_preimage_raw)
    identity_refs = identity["exact_replay_refs"]
    _validate_refs_object(identity_refs, "identity.exact_replay_refs")
    for ref_name in ("operator_input", "matrix_pencil", "source_state"):
        _require_sample_path(
            identity_refs[ref_name]["path"], sample_index, f"identity.exact_replay_refs.{ref_name}.path"
        )
    mesh_payload_ref = identity_refs.get("mesh_payload")
    mesh_payload_ref_raw: bytes | None = None
    if mesh_payload_ref is not None:
        mesh_payload_ref_raw = _validate_mesh_payload_ref(
            root,
            mesh_payload_ref,
            identity,
            sample_index,
            "identity.exact_replay_refs.mesh_payload",
        )
    if identity_refs["physical_source"] is not None:
        for ref_name, ref in identity_refs["physical_source"].items():
            _require_sample_path(
                ref["path"], sample_index, f"identity.exact_replay_refs.physical_source.{ref_name}.path"
            )

    source_state_raw, _ = _read_relative(root, source_state_rel_string, "source state path")
    source_state = _json_object(source_state_raw, "source state")
    _fields(source_state, _SOURCE_REQUIRED, "source state")
    if source_state["schema_version"] != SOURCE_STATE_SCHEMA or source_state["variant"] != "nonshared_floquet":
        _fail("source state: unsupported schema or variant")
    _integer(source_state["sample_index"], "source_state.sample_index")
    for key in (
        "source_replay_qualified",
        "source_replay_available",
        "source_field_origins_verified",
        "source_field_lengths_verified",
    ):
        _boolean(source_state[key], f"source_state.{key}")
    if source_state["source_mesh_node_count"] is not None:
        _integer(source_state["source_mesh_node_count"], "source_state.source_mesh_node_count", 1)
    if source_state["sample_index"] != sample_index:
        _fail("source state: sample_index mismatch")
    identity_plan_snapshot = _validate_plan_snapshot(
        root, identity["producer_plan_snapshot"], "identity.producer_plan_snapshot", sample_index=sample_index
    )
    source_plan_snapshot = _validate_plan_snapshot(
        root, source_state.get("producer_plan_snapshot"), "source_state.producer_plan_snapshot", sample_index=sample_index
    )
    source_preimage_ref = identity_refs.get("source_state")
    _check_ref_shape(source_preimage_ref, "identity.exact_replay_refs.source_state")
    if source_preimage_ref["schema_version"] != SOURCE_STATE_PREIMAGE_SCHEMA:
        _fail("source state ref: unsupported schema")
    source_preimage_raw, _ = _read_ref(root, source_preimage_ref, "source state preimage")
    source_preimage = _json_object(source_preimage_raw, "source state preimage")
    _same_typed_json(source_preimage, _replace_empty_digest(source_state, "content_sha256", "source state"), "source state preimage")
    source_state_digest = _digest(source_state["content_sha256"], "source_state.content_sha256")
    if raw_sha256(source_preimage_raw) != source_state_digest or source_preimage_ref.get("semantic_signature") != source_state_digest:
        _fail("source state: content digest/ref mismatch")
    source_refs = source_state["exact_replay_refs"]
    _validate_refs_object(source_refs, "source_state.exact_replay_refs")
    _validate_source_ref_subset(source_refs, identity_refs)

    operator_ref = identity_refs["operator_input"]
    matrix_ref = identity_refs["matrix_pencil"]
    _check_ref_shape(operator_ref, "identity.exact_replay_refs.operator_input")
    _check_ref_shape(matrix_ref, "identity.exact_replay_refs.matrix_pencil")
    if operator_ref["schema_version"] != OPERATOR_INPUT_PREIMAGE_SCHEMA:
        _fail("operator input ref: unsupported schema")
    if matrix_ref["schema_version"] != MATRIX_PENCIL_PREIMAGE_SCHEMA:
        _fail("matrix pencil ref: unsupported schema")
    operator_raw, operator_input = _read_ref(root, operator_ref, "operator input")
    matrix_raw, matrix = _read_ref(root, matrix_ref, "matrix pencil")
    operator_plan_snapshot = _validate_plan_snapshot(
        root, operator_input["producer_plan_snapshot"], "operator_input.producer_plan_snapshot", sample_index=sample_index
    )
    if identity_plan_snapshot != source_plan_snapshot or identity_plan_snapshot != operator_plan_snapshot:
        _fail("producer plan snapshot is not bound across identity/source/operator")
    operator_digest = _digest(operator_ref.get("semantic_signature"), "operator input ref.semantic_signature")
    matrix_digest = _digest(matrix_ref.get("semantic_signature"), "matrix pencil ref.semantic_signature")
    if raw_sha256(operator_raw) != operator_digest or raw_sha256(matrix_raw) != matrix_digest:
        _fail("exact replay refs: semantic signature does not equal raw preimage SHA")
    operator_record = _operator_record(source_state)
    if identity["operator_input_signature_sha256"] != operator_digest or operator_record["input_signature_sha256"] != operator_digest:
        _fail("operator input signature is not bound across identity/source state")
    if identity["matrix_pencil_sha256"] != matrix_digest or operator_record["matrix_pencil_sha256"] != matrix_digest:
        _fail("matrix pencil signature is not bound across identity/source state")
    k_vector, alpha, pair_count = _validate_operator_input(operator_input, source_state, matrix_ref)
    equilibrium = source_state["equilibrium"]
    if not isinstance(equilibrium, Mapping):
        _fail("source state.equilibrium: expected object")
    if operator_input["source_equilibrium_sha256"] != equilibrium.get("runtime_equilibrium_sha256"):
        _fail("operator input: source equilibrium digest is not bound to source state")
    if operator_input["source_m0_sha256"] != equilibrium.get("m0_sha256"):
        _fail("operator input: source m0 digest is not bound to source state")
    if operator_input["source_m0_origin"] != equilibrium.get("m0_origin"):
        _fail("operator input: source m0 origin is not bound to source state")
    dimension, embedding, gamma, matrix_alpha, metrics = _validate_matrix(matrix, source_state, operator_input)
    if not _close(alpha, matrix_alpha):
        _fail("alpha differs between operator input and matrix/source state")
    if identity["floquet_pairs"] != operator_input["floquet_pairs"]:
        _fail("identity/source operator Floquet pair list mismatch")
    if identity["k_vector_rad_m"] != list(k_vector):
        _fail("identity/source operator k vector mismatch")
    if identity["alpha"] != alpha:
        _fail("identity/source operator alpha mismatch")
    if identity["source_state_sha256"] != source_state_digest:
        _fail("identity source_state_sha256 mismatch")
    if identity["source_replay_status"] != source_state["source_replay_status"]:
        _fail("source replay status mismatch")
    if identity["source_replay_qualified"] != source_state["source_replay_qualified"]:
        _fail("source replay qualification mismatch")
    for key, source_key in (
        ("material_signature", "material"),
        ("physics_signature", "static_physics"),
        ("boundary_signature", "boundary"),
    ):
        source_record = source_state[source_key]
        if not isinstance(source_record, Mapping):
            _fail(f"source state.{source_key}: expected object")
        if identity[key] != operator_input[key] or identity[key] != source_record.get("signature"):
            _fail(f"source/material identity mismatch for {key}")
    damping = _damping_record(source_state)
    if identity["damping_policy"] != operator_input["damping_policy"] or identity["damping_policy"] != damping["policy"]:
        _fail("damping policy is not bound across identity/source/operator")
    mesh = _mapping(source_state["mesh"], "source_state.mesh")
    for key in ("mesh_topology_sha256", "source_mesh_topology_sha256", "mesh_payload_kind", "mesh_payload_sha256", "mesh_payload_path"):
        if identity[key] != operator_input[key] or identity[key] != mesh.get({
            "mesh_topology_sha256": "topology_fingerprint_v3",
            "source_mesh_topology_sha256": "source_mesh_topology_sha256",
            "mesh_payload_kind": "payload_kind",
            "mesh_payload_sha256": "payload_sha256",
            "mesh_payload_path": "payload_path",
        }[key]):
            _fail(f"mesh/source identity mismatch for {key}")

    # The mesh sidecar is always checked against the identity path and digest.
    # New bundles additionally carry the same bytes as an exact replay ref;
    # historical bundles retain an explicit gap for that missing binding.
    _require_sample_path(identity["mesh_payload_path"], sample_index, "mesh payload")
    expected_mesh_sha = _digest(identity["mesh_payload_sha256"], "identity.mesh_payload_sha256")
    if mesh_payload_ref_raw is None:
        mesh_raw, _ = _read_relative(root, identity["mesh_payload_path"], "mesh payload")
    else:
        mesh_raw = mesh_payload_ref_raw
    if raw_sha256(mesh_raw) != expected_mesh_sha:
        _fail("mesh payload: raw SHA-256 mismatch")
    mesh_payload_ref_gap = (
        None if mesh_payload_ref is not None else "mesh_payload_not_in_exact_replay_refs"
    )

    physical_verified = _validate_physical_refs(root, identity_refs["physical_source"])
    source_qualified = bool(identity["source_replay_qualified"])
    if source_qualified and identity_plan_snapshot is None:
        _fail("source replay is qualified but producer plan snapshot is absent")
    if source_qualified and not physical_verified:
        _fail("source replay is qualified but physical source preimages are absent")
    if physical_verified:
        physical_refs = identity_refs["physical_source"]
        for operator_key, physical_key in (
            ("source_equilibrium_material_signature", "equilibrium_material"),
            ("source_equilibrium_static_physics_signature", "equilibrium_static_physics"),
            ("source_equilibrium_boundary_signature", "equilibrium_boundary"),
            ("source_material_provenance_signature", "material_provenance"),
        ):
            if operator_input[operator_key] != physical_refs[physical_key].get("semantic_signature"):
                _fail(f"operator input: {operator_key} is not bound to physical source preimage")
    gaps: list[str] = [gap for gap in (mesh_payload_ref_gap,) if gap]
    if not source_qualified:
        gaps.append("source_replay_not_qualified")
    native_input_diagnostics_verified = False
    if operator_diagnostics is None:
        operator_diagnostics = _load_and_validate_native_input_diagnostics(
            root,
            sample_index=sample_index,
            identity=identity,
            operator_input=operator_input,
            embedding=embedding,
        )
        if operator_diagnostics is None:
            gaps.append("native_input_diagnostics_not_published")
            # Keep the historical diagnostic for callers and reports that
            # predate the exact final-input sidecar.
            gaps.append("operator_diagnostics_exact_payload_not_published")
        else:
            # The final input JSON is now bound to its exact preimage and to
            # the external raw-byte reference.  Native matrix assembly and
            # solver residuals remain a separate, unresolved gate.
            native_input_diagnostics_verified = True
        gaps.append("native_actual_matrix_pencil_not_replayed")
    else:
        if not isinstance(operator_diagnostics, Mapping):
            _fail("operator_diagnostics: expected object")
        _validate_diagnostics(operator_diagnostics, embedding)
        gaps.append("operator_diagnostics_exact_digest_unbound")
        gaps.append("native_actual_matrix_pencil_not_replayed")
    if metrics["gyrotropic_skew_structure"] != "verified":
        gaps.append("direct_tangent_mass_not_symmetric")
    gaps.append("native_solver_residual_and_frequency_not_replayed")
    status = "operator_replayable" if not source_qualified else "operator_and_source_replayable"
    exact_refs_verified = ["source_state", "operator_input", "matrix_pencil"]
    if native_input_diagnostics_verified:
        exact_refs_verified.append("native_input_diagnostics")
    if mesh_payload_ref is not None:
        exact_refs_verified.append("mesh_payload")
    if physical_verified:
        exact_refs_verified.append("physical_source")
    return NonSharedOperatorReplayReport(
        status=status,
        scientific_qualification="NOT_VERIFIED",
        sample_index=sample_index,
        operator_identity_sha256=identity_digest,
        source_state_sha256=source_state_digest,
        operator_input_sha256=operator_digest,
        matrix_pencil_sha256=matrix_digest,
        dimension=dimension,
        embedding=embedding,
        gamma0_rad_s_per_A_m=gamma,
        alpha=alpha,
        k_vector_rad_m=k_vector,
        floquet_pair_count=pair_count,
        relation_metrics=metrics,
        exact_refs_verified=tuple(exact_refs_verified),
        source_replay_status=identity["source_replay_status"],
        gaps=tuple(gap for gap in gaps if gap),
    )


def _validate_diagnostics(diagnostics: Mapping[str, Any], embedding: str) -> None:
    expected_schema = "frequency_domain_operator_diagnostics.v1"
    if diagnostics.get("schema_version") != expected_schema:
        _fail("operator diagnostics: unsupported schema")
    if diagnostics.get("stiffness_units") != "rad_s_inv":
        _fail("operator diagnostics: stiffness_units is not rad_s_inv")
    expected_form = (
        "pencil_B=-G=[[0,M],[-M,0]]" if embedding == "direct_real_tangent"
        else "pencil_B=-G=[[0,-M],[M,0]]"
    )
    if diagnostics.get("gyrotropic_form") != expected_form:
        _fail("operator diagnostics: gyrotropic form mismatch")


def _validate_native_input_diagnostics_ref(
    ref: Any,
    *,
    expected_schema: str,
    expected_path: str,
    expected_raw: bytes,
    sample_index: int,
    label: str,
) -> None:
    _check_ref_shape(ref, label)
    if ref["schema_version"] != expected_schema:
        _fail(f"{label}: unsupported schema")
    if ref["path"] != expected_path:
        _fail(f"{label}: path is not the canonical sample path")
    if "sample_index" not in ref:
        _fail(f"{label}: sample_index is required")
    _integer(ref["sample_index"], f"{label}.sample_index")
    if ref["sample_index"] != sample_index:
        _fail(f"{label}: sample_index mismatch")
    if ref["byte_length"] != len(expected_raw):
        _fail(f"{label}: byte length does not describe exact sidecar")
    expected_raw_digest = raw_sha256(expected_raw)
    if ref["raw_sha256"] != expected_raw_digest:
        _fail(f"{label}: raw SHA-256 does not describe exact sidecar")
    if ref.get("semantic_signature") != expected_raw_digest:
        _fail(f"{label}: semantic signature does not describe exact sidecar")


def _solver_diagnostics_candidates(
    solver_payload: Mapping[str, Any], sample_index: int
) -> list[Mapping[str, Any]]:
    candidates: list[Mapping[str, Any]] = []

    def add_candidate(value: Any) -> None:
        if not isinstance(value, Mapping) or NATIVE_INPUT_DIAGNOSTICS_REFS_FIELD not in value:
            return
        refs = value[NATIVE_INPUT_DIAGNOSTICS_REFS_FIELD]
        if not isinstance(refs, Mapping):
            _fail("native input diagnostics external references: expected object")
        declared_sample = refs.get("sample_index")
        if type(declared_sample) is not int or declared_sample < 0:
            _fail(
                "native input diagnostics external references.sample_index: "
                "expected non-negative integer"
            )
        if declared_sample == sample_index:
            candidates.append(value)

    add_candidate(solver_payload)
    nested = solver_payload.get("solver_diagnostics")
    add_candidate(nested)
    for container in (solver_payload, nested):
        if not isinstance(container, Mapping):
            continue
        rows = container.get("sample_solver_diagnostics")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            if type(row.get("sample_index")) is int and row["sample_index"] == sample_index:
                add_candidate(row.get("diagnostics"))
    return candidates


def _validate_native_input_diagnostics_external_refs(
    root: Path,
    *,
    sample_index: int,
    final_path: str,
    preimage_path: str,
    final_raw: bytes,
    preimage_raw: bytes,
) -> None:
    solver_path = "eigen/diagnostics/solver.v1.json"
    solver_read = _read_optional_relative(root, solver_path, "solver diagnostics path")
    if solver_read is None:
        _fail("native input diagnostics: external raw reference is not published")
    solver_raw, _ = solver_read
    solver_payload = _json_object(solver_raw, "solver diagnostics")
    candidates = _solver_diagnostics_candidates(solver_payload, sample_index)
    if not candidates:
        _fail("native input diagnostics: external raw reference is not bound to sample")
    if len(candidates) > 1:
        first = candidates[0][NATIVE_INPUT_DIAGNOSTICS_REFS_FIELD]
        for candidate in candidates[1:]:
            _same_typed_json(
                first,
                candidate[NATIVE_INPUT_DIAGNOSTICS_REFS_FIELD],
                "native input diagnostics external reference duplicates",
            )
    refs = candidates[0][NATIVE_INPUT_DIAGNOSTICS_REFS_FIELD]
    if not isinstance(refs, Mapping):
        _fail("native input diagnostics external references: expected object")
    _fields(
        refs,
        frozenset({"schema_version", "sample_index", "payload", "preimage"}),
        "native input diagnostics external references",
    )
    if refs["schema_version"] != NATIVE_INPUT_DIAGNOSTICS_REFS_SCHEMA:
        _fail("native input diagnostics external references: unsupported schema")
    _integer(refs["sample_index"], "native input diagnostics external references.sample_index")
    if refs["sample_index"] != sample_index:
        _fail("native input diagnostics external references: sample_index mismatch")
    _validate_native_input_diagnostics_ref(
        refs["payload"],
        expected_schema=NATIVE_INPUT_DIAGNOSTICS_SCHEMA,
        expected_path=final_path,
        expected_raw=final_raw,
        sample_index=sample_index,
        label="native input diagnostics external payload",
    )
    _validate_native_input_diagnostics_ref(
        refs["preimage"],
        expected_schema=NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA,
        expected_path=preimage_path,
        expected_raw=preimage_raw,
        sample_index=sample_index,
        label="native input diagnostics external preimage",
    )


def _load_and_validate_native_input_diagnostics(
    root: Path,
    *,
    sample_index: int,
    identity: Mapping[str, Any],
    operator_input: Mapping[str, Any],
    embedding: str,
) -> dict[str, Any] | None:
    prefix = _sample_prefix(sample_index) + "nonshared_source/"
    final_path = prefix + NATIVE_INPUT_DIAGNOSTICS_FILENAME
    preimage_path = prefix + NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_FILENAME
    final_read = _read_optional_relative(root, final_path, "native input diagnostics path")
    if final_read is None:
        preimage_read = _read_optional_relative(
            root,
            preimage_path,
            "native input diagnostics preimage path",
        )
        if preimage_read is not None:
            _fail(
                "native input diagnostics: final payload is missing while its preimage is published"
            )
        solver_read = _read_optional_relative(
            root,
            "eigen/diagnostics/solver.v1.json",
            "solver diagnostics path",
        )
        if solver_read is not None:
            solver_payload = _json_object(solver_read[0], "solver diagnostics")
            if _solver_diagnostics_candidates(solver_payload, sample_index):
                _fail(
                    "native input diagnostics: final payload is missing while an external "
                    "reference is published"
                )
        return None
    final_raw, _ = final_read
    final = _json_object(final_raw, "native input diagnostics")
    _fields(
        final,
        frozenset(
            {
                "schema_version",
                "stiffness_units",
                "gyrotropic_form",
                "operator_diagnostics_sha256",
                "operator_diagnostics_schema",
                "nonshared_floquet_native_input_diagnostics_schema",
                "nonshared_floquet_native_input_diagnostics_sample_index",
                "nonshared_floquet_native_input_diagnostics_path",
                "nonshared_floquet_native_input_diagnostics_preimage_path",
                NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD,
                "nonshared_floquet_operator_identity_sha256",
                "nonshared_floquet_source_state_sha256",
                "nonshared_floquet_matrix_pencil_sha256",
                "nonshared_floquet_mesh_payload_sha256",
                "nonshared_floquet_exact_replay_refs",
                "nonshared_floquet_operator_identity",
            }
        ),
        "native input diagnostics",
    )
    if final["nonshared_floquet_native_input_diagnostics_schema"] != NATIVE_INPUT_DIAGNOSTICS_SCHEMA:
        _fail("native input diagnostics: unsupported sidecar schema")
    _integer(
        final["nonshared_floquet_native_input_diagnostics_sample_index"],
        "native input diagnostics.sample_index",
    )
    if final["nonshared_floquet_native_input_diagnostics_sample_index"] != sample_index:
        _fail("native input diagnostics: sample_index mismatch")
    if final["nonshared_floquet_native_input_diagnostics_path"] != final_path:
        _fail("native input diagnostics: final path mismatch")
    if final["nonshared_floquet_native_input_diagnostics_preimage_path"] != preimage_path:
        _fail("native input diagnostics: preimage path mismatch")
    preimage_digest = _digest(
        final[NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD],
        "native input diagnostics.preimage_sha256",
    )
    preimage_read = _read_relative(root, preimage_path, "native input diagnostics preimage path")
    preimage_raw, _ = preimage_read
    preimage = _json_object(preimage_raw, "native input diagnostics preimage")
    _same_typed_json(
        preimage,
        _replace_empty_digest(final, NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD, "native input diagnostics"),
        "native input diagnostics preimage",
    )
    if raw_sha256(preimage_raw) != preimage_digest:
        _fail("native input diagnostics: preimage raw SHA-256 mismatch")
    _validate_diagnostics(final, embedding)
    _digest(
        final["operator_diagnostics_sha256"],
        "native input diagnostics.operator_diagnostics_sha256",
    )
    if final["operator_diagnostics_schema"] != "frequency_domain_operator_diagnostics.v1":
        _fail("native input diagnostics: unsupported operator diagnostics schema")
    if final["operator_diagnostics_sha256"] != operator_input["operator_diagnostics_sha256"]:
        _fail("native input diagnostics: base diagnostics digest is not bound to operator input")
    if final["operator_diagnostics_schema"] != operator_input["operator_diagnostics_schema"]:
        _fail("native input diagnostics: base diagnostics schema is not bound to operator input")
    expected_bindings = {
        "nonshared_floquet_operator_identity_sha256": identity["content_sha256"],
        "nonshared_floquet_source_state_sha256": identity["source_state_sha256"],
        "nonshared_floquet_matrix_pencil_sha256": identity["matrix_pencil_sha256"],
        "nonshared_floquet_mesh_payload_sha256": identity["mesh_payload_sha256"],
    }
    for key, expected in expected_bindings.items():
        if final[key] != expected:
            _fail(f"native input diagnostics: {key} is not bound to identity")
    _same_typed_json(
        final["nonshared_floquet_exact_replay_refs"],
        identity["exact_replay_refs"],
        "native input diagnostics exact replay refs",
    )
    nested_identity = _mapping(
        final["nonshared_floquet_operator_identity"],
        "native input diagnostics.operator_identity",
    )
    nested_bindings = {
        "schema_version": identity["schema_version"],
        "content_sha256": identity["content_sha256"],
        "sample_index": sample_index,
        "operator_input_signature_sha256": identity["operator_input_signature_sha256"],
        "source_state_sha256": identity["source_state_sha256"],
        "matrix_pencil_sha256": identity["matrix_pencil_sha256"],
    }
    for key, expected in nested_bindings.items():
        if nested_identity.get(key) != expected:
            _fail(f"native input diagnostics: nested identity {key} is not bound")
    _validate_native_input_diagnostics_external_refs(
        root,
        sample_index=sample_index,
        final_path=final_path,
        preimage_path=preimage_path,
        final_raw=final_raw,
        preimage_raw=preimage_raw,
    )
    return final


def _cli() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--sample-index", type=int, default=0)
    args = parser.parse_args()
    try:
        report = replay_nonshared_operator(args.root, sample_index=args.sample_index)
    except NonSharedReplayError as error:
        print(json.dumps({"status": "rejected", "error": str(error)}, indent=2))
        return 2
    print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - command-line adapter
    raise SystemExit(_cli())
