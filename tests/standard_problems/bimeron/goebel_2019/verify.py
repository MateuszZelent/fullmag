"""Fail-closed verification of the Göbel 2019 FDM bimeron artifact."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parent


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _solid_angle(a: Sequence[float], b: Sequence[float], c: Sequence[float]) -> float:
    numerator = _dot(a, _cross(b, c))
    denominator = 1.0 + _dot(a, b) + _dot(b, c) + _dot(c, a)
    return 2.0 * math.atan2(numerator, denominator)


def analyze_fdm_state(
    values: Sequence[Sequence[float]],
    *,
    grid_cells: tuple[int, int, int],
    cell_size: tuple[float, float, float],
    origin: tuple[float, float, float],
    periodic_x: bool,
) -> dict[str, object]:
    nx, ny, nz = grid_cells
    expected = nx * ny * nz
    if nz != 1:
        raise ValueError(f"Göbel verifier requires one z cell, got {nz}")
    if len(values) != expected:
        raise ValueError(f"magnetization value count {len(values)} != {expected}")
    if nx < 2 or ny < 2:
        raise ValueError("topological charge requires at least a 2 x 2 grid")
    if any(len(vector) != 3 for vector in values):
        raise ValueError("every magnetization value must have three components")

    charge_sum = 0.0
    x_stop = nx if periodic_x else nx - 1
    for y_index in range(ny - 1):
        for x_index in range(x_stop):
            x_next = (x_index + 1) % nx
            lower_left = values[y_index * nx + x_index]
            lower_right = values[y_index * nx + x_next]
            upper_right = values[(y_index + 1) * nx + x_next]
            upper_left = values[(y_index + 1) * nx + x_index]
            charge_sum += _solid_angle(lower_left, lower_right, upper_right)
            charge_sum += _solid_angle(lower_left, upper_right, upper_left)

    max_index = max(range(expected), key=lambda index: values[index][2])
    min_index = min(range(expected), key=lambda index: values[index][2])

    def cell_center(index: int) -> tuple[float, float, float]:
        x_index = index % nx
        y_index = (index // nx) % ny
        z_index = index // (nx * ny)
        return (
            origin[0] + (x_index + 0.5) * cell_size[0],
            origin[1] + (y_index + 0.5) * cell_size[1],
            origin[2] + (z_index + 0.5) * cell_size[2],
        )

    max_core = cell_center(max_index)
    min_core = cell_center(min_index)
    delta_x = abs(max_core[0] - min_core[0])
    if periodic_x:
        delta_x = min(delta_x, nx * cell_size[0] - delta_x)
    delta_y = max_core[1] - min_core[1]

    return {
        "topological_charge": charge_sum / (4.0 * math.pi),
        "mean_mx": sum(vector[0] for vector in values) / expected,
        "max_mz": values[max_index][2],
        "min_mz": values[min_index][2],
        "max_mz_core_m": list(max_core),
        "min_mz_core_m": list(min_core),
        "core_separation_m": math.hypot(delta_x, delta_y),
    }


def _read_state(path: Path) -> tuple[dict[str, object], dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    layout = payload["layout"]
    analysis = analyze_fdm_state(
        payload["values"],
        grid_cells=tuple(layout["grid_cells"]),
        cell_size=tuple(layout["cell_size"]),
        origin=tuple(layout["origin_m"]),
        periodic_x=True,
    )
    return payload, analysis


def _last_scalar(path: Path) -> dict[str, float]:
    with path.open(newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    if not rows:
        raise ValueError(f"no scalar rows in {path}")
    return {key: float(value) for key, value in rows[-1].items()}


def _initial_energy_from_log(path: Path) -> float:
    pattern = re.compile(r"stage 1/4 .*?step\s+0 .*?E_total=([-+0-9.eE]+)")
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "heartbeat" in line:
            continue
        match = pattern.search(line)
        if match:
            return float(match.group(1))
    raise ValueError(f"initial stage energy is missing from {path}")


def verify_bundle(
    bundle: Path,
    runtime_log: Path,
    thresholds_path: Path = ROOT / "thresholds.v1.json",
) -> dict[str, object]:
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    relax = bundle / "stages" / "stage_00_flat_relax"
    hold = bundle / "stages" / "stage_02_flat_run"
    initial_payload, initial = _read_state(relax / "m_initial.json")
    relaxed_payload, relaxed = _read_state(relax / "m_final.json")
    _read_state(hold / "m_initial.json")
    held_payload, held = _read_state(hold / "m_final.json")
    relax_scalars = _last_scalar(relax / "scalars.csv")
    hold_scalars = _last_scalar(hold / "scalars.csv")
    metadata = json.loads((relax / "metadata.json").read_text(encoding="utf-8"))

    execution = metadata["execution_provenance"]
    resolution = execution["execution_resolution"]
    receipt = execution["fdm_gpu_execution_receipt"]
    initial_energy = _initial_energy_from_log(runtime_log)
    layout = held_payload["layout"]
    origin = layout["origin_m"]
    extent = [
        layout["grid_cells"][axis] * layout["cell_size"][axis]
        for axis in range(3)
    ]

    def core_is_central(core: object) -> bool:
        point = list(core)
        return all(
            origin[axis] + 0.1 * extent[axis]
            <= point[axis]
            <= origin[axis] + 0.9 * extent[axis]
            for axis in (0, 1)
        )

    checks: dict[str, bool] = {
        "strict_fp64_cuda": (
            metadata["requested_execution"] == {
                "backend": "fdm",
                "device": "gpu",
                "fallback_policy": "forbidden",
                "mode": "strict",
                "precision": "double",
            }
            and execution["execution_engine"] == "cuda_fdm"
            and execution["precision"] == "double"
        ),
        "no_fallback": (
            resolution["fallback_occurred"] is False
            and execution["lossy_fallback_used"] is False
            and receipt["fallback_count"] == 0
        ),
        "device_receipt_validated": (
            receipt["validation_state"] == "validated"
            and receipt["executed"] == "cuda_fdm"
            and receipt["executed_device_operator_mask"] == receipt["required_operator_mask"]
            and receipt["executed_host_operator_mask"] == 0
            and receipt["executed_unknown_operator_mask"] == 0
        ),
        "source_geometry": (
            initial_payload["layout"]["grid_cells"] == [1000, 80, 1]
            and initial_payload["layout"]["cell_size"] == [0.5e-9, 0.5e-9, 0.5e-9]
        ),
        "energy_decreased": hold_scalars["E_total"] < initial_energy,
        "initial_charge": abs(float(initial["topological_charge"])) >= thresholds["min_abs_topological_charge"],
        "relaxed_charge": abs(float(relaxed["topological_charge"])) >= thresholds["min_abs_topological_charge"],
        "held_charge": abs(float(held["topological_charge"])) >= thresholds["min_abs_topological_charge"],
        "charge_sign_preserved": (
            float(initial["topological_charge"]) * float(relaxed["topological_charge"]) > 0.0
            and float(initial["topological_charge"]) * float(held["topological_charge"]) > 0.0
        ),
        "two_relaxed_cores": (
            float(relaxed["max_mz"]) >= thresholds["min_core_abs_mz"]
            and float(relaxed["min_mz"]) <= -thresholds["min_core_abs_mz"]
        ),
        "two_held_cores": (
            float(held["max_mz"]) >= thresholds["min_core_abs_mz"]
            and float(held["min_mz"]) <= -thresholds["min_core_abs_mz"]
        ),
        "background_preserved": float(held["mean_mx"]) >= thresholds["min_background_mx"],
        "cores_resolved": float(held["core_separation_m"]) >= 2.0e-9,
        "cores_inside_central_80_percent": (
            core_is_central(held["max_mz_core_m"])
            and core_is_central(held["min_mz_core_m"])
        ),
        "hold_duration": (
            float(held_payload["time"]) - float(relaxed_payload["time"])
            >= float(thresholds["min_hold_time_s"]) * (1.0 - 1.0e-12)
        ),
    }

    report = {
        "schema_version": "goebel-bimeron-verification.v1",
        "status": "passed" if all(checks.values()) else "failed",
        "checks": checks,
        "initial": initial,
        "relaxed": relaxed,
        "held": held,
        "initial_energy_j": initial_energy,
        "relaxed_energy_j": relax_scalars["E_total"],
        "held_energy_j": hold_scalars["E_total"],
        "execution": {
            "engine": execution["execution_engine"],
            "device": receipt["device"],
            "precision": execution["precision"],
            "fallback_count": receipt["fallback_count"],
            "validation_state": receipt["validation_state"],
            "required_operator_mask": receipt["required_operator_mask"],
            "executed_device_operator_mask": receipt["executed_device_operator_mask"],
        },
    }
    if report["status"] != "passed":
        failed = ", ".join(name for name, passed in checks.items() if not passed)
        raise ValueError(f"Göbel bimeron verification failed: {failed}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--runtime-log", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify_bundle(args.bundle, args.runtime_log)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
