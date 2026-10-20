#!/usr/bin/env python3
"""Interpreted contract checks for the managed GPU workspace proof driver."""
from __future__ import annotations

import ast
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import verify_docker_fem_gpu_workspace as driver


class WorkspaceProofContractTests(unittest.TestCase):
    def test_driver_parses_and_declares_both_strict_gpu_lanes(self) -> None:
        source_path = SCRIPT_DIR / "verify_docker_fem_gpu_workspace.py"
        source = source_path.read_text(encoding="utf-8")
        ast.parse(source, filename=str(source_path))
        for token in (
            "fullmag as fm",
            'study.device("gpu", precision="double")',
            'study.mode("strict")',
            'study.engine("{lane.backend}")',
            "/v2/persistence/projects/from-script",
            "/v2/persistence/projects/{project_id}/run-intent",
            "worker_execution_completed.v1.json",
            "fem_gpu_accepted_state_snapshot.v1.json",
            "fdm_gpu_accepted_state_snapshot.v1.json",
            "fdm_gpu_execution_receipt",
            "fem_gpu_execution_receipt",
            "fallback_occurred",
            "host_launch_binding",
            "/state/runs/docker-all/session-store/runs",
            "resources_retained_on_failure",
        ):
            self.assertIn(token, source)
        self.assertNotIn("subprocess", source)
        self.assertNotIn("docker", " ".join(
            node.func.id
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
        ))

    def test_canonical_scripts_select_requested_gpu_for_each_backend(self) -> None:
        for lane_name, backend in (("fem-gpu", "fem"), ("fdm-gpu", "fdm")):
            script = driver._canonical_script(driver.LANES[lane_name])
            self.assertIn(f'study.engine("{backend}")', script)
            self.assertIn('study.device("gpu", precision="double")', script)
            self.assertIn('study.mode("strict")', script)
            self.assertIn("study.geometry(fm.Box", script)
            self.assertIn("study.run(1e-12)", script)
            ast.parse(script, filename=f"{lane_name}.py")

    def test_input_contract_requires_matching_lane_and_preserves_catalog(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-gpu-proof-input-") as directory:
            path = Path(directory) / "input.json"
            path.write_text(json.dumps({
                "study_plan": {"schema_version": "study_plan.v2"},
                "study_problem_catalog": {"schema_version": "study_problem_catalog.v2"},
                "run_authoring": {
                    "parameters": {},
                    "seeds": {},
                    "dependencies": [],
                    "scheduling_priority": 0,
                    "requested_execution": {
                        "backend": "fdm",
                        "device": "gpu",
                        "precision": "double",
                        "mode": "strict",
                    },
                },
            }), encoding="utf-8")
            plan, catalog, authoring, assets = driver._load_lane_inputs(path, driver.LANES["fdm-gpu"])
            self.assertEqual(plan["schema_version"], "study_plan.v2")
            self.assertEqual(catalog["schema_version"], "study_problem_catalog.v2")
            self.assertEqual(authoring["requested_execution"]["device"], "gpu")
            self.assertEqual(assets, {})
            with self.assertRaises(driver.ProofError):
                driver._load_lane_inputs(path, driver.LANES["fem-gpu"])

    def test_progress_rejects_cpu_or_backward_lifecycle(self) -> None:
        lane = driver.LANES["fdm-gpu"]
        resource = {
            "project_id": "project",
            "run_id": "run",
            "requested_execution": {"backend": "fdm", "device": "gpu", "precision": "double", "mode": "strict"},
            "catalog_state": "materialized",
            "catalog_revision": 1,
            "tasks": [{"task_id": "task", "lifecycle": "running", "readiness": {"state": "ready"}}],
        }
        history: list[dict[str, object]] = []
        task, evidence = driver._validate_task_progress(resource, "project", "run", lane, history)
        self.assertEqual(task["lifecycle"], "running")
        self.assertFalse(evidence["terminal"])
        resource["tasks"][0]["lifecycle"] = "accepted"
        with self.assertRaises(driver.ProofError):
            driver._validate_task_progress(resource, "project", "run", lane, history)
        resource["tasks"][0]["lifecycle"] = "failed"
        with self.assertRaises(driver.ProofError):
            driver._validate_task_progress(resource, "project", "run", lane, [])

    def test_fdm_snapshot_digest_and_receipt_are_strict(self) -> None:
        lane = driver.LANES["fdm-gpu"]
        clock = {"accepted_step": 2, "time_seconds": 2.0e-12, "dt_seconds": 1.0e-12}
        magnetization = "sha256:" + "a" * 64
        clock_digest, state_digest = driver._accepted_state_digests(
            clock, {"fdm.gpu.magnetization-digest.f64be.v1": magnetization.encode("ascii")}
        )
        snapshot = {
            "schema_version": lane.snapshot_schema,
            "clock": clock,
            "magnetization_digest": magnetization,
            "clock_digest": clock_digest,
            "state_digest": state_digest,
            "primary_carrier_ids": ["fdm.gpu.magnetization-digest.f64be.v1"],
        }
        accepted_ref = {"id": {"clock_digest": clock_digest, "state_digest": state_digest}}
        receipt = {
            "requested": "gpu", "resolved": "device_resident", "executed": "cuda_fdm", "device": "cuda:0", "precision": "double",
            "required_operator_mask": 1, "resolved_device_operator_mask": 1, "resolved_host_operator_mask": 0,
            "resolved_unknown_operator_mask": 0, "executed_device_operator_mask": 1, "executed_host_operator_mask": 0,
            "executed_unknown_operator_mask": 0, "fallback_count": 0, "accounting_valid": True,
            "operator_residency": [{"operator": "llg_integrator", "location": "device"}],
            "transfer_counts": {"hot_loop_full_vector_h2d_count": 0, "hot_loop_full_vector_h2d_bytes": 0, "hot_loop_full_vector_d2h_count": 0, "hot_loop_full_vector_d2h_bytes": 0, "hot_loop_host_compute_count": 0, "hot_loop_host_sync_count": 0, "hot_loop_control_scalar_host_sync_count": 0},
            "precision_policy": {"requested": "double", "accounting_valid": True, "resolved": {"storage": "double", "compute": "double", "fft": "double", "reduction": "double"}, "executed": {"storage": "double", "compute": "double", "fft": "double", "reduction": "double"}},
        }
        provenance = {"fdm_gpu_execution_receipt": receipt}
        proof_receipt = driver._validate_fdm_receipt(provenance)
        self.assertEqual(proof_receipt["executed"], "cuda_fdm")
        self.assertEqual(driver._validate_snapshot(snapshot, lane, accepted_ref, proof_receipt)["schema"], lane.snapshot_schema)
        receipt["executed"] = "cpu_fdm"
        with self.assertRaises(driver.ProofError):
            driver._validate_fdm_receipt(provenance)

    def test_fem_receipt_rejects_hybrid_and_resolution_fallback(self) -> None:
        receipt = {
            "requested": "strict_device", "resolved": "device_resident", "executed": "cuda_fem", "precision": "double", "device_ordinal": 0,
            "required_operator_mask": 3, "resolved_device_operator_mask": 3, "resolved_host_operator_mask": 0,
            "resolved_unknown_operator_mask": 0, "executed_device_operator_mask": 3, "executed_host_operator_mask": 0,
            "executed_unknown_operator_mask": 0, "fallback_count": 0, "accepted_step_count": 1,
            "hot_loop_compute_h2d_bytes": 0, "hot_loop_compute_d2h_bytes": 0, "hot_loop_compute_host_sync_count": 0,
            "accounting_valid": True,
        }
        self.assertEqual(driver._validate_fem_receipt({"fem_gpu_execution_receipt": receipt})["executed"], "cuda_fem")
        receipt["resolved"] = "hybrid_cpu_poisson"
        with self.assertRaises(driver.ProofError):
            driver._validate_fem_receipt({"fem_gpu_execution_receipt": receipt})


if __name__ == "__main__":
    unittest.main()
