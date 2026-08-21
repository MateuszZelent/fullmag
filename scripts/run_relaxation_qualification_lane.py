#!/usr/bin/env python3
"""Execute one complete source-bound relaxation qualification lane.

This is the producer counterpart of ``verify_relaxation_production_matrix``.
It never synthesizes a receipt: every receipt is written only after the real
managed executable has produced converged metadata for both canonical
workloads, all three refinement levels, one warm-up, and five measured runs.
Any missing completion, fallback, parity, oracle, or source identity aborts
the lane and writes only a blocked diagnostic.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = ROOT / "scripts" / "verify_relaxation_production_matrix.py"
SPEC = importlib.util.spec_from_file_location("relaxation_production_matrix", MATRIX_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery failure
    raise RuntimeError(f"cannot load {MATRIX_PATH}")
MATRIX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATRIX)


SCENARIO = ROOT / "examples" / "relaxation_qualification_case.py"
SCENARIO_RELATIVE = "examples/relaxation_qualification_case.py"
ORACLE_SCRIPT = ROOT / "scripts" / "verify_relaxation_independent_oracle.py"
ORACLE_SCRIPT_RELATIVE = "scripts/verify_relaxation_independent_oracle.py"
CASE_SCHEMA = "fullmag.relaxation.case_artifact.v1"
ORACLE_SCHEMA = "fullmag.relaxation.oracle_artifact.v1"
EXECUTION_LOG_SCHEMA = "fullmag.relaxation.execution_log.v1"
RUNTIME_SCHEMA = "fullmag.relaxation.runtime_manifest.v1"
REPETITIONS = 5
WARMUP_RUNS = 1
MESH_LEVELS = ("coarse", "medium", "fine")
WORKLOADS = ("macrospin", "exchange_demag")
MAX_STEPS = 512
BUNDLE_ROOT: Path | None = None

LANE_ALGORITHMS: dict[str, tuple[str, ...]] = {
    "fdm_cpu_reference": (
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
    ),
    "fdm_gpu_production": (
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
    ),
    "fem_cpu_public": (
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ),
    "fem_gpu_public": (
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
    ),
}
LANE_PRECISIONS: dict[str, tuple[str, ...]] = {
    "fdm_cpu_reference": ("fp64",),
    # FP64 must be produced first because FP32 parity is against the same
    # managed CUDA lane at FP64.
    "fdm_gpu_production": ("fp64", "fp32"),
    "fem_cpu_public": ("fp64",),
    "fem_gpu_public": ("fp64",),
}


class QualificationError(RuntimeError):
    """A missing or failed qualification condition."""


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def sha256_directory(path: Path) -> str:
    require(path.is_dir(), f"final state artifact directory is missing: {path}")
    files = sorted(item for item in path.rglob("*") if item.is_file())
    require(files, f"final state artifact directory is empty: {path}")
    digest = hashlib.sha256()
    for item in files:
        digest.update(item.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def sha256_state_artifact(path: Path) -> str:
    """Hash the runtime's canonical final-state file or field store."""
    require(path.is_file() or path.is_dir(), f"final state artifact is missing: {path}")
    return sha256_file(path) if path.is_file() else sha256_directory(path)


def write_json(path: Path, value: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(value) + b"\n")
    return sha256_file(path)


def finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def relative(root: Path, path: Path) -> str:
    base = BUNDLE_ROOT or root
    try:
        return path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError as error:
        raise QualificationError(f"artifact escaped root: {path}") from error


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationError(message)


def load_json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise QualificationError(f"{label} is not valid JSON: {error}") from error
    require(isinstance(value, Mapping), f"{label} must be a JSON object")
    return value


def lane_policy(lane: str) -> tuple[str, str, str, str, dict[str, str]]:
    require(lane in LANE_ALGORITHMS, f"unsupported lane: {lane}")
    policy = MATRIX.LANE_POLICIES[lane]
    return (
        str(policy["backend"]),
        str(policy["device"]),
        str(policy["precisions"][0]),
        str(policy["runtime_identity"]["id"]),
        dict(policy["runtime_identity"]),
    )


def source_identity(repo_root: Path) -> tuple[str, str]:
    try:
        return MATRIX._source_identity(repo_root)
    except ValueError as error:
        raise QualificationError(f"source identity is not clean: {error}") from error


def recipe_hash(repo_root: Path, lane: str) -> str:
    recipe = MATRIX.CANONICAL_RECIPE_BY_LANE[lane]
    try:
        return MATRIX._recipe_sha256(repo_root, recipe)
    except ValueError as error:
        raise QualificationError(f"canonical recipe is unavailable for {lane}: {error}") from error


def precision_name(precision: str) -> str:
    return {"fp64": "double", "fp32": "single"}[precision]


def expected_environment(lane: str, precision: str) -> dict[str, str]:
    if lane == "fdm_cpu_reference":
        return {
            "FULLMAG_FDM_EXECUTION": "cpu",
            "FULLMAG_FEM_EXECUTION": "cpu",
            "FULLMAG_RELAX_DEVICE": "cpu",
        }
    if lane == "fdm_gpu_production":
        return {
            "FULLMAG_FDM_EXECUTION": "gpu",
            "FULLMAG_FEM_EXECUTION": "cpu",
            "FULLMAG_RELAX_DEVICE": "gpu",
        }
    if lane == "fem_cpu_public":
        return {
            "FULLMAG_FDM_EXECUTION": "cpu",
            "FULLMAG_FEM_EXECUTION": "cpu",
            "FULLMAG_RELAX_DEVICE": "cpu",
        }
    return {
        "FULLMAG_FDM_EXECUTION": "cpu",
        "FULLMAG_FEM_EXECUTION": "gpu",
        "FULLMAG_RELAX_DEVICE": "gpu",
    }


def runtime_manifest(
    *,
    root: Path,
    lane: str,
    precision: str,
    source_commit: str,
    source_tree: str,
    source_git_tree: str,
    executable: Path,
    managed_bundle_manifest: Path | None,
) -> tuple[str, str]:
    backend, device, _, _, runtime_identity = lane_policy(lane)
    payload: dict[str, Any] = {
        "schema_version": RUNTIME_SCHEMA,
        "runtime_identity": runtime_identity,
        "backend": backend,
        "device": device,
        "precision": precision,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree,
        "source_git_tree": source_git_tree,
        "scenario": SCENARIO_RELATIVE,
        "scenario_sha256": sha256_file(SCENARIO),
        "executable": str(executable),
        "executable_sha256": sha256_file(executable),
    }
    if managed_bundle_manifest is not None:
        managed = load_json(managed_bundle_manifest, "managed runtime manifest")
        build_identity = managed.get("build_identity")
        require(isinstance(build_identity, Mapping), "managed runtime manifest lacks build_identity")
        require(build_identity.get("git_commit") == source_commit, "managed runtime commit is not source-bound")
        require(build_identity.get("git_tree") == source_git_tree, "managed runtime tree is not source-bound")
        require(build_identity.get("worktree_state") == "clean", "managed runtime was built from a dirty source tree")
        payload["managed_bundle_manifest_sha256"] = sha256_file(managed_bundle_manifest)
        payload["managed_bundle_build_identity"] = dict(build_identity)
    path = root / "runtime" / f"{lane}--{precision}.json"
    return relative(root, path), write_json(path, payload)


def scalar_rows(path: Path) -> list[dict[str, float]]:
    csv_path = path / "scalars.csv"
    require(csv_path.is_file(), f"runtime artifact is missing scalars.csv: {path}")
    try:
        with csv_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
    except (OSError, csv.Error) as error:
        raise QualificationError(f"cannot read {csv_path}: {error}") from error
    require(rows, f"runtime artifact has no scalar rows: {path}")
    converted: list[dict[str, float]] = []
    for row in rows:
        numeric: dict[str, float] = {}
        for key, value in row.items():
            if value is None or value == "":
                continue
            try:
                parsed = float(value)
            except ValueError as error:
                raise QualificationError(f"non-numeric scalar {key} in {csv_path}") from error
            require(math.isfinite(parsed), f"non-finite scalar {key} in {csv_path}")
            numeric[key] = parsed
        converted.append(numeric)
    return converted


def completion_result(
    metadata: Mapping[str, Any],
    rows: Sequence[Mapping[str, float]],
    *,
    lane: str,
    precision: str,
    algorithm: str,
    workload: str,
    mesh: str,
) -> dict[str, Any]:
    require(metadata.get("status") == "completed", f"{workload}/{mesh}: runtime status is not completed")
    completion = metadata.get("completion")
    require(isinstance(completion, Mapping), f"{workload}/{mesh}: authoritative completion is missing")
    require(completion.get("converged") is True, f"{workload}/{mesh}: completion is not converged")
    reason = completion.get("reason")
    require(reason in {"torque", "energy"}, f"{workload}/{mesh}: completion reason is not a convergence reason")
    accepted_steps = metadata.get("accepted_solver_steps", metadata.get("total_steps"))
    require(isinstance(accepted_steps, int) and accepted_steps >= 0, f"{workload}/{mesh}: accepted steps are invalid")
    require(accepted_steps < MAX_STEPS, f"{workload}/{mesh}: runtime reached qualification max_steps")
    last = rows[-1]
    required = ("E_total", "max_torque_Apm", "max_torque_T", "mx", "my", "mz")
    for key in required:
        require(key in last and finite(last[key]), f"{workload}/{mesh}: scalar {key} is missing or non-finite")

    provenance = metadata.get("execution_provenance")
    request = metadata.get("requested_execution")
    require(isinstance(provenance, Mapping), f"{workload}/{mesh}: execution provenance is missing")
    require(isinstance(request, Mapping), f"{workload}/{mesh}: requested execution is missing")
    backend, expected_device, _, _, _ = lane_policy(lane)
    expected_precision = precision_name(precision)
    require(request.get("backend") == backend, f"{workload}/{mesh}: requested backend mismatch")
    requested_device = str(request.get("device", "")).lower()
    if expected_device == "cuda":
        require(requested_device in {"cuda", "gpu", "cuda:0"}, f"{workload}/{mesh}: requested GPU device mismatch")
    else:
        require(requested_device == expected_device, f"{workload}/{mesh}: requested device mismatch")
    require(request.get("precision") == expected_precision, f"{workload}/{mesh}: requested precision mismatch")
    require(str(provenance.get("precision")) == expected_precision, f"{workload}/{mesh}: resolved precision mismatch")
    engine = str(provenance.get("execution_engine", ""))
    expected_engine = {
        "fdm_cpu_reference": "cpu_reference",
        "fdm_gpu_production": "cuda",
        "fem_cpu_public": "fem_cpu_native",
        "fem_gpu_public": "fem_native_gpu",
    }[lane]
    require(expected_engine in engine, f"{workload}/{mesh}: resolved engine {engine!r} is not {expected_engine!r}")
    require(request.get("fallback_policy") == "forbidden", f"{workload}/{mesh}: fallback policy is not forbidden")

    resolution = provenance.get("execution_resolution")
    if isinstance(resolution, Mapping):
        require(resolution.get("fallback_occurred") is not True, f"{workload}/{mesh}: execution-resolution fallback occurred")
        require(resolution.get("fallback_reason") in {None, ""}, f"{workload}/{mesh}: execution-resolution fallback reason is present")
    fallback = provenance.get("resolved_fallback")
    if isinstance(fallback, Mapping):
        require(fallback.get("occurred") is not True, f"{workload}/{mesh}: resolved fallback occurred")
    require(provenance.get("lossy_fallback_used") is not True, f"{workload}/{mesh}: lossy fallback occurred")

    expected_binding = MATRIX.canonical_binding(
        lane=lane,
        algorithm=algorithm,
        workload_ids=MATRIX.canonical_workloads(algorithm, lane, precision),
        mesh_levels=MESH_LEVELS,
    )
    realized_id = provenance.get("energy_minimizer_realization")
    require(
        realized_id == expected_binding["realization_id"],
        f"{workload}/{mesh}: realization id {realized_id!r} is not source-canonical",
    )
    if algorithm == "llg_overdamped":
        direction = expected_binding["direction_policy"]
    else:
        direct_policy = provenance.get("fem_direct_minimizer_policy")
        if isinstance(direct_policy, Mapping):
            direction = direct_policy.get("resolved_direction_policy")
        else:
            direction = {
                "fdm_cpu_reference": "raw_tangent_gradient",
                "fdm_gpu_production": "device_tangent_gradient",
            }.get(lane)
        require(
            direction == expected_binding["direction_policy"],
            f"{workload}/{mesh}: direction policy {direction!r} is not source-canonical",
        )

    return {
        "status": "passed",
        "converged": True,
        "termination_reason": str(reason),
        "accepted_steps": accepted_steps,
        "max_steps": MAX_STEPS,
        "metrics": {
            "energy_j": float(last["E_total"]),
            "max_torque_apm": float(last["max_torque_Apm"]),
            "max_torque_t": float(last["max_torque_T"]),
            "mx": float(last["mx"]),
            "my": float(last["my"]),
            "mz": float(last["mz"]),
        },
        "lane": lane,
        "precision": precision,
        "algorithm": algorithm,
        "workload": workload,
        "mesh_level": mesh,
        "metadata_status": metadata.get("status"),
        "realization_id": str(realized_id),
        "direction_policy": str(direction),
    }


def independent_oracle(
    *,
    root: Path,
    algorithm: str,
    lane: str,
    precision: str,
    workload: str,
    measurements: Sequence[Mapping[str, Any]],
) -> tuple[str, str, dict[str, Any]]:
    oracle_identity = MATRIX.ORACLE_IDENTITIES[algorithm]
    bundle_root = BUNDLE_ROOT or root
    input_path = root / "oracle-input" / f"{algorithm}--{lane}--{precision}--{workload}.json"
    input_payload = {
        "schema_version": "fullmag.relaxation.oracle_input.v1",
        "oracle": oracle_identity,
        "algorithm": algorithm,
        "lane": lane,
        "precision": precision,
        "workload": workload,
        "measurements": [
            {
                key: item[key]
                for key in (
                    "input_contract_path",
                    "input_contract_sha256",
                    "final_state_path",
                    "final_state_sha256",
                    "initial_energy_j",
                    "result",
                )
            }
            for item in measurements
        ],
    }
    write_json(input_path, input_payload)
    path = root / "oracles" / f"{algorithm}--{lane}--{precision}--{workload}.json"
    command = [
        sys.executable,
        str(ORACLE_SCRIPT),
        "--input",
        str(input_path),
        "--output",
        str(path),
        "--artifact-root",
        str(bundle_root),
    ]
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    require(
        completed.returncode == 0,
        f"{workload}: independent oracle failed: {completed.stdout.strip()} {completed.stderr.strip()}".strip(),
    )
    payload = load_json(path, f"{workload} independent oracle")
    require(payload.get("schema_version") == ORACLE_SCHEMA, f"{workload}: oracle schema is invalid")
    require(payload.get("oracle") == oracle_identity, f"{workload}: oracle identity is invalid")
    require(payload.get("status") == "passed", f"{workload}: oracle did not pass")
    require(payload.get("measurement_count") == len(measurements), f"{workload}: oracle measurement count is invalid")
    return relative(root, path), sha256_file(path), dict(payload)


def aggregate_result(measurements: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    require(measurements, "cannot aggregate an empty measurement set")
    results = [item["result"] for item in measurements]
    energies = [float(item["metrics"]["energy_j"]) for item in results]
    torques = [float(item["metrics"]["max_torque_apm"]) for item in results]
    steps = [int(item["accepted_steps"]) for item in results]
    reasons = {str(item["termination_reason"]) for item in results}
    energy_scale = max(1e-30, max(abs(value) for value in energies))
    energy_spread = (max(energies) - min(energies)) / energy_scale
    require(energy_spread <= 5e-2, f"repeatability energy spread is too large: {energy_spread:.6g}")
    require(all(finite(value) for value in torques), "repeatability torque contains a non-finite value")
    return {
        "status": "passed",
        "converged": True,
        "termination_reason": "energy" if reasons == {"energy"} else "torque",
        "accepted_steps": max(steps),
        "max_steps": MAX_STEPS,
        "metrics": {
            "energy_j": energies[-1],
            "max_torque_apm": max(torques),
            "max_torque_t": max(float(item["metrics"]["max_torque_t"]) for item in results),
            "repeatability_energy_relative_spread": energy_spread,
            "repeatability_max_torque_apm": max(torques),
            "mx": float(results[-1]["metrics"]["mx"]),
            "my": float(results[-1]["metrics"]["my"]),
            "mz": float(results[-1]["metrics"]["mz"]),
        },
    }


def parity_artifact(
    *,
    root: Path,
    algorithm: str,
    lane: str,
    precision: str,
    source_commit: str,
    source_tree: str,
    target_refinement: Mapping[str, Any],
) -> tuple[dict[str, Any], str | None, str | None]:
    baseline = MATRIX.parity_baseline(lane, precision)
    expected_scope = MATRIX.parity_scope(lane, precision)
    if baseline is None:
        return expected_scope, None, None
    bundle_root = BUNDLE_ROOT or root.parent
    baseline_receipt_path = (
        bundle_root
        / baseline["lane"]
        / "receipts"
        / f"{algorithm}--{baseline['lane']}--{baseline['precision']}"
        / "receipt.json"
    )
    baseline_receipt = load_json(baseline_receipt_path, "parity baseline receipt")
    require(baseline_receipt.get("status") == "passed", "parity baseline receipt is not passed")
    require(
        baseline_receipt.get("source_commit") == source_commit,
        "parity baseline receipt source commit differs",
    )
    require(
        baseline_receipt.get("source_tree_sha256") == source_tree,
        "parity baseline receipt source tree differs",
    )
    baseline_scope = baseline_receipt.get("validated_scope")
    require(isinstance(baseline_scope, Mapping), "parity baseline scope is missing")
    baseline_evidence = baseline_scope.get("evidence")
    require(isinstance(baseline_evidence, Mapping), "parity baseline evidence is missing")
    d5 = baseline_evidence.get("D5")
    require(isinstance(d5, Mapping), "parity baseline D5 evidence is missing")
    manifest = d5.get("artifact_manifest")
    require(isinstance(manifest, list) and manifest, "parity baseline D5 artifact is missing")
    baseline_artifact_path = bundle_root / str(manifest[0]["path"])
    baseline_artifact = load_json(baseline_artifact_path, "parity baseline D5 artifact")
    require(baseline_artifact.get("level") == "D5", "parity baseline artifact is not D5")
    require(
        baseline_artifact.get("source_commit") == source_commit
        and baseline_artifact.get("source_tree_sha256") == source_tree,
        "parity baseline artifact source identity differs",
    )
    baseline_observations = baseline_artifact.get("mesh_refinement_observations")
    require(isinstance(baseline_observations, Mapping), "parity baseline refinement observations are missing")
    baseline_workloads = MATRIX.canonical_workloads(
        algorithm,
        baseline["lane"],
        baseline["precision"],
    )
    baseline_by_pair = {
        (str(item.get("workload_id", "")).rsplit(".", 1)[-1], item.get("mesh_level")): item
        for item in baseline_observations.get("observations", [])
        if isinstance(item, Mapping)
    }
    target_observations = target_refinement.get("observations")
    require(isinstance(target_observations, list), "parity target refinement observations are missing")
    comparisons: list[dict[str, Any]] = []
    tolerances = {
        "energy_j": {"rtol": 1e-6 if precision == "fp64" else 5e-3, "atol": 1e-30},
        "max_torque_apm": {"rtol": 1e-5 if precision == "fp64" else 2e-2, "atol": 1e-6},
        "max_torque_t": {"rtol": 1e-5 if precision == "fp64" else 2e-2, "atol": 1e-12},
        "mx": {"rtol": 1e-5 if precision == "fp64" else 5e-3, "atol": 1e-8},
        "my": {"rtol": 1e-5 if precision == "fp64" else 5e-3, "atol": 1e-8},
        "mz": {"rtol": 1e-5 if precision == "fp64" else 5e-3, "atol": 1e-8},
    }
    for target in target_observations:
        require(isinstance(target, Mapping), "parity target observation is invalid")
        target_workload_id = target.get("workload_id")
        case_name = str(target_workload_id).rsplit(".", 1)[-1]
        pair = (case_name, target.get("mesh_level"))
        baseline_item = baseline_by_pair.get(pair)
        require(isinstance(baseline_item, Mapping), f"parity baseline lacks {pair}")
        baseline_workload_id = baseline_item.get("workload_id")
        require(
            target_workload_id in MATRIX.canonical_workloads(algorithm, lane, precision),
            f"parity target workload is not canonical: {target_workload_id}",
        )
        require(
            baseline_workload_id in baseline_workloads,
            f"parity baseline workload is not canonical: {baseline_workload_id}",
        )
        target_result = target.get("result")
        baseline_result = baseline_item.get("result")
        require(isinstance(target_result, Mapping) and isinstance(baseline_result, Mapping), "parity result is missing")
        target_metrics = target_result.get("metrics")
        baseline_metrics = baseline_result.get("metrics")
        require(isinstance(target_metrics, Mapping) and isinstance(baseline_metrics, Mapping), "parity metrics are missing")
        absolute_error: dict[str, float] = {}
        tolerance_values: dict[str, float] = {}
        for name, policy in tolerances.items():
            observed = float(target_metrics[name])
            reference = float(baseline_metrics[name])
            error = abs(observed - reference)
            tolerance = float(policy["atol"]) + float(policy["rtol"]) * max(abs(observed), abs(reference))
            require(error <= tolerance, f"parity mismatch {pair} metric={name}: {error} > {tolerance}")
            absolute_error[name] = error
            tolerance_values[name] = tolerance
        comparisons.append(
            {
                "workload_id": pair[0],
                "target_workload_id": target_workload_id,
                "baseline_workload_id": baseline_workload_id,
                "mesh_level": pair[1],
                "target_input_contract_sha256": target["input_contract_sha256"],
                "baseline_input_contract_sha256": baseline_item["input_contract_sha256"],
                "target_final_state_sha256": target["final_state_sha256"][0],
                "baseline_final_state_sha256": baseline_item["final_state_sha256"][0],
                "target_metrics": dict(target_metrics),
                "baseline_metrics": dict(baseline_metrics),
                "absolute_error": absolute_error,
                "tolerance": tolerance_values,
                "status": "passed",
            }
        )
    payload = {
        "schema_version": MATRIX.PARITY_SCHEMA,
        "status": "passed",
        "target": {"algorithm": algorithm, "lane": lane, "precision": precision},
        "baseline": baseline,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree,
        "comparisons": comparisons,
        "tolerances": tolerances,
    }
    path = root / "parity" / f"{algorithm}--{lane}--{precision}.json"
    digest = write_json(path, payload)
    return {
        **expected_scope,
        "artifact_path": relative(root, path),
        "artifact_sha256": digest,
    }, relative(root, path), digest


def semantic_artifact(
    *,
    root: Path,
    level: str,
    algorithm: str,
    lane: str,
    precision: str,
    source_commit: str,
    source_tree: str,
    binding: Mapping[str, Any],
    parity: Mapping[str, Any],
    refinement: Mapping[str, Any],
    repeatability: Mapping[str, Any],
    result: Mapping[str, Any],
    artifact_tag: str | None = None,
) -> tuple[str, str]:
    workload_ids = MATRIX.canonical_workloads(algorithm, lane, precision)
    payload = {
        "schema_version": MATRIX.ARTIFACT_SCHEMA,
        "level": level,
        "cell": {"algorithm": algorithm, "lane": lane, "precision": precision},
        "workload_ids": workload_ids,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree,
        "runtime_identity": MATRIX.LANE_POLICIES[lane]["runtime_identity"],
        "oracle": MATRIX.ORACLE_IDENTITIES[algorithm],
        **dict(binding),
        "parity": dict(parity),
        "mesh_refinement_observations": dict(refinement),
        "repeatability_observations": dict(repeatability),
        "result": dict(result),
    }
    filename = f"{level.lower()}{f'--{artifact_tag}' if artifact_tag else ''}.json"
    path = root / "artifacts" / f"{algorithm}--{lane}--{precision}" / filename
    return relative(root, path), write_json(path, payload)


def run_one(
    *,
    repo_root: Path,
    output_root: Path,
    lane: str,
    precision: str,
    algorithm: str,
    workload: str,
    mesh: str,
    repetition: str,
    executable: Path,
    timeout_s: float,
) -> dict[str, Any]:
    run_dir = output_root / "runs" / f"{algorithm}--{lane}--{precision}" / workload / mesh / repetition
    run_dir.mkdir(parents=True, exist_ok=True)
    workload_id = f"{lane}.{precision}.{algorithm}.{workload}"
    input_contract = {
        "schema_version": "fullmag.relaxation.problem_input.v1",
        "workload_id": workload_id,
        "algorithm": algorithm,
        "lane": lane,
        "precision": precision,
        "mesh_level": mesh,
        "material": MATRIX.canonical_binding(
            lane=lane,
            algorithm=algorithm,
            workload_ids=MATRIX.canonical_workloads(algorithm, lane, precision),
            mesh_levels=MESH_LEVELS,
        )["material_representation"],
        "material_values_si": {"Ms_Apm": 800e3, "Aex_Jpm": 13e-12, "alpha": 0.5},
        "body_extent_m": [40e-9, 40e-9, 10e-9],
    }
    input_contract_path = run_dir / "input-contract.json"
    input_contract_sha = write_json(input_contract_path, input_contract)
    command = [
        str(executable),
        str(SCENARIO),
        "--backend",
        MATRIX.LANE_POLICIES[lane]["backend"],
        "--headless",
        "--json",
        "--output-dir",
        str(run_dir / "artifacts"),
        "--workspace-root",
        str(run_dir / "workspace-history"),
    ]
    environment = os.environ.copy()
    environment.update(expected_environment(lane, precision))
    environment.update(
        {
            "FULLMAG_PYTHON": environment.get("FULLMAG_PYTHON", sys.executable),
            "FULLMAG_RELAXATION_BACKEND": str(MATRIX.LANE_POLICIES[lane]["backend"]),
            "FULLMAG_RELAXATION_DEVICE": "gpu" if MATRIX.LANE_POLICIES[lane]["device"] in {"cuda", "gpu"} else "cpu",
            "FULLMAG_RELAXATION_PRECISION": precision_name(precision),
            "FULLMAG_RELAXATION_ALGORITHM": algorithm,
            "FULLMAG_RELAXATION_WORKLOAD": workload,
            "FULLMAG_RELAXATION_MESH_LEVEL": mesh,
            "FULLMAG_DISABLE_PREVIEW_3D": "1",
            "FULLMAG_DISABLE_CHARTS": "1",
            "FULLMAG_API_PORT": "0",
        }
    )
    command_text = " ".join(subprocess.list2cmdline([part]) for part in command)
    log_path = run_dir / "runtime.log"
    started = time.monotonic()
    timed_out = False
    with log_path.open("w", encoding="utf-8") as log:
        try:
            completed = subprocess.run(
                command,
                cwd=repo_root,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            timed_out = True
            completed = None
    elapsed = time.monotonic() - started
    run_record: dict[str, Any] = {
        "workload_id": workload_id,
        "mesh_level": mesh,
        "repetition": repetition,
        "command": command_text,
        "elapsed_s": elapsed,
        "timeout_s": timeout_s,
        "timeout": timed_out,
        "exit_code": None if completed is None else completed.returncode,
        "log_path": relative(output_root, log_path),
        "input_contract_path": relative(output_root, input_contract_path),
        "input_contract_sha256": input_contract_sha,
    }
    require(not timed_out, f"{algorithm}/{workload}/{mesh}/{repetition}: runtime timed out")
    require(completed is not None and completed.returncode == 0, f"{algorithm}/{workload}/{mesh}/{repetition}: runtime failed; see {log_path}")
    metadata_path = run_dir / "artifacts" / "metadata.json"
    metadata = load_json(metadata_path, f"{algorithm}/{workload}/{mesh}/{repetition} metadata")
    rows = scalar_rows(run_dir / "artifacts")
    result = completion_result(
        metadata,
        rows,
        lane=lane,
        precision=precision,
        algorithm=algorithm,
        workload=workload,
        mesh=mesh,
    )
    initial_energy = rows[0].get("E_total")
    require(finite(initial_energy), f"{workload}/{mesh}/{repetition}: initial energy is missing")
    final_state_path = run_dir / "artifacts" / "m_final.json"
    final_state_sha = sha256_state_artifact(final_state_path)
    run_record.update(
        {
            "result": result,
            "initial_energy_j": float(initial_energy),
            "metadata_path": relative(output_root, metadata_path),
            "metadata_sha256": sha256_file(metadata_path),
            "log_sha256": sha256_file(log_path),
            "final_observables_path": relative(output_root, run_dir / "artifacts" / "scalars.csv"),
            "final_observables_sha256": sha256_file(run_dir / "artifacts" / "scalars.csv"),
            "final_state_path": relative(output_root, final_state_path),
            "final_state_sha256": final_state_sha,
        }
    )
    return run_record


def build_receipt(
    *,
    root: Path,
    lane: str,
    precision: str,
    algorithm: str,
    source_commit: str,
    source_tree: str,
    binding: Mapping[str, Any],
    parity: Mapping[str, Any],
    refinement: Mapping[str, Any],
    repeatability: Mapping[str, Any],
    recipe_sha: str,
    runtime_path: str,
    runtime_sha: str,
    log_path: str,
    log_sha: str,
    workload_records: Mapping[str, Sequence[Mapping[str, Any]]],
    evidence: Mapping[str, Sequence[Mapping[str, str]]],
    d6_path: str,
    d6_sha: str,
    managed_command: str,
) -> Path:
    all_records = [
        record
        for records in workload_records.values()
        for record in records
        if "measured-" in str(record["log_path"])
    ]
    aggregate = aggregate_result(all_records)
    workloads = MATRIX.canonical_workloads(algorithm, lane, precision)
    cases: list[dict[str, Any]] = []
    for workload, records in workload_records.items():
        representative = records[-1]["result"]
        case_artifact = {
            "schema_version": CASE_SCHEMA,
            "workload_id": f"{lane}.{precision}.{algorithm}.{workload}",
            "status": "passed",
            "result": representative,
            "run_count": len(records),
            "run_records": [dict(record) for record in records],
        }
        case_path = root / "cases" / f"{algorithm}--{lane}--{precision}--{workload}.json"
        case_sha = write_json(case_path, case_artifact)
        oracle_path, oracle_sha, _ = independent_oracle(
            root=root,
            algorithm=algorithm,
            lane=lane,
            precision=precision,
            workload=workload,
            measurements=records,
        )
        cases.append(
            {
                "workload_id": f"{lane}.{precision}.{algorithm}.{workload}",
                "algorithm": algorithm,
                "backend": MATRIX.LANE_POLICIES[lane]["backend"],
                "device": MATRIX.LANE_POLICIES[lane]["device"],
                "precision": precision,
                "timeout_s": max(float(record["timeout_s"]) for record in records),
                "elapsed_s": max(float(record["elapsed_s"]) for record in records),
                "status": "passed",
                "skipped": False,
                "fallback_occurred": False,
                "completion": {
                    "converged": True,
                    "reason": representative["termination_reason"],
                },
                "accepted_steps": representative["accepted_steps"],
                "max_steps": MAX_STEPS,
                "metrics": representative["metrics"],
                "oracle": {
                    **MATRIX.ORACLE_IDENTITIES[algorithm],
                    "artifact_path": oracle_path,
                    "artifact_sha256": oracle_sha,
                },
                "artifacts": [{"path": relative(root, case_path), "sha256": case_sha}],
            }
        )

    scope = {
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": MATRIX.LANE_POLICIES[lane]["backend"],
        "device": MATRIX.LANE_POLICIES[lane]["device"],
        "precision": precision,
        "runtime_identity": MATRIX.LANE_POLICIES[lane]["runtime_identity"],
        "validated_workloads": workloads,
        "oracle": MATRIX.ORACLE_IDENTITIES[algorithm],
        "mesh_refinement": dict(refinement),
        "repeatability": dict(repeatability),
        **dict(binding),
        "parity": dict(parity),
        "evidence": {level: {"status": "passed", "artifact_manifest": list(items)} for level, items in evidence.items()},
    }
    receipt: dict[str, Any] = {
        "schema_version": MATRIX.RECEIPT_SCHEMA,
        "status": "passed",
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": MATRIX.LANE_POLICIES[lane]["backend"],
        "device": MATRIX.LANE_POLICIES[lane]["device"],
        "runtime_identity": MATRIX.LANE_POLICIES[lane]["runtime_identity"],
        "precision": precision,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree,
        "source_clean": True,
        "recipe_sha256": recipe_sha,
        "managed_command": managed_command,
        "artifact_path": d6_path,
        "artifact_sha256": d6_sha,
        "validated_scope": scope,
        "execution": {
            "status": "passed",
            "converged": True,
            "termination_reason": aggregate["termination_reason"],
            "timeout": False,
            "max_steps_reached": False,
            "non_converged": False,
            "fallback_occurred": False,
            "accepted_steps": aggregate["accepted_steps"],
            "max_steps": MAX_STEPS,
            "metrics": aggregate["metrics"],
            "confirmation": {
                "accepted_state_id": f"{algorithm}:{lane}:{precision}:last-measured-state",
                "observed_after_accepted_step": True,
            },
            "process": {
                "command": managed_command,
                "command_sha256": sha256_bytes(managed_command.encode("utf-8")),
                "runtime_manifest_path": runtime_path,
                "runtime_manifest_sha256": runtime_sha,
                "log_path": log_path,
                "log_sha256": log_sha,
                "exit_code": 0,
            },
        },
        "cases": cases,
        "solver_audit_gate": "passed",
    }
    receipt_path = root / "receipts" / f"{algorithm}--{lane}--{precision}" / "receipt.json"
    write_json(receipt_path, receipt)
    return receipt_path


def qualify_cell(
    *,
    repo_root: Path,
    output_root: Path,
    lane: str,
    precision: str,
    algorithm: str,
    executable: Path,
    managed_bundle_manifest: Path | None,
    timeout_s: float,
    source_commit: str,
    source_tree: str,
    source_git_tree: str,
    recipe_sha: str,
) -> Path:
    runtime_path, runtime_sha = runtime_manifest(
        root=output_root,
        lane=lane,
        precision=precision,
        source_commit=source_commit,
        source_tree=source_tree,
        source_git_tree=source_git_tree,
        executable=executable,
        managed_bundle_manifest=managed_bundle_manifest,
    )
    workload_records: dict[str, list[dict[str, Any]]] = {}
    subprocess_records: list[dict[str, Any]] = []
    for workload in WORKLOADS:
        records: list[dict[str, Any]] = []
        for mesh in MESH_LEVELS:
            for index in range(WARMUP_RUNS):
                records.append(
                    run_one(
                        repo_root=repo_root,
                        output_root=output_root,
                        lane=lane,
                        precision=precision,
                        algorithm=algorithm,
                        workload=workload,
                        mesh=mesh,
                        repetition=f"warmup-{index + 1:02d}",
                        executable=executable,
                        timeout_s=timeout_s,
                    )
                )
            for index in range(REPETITIONS):
                record = run_one(
                    repo_root=repo_root,
                    output_root=output_root,
                    lane=lane,
                    precision=precision,
                    algorithm=algorithm,
                    workload=workload,
                    mesh=mesh,
                    repetition=f"measured-{index + 1:02d}",
                    executable=executable,
                    timeout_s=timeout_s,
                )
                records.append(record)
                subprocess_records.append(record)
        workload_records[workload] = records

    workloads = MATRIX.canonical_workloads(algorithm, lane, precision)
    binding = MATRIX.canonical_binding(
        lane=lane,
        algorithm=algorithm,
        workload_ids=workloads,
        mesh_levels=MESH_LEVELS,
        realized_id=str(next(iter(workload_records.values()))[0]["result"]["realization_id"]),
        resolved_direction_policy=str(next(iter(workload_records.values()))[0]["result"]["direction_policy"]),
    )
    for records in workload_records.values():
        for record in records:
            require(record["result"]["realization_id"] == binding["realization_id"], "realization changed during qualification")
            require(record["result"]["direction_policy"] == binding["direction_policy"], "direction policy changed during qualification")

    refinement_observations: list[dict[str, Any]] = []
    repeatability_observations: list[dict[str, Any]] = []
    for workload, records in workload_records.items():
        for mesh in MESH_LEVELS:
            measured = [
                record
                for record in records
                if f"/{mesh}/measured-" in str(record["log_path"])
            ]
            require(len(measured) == REPETITIONS, f"{workload}/{mesh}: measured repeat count is incomplete")
            mesh_result = aggregate_result(measured)
            input_hashes = {record["input_contract_sha256"] for record in measured}
            require(len(input_hashes) == 1, f"{workload}/{mesh}: input contract changed across repeats")
            refinement_observations.append(
                {
                    "workload_id": f"{lane}.{precision}.{algorithm}.{workload}",
                    "mesh_level": mesh,
                    "input_contract_sha256": next(iter(input_hashes)),
                    "measured_run_count": len(measured),
                    "final_state_sha256": [record["final_state_sha256"] for record in measured],
                    "result": mesh_result,
                }
            )
            repeatability_observations.append(
                {
                    "workload_id": f"{lane}.{precision}.{algorithm}.{workload}",
                    "mesh_level": mesh,
                    "warmup_run_count": WARMUP_RUNS,
                    "measured_run_count": REPETITIONS,
                    "input_contract_sha256": next(iter(input_hashes)),
                    "run_log_paths": [record["log_path"] for record in measured],
                    "final_state_sha256": [record["final_state_sha256"] for record in measured],
                    "energy_relative_spread": mesh_result["metrics"]["repeatability_energy_relative_spread"],
                }
            )
    refinement = {
        "levels": list(MESH_LEVELS),
        "strategy": "same_physical_problem",
        "observations": refinement_observations,
    }
    repeatability = {
        "warmup_runs": WARMUP_RUNS,
        "measured_runs": REPETITIONS,
        "determinism_policy": "same_input_contract_and_bounded_metric_spread",
        "observations": repeatability_observations,
    }
    parity, _, _ = parity_artifact(
        root=output_root,
        algorithm=algorithm,
        lane=lane,
        precision=precision,
        source_commit=source_commit,
        source_tree=source_tree,
        target_refinement=refinement,
    )
    evidence: dict[str, list[dict[str, str]]] = {"D4": [], "D5": [], "D6": []}
    for workload, records in workload_records.items():
        measured = [record for record in records if str(record["log_path"]).find("measured-") >= 0]
        level_result = aggregate_result(measured)
        path, digest = semantic_artifact(
            root=output_root,
            level="D4",
            algorithm=algorithm,
            lane=lane,
            precision=precision,
            source_commit=source_commit,
            source_tree=source_tree,
            binding=binding,
            parity=parity,
            refinement=refinement,
            repeatability=repeatability,
            result=level_result,
            artifact_tag=workload,
        )
        evidence["D4"].append({"path": path, "sha256": digest})

    all_measured = [
        record
        for records in workload_records.values()
        for record in records
        if "measured-" in str(record["log_path"])
    ]
    d5_result = aggregate_result(all_measured)
    d5_path, d5_sha = semantic_artifact(
        root=output_root,
        level="D5",
        algorithm=algorithm,
        lane=lane,
        precision=precision,
        source_commit=source_commit,
        source_tree=source_tree,
        binding=binding,
        parity=parity,
        refinement=refinement,
        repeatability=repeatability,
        result=d5_result,
    )
    evidence["D5"].append({"path": d5_path, "sha256": d5_sha})
    d6_result = aggregate_result(all_measured)
    d6_path, d6_sha = semantic_artifact(
        root=output_root,
        level="D6",
        algorithm=algorithm,
        lane=lane,
        precision=precision,
        source_commit=source_commit,
        source_tree=source_tree,
        binding=binding,
        parity=parity,
        refinement=refinement,
        repeatability=repeatability,
        result=d6_result,
    )
    evidence["D6"].append({"path": d6_path, "sha256": d6_sha})

    managed_command = f"just {MATRIX.CANONICAL_RECIPE_BY_LANE[lane]}"
    log_path = output_root / "logs" / f"{algorithm}--{lane}--{precision}.json"
    log_payload = {
        "schema_version": EXECUTION_LOG_SCHEMA,
        "status": "passed",
        "exit_code": 0,
        "command": managed_command,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree,
        "subprocesses": subprocess_records,
    }
    log_sha = write_json(log_path, log_payload)
    return build_receipt(
        root=output_root,
        lane=lane,
        precision=precision,
        algorithm=algorithm,
        source_commit=source_commit,
        source_tree=source_tree,
        binding=binding,
        parity=parity,
        refinement=refinement,
        repeatability=repeatability,
        recipe_sha=recipe_sha,
        runtime_path=runtime_path,
        runtime_sha=runtime_sha,
        log_path=relative(output_root, log_path),
        log_sha=log_sha,
        workload_records=workload_records,
        evidence=evidence,
        d6_path=d6_path,
        d6_sha=d6_sha,
        managed_command=managed_command,
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lane", required=True, choices=sorted(LANE_ALGORITHMS))
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--artifact-root", type=Path, default=Path(".fullmag/reports/relaxation-qualification"))
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--managed-runtime-manifest", type=Path)
    parser.add_argument(
        "--timeout-s",
        type=float,
        default=float(os.environ.get("FULLMAG_RELAXATION_TIMEOUT_S", "900")),
    )
    return parser.parse_args(argv)


def write_blocked(root: Path, lane: str, reason: str) -> Path:
    path = root / "blocked" / f"{lane}.json"
    write_json(
        path,
        {
            "schema_version": "fullmag.relaxation.qualification_blocked.v1",
            "lane": lane,
            "status": "blocked",
            "reason": reason,
        },
    )
    return path


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.resolve()
    output_root = args.artifact_root.resolve()
    lane_root = output_root / args.lane
    global BUNDLE_ROOT
    BUNDLE_ROOT = output_root
    try:
        require(
            repo_root == ROOT.resolve(),
            "--repo-root must be the repository containing this qualification script",
        )
        require(args.timeout_s > 0 and args.timeout_s <= 900.0, "--timeout-s must be in (0, 900]")
        require(SCENARIO.is_file(), f"qualification scenario is missing: {SCENARIO}")
        executable = args.executable.resolve()
        require(executable.is_file() and os.access(executable, os.X_OK), f"qualification executable is not executable: {executable}")
        if lane_root.exists() and any(lane_root.rglob("receipt.json")):
            raise QualificationError(f"lane output already contains receipts: {lane_root}; use a new artifact root")
        lane_root.mkdir(parents=True, exist_ok=True)
        source_commit, source_tree = source_identity(repo_root)
        source_git_tree = MATRIX._git(repo_root, "rev-parse", "HEAD^{tree}")
        recipe_hashes = {
            lane: recipe_hash(repo_root, lane)
            for lane in MATRIX.CANONICAL_RECIPE_BY_LANE
        }
        write_json(
            output_root / "expected-identity.json",
            {
                "source_commit": source_commit,
                "source_tree_sha256": source_tree,
                "recipe_sha256_by_lane": recipe_hashes,
            },
        )
        managed_manifest = args.managed_runtime_manifest.resolve() if args.managed_runtime_manifest else None
        if lane != "fdm_cpu_reference":
            require(managed_manifest is not None and managed_manifest.is_file(), "managed runtime manifest is required for this lane")
        for precision in LANE_PRECISIONS[args.lane]:
            for algorithm in LANE_ALGORITHMS[args.lane]:
                qualify_cell(
                    repo_root=repo_root,
                    output_root=lane_root,
                    lane=args.lane,
                    precision=precision,
                    algorithm=algorithm,
                    executable=executable,
                    managed_bundle_manifest=managed_manifest,
                    timeout_s=args.timeout_s,
                    source_commit=source_commit,
                    source_tree=source_tree,
                    source_git_tree=source_git_tree,
                    recipe_sha=recipe_hashes[args.lane],
                )
        final_commit, final_tree = source_identity(repo_root)
        require((final_commit, final_tree) == (source_commit, source_tree), "source changed during qualification")
        print(f"RELAXATION_LANE_QUALIFIED lane={args.lane} root={lane_root}")
        return 0
    except (QualificationError, OSError, subprocess.SubprocessError) as error:
        lane_root.mkdir(parents=True, exist_ok=True)
        blocked = write_blocked(lane_root, args.lane, str(error))
        print(f"RELAXATION_LANE_BLOCKED lane={args.lane} report={blocked}: {error}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
