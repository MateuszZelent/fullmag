from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_relaxation_qualification_lane.py"
SPEC = importlib.util.spec_from_file_location("relaxation_lane", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
lane = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lane)


def metadata(*, engine: str = "cpu_reference", fallback: bool = False) -> dict[str, object]:
    return {
        "status": "completed",
        "completion": {
            "status": "completed",
            "converged": True,
            "reason": "torque",
        },
        "requested_execution": {
            "backend": "fdm",
            "device": "cpu",
            "precision": "double",
            "fallback_policy": "forbidden",
        },
        "execution_provenance": {
            "execution_engine": engine,
            "precision": "double",
            "energy_minimizer_realization": "native_llg_time_integrator",
            "lossy_fallback_used": fallback,
            "execution_resolution": {
                "fallback_occurred": fallback,
                "fallback_reason": "cpu fallback" if fallback else None,
            },
        },
        "accepted_solver_steps": 12,
    }


def scalar_rows() -> list[dict[str, float]]:
    return [
        {
            "E_total": 2.0e-19,
            "max_torque_Apm": 10.0,
            "max_torque_T": 1.0e-5,
            "mx": 0.0,
            "my": 0.0,
            "mz": 1.0,
        },
        {
            "E_total": 1.0e-19,
            "max_torque_Apm": 0.5,
            "max_torque_T": 5.0e-7,
            "mx": 0.0,
            "my": 0.0,
            "mz": 1.0,
        },
    ]


def test_completion_result_requires_authoritative_runtime_completion() -> None:
    result = lane.completion_result(
        metadata(),
        scalar_rows(),
        lane="fdm_cpu_reference",
        precision="fp64",
        algorithm="llg_overdamped",
        workload="macrospin",
        mesh="coarse",
    )
    assert result["converged"] is True
    assert result["accepted_steps"] == 12
    assert result["metrics"]["mz"] == 1.0


def test_completion_result_rejects_fallback_even_when_run_completed() -> None:
    with pytest.raises(lane.QualificationError, match="fallback"):
        lane.completion_result(
            metadata(fallback=True),
            scalar_rows(),
            lane="fdm_cpu_reference",
            precision="fp64",
            algorithm="llg_overdamped",
            workload="macrospin",
            mesh="coarse",
        )


def test_independent_oracle_checks_macrospin_and_writes_hashed_artifact(tmp_path: Path) -> None:
    lane.BUNDLE_ROOT = tmp_path
    input_contract = tmp_path / "input-contract.json"
    input_contract.write_text(
        json.dumps({"workload_id": "fdm_cpu_reference.fp64.llg_overdamped.macrospin"})
        + "\n",
        encoding="utf-8",
    )
    final_state = tmp_path / "m_final.json"
    final_state.write_text(
        json.dumps({"values": [[0.0, 0.0, 1.0]]}) + "\n",
        encoding="utf-8",
    )
    record = {
        "result": {
            "metrics": {
                "energy_j": 1.0e-19,
                "mx": 0.0,
                "my": 0.0,
                "mz": 1.0,
                "max_torque_apm": 0.5,
            },
        },
        "initial_energy_j": 2.0e-19,
        "input_contract_path": "input-contract.json",
        "input_contract_sha256": lane.sha256_file(input_contract),
        "final_state_path": "m_final.json",
        "final_state_sha256": lane.sha256_file(final_state),
    }
    path, digest, payload = lane.independent_oracle(
        root=tmp_path / "fdm_cpu_reference",
        algorithm="llg_overdamped",
        lane="fdm_cpu_reference",
        precision="fp64",
        workload="macrospin",
        measurements=[record] * 6,
    )
    artifact = tmp_path / path
    assert artifact.is_file()
    assert lane.sha256_file(artifact) == digest
    assert payload["status"] == "passed"


def _refinement(lane_name: str, precision: str) -> dict[str, object]:
    observations = []
    for workload in ("macrospin", "exchange_demag"):
        workload_id = f"{lane_name}.{precision}.projected_gradient_bb.{workload}"
        for mesh in ("coarse", "medium", "fine"):
            observations.append(
                {
                    "workload_id": workload_id,
                    "mesh_level": mesh,
                    "input_contract_sha256": "c" * 64,
                    "measured_run_count": 5,
                    "final_state_sha256": ["d" * 64] * 5,
                    "result": {
                        "metrics": {
                            "energy_j": -1.0e-19,
                            "max_torque_apm": 1.0,
                            "max_torque_t": 1.0e-6,
                            "mx": 0.0,
                            "my": 0.0,
                            "mz": 1.0,
                        }
                    },
                }
            )
    return {
        "levels": ["coarse", "medium", "fine"],
        "strategy": "same_physical_problem",
        "observations": observations,
    }


def test_gpu_parity_matches_workloads_by_case_not_full_lane_id(tmp_path: Path) -> None:
    lane.BUNDLE_ROOT = tmp_path
    baseline_root = tmp_path / "fdm_cpu_reference"
    baseline_receipt = baseline_root / "receipts" / "projected_gradient_bb--fdm_cpu_reference--fp64" / "receipt.json"
    baseline_artifact = baseline_root / "artifacts" / "d5.json"
    baseline_artifact.parent.mkdir(parents=True)
    baseline_artifact.write_text(
        json.dumps(
            {
                "level": "D5",
                "source_commit": "a" * 40,
                "source_tree_sha256": "b" * 64,
                "mesh_refinement_observations": _refinement("fdm_cpu_reference", "fp64"),
            }
        ),
        encoding="utf-8",
    )
    baseline_receipt.parent.mkdir(parents=True)
    baseline_receipt.write_text(
        json.dumps(
                {
                    "status": "passed",
                    "source_commit": "a" * 40,
                    "source_tree_sha256": "b" * 64,
                    "validated_scope": {
                    "evidence": {
                        "D5": {
                            "artifact_manifest": [
                                {"path": "fdm_cpu_reference/artifacts/d5.json"}
                            ]
                        }
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    parity, path, digest = lane.parity_artifact(
        root=tmp_path / "fdm_gpu_production",
        algorithm="projected_gradient_bb",
        lane="fdm_gpu_production",
        precision="fp64",
        source_commit="a" * 40,
        source_tree="b" * 64,
        target_refinement=_refinement("fdm_gpu_production", "fp64"),
    )
    assert path is not None and digest is not None
    assert len(parity["artifact_path"]) > 0
    document = json.loads((tmp_path / path).read_text(encoding="utf-8"))
    assert len(document["comparisons"]) == 6
    assert {
        comparison["baseline_workload_id"]
        for comparison in document["comparisons"]
    } == {
        "fdm_cpu_reference.fp64.projected_gradient_bb.macrospin",
        "fdm_cpu_reference.fp64.projected_gradient_bb.exchange_demag",
    }


def test_aggregate_result_rejects_unrepeatable_energy() -> None:
    records = [
        {"result": {"metrics": {"energy_j": 1.0, "max_torque_apm": 1.0, "max_torque_t": 1.0}, "accepted_steps": 1, "termination_reason": "torque"}},
        {"result": {"metrics": {"energy_j": 2.0, "max_torque_apm": 1.0, "max_torque_t": 1.0}, "accepted_steps": 1, "termination_reason": "torque"}},
    ]
    with pytest.raises(lane.QualificationError, match="energy spread"):
        lane.aggregate_result(records)
