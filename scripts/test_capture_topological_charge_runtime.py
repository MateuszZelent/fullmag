#!/usr/bin/env python3
"""Tests for the v2 topological-charge runtime evidence capture."""

from __future__ import annotations

import unittest

from scripts.capture_topological_charge_runtime import build_evidence
from scripts.validate_topological_charge_runtime import validate_evidence


class CaptureTopologicalChargeRuntimeTest(unittest.TestCase):
    def test_builds_versioned_evidence_from_a_v2_resource(self) -> None:
        resource = {
            "schema_version": "topological_charge.v2",
            "method": {"id": "berg_luescher_oriented_triangles_v2"},
            "object_id": "magnet",
            "charge": -0.99,
            "trust": "diagnostic_boundary",
            "support_frame": {"u_axis": [1, 0, 0], "v_axis": [0, 1, 0], "normal_axis": [0, 0, 1]},
            "provenance": {
                "discretization": "fdm",
                "fe_order": None,
                "requested_execution": {"backend": "cpu-fdm", "device": "cpu", "precision": "double", "mode": "strict"},
                "resolved_execution": {"backend": "cpu-fdm", "device": "cpu", "precision": "double", "mode": "strict", "lossy_fallback_used": False},
            },
        }
        evidence = build_evidence("fdm", resource)
        self.assertEqual(evidence["schema_version"], "topological_charge_runtime.v2")
        self.assertEqual(evidence["runs"][0]["provenance"]["discretization"], "fdm")
        validate_evidence(evidence)

    def test_rejects_non_v2_or_unresolved_resource(self) -> None:
        with self.assertRaisesRegex(ValueError, "schema_version"):
            build_evidence("fdm", {"schema_version": "legacy"})


if __name__ == "__main__":
    unittest.main()
