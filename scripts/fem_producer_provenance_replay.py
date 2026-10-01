"""Fail-closed replay of a FEM relaxation producer provenance bundle.

The Rust producer publishes a provenance sidecar beside the three exact FEM
payloads.  This module is the source-bound Python adapter for that sidecar. It
never recreates the producer plan or payload bytes for hashing: the exact plan,
payloads, identity and m0 files are read from the supplied producer bundle.

The returned report is an interpreted artifact result.  It is useful for a
consumer verifier, but it does not certify native execution, device residency,
mesh convergence, modal residuals, or scientific agreement with COMSOL/TetraX.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
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
    from comsol_mesh_identity import mesh_topology_fingerprint_v3
    from fem_accepted_recomputed_replay import (
        AcceptedRecomputedReplayReport,
        ArtifactPaths,
        ReplaySourceContext,
        SCIENTIFIC_QUALIFICATION_NOT_VERIFIED,
        load_json_artifact,
        replay_artifact_paths,
    )
    from fem_equilibrium_field_replay import ValidationError
    from fem_equilibrium_identity_replay import (
        replay_equilibrium_identity_preimages,
    )
    from fem_linearization_identity_replay import (
        IDENTITY_FIELDS,
        IdentityReplayError,
        replay_identity_preimage,
        strict_json_object,
    )
except ModuleNotFoundError:  # pragma: no cover - package import fallback
    from scripts.comsol_mesh_identity import mesh_topology_fingerprint_v3
    from scripts.fem_accepted_recomputed_replay import (
        AcceptedRecomputedReplayReport,
        ArtifactPaths,
        ReplaySourceContext,
        SCIENTIFIC_QUALIFICATION_NOT_VERIFIED,
        load_json_artifact,
        replay_artifact_paths,
    )
    from scripts.fem_equilibrium_field_replay import ValidationError
    from scripts.fem_equilibrium_identity_replay import (
        replay_equilibrium_identity_preimages,
    )
    from scripts.fem_linearization_identity_replay import (
        IDENTITY_FIELDS,
        IdentityReplayError,
        replay_identity_preimage,
        strict_json_object,
    )


PROVENANCE_SCHEMA = "fem_relaxation_producer_provenance.v1"
PLAN_NAMESPACE = "fem_relaxation.producer_plan.v1"
PLAN_ENCODING = "utf-8-json-bytes"
CROSS_BUILD_POLICY = "same_source_snapshot_required"
ACCEPTED_V1_PATH = "equilibrium/accepted_fem_equilibrium_fields.v1.json"
ACCEPTED_V2_PATH = "equilibrium/accepted_fem_equilibrium_fields.v2.json"
CERTIFIED_V1_PATH = "equilibrium/certified_fem_equilibrium_fields.v1.json"
CERTIFIED_V2_PATH = "equilibrium/certified_fem_equilibrium_fields.v2.json"
CERTIFICATE_V1_PATH = "equilibrium/recomputed_fem_linearization_certificate.v1.json"
CERTIFICATE_V2_PATH = "equilibrium/recomputed_fem_linearization_certificate.v2.json"
SOURCE_REPLAY_QUALIFIED = "qualified_payload_replay"
SOURCE_REPLAY_REJECTED = "rejected"

_SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_RAW_SOURCE_SNAPSHOT_RE = re.compile(r"[0-9a-f]{64}\Z")
_PROVENANCE_FIELDS = frozenset(
    {
        "schema_version",
        "source_run_id",
        "source_stage_id",
        "source_stage_kind",
        "producer_build_identity",
        "producer_plan_snapshot",
        "source_mesh_topology_sha256",
        "equilibrium_content_sha256",
        "equilibrium_material_signature",
        "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature",
        "payloads",
        "cross_build_policy",
    }
)
_BUILD_FIELDS = frozenset(
    {"built_at_utc", "git_commit", "worktree_state", "source_snapshot_sha256"}
)
_PLAN_FIELDS = frozenset(
    {"namespace", "encoding", "preimage_json", "raw_sha256", "framed_sha256"}
)
_PAYLOADS_FIELDS = frozenset(
    {"accepted_fields", "certified_fields", "recomputed_certificate"}
)
_PAYLOAD_REF_FIELDS = frozenset(
    {"path", "schema_version", "raw_bytes_sha256", "content_sha256"}
)

_REQUIRED_PLAN_FIELDS = frozenset(
    {
        "mesh",
        "material",
        "initial_magnetization",
        "enable_exchange",
        "enable_demag",
        "exchange_bc",
    }
)
_OPTIONAL_SOURCE_PHYSICS_FIELDS = (
    "anisotropy_axis_field",
    "ms_element_field",
    "a_element_field",
    "region_materials",
    "interfacial_dmi",
    "rotated_interfacial_dmi",
    "dmi_interface_normal",
    "bulk_dmi",
    "dind_field",
    "dbulk_field",
    "antenna_zeeman_masks",
    "field_drives",
    "field_drive_geometry_masks",
    "current_modules",
    "spin_transport_plans",
    "current_density",
    "spin_torque_contract",
    "stt_degree",
    "stt_beta",
    "stt_spin_polarization",
    "stt_lambda",
    "stt_epsilon_prime",
    "stt_thickness",
    "stt_fixed_layer_position",
    "has_oersted_cylinder",
    "oersted_current",
    "oersted_radius",
    "oersted_center",
    "oersted_axis",
    "oersted_field_xyz",
    "oersted_realization",
    "temperature",
    "thermal_seed_config",
    "mechanics",
)
_UNSUPPORTED_MATERIAL_FIELDS = (
    "uniaxial_anisotropy_k2",
    "cubic_anisotropy_kc1",
    "cubic_anisotropy_kc2",
    "cubic_anisotropy_kc3",
    "cubic_anisotropy_axis1",
    "cubic_anisotropy_axis2",
    "ku_field",
    "ku2_field",
    "kc1_field",
    "kc2_field",
    "kc3_field",
    "interfacial_dmi",
    "bulk_dmi",
    "dind_field",
    "dbulk_field",
)


class ProducerProvenanceReplayError(ValidationError):
    """The producer bundle is incomplete, corrupt, foreign, or inconsistent."""


@dataclass(frozen=True)
class ProducerArtifactPaths:
    """Exact files belonging to one producer bundle.

    ``producer_root`` is only a resolver root for the relative payload paths
    published by the Rust sidecar.  The m0 is explicit because the current
    producer writes it as a certified equilibrium artifact (or a field file);
    neither can be guessed safely. ``producer_plan_path`` may be omitted when
    a modal bundle carries the exact plan only inline in
    ``producer_plan_snapshot.preimage_json``. ``payload_paths`` may point at
    consumer-copied sample files; their original producer-relative names stay
    immutable in the provenance refs. ``source_mesh_path`` is optional because
    the canonical mesh is already part of the exact plan preimage. When
    supplied, it must be byte-level JSON equivalent to that plan mesh.
    """

    producer_root: Path
    provenance_path: Path
    equilibrium_magnetization_path: Path
    identity_path: Path
    identity_preimage_path: Path
    producer_plan_path: Path | None = None
    source_mesh_path: Path | None = None
    payload_paths: Mapping[str, Path] | None = None


@dataclass(frozen=True)
class ProducerReplayReport:
    """Evidence returned only after all source-bound checks pass."""

    status: str
    scientific_qualification: str
    source_context: ReplaySourceContext
    source_run_id: str
    source_stage_id: str
    source_stage_kind: str
    producer_source_snapshot_sha256: str
    plan_raw_sha256: str
    plan_framed_sha256: str
    identity_content_sha256: str
    sidecar_raw_sha256: str
    payload_raw_sha256_by_name: Mapping[str, str]
    source_paths: Mapping[str, str]
    payload_report: AcceptedRecomputedReplayReport
    limitations: tuple[str, ...]


def _fail(message: str) -> None:
    raise ProducerProvenanceReplayError(message)


def _exact_fields(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    actual = frozenset(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    if missing or unknown:
        details = []
        if missing:
            details.append("missing=" + ",".join(missing))
        if unknown:
            details.append("unknown=" + ",".join(unknown))
        _fail(f"{label}: invalid field set ({'; '.join(details)})")


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label}: expected JSON object")
    return value


def _nonempty_string(value: Any, label: str) -> str:
    if type(value) is not str or not value.strip():
        _fail(f"{label}: expected non-empty string")
    return value


def _digest(value: Any, label: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        _fail(f"{label}: expected sha256:<64 lowercase hex>")
    return value


def _source_snapshot(value: Any, label: str) -> str:
    """Validate native build-info's raw lowercase SHA-256 spelling."""
    if type(value) is not str or _RAW_SOURCE_SNAPSHOT_RE.fullmatch(value) is None:
        _fail(
            f"{label}: expected 64 lowercase hexadecimal characters without sha256: prefix"
        )
    return value


def _sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _framed_sha256(namespace: str, raw: bytes) -> str:
    if type(namespace) is not str or not namespace:
        _fail("plan namespace must be a non-empty string")
    framed = namespace.encode("utf-8") + b"\0" + struct.pack("<Q", len(raw)) + raw
    return _sha256(framed)


def _read_bytes(path: Path, label: str) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise ProducerProvenanceReplayError(
            f"cannot read {label} at {path}: {error}"
        ) from error


def _load_object(path: Path, label: str) -> tuple[Mapping[str, Any], bytes]:
    raw = _read_bytes(path, label)
    try:
        value = strict_json_object(raw, label)
    except IdentityReplayError as error:
        raise ProducerProvenanceReplayError(str(error)) from error
    return value, raw


def _same_json(left: Any, right: Any, label: str) -> None:
    """Compare parsed JSON without Python bool/number coercion."""

    if type(left) is not type(right):
        raise ProducerProvenanceReplayError(f"{label}: JSON type mismatch")
    if isinstance(left, Mapping):
        if left.keys() != right.keys():
            raise ProducerProvenanceReplayError(f"{label}: JSON field set mismatch")
        for key in left:
            _same_json(left[key], right[key], f"{label}.{key}")
    elif isinstance(left, list):
        if len(left) != len(right):
            raise ProducerProvenanceReplayError(f"{label}: JSON array length mismatch")
        for index, (a, b) in enumerate(zip(left, right)):
            _same_json(a, b, f"{label}[{index}]")
    elif left != right:
        raise ProducerProvenanceReplayError(f"{label}: JSON value mismatch")


def _relative_payload_path(root: Path, value: Any, label: str) -> Path:
    relative = _nonempty_string(value, f"{label}.path")
    if relative.startswith(("/", "\\")) or ":" in relative:
        _fail(f"{label}.path: absolute or drive-qualified path is forbidden")
    parts = [part for part in re.split(r"[/\\]", relative) if part]
    if any(part in {".", ".."} for part in parts):
        _fail(f"{label}.path: traversal component is forbidden")
    candidate = (root.joinpath(*parts)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise ProducerProvenanceReplayError(
            f"{label}.path: resolved path escapes producer root"
        ) from error
    return candidate


def _validate_payload_ref(
    ref: Mapping[str, Any],
    label: str,
    root: Path,
    expected_path: str,
) -> tuple[Path, str, str]:
    _exact_fields(ref, _PAYLOAD_REF_FIELDS, label)
    path = _nonempty_string(ref["path"], f"{label}.path")
    if path != expected_path:
        _fail(f"{label}.path: expected {expected_path!r}, got {path!r}")
    resolved = _relative_payload_path(root, path, label)
    schema = _nonempty_string(ref["schema_version"], f"{label}.schema_version")
    raw_digest = _digest(ref["raw_bytes_sha256"], f"{label}.raw_bytes_sha256")
    content_digest = _digest(ref["content_sha256"], f"{label}.content_sha256")
    return resolved, raw_digest, content_digest


def _identity_path(value: Any, label: str, expected_name: str) -> str:
    """Validate a relative identity path and bind its leaf to the payload."""

    path = _nonempty_string(value, label)
    if path.startswith(("/", "\\")) or ":" in path:
        _fail(f"{label}: absolute or drive-qualified path is forbidden")
    parts = [part for part in re.split(r"[/\\]", path) if part]
    if any(part in {".", ".."} for part in parts):
        _fail(f"{label}: traversal component is forbidden")
    if not parts or parts[-1] != expected_name:
        _fail(f"{label}: payload leaf does not match {expected_name!r}")
    return path


def _identity_build_identity(value: Any, label: str) -> Mapping[str, Any]:
    build = _mapping(value, label)
    _exact_fields(build, _BUILD_FIELDS, label)
    for key in ("built_at_utc", "git_commit", "worktree_state"):
        _nonempty_string(build[key], f"{label}.{key}")
    _source_snapshot(build["source_snapshot_sha256"], f"{label}.source_snapshot_sha256")
    return build


def _identity_preimage_object(value: Any, label: str) -> tuple[Mapping[str, Any], bytes]:
    text = _nonempty_string(value, label)
    try:
        raw = text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ProducerProvenanceReplayError(f"{label}: invalid UTF-8") from error
    try:
        return strict_json_object(raw, label), raw
    except IdentityReplayError as error:
        raise ProducerProvenanceReplayError(str(error)) from error


def _validate_identity_source_bindings(
    identity: Mapping[str, Any],
    *,
    provenance: Mapping[str, Any],
    build: Mapping[str, Any],
    plan_snapshot: Mapping[str, Any],
    material: Mapping[str, Any],
    node_count: int,
    equilibrium_content_sha256: str,
    equilibrium_artifact_schema: str | None,
    payload_refs: Mapping[str, Mapping[str, Any]],
    payload_values: Mapping[str, Mapping[str, Any]],
    payload_paths: Mapping[str, Path],
    payload_raw_sha256: Mapping[str, str],
) -> None:
    """Bind identity semantics to the already validated source bundle.

    ``replay_identity_preimage`` proves only exact identity bytes and their
    own digest. This second gate prevents a self-consistent foreign identity
    from being accepted beside an otherwise valid producer bundle.
    """

    def equal(name: str, expected: Any) -> None:
        actual = identity.get(name)
        if actual != expected:
            _fail(f"linearization identity {name} does not match producer provenance")

    def digest(name: str) -> str:
        return _digest(identity.get(name), f"linearization identity.{name}")

    equal("source_run_id", provenance["source_run_id"])
    equal("source_stage_id", provenance["source_stage_id"])
    equal("source_stage_kind", provenance["source_stage_kind"])
    equal("producer_plan_snapshot_sha256", plan_snapshot["framed_sha256"])
    _source_snapshot(
        identity.get("producer_source_snapshot_sha256"),
        "linearization identity.producer_source_snapshot_sha256",
    )
    equal("producer_source_snapshot_sha256", build["source_snapshot_sha256"])
    equal("cross_build_policy", provenance["cross_build_policy"])
    equal("source_mesh_topology_sha256", provenance["source_mesh_topology_sha256"])
    equal("equilibrium_content_sha256", equilibrium_content_sha256)

    producer_build = _identity_build_identity(
        identity.get("producer_build_identity"),
        "linearization identity.producer_build_identity",
    )
    _same_json(
        producer_build,
        build,
        "linearization identity.producer_build_identity vs producer provenance",
    )
    consumer_build = _identity_build_identity(
        identity.get("consumer_build_identity"),
        "linearization identity.consumer_build_identity",
    )
    _source_snapshot(
        identity.get("consumer_source_snapshot_sha256"),
        "linearization identity.consumer_source_snapshot_sha256",
    )
    equal("consumer_source_snapshot_sha256", consumer_build["source_snapshot_sha256"])
    if consumer_build["source_snapshot_sha256"] != build["source_snapshot_sha256"]:
        _fail("linearization identity consumer source snapshot violates cross-build policy")

    node_value = identity.get("node_count")
    if type(node_value) is not int or node_value <= 0 or node_value != node_count:
        _fail("linearization identity.node_count does not match source mesh/m0")

    v2 = material.get("uniaxial_anisotropy") is not None
    expected_family = (
        "equilibrium_artifact.v8",
        "LinearizationState.v7",
        "CertifiedFemEquilibriumFields.v2",
        "RecomputedFemLinearizationCertificate.v2",
        "canonical_equilibrium_material.v2",
    ) if v2 else (
        "equilibrium_artifact.v7",
        "LinearizationState.v6",
        "CertifiedFemEquilibriumFields.v1",
        "RecomputedFemLinearizationCertificate.v1",
        "raw_material.v1",
    )
    for name, expected in zip(
        (
            "equilibrium_artifact_schema",
            "linearization_state_schema",
            "accepted_fields_schema",
            "recomputed_certificate_schema",
            "material_identity_kind",
        ),
        expected_family,
    ):
        equal(name, expected)
    equal("certified_fields_schema", expected_family[2])
    if equilibrium_artifact_schema is not None and equilibrium_artifact_schema != expected_family[0]:
        _fail("equilibrium artifact schema does not match linearization identity family")
    if identity.get("handoff_schema_version") not in {
        "AcceptedFemRelaxStageHandoff.v2",
        "AcceptedFemRelaxStageHandoff.v3",
    }:
        _fail("linearization identity.handoff_schema_version is unsupported")

    for name in (
        "handoff_content_sha256",
        "modal_mesh_topology_fingerprint_v3",
        "equilibrium_artifact_sha256",
        "linearization_state_sha256",
        "equilibrium_material_signature",
        "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature",
        "material_signature",
        "material_provenance_signature",
        "producer_material_provenance_signature",
        "consumer_plan_snapshot_sha256",
        "accepted_fields_content_sha256",
        "certified_fields_content_sha256",
        "recomputed_certificate_content_sha256",
        "accepted_fields_bytes_sha256",
        "certified_fields_bytes_sha256",
        "recomputed_certificate_bytes_sha256",
        "recomputed_certificate_preimage_sha256",
    ):
        digest(name)
    equal("equilibrium_material_signature", provenance["equilibrium_material_signature"])
    equal("equilibrium_static_physics_signature", provenance["equilibrium_static_physics_signature"])
    equal("equilibrium_boundary_signature", provenance["equilibrium_boundary_signature"])

    if identity.get("material_provenance_scope") != "materialization_plan":
        _fail("linearization identity.material_provenance_scope is unsupported")
    producer_material, producer_material_raw = _identity_preimage_object(
        identity.get("producer_material_provenance_preimage_json"),
        "linearization identity.producer_material_provenance_preimage_json",
    )
    _same_json(
        producer_material,
        material,
        "linearization identity producer material preimage vs source plan",
    )
    if _sha256(producer_material_raw) != identity["producer_material_provenance_signature"]:
        _fail("linearization identity producer material provenance digest mismatch")
    _, consumer_material_raw = _identity_preimage_object(
        identity.get("material_provenance_preimage_json"),
        "linearization identity.material_provenance_preimage_json",
    )
    if _sha256(consumer_material_raw) != identity["material_provenance_signature"]:
        _fail("linearization identity material provenance digest mismatch")

    expected_payload_identity_fields = {
        "accepted_fields": (
            "accepted_fields_schema",
            "accepted_fields_content_sha256",
            "accepted_fields_bytes_sha256",
            "accepted_fields_path",
        ),
        "certified_fields": (
            "certified_fields_schema",
            "certified_fields_content_sha256",
            "certified_fields_bytes_sha256",
            "certified_fields_path",
        ),
        "recomputed_certificate": (
            "recomputed_certificate_schema",
            "recomputed_certificate_content_sha256",
            "recomputed_certificate_bytes_sha256",
            "recomputed_certificate_path",
        ),
    }
    for name, (schema_field, content_field, bytes_field, path_field) in expected_payload_identity_fields.items():
        ref = payload_refs[name]
        payload = payload_values[name]
        actual_path = payload_paths[name]
        if ref["schema_version"] != payload.get("schema_version"):
            _fail(f"producer provenance {name} schema does not match payload bytes")
        equal(schema_field, payload["schema_version"])
        equal(content_field, payload["content_sha256"])
        equal(bytes_field, payload_raw_sha256[name])
        _identity_path(identity.get(path_field), f"linearization identity.{path_field}", actual_path.name)

    certificate_preimage, certificate_preimage_raw = _identity_preimage_object(
        identity.get("recomputed_certificate_preimage_json"),
        "linearization identity.recomputed_certificate_preimage_json",
    )
    if _sha256(certificate_preimage_raw) != identity["recomputed_certificate_preimage_sha256"]:
        _fail("linearization identity certificate preimage digest mismatch")
    if certificate_preimage.get("schema_version") != payload_values["recomputed_certificate"].get("schema_version"):
        _fail("linearization identity certificate preimage schema mismatch")


def _validate_provenance(
    value: Mapping[str, Any],
    *,
    expected_source_run_id: str,
    expected_source_stage_id: str,
    expected_source_stage_kind: str,
    expected_source_snapshot_sha256: str,
) -> tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    _exact_fields(value, _PROVENANCE_FIELDS, "producer provenance")
    if value["schema_version"] != PROVENANCE_SCHEMA:
        _fail("producer provenance.schema_version is unsupported")
    for name, expected in (
        ("source_run_id", expected_source_run_id),
        ("source_stage_id", expected_source_stage_id),
        ("source_stage_kind", expected_source_stage_kind),
    ):
        actual = _nonempty_string(value[name], f"producer provenance.{name}")
        if type(expected) is not str or not expected.strip() or actual != expected:
            _fail(f"producer provenance.{name} does not match expected source identity")
    if value["cross_build_policy"] != CROSS_BUILD_POLICY:
        _fail("producer provenance.cross_build_policy is unsupported")

    build = _mapping(value["producer_build_identity"], "producer_build_identity")
    _exact_fields(build, _BUILD_FIELDS, "producer_build_identity")
    for key in ("built_at_utc", "git_commit", "worktree_state"):
        _nonempty_string(build[key], f"producer_build_identity.{key}")
    producer_snapshot = _source_snapshot(
        build["source_snapshot_sha256"],
        "producer_build_identity.source_snapshot_sha256",
    )
    expected_snapshot = _source_snapshot(
        expected_source_snapshot_sha256,
        "expected_source_snapshot_sha256",
    )
    if producer_snapshot != expected_snapshot:
        _fail("producer build source snapshot does not match consumer expectation")

    plan = _mapping(value["producer_plan_snapshot"], "producer_plan_snapshot")
    _exact_fields(plan, _PLAN_FIELDS, "producer_plan_snapshot")
    if plan["namespace"] != PLAN_NAMESPACE or plan["encoding"] != PLAN_ENCODING:
        _fail("producer plan namespace or encoding is unsupported")
    preimage = plan["preimage_json"]
    if type(preimage) is not str:
        _fail("producer plan preimage_json must be a string")
    try:
        plan_bytes = preimage.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ProducerProvenanceReplayError(
            "producer plan preimage_json is not valid UTF-8"
        ) from error
    _digest(plan["raw_sha256"], "producer_plan_snapshot.raw_sha256")
    _digest(plan["framed_sha256"], "producer_plan_snapshot.framed_sha256")
    if plan["raw_sha256"] != _sha256(plan_bytes):
        _fail("producer plan raw digest does not match preimage bytes")
    if plan["framed_sha256"] != _framed_sha256(PLAN_NAMESPACE, plan_bytes):
        _fail("producer plan framed digest does not match preimage bytes")

    payloads = _mapping(value["payloads"], "producer provenance.payloads")
    _exact_fields(payloads, _PAYLOADS_FIELDS, "producer provenance.payloads")
    return build, plan, payloads, value


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        _fail(f"{label} must be a finite number")
    return result


def _optional_source_value(value: Any, label: str) -> None:
    if value is None:
        return
    if isinstance(value, list) and not value:
        # Vec fields with an empty list are still Some in the Rust source
        # contract; callers must not use an empty list to hide unsupported
        # physics.  This branch intentionally rejects it below.
        _fail(f"{label} is present but unsupported")
    _fail(f"{label} is present but unsupported")


def _validate_material_projection(material: Mapping[str, Any]) -> str:
    _nonempty_string(material.get("name"), "source plan.material.name")
    for key in ("saturation_magnetisation", "exchange_stiffness", "damping"):
        _finite_number(material.get(key), f"source plan.material.{key}")
    for key in _UNSUPPORTED_MATERIAL_FIELDS:
        if key in material and material[key] is not None:
            _fail(f"source plan.material.{key} is outside the producer identity scope")
    if "uniaxial_anisotropy" not in material:
        _fail("source plan.material.uniaxial_anisotropy is missing")
    ku = material["uniaxial_anisotropy"]
    if ku is None:
        if material.get("anisotropy_axis") is not None:
            _fail("source plan.material.anisotropy_axis requires constant Ku")
        return "v1"
    _finite_number(ku, "source plan.material.uniaxial_anisotropy")
    axis = material.get("anisotropy_axis")
    if axis is not None:
        if type(axis) is not list or len(axis) != 3:
            _fail("source plan.material.anisotropy_axis must be a vector3")
        for index, component in enumerate(axis):
            _finite_number(component, f"source plan.material.anisotropy_axis[{index}]")
    return "v2"


def _validate_supported_plan(plan: Mapping[str, Any]) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    missing = sorted(_REQUIRED_PLAN_FIELDS - frozenset(plan))
    if missing:
        _fail("producer plan is not a FEM relaxation plan; missing " + ",".join(missing))
    mesh = _mapping(plan["mesh"], "source plan.mesh")
    material = _mapping(plan["material"], "source plan.material")
    family = _validate_material_projection(material)
    nodes = mesh.get("nodes")
    initial = plan["initial_magnetization"]
    if type(nodes) is not list or not nodes:
        _fail("source plan.mesh.nodes must be a non-empty array")
    if type(initial) is not list or len(initial) != len(nodes):
        _fail("source plan.initial_magnetization must match source mesh node count")
    for node, vector in enumerate(initial):
        if type(vector) is not list or len(vector) != 3:
            _fail(f"source plan.initial_magnetization[{node}] must be a vector3")
        for component, number in enumerate(vector):
            _finite_number(number, f"source plan.initial_magnetization[{node}][{component}]")
    for key in _OPTIONAL_SOURCE_PHYSICS_FIELDS:
        if key == "has_oersted_cylinder":
            if plan.get(key) is True:
                _fail(f"source plan.{key} is outside the certified relaxation scope")
            continue
        if key in plan and plan[key] is not None:
            if isinstance(plan[key], list) and not plan[key]:
                _fail(f"source plan.{key} is present but unsupported")
            _fail(f"source plan.{key} is outside the certified relaxation scope")
    for key in ("enable_exchange", "enable_demag"):
        if type(plan[key]) is not bool:
            _fail(f"source plan.{key} must be a JSON boolean")
    if type(plan["exchange_bc"]) is not str:
        _fail("source plan.exchange_bc must be a JSON string")
    if "external_field" in plan and plan["external_field"] is not None:
        field = plan["external_field"]
        if type(field) is not list or len(field) != 3:
            _fail("source plan.external_field must be null or a vector3")
        for index, component in enumerate(field):
            _finite_number(component, f"source plan.external_field[{index}]")
    if "demag_realization" not in plan:
        plan_demag = None
    else:
        plan_demag = plan["demag_realization"]
    if "air_box_config" not in plan:
        plan_airbox = None
    else:
        plan_airbox = plan["air_box_config"]
    if plan_demag is None and plan.get("enable_demag"):
        # The Rust identity still serializes an Option::None, so this is a
        # valid source projection.  No fallback demag model is invented here.
        pass
    _ = family, plan_airbox
    return mesh, material


def _mesh_for_producer_fingerprint(
    plan: Mapping[str, Any], mesh: Mapping[str, Any]
) -> Mapping[str, Any]:
    """Mirror the Rust ``FemMeshPayload`` marker normalization exactly.

    ``FemRelaxationProducerProvenance`` fingerprints the payload produced by
    ``FemMeshPayload::from_fem_plan_with_generation``. That payload maps
    homogeneous markers to magnetic ``1`` and mixed air/magnetic markers to
    ``0/1`` before hashing. The source plan itself is retained unchanged in
    the exact preimage, so this shallow copy is only for the fingerprint.
    """

    markers = mesh.get("element_markers")
    if type(markers) is not list:
        _fail("source plan.mesh.element_markers must be an array")
    for index, marker in enumerate(markers):
        if isinstance(marker, bool) or not isinstance(marker, int) or marker < 0:
            _fail(f"source plan.mesh.element_markers[{index}] must be a non-negative integer")
    regions = plan.get("region_materials", [])
    if type(regions) is not list:
        _fail("source plan.region_materials must be an array")
    if regions:
        magnetic_markers: set[int] = set()
        for index, region in enumerate(regions):
            region_object = _mapping(region, f"source plan.region_materials[{index}]")
            marker = region_object.get("element_marker")
            if isinstance(marker, bool) or not isinstance(marker, int) or marker < 0:
                _fail(
                    f"source plan.region_materials[{index}].element_marker must be a non-negative integer"
                )
            magnetic_markers.add(marker)
        normalized_markers = [int(marker in magnetic_markers) for marker in markers]
    elif not markers:
        normalized_markers = []
    elif 0 in markers and any(marker != 0 for marker in markers):
        normalized_markers = [int(marker != 0) for marker in markers]
    elif all(marker == markers[0] for marker in markers):
        normalized_markers = [1] * len(markers)
    else:
        normalized_markers = list(markers)
    fingerprint_mesh = dict(mesh)
    fingerprint_mesh["element_markers"] = normalized_markers
    return fingerprint_mesh


def _canonical_axis(material: Mapping[str, Any]) -> list[float]:
    axis = material.get("anisotropy_axis")
    if axis is None:
        axis = [0.0, 0.0, 1.0]
    scale = max(abs(float(value)) for value in axis)
    if scale == 0.0:
        _fail("source plan.material.anisotropy_axis must be non-zero")
    scaled = [float(value) / scale for value in axis]
    norm = math.hypot(math.hypot(scaled[0], scaled[1]), scaled[2])
    first = next((value for value in scaled if value != 0.0), None)
    if first is None or norm == 0.0:
        _fail("source plan.material.anisotropy_axis must be finite and non-zero")
    orientation = 1.0 if first > 0.0 else -1.0
    result = [orientation * value / norm for value in scaled]
    return [0.0 if value == 0.0 else value for value in result]


def _load_m0(path: Path) -> tuple[list[list[float]], bytes, str | None]:
    value, raw = _load_object(path, "equilibrium magnetization artifact")
    artifact_schema: str | None = None
    if "m0" in value:
        schema = value.get("schema_version")
        if schema not in {"equilibrium_artifact.v7", "equilibrium_artifact.v8"}:
            _fail("equilibrium artifact m0 must use schema equilibrium_artifact.v7 or .v8")
        if value.get("accepted_for_linearization") is not True:
            _fail("equilibrium artifact m0 is not accepted_for_linearization")
        artifact_schema = schema
        vectors = value["m0"]
    else:
        # ``m_final.json`` is retained as a source-compatible producer field
        # file.  A modal bundle should prefer the certified artifact branch
        # above; this branch does not guess an artifact from the plan.
        vectors = value.get("values")
    if not isinstance(vectors, list):
        _fail("equilibrium magnetization artifact.values must be an array")
    result: list[list[float]] = []
    for node, vector in enumerate(vectors):
        if type(vector) is not list or len(vector) != 3:
            _fail(f"equilibrium magnetization values[{node}] must be a vector3")
        converted: list[float] = []
        for component, number in enumerate(vector):
            converted.append(_finite_number(number, f"equilibrium magnetization values[{node}][{component}]"))
        result.append(converted)
    if not result:
        _fail("equilibrium magnetization artifact must contain at least one vector")
    return result, raw, artifact_schema


def replay_producer_provenance(
    paths: ProducerArtifactPaths,
    *,
    expected_source_run_id: str,
    expected_source_stage_id: str,
    expected_source_stage_kind: str,
    expected_source_snapshot_sha256: str,
) -> ProducerReplayReport:
    """Replay one real FEM producer bundle and return a source-bound context.

    All identity and payload paths are explicit.  A missing/corrupt/foreign
    file raises ``ProducerProvenanceReplayError``; no partial context is
    returned.  The caller must supply the consumer's expected source snapshot
    explicitly, which prevents silently replacing producer provenance with the
    current process identity.
    """

    if not isinstance(paths, ProducerArtifactPaths):
        _fail("paths must be a ProducerArtifactPaths")
    root = Path(paths.producer_root)
    if not root.is_absolute():
        _fail("producer_root must be an absolute path")
    if not isinstance(expected_source_run_id, str) or not expected_source_run_id.strip():
        _fail("expected_source_run_id must be non-empty")
    if not isinstance(expected_source_stage_id, str) or not expected_source_stage_id.strip():
        _fail("expected_source_stage_id must be non-empty")
    if not isinstance(expected_source_stage_kind, str) or not expected_source_stage_kind.strip():
        _fail("expected_source_stage_kind must be non-empty")
    expected_snapshot = _source_snapshot(
        expected_source_snapshot_sha256,
        "expected_source_snapshot_sha256",
    )

    provenance, provenance_raw = _load_object(paths.provenance_path, "producer provenance sidecar")
    build, plan_snapshot, payloads, _ = _validate_provenance(
        provenance,
        expected_source_run_id=expected_source_run_id,
        expected_source_stage_id=expected_source_stage_id,
        expected_source_stage_kind=expected_source_stage_kind,
        expected_source_snapshot_sha256=expected_snapshot,
    )
    expected_plan_raw = plan_snapshot["preimage_json"].encode("utf-8")
    if paths.producer_plan_path is None:
        plan_raw = expected_plan_raw
    else:
        plan_raw = _read_bytes(paths.producer_plan_path, "producer plan exact bytes")
        if plan_raw != expected_plan_raw:
            _fail("producer plan file bytes do not match producer_plan_snapshot.preimage_json")
    try:
        plan = strict_json_object(plan_raw, "producer plan")
    except IdentityReplayError as error:
        raise ProducerProvenanceReplayError(str(error)) from error
    mesh, material = _validate_supported_plan(plan)
    fingerprint_mesh = _mesh_for_producer_fingerprint(plan, mesh)
    try:
        mesh_digest = mesh_topology_fingerprint_v3(fingerprint_mesh)
    except (TypeError, ValueError, OverflowError, UnicodeError) as error:
        raise ProducerProvenanceReplayError(f"source plan mesh replay failed: {error}") from error
    if mesh_digest != provenance["source_mesh_topology_sha256"]:
        _fail("producer provenance source mesh digest does not match the source plan mesh")

    if paths.source_mesh_path is not None:
        external_mesh, _ = _load_object(paths.source_mesh_path, "source mesh artifact")
        _same_json(external_mesh, mesh, "source mesh artifact vs producer plan mesh")

    m0, m0_raw, equilibrium_artifact_schema = _load_m0(paths.equilibrium_magnetization_path)
    node_count = len(mesh.get("nodes", []))
    if node_count <= 0 or len(m0) != node_count:
        _fail("source mesh node count and equilibrium magnetization length differ")
    source_context_placeholder = ReplaySourceContext(
        node_count=node_count,
        material=material,
        equilibrium_magnetization=m0,
        mesh_topology_sha256=mesh_digest,
        equilibrium_material_signature=provenance["equilibrium_material_signature"],
        equilibrium_static_physics_signature=provenance["equilibrium_static_physics_signature"],
        equilibrium_boundary_signature=provenance["equilibrium_boundary_signature"],
        mesh=fingerprint_mesh,
    )

    identity_raw = _read_bytes(paths.identity_path, "linearization identity")
    identity_preimage_raw = _read_bytes(paths.identity_preimage_path, "linearization identity preimage sidecar")
    try:
        identity_content_sha256 = replay_identity_preimage(identity_raw, identity_preimage_raw)
    except IdentityReplayError as error:
        raise ProducerProvenanceReplayError(f"full identity replay failed: {error}") from error
    try:
        identity = strict_json_object(identity_raw, "linearization identity")
    except IdentityReplayError as error:
        raise ProducerProvenanceReplayError(str(error)) from error
    # The full replay above checks this set; retaining this assertion makes the
    # source adapter fail closed if a future helper changes its coverage.
    if frozenset(identity) != IDENTITY_FIELDS:
        _fail("linearization identity does not contain the full v2 field set")
    physical_signatures = _validate_physical_preimages_from_exact_bytes(
        identity_raw, plan, material
    )
    for key in (
        "equilibrium_material_signature",
        "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature",
    ):
        if provenance[key] != physical_signatures[key]:
            _fail(f"producer provenance {key} does not match source identity preimage")
    if provenance["equilibrium_content_sha256"] != _m0_content_digest(m0):
        _fail("producer provenance equilibrium_content_sha256 does not match source m0")

    expected_paths = (
        ("accepted_fields", ACCEPTED_V2_PATH if material.get("uniaxial_anisotropy") is not None else ACCEPTED_V1_PATH),
        ("certified_fields", CERTIFIED_V2_PATH if material.get("uniaxial_anisotropy") is not None else CERTIFIED_V1_PATH),
        ("recomputed_certificate", CERTIFICATE_V2_PATH if material.get("uniaxial_anisotropy") is not None else CERTIFICATE_V1_PATH),
    )
    resolved_payloads: dict[str, Path] = {}
    payload_digests: dict[str, str] = {}
    payload_values: dict[str, Mapping[str, Any]] = {}
    explicit_payloads = paths.payload_paths
    if explicit_payloads is not None:
        expected_names = frozenset(name for name, _ in expected_paths)
        if frozenset(explicit_payloads) != expected_names:
            _fail("payload_paths must contain exactly accepted_fields, certified_fields and recomputed_certificate")
    for name, expected in expected_paths:
        ref = _mapping(payloads[name], f"producer provenance.payloads.{name}")
        _, raw_digest, content_digest = _validate_payload_ref(
            ref, f"producer provenance.payloads.{name}", root, expected
        )
        if explicit_payloads is None:
            resolved = _relative_payload_path(
                root, ref["path"], f"producer provenance.payloads.{name}"
            )
        else:
            candidate = explicit_payloads[name]
            if not isinstance(candidate, Path):
                candidate = Path(candidate)
            if not candidate.is_absolute():
                _fail(f"payload_paths.{name} must be an absolute copied-payload path")
            resolved = candidate
        payload_raw = _read_bytes(resolved, f"{name} payload")
        if _sha256(payload_raw) != raw_digest:
            _fail(f"{name} payload raw bytes do not match producer provenance")
        payload, _ = _load_object(resolved, f"{name} payload")
        if payload.get("content_sha256") != content_digest:
            _fail(f"{name} payload content digest does not match producer provenance")
        resolved_payloads[name] = resolved
        payload_digests[name] = raw_digest
        payload_values[name] = payload

    _validate_identity_source_bindings(
        identity,
        provenance=provenance,
        build=build,
        plan_snapshot=plan_snapshot,
        material=material,
        node_count=node_count,
        equilibrium_content_sha256=_m0_content_digest(m0),
        equilibrium_artifact_schema=equilibrium_artifact_schema,
        payload_refs={name: _mapping(payloads[name], f"producer provenance.payloads.{name}") for name, _ in expected_paths},
        payload_values=payload_values,
        payload_paths=resolved_payloads,
        payload_raw_sha256=payload_digests,
    )

    replay_report = replay_artifact_paths(
        ArtifactPaths(
            accepted_fields=resolved_payloads["accepted_fields"],
            certified_fields=resolved_payloads["certified_fields"],
            recomputed_certificate=resolved_payloads["recomputed_certificate"],
        ),
        source=source_context_placeholder,
        identity_path=paths.identity_path,
    )
    if not replay_report.payload_replay_qualified:
        _fail("accepted/certified/recomputed payload replay did not close all exact gates")
    if replay_report.scientific_qualification != SCIENTIFIC_QUALIFICATION_NOT_VERIFIED:
        _fail("payload replay returned an unsupported scientific qualification")

    source_paths = {
        "provenance": str(paths.provenance_path),
        "producer_plan": str(paths.producer_plan_path) if paths.producer_plan_path is not None else "inline:producer_plan_snapshot.preimage_json",
        "equilibrium_magnetization": str(paths.equilibrium_magnetization_path),
        "identity": str(paths.identity_path),
        "identity_preimage": str(paths.identity_preimage_path),
    }
    if paths.source_mesh_path is not None:
        source_paths["source_mesh"] = str(paths.source_mesh_path)
    for name, path in resolved_payloads.items():
        source_paths[f"payload_{name}"] = str(path)
    limitations = tuple(
        dict.fromkeys(
            (
                *replay_report.limitations,
                "interpreted source replay does not prove native execution, device residency, residual, convergence, or COMSOL/TetraX parity",
                "source plan projection checks the certified exchange/demag/Zeeman/constant-Ku scope; full Rust plan deserialization remains a native responsibility",
            )
        )
    )
    return ProducerReplayReport(
        status=SOURCE_REPLAY_QUALIFIED,
        scientific_qualification=SCIENTIFIC_QUALIFICATION_NOT_VERIFIED,
        source_context=ReplaySourceContext(
            node_count=source_context_placeholder.node_count,
            material=source_context_placeholder.material,
            equilibrium_magnetization=source_context_placeholder.equilibrium_magnetization,
            mesh_topology_sha256=source_context_placeholder.mesh_topology_sha256,
            equilibrium_material_signature=physical_signatures["equilibrium_material_signature"],
            equilibrium_static_physics_signature=physical_signatures["equilibrium_static_physics_signature"],
            equilibrium_boundary_signature=physical_signatures["equilibrium_boundary_signature"],
            mesh=source_context_placeholder.mesh,
        ),
        source_run_id=provenance["source_run_id"],
        source_stage_id=provenance["source_stage_id"],
        source_stage_kind=provenance["source_stage_kind"],
        producer_source_snapshot_sha256=build["source_snapshot_sha256"],
        plan_raw_sha256=plan_snapshot["raw_sha256"],
        plan_framed_sha256=plan_snapshot["framed_sha256"],
        identity_content_sha256=identity_content_sha256,
        sidecar_raw_sha256=_sha256(provenance_raw),
        payload_raw_sha256_by_name=payload_digests,
        source_paths=source_paths,
        payload_report=replay_report,
        limitations=limitations,
    )


def _m0_content_digest(m0: list[list[float]]) -> str:
    digest = hashlib.sha256()
    digest.update(b"RecomputedFemLinearizationCertificate.m0.v1\0")
    digest.update(struct.pack("<Q", len(m0)))
    for vector in m0:
        for value in vector:
            digest.update(struct.pack("<d", _finite_number(value, "m0")))
    return "sha256:" + digest.hexdigest()


def _validate_physical_preimages_from_exact_bytes(
    identity_raw: bytes,
    plan: Mapping[str, Any],
    material: Mapping[str, Any],
) -> Mapping[str, str]:
    try:
        signatures = replay_equilibrium_identity_preimages(identity_raw)
        identity = strict_json_object(identity_raw, "linearization identity")
    except (IdentityReplayError, ValueError, TypeError) as error:
        raise ProducerProvenanceReplayError(
            f"equilibrium identity physical preimage replay failed: {error}"
        ) from error

    def preimage(key: str, label: str) -> Mapping[str, Any]:
        value = identity.get(key)
        if type(value) is not str:
            _fail(f"identity.{key} must be a string")
        try:
            return strict_json_object(value.encode("utf-8"), label)
        except IdentityReplayError as error:
            raise ProducerProvenanceReplayError(str(error)) from error

    physical = preimage("equilibrium_material_preimage_json", "equilibrium material preimage")
    raw_material = preimage("producer_material_provenance_preimage_json", "producer raw material preimage")
    static = preimage("equilibrium_static_physics_preimage_json", "equilibrium static physics preimage")
    boundary = preimage("equilibrium_boundary_preimage_json", "equilibrium boundary preimage")
    _same_json(raw_material, material, "producer raw material vs source plan.material")
    expected_material = {
        "schema_version": "EquilibriumMaterialSignaturePreimage.v2"
        if material.get("uniaxial_anisotropy") is not None
        else "EquilibriumMaterialSignaturePreimage.v1",
        "saturation_magnetisation_a_per_m": material["saturation_magnetisation"],
        "exchange_stiffness_j_per_m": material["exchange_stiffness"],
        "saturation_magnetisation_field_a_per_m": material.get("ms_field"),
        "exchange_stiffness_field_j_per_m": material.get("a_field"),
    }
    if material.get("uniaxial_anisotropy") is not None:
        expected_material.update(
            {
                "uniaxial_anisotropy_j_per_m3": material["uniaxial_anisotropy"],
                "canonical_uniaxial_axis": _canonical_axis(material),
            }
        )
    _same_json(physical, expected_material, "equilibrium material vs source plan")
    _same_json(
        static,
        {
            "schema_version": "EquilibriumStaticPhysicsSignaturePreimage.v1",
            "enable_exchange": plan["enable_exchange"],
            "enable_demag": plan["enable_demag"],
            "external_field_a_per_m": plan.get("external_field"),
        },
        "static physics vs source plan",
    )
    source_mesh = _mapping(plan["mesh"], "source plan.mesh")
    _same_json(
        boundary,
        {
            "schema_version": "EquilibriumBoundarySignaturePreimage.v1",
            "exchange_bc": plan["exchange_bc"],
            "demag_realization": plan.get("demag_realization"),
            "air_box_config": plan.get("air_box_config"),
            "periodic_node_pairs": source_mesh.get("periodic_node_pairs", []),
            "periodic_boundary_pairs": source_mesh.get("periodic_boundary_pairs", []),
        },
        "boundary vs source plan",
    )
    return signatures


__all__ = [
    "ProducerArtifactPaths",
    "ProducerProvenanceReplayError",
    "ProducerReplayReport",
    "SOURCE_REPLAY_QUALIFIED",
    "SOURCE_REPLAY_REJECTED",
    "replay_producer_provenance",
]
