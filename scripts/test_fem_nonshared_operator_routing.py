"""Main-verifier routing with real interpreted nonshared byte fixtures."""
from pathlib import Path
import tempfile
import unittest

from scripts.test_fem_nonshared_operator_replay import _bundle, _rewrite_payload_bundle
from scripts.verify_fem_frequency_domain_eigen_artifacts import (
    validate_equilibrium_artifacts, validate_nonshared_operator_replay,
)


FAMILIES = (
    "nonshared_floquet_operator_identity",
    "nonshared_floquet_operator_identity_preimage",
    "nonshared_floquet_source_state",
)


def manifest_paths():
    return {
        f"{family}_v1_paths": [f"eigen/metadata/sample_0003/{family}.v1.json"]
        for family in FAMILIES
    }


class NonsharedOperatorRoutingTests(unittest.TestCase):
    def test_real_fixture_replays_without_native_or_scientific_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            result = validate_nonshared_operator_replay(root, manifest_paths(), {3})
            self.assertEqual(result["status"], "nonshared_exact_operator_relations_replayed")
            self.assertEqual(result["native_operator_replay_status"], "NOT_VERIFIED")
            self.assertEqual(result["scientific_qualification"], "NOT_VERIFIED")
            self.assertEqual(result["reports_by_sample"]["3"]["gamma0_rad_s_per_A_m"], 2.0)
            integrated = validate_equilibrium_artifacts(
                root, {"artifacts": manifest_paths()}, computed_sample_indices={3},
            )
            self.assertEqual(integrated["nonshared_operator_replay"], result)
            self.assertEqual(integrated["consumer_plan_replay"]["status"], "NOT_VERIFIED")
            self.assertEqual(integrated["producer_payload_replay"]["status"], "NOT_VERIFIED")

    def test_historical_absence_remains_unverified(self):
        self.assertEqual(validate_nonshared_operator_replay(Path("."), {}, {3})["status"], "NOT_VERIFIED")
        for families in (FAMILIES, FAMILIES[:1]):
            with self.subTest(families=families), self.assertRaisesRegex(SystemExit, "explicit nonshared"):
                validate_nonshared_operator_replay(
                    Path("."), {f"{family}_v1_paths": [] for family in families}, {3},
                )

    def test_incomplete_coverage_and_wrong_computed_samples_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            artifacts = manifest_paths()
            with self.assertRaises(SystemExit):
                validate_nonshared_operator_replay(root, artifacts, {0, 3})
            artifacts.pop(f"{FAMILIES[1]}_v1_paths")
            with self.assertRaises(SystemExit):
                validate_nonshared_operator_replay(root, artifacts, {3})

    def test_singular_alias_and_tampered_bytes_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            artifacts = manifest_paths()
            artifacts[f"{FAMILIES[0]}_v1_path"] = "foreign.json"
            with self.assertRaises(SystemExit):
                validate_nonshared_operator_replay(root, artifacts, {3})
            artifacts.pop(f"{FAMILIES[0]}_v1_path")
            path = root / artifacts[f"{FAMILIES[0]}_v1_paths"][0]
            path.write_bytes(path.read_bytes().replace(b'"sample_index":3', b'"sample_index":4'))
            with self.assertRaises(SystemExit):
                validate_nonshared_operator_replay(root, artifacts, {3})

    def test_rehashed_malformed_matrix_is_a_controlled_main_verifier_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_matrix=lambda value: value.__setitem__("embedding", []))
            with self.assertRaisesRegex(SystemExit, "unsupported embedding"):
                validate_equilibrium_artifacts(
                    root, {"artifacts": manifest_paths()}, computed_sample_indices={3},
                )


if __name__ == "__main__":
    unittest.main()
