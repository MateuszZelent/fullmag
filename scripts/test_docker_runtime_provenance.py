"""Canonical runtime provenance path regressions for both Compose layouts."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


SERVICE_DIR = Path(__file__).resolve().parents[1] / "docker" / "all-in-one"
sys.path.insert(0, str(SERVICE_DIR))
import runtime_service


class RuntimeProvenancePathTests(unittest.TestCase):
    def setUp(self):
        self.legacy = runtime_service.IMAGE_ROOT / "provenance.json"
        self.control = Path("/build/control/provenance.json")

    def test_legacy_image_path_remains_the_default(self):
        paths = runtime_service.canonical_paths({})
        self.assertEqual(paths.provenance, self.legacy)

    def test_build_control_path_is_accepted_and_passed_to_native_processes(self):
        paths = runtime_service.canonical_paths(
            {"FULLMAG_PACKAGE_PROVENANCE": str(self.control)}
        )
        with patch.dict(
            os.environ,
            {"FULLMAG_PACKAGE_PROVENANCE": str(self.legacy)},
        ):
            environment = runtime_service.process_environment(paths, service=True)

        self.assertEqual(paths.provenance, self.control)
        self.assertEqual(
            environment["FULLMAG_PACKAGE_PROVENANCE"], str(self.control)
        )

    def test_other_prefixes_and_traversal_are_rejected(self):
        for value in (
            "/opt/fullmag/provenance.json.backup",
            "/build/control/provenance.json.extra",
            "/build/control/../control/provenance.json",
            "/tmp/fullmag/provenance.json",
        ):
            with self.subTest(value=value), self.assertRaises(
                runtime_service.RuntimeServiceError
            ):
                runtime_service.canonical_paths(
                    {"FULLMAG_PACKAGE_PROVENANCE": value}
                )


if __name__ == "__main__":
    unittest.main()
