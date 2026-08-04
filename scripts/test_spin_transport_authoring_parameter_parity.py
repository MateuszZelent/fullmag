from __future__ import annotations

import json
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = REPO_ROOT / "docs" / "specs" / "spin-transport-authoring-parameter-parity-v1.json"
REQUIRED_PARAMETER_KEYS = {
    "id",
    "family",
    "variant",
    "python_path",
    "ir_path",
    "ui_field",
    "unit",
    "kind",
    "status",
    "round_trip",
    "planner_error_class",
}
ALLOWED_STATUS = {"executable", "declared_unsupported", "not_applicable"}
ALLOWED_ROUND_TRIP = {"required", "preserve_and_reject", "forbidden"}
REQUIRED_VARIANTS = {
    ("current_transport", "prescribed_density"),
    ("current_transport", "ohmic_poisson"),
    ("spin_transport", "steady"),
    ("spin_transport", "transient"),
    ("spin_torque", "zhang_li"),
    ("spin_torque", "slonczewski"),
    ("spin_torque", "prescribed_sot"),
    ("oersted", "oersted_cylinder"),
    ("oersted", "oersted_field"),
}


class SpinTransportAuthoringParameterManifestTests(unittest.TestCase):
    def test_manifest_is_versioned_and_covers_public_variants(self) -> None:
        with MANIFEST_PATH.open(encoding="utf-8") as handle:
            manifest = json.load(handle)

        self.assertEqual(
            manifest.get("schema_version"),
            "spin_transport_authoring_parameter_parity.v1",
        )
        self.assertIsInstance(manifest.get("families"), list)
        self.assertIsInstance(manifest.get("parameters"), list)
        self.assertIsInstance(manifest.get("unsupported_cases"), list)

        parameters = manifest["parameters"]
        ids = [entry.get("id") for entry in parameters]
        self.assertTrue(all(isinstance(identifier, str) and identifier for identifier in ids))
        self.assertEqual(len(ids), len(set(ids)), "parameter IDs must be unique")
        self.assertTrue(parameters, "the parity manifest must not be empty")

        variants = {(entry.get("family"), entry.get("variant")) for entry in parameters}
        self.assertTrue(REQUIRED_VARIANTS <= variants, REQUIRED_VARIANTS - variants)

        for entry in parameters:
            self.assertEqual(
                REQUIRED_PARAMETER_KEYS,
                set(entry),
                f"manifest entry {entry.get('id')!r} has an incomplete schema",
            )
            self.assertIn(entry["status"], ALLOWED_STATUS)
            self.assertIn(entry["round_trip"], ALLOWED_ROUND_TRIP)
            self.assertTrue(entry["python_path"], entry["id"])
            self.assertTrue(entry["ir_path"], entry["id"])
            self.assertTrue(entry["ui_field"], entry["id"])
            self.assertTrue(entry["kind"], entry["id"])
            self.assertTrue(entry["planner_error_class"], entry["id"])


if __name__ == "__main__":
    unittest.main()
