#!/usr/bin/env python3
"""Prepare and validate the bounded managed CPU mixed prism-airbox runtime gate."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any


CANONICAL_MAX_STEPS = "max_steps=50_000"
BOUNDED_MAX_STEPS = "max_steps=1"
EXPECTED_PROBLEM_NAME = "mumag_sp4_fem_relax_projected_gradient_bb"
EXPECTED_ALGORITHM = "projected_gradient_bb"
TOPOLOGY_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")


class ContractError(ValueError):
    """Raised when bounded runtime evidence is absent, stale, or malformed."""


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    try:
        return _sha256_bytes(path.read_bytes())
    except OSError as error:
        raise ContractError(f"cannot read required artifact {path}: {error}") from error


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return value


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise ContractError(f"{label} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ContractError(f"{label} must be a finite number") from error
    if not math.isfinite(result):
        raise ContractError(f"{label} must be finite")
    return result


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ContractError(f"cannot read {label} {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ContractError(f"{label} {path} is not valid JSON: {error}") from error
    return _object(value, label)


def prepare_bounded_scenario(source: Path, output: Path) -> dict[str, object]:
    try:
        source_bytes = source.read_bytes()
        source_text = source_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ContractError(f"cannot read canonical scenario {source}: {error}") from error
    replacement_count = source_text.count(CANONICAL_MAX_STEPS)
    if replacement_count != 1:
        raise ContractError(
            "canonical scenario must contain exactly one "
            f"{CANONICAL_MAX_STEPS!r}; found {replacement_count}"
        )
    bounded_text = source_text.replace(CANONICAL_MAX_STEPS, BOUNDED_MAX_STEPS, 1)
    bounded_bytes = bounded_text.encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(bounded_bytes)
    return {
        "schema_version": "fem_mixed_prism_airbox_runtime_source.v1",
        "canonical_source": str(source),
        "canonical_source_sha256": _sha256_bytes(source_bytes),
        "bounded_source_sha256": _sha256_bytes(bounded_bytes),
        "canonical_max_steps": 50_000,
        "bounded_max_steps": 1,
        "replacement_count": replacement_count,
    }


def _validate_source_identity(source: Path, bounded_source: Path) -> dict[str, object]:
    try:
        canonical_bytes = source.read_bytes()
        bounded_bytes = bounded_source.read_bytes()
        canonical_text = canonical_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ContractError(f"cannot read runtime source identity: {error}") from error
    if canonical_text.count(CANONICAL_MAX_STEPS) != 1:
        raise ContractError("canonical source no longer has exactly one authored max_steps=50_000")
    expected = canonical_text.replace(CANONICAL_MAX_STEPS, BOUNDED_MAX_STEPS, 1).encode(
        "utf-8"
    )
    if bounded_bytes != expected:
        raise ContractError("bounded source differs from the canonical source beyond max_steps=1")
    return {
        "canonical_source": str(source),
        "canonical_source_sha256": _sha256_bytes(canonical_bytes),
        "bounded_source_sha256": _sha256_bytes(bounded_bytes),
    }


def _validate_scalar_artifact(path: Path) -> dict[str, object]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            required = {"step", "E_ex", "E_demag", "E_total", "max_torque_T"}
            missing = required - set(reader.fieldnames or ())
            if missing:
                raise ContractError(f"scalars.csv is missing columns {sorted(missing)}")
            rows = list(reader)
    except OSError as error:
        raise ContractError(f"cannot read scalar artifact {path}: {error}") from error
    if not rows:
        raise ContractError("scalars.csv must contain at least one row")
    for index, row in enumerate(rows):
        for field in ("E_ex", "E_demag", "E_total", "max_torque_T"):
            _finite(row.get(field), f"scalars.csv row {index} {field}")
    try:
        final_step = int(rows[-1]["step"])
    except (KeyError, TypeError, ValueError) as error:
        raise ContractError("scalars.csv final step must be an integer") from error
    if final_step != 1:
        raise ContractError(f"scalars.csv final step must be 1, got {final_step}")
    return {"scalar_rows": len(rows), "final_scalar_step": final_step}


def _validate_final_field(path: Path) -> int:
    field = _read_json_object(path, "final magnetization artifact")
    values = field.get("values")
    if not isinstance(values, list) or not values:
        raise ContractError("m_final.json values must be a non-empty array")
    for index, vector in enumerate(values):
        if not isinstance(vector, list) or len(vector) != 3:
            raise ContractError(f"m_final.json values[{index}] must be a three-vector")
        for component, value in enumerate(vector):
            _finite(value, f"m_final.json values[{index}][{component}]")
    return len(values)


def validate_runtime_artifacts(
    source: Path,
    bounded_source: Path,
    artifacts: Path,
    *,
    runtime_log: Path | None = None,
) -> dict[str, object]:
    source_identity = _validate_source_identity(source, bounded_source)
    metadata_path = artifacts / "metadata.json"
    scalars_path = artifacts / "scalars.csv"
    final_field_path = artifacts / "m_final.json"
    metadata = _read_json_object(metadata_path, "runtime metadata")

    if metadata.get("problem_name") != EXPECTED_PROBLEM_NAME:
        raise ContractError(f"problem_name must be {EXPECTED_PROBLEM_NAME}")
    if metadata.get("source_hash") != source_identity["bounded_source_sha256"]:
        raise ContractError("runtime source_hash does not match the generated bounded source")

    problem_meta = _object(metadata.get("problem_meta"), "problem_meta")
    runtime = _object(problem_meta.get("runtime_metadata"), "runtime_metadata")
    selection = _object(runtime.get("runtime_selection"), "runtime_selection")
    if selection.get("device") != "auto":
        raise ContractError("authored runtime_selection.device must remain auto")
    model_builder = _object(runtime.get("model_builder"), "model_builder")
    model_problem = _object(model_builder.get("problem"), "model_builder.problem")
    model_runtime = _object(model_problem.get("runtime"), "model_builder.problem.runtime")
    if model_runtime.get("device") != "auto":
        raise ContractError("authored model-builder runtime device must remain auto")
    override = _object(runtime.get("runtime_device_override"), "runtime_device_override")
    if override != {"device": "cpu", "source": "managed_launcher"}:
        raise ContractError("managed runtime device override must be exact CPU launcher provenance")

    requested = _object(metadata.get("requested_execution"), "requested_execution")
    expected_requested = {
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    if requested != expected_requested:
        raise ContractError(f"requested_execution must equal {expected_requested}")

    execution = _object(metadata.get("execution_provenance"), "execution_provenance")
    if execution.get("execution_engine") != "fem_cpu_native":
        raise ContractError("resolved execution engine must be fem_cpu_native")
    if execution.get("precision") != "double":
        raise ContractError("resolved execution precision must be double")
    if execution.get("lossy_fallback_used") is not False:
        raise ContractError("lossy_fallback_used must be explicitly false")
    if execution.get("resolved_fallback") is not None:
        raise ContractError("resolved_fallback must be absent")
    if execution.get("ignored_terms") not in (None, []):
        raise ContractError("ignored_terms must be absent or empty")

    mesh = _object(metadata.get("mesh"), "mesh metadata")
    topology_fingerprint = mesh.get("topology_fingerprint")
    if not isinstance(topology_fingerprint, str) or not TOPOLOGY_FINGERPRINT.fullmatch(
        topology_fingerprint
    ):
        raise ContractError("mesh topology_fingerprint must be canonical sha256 identity")
    report = _object(mesh.get("mesh_build_report"), "mesh build report")
    if report.get("fallbacks_triggered") != [] or report.get("degraded") is not False:
        raise ContractError("mesh build report must prove empty fallbacks and degraded=false")
    certificate = _object(
        report.get("mixed_layer_topology_certificate"),
        "mixed layer topology certificate",
    )
    if certificate.get("schema_version") != "mixed_layer_topology_certificate.v1":
        raise ContractError("mixed topology certificate schema is not v1")
    if certificate.get("certificate_status") != "accepted":
        raise ContractError("mixed topology certificate must be accepted")
    if certificate.get("topology_fingerprint") != topology_fingerprint:
        raise ContractError("certificate fingerprint does not match executed mesh")
    if certificate.get("fallbacks_triggered") != []:
        raise ContractError("mixed topology certificate fallback trail must be empty")
    mixed_provenance = _object(
        report.get("mixed_topology_provenance"), "mixed topology provenance"
    )
    expected_mixed = {
        "requested_topology": "mixed_p1",
        "resolved_topology": "mixed_p1",
        "accepted_certificate_fingerprint": topology_fingerprint,
        "requested_device": "cpu",
        "precision": "double",
        "capability_status": "implemented",
    }
    for key, expected in expected_mixed.items():
        if mixed_provenance.get(key) != expected:
            raise ContractError(f"mixed topology provenance {key} must be {expected!r}")

    qualification = _object(
        metadata.get("fem_cpu_relaxation_qualification"),
        "FEM CPU relaxation qualification",
    )
    if qualification.get("schema_version") != "fem_cpu_relaxation_qualification.v1":
        raise ContractError("FEM CPU relaxation qualification schema is not v1")
    if qualification.get("relaxation_algorithm") != EXPECTED_ALGORITHM:
        raise ContractError(f"relaxation algorithm must be {EXPECTED_ALGORITHM}")
    if qualification.get("executed_steps") != 1:
        raise ContractError("FEM CPU relaxation qualification executed_steps must be 1")
    energy_terms = _object(
        qualification.get("final_energy_terms_j"), "final energy terms"
    )
    for name in ("E_ex", "E_demag", "E_ext", "e_drive", "E_ani", "E_dmi", "E_total"):
        _finite(energy_terms.get(name), f"final_energy_terms_j.{name}")
    final_torque_apm = _finite(
        qualification.get("final_torque_apm"), "final_torque_apm"
    )
    final_torque_t = _finite(
        qualification.get("final_torque_t"), "final_torque_t"
    )

    scalar_evidence = _validate_scalar_artifact(scalars_path)
    final_field_vectors = _validate_final_field(final_field_path)
    runtime_log_sha256 = None
    if runtime_log is not None:
        try:
            runtime_text = runtime_log.read_text(encoding="utf-8")
        except OSError as error:
            raise ContractError(f"cannot read runtime log {runtime_log}: {error}") from error
        if "resolved_engine_id=fem_cpu_native fallback=None" not in runtime_text:
            raise ContractError("runtime log does not prove fem_cpu_native with fallback=None")
        runtime_log_sha256 = _sha256_file(runtime_log)

    return {
        "schema_version": "fem_mixed_prism_airbox_runtime.v1",
        "qualification_status": "implemented",
        **source_identity,
        "metadata_sha256": _sha256_file(metadata_path),
        "scalars_sha256": _sha256_file(scalars_path),
        "m_final_sha256": _sha256_file(final_field_path),
        "runtime_log_sha256": runtime_log_sha256,
        "topology_fingerprint": topology_fingerprint,
        "certificate_fingerprint": certificate["topology_fingerprint"],
        "fallbacks_triggered": [],
        "degraded": False,
        "authored_device": "auto",
        "managed_override": override,
        "effective_device": "cpu",
        "execution_engine": "fem_cpu_native",
        "executed_steps": 1,
        "final_energy_terms_j": energy_terms,
        "final_torque_apm": final_torque_apm,
        "final_torque_t": final_torque_t,
        "final_field_vectors": final_field_vectors,
        **scalar_evidence,
    }


def _write_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("output", type=Path)
    prepare.add_argument("--evidence", type=Path)

    validate = subparsers.add_parser("validate")
    validate.add_argument("source", type=Path)
    validate.add_argument("bounded_source", type=Path)
    validate.add_argument("artifacts", type=Path)
    validate.add_argument("--runtime-log", type=Path)
    validate.add_argument("--output", type=Path, required=True)

    args = parser.parse_args()
    try:
        if args.command == "prepare":
            evidence = prepare_bounded_scenario(args.source, args.output)
            if args.evidence is not None:
                _write_json(args.evidence, evidence)
            else:
                print(json.dumps(evidence, sort_keys=True))
        else:
            summary = validate_runtime_artifacts(
                args.source,
                args.bounded_source,
                args.artifacts,
                runtime_log=args.runtime_log,
            )
            _write_json(args.output, summary)
    except ContractError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
