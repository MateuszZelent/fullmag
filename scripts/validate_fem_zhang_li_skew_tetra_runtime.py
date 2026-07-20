#!/usr/bin/env python3
"""Validate artifacts from the named managed FEM Zhang-Li workload."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path


EXPECTED_STEPS = 10
# Frozen before executing this workload.  The source contract establishes the
# local algebraic tolerance; this separate trajectory threshold is deliberately
# not derived from the result being checked.
CPU_GPU_TRAJECTORY_RTOL = 2.0e-9
CPU_GPU_TRAJECTORY_ATOL = 1.0e-11


def result_from_log(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    candidates: list[dict[str, object]] = []
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "artifact_dir" in value and "total_steps" in value:
            candidates.append(value)
    if not candidates:
        raise ValueError(f"{path} does not contain the CLI run summary")
    return candidates[-1]


def flat_m(result: dict[str, object]) -> list[float]:
    artifact_dir = result.get("artifact_dir")
    if not isinstance(artifact_dir, str):
        raise ValueError("runtime result has no artifact directory")
    final_path = Path(artifact_dir) / "m_final.json"
    values = json.loads(final_path.read_text(encoding="utf-8")).get("values")
    if not isinstance(values, list) or not values:
        raise ValueError("runtime result has no final magnetization")
    return [float(component) for vector in values for component in vector]


def artifact_metadata(result: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    """Return the runner-written final-field provenance and executed FEM plan."""
    artifact_dir = Path(str(result["artifact_dir"]))
    final = json.loads((artifact_dir / "m_final.json").read_text(encoding="utf-8"))
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    if not isinstance(final, dict) or not isinstance(metadata, dict):
        raise ValueError("runtime artifact metadata is not an object")
    return final, metadata


def initial_m(result: dict[str, object]) -> list[float]:
    artifact_dir = result["artifact_dir"]
    values = json.loads((Path(artifact_dir) / "m_initial.json").read_text(encoding="utf-8"))["values"]
    return [float(component) for vector in values for component in vector]


def volume_weighted_average(result: dict[str, object], mesh_path: Path) -> list[float]:
    values = json.loads((Path(str(result["artifact_dir"])) / "m_final.json").read_text(encoding="utf-8"))["values"]
    mesh = json.loads(mesh_path.read_text(encoding="utf-8"))
    nodes = mesh["nodes"]
    total_volume = 0.0
    total = [0.0, 0.0, 0.0]
    for tet in mesh["elements"]:
        a, b, c, d = (nodes[index] for index in tet)
        jacobian = (
            (b[0] - a[0], c[0] - a[0], d[0] - a[0]),
            (b[1] - a[1], c[1] - a[1], d[1] - a[1]),
            (b[2] - a[2], c[2] - a[2], d[2] - a[2]),
        )
        volume = abs(
            jacobian[0][0] * (jacobian[1][1] * jacobian[2][2] - jacobian[1][2] * jacobian[2][1])
            - jacobian[0][1] * (jacobian[1][0] * jacobian[2][2] - jacobian[1][2] * jacobian[2][0])
            + jacobian[0][2] * (jacobian[1][0] * jacobian[2][1] - jacobian[1][1] * jacobian[2][0])
        ) / 6.0
        for component in range(3):
            total[component] += volume * sum(float(values[index][component]) for index in tet) / 4.0
        total_volume += volume
    return [value / total_volume for value in total]


def norm_difference(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((left - right) ** 2 for left, right in zip(a, b, strict=True)))


def observed_order(coarse: list[float], medium: list[float], fine: list[float]) -> float:
    first = norm_difference(coarse, medium)
    second = norm_difference(medium, fine)
    if first <= 0.0 or second <= 0.0:
        raise ValueError("convergence study has zero successive difference")
    return math.log(first / second, 2.0)


def close(a: list[float], b: list[float]) -> bool:
    return all(abs(x - y) <= CPU_GPU_TRAJECTORY_ATOL + CPU_GPU_TRAJECTORY_RTOL * max(abs(x), abs(y)) for x, y in zip(a, b, strict=True))


def check_run(name: str, result: dict[str, object], expected_steps: int = EXPECTED_STEPS) -> None:
    if result["status"] != "completed":
        raise ValueError(f"{name}: status is {result['status']!r}")
    if result["total_steps"] != expected_steps:
        raise ValueError(f"{name}: expected {expected_steps} steps, got {result['total_steps']!r}")
    if not all(math.isfinite(value) for value in flat_m(result)):
        raise ValueError(f"{name}: non-finite final magnetization")


def check_runtime_provenance(name: str, result: dict[str, object], expected_engine: str, expected_mesh: Path, expected_device: str) -> dict[str, object]:
    """Fail closed on runner-written requested intent and resolved FEM provenance."""
    final, metadata = artifact_metadata(result)
    requested = result.get("requested_execution")
    provenance = final.get("provenance")
    layout = final.get("layout")
    plan = metadata.get("execution_plan", {}).get("backend_plan")
    execution_provenance = metadata.get("execution_provenance")
    artifact_requested = metadata.get("requested_execution")
    if not isinstance(requested, dict):
        raise ValueError(f"{name}: runtime result lacks requested execution provenance")
    if not isinstance(artifact_requested, dict):
        raise ValueError(f"{name}: artifact lacks requested execution provenance")
    if not isinstance(provenance, dict) or not isinstance(layout, dict) or not isinstance(plan, dict) or not isinstance(execution_provenance, dict):
        raise ValueError(f"{name}: final artifact lacks native FEM provenance/layout/plan")
    if requested.get("backend") != "fem":
        raise ValueError(f"{name}: requested backend is {requested.get('backend')!r}, expected 'fem'")
    if requested.get("device") != expected_device:
        raise ValueError(f"{name}: requested device is {requested.get('device')!r}, expected {expected_device!r}")
    if requested.get("precision") != "double" or requested.get("mode") != "strict":
        raise ValueError(f"{name}: requested execution must be strict double precision")
    if requested.get("fallback_policy") != "forbidden":
        raise ValueError(f"{name}: requested fallback policy is not forbidden")
    for key in ("backend", "device", "precision", "mode", "fallback_policy"):
        if artifact_requested.get(key) != requested.get(key):
            raise ValueError(f"{name}: artifact requested execution disagrees with CLI summary for {key}")
    if artifact_requested.get("backend") != "fem" or artifact_requested.get("device") != expected_device:
        raise ValueError(f"{name}: artifact requested execution does not match the required FEM {expected_device} run")
    if artifact_requested.get("precision") != "double" or artifact_requested.get("mode") != "strict":
        raise ValueError(f"{name}: artifact requested execution must be strict double precision")
    if artifact_requested.get("fallback_policy") != "forbidden":
        raise ValueError(f"{name}: artifact requested fallback policy is not forbidden")
    if result.get("backend") != "fem" or result.get("mode") != "strict" or result.get("precision") != "double":
        raise ValueError(f"{name}: run summary resolved execution is not strict FEM double")
    if provenance.get("execution_engine") != expected_engine:
        raise ValueError(f"{name}: resolved engine is {provenance.get('execution_engine')!r}, expected {expected_engine!r}")
    if provenance.get("execution_mode") != "strict":
        raise ValueError(f"{name}: resolved execution mode is not strict")
    if provenance.get("precision") != "double" or plan.get("precision") != "double":
        raise ValueError(f"{name}: runtime did not resolve double precision")
    if execution_provenance.get("execution_engine") != expected_engine or execution_provenance.get("precision") != "double":
        raise ValueError(f"{name}: artifact execution provenance disagrees with resolved engine/precision")
    if execution_provenance.get("lossy_fallback_used") is not False:
        raise ValueError(f"{name}: artifact reports a lossy fallback")
    mesh_source = layout.get("mesh_source")
    if not isinstance(mesh_source, str) or Path(mesh_source).resolve() != expected_mesh.resolve():
        raise ValueError(f"{name}: resolved mesh source does not match requested fixture")
    if plan.get("integrator") != "heun":
        raise ValueError(f"{name}: resolved integrator is {plan.get('integrator')!r}, expected 'heun'")
    if not isinstance(plan.get("fixed_timestep"), (int, float)) or plan["fixed_timestep"] <= 0:
        raise ValueError(f"{name}: resolved fixed timestep is invalid")
    material = plan.get("material")
    if not isinstance(material, dict) or material.get("saturation_magnetisation") != 800000.0 or material.get("damping") != 0.02:
        raise ValueError(f"{name}: resolved Py material parameters differ from fixture")
    return {"requested": artifact_requested, "provenance": provenance, "layout": layout, "plan": plan}


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    parser.add_argument("--cpu-reversed", type=Path, required=True)
    parser.add_argument("--cpu-zero-current", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--acceptance-manifest", type=Path, required=True)
    parser.add_argument("--dt-log", type=Path, action="append", default=[])
    parser.add_argument("--mesh-run", action="append", default=[])
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cpu, gpu, reversed_cpu, zero_current_cpu = (result_from_log(path) for path in (args.cpu, args.gpu, args.cpu_reversed, args.cpu_zero_current))
    for name, result in (("cpu", cpu), ("gpu", gpu), ("cpu_reversed", reversed_cpu), ("cpu_zero_current", zero_current_cpu)):
        check_run(name, result)
    fixture_mesh = Path("examples/assets/zhang_li_skew_tetra_r0.mesh.json")
    cpu_runtime = check_runtime_provenance("cpu", cpu, "fem_cpu_native", fixture_mesh, "cpu")
    gpu_runtime = check_runtime_provenance("gpu", gpu, "fem_native_gpu", fixture_mesh, "gpu")
    check_runtime_provenance("cpu_reversed", reversed_cpu, "fem_cpu_native", fixture_mesh, "cpu")
    check_runtime_provenance("cpu_zero_current", zero_current_cpu, "fem_cpu_native", fixture_mesh, "cpu")
    cpu_m, gpu_m, reversed_m = flat_m(cpu), flat_m(gpu), flat_m(reversed_cpu)
    if len(cpu_m) != len(gpu_m) or not close(cpu_m, gpu_m):
        raise ValueError("CPU/GPU 10-step trajectory exceeds frozen mixed tolerance")
    if close(cpu_m, reversed_m):
        raise ValueError("current reversal did not change the 10-step trajectory")
    zero_current_m = flat_m(zero_current_cpu)
    forward_delta = [value - baseline for value, baseline in zip(cpu_m, zero_current_m, strict=True)]
    reverse_delta = [value - baseline for value, baseline in zip(reversed_m, zero_current_m, strict=True)]
    if sum(a * b for a, b in zip(forward_delta, reverse_delta, strict=True)) >= 0.0:
        raise ValueError("current reversal did not reverse the Zhang-Li trajectory displacement")
    if not args.manifest.is_file():
        raise ValueError(f"managed runtime manifest is missing: {args.manifest}")
    runtime_manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(runtime_manifest.get("binaries"), dict) or not isinstance(runtime_manifest.get("integrity"), dict):
        raise ValueError("managed runtime manifest has no binary integrity provenance")
    acceptance = json.loads(args.acceptance_manifest.read_text(encoding="utf-8"))
    convergence = acceptance.get("convergence")
    if not isinstance(convergence, dict):
        raise ValueError("acceptance manifest has no frozen convergence threshold")
    study = json.loads(args.study.read_text(encoding="utf-8"))
    if study.get("schema") != "fem_zhang_li_skew_tetra_convergence_study.v1" or study.get("identity") == acceptance.get("identity"):
        raise ValueError("acceptance manifest must cite a distinct frozen convergence study")
    if len(args.dt_log) != 3 or len(args.mesh_run) != 3:
        raise ValueError("expected exactly three dt logs and three mesh runs")
    dt_runs = [result_from_log(path) for path in args.dt_log]
    # Every level now lands exactly on the shared requested physical time.
    for index, (result, expected_steps) in enumerate(zip(dt_runs, (32, 64, 128), strict=True)):
        check_run(f"dt[{index}]", result, expected_steps)
        check_runtime_provenance(f"dt[{index}]", result, "fem_cpu_native", fixture_mesh, "cpu")
    dt_order = observed_order(*(flat_m(result) for result in dt_runs))
    mesh_averages: list[list[float]] = []
    mesh_logs: list[str] = []
    for index, item in enumerate(args.mesh_run):
        mesh_text, separator, log_text = item.partition("=")
        if not separator:
            raise ValueError("mesh run must be MESH_PATH=LOG_PATH")
        result = result_from_log(Path(log_text))
        check_run(f"mesh[{index}]", result)
        mesh_path = Path(mesh_text)
        check_runtime_provenance(f"mesh[{index}]", result, "fem_cpu_native", mesh_path, "cpu")
        mesh_averages.append(volume_weighted_average(result, mesh_path))
        mesh_logs.append(log_text)
    mesh_order = observed_order(*mesh_averages)
    minimum_dt_order = float(convergence["minimum_dt_order"])
    minimum_mesh_order = float(convergence["minimum_mesh_order"])
    if dt_order < minimum_dt_order:
        raise ValueError(f"observed dt order {dt_order:.6g} is below frozen threshold {minimum_dt_order:.6g}")
    if mesh_order < minimum_mesh_order:
        raise ValueError(f"observed mesh order {mesh_order:.6g} is below frozen threshold {minimum_mesh_order:.6g}")
    payload = {
        "schema": "fem_zhang_li_skew_tetra_runtime.v1",
        "repository_head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "requested": {
            "cpu": cpu_runtime["requested"],
            "gpu": gpu_runtime["requested"],
            "steps": EXPECTED_STEPS,
            "integrator": "heun",
            "mesh": str(fixture_mesh),
        },
        "resolved": {
            "cpu": cpu_runtime,
            "gpu": gpu_runtime,
            "same_mesh_sha256": hashlib.sha256(fixture_mesh.read_bytes()).hexdigest(),
        },
        "acceptance": {"cpu_gpu_rtol": CPU_GPU_TRAJECTORY_RTOL, "cpu_gpu_atol": CPU_GPU_TRAJECTORY_ATOL},
        "convergence": {"observed_dt_order": dt_order, "observed_mesh_order": mesh_order, "minimum_dt_order": minimum_dt_order, "minimum_mesh_order": minimum_mesh_order, "mesh_volume_averages": mesh_averages},
        "runtime_bundle": {
            "manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
            "runtime": runtime_manifest.get("runtime"),
            "binaries": runtime_manifest["binaries"],
            "integrity": runtime_manifest["integrity"],
        },
        "study_sha256": hashlib.sha256(args.study.read_bytes()).hexdigest(),
        "input_sha256": hashlib.sha256(Path("examples/fem_zhang_li_skew_tetra_runtime.py").read_bytes()).hexdigest(),
        "logs": {"cpu": str(args.cpu), "gpu": str(args.gpu), "cpu_reversed": str(args.cpu_reversed), "cpu_zero_current": str(args.cpu_zero_current)},
    }
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(payload, sort_keys=True))


if __name__ == "__main__":
    main()
