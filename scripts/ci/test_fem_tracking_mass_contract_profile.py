"""Static configuration checks for the hosted tracking-mass contract profiles."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_fem_positive_mass_contract as contract


class FemTrackingMassContractProfileTests(unittest.TestCase):
    def test_mfem_profile_selects_provider_and_snapshot_contracts(self):
        profile = contract.CONTRACT_PROFILES["tracking-mass-mfem"]

        self.assertTrue(profile["uses_mfem_stack"])
        self.assertTrue(profile["requires_source_snapshot"])
        self.assertTrue(profile["direct_compose"])
        self.assertEqual(
            [test["name"] for test in profile["tests"]],
            [
                "fem_tracking_mass_provider_contract",
                "fem_tracking_mass_snapshot_contract",
            ],
        )
        self.assertEqual(
            [test["marker"] for test in profile["tests"]],
            [
                "PASS: fem_tracking_mass_provider_geometric_csr_contract",
                "PASS: fem_tracking_mass_snapshot_cabi_contract",
            ],
        )
        self.assertIn(
            "-DFULLMAG_FEM_SOURCE_SNAPSHOT_SHA256",
            profile["tests"][1]["compile_definitions"],
        )
        self.assertEqual(
            contract._ctest_regex(profile),
            "^(fem_tracking_mass_provider_contract|fem_tracking_mass_snapshot_contract)$",
        )

    def test_stub_profile_selects_no_stack_unavailable_contract(self):
        profile = contract.CONTRACT_PROFILES["tracking-mass-stub"]

        self.assertFalse(profile["uses_mfem_stack"])
        self.assertTrue(profile["requires_source_snapshot"])
        self.assertFalse(profile.get("direct_compose", False))
        self.assertEqual(
            [test["name"] for test in profile["tests"]],
            ["fem_tracking_mass_snapshot_contract"],
        )
        self.assertEqual(
            profile["tests"][0]["marker"],
            "PASS: fem_tracking_mass_snapshot_stub_contract",
        )
        self.assertEqual(contract._ctest_regex(profile), "^fem_tracking_mass_snapshot_contract$")
        self.assertIn(
            "-DFULLMAG_HAS_MFEM_STACK=0",
            profile["tests"][0]["compile_definitions"],
        )
        self.assertIn(
            "-DFULLMAG_FEM_SOURCE_SNAPSHOT_SHA256",
            profile["tests"][0]["compile_definitions"],
        )

    def test_positive_mass_profile_remains_separate(self):
        profile = contract.CONTRACT_PROFILES["positive-mass"]

        self.assertFalse(profile.get("direct_compose", False))
        self.assertNotIn(
            "fem_tracking_mass_provider_contract",
            [test["name"] for test in profile["tests"]],
        )
        self.assertNotIn(
            "fem_tracking_mass_snapshot_contract",
            [test["name"] for test in profile["tests"]],
        )


if __name__ == "__main__":
    unittest.main()
