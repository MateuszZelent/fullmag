from __future__ import annotations

import json
from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.frozen_size.analyze import analyze_case


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
    assert result["accepted_step_count"] == 1
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
