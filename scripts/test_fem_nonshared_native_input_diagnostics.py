"""Interpreted regressions for exact non-shared native input diagnostics."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from fem_nonshared_operator_replay import (  # noqa: E402
    NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD,
    NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA,
    NATIVE_INPUT_DIAGNOSTICS_REFS_SCHEMA,
    NATIVE_INPUT_DIAGNOSTICS_SCHEMA,
    NonSharedReplayError,
    raw_sha256,
    replay_nonshared_operator,
)
from test_fem_nonshared_operator_replay import (  # noqa: E402
    MATRIX_PENCIL_SHA,
    OPERATOR_INPUT_RAW,
    _bundle,
    _digest,
    _raw,
    _ref,
    _write,
)


SAMPLE = 3
PREFIX = "eigen/metadata/sample_0003/nonshared_source/"
FINAL_PATH = PREFIX + "native_input_operator_diagnostics.v1.json"
PREIMAGE_PATH = PREFIX + "native_input_operator_diagnostics_preimage.v1.json"
SOLVER_PATH = "eigen/diagnostics/solver.v1.json"


def _write_native_input_diagnostics(root: Path) -> None:
    identity = json.loads(
        (root / "eigen/metadata/sample_0003/nonshared_floquet_operator_identity.v1.json").read_text(
            encoding="utf-8"
        )
    )
    operator = json.loads(OPERATOR_INPUT_RAW)
    final = {
        "schema_version": "frequency_domain_operator_diagnostics.v1",
        "payload_kind": "rust_full_2x2_dense_operator",
        "stiffness_units": "rad_s_inv",
        "gyrotropic_form": "pencil_B=-G=[[0,M],[-M,0]]",
        "operator_diagnostics_sha256": operator["operator_diagnostics_sha256"],
        "operator_diagnostics_schema": operator["operator_diagnostics_schema"],
        "nonshared_floquet_native_input_diagnostics_schema": NATIVE_INPUT_DIAGNOSTICS_SCHEMA,
        "nonshared_floquet_native_input_diagnostics_sample_index": SAMPLE,
        "nonshared_floquet_native_input_diagnostics_path": FINAL_PATH,
        "nonshared_floquet_native_input_diagnostics_preimage_path": PREIMAGE_PATH,
        NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD: "",
        "nonshared_floquet_operator_identity_sha256": identity["content_sha256"],
        "nonshared_floquet_source_state_sha256": identity["source_state_sha256"],
        "nonshared_floquet_matrix_pencil_sha256": MATRIX_PENCIL_SHA,
        "nonshared_floquet_mesh_payload_sha256": identity["mesh_payload_sha256"],
        "nonshared_floquet_exact_replay_refs": copy.deepcopy(identity["exact_replay_refs"]),
        "nonshared_floquet_operator_identity": {
            "schema_version": identity["schema_version"],
            "content_sha256": identity["content_sha256"],
            "sample_index": SAMPLE,
            "operator_input_signature_sha256": identity["operator_input_signature_sha256"],
            "source_state_sha256": identity["source_state_sha256"],
            "matrix_pencil_sha256": identity["matrix_pencil_sha256"],
            "source_replay_qualified": False,
        },
    }
    preimage = copy.deepcopy(final)
    preimage_raw = _raw(preimage)
    final[NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD] = raw_sha256(preimage_raw)
    final_raw = _raw(final)
    _write(root, FINAL_PATH, final_raw)
    _write(root, PREIMAGE_PATH, preimage_raw)
    refs = {
        "schema_version": NATIVE_INPUT_DIAGNOSTICS_REFS_SCHEMA,
        "sample_index": SAMPLE,
        "payload": {
            **_ref(NATIVE_INPUT_DIAGNOSTICS_SCHEMA, FINAL_PATH, final_raw),
            "sample_index": SAMPLE,
        },
        "preimage": {
            **_ref(NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA, PREIMAGE_PATH, preimage_raw),
            "sample_index": SAMPLE,
        },
    }
    _write(root, SOLVER_PATH, _raw({"nonshared_floquet_native_input_diagnostics_exact_refs": refs}))


def _rewrite_native_input_diagnostics(root: Path, mutate: object) -> None:
    final_path = root / FINAL_PATH
    final = json.loads(final_path.read_text(encoding="utf-8"))
    preimage = copy.deepcopy(final)
    preimage[NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD] = ""
    mutate(preimage)
    preimage_raw = _raw(preimage)
    final[NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD] = raw_sha256(preimage_raw)
    final_raw = _raw(final)
    _write(root, FINAL_PATH, final_raw)
    _write(root, PREIMAGE_PATH, preimage_raw)
    refs = json.loads((root / SOLVER_PATH).read_text(encoding="utf-8"))[
        "nonshared_floquet_native_input_diagnostics_exact_refs"
    ]
    refs["payload"] = {
        **_ref(NATIVE_INPUT_DIAGNOSTICS_SCHEMA, FINAL_PATH, final_raw),
        "sample_index": SAMPLE,
    }
    refs["preimage"] = {
        **_ref(NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA, PREIMAGE_PATH, preimage_raw),
        "sample_index": SAMPLE,
    }
    _write(root, SOLVER_PATH, _raw({"nonshared_floquet_native_input_diagnostics_exact_refs": refs}))


class NonSharedNativeInputDiagnosticsTests(unittest.TestCase):
    def test_exact_final_cabi_payload_is_replayed_and_remains_unqualified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            report = replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("native_input_diagnostics", report.exact_refs_verified)
            self.assertNotIn("operator_diagnostics_exact_digest_unbound", report.gaps)
            self.assertNotIn("native_input_diagnostics_not_published", report.gaps)
            self.assertIn("native_actual_matrix_pencil_not_replayed", report.gaps)
            self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")

    def test_preimage_digest_mutation_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            final_path = root / FINAL_PATH
            final = json.loads(final_path.read_text(encoding="utf-8"))
            final[NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD] = _digest("f")
            final_path.write_bytes(_raw(final))
            with self.assertRaises(NonSharedReplayError):
                replay_nonshared_operator(root, sample_index=SAMPLE)

    def test_preimage_bytes_mutation_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            preimage_path = root / PREIMAGE_PATH
            preimage_path.write_bytes(
                preimage_path.read_bytes().replace(
                    b"frequency_domain_operator_diagnostics.v1",
                    b"frequency_domain_operator_diagnostics.v2",
                )
            )
            with self.assertRaises(NonSharedReplayError):
                replay_nonshared_operator(root, sample_index=SAMPLE)

    def test_operator_input_digest_binding_is_rejected_after_consistent_rehash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            _rewrite_native_input_diagnostics(
                root,
                lambda value: value.__setitem__("operator_diagnostics_sha256", _digest("f")),
            )
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("native input diagnostics", str(context.exception))

    def test_base_diagnostics_sha_format_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            _rewrite_native_input_diagnostics(
                root,
                lambda value: value.__setitem__("operator_diagnostics_sha256", "not-a-sha256-token"),
            )
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("operator_diagnostics_sha256", str(context.exception))

    def test_external_raw_reference_is_required_for_published_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            (root / SOLVER_PATH).unlink()
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("external raw reference", str(context.exception))

    def test_multi_k_solver_diagnostics_selects_requested_sample(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            solver = json.loads((root / SOLVER_PATH).read_text(encoding="utf-8"))
            refs_three = solver["nonshared_floquet_native_input_diagnostics_exact_refs"]
            refs_zero = copy.deepcopy(refs_three)
            refs_zero["sample_index"] = 0
            for ref_name in ("payload", "preimage"):
                refs_zero[ref_name]["sample_index"] = 0
                refs_zero[ref_name]["path"] = refs_zero[ref_name]["path"].replace(
                    "sample_0003", "sample_0000"
                )
            _write(
                root,
                SOLVER_PATH,
                _raw(
                    {
                        "sample_solver_diagnostics": [
                            {"sample_index": 0, "diagnostics": {"nonshared_floquet_native_input_diagnostics_exact_refs": refs_zero}},
                            {"sample_index": SAMPLE, "diagnostics": {"nonshared_floquet_native_input_diagnostics_exact_refs": refs_three}},
                        ]
                    }
                ),
            )
            report = replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("native_input_diagnostics", report.exact_refs_verified)

    def test_missing_final_payload_with_preimage_or_external_ref_is_rejected(self) -> None:
        for remove_preimage in (True, False):
            with self.subTest(remove_preimage=remove_preimage), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                _bundle(root)
                _write_native_input_diagnostics(root)
                (root / FINAL_PATH).unlink()
                if remove_preimage:
                    (root / PREIMAGE_PATH).unlink()
                with self.assertRaises(NonSharedReplayError) as context:
                    replay_nonshared_operator(root, sample_index=SAMPLE)
                self.assertIn("final payload is missing", str(context.exception))

    def test_missing_preimage_is_rejected_for_published_final_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _write_native_input_diagnostics(root)
            (root / PREIMAGE_PATH).unlink()
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("preimage path", str(context.exception))

    def test_historical_absence_remains_explicit_not_verified_gap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            report = replay_nonshared_operator(root, sample_index=SAMPLE)
            self.assertIn("native_input_diagnostics_not_published", report.gaps)
            self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")
            self.assertNotIn("native_input_diagnostics", report.exact_refs_verified)


if __name__ == "__main__":
    unittest.main()
