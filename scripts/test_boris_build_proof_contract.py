"""Interpreted admission guards; synthetic bytes are never a BORIS build proof."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from run_boris_nf_interface import (_read_source_manifest, capture_runtime_identity,
    validate_runtime_identity, run_boris_case, SOURCE_MANIFEST_MAX_BYTES)
from verify_boris_nf_interface import validate_boris_artifact
from boris_nf_interface_smoke import NfCaseConfig

class BuildProofContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "BorisLin"
        self.binary.write_bytes(b"synthetic binary, not executed")
        self.binary.chmod(0o755)
        self.manifest = self.root / "source_manifest.json"
        self.manifest.write_text(json.dumps({"schema_version":"fullmag.boris.source.v1"}), encoding="utf-8")
        self.probe = dict(binary_version="BORIS fixture", python_version="3.10", device_detected="cpu", device_residency_evidence="synthetic")

    def test_legacy_identity_is_honest(self):
        value = capture_runtime_identity(self.root, "sha256:"+"a"*64, "cpu", runtime_probe=self.probe)
        self.assertFalse(value["identity_complete"])
        self.assertIsNone(value["precision"])
        self.assertEqual(value["build_proof_status"], "unverified")
        self.assertEqual(len(value["binary_sha256"]),64)
        with self.assertRaisesRegex(ValueError,"incomplete"):
            validate_runtime_identity(value)

    def test_caller_complete_cannot_promote_legacy(self):
        with self.assertRaisesRegex(ValueError,"verified managed build proof"):
            validate_runtime_identity({"schema_version":"fullmag.boris.runtime.v1", "identity_complete":True,"precision":"double"})

    def test_public_benchmark_rejects_forged_complete(self):
        (self.root/"summary.json").write_text(json.dumps({"schema_version":"fullmag.boris_she_nf.v1", "runtime":{"schema_version":"fullmag.boris.runtime.v1","identity_complete":True,"precision":"double"}}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"verified managed build proof"):
            validate_boris_artifact(self.root)

    def test_run_refuses_before_output_or_subprocess(self):
        output=self.root/"output"
        with patch("run_boris_nf_interface.subprocess.run") as process:
            with self.assertRaisesRegex(RuntimeError,"verified managed build proof"):
                run_boris_case(NfCaseConfig(output_dir=output),self.root,output,"cpu")
            process.assert_not_called()
        self.assertFalse(output.exists())

    def test_manifest_is_bounded_unique_utf8_object(self):
        for raw in [b"",b"[]",b"{\"a\":1,\"a\":2}",b"{\"a\":NaN}",b"\xff",b"x"*(SOURCE_MANIFEST_MAX_BYTES+1)]:
            with self.subTest(raw=raw[:20]):
                self.manifest.write_bytes(raw)
                with self.assertRaises(RuntimeError):
                    _read_source_manifest(self.manifest)

    def test_v2_caller_json_is_not_producer(self):
        self.manifest.write_text(json.dumps({"schema_version":"fullmag.boris.source.v2","precision":"double","identity_complete":True}),encoding="utf-8")
        output=self.root/"output"
        with patch("run_boris_nf_interface.subprocess.run") as process:
            with self.assertRaisesRegex(RuntimeError,"no supported managed build"):
                run_boris_case(NfCaseConfig(output_dir=output),self.root,output,"cpu")
            process.assert_not_called()
        self.assertFalse(output.exists())

if __name__ == "__main__":
    unittest.main()
