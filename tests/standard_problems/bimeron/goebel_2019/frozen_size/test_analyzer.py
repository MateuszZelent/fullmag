from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from tests.standard_problems.bimeron.goebel_2019.frozen_size.analyze import (
    _constrained_metric_row,
    _interpolated_negative_area,
    _grid_from_metadata,
    _measure,
    analyze_case,
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_analyzer_reads_managed_stage_layout_and_resolved_grid(tmp_path: Path) -> None:
    root = tmp_path / "case"
    stage = root / "stages" / "stage_01_flat_relax"
    _write_json(
        root / "metadata.json",
        {
            "execution_plan": {
                "backend_plan": {
                    "grid": {"cells": [4, 2, 1]},
                    "cell_size": [5e-10, 5e-10, 5e-10],
                }
            },
            "problem_meta": {
                "runtime_metadata": {
                    "bimeron_frozen_size": {
                        "protocol": {"protocol": "p3", "cell_nm": 0.5}
                    }
                }
            },
            "requested_execution": {
                "backend": "fdm",
                "device": "gpu",
                "precision": "double",
            },
            "execution_provenance": {
                "fdm_gpu_execution_receipt": {
                    "resolved": "device_resident",
                    "executed": "cuda_fdm",
                    "fallback_count": 0,
                }
            },
        },
    )
    _write_json(
        stage / "m_final.json",
        {
            "values": [
                [-1.0, 0.0, 0.0],
                [-1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [-1.0, 0.0, 1.0],
                [-1.0, 0.0, -1.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
            ]
        },
    )
    _write_json(
        stage / "solver" / "accepted_steps.v1.json",
        {
            "steps": [
                {
                    "step": 4,
                    "time": 2.5e-12,
                    "e_total": -1.25,
                    "max_torque_Apm": 2.0,
                    "frozen_dof_count": 3,
                    "free_dof_count": 5,
                    "frozen_reference_max_drift": 0.0,
                }
            ]
        },
    )

    result = analyze_case(root)

    assert result["status"] == "measured"
    assert result["accepted_step_count"] is None
    assert result["trace_sample_count"] == 1
    assert result["accepted_step_count_source"] == "not_emitted_in_sampled_trace"
    assert result["terminal_step_index"] == 4
    assert result["energy"]["E_total_J"] == -1.25
    assert result["profile_energy"]["E_total_J"] == -1.25
    assert result["profile_energy"]["stage_id"] == "stage_01_flat_relax"
    assert result["runtime_provenance"]["requested_execution"]["device"] == "gpu"
    assert result["frozen_runtime"]["frozen_dof_count"] == 3
    assert result["frozen_runtime"]["free_torque_metric_status"] == "emitted"
    assert result["frozen_runtime"]["free_torque_metric"] == 2.0
    assert result["frozen_runtime"]["free_torque_metric_units"] == "Apm"
    assert result["frozen_runtime"]["free_torque_metric_source"] == "max_torque_Apm"
    assert result["states"]["final"]["measurement"]["measurement_grid"]["nx"] == 4
    assert result["states"]["final"]["measurement"]["max_unit_norm_defect"] == pytest.approx(math.sqrt(2.0) - 1.0)
    assert result["states"]["final"]["measurement"]["R_area_uncertainty_nm"] == 0.25
    assert result["states"]["final"]["measurement"]["R_area_uncertainty_kind"] == "grid_resolution_estimate"
    assert result["convergence_diagnostics"]["sample_count"] == 1


def test_interpolated_area_is_limited_to_selected_component() -> None:
    nx, ny = 10, 5
    plane = [(1.0, 0.0, 0.0)] * (nx * ny)
    mutable = list(plane)
    for ix, iy in ((4, 2), (5, 2), (8, 2), (9, 2)):
        mutable[iy * nx + ix] = (-1.0, 0.0, 0.0)
    selected = {(4, 2), (5, 2)}

    selected_area = _interpolated_negative_area(
        mutable,
        nx,
        ny,
        1.0,
        1.0,
        component=selected,
    )
    all_area = _interpolated_negative_area(mutable, nx, ny, 1.0, 1.0)

    assert selected_area > 0.0
    assert all_area > selected_area


def test_interpolated_area_reports_diagonal_component_ambiguity() -> None:
    nx, ny = 4, 2
    plane = [(1.0, 0.0, 0.0)] * (nx * ny)
    mutable = list(plane)
    mutable[0 * nx + 1] = (-1.0, 0.0, 0.0)
    mutable[1 * nx + 2] = (-1.0, 0.0, 0.0)
    diagnostics: dict[str, int] = {}

    area = _interpolated_negative_area(
        mutable,
        nx,
        ny,
        1.0,
        1.0,
        component={(1, 0)},
        diagnostics=diagnostics,
    )

    assert area > 0.0
    assert diagnostics["mixed_component_triangle_count"] == 2


def test_measure_uses_configured_background_sign() -> None:
    nx, ny = 5, 5
    values = [(1.0, 0.0, 0.0)] * (nx * ny)
    mutable = list(values)
    for iy in range(1, 4):
        for ix in range(1, 4):
            mutable[iy * nx + ix] = (-1.0, 0.0, 0.0)

    plus_background = _measure(mutable, nx=nx, ny=ny, nz=1, cell=(1.0, 1.0, 1.0), background_sign=1)
    minus_background = _measure(mutable, nx=nx, ny=ny, nz=1, cell=(1.0, 1.0, 1.0), background_sign=-1)

    assert plus_background["background_sign"] == 1
    assert plus_background["area_cell_count"] == 9
    assert minus_background["background_sign"] == -1
    assert minus_background["area_cell_count"] == 16


def test_core_distance_uses_selected_component_and_periodic_x() -> None:
    nx, ny = 8, 3
    values = [(1.0, 0.0, 0.0)] * (nx * ny)
    mutable = list(values)
    mutable[1 * nx + 7] = (-1.0, 0.0, -1.0)
    mutable[1 * nx + 0] = (-1.0, 0.0, 1.0)

    measurement = _measure(mutable, nx=nx, ny=ny, nz=1, cell=(1e-9, 1e-9, 1e-9))

    assert measurement["R_core_distance_method"] == "periodic_x_minimum_image_euclidean_y"
    assert measurement["R_core_nm"] == pytest.approx(0.5)
    assert measurement["component_semi_axes_nm"][0] == pytest.approx(1.0)


def test_grid_measurement_refuses_environment_fallback(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="resolved grid metadata is missing"):
        _grid_from_metadata(tmp_path)


def test_grid_measurement_accepts_saved_case_grid_contract(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "request.json",
        {
            "case": {
                "track_size_nm": [10.0, 8.0, 0.5],
                "cell_size_nm": [0.5, 0.5, 0.5],
            }
        },
    )

    assert _grid_from_metadata(tmp_path) == (
        20,
        16,
        1,
        0.5e-9,
        0.5e-9,
        0.5e-9,
    )


def test_analyzer_uses_workspace_grid_when_run_metadata_is_not_ready(tmp_path: Path) -> None:
    root = tmp_path / "case"
    workspace = tmp_path / "workspace"
    _write_json(
        workspace / "stages" / "stage_01_flat_relax" / "metadata.json",
        {
            "execution_plan": {
                "backend_plan": {
                    "grid": {"cells": [8, 4, 1]},
                    "cell_size": [2.5e-10, 2.5e-10, 5e-10],
                }
            }
        },
    )

    assert _grid_from_metadata(root, workspace_root=workspace) == (
        8,
        4,
        1,
        2.5e-10,
        2.5e-10,
        5e-10,
    )


def test_analyzer_uses_resolved_static_mask_when_trace_omits_counts(tmp_path: Path) -> None:
    root = tmp_path / "case"
    stage = root / "stages" / "stage_01_flat_relax"
    _write_json(
        stage / "metadata.json",
        {
            "frozen_spins": {
                "active_dof_count": 20,
                "frozen_dof_count": 4,
                "free_dof_count": 16,
            }
        },
    )
    _write_json(
        root / "metadata.json",
        {
            "problem_meta": {
                "runtime_metadata": {
                    "bimeron_frozen_size": {
                        "protocol": {"protocol": "p3", "cell_nm": 0.5}
                    }
                }
            },
            "execution_plan": {
                "backend_plan": {
                    "grid": {"cells": [2, 2, 1]},
                    "cell_size": [5e-10, 5e-10, 5e-10],
                }
            },
        },
    )
    _write_json(
        stage / "m_final.json",
        {"values": [[1.0, 0.0, 0.0]] * 4},
    )
    _write_json(
        stage / "solver" / "accepted_steps.v1.json",
        {"steps": [{"step": 1, "time": 1e-12, "e_total": -1.0}]},
    )

    result = analyze_case(root)

    assert result["frozen_runtime"]["frozen_dof_count"] == 4
    assert result["frozen_runtime"]["frozen_cell_count"] == 4
    assert result["frozen_runtime"]["free_dof_count"] == 16
    assert result["frozen_runtime"]["frozen_runtime_source"] == "resolved_frozen_spins_plan"


def test_analyzer_derives_constrained_reference_drift_from_state_artifacts(tmp_path: Path) -> None:
    root = tmp_path / "case"
    stage = root / "stages" / "stage_01_flat_relax"
    _write_json(
        root / "metadata.json",
        {
            "problem_meta": {
                "runtime_metadata": {
                    "bimeron_frozen_size": {
                        "protocol": {"protocol": "p3", "cell_nm": 0.5}
                    }
                }
            },
            "execution_plan": {
                "backend_plan": {
                    "grid": {"cells": [2, 2, 1]},
                    "cell_size": [5e-10, 5e-10, 5e-10],
                }
            },
            "frozen_spins": {
                "active_dof_count": 4,
                "frozen_dof_count": 2,
                "free_dof_count": 2,
                "frozen_mask": [True, False, True, False],
            },
        },
    )
    initial = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]]
    held = [[1.0, 0.0, 0.0], [0.5, 0.5, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]]
    _write_json(root / "states" / "initial_m.json", {"values": initial})
    _write_json(root / "states" / "constrained_held_m.json", {"values": held})
    _write_json(stage / "m_final.json", {"values": held})
    _write_json(
        stage / "solver" / "accepted_steps.v1.json",
        {"steps": [{"step": 1, "time": 1e-12, "e_total": -1.0}]},
    )

    result = analyze_case(root)

    assert result["frozen_runtime"]["frozen_reference_max_drift"] == 0.0
    assert result["frozen_runtime"]["frozen_reference_drift_source"] == "state_artifact_comparison"


def test_analyzer_uses_constrained_stage_torque_when_release_is_present() -> None:
    rows = [
        {"_stage_id": "constrained_hold", "max_torque_Apm": 8.0},
        {"_stage_id": "released_relax", "max_torque_Apm": 1.0},
    ]

    selected = _constrained_metric_row(rows, rows[-1])

    assert selected["_stage_id"] == "constrained_hold"
    assert selected["max_torque_Apm"] == 8.0
