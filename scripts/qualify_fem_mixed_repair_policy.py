#!/usr/bin/env python3
"""Qualify private mixed-tetrahedral repair candidates on canonical SP4."""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import subprocess
import sys
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Mapping, Sequence


SCHEMA = "fullmag.fem-mixed-repair-policy-qualification.v1"
WORKER_EVIDENCE_SCHEMA = "fullmag.fem-mixed-repair-policy-worker-evidence.v1"
WORKER_FAILURE_SCHEMA = "fullmag.fem-mixed-repair-policy-worker-failure.v1"
METHODS = ("default", "Relocate3D", "Netgen")
PRESERVED_NETGEN_REGRESSION_CONTROL = {
    "fixture": "test_netgen_regression_fixture_is_rejected_by_certificate_conformity_boundary",
    "cell_family": "tet4",
    "mesh_part": "far_air",
    "same_side_two_owner_faces": 2,
    "non_manifold_faces": 2,
    "expected_exception": "MeshValidationError",
    "expected_result": "rejected",
}


@dataclass(frozen=True)
class QualificationConfig:
    scenario: str
    runs: int
    methods: Sequence[str]
    gmsh_threads: int
    output: Path


_RunProcess = Callable[..., subprocess.CompletedProcess[str]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _render_json(document: Mapping[str, object]) -> str:
    return json.dumps(
        document,
        sort_keys=True,
        allow_nan=False,
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def _write_json(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_render_json(document), encoding="utf-8")


def _validate_config(config: QualificationConfig) -> None:
    if config.scenario != "sp4_mixed":
        raise ValueError("repair qualification requires scenario sp4_mixed")
    if config.runs != 10:
        raise ValueError("repair qualification requires exactly 10 cold runs")
    if config.gmsh_threads != 1:
        raise ValueError("repair qualification requires exactly one Gmsh thread")
    if tuple(config.methods) != METHODS:
        raise ValueError(
            "repair qualification methods must be exactly default,Relocate3D,Netgen"
        )
    if not config.output.is_absolute():
        raise ValueError("repair qualification output must be absolute")


def _method_slug(method: str) -> str:
    return "default" if method == "default" else method.lower()


def _candidate_evidence_path(output: Path, method: str) -> Path:
    return output.with_name(
        f"{output.stem}.{_method_slug(method)}.evidence.json"
    )


def _candidate_artifact_dir(output: Path, method: str) -> Path:
    return output.parent / f"{output.stem}.artifacts" / _method_slug(method)


def _worker_command(
    config: QualificationConfig,
    *,
    method: str,
    evidence_path: Path,
    artifact_dir: Path,
) -> list[str]:
    return [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--scenario",
        config.scenario,
        "--runs",
        str(config.runs),
        "--method",
        method,
        "--gmsh-threads",
        str(config.gmsh_threads),
        "--evidence-output",
        str(evidence_path),
        "--artifact-dir",
        str(artifact_dir),
    ]


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    return value


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    return number


def candidate_quality_failures(
    document: Mapping[str, object],
    *,
    expected_runs: int,
) -> list[str]:
    """Return all available Task-1 quality-gate failures for one candidate."""
    failures: list[str] = []
    benchmark = _mapping(document.get("benchmark"), "benchmark")
    gate = _mapping(benchmark.get("gate"), "benchmark.gate")
    if gate.get("status") != "release_pass":
        failures.append(f"benchmark gate did not pass: {gate.get('status')!r}")
    gate_failures = gate.get("failures")
    if isinstance(gate_failures, list):
        failures.extend(f"benchmark: {failure}" for failure in gate_failures)

    runs = benchmark.get("runs")
    if not isinstance(runs, list) or len(runs) != expected_runs or any(
        not isinstance(run, Mapping) or run.get("kind") != "cold" for run in runs
    ):
        failures.append(f"candidate requires exactly {expected_runs} cold runs")
        return failures

    scenario = _mapping(benchmark.get("scenario"), "benchmark.scenario")
    if scenario.get("id") != "sp4_mixed":
        failures.append("candidate scenario is not canonical sp4_mixed")
    if scenario.get("gmsh_threads") != 1:
        failures.append("candidate did not use exactly one Gmsh thread")

    fingerprints: set[str] = set()
    for index, run_value in enumerate(runs):
        run = _mapping(run_value, f"runs[{index}]")
        fingerprint = run.get("topology_fingerprint_v3")
        if not isinstance(fingerprint, str) or len(fingerprint) != 64:
            failures.append(f"run {index} has invalid topology fingerprint")
        else:
            fingerprints.add(fingerprint)
        if run.get("degraded") is not False:
            failures.append(f"run {index} is degraded")
        quality = _mapping(run.get("quality"), f"runs[{index}].quality")
        required_quality_fields = (
            "magnetic_plane_count",
            "cell_family_counts_by_part",
            "nonconforming_faces",
            "orphan_faces",
            "non_manifold_faces",
            "same_side_two_owner_faces",
            "coincident_interface_faces",
            "duplicate_cells",
            "fallbacks_triggered",
            "strict_jacobian_validation_passed",
            "marker_coverage_complete",
            "global_ordinals_complete",
            "relative_volume_error",
            "jacobian_minima_m3_by_family",
            "scaled_jacobian_minima_by_family",
            "scaled_jacobian_p05_by_family",
        )
        for field in required_quality_fields:
            if field not in quality:
                failures.append(f"run {index} quality is missing {field}")
        if quality.get("requested_layers") != 1 or quality.get("realized_layers") != 1:
            failures.append(f"run {index} does not preserve exact layer count 1")
        if quality.get("magnetic_plane_count") != 2:
            failures.append(f"run {index} magnetic_plane_count must be 2")
        parts_value = quality.get("cell_family_counts_by_part")
        if isinstance(parts_value, Mapping):
            expected_families = {
                "magnetic": {"prism6"},
                "transition_air": {"pyramid5", "tet4"},
                "far_air": {"tet4"},
            }
            if set(parts_value) != set(expected_families):
                failures.append(
                    f"run {index} cell_family_counts_by_part has incomplete mesh parts"
                )
            else:
                for part, families in expected_families.items():
                    counts = parts_value.get(part)
                    actual_families = set(counts) if isinstance(counts, Mapping) else set()
                    if (
                        not isinstance(counts, Mapping)
                        or not actual_families.issubset(families)
                        or (
                            part == "transition_air"
                            and "pyramid5" not in actual_families
                        )
                        or (part != "transition_air" and actual_families != families)
                        or any(
                            isinstance(count, bool)
                            or not isinstance(count, int)
                            or count < 1
                            for count in counts.values()
                        )
                    ):
                        failures.append(
                            f"run {index} {part} cell families violate {sorted(families)}"
                        )
        if quality.get("non_manifold_faces") != 0:
            failures.append(f"run {index} has non-manifold faces")
        if quality.get("same_side_two_owner_faces") != 0:
            failures.append(f"run {index} has same-side two-owner faces")
        for field in (
            "nonconforming_faces",
            "orphan_faces",
            "coincident_interface_faces",
            "duplicate_cells",
        ):
            if quality.get(field) != 0:
                failures.append(f"run {index} {field} must be zero")
        if quality.get("fallbacks_triggered") != []:
            failures.append(f"run {index} fallbacks_triggered must be empty")
        for field in (
            "strict_jacobian_validation_passed",
            "marker_coverage_complete",
            "global_ordinals_complete",
        ):
            if quality.get(field) is not True:
                failures.append(f"run {index} {field} must be true")
        if "relative_volume_error" in quality:
            volume_error = _finite(
                quality.get("relative_volume_error"),
                f"runs[{index}].quality.relative_volume_error",
            )
            if volume_error > 1.0e-8:
                failures.append(f"run {index} exceeds relative volume error 1e-8")
        for field, minimum in (
            ("jacobian_minima_m3_by_family", 0.0),
            ("scaled_jacobian_minima_by_family", 0.0),
            ("scaled_jacobian_p05_by_family", 0.1),
        ):
            values = quality.get(field)
            if not isinstance(values, Mapping):
                continue
            if set(values) != {"prism6", "pyramid5", "tet4"}:
                failures.append(f"run {index} {field} does not report all families")
                continue
            for family in ("prism6", "pyramid5", "tet4"):
                value = _finite(values[family], f"run {index} {family} {field}")
                violates_minimum = (
                    value <= minimum if minimum == 0.0 else value < minimum
                )
                if violates_minimum:
                    failures.append(
                        f"run {index} {family} {field} minimum is below {minimum}"
                    )
    if len(fingerprints) != 1:
        failures.append("topology fingerprint differs across candidate runs")
    return failures


def _candidate_p95(document: Mapping[str, object]) -> float:
    benchmark = _mapping(document.get("benchmark"), "benchmark")
    summary = _mapping(benchmark.get("summary"), "benchmark.summary")
    timings = _mapping(summary.get("timings"), "summary.timings")
    total = _mapping(timings.get("total_s"), "summary.timings.total_s")
    return _finite(total.get("p95"), "summary.timings.total_s.p95")


def evaluate_candidate(
    method: str,
    document: Mapping[str, object],
    *,
    expected_runs: int,
) -> dict[str, object]:
    failures = candidate_quality_failures(document, expected_runs=expected_runs)
    if document.get("schema") != WORKER_EVIDENCE_SCHEMA:
        failures.append("candidate repair policy evidence schema is invalid")
    expected_policy = _candidate_policy_identity(method)
    policy = _mapping(document.get("repair_policy"), "repair_policy")
    if set(policy) != {"algorithm_id", "method", "iterations"}:
        failures.append("candidate repair policy fields differ from the canonical schema")
    if not isinstance(policy.get("algorithm_id"), str) or not str(
        policy.get("algorithm_id")
    ).strip():
        failures.append("candidate repair policy algorithm_id must be a non-empty string")
    if not isinstance(policy.get("method"), str):
        failures.append("candidate repair policy method must be a string")
    if (
        isinstance(policy.get("iterations"), bool)
        or not isinstance(policy.get("iterations"), int)
        or int(policy.get("iterations")) < 1
    ):
        failures.append("candidate repair policy iterations must be a positive integer")
    policy_identity = {
        "algorithm_id": policy.get("algorithm_id"),
        "method": policy.get("method"),
        "iterations": policy.get("iterations"),
    }
    if policy_identity != expected_policy:
        failures.append(
            "candidate repair policy identity does not match the canonical policy: "
            f"expected={expected_policy}, actual={policy_identity}"
        )
    benchmark = _mapping(document.get("benchmark"), "benchmark")
    scenario = _mapping(benchmark.get("scenario"), "benchmark.scenario")
    if scenario.get("repair_method") != method:
        failures.append(
            "candidate evidence repair method does not match the requested method"
        )
    regression_control: dict[str, object] | None = None
    if method == "Netgen":
        regression_control = dict(PRESERVED_NETGEN_REGRESSION_CONTROL)
        failures.append(
            "Netgen is rejected by the preserved canonical SP4 conformity regression control"
        )
    mesh = _mapping(benchmark.get("mesh"), "benchmark.mesh")
    return {
        "method": method,
        "algorithm_id": policy_identity["algorithm_id"],
        "iterations": policy_identity["iterations"],
        "legal": not failures,
        "failures": failures,
        "p95_total_s": _candidate_p95(document),
        "mesh_counts": {
            field: mesh.get(field) for field in ("nodes", "cells", "facets")
        },
        "topology_fingerprint_v3": mesh.get("topology_fingerprint_v3"),
        "regression_control": regression_control,
        "worker_status": "completed",
    }


def _production_policy_identity() -> dict[str, object]:
    package_source = (
        Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
    )
    if str(package_source) not in sys.path:
        sys.path.insert(0, str(package_source))
    from fullmag.meshing._gmsh_swept import _STRICT_MIXED_TET_REPAIR_POLICY

    return {
        "algorithm_id": _STRICT_MIXED_TET_REPAIR_POLICY.algorithm_id,
        "method": _STRICT_MIXED_TET_REPAIR_POLICY.method,
        "iterations": _STRICT_MIXED_TET_REPAIR_POLICY.iterations,
    }


def _candidate_policy_identity(method: str) -> dict[str, object]:
    production_policy = _production_policy_identity()
    selected_method = "" if method == "default" else method
    if selected_method == production_policy["method"]:
        return production_policy
    package_source = (
        Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
    )
    if str(package_source) not in sys.path:
        sys.path.insert(0, str(package_source))
    from fullmag.meshing._gmsh_swept import (
        _qualification_mixed_tet_repair_algorithm_id,
    )

    return {
        "algorithm_id": _qualification_mixed_tet_repair_algorithm_id(
            selected_method,
            1,
        ),
        "method": selected_method,
        "iterations": 1,
    }


def topology_equivalence_failures(
    candidates: Sequence[Mapping[str, object]],
) -> list[str]:
    legal = [candidate for candidate in candidates if candidate.get("legal") is True]
    if not legal:
        return []
    failures: list[str] = []
    reference = legal[0]
    reference_method = str(reference.get("method"))
    reference_counts = reference.get("mesh_counts")
    reference_fingerprint = reference.get("topology_fingerprint_v3")
    expected_count_fields = {"nodes", "cells", "facets"}
    if (
        not isinstance(reference_counts, Mapping)
        or set(reference_counts) != expected_count_fields
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 1
            for value in reference_counts.values()
        )
    ):
        failures.append(
            f"{reference_method} lacks valid nodes/cells/facets element counts"
        )
    if not isinstance(reference_fingerprint, str) or len(reference_fingerprint) != 64:
        failures.append(f"{reference_method} lacks a topology fingerprint")
    for candidate in legal[1:]:
        method = str(candidate.get("method"))
        counts = candidate.get("mesh_counts")
        fingerprint = candidate.get("topology_fingerprint_v3")
        if (
            not isinstance(counts, Mapping)
            or set(counts) != expected_count_fields
            or any(
                isinstance(value, bool) or not isinstance(value, int) or value < 1
                for value in counts.values()
            )
        ):
            failures.append(f"{method} lacks valid nodes/cells/facets element counts")
        elif isinstance(reference_counts, Mapping) and counts != reference_counts:
            failures.append(
                "timing ranking requires equal element counts: "
                f"{reference_method}={dict(reference_counts)}, {method}={dict(counts)}"
            )
        if not isinstance(fingerprint, str) or len(fingerprint) != 64:
            failures.append(f"{method} lacks a topology fingerprint")
        elif (
            isinstance(reference_fingerprint, str)
            and fingerprint != reference_fingerprint
        ):
            failures.append(
                "timing ranking requires an equal topology fingerprint: "
                f"{reference_method}={reference_fingerprint}, {method}={fingerprint}"
            )
    return failures


def fastest_legal_method(candidates: Sequence[Mapping[str, object]]) -> str | None:
    legal = [candidate for candidate in candidates if candidate.get("legal") is True]
    if not legal or topology_equivalence_failures(candidates):
        return None
    return str(min(legal, key=lambda row: float(row["p95_total_s"]))["method"])


def _production_candidate_method() -> str:
    policy_method = _production_policy_identity()["method"]
    return "default" if policy_method == "" else str(policy_method)


def decide_matrix_status(candidates: Sequence[Mapping[str, object]]) -> dict[str, object]:
    production_method = _production_candidate_method()
    relocate = next(
        (candidate for candidate in candidates if candidate.get("method") == production_method),
        None,
    )
    fastest = fastest_legal_method(candidates)
    ranking_failures = topology_equivalence_failures(candidates)
    if relocate is None or relocate.get("legal") is not True:
        infrastructure = bool(
            relocate is not None
            and relocate.get("worker_status") == "BLOCKED_INFRASTRUCTURE"
        )
        return {
            "status": (
                "BLOCKED_INFRASTRUCTURE"
                if infrastructure
                else "BLOCKED_MESHER_QUALITY"
            ),
            "selected_production_method": None,
            "fastest_legal_method": fastest,
            "ranking_failures": ranking_failures,
            "failing_topology_fingerprint_v3": (
                relocate.get("topology_fingerprint_v3") if relocate else None
            ),
        }
    if ranking_failures:
        return {
            "status": "BLOCKED_TOPOLOGY_EQUIVALENCE",
            "selected_production_method": None,
            "fastest_legal_method": None,
            "ranking_failures": ranking_failures,
            "failing_topology_fingerprint_v3": None,
        }
    return {
        "status": "PASSED",
        "selected_production_method": production_method,
        "fastest_legal_method": fastest,
        "ranking_failures": [],
        "failing_topology_fingerprint_v3": None,
    }


def classify_worker_failure(message: str) -> str:
    lowered = message.lower()
    infrastructure_markers = (
        "no space left on device",
        "errno 28",
        "gmsh is required",
        "module not found",
        "cannot import",
        "permission denied",
    )
    if any(marker in lowered for marker in infrastructure_markers):
        return "BLOCKED_INFRASTRUCTURE"
    return "BLOCKED_MESHER_QUALITY"


def _complete_candidate_quality(
    mesh: object,
    base: Mapping[str, object],
) -> dict[str, object]:
    """Bind every currently implemented brief-3.3 gate to worker evidence."""
    certificate = mesh.mixed_layer_topology_certificate  # type: ignore[attr-defined]
    if certificate is None:
        raise ValueError("SP4 mixed mesh is missing its topology certificate")
    mesh.validate_strict(require_positive_orientation=True)  # type: ignore[attr-defined]
    cell_keys = [
        (
            str(mesh.cell_types[index]),  # type: ignore[attr-defined]
            tuple(sorted(int(node) for node in mesh.cell_node_ids(index))),  # type: ignore[attr-defined]
        )
        for index in range(int(mesh.n_elements))  # type: ignore[attr-defined]
    ]
    ordinals = [
        int(value) for value in mesh.cell_global_ordinals.tolist()  # type: ignore[attr-defined]
    ]
    complete = dict(base)
    complete.update(
        {
            "magnetic_plane_count": len(certificate.magnetic_plane_coordinates_m),
            "cell_family_counts_by_part": certificate.cell_family_counts_by_part,
            "nonconforming_faces": certificate.nonconforming_face_count,
            "orphan_faces": certificate.orphan_face_count,
            "coincident_interface_faces": certificate.coincident_interface_face_count,
            "duplicate_cells": len(cell_keys) - len(set(cell_keys)),
            "fallbacks_triggered": list(certificate.fallbacks_triggered),
            "strict_jacobian_validation_passed": True,
            "marker_coverage_complete": certificate.marker_coverage_complete,
            "global_ordinals_complete": (
                len(ordinals) == len(set(ordinals))
                and sorted(ordinals) == list(range(len(ordinals)))
            ),
            "jacobian_minima_m3_by_family": dict(
                certificate.jacobian_minima_m3_by_family
            ),
            "scaled_jacobian_minima_by_family": dict(
                certificate.scaled_jacobian_minima_by_family
            ),
        }
    )
    return complete


def _worker_failure_row(
    method: str,
    *,
    evidence_path: Path,
    returncode: int,
    stdout: str,
    stderr: str,
) -> dict[str, object]:
    message = "\n".join(part for part in (stdout.strip(), stderr.strip()) if part)
    status = classify_worker_failure(message)
    policy = _candidate_policy_identity(method)
    captured: Mapping[str, object] = {}
    if evidence_path.is_file():
        try:
            candidate = json.loads(evidence_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            candidate = None
        if (
            isinstance(candidate, Mapping)
            and candidate.get("schema") == WORKER_FAILURE_SCHEMA
        ):
            captured = candidate
    failure_document = {
        **captured,
        "schema": WORKER_FAILURE_SCHEMA,
        "generated_at": _utc_now(),
        "method": method,
        "repair_policy": policy,
        "returncode": returncode,
        "status": status,
        "stdout": stdout,
        "stderr": stderr,
    }
    _write_json(evidence_path, failure_document)
    row = {
        "method": method,
        "algorithm_id": policy["algorithm_id"],
        "iterations": policy["iterations"],
        "legal": False,
        "failures": [message or f"worker exited with status {returncode}"],
        "p95_total_s": None,
        "regression_control": (
            dict(PRESERVED_NETGEN_REGRESSION_CONTROL)
            if method == "Netgen"
            else None
        ),
        "worker_status": status,
    }
    fingerprint = captured.get("topology_fingerprint_v3")
    if isinstance(fingerprint, str) and fingerprint.startswith("sha256:"):
        row["topology_fingerprint_v3"] = fingerprint
    mesh_counts = captured.get("mesh_counts")
    if isinstance(mesh_counts, Mapping):
        row["mesh_counts"] = dict(mesh_counts)
    capture_error = captured.get("topology_capture_error")
    if isinstance(capture_error, str):
        row["topology_capture_error"] = capture_error
    return row


def run_qualification(
    config: QualificationConfig,
    *,
    run_process: _RunProcess = subprocess.run,
) -> dict[str, object]:
    _validate_config(config)
    candidates: list[dict[str, object]] = []
    for method in config.methods:
        evidence_path = _candidate_evidence_path(config.output, method)
        artifact_dir = _candidate_artifact_dir(config.output, method)
        command = _worker_command(
            config,
            method=method,
            evidence_path=evidence_path,
            artifact_dir=artifact_dir,
        )
        evidence_path.unlink(missing_ok=True)
        completed = run_process(
            command,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            candidate = _worker_failure_row(
                method,
                evidence_path=evidence_path,
                returncode=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
        else:
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            candidate = evaluate_candidate(
                method,
                _mapping(evidence, "candidate evidence"),
                expected_runs=config.runs,
            )
        candidate["evidence_path"] = str(evidence_path)
        candidates.append(candidate)

    production_policy = _production_policy_identity()
    document: dict[str, object] = {
        "schema": SCHEMA,
        "generated_at": _utc_now(),
        "scenario": config.scenario,
        "runs_per_method": config.runs,
        "gmsh_threads": config.gmsh_threads,
        "production_policy": production_policy,
        "candidates": candidates,
        "decision": decide_matrix_status(candidates),
    }
    _write_json(config.output, document)
    return document


def _capture_failing_topology(gmsh: object, swept: object) -> dict[str, object]:
    from fullmag.meshing._gmsh_types import (
        AirboxOptions,
        MIXED_INTERFACE_MARKER,
    )

    raw_mesh = swept._extract_mesh_data(  # type: ignore[attr-defined]
        gmsh,
        has_physical_groups=True,
        boundary_role_markers=(
            MIXED_INTERFACE_MARKER,
            AirboxOptions().boundary_marker,
        ),
    )
    mesh_si = replace(
        raw_mesh,
        nodes=raw_mesh.nodes * 1.0e-6,
    )
    return {
        "topology_fingerprint_v3": mesh_si.topology_fingerprint_v3(),
        "mesh_counts": {
            "nodes": mesh_si.n_nodes,
            "cells": mesh_si.n_elements,
            "facets": mesh_si.n_boundary_faces,
        },
    }


@contextlib.contextmanager
def _qualification_probe_installed(
    method: str,
    *,
    failing_topology: dict[str, object] | None = None,
) -> Iterator[None]:
    import benchmark_fem_mixed_mesh_pipeline as benchmark

    package_source = (
        Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
    )
    if str(package_source) not in sys.path:
        sys.path.insert(0, str(package_source))
    from fullmag.meshing import _gmsh_swept as swept

    original_probe = benchmark._mesh_phase_probe
    original_quality_document = benchmark._quality_document
    selected_method = "" if method == "default" else method

    def selected_repair(candidate_method: str, gmsh: object) -> None:
        try:
            swept._repair_mixed_tetrahedra_for_qualification(
                candidate_method,
                gmsh,
            )
        except Exception:
            if failing_topology is not None:
                try:
                    failing_topology.update(_capture_failing_topology(gmsh, swept))
                except Exception as capture_error:
                    failing_topology["topology_capture_error"] = (
                        f"{type(capture_error).__name__}: {capture_error}"
                    )
            raise

    @contextlib.contextmanager
    def qualification_probe(
        timings_ns: dict[str, int],
        _repair_method_override: str | None,
        qualification_selector: object | None = None,
    ) -> Iterator[None]:
        del qualification_selector
        with original_probe(
            timings_ns,
            selected_method,
            qualification_selector=selected_repair,
        ):
            yield

    benchmark._mesh_phase_probe = qualification_probe
    benchmark._quality_document = lambda mesh: _complete_candidate_quality(
        mesh,
        original_quality_document(mesh),
    )
    try:
        yield
    finally:
        benchmark._mesh_phase_probe = original_probe
        benchmark._quality_document = original_quality_document


def _run_worker(
    *,
    scenario: str,
    runs: int,
    method: str,
    gmsh_threads: int,
    evidence_output: Path,
    artifact_dir: Path,
) -> None:
    import benchmark_fem_mixed_mesh_pipeline as benchmark

    config = benchmark.BenchmarkConfig(
        scenario=scenario,
        cold_runs=runs,
        warm_runs=0,
        native_audit_runs=0,
        python_audit_runs=0,
        warmup_runs=0,
        artifact_dir=artifact_dir.resolve(),
        output=evidence_output.resolve(),
        repair_method_override=(None if method == "default" else method),
        rayon_threads=(1,),
        gmsh_threads=(gmsh_threads,),
    )
    failing_topology: dict[str, object] = {}
    try:
        with _qualification_probe_installed(
            method,
            failing_topology=failing_topology,
        ):
            document = benchmark._run_benchmark(config, mode="qualification")
    except Exception as error:
        failure_document = {
            "schema": WORKER_FAILURE_SCHEMA,
            "generated_at": _utc_now(),
            "method": method,
            "repair_policy": _candidate_policy_identity(method),
            "status": classify_worker_failure(str(error)),
            "error": f"{type(error).__name__}: {error}",
            **failing_topology,
        }
        _write_json(evidence_output, failure_document)
        raise
    benchmark.validate_evidence_document(document)
    _write_json(
        evidence_output,
        {
            "schema": WORKER_EVIDENCE_SCHEMA,
            "repair_policy": _candidate_policy_identity(method),
            "benchmark": document,
        },
    )


def _csv_methods(value: str) -> tuple[str, ...]:
    methods = tuple(item.strip() for item in value.split(",") if item.strip())
    if methods != METHODS:
        raise argparse.ArgumentTypeError(
            f"methods must be exactly {','.join(METHODS)}"
        )
    return methods


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--scenario", choices=("sp4_mixed",), required=True)
    parser.add_argument("--runs", type=int, required=True)
    parser.add_argument("--gmsh-threads", type=int, required=True)
    parser.add_argument("--methods", type=_csv_methods)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--method", choices=METHODS)
    parser.add_argument("--evidence-output", type=Path)
    parser.add_argument("--artifact-dir", type=Path)
    arguments = parser.parse_args(argv)
    if arguments.runs != 10:
        parser.error("--runs must be exactly 10")
    if arguments.gmsh_threads != 1:
        parser.error("--gmsh-threads must be exactly 1")
    if arguments.worker:
        if (
            arguments.method is None
            or arguments.evidence_output is None
            or arguments.artifact_dir is None
        ):
            parser.error("worker requires --method, --evidence-output, and --artifact-dir")
    elif arguments.methods is None or arguments.output is None:
        parser.error("qualification requires --methods and --output")
    return arguments


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parse_args(argv)
    if arguments.worker:
        _run_worker(
            scenario=arguments.scenario,
            runs=arguments.runs,
            method=arguments.method,
            gmsh_threads=arguments.gmsh_threads,
            evidence_output=arguments.evidence_output,
            artifact_dir=arguments.artifact_dir,
        )
        return 0
    output = arguments.output.expanduser().resolve()
    run_qualification(
        QualificationConfig(
            scenario=arguments.scenario,
            runs=arguments.runs,
            methods=arguments.methods,
            gmsh_threads=arguments.gmsh_threads,
            output=output,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
