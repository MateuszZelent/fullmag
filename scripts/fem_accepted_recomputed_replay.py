"""Fail-closed replay of the native FEM equilibrium sidecars.

The native relaxation producer writes three typed payloads: the accepted
endpoint fields, the refreshed certified fields, and the recomputation
certificate.  This module binds those payloads to the source material family,
equilibrium magnetisation, mesh identity, and the three physical identity
signatures before it reports a qualified replay.

The binary field digest and difference rules are shared with
``fem_equilibrium_field_replay``.  Certificate JSON digest verification is
deliberately byte-oriented: callers must provide the producer's exact
``serde_json`` preimage bytes (or extract them from the published
``linearization_identity.v2`` payload).  Python never reserializes the
certificate to guess Rust bytes.

This is an interpreted artifact consumer.  It does not prove native execution,
mesh/airbox convergence, modal residuals, or COMSOL/TetraX agreement.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import math
from pathlib import Path
import sys
from typing import Any, Mapping, Sequence

_SCRIPT_DIR = str(Path(__file__).resolve().parent)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

try:
    from fem_equilibrium_field_replay import (
        CERTIFICATE_DIGEST_STATUS_VERIFIED,
        ReplayResult,
        ValidationError,
        recomputed_fem_equilibrium_content_sha256,
        replay_accepted_recomputed_fields,
    )
except ModuleNotFoundError:  # pragma: no cover - package import fallback
    from scripts.fem_equilibrium_field_replay import (
        CERTIFICATE_DIGEST_STATUS_VERIFIED,
        ReplayResult,
        ValidationError,
        recomputed_fem_equilibrium_content_sha256,
        replay_accepted_recomputed_fields,
    )

try:
    from fem_linearization_identity_replay import (
        IdentityReplayError,
        strict_json_object as _identity_strict_json_object,
    )
except ModuleNotFoundError:  # pragma: no cover - package import fallback
    from scripts.fem_linearization_identity_replay import (
        IdentityReplayError,
        strict_json_object as _identity_strict_json_object,
    )

try:
    from comsol_mesh_identity import mesh_topology_fingerprint_v3
except ModuleNotFoundError:  # pragma: no cover - package import fallback
    from scripts.comsol_mesh_identity import mesh_topology_fingerprint_v3


V1_FIELDS_SCHEMA = "CertifiedFemEquilibriumFields.v1"
V2_FIELDS_SCHEMA = "CertifiedFemEquilibriumFields.v2"
CERTIFICATE_PREIMAGE_JSON_KEY = "recomputed_certificate_preimage_json"
CERTIFICATE_PREIMAGE_SHA256_KEY = "recomputed_certificate_preimage_sha256"
SCIENTIFIC_QUALIFICATION_NOT_VERIFIED = "NOT_VERIFIED"
CALLER_VALIDATED_IDENTITY_SCOPE = "caller_validated_source_signatures"
IDENTITY_EXTRACTOR_SCOPE = "preimage_extractor_only"

_CELL_ARITY = {"tet4": 4, "prism6": 6, "pyramid5": 5, "hex8": 8}
_FACET_ARITY = {"tri3": 3, "quad4": 4}


def _fail(message: str) -> None:
    raise ValidationError(message)


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail(f"{label} must be a positive integer")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith("sha256:"):
        _fail(f"{label} must be a lowercase sha256 digest")
    if any(character not in "0123456789abcdef" for character in value[7:]):
        _fail(f"{label} must be a lowercase sha256 digest")
    return value


def _finite_float(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError) as error:
        raise ValidationError(f"{label} must be a finite number") from error
    if not math.isfinite(result):
        _fail(f"{label} must be a finite number")
    return result


def _strict_json_object(raw: bytes, label: str) -> Mapping[str, Any]:
    """Reuse the identity parser's duplicate/depth/Unicode safeguards."""

    if type(raw) is not bytes:
        _fail(f"{label} must be exact UTF-8 JSON bytes")
    try:
        return _identity_strict_json_object(raw, label)
    except IdentityReplayError as error:
        raise ValidationError(str(error)) from error


def load_json_artifact(path: str | Path, label: str) -> tuple[Mapping[str, Any], bytes]:
    """Read one real sidecar while preserving its exact bytes for diagnostics."""

    artifact_path = Path(path)
    try:
        raw = artifact_path.read_bytes()
    except OSError as error:
        raise ValidationError(f"cannot read {label} at {artifact_path}: {error}") from error
    return _strict_json_object(raw, label), raw


@dataclass(frozen=True)
class ReplaySourceContext:
    """Typed source identity required for a qualified sidecar replay.

    ``material`` is the source ``MaterialIR`` JSON object.  The presence of
    ``uniaxial_anisotropy`` selects V2 even when its value is exactly zero;
    omitting that key is rejected because it cannot distinguish an incomplete
    source snapshot from the legacy V1 family.
    """

    node_count: int
    material: Mapping[str, Any]
    equilibrium_magnetization: Sequence[Sequence[float]]
    mesh_topology_sha256: str | None
    equilibrium_material_signature: str
    equilibrium_static_physics_signature: str
    equilibrium_boundary_signature: str
    mesh: Mapping[str, Any] | bytes | None = None


@dataclass(frozen=True)
class ArtifactPaths:
    """Canonical accepted/certified/certificate sidecar paths for one sample."""

    accepted_fields: Path
    certified_fields: Path
    recomputed_certificate: Path


@dataclass(frozen=True)
class AcceptedRecomputedReplayReport:
    """Evidence for one source-bound replay.

    ``payload_replay_qualified`` is true only when all source bindings and the
    exact certificate preimage gate pass.  A successful field comparison
    without that preimage remains useful evidence but is never promoted to a
    qualified payload replay.  ``scientific_qualification`` is always
    ``NOT_VERIFIED`` here because this interpreted check cannot prove native
    execution or modal physics.
    """

    expected_fields_schema: str
    node_count: int
    differences: Mapping[str, float]
    field_content_digests_verified: bool
    field_replay_verified: bool
    m0_binding_verified: bool
    mesh_binding_verified: bool
    material_binding_verified: bool
    static_physics_binding_verified: bool
    boundary_binding_verified: bool
    identity_scope: str
    certificate_content_digest_status: str
    payload_replay_qualified: bool
    scientific_qualification: str
    limitations: tuple[str, ...]


def _material_fields_schema(material: Mapping[str, Any]) -> str:
    if not isinstance(material, Mapping):
        _fail("source material must be a JSON object")
    if "uniaxial_anisotropy" not in material:
        _fail(
            "source material must include uniaxial_anisotropy presence; "
            "an incomplete snapshot cannot select V1 or V2"
        )
    ku = material["uniaxial_anisotropy"]
    if ku is not None:
        _finite_float(ku, "source material.uniaxial_anisotropy")
        return V2_FIELDS_SCHEMA
    return V1_FIELDS_SCHEMA


def _mesh_mapping(mesh: Mapping[str, Any] | bytes | None) -> Mapping[str, Any] | None:
    if mesh is None:
        return None
    if type(mesh) is bytes:
        return _strict_json_object(mesh, "source mesh")
    if not isinstance(mesh, Mapping):
        _fail("source.mesh must be a canonical mesh object or exact JSON bytes")
    return mesh


def _mesh_index(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail(f"{label} must be a non-negative integer")
    return value


def _mesh_sequence(mapping: Mapping[str, Any], key: str, label: str, *, default: Any = None) -> list[Any]:
    value = mapping.get(key, default)
    if not isinstance(value, list):
        _fail(f"{label} must be an array")
    return value


def _normalize_and_validate_mesh(
    mesh: Mapping[str, Any], expected_node_count: int
) -> Mapping[str, Any]:
    """Apply MeshIR serde defaults and the structural MeshIR::validate rules.

    This intentionally stops at structural validation.  Geometric Jacobian
    checks and strict production qualification remain native responsibilities.
    """

    if not isinstance(mesh, Mapping):
        _fail("source.mesh must be a canonical mesh object")
    normalized = dict(mesh)
    nodes = _mesh_sequence(mesh, "nodes", "mesh.nodes", default=None)
    if not nodes:
        _fail("mesh.nodes must not be empty")
    if len(nodes) != expected_node_count:
        _fail(
            "source.mesh.nodes length does not match source.node_count "
            f"({len(nodes)} != {expected_node_count})"
        )
    for index, node in enumerate(nodes):
        if not isinstance(node, list) or len(node) != 3:
            _fail(f"mesh.nodes[{index}] must have three coordinates")
        for axis, coordinate in enumerate(node):
            _finite_float(coordinate, f"mesh.nodes[{index}][{axis}]")

    for key in ("element_markers", "boundary_markers", "periodic_boundary_pairs", "periodic_node_pairs"):
        normalized[key] = _mesh_sequence(mesh, key, f"mesh.{key}", default=[])

    for key, required in (("cells", ("types", "offsets", "nodes")), ("facets", ("types", "roles", "offsets", "nodes"))):
        value = mesh.get(key)
        if not isinstance(value, Mapping):
            _fail(f"mesh.{key} connectivity is required")
        nested = dict(value)
        for field in required:
            nested[field] = _mesh_sequence(value, field, f"mesh.{key}.{field}", default=None)
        nested["mesh_parts"] = _mesh_sequence(value, "mesh_parts", f"mesh.{key}.mesh_parts", default=[])
        nested["global_ordinals"] = _mesh_sequence(
            value, "global_ordinals", f"mesh.{key}.global_ordinals", default=[]
        )
        if not nested["global_ordinals"] and nested["types"]:
            nested["global_ordinals"] = list(range(len(nested["types"])))
        normalized[key] = nested

    cells = normalized["cells"]
    facets = normalized["facets"]
    if not cells["types"]:
        _fail("mesh.cells must not be empty")
    if len(normalized["element_markers"]) != len(cells["types"]):
        _fail("mesh.element_markers length must match mesh.cells.types length")
    if len(normalized["boundary_markers"]) != len(facets["types"]):
        _fail("mesh.boundary_markers length must match mesh.facets.types length")
    if len(facets["roles"]) != len(facets["types"]):
        _fail("mesh.facets.roles length must match mesh.facets.types length")
    if cells["mesh_parts"] and len(cells["mesh_parts"]) != len(cells["types"]):
        _fail("mesh.cells.mesh_parts must be empty or match mesh.cells.types length")
    if len(cells["global_ordinals"]) != len(cells["types"]):
        _fail("mesh.cells.global_ordinals length must match mesh.cells.types length")
    if len(facets["global_ordinals"]) != len(facets["types"]):
        _fail("mesh.facets.global_ordinals length must match mesh.facets.types length")
    for index, ordinal in enumerate(cells["global_ordinals"]):
        if _mesh_index(ordinal, f"mesh.cells.global_ordinals[{index}]") > 0xFFFFFFFFFFFFFFFF:
            _fail("mesh.cells.global_ordinals value is out of range")
    for index, ordinal in enumerate(facets["global_ordinals"]):
        if _mesh_index(ordinal, f"mesh.facets.global_ordinals[{index}]") > 0xFFFFFFFFFFFFFFFF:
            _fail("mesh.facets.global_ordinals value is out of range")
    if len(set(cells["global_ordinals"])) != len(cells["global_ordinals"]):
        _fail("mesh.cells.global_ordinals must be unique")
    if len(set(facets["global_ordinals"])) != len(facets["global_ordinals"]):
        _fail("mesh.facets.global_ordinals must be unique")

    def validate_connectivity(kind: str, data: Mapping[str, Any], arities: Mapping[str, int]) -> None:
        types = data["types"]
        offsets = data["offsets"]
        connectivity = data["nodes"]
        if len(offsets) != len(types) + 1:
            _fail(f"mesh.{kind}.offsets length must equal {kind} count + 1")
        if not offsets or _mesh_index(offsets[0], f"mesh.{kind}.offsets[0]") != 0:
            _fail(f"mesh.{kind}.offsets must start at 0")
        previous = 0
        for index, offset in enumerate(offsets):
            current = _mesh_index(offset, f"mesh.{kind}.offsets[{index}]")
            if current < previous:
                _fail(f"mesh.{kind}.offsets must be monotone")
            previous = current
        if previous != len(connectivity):
            _fail(f"mesh.{kind}.offsets must end at {kind}.nodes length")
        for index, cell_type in enumerate(types):
            if not isinstance(cell_type, str) or cell_type not in arities:
                _fail(f"mesh.{kind}.types[{index}] has unsupported enum value")
            start = offsets[index]
            end = offsets[index + 1]
            item = connectivity[start:end]
            if len(item) != arities[cell_type]:
                _fail(
                    f"mesh {kind[:-1]} {index} has wrong arity {len(item)}; "
                    f"expected {arities[cell_type]}"
                )
            indices = [_mesh_index(node, f"mesh.{kind}.nodes[{start + item_index}]") for item_index, node in enumerate(item)]
            if any(node >= expected_node_count for node in indices):
                _fail(f"mesh {kind[:-1]} {index} contains invalid node index")
            if len(set(indices)) != len(indices):
                _fail(f"mesh {kind[:-1]} {index} contains duplicate node indices")

    validate_connectivity("cells", cells, _CELL_ARITY)
    validate_connectivity("facets", facets, _FACET_ARITY)
    if any(cell_type != "tet4" for cell_type in cells["types"]):
        if normalized["periodic_boundary_pairs"] or normalized["periodic_node_pairs"] or "periodic_seam" in facets["roles"]:
            _fail(
                "mixed topology with periodic pairs or periodic_seam facets is not qualified"
            )

    pair_ids: set[str] = set()
    pair_translations: dict[str, Any] = {}
    for index, pair in enumerate(normalized["periodic_boundary_pairs"]):
        if not isinstance(pair, Mapping):
            _fail(f"mesh periodic boundary pair {index} must be an object")
        if "tolerance" in pair and "tolerance_m" in pair:
            _fail("mesh periodic boundary pair duplicates tolerance through tolerance_m alias")
        pair_id = pair.get("pair_id")
        if not isinstance(pair_id, str) or not pair_id.strip():
            _fail(f"mesh periodic boundary pair {index} must have a non-empty pair_id")
        pair_ids.add(pair_id)
        translation = pair.get("translation")
        if pair_id in pair_translations and pair_translations[pair_id] != translation:
            _fail(f"mesh periodic boundary pair id {pair_id!r} has inconsistent translations")
        pair_translations[pair_id] = translation

    source_nodes: set[tuple[str, int]] = set()
    destination_nodes: set[tuple[str, int]] = set()
    for index, pair in enumerate(normalized["periodic_node_pairs"]):
        if not isinstance(pair, Mapping):
            _fail(f"mesh periodic node pair {index} must be an object")
        pair_id = pair.get("pair_id")
        node_a = _mesh_index(pair.get("node_a"), f"mesh.periodic_node_pairs[{index}].node_a")
        node_b = _mesh_index(pair.get("node_b"), f"mesh.periodic_node_pairs[{index}].node_b")
        if not isinstance(pair_id, str) or not pair_id.strip():
            _fail(f"mesh periodic node pair {index} must have a non-empty pair_id")
        if pair_id not in pair_ids:
            _fail(f"mesh periodic node pair {index} references unknown pair_id {pair_id!r}")
        if node_a >= expected_node_count or node_b >= expected_node_count:
            _fail(f"mesh periodic node pair {index} contains invalid node index")
        if node_a == node_b:
            _fail(f"mesh periodic node pair {index} must connect two distinct nodes")
        if (pair_id, node_a) in source_nodes or (pair_id, node_b) in destination_nodes:
            _fail(f"mesh periodic node pair {index} duplicates a source or destination node")
        source_nodes.add((pair_id, node_a))
        destination_nodes.add((pair_id, node_b))

        boundary_pair = next(
            item for item in normalized["periodic_boundary_pairs"]
            if item.get("pair_id") == pair_id
        )
        translation = boundary_pair.get("translation")
        if translation is not None:
            tolerance = boundary_pair.get("tolerance")
            if tolerance is None:
                tolerance = boundary_pair.get("tolerance_m")
            if tolerance is None:
                tolerance = 1e-9
            tolerance = _finite_float(tolerance, f"periodic boundary pair {pair_id} tolerance")
            tolerance = max(tolerance, 0.0)
            if not isinstance(translation, list) or len(translation) != 3:
                _fail(f"periodic boundary pair {pair_id} translation must have three components")
            residual = [
                _finite_float(nodes[node_b][axis], "mesh node coordinate")
                - _finite_float(nodes[node_a][axis], "mesh node coordinate")
                - _finite_float(translation[axis], "periodic translation")
                for axis in range(3)
            ]
            if math.sqrt(sum(component * component for component in residual)) > tolerance:
                _fail(
                    f"mesh periodic node pair {index} residual exceeds tolerance for pair_id {pair_id!r}"
                )

    return normalized


def _validate_source_context(
    source: ReplaySourceContext,
) -> tuple[str, Mapping[str, str], str | None]:
    if not isinstance(source, ReplaySourceContext):
        _fail("source must be a ReplaySourceContext")
    node_count = _positive_int(source.node_count, "source.node_count")
    expected_schema = _material_fields_schema(source.material)
    if isinstance(source.equilibrium_magnetization, (str, bytes)) or not isinstance(
        source.equilibrium_magnetization, Sequence
    ):
        _fail("source.equilibrium_magnetization must be a vector array")
    if len(source.equilibrium_magnetization) != node_count:
        _fail("source.equilibrium_magnetization node count does not match source.node_count")
    # Calling the native m0 digest mirror validates every array entry, shape,
    # finiteness, and little-endian f64 conversion before the certificate is
    # allowed to bind to it.
    recomputed_fem_equilibrium_content_sha256(source.equilibrium_magnetization)
    signatures = {
        "equilibrium_material_signature": _digest(
            source.equilibrium_material_signature,
            "source.equilibrium_material_signature",
        ),
        "equilibrium_static_physics_signature": _digest(
            source.equilibrium_static_physics_signature,
            "source.equilibrium_static_physics_signature",
        ),
        "equilibrium_boundary_signature": _digest(
            source.equilibrium_boundary_signature,
            "source.equilibrium_boundary_signature",
        ),
    }
    if source.mesh_topology_sha256 is not None:
        _digest(source.mesh_topology_sha256, "source.mesh_topology_sha256")
    mesh = _mesh_mapping(source.mesh)
    actual_mesh_digest: str | None = None
    if mesh is not None:
        mesh = _normalize_and_validate_mesh(mesh, node_count)
        try:
            actual_mesh_digest = mesh_topology_fingerprint_v3(mesh)
        except (TypeError, ValueError, OverflowError, UnicodeError) as error:
            raise ValidationError(f"source mesh topology fingerprint failed: {error}") from error
        if (
            source.mesh_topology_sha256 is not None
            and source.mesh_topology_sha256 != actual_mesh_digest
        ):
            _fail("source.mesh_topology_sha256 does not match the supplied source mesh")
    return expected_schema, signatures, actual_mesh_digest


def certificate_preimage_from_identity(identity: Mapping[str, Any]) -> bytes:
    """Extract and raw-hash-check a preimage string from an identity object.

    The value is a producer-owned UTF-8 string.  Its bytes are returned
    unchanged; no JSON serialization is performed here.  This is deliberately
    an extractor only: it does not validate the complete
    ``linearization_identity.v2`` schema, its source bindings, or its signed
    path set.  Callers must perform that identity validation separately.
    """

    if not isinstance(identity, Mapping):
        _fail("linearization identity must be a JSON object")
    if CERTIFICATE_PREIMAGE_JSON_KEY not in identity:
        _fail(f"linearization identity is missing {CERTIFICATE_PREIMAGE_JSON_KEY}")
    value = identity[CERTIFICATE_PREIMAGE_JSON_KEY]
    if not isinstance(value, str):
        _fail(f"linearization identity {CERTIFICATE_PREIMAGE_JSON_KEY} must be a string")
    try:
        raw = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValidationError(
            f"linearization identity {CERTIFICATE_PREIMAGE_JSON_KEY} must be valid UTF-8"
        ) from error
    expected = _digest(
        identity.get(CERTIFICATE_PREIMAGE_SHA256_KEY),
        f"linearization identity {CERTIFICATE_PREIMAGE_SHA256_KEY}",
    )
    actual = "sha256:" + hashlib.sha256(raw).hexdigest()
    if actual != expected:
        _fail("linearization identity certificate preimage raw digest does not match its bytes")
    return raw


def replay_accepted_recomputed_payloads(
    accepted_fields: Mapping[str, Any],
    certified_fields: Mapping[str, Any],
    recomputed_certificate: Mapping[str, Any],
    *,
    source: ReplaySourceContext,
    certificate_preimage: bytes | None = None,
) -> AcceptedRecomputedReplayReport:
    """Replay three typed sidecars and bind them to the source context."""

    expected_schema, signatures, source_mesh_digest = _validate_source_context(source)
    if not isinstance(accepted_fields, Mapping):
        _fail("accepted_fields must be a JSON object")
    if not isinstance(certified_fields, Mapping):
        _fail("certified_fields must be a JSON object")
    if accepted_fields.get("schema_version") != expected_schema:
        _fail("accepted_fields schema does not match source material family")
    if certified_fields.get("schema_version") != expected_schema:
        _fail("certified_fields schema does not match source material family")

    base: ReplayResult = replay_accepted_recomputed_fields(
        accepted_fields,
        certified_fields,
        recomputed_certificate,
        node_count=source.node_count,
        certificate_preimage=certificate_preimage,
        equilibrium_magnetization=source.equilibrium_magnetization,
        expected_mesh_topology_sha256=source_mesh_digest,
        expected_identity_signatures=signatures,
    )
    source_bindings = {
        "m0": True,
        "mesh": source_mesh_digest is not None,
        "material": True,
        "static_physics": True,
        "boundary": True,
    }
    limitations = list(base.limitations)
    limitations.append(
        "material, static-physics, and boundary signatures are caller-validated source digests; "
        "this replay does not reconstruct or authenticate their producer preimages"
    )
    if source_mesh_digest is None:
        limitations.append(
            "mesh topology fingerprint was not replayed: source.mesh mapping or exact JSON bytes were not supplied"
        )
    all_content_gates = (
        base.field_content_digests_verified
        and base.field_replay_verified
        and all(source_bindings.values())
        and base.certificate_content_digest_status == CERTIFICATE_DIGEST_STATUS_VERIFIED
    )
    return AcceptedRecomputedReplayReport(
        expected_fields_schema=expected_schema,
        node_count=source.node_count,
        differences=base.differences,
        field_content_digests_verified=base.field_content_digests_verified,
        field_replay_verified=base.field_replay_verified,
        m0_binding_verified=source_bindings["m0"],
        mesh_binding_verified=source_bindings["mesh"],
        material_binding_verified=source_bindings["material"],
        static_physics_binding_verified=source_bindings["static_physics"],
        boundary_binding_verified=source_bindings["boundary"],
        identity_scope=CALLER_VALIDATED_IDENTITY_SCOPE,
        certificate_content_digest_status=base.certificate_content_digest_status,
        payload_replay_qualified=all_content_gates,
        scientific_qualification=SCIENTIFIC_QUALIFICATION_NOT_VERIFIED,
        limitations=tuple(dict.fromkeys(limitations)),
    )


def replay_artifact_paths(
    paths: ArtifactPaths,
    *,
    source: ReplaySourceContext,
    certificate_preimage_path: str | Path | None = None,
    identity_path: str | Path | None = None,
) -> AcceptedRecomputedReplayReport:
    """Load real sidecars and replay them without changing their JSON bytes."""

    accepted, _ = load_json_artifact(paths.accepted_fields, "accepted fields artifact")
    certified, _ = load_json_artifact(paths.certified_fields, "certified fields artifact")
    certificate, _ = load_json_artifact(
        paths.recomputed_certificate, "recomputed certificate artifact"
    )
    if certificate_preimage_path is not None and identity_path is not None:
        _fail("supply either certificate_preimage_path or identity_path, not both")
    preimage: bytes | None = None
    if certificate_preimage_path is not None:
        try:
            preimage = Path(certificate_preimage_path).read_bytes()
        except OSError as error:
            raise ValidationError(
                f"cannot read exact certificate preimage at {certificate_preimage_path}: {error}"
            ) from error
    elif identity_path is not None:
        identity, _ = load_json_artifact(identity_path, "linearization identity artifact")
        preimage = certificate_preimage_from_identity(identity)
    report = replay_accepted_recomputed_payloads(
        accepted,
        certified,
        certificate,
        source=source,
        certificate_preimage=preimage,
    )
    if identity_path is not None:
        report = replace(
            report,
            limitations=tuple(
                dict.fromkeys(
                    (*report.limitations,
                     "certificate preimage was extracted from identity; complete linearization_identity.v2 validation is caller responsibility")
                )
            ),
        )
    return report


__all__ = [
    "ArtifactPaths",
    "AcceptedRecomputedReplayReport",
    "CALLER_VALIDATED_IDENTITY_SCOPE",
    "IDENTITY_EXTRACTOR_SCOPE",
    "ReplaySourceContext",
    "SCIENTIFIC_QUALIFICATION_NOT_VERIFIED",
    "V1_FIELDS_SCHEMA",
    "V2_FIELDS_SCHEMA",
    "certificate_preimage_from_identity",
    "load_json_artifact",
    "replay_accepted_recomputed_payloads",
    "replay_artifact_paths",
]
