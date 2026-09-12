from __future__ import annotations

import json
import math
from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.verify import (
    MIN_RELAX_TIME_S,
    _receipt_contains_dmi_operator,
    _goebel_plan_has_only_expected_physics,
    _initial_energy_from_log,
    _stage_duration_s,
    _stage_meets_minimum_duration,
    analyze_fdm_state,
    verify_bundle,
)


def test_goebel_source_physics_rejects_extra_drives_and_torques() -> None:
    assert _goebel_plan_has_only_expected_physics({})
    for key, value in (
        ("external_field", [1.0, 0.0, 0.0]),
        ("field_drives", [{"id": "drive"}]),
        ("spin_transport_plans", [{"id": "transport"}]),
        ("sot_current_density", 1.0),
        ("has_oersted_cylinder", True),
        ("mel_b1", 1.0),
        ("temperature", 300.0),
    ):
        plan = {key: value}
        assert not _goebel_plan_has_only_expected_physics(plan), key


def _analytic_bimeron(nx: int, ny: int) -> list[list[float]]:
    values: list[list[float]] = []
    radius = 10.0
    width = 3.0
    for y_index in range(ny):
        y = y_index + 0.5 - ny / 2.0
        for x_index in range(nx):
            x = x_index + 0.5 - nx / 2.0
            distance = math.hypot(x, y)
            theta = math.asin(math.tanh((distance - radius) / width)) + math.asin(
                math.tanh((distance + radius) / width)
            )
            phase = math.atan2(y, x)
            values.append(
                [
                    -math.cos(theta),
                    -math.sin(theta) * math.sin(phase),
                    -math.sin(theta) * math.cos(phase),
                ]
            )
    return values


def test_analyze_fdm_state_recovers_bimeron_charge_and_two_cores() -> None:
    result = analyze_fdm_state(
        _analytic_bimeron(80, 40),
        grid_cells=(80, 40, 1),
        cell_size=(1e-9, 1e-9, 0.5e-9),
        origin=(-40e-9, -20e-9, -0.25e-9),
        periodic_x=True,
    )

    assert result["topological_charge"] > 0.99
    assert result["max_mz"] > 0.98
    assert result["min_mz"] < -0.98
    assert result["mean_mx"] > 0.78
    assert result["core_separation_m"] > 18e-9


def test_analyze_fdm_state_rejects_shape_mismatch() -> None:
    try:
        analyze_fdm_state(
            [[1.0, 0.0, 0.0]],
            grid_cells=(2, 2, 1),
            cell_size=(1.0, 1.0, 1.0),
            origin=(0.0, 0.0, 0.0),
            periodic_x=True,
        )
    except ValueError as exc:
        assert "value count" in str(exc)
    else:
        raise AssertionError("shape mismatch must fail closed")


def test_analyze_fdm_state_rejects_non_unit_or_non_finite_vectors() -> None:
    for invalid in ([2.0, 0.0, 0.0], [math.nan, 0.0, 1.0]):
        values = [[1.0, 0.0, 0.0] for _ in range(4)]
        values[2] = invalid
        try:
            analyze_fdm_state(
                values,
                grid_cells=(2, 2, 1),
                cell_size=(1.0, 1.0, 1.0),
                origin=(0.0, 0.0, 0.0),
                periodic_x=True,
            )
        except ValueError as exc:
            assert "magnetization value 2" in str(exc)
        else:
            raise AssertionError("invalid magnetization must fail closed")


def test_initial_energy_ignores_zero_heartbeat(tmp_path: Path) -> None:
    runtime_log = tmp_path / "runtime.log"
    runtime_log.write_text(
        "stage 1/4 (flat_relax) heartbeat step 0 E_total=0.0000e0\n"
        "stage 1/4 (flat_relax) step 0 E_total=-7.4885e-18\n",
        encoding="utf-8",
    )

    assert _initial_energy_from_log(runtime_log) == -7.4885e-18


def test_relaxation_duration_floor_rejects_a_short_stage() -> None:
    assert MIN_RELAX_TIME_S == 20e-12
    initial = {"time": 0.0}
    completed = {"time": MIN_RELAX_TIME_S}
    short = {"time": MIN_RELAX_TIME_S * 0.999}

    assert math.isclose(_stage_duration_s(initial, completed), MIN_RELAX_TIME_S)
    assert _stage_meets_minimum_duration(initial, completed, MIN_RELAX_TIME_S)
    assert not _stage_meets_minimum_duration(initial, short, MIN_RELAX_TIME_S)


def test_verify_bundle_reports_short_relaxation_gate_failure(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    relax = bundle / "stages" / "stage_00_flat_relax"
    hold = bundle / "stages" / "stage_02_flat_run"
    relax.mkdir(parents=True)
    hold.mkdir(parents=True)

    values = _analytic_bimeron(1000, 80)
    layout = {
        "grid_cells": [1000, 80, 1],
        "cell_size": [0.5e-9, 0.5e-9, 0.5e-9],
        "origin_m": [-250e-9, -20e-9, -0.25e-9],
    }

    def state(time_s: float) -> dict[str, object]:
        return {"time": time_s, "layout": layout, "values": values}

    states = {
        "initial": state(0.0),
        "relaxed": state(10e-12),
        "hold_initial": state(10e-12),
        "held": state(110e-12),
    }
    state_paths = {
        "initial": relax / "m_initial.json",
        "relaxed": relax / "m_final.json",
        "hold_initial": hold / "m_initial.json",
        "held": hold / "m_final.json",
    }
    for key, path in state_paths.items():
        path.write_text(json.dumps(states[key]), encoding="utf-8")

    requested_execution = {
        "backend": "fdm",
        "device": "gpu",
        "fallback_policy": "forbidden",
        "mode": "strict",
        "precision": "double",
    }
    backend_plan = {
        "material": {
            "saturation_magnetisation": 0.58e6,
            "exchange_stiffness": 15e-12,
            "damping": 0.3,
            "uniaxial_anisotropy_ku1": 0.8e6,
            "anisotropy_axis": [1.0, 0.0, 0.0],
        },
        "periodicity": {
            "axes": ["periodic", "open", "open"],
            "demag": "truncated_images",
        },
        "rotated_interfacial_dmi": 3e-3,
        "interfacial_dmi": None,
        "bulk_dmi": None,
        "enable_exchange": True,
        "enable_demag": True,
        "temperature": 0.0,
    }
    receipt = {
        "validation_state": "validated",
        "executed": "cuda_fdm",
        "device": "synthetic-gpu",
        "fallback_count": 0,
        "required_operator_mask": 8,
        "executed_device_operator_mask": 8,
        "executed_host_operator_mask": 0,
        "executed_unknown_operator_mask": 0,
    }

    def metadata() -> dict[str, object]:
        return {
            "source_hash": "synthetic-goebel-source",
            "requested_execution": requested_execution,
            "execution_plan": {"backend_plan": backend_plan},
            "execution_provenance": {
                "execution_resolution": {"fallback_occurred": False},
                "execution_engine": "cuda_fdm",
                "precision": "double",
                "lossy_fallback_used": False,
                "fdm_gpu_execution_receipt": receipt,
            },
        }

    (relax / "metadata.json").write_text(
        json.dumps(metadata()), encoding="utf-8"
    )
    (hold / "metadata.json").write_text(
        json.dumps(metadata()), encoding="utf-8"
    )
    (relax / "scalars.csv").write_text(
        "E_total\n-1.0e-18\n-1.1e-18\n", encoding="utf-8"
    )
    (hold / "scalars.csv").write_text(
        "E_total\n-1.2e-18\n", encoding="utf-8"
    )
    runtime_log = tmp_path / "runtime.log"
    runtime_log.write_text(
        "synthetic runtime receipt\n"
        "stage 1/4 (flat_relax) step 0 E_total=-1.0e-18\n",
        encoding="utf-8",
    )

    report = verify_bundle(bundle, runtime_log, raise_on_failure=False)

    assert report["status"] == "failed"
    assert report["checks"]["relax_duration"] is False
    assert report["checks"]["hold_duration"] is True
    assert [
        name for name, passed in report["checks"].items() if not passed
    ] == ["relax_duration"]
    assert math.isclose(report["relax_duration_s"], 10e-12)
    assert math.isclose(report["hold_duration_s"], 100e-12)

    altered_relaxed = json.loads(
        (relax / "m_final.json").read_text(encoding="utf-8")
    )
    altered_relaxed["layout"] = {
        **altered_relaxed["layout"],
        "origin_m": [-249e-9, -20e-9, -0.25e-9],
    }
    (relax / "m_final.json").write_text(
        json.dumps(altered_relaxed), encoding="utf-8"
    )
    geometry_report = verify_bundle(bundle, runtime_log, raise_on_failure=False)
    assert geometry_report["checks"]["source_geometry"] is False


def test_dmi_receipt_requires_operator_bit_in_required_and_executed_masks() -> None:
    base = {
        "required_operator_mask": 159,
        "executed_device_operator_mask": 159,
    }
    assert _receipt_contains_dmi_operator(base)

    for key in base:
        missing = dict(base)
        missing[key] &= ~(1 << 3)
        assert not _receipt_contains_dmi_operator(missing)
