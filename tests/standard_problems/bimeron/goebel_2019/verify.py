"""Fail-closed verification of the Göbel 2019 FDM bimeron artifact."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parent
DMI_OPERATOR_BIT = 1 << 3
MIN_RELAX_TIME_S = 20e-12
_TIME_COMPARISON_TOLERANCE = 1.0e-12
VERIFICATION_SCHEMA_VERSION = "goebel-bimeron-verification.v1"
VERIFICATION_CHECK_NAMES = (
    "strict_fp64_cuda",
    "no_fallback",
    "device_receipt_validated",
    "source_geometry",
    "source_physics",
    "hold_starts_from_relaxed_state",
    "hold_provenance_matches_relax",
    "energy_decreased",
    "initial_charge",
    "relaxed_charge",
    "held_charge",
    "charge_sign_preserved",
    "two_relaxed_cores",
    "two_held_cores",
    "background_preserved",
    "cores_resolved",
    "cores_inside_central_80_percent",
    "relax_duration",
    "hold_duration",
)


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
    for index, vector in enumerate(values):
        if not all(math.isfinite(component) for component in vector):
            raise ValueError(f"magnetization value {index} contains a non-finite component")
        norm = math.sqrt(_dot(vector, vector))
        if abs(norm - 1.0) > 5.0e-6:
            raise ValueError(
                f"magnetization value {index} is not unit length: norm={norm:.17g}"
            )

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


def _explicit_initial_scalar(path: Path) -> dict[str, float] | None:
    """Return a scalar row that explicitly identifies the stage-0 state.

    Accepted-step autosaves can omit step 0, leaving the first row as a
    post-relaxation sample.  Only a row carrying step 0 and (when present)
    time 0 is safe to use as the initial-energy baseline; callers can fall
    back to the stage-0 runtime receipt when no such row was persisted.
    """

    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        for row in reader:
            if "step" not in row:
                continue
            try:
                step = float(row["step"])
            except (TypeError, ValueError):
                continue
            if step != 0.0:
                continue
            if "time" in row or "t" in row:
                time_value = row.get("time", row.get("t"))
                try:
                    if not math.isclose(float(time_value), 0.0, abs_tol=1.0e-30):
                        continue
                except (TypeError, ValueError):
                    continue
            if "E_total" not in row:
                raise ValueError(f"initial scalar row is missing E_total in {path}")
            try:
                return {key: float(value) for key, value in row.items()}
            except (TypeError, ValueError) as exc:
                raise ValueError(f"initial scalar row is not numeric in {path}") from exc
    return None


def _stage_duration_s(
    initial_payload: dict[str, object], final_payload: dict[str, object]
) -> float:
    """Return a finite, non-negative duration recorded by two stage states."""

    try:
        initial_time = float(initial_payload["time"])
        final_time = float(final_payload["time"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("stage state time is missing or not numeric") from exc
    if not math.isfinite(initial_time) or not math.isfinite(final_time):
        raise ValueError("stage state time must be finite")
    duration = final_time - initial_time
    if duration < 0.0:
        raise ValueError(
            f"stage state time moved backwards: {initial_time:.17g} -> {final_time:.17g}"
        )
    return duration


def _stage_meets_minimum_duration(
    initial_payload: dict[str, object],
    final_payload: dict[str, object],
    minimum_s: float,
) -> bool:
    if not math.isfinite(minimum_s) or minimum_s <= 0.0:
        raise ValueError("minimum stage duration must be finite and positive")
    return _stage_duration_s(initial_payload, final_payload) >= minimum_s * (
        1.0 - _TIME_COMPARISON_TOLERANCE
    )


def _goebel_plan_has_only_expected_physics(plan: dict[str, object]) -> bool:
    """Reject receipts that silently add a second physical drive/module."""

    def is_empty(value: object) -> bool:
        if value is None:
            return True
        if isinstance(value, bool):
            return not value
        if isinstance(value, (int, float)):
            return value == 0.0
        if isinstance(value, (list, tuple, dict, str)):
            return len(value) == 0
        return False

    # The Göbel reproduction is a zero-current, zero-temperature thin film.
    # Keep this list explicit so a future plan cannot pass source_physics while
    # adding a field drive, torque, Oersted profile, thermal term, or strain.
    disallowed = (
        "external_field",
        "antenna_zeeman_masks",
        "field_drives",
        "regional_field_drive_bases",
        "inter_region_exchange",
        "spin_transport_plans",
        "fdm_gpu_charge_transports",
        "current_density",
        "stt_degree",
        "stt_beta",
        "zhang_li_formula_version",
        "zhang_li_operator_version",
        "zhang_li_target",
        "zhang_li_lande_g",
        "stt_spin_polarization",
        "stt_lambda",
        "stt_epsilon_prime",
        "stt_thickness",
        "stt_fixed_layer_position",
        "slonczewski_formula_version",
        "slonczewski_stack_normal",
        "slonczewski_target",
        "slonczewski_active_mask",
        "sot_current_density",
        "sot_xi_dl",
        "sot_xi_fl",
        "sot_sigma",
        "sot_thickness",
        "sot_formula_version",
        "sot_target",
        "sot_active_mask",
        "sot_envelope",
        "sot_drive",
        "has_oersted_cylinder",
        "oersted_current",
        "oersted_radius",
        "oersted_center",
        "oersted_axis",
        "oersted_field_xyz",
        "static_external_field_xyz",
        "oersted_time_dep_kind",
        "oersted_time_dep_freq",
        "oersted_time_dep_phase",
        "oersted_time_dep_offset",
        "oersted_time_dep_t_on",
        "oersted_time_dep_t_off",
        "oersted_realization",
        "thermal_seed_config",
        "temperature",
        "mel_b1",
        "mel_b2",
        "mel_uniform_strain",
    )
    return all(is_empty(plan.get(key)) for key in disallowed)


def _goebel_material_has_only_expected_physics(material: object) -> bool:
    """Require the Göbel material record to contain only its five source terms."""

    if not isinstance(material, dict):
        return False
    allowed = {
        "name",
        "saturation_magnetisation",
        "exchange_stiffness",
        "damping",
        "uniaxial_anisotropy_ku1",
        "anisotropy_axis",
    }
    if any(key not in allowed for key in material):
        return False
    required = {
        "saturation_magnetisation",
        "exchange_stiffness",
        "damping",
        "uniaxial_anisotropy_ku1",
        "anisotropy_axis",
    }
    return required.issubset(material)


def _initial_energy_from_log(path: Path) -> float:
    pattern = re.compile(r"stage 1/4 .*?step\s+0 .*?E_total=([-+0-9.eE]+)")
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "heartbeat" in line:
            continue
        match = pattern.search(line)
        if match:
            return float(match.group(1))
    raise ValueError(f"initial stage energy is missing from {path}")


def _receipt_contains_dmi_operator(receipt: dict[str, object]) -> bool:
    required = receipt.get("required_operator_mask")
    executed = receipt.get("executed_device_operator_mask")
    if any(
        isinstance(mask, bool) or not isinstance(mask, int)
        for mask in (required, executed)
    ):
        return False
    required_mask = int(required)
    executed_mask = int(executed)
    return (
        (required_mask & DMI_OPERATOR_BIT) == DMI_OPERATOR_BIT
        and (executed_mask & DMI_OPERATOR_BIT) == DMI_OPERATOR_BIT
    )


def verify_bundle(
    bundle: Path,
    runtime_log: Path,
    thresholds_path: Path = ROOT / "thresholds.v1.json",
    *,
    raise_on_failure: bool = True,
) -> dict[str, object]:
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    relax = bundle / "stages" / "stage_00_flat_relax"
    hold = bundle / "stages" / "stage_02_flat_run"
    initial_payload, initial = _read_state(relax / "m_initial.json")
    relaxed_payload, relaxed = _read_state(relax / "m_final.json")
    hold_initial_payload, _hold_initial = _read_state(hold / "m_initial.json")
    held_payload, held = _read_state(hold / "m_final.json")
    relax_duration_s = _stage_duration_s(initial_payload, relaxed_payload)
    hold_duration_s = _stage_duration_s(relaxed_payload, held_payload)
    relax_scalars = _last_scalar(relax / "scalars.csv")
    hold_scalars = _last_scalar(hold / "scalars.csv")
    metadata = json.loads((relax / "metadata.json").read_text(encoding="utf-8"))
    hold_metadata = json.loads((hold / "metadata.json").read_text(encoding="utf-8"))

    execution = metadata["execution_provenance"]
    resolution = execution["execution_resolution"]
    receipt = execution["fdm_gpu_execution_receipt"]
    if not runtime_log.is_file():
        raise ValueError(f"runtime log is missing: {runtime_log}")
    # Prefer an explicitly identified step-0 scalar row.  Accepted-step
    # autosaves commonly start at step 10, however, so the first row is not a
    # reliable initial-state sample.  In that case the stage-0 runtime receipt
    # is the only associated artifact carrying the initial energy and becomes
    # the baseline instead of being compared to a post-relaxation row.
    relax_initial_scalars = _explicit_initial_scalar(relax / "scalars.csv")
    runtime_log_initial_energy = _initial_energy_from_log(runtime_log)
    initial_energy = (
        relax_initial_scalars["E_total"]
        if relax_initial_scalars is not None
        else runtime_log_initial_energy
    )
    plan = metadata["execution_plan"]["backend_plan"]
    material = plan["material"]
    periodicity = plan["periodicity"]
    hold_execution = hold_metadata["execution_provenance"]
    hold_receipt = hold_execution["fdm_gpu_execution_receipt"]
    layout = held_payload["layout"]
    origin = layout["origin_m"]
    extent = [
        layout["grid_cells"][axis] * layout["cell_size"][axis]
        for axis in range(3)
    ]

    expected_layout = {
        "grid_cells": [1000, 80, 1],
        "cell_size": [0.5e-9, 0.5e-9, 0.5e-9],
        "origin_m": [-250e-9, -20e-9, -0.25e-9],
    }

    def layout_matches_source(payload: dict[str, object]) -> bool:
        candidate = payload.get("layout")
        return isinstance(candidate, dict) and all(
            candidate.get(key) == value for key, value in expected_layout.items()
        )

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
            and _receipt_contains_dmi_operator(receipt)
            and receipt["executed_device_operator_mask"] == receipt["required_operator_mask"]
            and receipt["executed_host_operator_mask"] == 0
            and receipt["executed_unknown_operator_mask"] == 0
        ),
        "source_geometry": (
            all(
                layout_matches_source(payload)
                for payload in (
                    initial_payload,
                    relaxed_payload,
                    hold_initial_payload,
                    held_payload,
                )
            )
        ),
        "source_physics": (
            plan["rotated_interfacial_dmi"] == 3e-3
            and plan.get("interfacial_dmi") is None
            and plan.get("bulk_dmi") is None
            and plan.get("enable_exchange") is True
            and plan.get("enable_demag") is True
            and plan.get("temperature", 0.0) == 0.0
            and _goebel_plan_has_only_expected_physics(plan)
            and _goebel_material_has_only_expected_physics(material)
            and material["saturation_magnetisation"] == 0.58e6
            and material["exchange_stiffness"] == 15e-12
            and material["damping"] == 0.3
            and material["uniaxial_anisotropy_ku1"] == 0.8e6
            and material["anisotropy_axis"] == [1.0, 0.0, 0.0]
            and periodicity["axes"] == ["periodic", "open", "open"]
            and periodicity["demag"] == "truncated_images"
        ),
        "hold_starts_from_relaxed_state": (
            hold_initial_payload["values"] == relaxed_payload["values"]
            and float(hold_initial_payload["time"]) == float(relaxed_payload["time"])
        ),
        "hold_provenance_matches_relax": (
            hold_metadata["source_hash"] == metadata["source_hash"]
            and hold_metadata["requested_execution"] == metadata["requested_execution"]
            and hold_execution["execution_engine"] == execution["execution_engine"]
            and hold_execution["precision"] == execution["precision"]
            and hold_receipt["validation_state"] == "validated"
            and hold_receipt["executed"] == "cuda_fdm"
            and hold_receipt["fallback_count"] == 0
            and _receipt_contains_dmi_operator(hold_receipt)
            and hold_receipt["executed_device_operator_mask"]
            == hold_receipt["required_operator_mask"]
            and hold_receipt["executed_host_operator_mask"] == 0
            and hold_receipt["executed_unknown_operator_mask"] == 0
        ),
        "energy_decreased": (
            (
                relax_initial_scalars is None
                or math.isclose(
                    runtime_log_initial_energy,
                    initial_energy,
                    rel_tol=5.0e-4,
                    abs_tol=1.0e-30,
                )
            )
            and hold_scalars["E_total"] < initial_energy
        ),
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
        "relax_duration": _stage_meets_minimum_duration(
            initial_payload, relaxed_payload, MIN_RELAX_TIME_S
        ),
        "hold_duration": _stage_meets_minimum_duration(
            relaxed_payload, held_payload, float(thresholds["min_hold_time_s"])
        ),
    }

    report = {
        "schema_version": VERIFICATION_SCHEMA_VERSION,
        "status": "passed" if all(checks.values()) else "failed",
        "check_count": len(checks),
        "checks": checks,
        "initial": initial,
        "relaxed": relaxed,
        "held": held,
        "initial_energy_j": initial_energy,
        "initial_energy_source": (
            "relax_scalars_step_0"
            if relax_initial_scalars is not None
            else "runtime_log_stage_0"
        ),
        "relaxed_energy_j": relax_scalars["E_total"],
        "held_energy_j": hold_scalars["E_total"],
        "relax_duration_s": relax_duration_s,
        "hold_duration_s": hold_duration_s,
        "verified_state_sha256": {
            "initial": hashlib.sha256((relax / "m_initial.json").read_bytes()).hexdigest(),
            "relaxed": hashlib.sha256((relax / "m_final.json").read_bytes()).hexdigest(),
            "held": hashlib.sha256((hold / "m_final.json").read_bytes()).hexdigest(),
        },
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
    if report["status"] != "passed" and raise_on_failure:
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
