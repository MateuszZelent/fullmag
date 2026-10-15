"""Fail-closed parity comparison for two canonical signed-fifteen DE campaigns."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from collections.abc import Mapping
from typing import Any

import plot_signed_de_campaign as plotting
from fem_linearization_identity_replay import IDENTITY_FIELDS, IdentityReplayError, replay_identity_preimage
from fem_equilibrium_identity_replay import (
    EquilibriumIdentityReplayError,
    replay_equilibrium_identity_preimages,
)
from fem_equilibrium_field_replay import recomputed_fem_equilibrium_content_sha256
from verify_fem_frequency_domain_eigen_artifacts import (
    equilibrium_artifact_v7_digest,
    equilibrium_artifact_v8_digest,
    linearization_state_v7_digest,
)
from validate_de_smoke_rows import DENSE_CERTIFICATION_TOLERANCE, MAX_PROBE_RELATIVE_TOLERANCE, load_spectrum_v3_modes
from validate_parallel_execution_report import ValidationError as SchedulerValidationError
from validate_parallel_execution_report import validate_parallel_execution_report

SAMPLE_COUNT = 15
SAMPLE_INDICES = tuple(range(SAMPLE_COUNT))
POOL_SAMPLE_INDICES = tuple(range(1, SAMPLE_COUNT))
SPECTRUM_PATH = "eigen/spectrum.v3.json"
MANIFEST_PATH = "frequency_domain/manifest.v1.json"
REPORT_PATH = "eigen/parallel_execution.v1.json"
JOURNAL_PATH = "eigen/admission_journal.v1.json"
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
SIDECAR_SCHEMA_PAIRS = {
    ("equilibrium_artifact.v7", "LinearizationState.v6"): (
        "equilibrium_artifact.v7.json", "linearization_state.v6.json",
        equilibrium_artifact_v7_digest,
    ),
    ("equilibrium_artifact.v8", "LinearizationState.v7"): (
        "equilibrium_artifact.v8.json", "linearization_state.v7.json",
        equilibrium_artifact_v8_digest,
    ),
}

# Stable physical/build identity is compared across runs; local output bindings
# are validated separately and their digests are not equated between campaigns.
STABLE_IDENTITY_FIELDS = (
    "equilibrium_artifact_schema", "linearization_state_schema", "accepted_fields_schema",
    "certified_fields_schema", "recomputed_certificate_schema", "handoff_schema_version",
    "cross_build_policy", "producer_build_identity", "consumer_build_identity",
    "producer_source_snapshot_sha256", "consumer_source_snapshot_sha256",
    "source_mesh_topology_sha256", "modal_mesh_topology_fingerprint_v3", "node_count",
    "equilibrium_content_sha256",
    "equilibrium_material_signature", "equilibrium_material_preimage_json",
    "equilibrium_static_physics_signature", "equilibrium_static_physics_preimage_json",
    "equilibrium_boundary_signature", "equilibrium_boundary_preimage_json",
    "material_signature", "material_identity_kind", "material_provenance_signature",
    "material_provenance_scope", "material_provenance_preimage_json",
    "producer_material_provenance_signature", "producer_material_provenance_preimage_json",
)
MODE_DIGEST_FIELDS = (
    "source_mesh_topology_sha256", "periodic_mesh_certificate_sha256",
    "operator_input_signature_sha256", "phase_constraint_sha256",
)
MANIFEST_DIGEST_FIELDS = (
    "source_mesh_topology_sha256", "periodic_mesh_certificate_sha256",
    "operator_input_signature_sha256", "phase_constraint_sha256",
    "equilibrium_artifact_sha256", "linearization_state_sha256",
    "linearization_identity_sha256",
)
RUNTIME_FIELDS = ("backend", "device", "image_digest", "mode", "precision", "slepc")


class ValidationError(ValueError):
    """A malformed or conflicting campaign identity must be rejected."""


class EvidenceUnavailable(ValidationError):
    """Required evidence is missing; no parity claim is made."""


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValidationError(f"non-finite JSON constant is not allowed: {value}")


def _read_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise EvidenceUnavailable(f"{label} is missing or is not a regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"),
                           object_pairs_hook=_unique_pairs, parse_constant=_reject_constant)
    except EvidenceUnavailable:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValidationError(f"{label} is invalid JSON") from error
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be a JSON object")
    return value


def _object(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvidenceUnavailable(f"{label} is missing or is not an object")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvidenceUnavailable(f"{label} is missing or is not a non-empty string")
    return value


def _digest(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        raise EvidenceUnavailable(f"{label} is missing or is not a sha256 digest")
    return value


def _finite(value: object, label: str, *, nonnegative: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{label} is not numeric")
    result = float(value)
    if not math.isfinite(result) or (nonnegative and result < 0.0):
        raise ValidationError(f"{label} is non-finite or outside its allowed range")
    return result


def _bound_artifact(campaign: Mapping[str, Any], relative: str) -> tuple[Path, dict[str, Any]]:
    case = Path(campaign["case"]).resolve()
    result = _object(campaign.get("result"), "run-result")
    artifacts = _object(result.get("artifacts"), "run-result artifacts")
    catalog = _object(artifacts.get("required_artifact_hashes"), "required_artifact_hashes")
    binding = catalog.get(relative)
    if not isinstance(binding, Mapping):
        raise EvidenceUnavailable(f"run-result does not hash-bind {relative}")
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValidationError(f"artifact path escapes campaign: {relative}")
    path = (case / rel).resolve()
    try:
        path.relative_to(case)
    except ValueError as error:
        raise ValidationError(f"artifact path escapes campaign: {relative}") from error
    if path.is_symlink() or not path.is_file():
        raise EvidenceUnavailable(f"hash-bound artifact is missing: {relative}")
    expected_hash = binding.get("sha256")
    if not isinstance(expected_hash, str) or HEX64.fullmatch(expected_hash) is None:
        raise EvidenceUnavailable(
            f"required_artifact_hashes[{relative}].sha256 is missing or is not a raw SHA-256 digest"
        )
    size = binding.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValidationError(f"required_artifact_hashes[{relative}].size is invalid")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise EvidenceUnavailable(f"cannot read hash-bound artifact: {relative}") from error
    actual = hashlib.sha256(raw).hexdigest()
    if len(raw) != size or actual != expected_hash:
        raise ValidationError(f"artifact hash or size differs from run-result binding: {relative}")
    return path, {"relative_path": relative, "size": len(raw), "sha256": actual}


def _load_campaign(directory: str | Path, expected_mode: str) -> dict[str, Any]:
    try:
        campaign = plotting.load_campaign(Path(directory))
    except (OSError, ValueError) as error:
        message = str(error)
        if any(term in message.lower() for term in (
            "completed managed", "missing", "not present", "did not pass", "unavailable",
        )):
            raise EvidenceUnavailable(f"{expected_mode} campaign is incomplete: {message}") from error
        raise ValidationError(f"{expected_mode} canonical campaign was rejected: {message}") from error
    if campaign["parallel_campaign"].get("mode") != expected_mode:
        raise ValidationError(f"campaign mode is not {expected_mode!r}")
    rows = campaign.get("rows")
    if not isinstance(rows, list) or [row.get("sample_index") for row in rows] != list(SAMPLE_INDICES):
        raise ValidationError(f"{expected_mode} campaign does not contain exact sample indices 0 through 14")
    if any(row.get("raw_mode_index") != 0 for row in rows):
        raise ValidationError(f"{expected_mode} campaign rows must use raw mode 0")
    return campaign

def _immutable_projection(campaign: Mapping[str, Any], mode: str) -> dict[str, Any]:
    request = _object(campaign.get("request"), "run-request")
    result = _object(campaign.get("result"), "run-result")
    for field in ("model_sha256", "source", "job", "model_source", "parallel_campaign"):
        if request.get(field) != result.get(field):
            raise ValidationError(f"request/result {field} differs")
    source = _object(request.get("source"), "run-request source")
    job = _object(request.get("job"), "run-request job")
    model_source = _object(request.get("model_source"), "run-request model_source")
    runtime = _object(request.get("runtime"), "run-request runtime")
    result_runtime = _object(result.get("runtime"), "run-result runtime")
    if any(runtime.get(field) != result_runtime.get(field) for field in RUNTIME_FIELDS):
        raise ValidationError("request/result runtime identity differs")
    if runtime.get("slepc") is not True:
        raise ValidationError("signed-fifteen runtime does not declare SLEPc")
    for field in ("backend", "device", "image_digest", "mode", "precision"):
        _string(runtime.get(field), f"runtime.{field}")
    _digest(runtime.get("image_digest"), "runtime.image_digest")

    model_sha = _string(request.get("model_sha256"), "model_sha256")
    if HEX64.fullmatch(model_sha) is None:
        raise EvidenceUnavailable("model_sha256 is malformed")
    metadata = _object(campaign.get("metadata"), "metadata")
    if metadata.get("source_hash") != model_sha:
        raise ValidationError("metadata source_hash differs from model_sha256")
    snapshot = _string(source.get("source_snapshot_sha256"), "source.source_snapshot_sha256")
    source_digest = _string(job.get("source_digest"), "job.source_digest")
    if HEX64.fullmatch(snapshot) is None or HEX64.fullmatch(source_digest) is None:
        raise EvidenceUnavailable("source snapshot or job digest is malformed")
    commit = _string(source.get("resolved_commit"), "source.resolved_commit")
    model_commit = _string(model_source.get("commit"), "model_source.commit")
    if re.fullmatch(r"[0-9a-f]{40}", commit) is None or re.fullmatch(r"[0-9a-f]{40}", model_commit) is None:
        raise EvidenceUnavailable("source commit is not a full SHA")
    if model_source.get("sha256") != model_sha:
        raise ValidationError("model_source.sha256 differs from model_sha256")
    orchestrator = _string(request.get("orchestrator_sha256"), "orchestrator_sha256")
    if HEX64.fullmatch(orchestrator) is None:
        raise EvidenceUnavailable("orchestrator_sha256 is malformed")

    problem = _object(metadata.get("problem_meta"), "metadata.problem_meta")
    runtime_meta = _object(problem.get("runtime_metadata"), "runtime_metadata")
    selection = _object(runtime_meta.get("runtime_selection"), "runtime_selection")
    for run_key, meta_key in (
        ("backend", "backend"), ("device", "device"),
        ("mode", "execution_mode"), ("precision", "execution_precision"),
    ):
        if selection.get(meta_key) != runtime.get(run_key):
            raise ValidationError(f"runtime_selection.{meta_key} differs from receipt runtime")
    request_campaign = _object(request.get("parallel_campaign"), "parallel_campaign")
    result_campaign = _object(result.get("parallel_campaign"), "result parallel_campaign")
    if dict(request_campaign) != dict(result_campaign) or request_campaign.get("mode") != mode:
        raise ValidationError("request/result parallel campaign mode or identity differs")
    expected_policy = {"mode": mode, **plotting.EXPECTED_POLICY}
    metadata_policy = _object(selection.get("parallel_execution"), "runtime parallel_execution")
    if dict(metadata_policy) != expected_policy:
        raise ValidationError("runtime parallel execution policy differs from signed-fifteen pin")
    for key, expected in plotting.EXPECTED_POLICY.items():
        if request_campaign.get(key) != expected:
            raise ValidationError(f"parallel_campaign.{key} differs from signed-fifteen pin")
    if request_campaign.get("sampling") != "signed-fifteen" or request_campaign.get("model_sha256") != model_sha:
        raise ValidationError("parallel campaign source or sampling identity differs")

    parameters, window, model = plotting._validate_model_metadata(request, metadata)
    return {
        "model_sha256": model_sha,
        "model_source": dict(model_source),
        "source.resolved_commit": commit,
        "source.source_snapshot_sha256": snapshot,
        "job.source_digest": source_digest,
        "orchestrator_sha256": orchestrator,
        "runtime": {field: runtime[field] for field in RUNTIME_FIELDS},
        "model": dict(model),
        "parameters": dict(parameters),
        "frequency_window_hz": list(window),
        "parallel_policy": {key: request_campaign[key] for key in plotting.EXPECTED_POLICY},
    }


def _m0_fingerprint(value: object, node_count: int, sample_index: int) -> str:
    if not isinstance(value, list) or len(value) != node_count or not value:
        raise EvidenceUnavailable(f"sample {sample_index} source M0 is missing or disagrees with identity.node_count")
    normalized = []
    for node, vector in enumerate(value):
        if not isinstance(vector, list) or len(vector) != 3:
            raise EvidenceUnavailable(f"sample {sample_index} source M0 node {node} is malformed")
        normalized.append([
            _finite(component, f"sample {sample_index} source M0[{node}][{axis}]")
            for axis, component in enumerate(vector)
        ])
    return recomputed_fem_equilibrium_content_sha256(normalized)


def _recompute_semantic_digest(digest_fn, payload: dict, label: str) -> str:
    try:
        return digest_fn(payload)
    except SystemExit as error:
        raise ValidationError(f"{label} semantic digest cannot be replayed: {error}") from error


def _sample_identity(campaign, native_modes, raw_modes, manifest, provenance, sample_index):
    stem = f"eigen/metadata/sample_{sample_index:04d}/"
    identity_path, identity_binding = _bound_artifact(campaign, stem + "linearization_identity.v2.json")
    preimage_path, preimage_binding = _bound_artifact(campaign, stem + "linearization_identity_preimage.v1.json")
    identity_bytes, preimage_bytes = identity_path.read_bytes(), preimage_path.read_bytes()
    try:
        identity = json.loads(identity_bytes, object_pairs_hook=_unique_pairs, parse_constant=_reject_constant)
        if not isinstance(identity, dict):
            raise ValidationError(f"sample {sample_index} identity is not an object")
        identity_sha = replay_identity_preimage(identity_bytes, preimage_bytes)
    except IdentityReplayError as error:
        raise ValidationError(f"sample {sample_index} identity/preimage replay failed: {error}") from error
    except (json.JSONDecodeError, UnicodeError, RecursionError) as error:
        raise ValidationError(f"sample {sample_index} identity JSON is invalid") from error
    if set(identity) != IDENTITY_FIELDS or identity.get("sample_index") != sample_index:
        raise ValidationError(f"sample {sample_index} identity schema or index differs")
    expected_snapshot = campaign["request"]["source"]["source_snapshot_sha256"]
    if identity.get("cross_build_policy") != "same_source_snapshot_required":
        raise ValidationError(f"sample {sample_index} identity cross-build policy is unsupported")
    for role in ("producer", "consumer"):
        build = identity.get(f"{role}_build_identity")
        if (identity.get(f"{role}_source_snapshot_sha256") != expected_snapshot
                or not isinstance(build, Mapping)
                or build.get("source_snapshot_sha256") != expected_snapshot):
            raise ValidationError(f"sample {sample_index} identity snapshot differs from the selected capsule")
    for field in (
        "source_mesh_topology_sha256", "modal_mesh_topology_fingerprint_v3",
        "equilibrium_material_signature", "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature", "material_signature",
        "material_provenance_signature", "producer_material_provenance_signature",
    ):
        _digest(identity.get(field), f"sample {sample_index} identity.{field}")

    try:
        replay_equilibrium_identity_preimages(identity_bytes)
    except EquilibriumIdentityReplayError as error:
        raise ValidationError(
            f"sample {sample_index} canonical equilibrium identity preimage replay failed: {error}"
        ) from error

    eq_schema = _string(identity.get("equilibrium_artifact_schema"), "equilibrium_artifact_schema")
    state_schema = _string(identity.get("linearization_state_schema"), "linearization_state_schema")
    sidecar_pair = SIDECAR_SCHEMA_PAIRS.get((eq_schema, state_schema))
    if sidecar_pair is None:
        raise ValidationError(
            f"sample {sample_index} identity declares an unsupported equilibrium/linearization schema pair"
        )
    eq_filename, state_filename, eq_digest_fn = sidecar_pair
    expected_eq_path = stem + eq_filename
    expected_state_path = stem + state_filename
    if identity.get("equilibrium_artifact_path") != expected_eq_path:
        raise ValidationError(f"sample {sample_index} equilibrium artifact path differs from schema pair")
    if identity.get("linearization_state_path") != expected_state_path:
        raise ValidationError(f"sample {sample_index} linearization state path differs from schema pair")
    eq_path, eq_binding = _bound_artifact(campaign, expected_eq_path)
    state_path, state_binding = _bound_artifact(campaign, expected_state_path)
    equilibrium = _read_json(eq_path, f"sample {sample_index} equilibrium artifact")
    state = _read_json(state_path, f"sample {sample_index} linearization state")
    if equilibrium.get("schema_version") != eq_schema or state.get("schema_version") != state_schema:
        raise ValidationError(f"sample {sample_index} sidecar schema differs from identity")

    mode = raw_modes[(sample_index, 0)]
    parsed = native_modes[(sample_index, 0)]
    eq_sha = _digest(equilibrium.get("content_sha256"), f"sample {sample_index} equilibrium content digest")
    replayed_eq_sha = _recompute_semantic_digest(
        eq_digest_fn, equilibrium, f"sample {sample_index} equilibrium artifact"
    )
    if replayed_eq_sha != eq_sha:
        raise ValidationError(f"sample {sample_index} equilibrium artifact semantic content digest differs")
    expected_equilibrium_id = f"{eq_schema}:{eq_sha.removeprefix('sha256:')}"
    if equilibrium.get("equilibrium_id") != expected_equilibrium_id:
        raise ValidationError(f"sample {sample_index} equilibrium artifact id differs from semantic digest")

    state_sha = _digest(state.get("content_sha256"), f"sample {sample_index} linearization content digest")
    replayed_state_sha = _recompute_semantic_digest(
        linearization_state_v7_digest, state, f"sample {sample_index} linearization state"
    )
    if replayed_state_sha != state_sha:
        raise ValidationError(f"sample {sample_index} linearization state semantic content digest differs")
    if state.get("source_equilibrium_artifact") != eq_sha:
        raise ValidationError(f"sample {sample_index} linearization state source equilibrium digest differs")
    if state.get("source_equilibrium_id") != expected_equilibrium_id:
        raise ValidationError(f"sample {sample_index} linearization state source equilibrium id differs")
    expected_state_id = f"{state_schema}:{state_sha.removeprefix('sha256:')}"
    if state.get("linearization_state_id") != expected_state_id:
        raise ValidationError(f"sample {sample_index} linearization state id differs from semantic digest")

    identity_sha = _digest(identity_sha, f"sample {sample_index} replayed identity digest")
    bindings = {
        "equilibrium_artifact_sha256": (
            eq_sha, identity.get("equilibrium_artifact_sha256"), mode.get("equilibrium_artifact_sha256"),
            provenance.get("equilibrium_artifact_sha256"),
        ),
        "linearization_state_sha256": (
            state_sha, identity.get("linearization_state_sha256"), mode.get("linearization_state_sha256"),
            provenance.get("linearization_state_sha256"),
        ),
        "linearization_identity_sha256": (identity_sha, provenance.get("linearization_identity_sha256")),
    }
    for name, values in bindings.items():
        for value in values:
            _digest(value, f"sample {sample_index} {name}")
        if any(value != values[0] for value in values[1:]):
            raise ValidationError(f"sample {sample_index} local {name} binding differs")

    for identity_field, eq_field in (("material_signature", "material_signature"),):
        if identity.get(identity_field) != equilibrium.get(eq_field):
            raise ValidationError(f"sample {sample_index} equilibrium {eq_field} differs from identity")
    # These artifact fields are legacy payload digests. The canonical static
    # physics and boundary signatures live in identity v2 and are replayed
    # from their exact preimage JSON above; do not compare unlike digest roles.
    _digest(equilibrium.get("physics_signature"), f"sample {sample_index} legacy physics signature")
    _digest(equilibrium.get("boundary_signature"), f"sample {sample_index} legacy boundary signature")
    nodes = identity.get("node_count")
    if isinstance(nodes, bool) or not isinstance(nodes, int) or nodes < 1:
        raise EvidenceUnavailable(f"sample {sample_index} identity.node_count is unavailable")
    m0_sha = _m0_fingerprint(equilibrium.get("m0"), nodes, sample_index)
    if identity.get("equilibrium_content_sha256") != m0_sha:
        raise ValidationError(
            f"sample {sample_index} equilibrium_content_sha256 does not bind to source M0"
        )

    mode_identity = {}
    for field in MODE_DIGEST_FIELDS:
        mode_identity[field] = _digest(mode.get(field), f"sample {sample_index} spectrum.{field}")
        if field not in provenance:
            raise EvidenceUnavailable(f"sample {sample_index} manifest is missing {field}")
        if provenance.get(field) != mode.get(field):
            raise ValidationError(f"sample {sample_index} spectrum/manifest {field} differs")
    if identity["modal_mesh_topology_fingerprint_v3"] != mode_identity["source_mesh_topology_sha256"]:
        raise ValidationError(
            f"sample {sample_index} spectrum source_mesh_topology_sha256 differs from modal mesh identity"
        )
    mode_identity["assembly_kind"] = _string(mode.get("assembly_kind"), f"sample {sample_index} assembly_kind")
    for field in MANIFEST_DIGEST_FIELDS:
        _digest(provenance.get(field), f"sample {sample_index} manifest.{field}")
    _string(provenance.get("operator_dictionary_version"), f"sample {sample_index} operator dictionary version")
    if provenance.get("linearization_identity_sha256") != identity_sha:
        raise ValidationError(f"sample {sample_index} manifest identity digest differs")
    if provenance.get("operator_dictionary_version") != manifest.get("operator_dictionary_version"):
        raise ValidationError(f"sample {sample_index} operator dictionary version differs in manifest")

    projection = {field: identity[field] for field in STABLE_IDENTITY_FIELDS}
    projection.update(mode_identity)
    projection.update({
        "source_m0_sha256": m0_sha,
        "operator_dictionary_version": _string(manifest.get("operator_dictionary_version"), "manifest.operator_dictionary_version"),
        "physics_contract_version": _string(manifest.get("physics_contract_version"), "manifest.physics_contract_version"),
    })
    csv_frequency = _finite(campaign["rows"][sample_index]["frequency_hz"], f"sample {sample_index} CSV frequency")
    native_frequency = _finite(parsed["frequency_hz"], f"sample {sample_index} spectrum frequency")
    if not math.isclose(csv_frequency, native_frequency,
                        rel_tol=MAX_PROBE_RELATIVE_TOLERANCE, abs_tol=1.0e-6):
        raise ValidationError(f"sample {sample_index} CSV and spectrum frequencies differ")
    return {
        "projection": projection, "frequency_hz": native_frequency,
        "residual_relative_l2": parsed["residual_relative_l2"],
        "equilibrium_artifact_sha256": eq_sha, "linearization_state_sha256": state_sha,
        "equilibrium_artifact_bytes_sha256": "sha256:" + eq_binding["sha256"],
        "linearization_identity_sha256": identity_sha,
        "raw_artifact_bindings": [identity_binding, preimage_binding, eq_binding, state_binding],
    }


def _load_native_identity(campaign, mode):
    spectrum_path, spectrum_binding = _bound_artifact(campaign, SPECTRUM_PATH)
    manifest_path, manifest_binding = _bound_artifact(campaign, MANIFEST_PATH)
    try:
        native_modes = load_spectrum_v3_modes(spectrum_path)
    except (OSError, ValueError) as error:
        raise ValidationError(f"{mode} native spectrum validation failed: {error}") from error
    if set(native_modes) != {(i, 0) for i in SAMPLE_INDICES}:
        raise ValidationError(f"{mode} spectrum must cover exact samples 0 through 14 at raw mode 0")
    spectrum = _read_json(spectrum_path, f"{mode} native spectrum")
    if not isinstance(spectrum.get("samples"), list):
        raise EvidenceUnavailable(f"{mode} spectrum samples are unavailable")
    raw_modes = {}
    for sample in spectrum["samples"]:
        if not isinstance(sample, Mapping) or not isinstance(sample.get("modes"), list):
            raise ValidationError(f"{mode} spectrum sample is malformed")
        index = sample.get("sample_index")
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValidationError(f"{mode} spectrum sample index is malformed")
        for item in sample["modes"]:
            if not isinstance(item, Mapping):
                raise ValidationError(f"{mode} spectrum mode is malformed")
            raw_modes[(index, item.get("raw_mode_index", item.get("index")))] = item

    manifest = _read_json(manifest_path, f"{mode} frequency-domain manifest")
    provenance = _object(manifest.get("native_provenance_by_sample"), f"{mode} native_provenance_by_sample")
    if set(provenance) != {str(i) for i in SAMPLE_INDICES}:
        raise EvidenceUnavailable(f"{mode} manifest native provenance does not cover samples 0 through 14")
    periodic = _digest(manifest.get("periodic_mesh_certificate_sha256"), f"{mode} manifest periodic certificate")
    samples = {}
    for index in SAMPLE_INDICES:
        mode_item = raw_modes.get((index, 0))
        if mode_item is None:
            raise EvidenceUnavailable(f"{mode} spectrum is missing sample {index} raw mode 0")
        vector = mode_item.get("k_vector")
        if not isinstance(vector, list) or len(vector) != 3:
            raise EvidenceUnavailable(f"{mode} spectrum sample {index} k vector is missing")
        for axis, (actual, expected) in enumerate(zip(vector, plotting.EXPECTED_VECTORS[index])):
            value = _finite(actual, f"{mode} sample {index} k_vector[{axis}]")
            if not math.isclose(value, expected, rel_tol=1.0e-12, abs_tol=1.0e-12):
                raise ValidationError(f"{mode} spectrum sample {index} k vector differs from signed-fifteen")
        entry = provenance[str(index)]
        if not isinstance(entry, Mapping):
            raise ValidationError(f"{mode} manifest provenance sample {index} is malformed")
        sample = _sample_identity(campaign, native_modes, raw_modes, manifest, entry, index)
        if entry.get("periodic_mesh_certificate_sha256") != periodic:
            raise ValidationError(f"{mode} sample {index} periodic certificate differs from manifest header")
        samples[index] = sample
    return {
        "status": "pass", "sample_count": SAMPLE_COUNT, "sample_indices": list(SAMPLE_INDICES),
        "samples": samples, "artifact_bindings": [spectrum_binding, manifest_binding],
        "cross_campaign_fields": [
            *(f"linearization_identity_v2.{field}" for field in STABLE_IDENTITY_FIELDS),
            "equilibrium_artifact.m0 -> recomputed equilibrium_content_sha256",
            *(f"spectrum_v3.{field}" for field in (
                "source_mesh_topology_sha256", "periodic_mesh_certificate_sha256",
                "phase_constraint_sha256", "assembly_kind",
            )),
            "frequency_domain_manifest.operator_dictionary_version",
            "frequency_domain_manifest.physics_contract_version",
        ],
        "per_run_bound_fields": [
            "equilibrium_artifact_sha256 -> replayed semantic content_sha256",
            "linearization_state_sha256 -> replayed semantic content_sha256 and source equilibrium id",
            "linearization_identity_sha256 -> replayed identity digest and canonical identity preimages",
            "operator_input_signature_sha256 -> spectrum/manifest local binding only",
            "required_artifact_hashes -> raw file SHA-256 and byte size",
        ],
        "not_compared_across_runs": [
            "run ids and stage ids", "artifact paths", "raw output file hashes",
            "per-run equilibrium artifact, linearization state, and identity content digests",
        ],
    }


def _compare_native_identity(serial, adaptive):
    operator_mismatches = []
    for index in SAMPLE_INDICES:
        left = serial["samples"][index]["projection"]
        right = adaptive["samples"][index]["projection"]
        comparable_fields = (name for name in left if name != "operator_input_signature_sha256")
        field = next((name for name in comparable_fields if left.get(name) != right.get(name)), None)
        if field is not None:
            description = {
                "source_m0_sha256": "source M0 fingerprint",
                "equilibrium_content_sha256": "source M0 accepted-state digest",
            }.get(field, field)
            raise ValidationError(f"serial/adaptive physical identity differs at sample {index}: {description}")
        serial_operator = left.get("operator_input_signature_sha256")
        adaptive_operator = right.get("operator_input_signature_sha256")
        if serial_operator != adaptive_operator:
            operator_mismatches.append({
                "sample_index": index,
                "serial_sha256": serial_operator,
                "adaptive_sha256": adaptive_operator,
            })
    operator_status = "not_verified" if operator_mismatches else "pass"
    operator_reason = None if not operator_mismatches else (
        "operator_input_signature_sha256 differs across runs, but the published digest includes per-run "
        "equilibrium/state lineage and no assembled-input preimage is available to distinguish lineage-only "
        "changes from physical operator changes"
    )
    return {
        "status": operator_status, "sample_count": SAMPLE_COUNT, "sample_indices": list(SAMPLE_INDICES),
        "fields_compared": serial["cross_campaign_fields"],
        "per_run_binding_fields": serial["per_run_bound_fields"],
        "not_compared_across_runs": serial["not_compared_across_runs"],
        "same_compared_physical_identity_fields": True,
        "operator_input_cross_run": {
            "status": operator_status,
            "reason": operator_reason,
            "mismatching_sample_count": len(operator_mismatches),
            "mismatches": operator_mismatches,
            "exact_digest_equality_is_sufficient": True,
            "different_digest_is_not_a_physical_mismatch_claim": True,
        },
        "campaign_artifact_bindings": {
            "serial": {
                "spectrum_and_manifest": serial["artifact_bindings"],
                "sample_sidecars": {
                    str(index): serial["samples"][index]["raw_artifact_bindings"]
                    for index in SAMPLE_INDICES
                },
            },
            "adaptive": {
                "spectrum_and_manifest": adaptive["artifact_bindings"],
                "sample_sidecars": {
                    str(index): adaptive["samples"][index]["raw_artifact_bindings"]
                    for index in SAMPLE_INDICES
                },
            },
        },
    }


def _numeric_parity(serial, adaptive):
    rows = []
    freq_pass = delta_pass = ceiling_pass = True
    max_freq = max_delta = max_residual = 0.0
    for index in SAMPLE_INDICES:
        left, right = serial["samples"][index], adaptive["samples"][index]
        sf = _finite(left["frequency_hz"], f"serial sample {index} frequency")
        af = _finite(right["frequency_hz"], f"adaptive sample {index} frequency")
        sr = _finite(left["residual_relative_l2"], f"serial sample {index} residual", nonnegative=True)
        ar = _finite(right["residual_relative_l2"], f"adaptive sample {index} residual", nonnegative=True)
        fd, rd = abs(sf - af), abs(sr - ar)
        fok = math.isclose(sf, af, rel_tol=MAX_PROBE_RELATIVE_TOLERANCE, abs_tol=1.0e-6)
        rok = rd <= DENSE_CERTIFICATION_TOLERANCE
        cok = sr <= DENSE_CERTIFICATION_TOLERANCE and ar <= DENSE_CERTIFICATION_TOLERANCE
        freq_pass, delta_pass, ceiling_pass = freq_pass and fok, delta_pass and rok, ceiling_pass and cok
        max_freq, max_delta = max(max_freq, fd), max(max_delta, rd)
        max_residual = max(max_residual, sr, ar)
        rows.append({
            "sample_index": index, "raw_mode_index": 0,
            "serial_frequency_hz": sf, "adaptive_frequency_hz": af,
            "frequency_difference_hz": fd, "frequency_within_tolerance": fok,
            "serial_residual_relative_l2": sr, "adaptive_residual_relative_l2": ar,
            "residual_difference": rd, "residual_difference_within_tolerance": rok,
            "residual_within_physical_ceiling": cok,
        })
    status = "pass" if freq_pass and delta_pass and ceiling_pass else "not_verified"
    return {
        "status": status, "qualification": "NOT VERIFIED", "sample_count": SAMPLE_COUNT,
        "sample_indices": list(SAMPLE_INDICES),
        "frequency_tolerance": {"relative": MAX_PROBE_RELATIVE_TOLERANCE, "absolute_hz": 1.0e-6},
        "frequency_within_tolerance": freq_pass, "max_frequency_difference_hz": max_freq,
        "residual_difference_tolerance": DENSE_CERTIFICATION_TOLERANCE,
        "residual_difference_within_tolerance": delta_pass, "max_residual_difference": max_delta,
        "residual_ceiling": {
            "status": "pass" if ceiling_pass else "not_verified",
            "limit": DENSE_CERTIFICATION_TOLERANCE, "max_observed": max_residual,
            "serial_and_adaptive_within_limit": ceiling_pass,
        },
        "comparisons": rows,
    }

def _scheduler_report(campaign, mode, native, *, required):
    journal = Path(campaign["case"]) / JOURNAL_PATH
    relative = JOURNAL_PATH if journal.exists() or journal.is_symlink() else REPORT_PATH
    path = Path(campaign["case"]) / relative
    if not path.is_file():
        if required:
            return {"status": "not_verified", "present": False, "required": True,
                    "reason": "adaptive signed-fifteen scheduler report is missing", "sample_indices": []}
        return {"status": "not_required", "present": False, "required": False,
                "reason": "serial producer may omit its process-pool report", "sample_indices": []}
    try:
        path, binding = _bound_artifact(campaign, relative)
    except EvidenceUnavailable as error:
        return {"status": "not_verified", "present": True, "required": required,
                "reason": str(error), "sample_indices": []}
    raw = _read_json(path, f"{mode} scheduler report")
    if relative == JOURNAL_PATH and raw.get("schema_version") != "fullmag.eigen.admission_journal.v1":
        raise ValidationError(f"{mode} terminal journal schema is invalid")
    try:
        validation = validate_parallel_execution_report(
            path, expected_mode=mode, expected_sample_count=len(POOL_SAMPLE_INDICES),
            require_concurrency=required,
        )
    except SchedulerValidationError as error:
        raise ValidationError(f"{mode} scheduler report is invalid: {error}") from error
    report = raw.get("report") if "schema_version" in raw else raw
    if report is None:
        return {"status": "not_verified", "present": True, "required": required,
                "reason": "bounded scheduler journal omitted its report body",
                "validation": validation, "artifact_binding": binding, "sample_indices": []}
    if not isinstance(report, Mapping):
        raise ValidationError(f"{mode} scheduler report body is malformed")
    expected = {"mode": mode, **plotting.EXPECTED_POLICY}
    if not isinstance(report.get("policy"), Mapping) or dict(report["policy"]) != expected:
        raise ValidationError(f"{mode} scheduler policy differs from signed-fifteen pin")
    inputs = report.get("inputs")
    if not isinstance(inputs, list):
        raise EvidenceUnavailable(f"{mode} scheduler inputs are missing")
    indices = [item.get("sample_index") if isinstance(item, Mapping) else None for item in inputs]
    if indices != list(POOL_SAMPLE_INDICES):
        raise ValidationError(f"{mode} scheduler sample indices must be exactly 1 through 14; sample 0 is the seed")
    if validation.get("terminal_state") != "completed":
        return {"status": "not_verified", "present": True, "required": required,
                "reason": "scheduler report has no completed terminal state",
                "validation": validation, "artifact_binding": binding, "sample_indices": indices}
    by_index = {}
    for item in inputs:
        index = item["sample_index"]
        if index in by_index:
            raise ValidationError(f"{mode} scheduler report duplicates sample {index}")
        by_index[index] = item
    missing_raw_bindings = []
    for index in POOL_SAMPLE_INDICES:
        _digest(by_index[index].get("plan_sha256"), f"{mode} sample {index} plan_sha256")
        input_sha = _digest(by_index[index].get("equilibrium_artifact_sha256"),
                            f"{mode} sample {index} input equilibrium raw SHA")
        published_raw_sha = native["samples"][index].get("equilibrium_artifact_bytes_sha256")
        if input_sha != published_raw_sha:
            missing_raw_bindings.append(index)
    if missing_raw_bindings:
        return {"status": "not_verified", "present": True, "required": required,
                "reason": "scheduler input raw SHA has no matching hash-bound source artifact; semantic content SHA is a different digest role",
                "unbound_sample_indices": missing_raw_bindings,
                "validation": validation, "artifact_binding": binding,
                "sample_indices": indices, "input_bindings": by_index}
    concurrency = validation.get("concurrency", {})
    quality = validation.get("resource_quality", {})
    if required and (
        validation.get("status") != "pass"
        or concurrency.get("status") != "observed_from_active_count"
        or quality.get("status") != "pass"
    ):
        return {"status": "not_verified", "present": True, "required": True,
                "reason": "adaptive scheduler lacks completion, coactivity, or resource-quality evidence",
                "validation": validation, "artifact_binding": binding, "sample_indices": indices,
                "concurrency": concurrency, "resource_quality": quality, "input_bindings": by_index}
    if not required and validation.get("status") != "pass":
        return {"status": "not_verified", "present": True, "required": False,
                "reason": "serial scheduler report lacks verified completion or telemetry",
                "validation": validation, "artifact_binding": binding, "sample_indices": indices}
    return {"status": "pass", "present": True, "required": required,
            "validation": validation, "artifact_binding": binding, "sample_indices": indices,
            "concurrency": concurrency, "resource_quality": quality, "input_bindings": by_index}


def _scheduler_input_parity(serial, adaptive):
    if serial.get("status") == "not_required":
        return {"status": "not_required", "reason": "serial report is optional",
                "sample_count": len(POOL_SAMPLE_INDICES)}
    if serial.get("status") != "pass" or adaptive.get("status") != "pass":
        return {"status": "not_verified", "reason": "both scheduler reports must pass",
                "sample_count": len(POOL_SAMPLE_INDICES)}
    si, ai = serial.get("input_bindings"), adaptive.get("input_bindings")
    if not isinstance(si, Mapping) or not isinstance(ai, Mapping):
        raise ValidationError("serial/adaptive scheduler reports have no bound inputs")
    differing_plans = [index for index in POOL_SAMPLE_INDICES
                       if si[index].get("plan_sha256") != ai[index].get("plan_sha256")]
    if differing_plans:
        return {"status": "not_verified", "sample_count": len(POOL_SAMPLE_INDICES),
                "sample_indices": list(POOL_SAMPLE_INDICES),
                "differing_plan_sample_indices": differing_plans,
                "reason": "full worker plan hashes include run-local artifact paths and execution policy; no typed physical-plan projection is published",
                "different_digest_is_not_a_physical_mismatch_claim": True}
    return {
        "status": "pass", "sample_count": len(POOL_SAMPLE_INDICES),
        "sample_indices": list(POOL_SAMPLE_INDICES), "same_per_sample_plan_sha256": True,
        "equilibrium_binding_scope": "each report input binds to its own native sample",
        "seed_sample_zero_outside_pool": True,
    }


def _not_verified_report(reason):
    return {
        "schema": "fullmag.signed-de-campaign-parity.v1", "status": "not_verified",
        "qualification": "NOT VERIFIED", "reason": reason,
        "pending_requirements": [
            "two complete verified signed-fifteen campaigns",
            "per-sample native identity and residual evidence",
            "adaptive scheduler completion, resource quality, and coactivity",
            "scientific convergence and qualification",
        ],
    }


def validate_signed_de_campaign_parity(serial_dir: str | Path, adaptive_dir: str | Path) -> dict[str, Any]:
    """Compare two canonical serial/adaptive signed-fifteen campaign batches."""
    try:
        serial_campaign = _load_campaign(serial_dir, "serial")
        adaptive_campaign = _load_campaign(adaptive_dir, "adaptive")
    except EvidenceUnavailable as error:
        return _not_verified_report(str(error))
    if serial_campaign["batch"] == adaptive_campaign["batch"]:
        raise ValidationError("serial and adaptive campaigns must be distinct batches")
    try:
        serial_inputs = _immutable_projection(serial_campaign, "serial")
        adaptive_inputs = _immutable_projection(adaptive_campaign, "adaptive")
    except EvidenceUnavailable as error:
        return _not_verified_report(str(error))
    for field in serial_inputs:
        if serial_inputs[field] != adaptive_inputs[field]:
            raise ValidationError(f"serial/adaptive immutable input differs: {field}")
    immutable = {
        "status": "pass",
        "fields_compared": [
            "model_sha256", "model_source", "source.resolved_commit",
            "source.source_snapshot_sha256", "job.source_digest", "orchestrator_sha256",
            *(f"runtime.{field}" for field in RUNTIME_FIELDS),
            "model", "parameters", "frequency_window_hz",
            *(f"parallel_policy.{field}" for field in plotting.EXPECTED_POLICY),
        ],
        "execution_mode_field": "parallel_campaign.mode",
        "execution_modes": {"serial": "serial", "adaptive": "adaptive"},
        "same_immutable_solver_inputs": True,
        "excluded_run_local_fields": [
            "source.capsule_relative", "run-request.output_dir", "runtime.artifact_root",
            "run and job ids", "artifact paths and raw output hashes",
        ],
    }
    try:
        serial_native = _load_native_identity(serial_campaign, "serial")
        adaptive_native = _load_native_identity(adaptive_campaign, "adaptive")
    except EvidenceUnavailable as error:
        result = _not_verified_report(str(error))
        result.update({
            "immutable_inputs": immutable,
            "native_identity": {"status": "not_verified", "reason": str(error)},
            "numeric_parity": {"status": "not_verified", "reason": "native identity is unavailable"},
            "scheduler": {
                "status": "not_verified", "sample_zero_seed_outside_pool": True,
                "serial": {"status": "not_verified", "reason": str(error)},
                "adaptive": {"status": "not_verified", "reason": str(error)},
                "serial_adaptive_input_parity": {"status": "not_verified"},
            },
        })
        return result
    identity = _compare_native_identity(serial_native, adaptive_native)
    numeric = _numeric_parity(serial_native, adaptive_native)
    serial_scheduler = _scheduler_report(serial_campaign, "serial", serial_native, required=False)
    adaptive_scheduler = _scheduler_report(adaptive_campaign, "adaptive", adaptive_native, required=True)
    scheduler_parity = _scheduler_input_parity(serial_scheduler, adaptive_scheduler)
    ss = "pass" if serial_scheduler["status"] == "not_required" else serial_scheduler["status"]
    ps = "pass" if scheduler_parity["status"] == "not_required" else scheduler_parity["status"]
    status = "pass" if all(value == "pass" for value in (
        identity["status"], numeric["status"], ss, adaptive_scheduler["status"], ps,
    )) else "not_verified"
    return {
        "schema": "fullmag.signed-de-campaign-parity.v1",
        "status": status, "qualification": "NOT VERIFIED",
        "campaigns": {
            "serial_batch": str(serial_campaign["batch"]),
            "adaptive_batch": str(adaptive_campaign["batch"]),
            "sampling": "signed-fifteen", "sample_count": SAMPLE_COUNT,
            "sample_indices": list(SAMPLE_INDICES), "raw_mode_index": 0,
        },
        "immutable_inputs": immutable, "native_identity": identity, "numeric_parity": numeric,
        "scheduler": {
            "status": "pass" if adaptive_scheduler["status"] == "pass"
                and scheduler_parity["status"] in {"pass", "not_required"} else "not_verified",
            "sample_zero_seed_outside_pool": True,
            "adaptive_expected_sample_count": len(POOL_SAMPLE_INDICES),
            "adaptive": adaptive_scheduler, "serial": serial_scheduler,
            "serial_adaptive_input_parity": scheduler_parity,
        },
        "pending_requirements": [
            "mesh, airbox, thickness, and mode-count convergence",
            "scientific comparison to an independently justified reference",
        ],
    }


def _output_path(output: Path, serial: Path, adaptive: Path) -> Path:
    resolved = output.expanduser().resolve()
    for source in (serial.resolve(), adaptive.resolve()):
        try:
            resolved.relative_to(source)
        except ValueError:
            continue
        raise ValidationError("report output must be outside both input campaign directories")
    if resolved.exists() or resolved.is_symlink():
        raise ValidationError(f"refusing to overwrite existing report: {resolved}")
    if not resolved.parent.is_dir() or resolved.parent.is_symlink():
        raise ValidationError("report output parent must be an existing regular directory")
    return resolved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serial_batch", type=Path)
    parser.add_argument("adaptive_batch", type=Path)
    parser.add_argument("--output", type=Path, required=True,
                        help="new report path outside both input batches")
    args = parser.parse_args(argv)
    try:
        output = _output_path(args.output, args.serial_batch, args.adaptive_batch)
    except ValidationError as error:
        output = None
        report = {
            "schema": "fullmag.signed-de-campaign-parity.v1",
            "status": "rejected", "qualification": "NOT VERIFIED", "reason": str(error),
        }
    else:
        try:
            report = validate_signed_de_campaign_parity(args.serial_batch, args.adaptive_batch)
        except EvidenceUnavailable as error:
            report = _not_verified_report(str(error))
        except ValidationError as error:
            report = {
                "schema": "fullmag.signed-de-campaign-parity.v1",
                "status": "rejected", "qualification": "NOT VERIFIED", "reason": str(error),
            }
    if output is not None:
        try:
            with output.open("x", encoding="utf-8", newline="\n") as stream:
                json.dump(report, stream, indent=2, sort_keys=True, allow_nan=False)
                stream.write("\n")
        except OSError as error:
            print(f"cannot write separate parity report: {error}", file=sys.stderr)
            return 1
    print(json.dumps(report, indent=2, sort_keys=True, allow_nan=False))
    if report.get("status") == "pass":
        return 0
    return 2 if report.get("status") == "not_verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
