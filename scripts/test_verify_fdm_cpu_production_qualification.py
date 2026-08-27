#!/usr/bin/env python3

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from verify_fdm_cpu_production_qualification import (
    ContractError,
    canonical_sha256,
    compare_metric,
    validate_summary,
    validate_thresholds,
)


def exact_provenance() -> dict:
    return {
        "execution_engine": "cpu_reference",
        "precision": "double",
        "lossy_fallback_used": False,
        "execution_resolution": {
            "resolution_mode": "exact",
            "fallback_occurred": False,
        },
    }


def summary() -> dict:
    hardware = {
        "operating_system": "windows",
        "architecture": "x86_64",
        "cpu_vendor": "AuthenticAMD",
        "cpu_brand": "Synthetic CPU",
        "detected_cpu_features": ["sse2", "avx2"],
        "available_logical_cpu_count": 16,
        "rayon_thread_count": 16,
        "rayon_num_threads_environment": None,
        "thread_policy": "rayon_global_pool",
        "precision_policy": "cpu_reference_double",
        "accelerator_driver": "not_applicable_cpu_reference",
        "accelerator_toolkit": "not_applicable_cpu_reference",
    }
    results = []
    evaluations = {"control": (30, 0), "requested": (20, 10), "full": (0, 30)}
    for fixture_index, fixture in enumerate(("small", "medium", "large")):
        for mode in ("control", "requested", "full"):
            minimal, full = evaluations[mode]
            provenance = exact_provenance()
            provenance.update(
                {
                    "fdm_cpu_step_transaction_telemetry": {
                        "accepted_step_count": 30,
                        "rejected_attempt_count": 0,
                    },
                    "fdm_cpu_evaluation_telemetry": {
                        "minimal_step_count": minimal,
                        "full_step_count": full,
                    },
                    "fdm_fft_execution": {
                        "runtime_telemetry": {
                            "forward_fft_count": 270,
                            "inverse_fft_count": 270,
                        }
                    },
                }
            )
            results.append(
                {
                    "fixture": fixture,
                    "mode": mode,
                    "end_to_end_wall_time_ns": 100 + fixture_index,
                    "allocation_count": 10,
                    "allocation_bytes": 1000,
                    "peak_live_heap_growth_bytes": 2000,
                    "backend_plan_sha256": f"sha256:{fixture_index + 1:064x}",
                    "final_magnetization_sha256": f"sha256:{fixture_index + 4:064x}",
                    "execution_provenance": provenance,
                }
            )
    refinement = []
    for timestep, steps, error in (
        (5.0e-11, 20, 1.1e-3),
        (2.5e-11, 40, 2.8e-4),
        (1.25e-11, 80, 7.0e-5),
    ):
        refinement.append(
            {
                "timestep_s": timestep,
                "expected_steps": steps,
                "max_abs_error": error,
                "execution_provenance": exact_provenance(),
            }
        )
    commit = "a" * 40
    return {
        "schema_version": "fullmag.fdm.cpu.production_qualification.v1",
        "commit": commit,
        "profile": "full",
        "qualification_status": "evidence_only",
        "qualification_blockers": ["external_hardware_baseline_gate_pending"],
        "source_identity": {
            "git_commit": commit,
            "worktree_state": "clean",
            "source_snapshot_sha256": "b" * 64,
            "rustc_version": "rustc synthetic",
            "target_triple": "x86_64-pc-windows-msvc",
        },
        "hardware_identity": hardware,
        "hardware_fingerprint_sha256": canonical_sha256(hardware),
        "process_peak_resident_bytes": 4096,
        "time_to_accuracy": {
            "oracle_id": "constant_z_field_llg_from_positive_x.v1",
            "tolerance_max_abs": 1.0e-3,
            "observed_order_coarse_to_fine": 1.99,
            "first_passing_timestep_s": 2.5e-11,
            "first_passing_wall_time_ns": 100,
            "runs": refinement,
        },
        "results": results,
    }


class ProductionQualificationVerifierTests(unittest.TestCase):
    def test_tracked_threshold_policy_is_explicitly_approved(self) -> None:
        path = (
            Path(__file__).resolve().parents[1]
            / "crates/fullmag-bench/qualification/fdm_cpu_production_thresholds.v1.json"
        )
        validate_thresholds(json.loads(path.read_text(encoding="utf-8")))

    def test_accepts_complete_exact_summary(self) -> None:
        validate_summary(summary(), "candidate")

    def test_rejects_fallback_in_production_result(self) -> None:
        value = copy.deepcopy(summary())
        value["results"][0]["execution_provenance"]["execution_resolution"][
            "fallback_occurred"
        ] = True
        with self.assertRaisesRegex(ContractError, "used fallback"):
            validate_summary(value, "candidate")

    def test_rejects_tampered_hardware_fingerprint(self) -> None:
        value = summary()
        value["hardware_identity"]["cpu_brand"] = "Different CPU"
        with self.assertRaisesRegex(ContractError, "hardware fingerprint mismatch"):
            validate_summary(value, "candidate")

    def test_ratio_gate_reports_median_and_p95_regression(self) -> None:
        comparison, failures = compare_metric(
            "wall", [100, 100, 100, 100, 100], [200, 200, 200, 200, 200], 1.15, 1.25
        )
        self.assertEqual(comparison["status"], "failed")
        self.assertEqual(len(failures), 2)


if __name__ == "__main__":
    unittest.main()
