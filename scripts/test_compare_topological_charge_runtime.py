#!/usr/bin/env python3
"""Regression tests for cross-backend topological-charge evidence assembly."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.compare_topological_charge_runtime import compare
from scripts.test_validate_topological_charge_runtime import evidence


class CompareTopologicalChargeRuntimeTest(unittest.TestCase):
    def test_combines_one_fdm_and_one_p1_fem_run(self) -> None:
        fdm = evidence("fdm")
        fem = evidence("fem_p1")
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            fdm_path = directory / "fdm.json"
            fem_path = directory / "fem.json"
            fdm_path.write_text(json.dumps(fdm), encoding="utf-8")
            fem_path.write_text(json.dumps(fem), encoding="utf-8")
            payload = compare(fdm_path, fem_path)
        self.assertEqual(payload["scenario"], "cross_backend")
        self.assertEqual(len(payload["runs"]), 2)

    def test_rejects_mislabeled_fem_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            fdm_path = directory / "fdm.json"
            fem_path = directory / "fem.json"
            fdm_path.write_text(json.dumps(evidence("fdm")), encoding="utf-8")
            fem_path.write_text(json.dumps(evidence("fdm")), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "fem_p1"):
                compare(fdm_path, fem_path)


if __name__ == "__main__":
    unittest.main()
