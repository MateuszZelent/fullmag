from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from tests.standard_problems.mumag.sp4.common.contract import (
    PRODUCTION_RELAXATION_ALGORITHMS,
)
from tests.standard_problems.mumag.sp4.fem.verify import (
    ValidationFailure,
    relaxation_artifact_path,
    relaxation_matrix_metrics,
)


NODES = (
    (-1.0, -1.0, -1.0),
    (1.0, -1.0, -1.0),
    (-1.0, 1.0, -1.0),
    (-1.0, -1.0, 1.0),
)


def _write_relaxation(
    root: Path,
    *,
    device: str,
    algorithm: str,
    angle: float = 0.0,
) -> Path:
    artifacts = relaxation_artifact_path(
        root,
        device=device,
        mesh="coarse",
        airbox="baseline",
        algorithm=algorithm,
    )
    artifacts.mkdir(parents=True, exist_ok=True)
    provenance = {
        "execution_engine": (
            "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
        ),
        "precision": "double",
        "lossy_fallback_used": False,
    }
    if device == "gpu":
        provenance.update(
            fem_demag_operator_mode="device_hypre_poisson",
            hypre_execution_policy="device",
            uses_gpu_poisson=True,
        )
    qualification = {
        "relaxation_algorithm": algorithm,
        "converged": True,
        "stop_reason": "torque_tolerance",
        "stop_metric_name": "max_torque_apm",
        "stop_metric_value": 6.0,
        "stop_threshold": 7.957747154594767,
        "executed_steps": 3,
        "final_torque_t": 8e-6,
        "norm_defect": 0.0,
    }
    metadata = {
        "requested_execution": {
            "backend": "fem",
            "device": device,
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
        "execution_provenance": provenance,
        "demag_runtime": {
            "actual_iterations": 7,
            "final_residual_norm": 1e-12,
        },
        "mesh": {"topology_fingerprint": "sha256:common"},
        "execution_plan": {
            "backend_plan": {
                "mesh": {"nodes": NODES},
                "object_segments": [
                    {"object_id": "film", "node_start": 0, "node_count": 4}
                ],
            }
        },
        f"fem_{device}_relaxation_qualification": qualification,
    }
    values = [[math.cos(angle), math.sin(angle), 0.0] for _ in NODES]
    (artifacts / "metadata.json").write_text(json.dumps(metadata))
    (artifacts / "m_final.json").write_text(json.dumps({"values": values}))
    (artifacts / "scalars.csv").write_text(
        "step,time,E_total,max_torque_T\n"
        "0,0,-1e-17,1e-3\n"
        "1,1e-14,-2e-17,1e-4\n"
        "2,2e-14,-3e-17,8e-6\n"
    )
    return artifacts


def _write_matrix(root: Path) -> None:
    for device in ("cpu", "gpu"):
        for index, algorithm in enumerate(PRODUCTION_RELAXATION_ALGORITHMS):
            _write_relaxation(
                root,
                device=device,
                algorithm=algorithm,
                angle=index * 0.005,
            )


def test_relaxation_matrix_qualifies_all_algorithms_and_devices(tmp_path: Path) -> None:
    _write_matrix(tmp_path)

    result = relaxation_matrix_metrics(
        tmp_path,
        mesh="coarse",
        airbox="baseline",
        reference=None,
    )

    assert result["status"] == "passed"
    assert result["canonical_run"] == "gpu/coarse/baseline/llg_overdamped"
    assert len(result["entries"]) == 6
    assert len(result["comparisons_to_canonical"]) == 6


def test_relaxation_matrix_rejects_a_different_local_minimum(tmp_path: Path) -> None:
    _write_matrix(tmp_path)
    _write_relaxation(
        tmp_path,
        device="gpu",
        algorithm="nonlinear_cg",
        angle=0.5,
    )

    with pytest.raises(ValidationFailure, match="endpoint does not agree"):
        relaxation_matrix_metrics(
            tmp_path,
            mesh="coarse",
            airbox="baseline",
            reference=None,
        )


def test_relaxation_matrix_rejects_missing_or_mislabeled_artifacts(
    tmp_path: Path,
) -> None:
    _write_matrix(tmp_path)
    artifacts = relaxation_artifact_path(
        tmp_path,
        device="cpu",
        mesh="coarse",
        airbox="baseline",
        algorithm="projected_gradient_bb",
    )
    metadata = json.loads((artifacts / "metadata.json").read_text())
    metadata["fem_cpu_relaxation_qualification"]["relaxation_algorithm"] = (
        "nonlinear_cg"
    )
    (artifacts / "metadata.json").write_text(json.dumps(metadata))

    with pytest.raises(ValidationFailure, match="readiness failed"):
        relaxation_matrix_metrics(
            tmp_path,
            mesh="coarse",
            airbox="baseline",
            reference=None,
        )
