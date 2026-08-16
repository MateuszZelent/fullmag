from __future__ import annotations

import json
from pathlib import Path

from scripts.build_fdm_gpu_racetrack_execution_audit import (
    SCHEMA_VERSION,
    audit,
)


def _runtime() -> dict[str, object]:
    return {
        "managed_container": True,
        "gpu_uuid": "GPU-test",
        "cuda_driver": "591.86",
        "cuda_runtime": "12.4.1",
        "build_digest": "a" * 64,
        "free_memory_bytes": 8 * 1024**3,
    }


def _telemetry() -> dict[str, object]:
    return {
        "schema_version": "fdm_gpu_transport_telemetry_summary.v1",
        "status": "pass",
        "stage_count": 6,
        "record_count": 120,
        "hot_loop_host_device_transfers": 0,
        "hot_loop_device_to_device_transfers": 120,
        "hot_loop_host_sync_count": 120,
        "forbidden_transfer_bytes": 0,
        "allowed_control_h2d_records": 120,
        "allowed_control_h2d_bytes": 120 * 256,
        "allowed_scalar_d2h_records": 120,
        "allowed_scalar_d2h_bytes": 120 * 256,
        "torque_provenance": "solved_transport",
        "all_stage_records_present": True,
    }


def _runtime_evidence() -> dict[str, object]:
    drives = []
    for current in (-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12):
        drives.append(
            {
                "drive_id": f"drive_{current}",
                "requested_current_Apm2": current,
                "status": "completed",
                "runtime_tuple_valid": True,
                "accepted_solver_steps": 20000,
                "output_quantities": ["m", "J_c", "mu_s", "Q_spin", "T_tr_G"],
                "missing_output_quantities": [],
                "hall_angle": {"artifact": f"hall/{current}.json", "reason_code": None},
                "transport_telemetry": _telemetry(),
            }
        )
    return {
        "schema_version": "fdm_gpu_solved_current_racetrack_runtime_evidence.v1",
        "status": "pass",
        "workload_id": "racetrack_m1_v1",
        "execution_tuple": {"backend": "fdm", "device": "gpu", "precision": "double", "execution_mode": "strict"},
        "expected_drive_currents_Apm2": [-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12],
        "drives": drives,
        "diagnostic_drives": [],
        "checkpoint_restart": {"restart_contract_observed": True, "save_count": 1, "load_count": 6},
        "reason_codes": [],
        "transport_telemetry": _telemetry(),
    }


def _write_contracts(root: Path, runtime: dict[str, object]) -> Path:
    contract_root = root / "contracts" / "artifact"
    records = []
    payloads = {
        "charge-uniform": {"host_fallback_count": 0, "algebraic_residual": 1e-14, "physical_residual": 1e-14, "component_balance": 1e-14, "electrode_balance": 1e-14},
        "charge-layered": {"host_fallback_count": 0, "algebraic_residual": 1e-14, "physical_residual": 1e-14, "interface_flux_jump": 1e-14},
        "charge-snapshot": {"host_fallback_count": 0, "restored_without_resolve": True, "one_cell_restored_without_resolve": True},
        "charge-transfer": {"host_fallback_count": 0, "exact_order_verified": True},
        "spin-diffusion": {"status": "pass", "direct_she_six_signs": True, "diffusion_independent_oracle": True, "six_views_present": True, "typed_spin_cells": True, "typed_spin_materials": True, "typed_spin_formula_ids": True, "skip_forbidden": True},
        "spin-public": {"passed": True, "first_required_is_upper_bound": True, "warm_required_is_exact": True, "memory_policy": "descriptor_derived"},
        "spin-sparse": {"passed": True, "forbidden_transfer_bytes": 0},
    }
    for label, payload in payloads.items():
        path = contract_root / label / f"{label}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({**payload, "build_digest": runtime["build_digest"], "device_uuid": runtime["gpu_uuid"], "cuda_runtime": runtime["cuda_runtime"]}), encoding="utf-8")
        records.append({"kind": "artifact", "label": label, "status": "collected", "path": path.relative_to(root).as_posix()})
    summary = root / "fdm_gpu_racetrack_contract_artifacts.v1.json"
    summary.write_text(json.dumps({"schema_version": "fdm_gpu_racetrack_contract_artifacts.v1", "status": "collected", "promotion": "forbidden_raw_artifacts_only", "records": records, "reason_codes": []}), encoding="utf-8")
    return summary


def _write_inputs(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    runtime = _runtime()
    runtime_path = tmp_path / "runtime.json"
    runtime_path.write_text(json.dumps(runtime), encoding="utf-8")
    evidence_path = tmp_path / "runtime-evidence.json"
    evidence_path.write_text(json.dumps(_runtime_evidence()), encoding="utf-8")
    workload_path = tmp_path / "workload-run.json"
    workload_path.write_text(json.dumps({"schema_version": "fdm_gpu_solved_current_racetrack_workload_run.v1", "status": "completed", "returncode": 0, "runtime_identity": runtime, "environment": {"FULLMAG_FDM_EXECUTION": "gpu", "FULLMAG_FDM_PRECISION": "double", "FULLMAG_RACETRACK_AMPLITUDES": "-1.5e12,-1.0e12,-0.5e12,0.5e12,1.0e12,1.5e12", "FULLMAG_RACETRACK_DRIVE_DURATION": "2.0e-9", "FULLMAG_RACETRACK_OUTPUT_PERIOD": "5.0e-12", "FULLMAG_RACETRACK_RELAX_MAX_STEPS": "50000", "FULLMAG_RACETRACK_RELAX_TOLT": "1.0e-6", "FULLMAG_ARTIFACT_FIELD_STORAGE": "zarr"}}), encoding="utf-8")
    contracts = _write_contracts(tmp_path, runtime)
    return evidence_path, workload_path, runtime_path, contracts


def test_audit_passes_only_with_complete_identity_bound_evidence(tmp_path: Path) -> None:
    evidence, workload, runtime, contracts = _write_inputs(tmp_path)
    result = audit(tmp_path, runtime_evidence_path=evidence, workload_run_path=workload, runtime_identity_path=runtime, contracts_path=contracts)
    assert result["status"] == "pass"
    assert result["schema_version"] == SCHEMA_VERSION
    assert result["fallbacks"] == []
    assert result["hot_loop_host_device_transfers"] == 0
    assert result["allowed_control_h2d_records"] == 120
    assert result["allowed_scalar_d2h_records"] == 120
    assert result["torque_provenance"] == "solved_transport"


def test_missing_transport_telemetry_blocks_audit(tmp_path: Path) -> None:
    evidence, workload, runtime, contracts = _write_inputs(tmp_path)
    payload = json.loads(evidence.read_text())
    payload["transport_telemetry"] = None
    evidence.write_text(json.dumps(payload), encoding="utf-8")
    result = audit(tmp_path, runtime_evidence_path=evidence, workload_run_path=workload, runtime_identity_path=runtime, contracts_path=contracts)
    assert result["status"] == "blocked"
    assert "transport_telemetry_missing" in result["reason_codes"]


def test_build_identity_mismatch_blocks_audit(tmp_path: Path) -> None:
    evidence, workload, runtime, contracts = _write_inputs(tmp_path)
    payload = json.loads(runtime.read_text())
    payload["build_digest"] = "f" * 64
    runtime.write_text(json.dumps(payload), encoding="utf-8")
    result = audit(tmp_path, runtime_evidence_path=evidence, workload_run_path=workload, runtime_identity_path=runtime, contracts_path=contracts)
    assert result["status"] == "blocked"
    assert "workload_runtime_identity_mismatch" in result["reason_codes"]


def test_nonzero_forbidden_transfer_blocks_audit(tmp_path: Path) -> None:
    evidence, workload, runtime, contracts = _write_inputs(tmp_path)
    payload = json.loads(evidence.read_text())
    payload["transport_telemetry"]["hot_loop_host_device_transfers"] = 1
    evidence.write_text(json.dumps(payload), encoding="utf-8")
    result = audit(tmp_path, runtime_evidence_path=evidence, workload_run_path=workload, runtime_identity_path=runtime, contracts_path=contracts)
    assert result["status"] == "blocked"
    assert "hot_loop_host_device_transfers_nonzero" in result["reason_codes"]
