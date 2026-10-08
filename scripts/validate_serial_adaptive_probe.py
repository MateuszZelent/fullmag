"""Fail-closed postsolve comparison for the serial/adaptive DE probe.

This module consumes two already-created canonical probe batch directories.  It
binds both ``run-result.json`` receipts, re-runs the existing metadata, native
solver-artifact and row validators, and then compares the actual per-sample
frequency/residual rows.  It deliberately does not create a serial process-pool
report: the serial producer may omit that artifact.  A missing adaptive report
or an unbound report is an explicit ``NOT VERIFIED`` state.

The result separates execution evidence, structural artifact evidence,
numeric parity, scheduler co-activity and scientific qualification.  A green
comparison therefore remains an execution/parity result and never a scientific
qualification of the dispersion.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
import sys
from typing import Any

from managed_runtime_artifact_root import (
    RuntimeArtifactRootError,
    resolve_runtime_artifact_root,
)
from de_pilot_receipts import verify_required_artifact_hash, validate_de_pilot_receipts
from validate_de_smoke_rows import (
    DENSE_CERTIFICATION_TOLERANCE,
    MAX_PROBE_RELATIVE_TOLERANCE,
    PARALLEL_PROBE_VECTORS_RAD_PER_M,
    load_spectrum_v3_modes,
    validate_parallel_probe_metadata,
    validate_parallel_probe_solver_artifacts,
    validate_rows,
)
from validate_parallel_execution_report import (
    REPORT_PROTOCOL,
    ValidationError,
    compare_serial_adaptive_policy,
    validate_parallel_execution_report,
)


PILOT = "de-smoke-parallel-probe"
REPORT_RELATIVE_PATH = "eigen/parallel_execution.v1.json"
MANIFEST_RELATIVE_PATH = "frequency_domain/manifest.v1.json"
EXPECTED_SAMPLE_COUNT = len(PARALLEL_PROBE_VECTORS_RAD_PER_M)
PHYSICAL_RESIDUAL_TOLERANCE = DENSE_CERTIFICATION_TOLERANCE
FREQUENCY_RELATIVE_TOLERANCE = MAX_PROBE_RELATIVE_TOLERANCE
FREQUENCY_ABSOLUTE_TOLERANCE_HZ = 1e-6
RESIDUAL_PARITY_ABSOLUTE_TOLERANCE = PHYSICAL_RESIDUAL_TOLERANCE
MAX_JSON_BYTES = 64 * 1024 * 1024
KNOWN_MODES = frozenset(("serial", "adaptive"))
EXPECTED_POLICY = {
    "max_cpu_percent": 90.0,
    "max_memory_percent": 80.0,
    "memory_reserve_bytes": 1024**3,
    "max_workers": 2,
    "threads_per_worker": 1,
}
_MODEL_SOURCE_MODE_FIELDS = frozenset(("parallel_mode",))
_MODEL_SOURCE_POLICY_MODE = "mode"
_REQUIRED_MANIFEST_DIGESTS = (
    "operator_input_signature_sha256",
)
_MESH_IDENTITY_KEYS = (
    "mesh_identity",
    "source_mesh_topology_sha256",
    "modal_mesh_topology_fingerprint_v3",
    "periodic_mesh_certificate_sha256",
)


class EvidenceUnavailable(ValidationError):
    """A required proof is missing without claiming that the run was invalid."""


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _reject_nonfinite_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is not allowed: {value}")


def _load_json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise EvidenceUnavailable(f"missing {label}: {path}") from error
    if len(raw) > MAX_JSON_BYTES:
        raise ValidationError(f"{label} exceeds the bounded JSON size")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValidationError(f"{label} is not strict JSON: {error}") from error
    if not isinstance(value, Mapping):
        raise ValidationError(f"{label} must be a JSON object")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{label} must be a non-empty string")
    return value


def _finite(value: Any, label: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or (minimum is not None and result < minimum):
        raise ValidationError(f"{label} must be a finite number in the allowed range")
    return result


def _digest(value: Any, label: str) -> str:
    value = _string(value, label)
    bare = value[7:] if value.startswith("sha256:") else value
    if len(bare) != 64 or any(character not in "0123456789abcdefABCDEF" for character in bare):
        raise ValidationError(f"{label} must be a bare or sha256:<64 hex> digest")
    return bare.lower()


def _digest_prefixed(value: Any, label: str) -> str:
    return "sha256:" + _digest(value, label)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _copy_without_policy_mode(value: Any) -> Any:
    if isinstance(value, Mapping):
        copied: dict[str, Any] = {}
        for key, item in value.items():
            if key == "parallel_mode":
                continue
            if key == "policy" and isinstance(item, Mapping):
                policy = dict(item)
                policy.pop("mode", None)
                copied[key] = _copy_without_policy_mode(policy)
            else:
                copied[key] = _copy_without_policy_mode(item)
        return copied
    if isinstance(value, list):
        return [_copy_without_policy_mode(item) for item in value]
    return value


def _strict_equal_without_policy_mode(left: Any, right: Any, label: str) -> None:
    if _canonical_json(_copy_without_policy_mode(left)) != _canonical_json(
        _copy_without_policy_mode(right)
    ):
        raise ValidationError(f"serial/adaptive {label} differs outside policy mode")


def _normalized_probe(value: Mapping[str, Any]) -> Any:
    normalized = _copy_without_policy_mode(value)
    if isinstance(normalized, Mapping):
        normalized = dict(normalized)
        normalized.pop("mode", None)
    return normalized


def _validate_policy(value: Any, mode: str, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{label} must be an object")
    if value.get("mode") != mode:
        raise ValidationError(f"{label}.mode does not match {mode}")
    for key, expected in EXPECTED_POLICY.items():
        actual = value.get(key)
        if isinstance(expected, float):
            if isinstance(actual, bool) or not isinstance(actual, (int, float)) \
                    or not math.isfinite(float(actual)) or float(actual) != expected:
                raise ValidationError(f"{label}.{key} is not pinned")
        elif type(actual) is not type(expected) or actual != expected:
            raise ValidationError(f"{label}.{key} is not pinned")
    return dict(value)


def _content_identity(value: Mapping[str, Any], field: str, label: str) -> str:
    """Require explicit native identity; never substitute a raw-file digest."""
    if value.get(field) is None:
        raise EvidenceUnavailable(f"{label} is missing explicit {field}")
    return _digest_prefixed(value[field], f"{label}.{field}")


def _validate_model_source(value: Any, mode: str, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{label} must be an object")
    required = (
        "kind", "source_commit", "path", "sha256", "manifest_path",
        "manifest_sha256", "equilibrium_artifact_sha256", "equilibrium_artifact_role",
        "linearization_state_sha256", "linearization_state_role", "parallel_mode",
        "policy", "required_cpu_cores", "required_memory_bytes",
    )
    for key in required:
        if key not in value:
            raise ValidationError(f"{label} is missing {key}")
    _string(value["kind"], f"{label}.kind")
    _string(value["source_commit"], f"{label}.source_commit")
    _string(value["path"], f"{label}.path")
    _digest(value["sha256"], f"{label}.sha256")
    _string(value["manifest_path"], f"{label}.manifest_path")
    _digest(value["manifest_sha256"], f"{label}.manifest_sha256")
    _digest(value["equilibrium_artifact_sha256"], f"{label}.equilibrium_artifact_sha256")
    _string(value["equilibrium_artifact_role"], f"{label}.equilibrium_artifact_role")
    _digest(value["linearization_state_sha256"], f"{label}.linearization_state_sha256")
    _string(value["linearization_state_role"], f"{label}.linearization_state_role")
    if value["parallel_mode"] != mode:
        raise ValidationError(f"{label}.parallel_mode does not match {mode}")
    _validate_policy(value["policy"], mode, f"{label}.policy")
    if type(value["required_cpu_cores"]) is not int or value["required_cpu_cores"] != 4:
        raise ValidationError(f"{label}.required_cpu_cores is not pinned")
    if type(value["required_memory_bytes"]) is not int or value["required_memory_bytes"] != 8 * 1024**3:
        raise ValidationError(f"{label}.required_memory_bytes is not pinned")
    for field in ("equilibrium_artifact_content_sha256", "linearization_state_content_sha256"):
        _content_identity(value, field, label)
    return value


def _validate_parallel_probe(value: Any, mode: str, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{label} must be an object")
    if value.get("schema") != "fullmag.parallel-probe-request.v1":
        raise ValidationError(f"{label}.schema is unsupported")
    if value.get("mode") != mode:
        raise ValidationError(f"{label}.mode does not match {mode}")
    _string(value.get("model_source_commit"), f"{label}.model_source_commit")
    _digest(value.get("model_sha256"), f"{label}.model_sha256")
    _validate_policy(value.get("policy"), mode, f"{label}.policy")
    if type(value.get("required_cpu_cores")) is not int or value["required_cpu_cores"] != 4:
        raise ValidationError(f"{label}.required_cpu_cores is not pinned")
    if type(value.get("required_memory_bytes")) is not int or value["required_memory_bytes"] != 8 * 1024**3:
        raise ValidationError(f"{label}.required_memory_bytes is not pinned")
    _digest(value.get("input_manifest_sha256"), f"{label}.input_manifest_sha256")
    _digest(value.get("equilibrium_artifact_sha256"), f"{label}.equilibrium_artifact_sha256")
    _string(value.get("equilibrium_artifact_role"), f"{label}.equilibrium_artifact_role")
    _digest(value.get("linearization_state_sha256"), f"{label}.linearization_state_sha256")
    _string(value.get("linearization_state_role"), f"{label}.linearization_state_role")
    for field in ("equilibrium_artifact_content_sha256", "linearization_state_content_sha256"):
        _content_identity(value, field, label)
    return value


def _load_receipt(root: Path, mode: str) -> dict[str, Any]:
    root = Path(root)
    if not root.is_dir():
        raise EvidenceUnavailable(f"{mode} batch directory is missing: {root}")
    request = _load_json(root / "run-request.json", f"{mode} run-request")
    result = _load_json(root / "run-result.json", f"{mode} run-result")
    try:
        validate_de_pilot_receipts(request, result, PILOT)
    except (TypeError, ValueError) as error:
        raise ValidationError(f"{mode} run receipt is not completed_unqualified: {error}") from error
    probe = _validate_parallel_probe(request.get("parallel_probe"), mode, f"{mode}.parallel_probe")
    if result.get("parallel_probe") != probe:
        raise ValidationError(f"{mode} result parallel_probe differs from its request")
    model_source_request = request.get("model_source")
    model_source_result = result.get("model_source")
    if model_source_request is None or model_source_result is None:
        raise ValidationError(f"{mode} receipt is missing model_source identity")
    model_source = _validate_model_source(model_source_request, mode, f"{mode}.model_source")
    if model_source_result != model_source:
        raise ValidationError(f"{mode} result model_source differs from its request")
    if _digest(request.get("model_sha256"), f"{mode}.model_sha256") \
            != _digest(probe.get("model_sha256"), f"{mode}.parallel_probe.model_sha256"):
        raise ValidationError(f"{mode} receipt and parallel_probe model hashes differ")
    if _digest(model_source.get("sha256"), f"{mode}.model_source.sha256") \
            != _digest(probe.get("model_sha256"), f"{mode}.parallel_probe.model_sha256"):
        raise ValidationError(f"{mode} model_source and parallel_probe model hashes differ")
    if model_source.get("source_commit") != probe.get("model_source_commit"):
        raise ValidationError(f"{mode} model_source and parallel_probe source commits differ")
    for probe_key, source_key in (
        ("input_manifest_sha256", "manifest_sha256"),
        ("equilibrium_artifact_sha256", "equilibrium_artifact_sha256"),
        ("linearization_state_sha256", "linearization_state_sha256"),
        ("equilibrium_artifact_content_sha256", "equilibrium_artifact_content_sha256"),
        ("linearization_state_content_sha256", "linearization_state_content_sha256"),
    ):
        if _digest(probe.get(probe_key), f"{mode}.parallel_probe.{probe_key}") \
                != _digest(model_source.get(source_key), f"{mode}.model_source.{source_key}"):
            raise ValidationError(
                f"{mode} model_source and parallel_probe {probe_key} differ"
            )
    _strict_equal_without_policy_mode(
        probe.get("policy"), model_source.get("policy"), f"{mode} policy input"
    )
    if request.get("sampling") != "parallel-probe":
        raise ValidationError(f"{mode} receipt has the wrong sampling")
    if request.get("cases") != [PILOT] or request.get("operation") != PILOT + "-numerical-pilot":
        raise ValidationError(f"{mode} receipt does not identify the closed probe operation")
    return {
        "root": root,
        "request": request,
        "result": result,
        "probe": probe,
        "model_source": model_source,
        "job_id": request.get("job", {}).get("job_id") if isinstance(request.get("job"), Mapping) else None,
    }


def _compare_receipts(serial: Mapping[str, Any], adaptive: Mapping[str, Any]) -> dict[str, Any]:
    serial_request = serial["request"]
    adaptive_request = adaptive["request"]
    if serial_request.get("model_sha256") != adaptive_request.get("model_sha256"):
        raise ValidationError("serial/adaptive model_sha256 differs")
    for key in ("source", "runtime"):
        if serial_request.get(key) != adaptive_request.get(key):
            raise ValidationError(f"serial/adaptive immutable {key} identity differs")
    serial_job = serial_request.get("job")
    adaptive_job = adaptive_request.get("job")
    if not isinstance(serial_job, Mapping) or not isinstance(adaptive_job, Mapping):
        raise ValidationError("run receipts are missing job identity")
    serial_job_cmp = dict(serial_job)
    adaptive_job_cmp = dict(adaptive_job)
    serial_job_cmp.pop("job_id", None)
    adaptive_job_cmp.pop("job_id", None)
    if serial_job_cmp != adaptive_job_cmp:
        raise ValidationError("serial/adaptive immutable job identity differs")
    if _canonical_json(_normalized_probe(serial["probe"])) != _canonical_json(
        _normalized_probe(adaptive["probe"])
    ):
        raise ValidationError("serial/adaptive parallel_probe input identity differs outside policy mode")
    _strict_equal_without_policy_mode(
        serial["model_source"], adaptive["model_source"], "model_source input identity"
    )
    return {
        "status": "pass",
        "model_sha256": serial_request["model_sha256"],
        "job_ids": {"serial": serial["job_id"], "adaptive": adaptive["job_id"]},
        "policy_mode_difference_allowed": True,
        "same_source": True,
        "same_runtime": True,
        "same_immutable_job_fields": True,
        "same_model_input_outside_policy_mode": True,
    }


def _first_named_value(value: Any, names: Sequence[str]) -> tuple[str, Any] | None:
    if isinstance(value, Mapping):
        for name in names:
            if name in value:
                return name, value[name]
        for item in value.values():
            found = _first_named_value(item, names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _first_named_value(item, names)
            if found is not None:
                return found
    return None


def _manifest_identity(
    case_dir: Path,
    probe: Mapping[str, Any],
    solver_artifacts: Mapping[str, Any],
) -> dict[str, Any]:
    manifest_path = case_dir / MANIFEST_RELATIVE_PATH
    manifest = _load_json(manifest_path, "frequency-domain manifest")
    if manifest.get("schema_version") != "frequency_domain_manifest.v1":
        raise ValidationError("frequency-domain manifest schema is unsupported")
    if manifest.get("study_product") not in (None, "modal_eigen"):
        raise ValidationError("frequency-domain manifest is not a modal eigen manifest")
    mesh = _first_named_value(manifest, _MESH_IDENTITY_KEYS)
    if mesh is None:
        diagnostics = _load_json(
            case_dir / "eigen/diagnostics/solver.v1.json",
            "solver diagnostics for mesh identity",
        )
        mesh = _first_named_value(diagnostics, _MESH_IDENTITY_KEYS)
    if mesh is None:
        raise EvidenceUnavailable("frequency-domain manifest has no explicit mesh identity")
    mesh_name, mesh_value = mesh
    if isinstance(mesh_value, str):
        mesh_identity: Any = _digest_prefixed(mesh_value, f"manifest.{mesh_name}") \
            if "sha" in mesh_name or "fingerprint" in mesh_name or "certificate" in mesh_name \
            else mesh_value
    elif isinstance(mesh_value, Mapping):
        mesh_identity = json.loads(_canonical_json(mesh_value))
    else:
        raise ValidationError(f"manifest.{mesh_name} has an invalid mesh identity")

    operator = _first_named_value(manifest, _REQUIRED_MANIFEST_DIGESTS)
    if operator is None:
        diagnostics = _load_json(
            case_dir / "eigen/diagnostics/solver.v1.json",
            "solver diagnostics for operator identity",
        )
        operator = _first_named_value(diagnostics, _REQUIRED_MANIFEST_DIGESTS)
    if operator is None:
        raise EvidenceUnavailable("modal artifacts have no operator_input_signature_sha256")
    operator_name, operator_value = operator
    operator_digest = _digest_prefixed(operator_value, f"{operator_name}")

    phase_values = solver_artifacts.get("phase_constraints_by_sample")
    if not isinstance(phase_values, list) or len(phase_values) != EXPECTED_SAMPLE_COUNT:
        raise ValidationError("native solver artifacts do not expose per-sample phase identities")
    phase_constraints = []
    for sample_index, value in enumerate(phase_values):
        if (not isinstance(value, Mapping)
                or isinstance(value.get("sample_index"), bool)
                or value.get("sample_index") != sample_index
                or value.get("k_vector_rad_per_m")
                != list(PARALLEL_PROBE_VECTORS_RAD_PER_M[sample_index])):
            raise ValidationError("native solver phase identity has an invalid sample binding")
        phase_constraints.append({
            "sample_index": sample_index,
            "k_vector_rad_per_m": value["k_vector_rad_per_m"],
            "phase_constraint_sha256": _digest_prefixed(
                value.get("phase_constraint_sha256"), "phase_constraints_by_sample"
            ),
        })
    # Preserve the legacy scalar field as the first-sample summary binding.
    phase_digest = phase_constraints[0]["phase_constraint_sha256"]

    equilibrium_digest = _content_identity(
        probe, "equilibrium_artifact_content_sha256", "parallel_probe"
    )
    reference_linearization_digest = _content_identity(
        probe, "linearization_state_content_sha256", "parallel_probe"
    )
    found_equilibrium = _first_named_value(manifest, ("equilibrium_artifact_sha256",))
    if found_equilibrium is None:
        raise EvidenceUnavailable("manifest has no native equilibrium_artifact_sha256")
    if _digest_prefixed(found_equilibrium[1], "manifest.equilibrium_artifact_sha256") != equilibrium_digest:
        raise ValidationError("manifest.equilibrium_artifact_sha256 differs from the pinned model input content")
    # Reference sidecar provenance is separate from the produced k-dependent state.
    found_state = _first_named_value(manifest, ("linearization_state_sha256",))
    if found_state is None:
        raise EvidenceUnavailable("manifest has no native linearization_state_sha256")
    linearization_digest = _digest_prefixed(found_state[1], "manifest.linearization_state_sha256")
    spectrum = _load_json(case_dir / "eigen/spectrum.v3.json", "native sample identities")
    samples = spectrum.get("samples")
    if not isinstance(samples, list) or len(samples) != EXPECTED_SAMPLE_COUNT:
        raise EvidenceUnavailable("spectrum has no complete native per-sample identities")
    native_states = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, Mapping) or sample.get("sample_index") != index \
                or sample.get("k_vector") != list(PARALLEL_PROBE_VECTORS_RAD_PER_M[index]):
            raise ValidationError("native state identity sample binding differs from the probe")
        modes = sample.get("modes")
        if not isinstance(modes, list) or len(modes) != 1 or not isinstance(modes[0], Mapping):
            raise EvidenceUnavailable("sample has no native mode state identity")
        mode = modes[0]
        native_equilibrium = _content_identity(mode, "equilibrium_artifact_sha256", f"sample[{index}]")
        native_state = _content_identity(mode, "linearization_state_sha256", f"sample[{index}]")
        if native_equilibrium != equilibrium_digest:
            raise ValidationError(f"sample[{index}] native equilibrium differs from the input content")
        native_states.append({"sample_index": index, "k_vector_rad_per_m": sample["k_vector"],
                              "equilibrium_artifact_sha256": native_equilibrium,
                              "linearization_state_sha256": native_state})
    if native_states[0]["linearization_state_sha256"] != linearization_digest:
        raise ValidationError("manifest linearization_state_sha256 differs from first sample native identity")
    periodic = _first_named_value(manifest, ("periodic_mesh_certificate_sha256",))
    periodic_digest = (
        _digest_prefixed(periodic[1], "periodic_mesh_certificate_sha256")
        if periodic is not None else None
    )
    return {
        "schema": "fullmag.serial-adaptive-mesh-identity.v1",
        "mesh_identity_field": mesh_name,
        "mesh_identity": mesh_identity,
        "operator_input_signature_sha256": operator_digest,
        "phase_constraint_sha256": phase_digest,
        "phase_constraints_by_sample": phase_constraints,
        "equilibrium_artifact_sha256": equilibrium_digest,
        "linearization_state_sha256": linearization_digest,
        "reference_linearization_state_content_sha256": reference_linearization_digest,
        "native_states_by_sample": native_states,
        "periodic_mesh_certificate_sha256": periodic_digest,
    }


def _read_probe_rows(case_dir: Path) -> dict[tuple[int, int], dict[str, Any]]:
    csv_path = case_dir / "eigen/dispersion.csv"
    spectrum = load_spectrum_v3_modes(case_dir / "eigen/spectrum.v3.json")
    expected_vectors = PARALLEL_PROBE_VECTORS_RAD_PER_M
    rows: dict[tuple[int, int], dict[str, Any]] = {}
    try:
        stream = csv_path.open(encoding="utf-8-sig", newline="")
    except OSError as error:
        raise EvidenceUnavailable(f"missing dispersion CSV: {csv_path}") from error
    with stream:
        reader = csv.DictReader(stream)
        required = {
            "sample_index", "raw_mode_index", "branch_id", "kx_rad_per_m",
            "ky_rad_per_m", "kz_rad_per_m", "frequency_hz",
        }
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValidationError("dispersion CSV has no canonical probe columns")
        for position, row in enumerate(reader):
            try:
                sample_index = int(row["sample_index"])
                raw_mode_index = int(row["raw_mode_index"])
                branch_id = int(row["branch_id"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValidationError(f"dispersion CSV row {position} has invalid indices") from error
            if min(sample_index, raw_mode_index, branch_id) < 0:
                raise ValidationError("dispersion CSV indices must be non-negative")
            values = {}
            for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz"):
                try:
                    values[key] = _finite(float(row[key]), f"CSV row {position}.{key}")
                except (KeyError, TypeError, ValueError) as error:
                    raise ValidationError(f"dispersion CSV row {position} has invalid {key}") from error
            if sample_index >= EXPECTED_SAMPLE_COUNT or raw_mode_index != 0 or branch_id != 0:
                raise ValidationError("dispersion CSV has an unexpected probe sample or mode")
            expected = expected_vectors[sample_index]
            actual = (values["kx_rad_per_m"], values["ky_rad_per_m"], values["kz_rad_per_m"])
            if any(not math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)
                   for a, b in zip(actual, expected)):
                raise ValidationError("dispersion CSV wavevector disagrees with the probe path")
            key = (sample_index, raw_mode_index)
            if key in rows:
                raise ValidationError(f"duplicate dispersion CSV row {key}")
            native = spectrum.get(key)
            if native is None:
                raise ValidationError(f"dispersion CSV row {key} has no native spectrum mode")
            if not math.isclose(
                values["frequency_hz"], native["frequency_hz"],
                rel_tol=1e-12, abs_tol=FREQUENCY_ABSOLUTE_TOLERANCE_HZ,
            ):
                raise ValidationError(f"dispersion CSV frequency disagrees with native mode {key}")
            rows[key] = {
                "sample_index": sample_index,
                "raw_mode_index": raw_mode_index,
                "branch_id": branch_id,
                "k_vector": list(actual),
                "frequency_hz": values["frequency_hz"],
                "residual_relative_l2": float(native["residual_relative_l2"]),
            }
    expected_keys = {(index, 0) for index in range(EXPECTED_SAMPLE_COUNT)}
    if set(rows) != expected_keys:
        raise ValidationError("dispersion CSV does not cover exactly the three probe samples")
    return rows


def _case_artifact_hash_bindings(result: Mapping[str, Any], case_dir: Path, mode: str) -> dict[str, Any]:
    artifacts = result.get("artifacts")
    hashes = artifacts.get("required_artifact_hashes") if isinstance(artifacts, Mapping) else None
    if not isinstance(hashes, Mapping) or not hashes:
        raise EvidenceUnavailable(f"{mode} has no required artifact hash catalog")
    required = {"metadata.json", "eigen/diagnostics/solver.v1.json", "eigen/dispersion.csv",
                "eigen/spectrum.v3.json", MANIFEST_RELATIVE_PATH}
    if not required.issubset(hashes):
        raise EvidenceUnavailable(f"{mode} required artifact hash catalog omits {sorted(required - hashes.keys())}")
    if any(not isinstance(path, str) for path in hashes):
        raise ValidationError(f"{mode} artifact hash catalog has a non-string path")
    bindings = {}
    for relative in sorted(hashes):
        try:
            binding = verify_required_artifact_hash(result, case_dir.parent, case_dir.name, relative)
        except (OSError, TypeError, ValueError) as error:
            if isinstance(error.__cause__, FileNotFoundError):
                raise EvidenceUnavailable(f"{mode} receipt-bound artifact is missing: {relative}") from error
            if relative == REPORT_RELATIVE_PATH:
                raise ValidationError(f"{mode} report hash binding failed: {error}") from error
            raise ValidationError(f"{mode} receipt-bound artifact failed: {relative}: {error}") from error
        bindings[relative] = binding
    return {"status": "pass", "artifact_count": len(bindings),
            "catalog_sha256": hashlib.sha256(_canonical_json(bindings).encode("utf-8")).hexdigest()}


def _validate_case(receipt: Mapping[str, Any], mode: str) -> dict[str, Any]:
    output_root = Path(receipt["root"])
    model_sha256 = _digest(receipt["probe"]["model_sha256"], f"{mode}.model_sha256")
    try:
        case_dir, resolved_binding = resolve_runtime_artifact_root(
            output_root, PILOT, model_sha256
        )
    except RuntimeArtifactRootError as error:
        if isinstance(error.__cause__, FileNotFoundError):
            raise EvidenceUnavailable(
                f"{mode} managed runtime artifacts are incomplete: {error}"
            ) from error
        raise ValidationError(f"{mode} managed runtime artifacts failed revalidation: {error}") from error
    result = receipt.get("result")
    recorded_binding = result.get("runtime_output_binding") if isinstance(result, Mapping) else None
    if not isinstance(recorded_binding, Mapping):
        raise EvidenceUnavailable(f"{mode} run-result is missing runtime_output_binding")
    if dict(recorded_binding) != resolved_binding:
        raise ValidationError(f"{mode} runtime_output_binding differs from resolved artifacts")
    artifact_bindings = _case_artifact_hash_bindings(result, case_dir, mode)
    metadata_path = case_dir / "metadata.json"
    diagnostics_path = case_dir / "eigen/diagnostics/solver.v1.json"
    try:
        metadata_result = validate_parallel_probe_metadata(
            metadata_path,
            model_sha256=_digest(receipt["probe"]["model_sha256"], f"{mode}.model_sha256"),
            parallel_mode=mode,
        )
        solver_result = validate_parallel_probe_solver_artifacts(
            case_dir,
            requested_eps_prefilter="1e-9",
            requested_shifted_ksp_rtol="1e-9",
            requested_gmres_restart="8",
            expected_sample_count=EXPECTED_SAMPLE_COUNT,
            physical_residual_tolerance=PHYSICAL_RESIDUAL_TOLERANCE,
        )
        validate_rows(
            case_dir / "eigen/dispersion.csv",
            "parallel-probe",
            diagnostics_path,
            metadata_path,
        )
    except EvidenceUnavailable:
        raise
    except (OSError, TypeError, ValueError) as error:
        raise ValidationError(f"{mode} native probe artifacts failed revalidation: {error}") from error
    rows = _read_probe_rows(case_dir)
    identity = _manifest_identity(case_dir, receipt["probe"], solver_result)
    if _case_artifact_hash_bindings(result, case_dir, mode) != artifact_bindings:
        raise ValidationError(f"{mode} artifact binding changed during revalidation")
    return {
        "status": "pass",
        "case_dir": str(case_dir),
        "artifact_hash_binding": artifact_bindings,
        "metadata": metadata_result,
        "solver_artifacts": solver_result,
        "rows": rows,
        "mesh_identity": identity,
    }


def _report_body(value: Mapping[str, Any]) -> Mapping[str, Any]:
    if value.get("schema_version") == "fullmag.eigen.admission_journal.v1":
        report = value.get("report")
        if not isinstance(report, Mapping):
            raise EvidenceUnavailable("admission journal has no report body")
        return report
    return value


def _report_inputs(value: Mapping[str, Any], probe: Mapping[str, Any]) -> dict[int, Mapping[str, Any]]:
    report = _report_body(value)
    inputs = report.get("inputs")
    if not isinstance(inputs, list):
        raise ValidationError("parallel execution report has no inputs array")
    result: dict[int, Mapping[str, Any]] = {}
    expected_equilibrium = _content_identity(
        probe, "equilibrium_artifact_content_sha256", "parallel_probe"
    )
    for position, item in enumerate(inputs):
        if not isinstance(item, Mapping):
            raise ValidationError(f"parallel execution input {position} is not an object")
        sample = item.get("sample_index")
        if type(sample) is not int or sample < 0 or sample in result:
            raise ValidationError("parallel execution input sample indices are invalid")
        if _digest_prefixed(item.get("equilibrium_artifact_sha256"),
                            f"inputs[{sample}].equilibrium_artifact_sha256") != expected_equilibrium:
            raise ValidationError(f"parallel execution input {sample} has a different equilibrium")
        _digest(item.get("plan_sha256"), f"inputs[{sample}].plan_sha256")
        result[sample] = item
    if set(result) != set(range(EXPECTED_SAMPLE_COUNT)):
        raise ValidationError("parallel execution report input samples differ from the probe")
    return result


def _artifact_hash_binding(result: Mapping[str, Any], report_path: Path) -> dict[str, Any]:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise EvidenceUnavailable("run-result has no artifact hash catalog for the adaptive report")
    hashes = artifacts.get("required_artifact_hashes")
    if not isinstance(hashes, Mapping):
        raise EvidenceUnavailable("run-result does not publish required_artifact_hashes")
    entry = hashes.get(REPORT_RELATIVE_PATH)
    if not isinstance(entry, Mapping):
        raise EvidenceUnavailable("run-result does not bind eigen/parallel_execution.v1.json")
    declared = _digest(entry.get("sha256"), "required_artifact_hashes.parallel_execution.sha256")
    try:
        actual = hashlib.sha256(report_path.read_bytes()).hexdigest()
    except OSError as error:
        raise EvidenceUnavailable(f"cannot read adaptive process-pool report: {report_path}") from error
    if declared != actual:
        raise ValidationError("adaptive process-pool report hash differs from run-result binding")
    return {"status": "pass", "relative_path": REPORT_RELATIVE_PATH, "sha256": actual}


def _validate_process_report(
    receipt: Mapping[str, Any],
    mode: str,
    case: Mapping[str, Any],
    *,
    required: bool,
) -> dict[str, Any]:
    report_path = Path(case["case_dir"]) / REPORT_RELATIVE_PATH
    if not report_path.is_file():
        if required:
            return {
                "present": False,
                "required": True,
                "status": "not_verified",
                "reason": "adaptive process-pool report is absent",
            }
        return {
            "present": False,
            "required": False,
            "status": "not_required",
            "reason": "serial producer may omit a process-pool report",
        }
    raw = _load_json(report_path, f"{mode} process-pool report")
    try:
        report_inputs = _report_inputs(raw, receipt["probe"])
    except EvidenceUnavailable as error:
        return {
            "present": True,
            "required": required,
            "status": "not_verified",
            "reason": str(error),
        }
    validation = validate_parallel_execution_report(
        raw,
        expected_mode=mode,
        expected_sample_count=EXPECTED_SAMPLE_COUNT,
        require_concurrency=required,
    )
    if required:
        try:
            binding = _artifact_hash_binding(receipt["result"], report_path)
        except EvidenceUnavailable as error:
            return {
                "present": True,
                "required": True,
                "status": "not_verified",
                "reason": str(error),
                "validation": validation,
                "input_binding": report_inputs,
            }
        concurrency = validation.get("concurrency", {})
        if concurrency.get("status") != "observed_from_active_count":
            return {
                "present": True,
                "required": True,
                "status": "not_verified",
                "reason": "adaptive report lacks timestamped active_workers>=2 evidence",
                "validation": validation,
                "input_binding": report_inputs,
                "artifact_binding": binding,
            }
        if validation.get("resource_quality", {}).get("status") == "not_verified":
            return {
                "present": True,
                "required": True,
                "status": "not_verified",
                "reason": "adaptive report resource quality is unavailable",
                "validation": validation,
                "input_binding": report_inputs,
                "artifact_binding": binding,
            }
        return {
            "present": True,
            "required": True,
            "status": "pass",
            "reason": "direct report is bound to completed_unqualified run-result; terminal state remains separate",
            "validation": validation,
            "input_binding": report_inputs,
            "artifact_binding": binding,
            "completion_bound_to_run_result": True,
        }
    return {
        "present": True,
        "required": False,
        "status": "pass" if validation.get("status") in {"pass", "not_verified"} else "not_verified",
        "reason": "serial process-pool report is optional structural evidence",
        "validation": validation,
        "input_binding": report_inputs,
    }


def _compare_report_inputs(serial_report: Mapping[str, Any], adaptive_report: Mapping[str, Any]) -> dict[str, Any]:
    serial_inputs = serial_report.get("input_binding")
    adaptive_inputs = adaptive_report.get("input_binding")
    if not isinstance(serial_inputs, Mapping) or not isinstance(adaptive_inputs, Mapping):
        raise ValidationError("serial/adaptive process reports have no input bindings")
    if set(serial_inputs) != set(adaptive_inputs):
        raise ValidationError("serial/adaptive process report sample sets differ")
    for sample_index in serial_inputs:
        serial_item = serial_inputs[sample_index]
        adaptive_item = adaptive_inputs[sample_index]
        if not isinstance(serial_item, Mapping) or not isinstance(adaptive_item, Mapping):
            raise ValidationError("serial/adaptive process report input is malformed")
        for key in ("plan_sha256", "equilibrium_artifact_sha256"):
            if serial_item.get(key) != adaptive_item.get(key):
                raise ValidationError(
                    f"serial/adaptive process report input {sample_index}.{key} differs"
                )
    return {"status": "pass", "sample_count": len(serial_inputs), "same_plan_and_equilibrium": True}


def _compare_mesh_identity(serial: Mapping[str, Any], adaptive: Mapping[str, Any]) -> dict[str, Any]:
    fields = (
        "mesh_identity", "operator_input_signature_sha256", "phase_constraint_sha256",
        "phase_constraints_by_sample",
        "equilibrium_artifact_sha256", "linearization_state_sha256",
        "reference_linearization_state_content_sha256", "native_states_by_sample",
        "periodic_mesh_certificate_sha256",
    )
    for field in fields:
        if serial.get(field) != adaptive.get(field):
            raise ValidationError(f"serial/adaptive mesh or operator identity differs: {field}")
    return {"status": "pass", "fields": list(fields), "same_immutable_modal_identity": True}


def _compare_rows(serial: Mapping[tuple[int, int], Mapping[str, Any]],
                  adaptive: Mapping[tuple[int, int], Mapping[str, Any]]) -> dict[str, Any]:
    if set(serial) != set(adaptive):
        raise ValidationError("serial/adaptive native row sample sets differ")
    comparisons = []
    max_frequency_difference = 0.0
    max_residual_difference = 0.0
    frequency_pass = True
    residual_pass = True
    for key in sorted(serial):
        left = serial[key]
        right = adaptive[key]
        frequency_difference = abs(float(left["frequency_hz"]) - float(right["frequency_hz"]))
        residual_difference = abs(
            float(left["residual_relative_l2"]) - float(right["residual_relative_l2"])
        )
        max_frequency_difference = max(max_frequency_difference, frequency_difference)
        max_residual_difference = max(max_residual_difference, residual_difference)
        frequency_equal = math.isclose(
            float(left["frequency_hz"]), float(right["frequency_hz"]),
            rel_tol=FREQUENCY_RELATIVE_TOLERANCE,
            abs_tol=FREQUENCY_ABSOLUTE_TOLERANCE_HZ,
        )
        residual_equal = residual_difference <= RESIDUAL_PARITY_ABSOLUTE_TOLERANCE
        frequency_pass = frequency_pass and frequency_equal
        residual_pass = residual_pass and residual_equal
        comparisons.append({
            "sample_index": key[0],
            "raw_mode_index": key[1],
            "serial_frequency_hz": left["frequency_hz"],
            "adaptive_frequency_hz": right["frequency_hz"],
            "frequency_difference_hz": frequency_difference,
            "frequency_within_tolerance": frequency_equal,
            "serial_residual_relative_l2": left["residual_relative_l2"],
            "adaptive_residual_relative_l2": right["residual_relative_l2"],
            "residual_difference": residual_difference,
            "residual_within_tolerance": residual_equal,
            "physical_residual_ceiling": PHYSICAL_RESIDUAL_TOLERANCE,
        })
    status = "pass" if frequency_pass and residual_pass else "not_verified"
    return {
        "schema": "fullmag.serial-adaptive-numeric-parity.v1",
        "status": status,
        "qualification": "NOT VERIFIED",
        "frequency_tolerance": {
            "relative": FREQUENCY_RELATIVE_TOLERANCE,
            "absolute_hz": FREQUENCY_ABSOLUTE_TOLERANCE_HZ,
            "source": "existing validate_de_smoke_rows native CSV/spectrum matching and MAX_PROBE_RELATIVE_TOLERANCE",
        },
        "residual_tolerance": {
            "absolute_relative_l2": RESIDUAL_PARITY_ABSOLUTE_TOLERANCE,
            "physical_ceiling": PHYSICAL_RESIDUAL_TOLERANCE,
            "source": "existing DENSE_CERTIFICATION_TOLERANCE; no relaxation of physical 1e-8 gate",
        },
        "max_frequency_difference_hz": max_frequency_difference,
        "max_residual_difference": max_residual_difference,
        "comparisons": comparisons,
    }


def validate_serial_adaptive_probe(serial_dir: str | Path, adaptive_dir: str | Path) -> dict[str, Any]:
    """Validate two canonical completed probe batches without altering them."""

    serial_receipt = _load_receipt(Path(serial_dir), "serial")
    adaptive_receipt = _load_receipt(Path(adaptive_dir), "adaptive")
    execution = _compare_receipts(serial_receipt, adaptive_receipt)
    try:
        serial_case = _validate_case(serial_receipt, "serial")
        adaptive_case = _validate_case(adaptive_receipt, "adaptive")
        mesh_identity = _compare_mesh_identity(
            serial_case["mesh_identity"], adaptive_case["mesh_identity"]
        )
        numeric_parity = _compare_rows(serial_case["rows"], adaptive_case["rows"])
    except EvidenceUnavailable as error:
        return {
            "schema": "fullmag.serial-adaptive-probe-comparison.v1",
            "status": "not_verified",
            "qualification": "NOT VERIFIED",
            "execution": execution,
            "structural_report": {"status": "not_verified", "reason": str(error)},
            "numeric_parity": {"status": "not_verified", "reason": "native case evidence unavailable"},
            "concurrency": {"status": "not_verified", "reason": "native case evidence unavailable"},
            "science": {"status": "NOT VERIFIED", "reason": "runtime or scientific evidence is incomplete"},
        }

    serial_report = _validate_process_report(
        serial_receipt, "serial", serial_case, required=False
    )
    adaptive_report = _validate_process_report(
        adaptive_receipt, "adaptive", adaptive_case, required=True
    )
    report_parity: dict[str, Any] = {
        "status": "not_required",
        "reason": "serial producer may omit eigen/parallel_execution.v1.json",
    }
    if serial_report.get("present") and adaptive_report.get("present"):
        serial_report_path = Path(serial_case["case_dir"]) / REPORT_RELATIVE_PATH
        adaptive_report_path = Path(adaptive_case["case_dir"]) / REPORT_RELATIVE_PATH
        report_parity = compare_serial_adaptive_policy(serial_report_path, adaptive_report_path)
        report_parity = {**report_parity, **_compare_report_inputs(serial_report, adaptive_report)}

    structural_status = "pass" if adaptive_report.get("status") == "pass" \
        and mesh_identity.get("status") == "pass" else "not_verified"
    structural_report = {
        "status": structural_status,
        "serial_process_pool_report": serial_report,
        "adaptive_process_pool_report": adaptive_report,
        "serial_adaptive_report_parity": report_parity,
        "mesh_identity": mesh_identity,
        "artifact_revalidation": {
            "serial": {"status": serial_case["status"], "metadata": serial_case["metadata"],
                        "solver_artifacts": serial_case["solver_artifacts"],
                        "artifact_hash_binding": serial_case["artifact_hash_binding"]},
            "adaptive": {"status": adaptive_case["status"], "metadata": adaptive_case["metadata"],
                          "solver_artifacts": adaptive_case["solver_artifacts"],
                          "artifact_hash_binding": adaptive_case["artifact_hash_binding"]},
        },
    }
    concurrency = adaptive_report.get("validation", {}).get("concurrency") \
        if adaptive_report.get("present") else None
    if not isinstance(concurrency, Mapping):
        concurrency = {"status": "not_verified", "reason": "adaptive report is unavailable"}
    else:
        concurrency = dict(concurrency)
        concurrency["qualification_scope"] = "timestamped scheduler co-activity only; no EPSSolve overlap or speedup claim"
    status = "pass" if structural_status == "pass" and numeric_parity["status"] == "pass" \
        and concurrency.get("status") == "observed_from_active_count" else "not_verified"
    return {
        "schema": "fullmag.serial-adaptive-probe-comparison.v1",
        "status": status,
        "qualification": "NOT VERIFIED",
        "execution": execution,
        "structural_report": structural_report,
        "numeric_parity": numeric_parity,
        "concurrency": concurrency,
        "science": {
            "status": "NOT VERIFIED",
            "reason": "serial/adaptive parity does not establish mesh, airbox, mode-count, analytical or COMSOL convergence",
            "pending_requirements": [
                "mesh/airbox/mode-count convergence",
                "independent analytical and COMSOL comparison",
                "phase and field-level scientific validation",
            ],
        },
    }


def _write_exclusive(path: Path, value: Mapping[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(payload)
    except FileExistsError as error:
        raise ValidationError(f"refusing to overwrite comparison output: {path}") from error


def _main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serial_dir", type=Path)
    parser.add_argument("adaptive_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        result = validate_serial_adaptive_probe(args.serial_dir, args.adaptive_dir)
    except EvidenceUnavailable as error:
        result = {
            "schema": "fullmag.serial-adaptive-probe-comparison.v1",
            "status": "not_verified",
            "qualification": "NOT VERIFIED",
            "reason": str(error),
            "science": {"status": "NOT VERIFIED"},
        }
        exit_code = 3
    except ValidationError as error:
        result = {
            "schema": "fullmag.serial-adaptive-probe-comparison.v1",
            "status": "invalid",
            "qualification": "NOT VERIFIED",
            "reason": str(error),
            "science": {"status": "NOT VERIFIED"},
        }
        exit_code = 2
    else:
        exit_code = 0 if result["status"] == "pass" else 3
    if args.output is not None:
        _write_exclusive(args.output, result)
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    sys.exit(_main())
