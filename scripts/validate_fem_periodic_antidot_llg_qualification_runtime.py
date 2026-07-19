#!/usr/bin/env python3
"""Validate the managed periodic-antidot relax-to-run LLG runtime evidence."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path
from typing import Any


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def finite(value: Any, label: str) -> float:
    require(not isinstance(value, bool), f"{label} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValidationError(f"{label} must be numeric") from error
    require(math.isfinite(result), f"{label} must be finite")
    return result


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path} must contain an object")
    return value


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def resolve_relax_workspace(report_root: Path, repository_root: Path) -> Path:
    log = (report_root / "runtime.log").read_text(encoding="utf-8")
    matches = re.findall(r'"workspace_dir":\s*"([^"]+)"', log)
    require(bool(matches), "runtime log does not publish workspace_dir")
    candidate = Path(matches[-1])
    if not candidate.is_absolute():
        candidate = repository_root / candidate
    candidate = candidate.resolve()
    history = (repository_root / ".fullmag/local-live/history").resolve()
    require(candidate.is_relative_to(history), "relax workspace must belong to local-live history")
    require(candidate.is_dir(), "relax workspace does not exist")
    return candidate


def validate_provenance(metadata: dict[str, Any], device: str, label: str) -> None:
    requested = metadata.get("requested_execution")
    require(isinstance(requested, dict), f"{label} requested_execution is missing")
    require(requested.get("backend") == "fem", f"{label} must request FEM")
    require(requested.get("device") == device, f"{label} must request {device}")
    require(requested.get("precision") == "double", f"{label} must request FP64")
    require(requested.get("mode") == "strict", f"{label} must use strict execution")
    require(requested.get("fallback_policy") == "forbidden", f"{label} must forbid fallback")
    provenance = metadata.get("execution_provenance")
    require(isinstance(provenance, dict), f"{label} execution_provenance is missing")
    require(provenance.get("lossy_fallback_used") is False, f"{label} used a lossy fallback")
    require(provenance.get("precision") == "double", f"{label} did not execute in FP64")
    require(provenance.get("resolved_demag_realization") == "fem_poisson_robin", f"{label} demag realization drifted")
    require(provenance.get("uses_gpu_poisson") is (device == "gpu"), f"{label} GPU Poisson provenance mismatch")
    if device == "cpu":
        require(provenance.get("execution_engine") == "fem_cpu_native", f"{label} CPU engine mismatch")
        require(provenance.get("uses_cuda_kernels") is False, f"{label} CPU lane used CUDA")
    else:
        require(provenance.get("execution_engine") == "fem_native_gpu", f"{label} GPU engine mismatch")
        require(provenance.get("uses_cuda_kernels") is True, f"{label} GPU lane did not use CUDA kernels")
        require(provenance.get("fem_gpu_state_allocated") is True, f"{label} GPU state was not allocated")


def validate_mesh(metadata: dict[str, Any]) -> None:
    layout = metadata.get("artifact_layout")
    mesh = metadata.get("mesh")
    require(isinstance(layout, dict) and isinstance(mesh, dict), "mesh metadata is missing")
    require(layout.get("n_nodes") == mesh.get("node_count") == 1781, "qualification mesh node count drifted")
    require(layout.get("n_elements") == mesh.get("element_count") == 8530, "qualification mesh element count drifted")
    require(mesh.get("periodic_node_pair_count") == 384, "qualification periodic node-pair count drifted")
    require(metadata.get("pbc") == {"axes": ["periodic", "periodic", "open"], "demag": "periodic_airbox_k0"}, "PBC contract drifted")


def validate_policy(config: dict[str, Any], device: str) -> None:
    require(config.get("schema_version") == "LLG-TD-SOLVER-CONFIG-V1", "solver config schema drifted")
    requested = config.get("requested_policy")
    resolved = config.get("resolved_policy")
    require(isinstance(requested, dict) and isinstance(resolved, dict), "solver policy is missing")
    expected = {
        "kind": "adaptive", "integrator": "rk45", "tolerance_mode": "max_error",
        "dt_initial_s": 1.0e-15, "dt_min_s": 1.0e-16, "dt_max_s": 1.0e-14,
        "atol": 1.0e-6, "rtol": 0.0,
    }
    for key, value in expected.items():
        require(requested.get(key) == value and resolved.get(key) == value, f"solver policy {key} drifted")
    require(resolved.get("dt_initial_reason") == "explicit", "dt_initial must remain explicitly requested")
    require(resolved.get("estimator_order") == 4, "RK45 estimator order must be four")
    identity = config.get("execution_identity")
    require(isinstance(identity, dict) and identity.get("device") == device, "solver execution identity device drifted")


def validate_fields(artifacts: Path, engine: str) -> None:
    for observable, unit, components in (
        ("m", "dimensionless", ["x", "y", "z"]),
        ("H_demag", "A/m", ["x", "y", "z"]),
        ("demag_phi", "A", ["scalar"]),
    ):
        root = artifacts / "fields" / f"{observable}.zarr"
        attrs = read_json(root / ".zattrs")
        require(attrs.get("observable") == observable, f"{observable} field identity drifted")
        require(attrs.get("unit") == unit, f"{observable} field unit drifted")
        require(attrs.get("component_order") == components, f"{observable} field components drifted")
        require(attrs.get("provenance", {}).get("execution_engine") == engine, f"{observable} field engine drifted")
        rows = read_rows(root / "samples.csv")
        require(len(rows) == 1, f"{observable} qualification must publish exactly one sample")
        require(any(path.name[0].isdigit() for path in root.iterdir()), f"{observable} has no payload chunk")


def validate(report_root: Path, device: str, repository_root: Path) -> dict[str, Any]:
    artifacts = report_root / "artifacts"
    metadata = read_json(artifacts / "metadata.json")
    require(metadata.get("status") == "completed", "run did not complete")
    validate_provenance(metadata, device, "run")
    validate_mesh(metadata)
    validate_policy(read_json(artifacts / "solver_config.json"), device)

    workspace = resolve_relax_workspace(report_root, repository_root)
    relax = workspace / "stages/stage_00_flat_relax"
    relax_metadata = read_json(relax / "metadata.json")
    require(relax_metadata.get("status") == "completed", "relax stage did not complete")
    validate_provenance(relax_metadata, device, "relax")
    validate_mesh(relax_metadata)
    qualification_key = "fem_cpu_relaxation_qualification" if device == "cpu" else "fem_gpu_relaxation_qualification"
    relaxation = relax_metadata.get(qualification_key)
    require(isinstance(relaxation, dict) and relaxation.get("converged") is True, "strict relaxation certificate is missing")
    torque = finite(relaxation.get("final_torque_apm"), "relax.final_torque_apm")
    require(torque <= 500.0, "relaxation torque exceeds 500 A/m")
    require(relaxation.get("stop_metric_kind") == "max_torque_apm", "relaxation stop metric drifted")

    attempts = read_rows(artifacts / "solver_attempts.csv")
    steps = read_rows(artifacts / "solver_steps.csv")
    require(len(attempts) == len(steps) == 1, "qualification run must contain exactly one accepted step")
    attempt = attempts[0]
    step = steps[0]
    require(attempt.get("decision") == "accepted" and attempt.get("reason") == "within_tolerance", "first RK attempt was not accepted normally")
    require(finite(attempt.get("t_s"), "attempt.t_s") == 0.0, "run clock did not start at zero")
    require(finite(attempt.get("dt_attempt_s"), "attempt.dt_attempt_s") == 1.0e-15, "first attempted dt drifted")
    require(finite(attempt.get("eta"), "attempt.eta") <= 1.0, "accepted attempt exceeds max_error")
    require(int(step.get("rejected_attempts", "-1")) == 0, "qualification run unexpectedly rejected a step")
    require(finite(step.get("t_s"), "step.t_s") == 1.0e-15, "run endpoint time drifted")
    demag_residual = finite(step.get("demag_residual"), "step.demag_residual")
    require(demag_residual <= 1.0e-12, "run demag residual exceeds requested tolerance")

    relax_final = read_json(relax / "m_final.json")
    run_initial = read_json(artifacts / "m_initial.json")
    require(relax_final.get("values") == run_initial.get("values"), "relax-to-run magnetization handoff is not bitwise exact")
    require(run_initial.get("time") == 0.0 and run_initial.get("step") == 0, "run initial state clock is not reset")

    relax_rows = read_rows(relax / "scalars.csv")
    require(bool(relax_rows), "relax scalars are missing")
    require(all(finite(row.get("time"), "relax.time") == 0.0 for row in relax_rows), "relaxation advanced physical time")
    relax_energy = finite(relax_rows[-1].get("E_total"), "relax.E_total")
    run_energy = finite(step.get("e_total_j"), "run.E_total")
    energy_delta = run_energy - relax_energy
    energy_budget = max(1.0e-28, abs(relax_energy) * 1.0e-9)
    require(energy_delta <= energy_budget, "autonomous high-damping run energy increase exceeds numerical budget")

    seam = read_json(artifacts / "diagnostics/fem_static_pbc_demag_seams.v1.json")
    require(seam.get("status") == "ok", "PBC demag seam diagnostic failed")
    pairs = seam.get("pair_diagnostics")
    require(isinstance(pairs, list) and len(pairs) == 6, "PBC seam evidence must cover all six boundary pairs")
    require({row.get("pair_id") for row in pairs} == {"x_faces", "y_faces"}, "PBC seam axes drifted")
    for row in pairs:
        require(row.get("status") == "ok", "a PBC seam pair failed")
        for key in ("m_seam_max", "h_demag_seam_max_Apm", "demag_phi_seam_max_after_offset_A", "b_normal_flux_seam_max_T"):
            require(finite(row.get(key), f"seam.{key}") <= 1.0e-12, f"PBC {key} exceeds qualification budget")

    engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    validate_fields(artifacts, engine)
    return {
        "schema_version": "fem_periodic_antidot_llg_runtime_qualification.v1",
        "status": "pass",
        "device": device,
        "precision": "fp64",
        "mesh": {"nodes": 1781, "elements": 8530, "periodic_node_pairs": 384},
        "relaxation": {"converged": True, "final_torque_apm": torque, "physical_time_s": 0.0},
        "relax_to_run": {"state_handoff_exact": True, "run_initial_time_s": 0.0},
        "run": {"endpoint_time_s": 1.0e-15, "attempts": 1, "accepted_steps": 1, "eta": finite(attempt["eta"], "attempt.eta"), "demag_residual": demag_residual},
        "energy": {"relax_final_j": relax_energy, "run_final_j": run_energy, "delta_j": energy_delta, "increase_budget_j": energy_budget},
        "pbc_seams": {"status": "ok", "boundary_pairs": 6},
        "fields": ["m", "H_demag", "demag_phi"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report_root", type=Path)
    parser.add_argument("--device", choices=("cpu", "gpu"), required=True)
    parser.add_argument("--repository-root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.report_root / "periodic_antidot_qualification.json"
    try:
        evidence = validate(args.report_root.resolve(), args.device, args.repository_root.resolve())
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError, ValidationError) as error:
        print(f"FAIL: {error}")
        return 1
    print(f"FEM periodic-antidot relax-to-run {args.device.upper()} FP64 qualification PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
