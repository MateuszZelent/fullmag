#!/usr/bin/env python3
"""Regression tests for topological-charge runtime evidence validation."""

from __future__ import annotations

import copy
import unittest

from scripts.validate_topological_charge_runtime import validate_evidence


def evidence(scenario: str = "fdm") -> dict[str, object]:
    backend = "fem" if scenario == "fem_p1" else "fdm"
    run = {
        "object_id": "magnet",
        "charge": -0.98,
        "trust": "diagnostic_boundary",
        "support_frame": {"u_axis": [1, 0, 0], "v_axis": [0, 1, 0], "normal_axis": [0, 0, 1]},
        "provenance": {
            "discretization": backend,
            "fe_order": 1 if scenario == "fem_p1" else None,
            "requested_execution": {"backend": backend, "device": "cpu", "precision": "double"},
            "resolved_execution": {"backend": backend, "device": "cpu", "precision": "double", "lossy_fallback_used": False},
        },
    }
    return {
        "schema_version": "topological_charge_runtime.v2",
        "method": "berg_luescher_oriented_triangles_v2",
        "scenario": scenario,
        "runs": [run],
    }


class ValidateTopologicalChargeRuntimeTest(unittest.TestCase):
    def test_accepts_fdm_evidence_without_hidden_fallback(self) -> None:
        validate_evidence(evidence())

    def test_rejects_hidden_fallback(self) -> None:
        payload = evidence()
        payload["runs"][0]["provenance"]["resolved_execution"]["lossy_fallback_used"] = True
        with self.assertRaisesRegex(ValueError, "fallback"):
            validate_evidence(payload)

    def test_rejects_non_p1_fem(self) -> None:
        payload = evidence("fem_p1")
        payload["runs"][0]["provenance"]["fe_order"] = 2
        with self.assertRaisesRegex(ValueError, "fe_order"):
            validate_evidence(payload)

    def test_rejects_cross_backend_frame_or_charge_drift(self) -> None:
        payload = evidence("cross_backend")
        fem = copy.deepcopy(payload["runs"][0])
        fem["charge"] = -0.90
        fem["provenance"]["discretization"] = "fem"
        fem["provenance"]["fe_order"] = 1
        fem["provenance"]["requested_execution"]["backend"] = "fem"
        fem["provenance"]["resolved_execution"]["backend"] = "fem"
        payload["runs"].append(fem)
        with self.assertRaisesRegex(ValueError, "difference"):
            validate_evidence(payload)


if __name__ == "__main__":
    unittest.main()
