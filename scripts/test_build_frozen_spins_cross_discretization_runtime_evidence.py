from __future__ import annotations

import json
import unittest

from scripts.build_frozen_spins_cross_discretization_runtime_evidence import (
    EvidenceError,
    build_evidence,
)


def runtime_payload() -> dict:
    rows = []
    for backend in ("fdm", "fem"):
        active = 512 if backend == "fdm" else 729
        frozen = 128 if backend == "fdm" else 169
        for level, (refinement, resolution) in enumerate((("coarse", 8), ("medium", 13), ("fine", 23))):
            rows.append(
                {
                    "backend": backend,
                    "refinement": refinement,
                    "refinement_level": level,
                    "resolution": [resolution] * 3,
                    "active_dof_count": active,
                    "frozen_dof_count": frozen,
                    "free_dof_count": active - frozen,
                    "resolved_mask_sha256": ("a" if backend == "fdm" else "b") * 64,
                    "solver": {
                        "status": "completed",
                        "steps_executed": 1,
                        "energy_finite": True,
                        "frozen_max_abs_drift": 0.0,
                        "frozen_max_ulp_drift": 0,
                        "free_max_displacement": 1.0e-3,
                        "free_dof_mobility_observed": True,
                        "frozen_dof_present": True,
                        "max_rhs_free": 2.0,
                        "max_rhs_all": 2.0,
                        "max_torque_free": 3.0,
                        "max_torque_all": 3.0,
                        "fallback_used": False,
                        "per_step_frozen_transfer_bytes": 0,
                    },
                    "final_magnetization_sha256": ("c" if backend == "fdm" else "d") * 64,
                }
            )
    return {
        "schema_version": "fullmag.frozen_spins.cross_discretization.runtime.v1",
        "status": "PASS",
        "implementation_status": "EXECUTED_PRODUCTION_PLANNER_AND_REFERENCE_RUNTIME",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "managed_clean_source_receipt_required",
        "test_case_ids": ["FS-P15-CROSS-DISCRETIZATION"],
        "contract": {
            "shared_selector": "production_planner_compile_fdm_and_compile_fem",
            "reference_policy": "capture_current_at_activation",
            "membership_policy": "static",
            "integrator": "heun",
            "precision": "double",
            "dt_s": 1.0e-15,
            "resolved_mask_hashes_cross_lane": "NOT_COMPARED",
        },
        "rows": rows,
    }


class RuntimeEvidenceTests(unittest.TestCase):
    def test_validates_six_rows_and_parity(self) -> None:
        evidence = build_evidence(json.dumps(runtime_payload()).encode("utf-8"), "fixture.json")
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(len(evidence["rows"]), 6)
        self.assertEqual(evidence["contracts"]["hard_restore_zero_ulp_all_rows"], "PASS")

    def test_rejects_frozen_drift(self) -> None:
        payload = runtime_payload()
        payload["rows"][0]["solver"]["frozen_max_ulp_drift"] = 1
        with self.assertRaisesRegex(EvidenceError, "ULP drift"):
            build_evidence(json.dumps(payload).encode("utf-8"))

    def test_rejects_fallback(self) -> None:
        payload = runtime_payload()
        payload["rows"][1]["solver"]["fallback_used"] = True
        with self.assertRaisesRegex(EvidenceError, "fallback"):
            build_evidence(json.dumps(payload).encode("utf-8"))

    def test_rejects_missing_refinement(self) -> None:
        payload = runtime_payload()
        payload["rows"].pop()
        with self.assertRaisesRegex(EvidenceError, "six runtime rows"):
            build_evidence(json.dumps(payload).encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
