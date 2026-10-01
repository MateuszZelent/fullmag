"""Interpreted contract checks for R4 multi-k signed sidecar discovery.

The tests deliberately validate only manifest paths and sample/family binding,
including the certified-field and recomputed-certificate sidecar families.
They do not invent a payload schema for the still-evolving
``linearization_identity.v2`` producer; accepted/recomputed field replay is a
separate gate.
"""

from __future__ import annotations

from contextlib import redirect_stderr
import io
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import verify_fem_frequency_domain_eigen_artifacts as verifier  # noqa: E402
from test_fem_linearization_identity_replay import fixture as exact_identity_fixture, encode  # noqa: E402
from test_fem_equilibrium_identity_replay import _identity_fixture as equilibrium_fixture  # noqa: E402


def identity_fixture(sample_index=2, *, overrides=None):
    physical, _ = equilibrium_fixture()
    physical.update(overrides or {})
    return exact_identity_fixture(sample_index, overrides=physical)


SIDECAR_DEFINITIONS = verifier.R4_SIGNED_SIDECAR_DEFINITIONS


def _sidecar_path(index: int, filename: str) -> str:
    return f"eigen/metadata/sample_{index:04d}/{filename}"


def _write(root: Path, relative: str, payload: bytes = b"opaque-signed-payload") -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _manifest_artifacts(
    root: Path,
    *,
    family: str,
    samples: tuple[int, ...] = (0, 2, 7),
    identity_samples: tuple[int, ...] | None = None,
    include_states: bool = True,
    include_recomputed: bool = True,
) -> dict[str, object]:
    artifacts: dict[str, object] = {
        "accepted_fem_equilibrium_fields_v1_paths": [],
        "accepted_fem_equilibrium_fields_v2_paths": [],
        "linearization_identity_v2_paths": [],
        "certified_fem_equilibrium_fields_v1_paths": [],
        "certified_fem_equilibrium_fields_v2_paths": [],
        "recomputed_fem_linearization_certificate_v1_paths": [],
        "recomputed_fem_linearization_certificate_v2_paths": [],
    }
    if family == "v1":
        accepted_key = "accepted_fem_equilibrium_fields_v1_paths"
        equilibrium_name = "equilibrium_artifact.v7.json"
        state_name = "linearization_state.v6.json"
    elif family == "v2":
        accepted_key = "accepted_fem_equilibrium_fields_v2_paths"
        equilibrium_name = "equilibrium_artifact.v8.json"
        state_name = "linearization_state.v7.json"
    else:
        raise ValueError(f"unsupported fixture family: {family}")

    accepted_paths = []
    equilibrium_paths = []
    state_paths = []
    for sample_index in samples:
        accepted_path = _sidecar_path(sample_index, SIDECAR_DEFINITIONS[accepted_key][0])
        accepted_paths.append(accepted_path)
        _write(root, accepted_path)
        if include_states:
            equilibrium_path = _sidecar_path(sample_index, equilibrium_name)
            state_path = _sidecar_path(sample_index, state_name)
            equilibrium_paths.append(equilibrium_path)
            state_paths.append(state_path)
            _write(root, equilibrium_path, b"state")
            _write(root, state_path, b"state")
    artifacts[accepted_key] = accepted_paths

    if include_recomputed:
        certified_key = f"certified_fem_equilibrium_fields_{family}_paths"
        recomputed_key = f"recomputed_fem_linearization_certificate_{family}_paths"
        certified_filename = SIDECAR_DEFINITIONS[certified_key][0]
        recomputed_filename = SIDECAR_DEFINITIONS[recomputed_key][0]
        certified_paths = []
        recomputed_paths = []
        for sample_index in samples:
            certified_path = _sidecar_path(sample_index, certified_filename)
            recomputed_path = _sidecar_path(sample_index, recomputed_filename)
            certified_paths.append(certified_path)
            recomputed_paths.append(recomputed_path)
            _write(root, certified_path, b"certified-fields")
            _write(root, recomputed_path, b"recomputed-certificate")
        artifacts[certified_key] = certified_paths
        artifacts[recomputed_key] = recomputed_paths

    if family == "v2":
        identity_paths = []
        for sample_index in (
            samples if identity_samples is None else identity_samples
        ):
            identity_path = _sidecar_path(
                sample_index, SIDECAR_DEFINITIONS["linearization_identity_v2_paths"][0]
            )
            identity_paths.append(identity_path)
            # The verifier must not infer an identity-v2 payload schema.
            _write(root, identity_path, b"identity producer payload is opaque")
        artifacts["linearization_identity_v2_paths"] = identity_paths

    if family == "v1" and include_states:
        artifacts["equilibrium_artifact_v7_paths"] = equilibrium_paths
        artifacts["linearization_state_v6_paths"] = state_paths
    elif family == "v2" and include_states:
        artifacts["equilibrium_artifact_v8_paths"] = equilibrium_paths
        artifacts["linearization_state_v7_paths"] = state_paths
    return artifacts


def _add_identity_sidecars(
    root: Path, artifacts: dict[str, object], samples: tuple[int, ...]
) -> None:
    identity_paths = []
    for sample_index in samples:
        identity_path = _sidecar_path(
            sample_index, SIDECAR_DEFINITIONS["linearization_identity_v2_paths"][0]
        )
        identity_paths.append(identity_path)
        # The verifier must not infer an identity-v2 payload schema.
        _write(root, identity_path, b"identity producer payload is opaque")
    artifacts["linearization_identity_v2_paths"] = identity_paths


class EigenPathSignedSidecarTests(unittest.TestCase):
    def assert_rejected(
        self, root: Path, artifacts: dict[str, object], message: str
    ) -> None:
        with self.assertRaises(SystemExit) as raised:
            verifier.validate_r4_signed_sidecars(root, artifacts)
        self.assertIn(message, str(raised.exception))

    def test_history_manifest_without_r4_keys_remains_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = verifier.validate_r4_signed_sidecars(Path(directory), {"legacy": True})
            self.assertEqual(result["status"], "historical")

    def test_cli_reports_r4_not_verified_without_claiming_replay(self) -> None:
        stream = io.StringIO()
        result = {
            "status": "payload_replay_pending",
            "reason": "R4 sidecar paths are structurally consistent; accepted/recomputed payload replay is not implemented",
        }
        with redirect_stderr(stream):
            verifier.report_r4_discovery(result)
        self.assertEqual(
            stream.getvalue(),
            "R4 replay NOT VERIFIED [payload_replay_pending]: "
            "R4 sidecar paths are structurally consistent; accepted/recomputed "
            "payload replay is not implemented\n",
        )

    def test_require_r4_replay_gate_is_exposed(self) -> None:
        args = verifier.parse_args(["--require-r4-replay"])
        self.assertTrue(args.require_r4_replay)

    def test_v1_family_binds_to_legacy_state_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1")
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "missing_identity")
            self.assertEqual(result["accepted_family"], "v1")

    def test_v2_family_binds_to_canonical_state_and_opaque_identity_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2")
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "payload_replay_pending")
            self.assertEqual(result["accepted_family"], "v2")

    def test_current_v2_producer_with_empty_identity_is_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", identity_samples=(), include_states=False
            )
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "missing_identity")
            self.assertEqual(result["reason"],
                             "R4 linearization identity v2 sidecars are missing; accepted field payload replay is not verified")
            self.assertEqual(result["accepted_sample_indices"], [0, 2, 7])

    def test_legacy_three_array_manifest_with_identity_is_missing_recomputed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", include_states=False, include_recomputed=False
            )
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "missing_recomputed")
            self.assertEqual(
                result["missing_recomputed_keys"],
                [
                    "certified_fem_equilibrium_fields_v2_paths",
                    "recomputed_fem_linearization_certificate_v2_paths",
                ],
            )

    def test_actual_seven_array_manifest_missing_recomputed_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", include_states=False)
            path = root / artifacts[
                "recomputed_fem_linearization_certificate_v2_paths"
            ][1]
            path.unlink()
            self.assert_rejected(root, artifacts, "missing required artifact")

    def test_actual_seven_array_manifest_recomputed_sample_set_must_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", samples=(0, 2), include_states=False
            )
            paths = artifacts["certified_fem_equilibrium_fields_v2_paths"]
            assert isinstance(paths, list)
            replacement = _sidecar_path(
                7,
                SIDECAR_DEFINITIONS[
                    "certified_fem_equilibrium_fields_v2_paths"
                ][0],
            )
            _write(root, replacement, b"certified-fields")
            paths[1] = replacement
            self.assert_rejected(root, artifacts, "sample index set must match")

    def test_actual_seven_array_manifest_rejects_mixed_new_family(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v1", samples=(0,), include_states=False
            )
            mixed_path = _sidecar_path(
                0,
                SIDECAR_DEFINITIONS[
                    "certified_fem_equilibrium_fields_v2_paths"
                ][0],
            )
            _write(root, mixed_path, b"wrong-family")
            artifacts["certified_fem_equilibrium_fields_v2_paths"] = [mixed_path]
            self.assert_rejected(root, artifacts, "uses family v2")

    def test_partial_new_array_declaration_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", include_states=False)
            del artifacts["recomputed_fem_linearization_certificate_v1_paths"]
            self.assert_rejected(root, artifacts, "all four plural arrays")

    def test_actual_seven_array_manifest_with_empty_new_arrays_is_missing_recomputed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", include_states=False)
            for key in verifier.R4_NEW_SIDECAR_KEYS:
                artifacts[key] = []
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "missing_recomputed")
            self.assertEqual(
                result["missing_recomputed_keys"],
                [
                    "certified_fem_equilibrium_fields_v2_paths",
                    "recomputed_fem_linearization_certificate_v2_paths",
                ],
            )

    def test_all_seven_sidecar_arrays_must_cover_every_computed_sample(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", samples=(0, 2), include_states=False
            )
            with self.assertRaises(SystemExit) as raised:
                verifier.validate_r4_signed_sidecars(
                    root, artifacts, computed_sample_indices={0, 2, 7}
                )
            self.assertIn(
                "must match the computed spectrum sample index set",
                str(raised.exception),
            )

    def test_all_seven_sidecar_arrays_reject_an_uncomputed_extra_sample(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", samples=(0, 2, 7, 9), include_states=False
            )
            with self.assertRaises(SystemExit) as raised:
                verifier.validate_r4_signed_sidecars(
                    root, artifacts, computed_sample_indices={0, 2, 7}
                )
            self.assertIn(
                "must match the computed spectrum sample index set",
                str(raised.exception),
            )

    def test_spectrum_only_coverage_uses_samples_without_mode_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spectrum = {
                "sample_count": 3,
                "samples": [
                    {"sample_index": 0, "modes": []},
                    {"sample_index": 2, "modes": []},
                    {"sample_index": 7, "modes": []},
                ],
            }
            computed = verifier._computed_sample_indices_from_spectrum(spectrum)
            self.assertEqual(computed, {0, 2, 7})
            artifacts = _manifest_artifacts(
                root, family="v2", samples=(0, 2, 7), include_states=False
            )
            result = verifier.validate_r4_signed_sidecars(
                root, artifacts, computed_sample_indices=computed
            )
            self.assertEqual(result["status"], "payload_replay_pending")
            self.assertEqual(result["computed_sample_indices"], [0, 2, 7])

    def test_spectrum_sample_index_contract_rejects_invalid_values(self) -> None:
        cases = (
            (
                "duplicate sample_index",
                {
                    "sample_count": 2,
                    "samples": [
                        {"sample_index": 0},
                        {"sample_index": 0},
                    ],
                },
                "duplicate sample_index",
            ),
            (
                "negative sample_index",
                {"sample_count": 1, "samples": [{"sample_index": -1}]},
                "must be a non-negative integer",
            ),
            (
                "boolean sample_index",
                {"sample_count": 1, "samples": [{"sample_index": True}]},
                "must be a non-negative integer",
            ),
            (
                "float sample_index",
                {"sample_count": 1, "samples": [{"sample_index": 1.0}]},
                "must be a non-negative integer",
            ),
            (
                "boolean sample_count",
                {"sample_count": True, "samples": [{"sample_index": 0}]},
                "spectrum.sample_count must be a non-negative integer",
            ),
            (
                "float sample_count",
                {"sample_count": 1.0, "samples": [{"sample_index": 0}]},
                "spectrum.sample_count must be a non-negative integer",
            ),
            (
                "sample_count mismatch",
                {"sample_count": 2, "samples": [{"sample_index": 0}]},
                "spectrum.sample_count: got 2, expected 1",
            ),
        )
        for case, spectrum, message in cases:
            with self.subTest(case=case):
                with self.assertRaises(SystemExit) as raised:
                    verifier._computed_sample_indices_from_spectrum(spectrum)
                self.assertIn(message, str(raised.exception))

    def test_empty_spectrum_is_not_an_inferred_contiguous_range(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            computed = verifier._computed_sample_indices_from_spectrum(
                {"sample_count": 0, "samples": []}
            )
            self.assertEqual(computed, set())
            artifacts = {
                key: [] for key in verifier.R4_SIGNED_SIDECAR_DEFINITIONS
            }
            result = verifier.validate_r4_signed_sidecars(
                root, artifacts, computed_sample_indices=computed
            )
            self.assertEqual(result["status"], "missing_accepted")
            self.assertEqual(result["computed_sample_indices"], [])

    def test_validate_equilibrium_artifacts_enforces_computed_sample_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", samples=(0, 2, 7), include_states=False
            )
            result = verifier.validate_equilibrium_artifacts(
                root,
                {"artifacts": artifacts},
                computed_sample_indices={0, 2, 7},
            )
            self.assertEqual(result["status"], "payload_replay_pending")
            self.assertEqual(result["computed_sample_indices"], [0, 2, 7])
            with self.assertRaises(SystemExit) as raised:
                verifier.validate_equilibrium_artifacts(
                    root,
                    {"artifacts": artifacts},
                    computed_sample_indices={0, 2},
                )
            self.assertIn(
                "must match the computed spectrum sample index set",
                str(raised.exception),
            )

    def test_partial_r4_array_declaration_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", include_states=False)
            del artifacts["linearization_identity_v2_paths"]
            self.assert_rejected(root, artifacts, "must declare all plural arrays")

    def test_accepted_v1_and_v2_are_mutually_exclusive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            v2_path = _sidecar_path(
                0, SIDECAR_DEFINITIONS["accepted_fem_equilibrium_fields_v2_paths"][0]
            )
            _write(root, v2_path)
            artifacts["accepted_fem_equilibrium_fields_v2_paths"] = [v2_path]
            self.assert_rejected(root, artifacts, "mix accepted FEM equilibrium")

    def test_v2_identity_sample_set_must_match_accepted_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(
                root, family="v2", samples=(0, 2), identity_samples=(0, 7)
            )
            self.assert_rejected(root, artifacts, "sample index sets must match")

    def test_no_ku_v1_family_can_bind_identity_v2_pending_replay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            _add_identity_sidecars(root, artifacts, (0,))
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "payload_replay_pending")
            self.assertEqual(result["accepted_family"], "v1")
            self.assertEqual(result["identity_sample_indices"], [0])

    def test_identity_without_accepted_family_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = {
                "accepted_fem_equilibrium_fields_v1_paths": [],
                "accepted_fem_equilibrium_fields_v2_paths": [],
                "linearization_identity_v2_paths": [],
            }
            _add_identity_sidecars(root, artifacts, (0,))
            self.assert_rejected(root, artifacts, "cannot be declared without an accepted")

    def test_all_empty_r4_arrays_with_state_are_missing_accepted_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = {
                "accepted_fem_equilibrium_fields_v1_paths": [],
                "accepted_fem_equilibrium_fields_v2_paths": [],
                "linearization_identity_v2_paths": [],
            }
            equilibrium = _sidecar_path(0, "equilibrium_artifact.v8.json")
            state = _sidecar_path(0, "linearization_state.v7.json")
            _write(root, equilibrium, b"state")
            _write(root, state, b"state")
            artifacts["equilibrium_artifact_v8_paths"] = [equilibrium]
            artifacts["linearization_state_v7_paths"] = [state]
            result = verifier.validate_r4_signed_sidecars(root, artifacts)
            self.assertEqual(result["status"], "missing_accepted")
            self.assertEqual(result["reason"], "R4 accepted FEM equilibrium sidecars are missing")

    def test_accepted_family_state_samples_must_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", samples=(0, 2))
            stale_equilibrium = _sidecar_path(7, "equilibrium_artifact.v8.json")
            stale_state = _sidecar_path(7, "linearization_state.v7.json")
            _write(root, stale_equilibrium, b"state")
            _write(root, stale_state, b"state")
            artifacts["equilibrium_artifact_v8_paths"] = [stale_equilibrium]
            artifacts["linearization_state_v7_paths"] = [stale_state]
            self.assert_rejected(root, artifacts, "accepted fields and state sample")

    def test_v1_accepted_with_v8_state_family_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            equilibrium = _sidecar_path(0, "equilibrium_artifact.v8.json")
            state = _sidecar_path(0, "linearization_state.v7.json")
            _write(root, equilibrium, b"state")
            _write(root, state, b"state")
            artifacts["equilibrium_artifact_v8_paths"] = [equilibrium]
            artifacts["linearization_state_v7_paths"] = [state]
            self.assert_rejected(root, artifacts, "mixed schema families")

    def test_v2_accepted_with_v7_state_family_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", samples=(0,))
            equilibrium = _sidecar_path(0, "equilibrium_artifact.v7.json")
            state = _sidecar_path(0, "linearization_state.v6.json")
            _write(root, equilibrium, b"state")
            _write(root, state, b"state")
            artifacts["equilibrium_artifact_v7_paths"] = [equilibrium]
            artifacts["linearization_state_v6_paths"] = [state]
            self.assert_rejected(root, artifacts, "mixed schema families")

    def test_duplicate_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            paths = artifacts["accepted_fem_equilibrium_fields_v1_paths"]
            assert isinstance(paths, list)
            paths.append(paths[0])
            self.assert_rejected(root, artifacts, "duplicate paths")

    def test_missing_sidecar_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            accepted_path = root / artifacts["accepted_fem_equilibrium_fields_v1_paths"][0]
            accepted_path.unlink()
            self.assert_rejected(root, artifacts, "missing required artifact")

    def test_path_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            artifacts["accepted_fem_equilibrium_fields_v1_paths"] = [
                "eigen/metadata/sample_0000/../../outside.json"
            ]
            self.assert_rejected(root, artifacts, "relative path inside")

    def test_noncanonical_namespace_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v1", samples=(0,))
            bad_path = "eigen/wrong-metadata/sample_0000/accepted_fem_equilibrium_fields.v1.json"
            _write(root, bad_path)
            artifacts["accepted_fem_equilibrium_fields_v1_paths"] = [bad_path]
            self.assert_rejected(root, artifacts, "sample_NNNN")


class IdentityPreimagePathTests(unittest.TestCase):
    def bundle(self, root: Path, samples=(0, 2, 7)) -> dict[str, object]:
        artifacts = _manifest_artifacts(root, family="v2", samples=samples)
        paths = []
        for sample_index in samples:
            identity, preimage = identity_fixture(sample_index)
            _write(root, _sidecar_path(sample_index, "linearization_identity.v2.json"), encode(identity))
            path = _sidecar_path(sample_index, "linearization_identity_preimage.v1.json")
            paths.append(path)
            _write(root, path, encode(preimage))
        artifacts[verifier.R4_IDENTITY_PREIMAGE_KEY] = paths
        return artifacts

    def test_exact_preimages_replayed_for_all_computed_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = self.bundle(root)
            result = verifier.validate_r4_signed_sidecars(root, artifacts, {0, 2, 7})
            self.assertEqual(result["identity_content_digest_status"], "verified_exact_preimage")
            self.assertEqual(set(result["identity_content_sha256_by_sample"]), {"0", "2", "7"})
            self.assertEqual(result["equilibrium_preimage_digest_status"], "verified_five_exact_preimages")
            self.assertEqual(set(result["equilibrium_preimage_sha256_by_sample"]), {"0", "2", "7"})
            self.assertTrue(all(len(digests) == 5 for digests in result["equilibrium_preimage_sha256_by_sample"].values()))
            # Identity digest replay cannot promote missing physical replay.
            self.assertEqual(result["status"], "payload_replay_pending")

    def test_missing_historical_preimages_remain_unqualified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = _manifest_artifacts(root, family="v2", samples=(2,))
            result = verifier.validate_r4_signed_sidecars(root, artifacts, {2})
            self.assertEqual(result["identity_content_digest_status"], "unverified_missing_preimage")
            self.assertEqual(result["equilibrium_preimage_digest_status"], "unverified_missing_preimage")
            self.assertEqual(result["status"], "payload_replay_pending")

    def test_valid_outer_digest_cannot_hide_corrupt_physical_preimage(self):
        physical, _ = equilibrium_fixture()
        fields = [key for key in physical if key.endswith("_preimage_json")]
        self.assertEqual(len(fields), 5)
        for field in fields:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifacts = self.bundle(root, samples=(2,))
                identity, preimage = identity_fixture(2, overrides={field: physical[field] + " "})
                _write(root, artifacts[verifier.R4_IDENTITY_SIDECAR_KEY][0], encode(identity))
                _write(root, artifacts[verifier.R4_IDENTITY_PREIMAGE_KEY][0], encode(preimage))
                # The outer digest is freshly valid, but each inner digest
                # still binds its original exact bytes and must reject.
                with self.assertRaisesRegex(SystemExit, "equilibrium exact preimage replay failed"):
                    verifier.validate_r4_signed_sidecars(root, artifacts, {2})

    def test_missing_fields_preserve_successful_identity_digest_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = self.bundle(root, samples=(2,))
            for key in verifier.R4_NEW_SIDECAR_KEYS:
                artifacts[key] = []
            result = verifier.validate_r4_signed_sidecars(root, artifacts, {2})
            self.assertEqual(result["status"], "missing_recomputed")
            self.assertEqual(result["identity_content_digest_status"], "verified_exact_preimage")
            self.assertEqual(set(result["identity_content_sha256_by_sample"]), {"2"})
            self.assertEqual(result["equilibrium_preimage_digest_status"], "verified_five_exact_preimages")

    def test_incomplete_or_extra_preimage_sample_sets_are_rejected(self):
        for mutation in ("empty", "missing", "extra"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifacts = self.bundle(root)
                paths = artifacts[verifier.R4_IDENTITY_PREIMAGE_KEY]
                if mutation == "empty":
                    paths.clear()
                elif mutation == "missing":
                    paths.pop()
                else:
                    path = _sidecar_path(8, "linearization_identity_preimage.v1.json")
                    _write(root, path)
                    paths.append(path)
                with self.assertRaisesRegex(SystemExit, "preimage and identity sample index"):
                    verifier.validate_r4_signed_sidecars(root, artifacts, {0, 2, 7})

    def test_wrong_identity_sample_with_valid_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = self.bundle(root, samples=(0,))
            identity, preimage = identity_fixture(2)
            _write(root, artifacts[verifier.R4_IDENTITY_SIDECAR_KEY][0], encode(identity))
            _write(root, artifacts[verifier.R4_IDENTITY_PREIMAGE_KEY][0], encode(preimage))
            with self.assertRaisesRegex(SystemExit, "sample_index must match"):
                verifier.validate_r4_signed_sidecars(root, artifacts, {0})

    def test_corrupt_exact_preimage_fails_main_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = self.bundle(root, samples=(2,))
            _, preimage = identity_fixture(2)
            preimage["identity_preimage_json"] += " "
            _write(root, artifacts[verifier.R4_IDENTITY_PREIMAGE_KEY][0], encode(preimage))
            with self.assertRaisesRegex(SystemExit, "exact preimage replay failed"):
                verifier.validate_r4_signed_sidecars(root, artifacts, {2})

    def test_preimage_without_identity_arrays_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(SystemExit, "must declare all plural arrays"):
                verifier.validate_r4_signed_sidecars(root, {verifier.R4_IDENTITY_PREIMAGE_KEY: []}, {0})


if __name__ == "__main__":
    unittest.main()
