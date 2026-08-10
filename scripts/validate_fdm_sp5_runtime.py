#!/usr/bin/env python3
"""Validate full fixed-step FDM Standard Problem 5 CPU/CUDA artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

try:
    from scripts.compare_fdm_sp5_mumax_fields import read_ovf2_binary4, vector_metrics
except ModuleNotFoundError:
    from compare_fdm_sp5_mumax_fields import (  # type: ignore[no-redef]
        read_ovf2_binary4,
        vector_metrics,
    )


MUMAX3_REFERENCE_MEAN = (
    -0.23488366603851318,
    -0.0945328027009964,
    0.022961989045143127,
)
EXPECTED_GRID = [32, 32, 4]
EXPECTED_CELL_M = [3.125e-9, 3.125e-9, 2.5e-9]
EXPECTED_TIME_S = 1e-9


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing required artifact: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON artifact: {path}: {exc}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_converged_reference(path: Path) -> list[tuple[float, float, float]]:
    field = read_ovf2_binary4(path)
    require(list(field.shape) == EXPECTED_GRID, "converged reference grid must be [32, 32, 4]")
    return field.values


def validate_run(root: Path, *, expected_engine: str, expected_device: str) -> dict[str, Any]:
    metadata = load_json(root / "metadata.json")
    field = load_json(root / "m_final.json")
    trace = load_json(root / "solver" / "accepted_steps.v1.json")
    graph_provenance = load_json(root / "physics" / "physics_graph_provenance.v1.json")
    provenance = field.get("provenance", {})
    resolved_time = provenance.get("timestep_policy", {}).get("resolved", {})
    steps = trace.get("steps")
    timestep_s = resolved_time.get("timestep_s")

    require(metadata.get("problem_name") == "mumax_standard_problem_5_fdm", "wrong problem_name")
    requested = metadata.get("requested_execution", {})
    require(requested.get("backend") == "fdm", "requested backend must be fdm")
    require(requested.get("device") == expected_device, f"requested device must be {expected_device}")
    require(requested.get("precision") == "double", "requested precision must be double")
    require(requested.get("fallback_policy") == "forbidden", "fallback_policy must be forbidden")
    require(provenance.get("execution_engine") == expected_engine, f"execution_engine must be {expected_engine}")
    require(provenance.get("precision") == "double", "resolved precision must be double")
    require(provenance.get("lossy_fallback_used") is False, "lossy fallback is forbidden")
    realization = graph_provenance.get("realization", {})
    require(
        realization.get("executed_module_ids") == ["sp5_zhang_li"],
        "physics graph must confirm sp5_zhang_li as the executed module",
    )
    realized_modules = realization.get("modules")
    require(
        isinstance(realized_modules, list)
        and len(realized_modules) == 1
        and realized_modules[0].get("module_id") == "sp5_zhang_li"
        and realized_modules[0].get("state") == "executed"
        and realized_modules[0].get("realized_cell_count") == 4096,
        "sp5_zhang_li realization must be executed on all 4096 cells",
    )
    require(resolved_time.get("kind") == "fixed", "SP5 qualification requires fixed timestep")
    require(
        isinstance(timestep_s, (int, float))
        and math.isfinite(timestep_s)
        and timestep_s > 0.0,
        "fixed timestep_s must be positive and finite",
    )
    expected_steps_float = EXPECTED_TIME_S / timestep_s
    expected_steps = round(expected_steps_float)
    require(
        expected_steps > 0
        and math.isclose(expected_steps_float, expected_steps, rel_tol=0.0, abs_tol=1e-9),
        "fixed timestep must divide the 1 ns SP5 interval into an integer number of steps",
    )
    require(field.get("observable") == "m", "m_final observable must be m")
    require(field.get("unit") == "1", "m_final unit must be canonical dimensionless unit '1'")
    require(field.get("layout", {}).get("grid_cells") == EXPECTED_GRID, "grid_cells must be [32, 32, 4]")
    cell = field.get("layout", {}).get("cell_size")
    require(isinstance(cell, list) and len(cell) == 3, "cell_size must have three components")
    require(all(math.isclose(a, b, rel_tol=0.0, abs_tol=1e-21) for a, b in zip(cell, EXPECTED_CELL_M)), "cell_size does not match SP5")
    require(math.isclose(field.get("time", -1.0), EXPECTED_TIME_S, rel_tol=0.0, abs_tol=1e-18), "m_final time must be 1 ns")
    require(field.get("step") == expected_steps, f"m_final step must be {expected_steps}")
    require(trace.get("schema_version") == "LLG-TD-ACCEPTED-TRACE-V1", "wrong accepted-step trace schema")
    require(isinstance(steps, list) and len(steps) == expected_steps, f"accepted-step trace must contain {expected_steps} records")
    require(metadata.get("accepted_solver_steps") == expected_steps, f"metadata accepted_solver_steps must be {expected_steps}")
    require(steps[-1].get("step") == expected_steps, f"accepted-step trace must end at step {expected_steps}")
    require(math.isclose(steps[-1].get("time", -1.0), EXPECTED_TIME_S, rel_tol=0.0, abs_tol=1e-18), "accepted-step trace must end at 1 ns")

    values = field.get("values")
    require(isinstance(values, list) and len(values) == 4096, "m_final must contain 4096 vectors")
    require(all(isinstance(vector, list) and len(vector) == 3 for vector in values), "each m_final value must be a 3-vector")
    mean = [sum(vector[axis] for vector in values) / len(values) for axis in range(3)]
    return {
        "root": str(root),
        "execution_engine": expected_engine,
        "device": expected_device,
        "timestep_s": timestep_s,
        "accepted_steps": expected_steps,
        "executed_module_ids": realization.get("executed_module_ids"),
        "mean_m": mean,
        "values": values,
        "schedule": [(step.get("step"), step.get("time"), step.get("dt")) for step in steps],
    }


def validate_runs(
    cpu_root: Path,
    gpu_root: Path,
    *,
    reference_tolerance: float = 1e-4,
    parity_tolerance: float = 1e-12,
    converged_reference_values: list[tuple[float, float, float]] | None = None,
    converged_reference_tolerance: float = 1e-4,
    qualification_reference: str = "literal",
) -> dict[str, Any]:
    cpu = validate_run(cpu_root, expected_engine="cpu_reference", expected_device="cpu")
    gpu = validate_run(gpu_root, expected_engine="cuda_fdm", expected_device="gpu")
    require(cpu["timestep_s"] == gpu["timestep_s"], "CPU and CUDA timestep differ")
    require(cpu["schedule"] == gpu["schedule"], "CPU and CUDA accepted-step schedules differ")

    differences = [
        abs(cpu_vector[axis] - gpu_vector[axis])
        for cpu_vector, gpu_vector in zip(cpu["values"], gpu["values"])
        for axis in range(3)
    ]
    parity_max = max(differences)
    parity_rms = math.sqrt(sum(value * value for value in differences) / len(differences))
    reference_errors = [abs(cpu["mean_m"][axis] - MUMAX3_REFERENCE_MEAN[axis]) for axis in range(3)]
    reference_max = max(reference_errors)
    parity_pass = parity_max <= parity_tolerance
    reference_pass = reference_max <= reference_tolerance

    require(
        qualification_reference in {"literal", "converged_demag"},
        "qualification_reference must be literal or converged_demag",
    )
    converged_reference: dict[str, Any] | None = None
    converged_pass = False
    if converged_reference_values is not None:
        require(
            len(converged_reference_values) == len(cpu["values"]),
            "converged reference field must contain 4096 vectors",
        )
        metrics = vector_metrics(cpu["values"], converged_reference_values)
        converged_pass = (
            float(metrics["max_abs_component_error"])
            <= converged_reference_tolerance
        )
        converged_reference = {
            "status": "pass" if converged_pass else "fail",
            "reference_kind": "mumax3_demag_accuracy_convergence",
            "tolerance": converged_reference_tolerance,
            **metrics,
        }
    if qualification_reference == "converged_demag":
        require(
            converged_reference is not None,
            "converged_demag qualification requires a full-field reference",
        )
    selected_reference_pass = (
        reference_pass if qualification_reference == "literal" else converged_pass
    )

    report = {
        "schema_version": "fullmag.fdm_sp5_qualification.v1",
        "qualification_status": (
            "qualified" if parity_pass and selected_reference_pass else "not_qualified"
        ),
        "qualification_reference": qualification_reference,
        "cpu": {key: value for key, value in cpu.items() if key not in {"values", "schedule"}},
        "gpu": {key: value for key, value in gpu.items() if key not in {"values", "schedule"}},
        "cpu_cuda_parity": {
            "status": "pass" if parity_pass else "fail",
            "tolerance": parity_tolerance,
            "max_abs_component_error": parity_max,
            "vector_component_rms": parity_rms,
            "accepted_schedule_equal": True,
        },
        "mumax3_reference": {
            "status": "pass" if reference_pass else "fail",
            "reference_mean_m": list(MUMAX3_REFERENCE_MEAN),
            "tolerance": reference_tolerance,
            "component_abs_errors": reference_errors,
            "max_abs_component_error": reference_max,
        },
    }
    if converged_reference is not None:
        report["mumax3_converged_demag_reference"] = converged_reference
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference-tolerance", type=float, default=1e-4)
    parser.add_argument("--parity-tolerance", type=float, default=1e-12)
    parser.add_argument("--converged-reference-ovf", type=Path)
    parser.add_argument("--converged-reference-tolerance", type=float, default=1e-4)
    parser.add_argument(
        "--qualification-reference",
        choices=("literal", "converged_demag"),
        default="literal",
    )
    args = parser.parse_args()
    report = validate_runs(
        args.cpu,
        args.gpu,
        reference_tolerance=args.reference_tolerance,
        parity_tolerance=args.parity_tolerance,
        converged_reference_values=(
            load_converged_reference(args.converged_reference_ovf)
            if args.converged_reference_ovf is not None
            else None
        ),
        converged_reference_tolerance=args.converged_reference_tolerance,
        qualification_reference=args.qualification_reference,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["qualification_status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
