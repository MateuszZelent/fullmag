"""Main-verifier routing with real interpreted nonshared byte fixtures."""
from pathlib import Path
import json
import tempfile
import unittest

from scripts.test_fem_nonshared_operator_replay import _bundle, _rewrite_payload_bundle
from scripts.test_fem_nonshared_native_input_diagnostics import (
    FINAL_PATH,
    PREIMAGE_PATH,
    _write_native_input_diagnostics,
)
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


def native_manifest_paths():
    return {
        "nonshared_floquet_native_input_diagnostics_v1_paths": [FINAL_PATH],
        "nonshared_floquet_native_input_diagnostics_v1_path": FINAL_PATH,
        "nonshared_floquet_native_input_diagnostics_preimage_v1_paths": [PREIMAGE_PATH],
        "nonshared_floquet_native_input_diagnostics_preimage_v1_path": PREIMAGE_PATH,
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

    def test_native_input_manifest_pair_is_validated_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            artifacts = manifest_paths()
            artifacts.update(native_manifest_paths())
            result = validate_nonshared_operator_replay(root, artifacts, {3})
            coverage = result["native_input_diagnostics"]
            self.assertEqual(coverage["status"], "path_coverage_complete")
            self.assertTrue(coverage["structural_complete"])
            self.assertIn(
                "native_input_diagnostics",
                result["reports_by_sample"]["3"]["exact_refs_verified"],
            )
            self.assertEqual(result["scientific_qualification"], "NOT_VERIFIED")

    def test_native_input_manifest_rejects_flattened_or_partial_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            artifacts = manifest_paths()
            artifacts.update(native_manifest_paths())
            flattened = root / "eigen/metadata/sample_0003/native_input_operator_diagnostics.v1.json"
            flattened.parent.mkdir(parents=True, exist_ok=True)
            flattened.write_bytes((root / FINAL_PATH).read_bytes())
            artifacts["nonshared_floquet_native_input_diagnostics_v1_paths"] = [
                flattened.relative_to(root).as_posix()
            ]
            artifacts["nonshared_floquet_native_input_diagnostics_v1_path"] = (
                flattened.relative_to(root).as_posix()
            )
            with self.assertRaisesRegex(SystemExit, "nonshared_source"):
                validate_nonshared_operator_replay(root, artifacts, {3})

            artifacts = manifest_paths()
            artifacts["nonshared_floquet_native_input_diagnostics_v1_paths"] = [FINAL_PATH]
            with self.assertRaisesRegex(SystemExit, "both final and preimage"):
                validate_nonshared_operator_replay(root, artifacts, {3})

    def test_native_input_manifest_rejects_boolean_sample_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            final_path = root / FINAL_PATH
            final = json.loads(final_path.read_text(encoding="utf-8"))
            final["nonshared_floquet_native_input_diagnostics_sample_index"] = True
            final_path.write_text(json.dumps(final), encoding="utf-8")
            artifacts = manifest_paths()
            artifacts.update(native_manifest_paths())
            with self.assertRaisesRegex(SystemExit, "sample_index must be an integer"):
                validate_nonshared_operator_replay(root, artifacts, {3})

    def test_historical_absence_remains_unverified(self):
        self.assertEqual(validate_nonshared_operator_replay(Path("."), {}, {3})["status"], "NOT_VERIFIED")
        for families in (FAMILIES, FAMILIES[:1]):
            with self.subTest(families=families), self.assertRaisesRegex(SystemExit, "explicit nonshared"):
                validate_nonshared_operator_replay(
                    Path("."), {f"{family}_v1_paths": [] for family in families}, {3},
                )

    def test_native_input_manifest_requires_numeric_sample_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            final_four = FINAL_PATH.replace("sample_0003", "sample_0004")
            preimage_four = PREIMAGE_PATH.replace("sample_0003", "sample_0004")
            final = json.loads((root / FINAL_PATH).read_text(encoding="utf-8"))
            final.update({
                "nonshared_floquet_native_input_diagnostics_sample_index": 4,
                "nonshared_floquet_native_input_diagnostics_path": final_four,
                "nonshared_floquet_native_input_diagnostics_preimage_path": preimage_four,
            })
            (root / final_four).parent.mkdir(parents=True)
            (root / final_four).write_text(json.dumps(final), encoding="utf-8")
            (root / preimage_four).write_bytes((root / PREIMAGE_PATH).read_bytes())
            artifacts = {
                "nonshared_floquet_native_input_diagnostics_v1_paths": [FINAL_PATH, final_four],
                "nonshared_floquet_native_input_diagnostics_v1_path": None,
                "nonshared_floquet_native_input_diagnostics_preimage_v1_paths": [PREIMAGE_PATH, preimage_four],
                "nonshared_floquet_native_input_diagnostics_preimage_v1_path": None,
            }
            result = validate_nonshared_operator_replay(root, artifacts, {3, 4})
            self.assertEqual(result["status"], "NOT_VERIFIED")
            self.assertEqual(result["native_input_diagnostics"]["sample_indices"], [3, 4])
            for key in (
                "nonshared_floquet_native_input_diagnostics_v1_paths",
                "nonshared_floquet_native_input_diagnostics_preimage_v1_paths",
            ):
                with self.subTest(key=key):
                    reversed_artifacts = dict(artifacts)
                    reversed_artifacts[key] = list(reversed(artifacts[key]))
                    with self.assertRaisesRegex(SystemExit, "ordered by sample index"):
                        validate_nonshared_operator_replay(root, reversed_artifacts, {3, 4})

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
