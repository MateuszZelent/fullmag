#!/usr/bin/env python3
"""Focused contract tests for the FDM GPU racetrack qualification manifest."""

from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_fdm_gpu_racetrack_qualification.py"
SPEC = importlib.util.spec_from_file_location("racetrack_qualification", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
qualification = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualification)


def _identity() -> tuple[dict[str, object], dict[str, object]]:
    source = {
        "commit": "a" * 40,
        "source_snapshot_sha256": "b" * 64,
        "input_sha256": "c" * 64,
        "fixture_sha256": "d" * 64,
    }
    runtime = {
        "managed_container": True,
        "gpu_uuid": "GPU-qualification-test",
        "cuda_driver": "550.54.14",
        "cuda_runtime": "12.4",
        "build_digest": "e" * 64,
        "free_memory_bytes": 8 * 1024**3,
    }
    return source, runtime


def _claims() -> dict[str, dict[str, object]]:
    return {
        "workload_signs_units": {
            "fixture_id": "racetrack_m1_v1",
            "signs_verified": True,
            "si_units_verified": True,
            "requested_resolved_tuple_equal": True,
        },
        "solved_charge": {
            "analytic_oracle": True,
            "cpu_oracle": True,
            "cuda_parity": True,
            "charge_balance": True,
            "convergence": True,
        },
        "direct_she_steady_spin": {
            "analytic_oracle": True,
            "cpu_oracle": True,
            "cuda_parity": True,
            "spin_balance": True,
            "convergence": True,
        },
        "hm_fm_interface": {
            "transparent_limit": True,
            "zero_conductance_limit": True,
            "real_mixing_limit": True,
            "imaginary_mixing_limit": True,
            "orientation_limit": True,
        },
        "transport_torque": {
            "torque_provenance": "solved_transport",
            "algebraic_oracle": True,
            "target_mask_verified": True,
            "device_rhs_evaluation": True,
            "prescribed_torque_used": False,
        },
        "transport_llg_lifecycle": {
            "all_rk_stages": True,
            "rollback_exact": True,
            "checkpoint_restart": True,
            "hot_loop_device_to_device": True,
        },
        "stable_skyrmion": {
            "relaxed_grids": ["coarse", "nominal", "fine"],
            "topology_stable": True,
            "energy_converged": True,
            "radius_converged": True,
            "center_stable": True,
        },
        "driven_racetrack": {
            "drive_currents_Apm2": [-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12],
            "no_annihilation": True,
            "no_edge_contamination": True,
            "transport_balance": True,
        },
        "hall_angle": {
            "algorithm_version": "skyrmion_hall_angle_v1",
            "uncertainty_reported": True,
            "stationary_window": True,
            "finite_angle": True,
        },
        "mumax_common_limit": {
            "comparison_scope": "common_magnetodynamic_limit",
            "solved_current_oracle": False,
            "identical_torque_field": True,
            "literal_demag_policy_reported": True,
            "converged_demag_policy_reported": True,
        },
        "product_contract": {
            "python_ui_round_trip": True,
            "normalized_ir_digest_equal": True,
            "output_quantities": [
                "m",
                "J_c",
                "mu_s",
                "Q_spin",
                "T_tr_G",
                "topological_charge",
                "skyrmion_center",
                "skyrmion_hall_angle",
            ],
        },
        "production_runtime": {
            "checkpoint_restart": True,
            "deterministic_repeat": True,
            "memory_budget_descriptor_derived": True,
            "memory_budget_within_free_memory": True,
            "performance_within_budget": True,
            "compute_sanitizer_clean": True,
            "no_fallback": True,
            "no_hot_loop_transfer": True,
        },
    }


def write_valid_manifest(root: Path) -> Path:
    source, runtime = _identity()
    gate_dir = root / "gates"
    proof_dir = root / "proofs"
    raw_dir = root / "raw"
    gate_dir.mkdir(parents=True)
    proof_dir.mkdir(parents=True)
    raw_dir.mkdir(parents=True)
    gates: dict[str, dict[str, object]] = {}
    for gate_id, claims in _claims().items():
        raw_path = raw_dir / f"{gate_id}.json"
        raw_path.write_text(json.dumps({"gate_id": gate_id}), encoding="utf-8")
        proof_path = proof_dir / f"{gate_id}.json"
        evidence_paths = [f"raw/{gate_id}.json"]
        proof_path.write_text(
            json.dumps(
                {
                    "schema_version": qualification.GATE_PROOF_SCHEMA,
                    "gate_id": gate_id,
                    "status": "pass",
                    "source_identity": source,
                    "runtime_identity": runtime,
                    "claims": claims,
                    "evidence_paths": evidence_paths,
                }
            ),
            encoding="utf-8",
        )
        artifact = gate_dir / f"{gate_id}.json"
        artifact.write_text(
            json.dumps(
                {
                    "schema_version": "fdm_gpu_racetrack_gate_evidence.v1",
                    "status": "pass",
                    "source_identity": source,
                    "runtime_identity": runtime,
                    "claims": claims,
                    "proof": {
                        "schema_version": qualification.GATE_PROOF_SCHEMA,
                        "path": f"proofs/{gate_id}.json",
                        "evidence_paths": evidence_paths,
                    },
                }
            ),
            encoding="utf-8",
        )
        gates[gate_id] = {"status": "pass", "artifact": str(artifact.relative_to(root))}

    manifest = {
        "schema_version": "fdm_gpu_solved_current_racetrack_qualification.v1",
        "status": "pass",
        "workload_id": "racetrack_m1_v1",
        "execution_tuple": {
            "backend": "fdm",
            "device": "gpu",
            "precision": "double",
            "execution_mode": "strict",
        },
        "source_identity": source,
        "runtime_identity": runtime,
        "input_hashes": {"before": "f" * 64, "after": "f" * 64},
        "execution_audit": {
            "schema_version": "fdm_gpu_racetrack_execution_audit.v1",
            "status": "pass",
            "runtime_identity": runtime,
            "reason_codes": [],
            "fallbacks": [],
            "hot_loop_host_device_transfers": 0,
            "forbidden_transfer_bytes": 0,
            "torque_provenance": "solved_transport",
            "transport_telemetry": {
                "schema_version": "fdm_gpu_transport_telemetry_summary.v1",
                "status": "pass",
                "stage_count": 6,
                "record_count": 120,
                "hot_loop_host_device_transfers": 0,
                "hot_loop_device_to_device_transfers": 120,
                "hot_loop_host_sync_count": 120,
                "forbidden_transfer_bytes": 0,
                "allowed_control_h2d_records": 120,
                "allowed_control_h2d_bytes": 30720,
                "allowed_scalar_d2h_records": 120,
                "allowed_scalar_d2h_bytes": 30720,
                "torque_provenance": "solved_transport",
                "all_stage_records_present": True,
            },
        },
        "gates": gates,
    }
    output = root / qualification.MANIFEST_NAME
    output.write_text(json.dumps(manifest), encoding="utf-8")
    return output


class VerifyFdmGpuRacetrackQualificationTests(unittest.TestCase):
    def test_missing_manifest_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(qualification.QualificationError, "manifest_missing"):
                qualification.validate_evidence_root(Path(temporary))

    def test_exact_complete_manifest_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = qualification.validate_evidence_root(root, write_valid_manifest(root))
            self.assertEqual("pass", result["status"])
            self.assertEqual(set(qualification.REQUIRED_GATES), set(result["gates"]))

    def test_exact_tuple_fallback_and_transfer_are_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = write_valid_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for mutation, expected in (
                (("execution_tuple", "precision", "single"), "precision"),
                (("execution_audit", "fallbacks", ["cpu"]), "fallback"),
                (("execution_audit", "hot_loop_host_device_transfers", 1), "hot_loop"),
            ):
                changed = copy.deepcopy(manifest)
                changed[mutation[0]][mutation[1]] = mutation[2]
                manifest_path.write_text(json.dumps(changed), encoding="utf-8")
                with self.subTest(expected=expected):
                    with self.assertRaisesRegex(qualification.QualificationError, expected):
                        qualification.validate_evidence_root(root, manifest_path)
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_torque_restart_and_mumax_scope_cannot_be_inferred(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = write_valid_manifest(root)
            mutations = (
                ("transport_torque", "torque_provenance", "prescribed_torque", "torque_provenance"),
                ("transport_llg_lifecycle", "checkpoint_restart", False, "checkpoint_restart"),
                ("mumax_common_limit", "solved_current_oracle", True, "solved_current_oracle"),
            )
            for gate, field, value, expected in mutations:
                artifact_path = root / "gates" / f"{gate}.json"
                artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
                artifact["claims"][field] = value
                artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
                with self.subTest(expected=expected):
                    with self.assertRaisesRegex(qualification.QualificationError, expected):
                        qualification.validate_evidence_root(root, manifest_path)
                artifact["claims"][field] = _claims()[gate][field]
                artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    def test_current_source_snapshot_must_match_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = write_valid_manifest(root)
            source_snapshot = root / "source-snapshot.v1.json"
            source_snapshot.write_text(
                json.dumps({"head_commit_full": "0" * 40, "source_snapshot_sha256": "b" * 64}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(qualification.QualificationError, "current_source_snapshot_commit_mismatch"):
                qualification.validate_evidence_root(root, manifest_path, source_snapshot)

    def test_gate_without_identity_bound_raw_proof_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = write_valid_manifest(root)
            artifact_path = root / "gates" / "workload_signs_units.json"
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            artifact.pop("proof", None)
            artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
            with self.assertRaisesRegex(qualification.QualificationError, "proof_missing"):
                qualification.validate_evidence_root(root, manifest_path)


if __name__ == "__main__":
    unittest.main()
