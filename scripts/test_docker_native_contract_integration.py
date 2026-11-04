"""Interpreted native qualification integration; no native or Docker execution."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_docker_backend_dev as fixtures
import backend_dev as backend
import docker_dev
import docker_volume_dev as volume

GATES = ("fem-demag-poisson",)


class NativeContractIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.BackendPackageTests(methodName="runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_current_ungated_package_cannot_bypass_requested_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self.fixture._published_package(root)
            manifest_path, manifest = self.fixture._live_manifest(root)
            toolchain = self.fixture._toolchain_fixture()
            backend._write_json(package / "backend-build-receipt.json",
                self.fixture._receipt_for_manifest(records, manifest, toolchain), "fixture receipt")
            before = (package / "lib/libfullmag_fem.so.1").read_bytes()
            errors = io.StringIO()
            with (patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                                          "FULLMAG_SHARED_BACKEND_STORE": "", "FULLMAG_PRIVATE_GROUP_STORAGE": ""}),
                  patch.object(backend, "PACKAGE_ROOT", package),
                  patch.object(backend, "_toolchain_identity", return_value=(toolchain["image_id"], toolchain)),
                  patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                  patch.object(backend, "_preflight_candidate_storage"),
                  patch.object(backend, "_prepare_locked", side_effect=backend.BackendBuildError("qualification build required")) as prepare,
                  patch.object(backend, "_rotate_package") as rotate,
                  patch.object(backend, "_serve") as serve,
                  contextlib.redirect_stderr(errors), contextlib.redirect_stdout(io.StringIO())):
                self.assertEqual(backend.main(["start", "--build-root", str(build_root),
                                               "--native-contract", GATES[0]]), 2)
            self.assertIn("qualification build required", errors.getvalue())
            prepare.assert_called_once()
            self.assertEqual(backend._requested_native_contracts(prepare.call_args.args[0]), GATES)
            rotate.assert_not_called()
            serve.assert_not_called()
            self.assertEqual((package / "lib/libfullmag_fem.so.1").read_bytes(), before)

    def test_ready_candidate_classification_carries_required_gate(self):
        spec = SimpleNamespace(receipt={"fixture": True}, artifacts=[{"path": "library"}], candidate=Path("/candidate"))
        result = SimpleNamespace(action="promote", candidate=spec.candidate)
        with (patch.object(backend, "_package_matches_fresh_live_manifest", return_value=True) as matches,
              patch.object(backend.candidate_retirement, "retire_candidate", return_value=result) as retire):
            selected = backend._classify_ready_candidate_retirements(
                [spec], Path("/manifest"), {}, "backend-dev", None, required_native_contracts=GATES)
        self.assertIs(selected, spec)
        self.assertEqual(matches.call_args.kwargs["required_native_contracts"], GATES)
        self.assertEqual(retire.call_args.kwargs["required_native_contracts"], GATES)

    def test_fresh_candidate_without_native_proof_cannot_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self.fixture._published_package(root)
            manifest_path, manifest = self.fixture._live_manifest(root)
            toolchain = self.fixture._toolchain_fixture()
            backend._write_json(package / "backend-build-receipt.json",
                self.fixture._receipt_for_manifest(records, manifest, toolchain), "fixture receipt")

            def prepare(*args):
                candidate = args[2]
                workspace = self.fixture._package_workspace(root / "fresh")
                fresh_records = self.fixture._copy_into_marked_candidate(workspace, candidate, package, args[1])
                backend._write_json(candidate / "backend-build-receipt.json",
                    self.fixture._receipt_for_manifest(fresh_records, manifest, toolchain), "unqualified fixture candidate")
                return 0

            errors = io.StringIO()
            with (patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                                          "FULLMAG_SHARED_BACKEND_STORE": "", "FULLMAG_PRIVATE_GROUP_STORAGE": ""}),
                  patch.object(backend, "PACKAGE_ROOT", package),
                  patch.object(backend, "_toolchain_identity", return_value=(toolchain["image_id"], toolchain)),
                  patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                  patch.object(backend, "_preflight_candidate_storage"),
                  patch.object(backend, "_prepare_locked", side_effect=prepare),
                  patch.object(backend, "_rotate_package") as rotate,
                  patch.object(backend, "_serve") as serve,
                  contextlib.redirect_stderr(errors), contextlib.redirect_stdout(io.StringIO())):
                self.assertEqual(backend.main(["start", "--build-root", str(build_root),
                                               "--native-contract", GATES[0]]), 2)
            self.assertIn("candidate does not satisfy requested native contract", errors.getvalue())
            rotate.assert_not_called()
            serve.assert_not_called()

    def test_shared_cache_identity_separates_required_native_contracts(self):
        capsule = {"resolved_commit": "a" * 40}
        with (patch.object(backend, "_read_json", return_value=({}, b"{}")),
              patch.object(backend, "_validate_live_manifest", return_value=(capsule, {}, None, None)),
              patch.object(backend, "_runtime_source_digest", return_value="b" * 64),
              patch.object(backend, "_sha256_file", return_value=("c" * 64, None))):
            legacy = backend._shared_package_identity(Path("/manifest"), {}, None)
            qualified = backend._shared_package_identity(Path("/manifest"), {}, None, required_native_contracts=GATES)
        self.assertNotIn("native_contracts", legacy)
        self.assertEqual(qualified["native_contracts"], list(GATES))
        self.assertIn("backend_native_contracts.py", qualified["builder_helpers"])
        self.assertNotEqual(legacy, qualified)

    def test_missing_native_attestation_short_circuits_cache_match(self):
        with patch.object(backend, "_read_json") as read:
            self.assertFalse(backend._package_matches_fresh_live_manifest(
                {"source": {}, "artifacts": []}, Path("/manifest"), {}, "backend-dev", required_native_contracts=GATES))
        read.assert_not_called()

    def test_command_and_retained_inputs_pin_exact_gate(self):
        service = {"command": ["start", "--source-root", "/opt/fullmag/source"]}
        volume._pin_native_contract_command(service, GATES)
        document = {"services": {"backend": service}}
        previous = {"inputs": {"native_contracts": list(GATES)}}
        self.assertEqual(volume._retained_native_contracts(previous, document), GATES)
        with self.assertRaises(volume.BuildControlError):
            volume._retained_native_contracts({"inputs": {}}, document)
        with self.assertRaises(volume.BuildControlError):
            volume._pin_native_contract_command(service, GATES)

    def test_empty_request_preserves_legacy_command_and_inputs(self):
        service = {"command": ["start", "--source-root", "/opt/fullmag/source"]}
        before = list(service["command"])
        volume._pin_native_contract_command(service, ())
        self.assertEqual(service["command"], before)
        self.assertEqual(volume._retained_native_contracts({"inputs": {}}, {"services": {"backend": service}}), ())
        self.assertTrue(backend._native_contract_receipt_matches({}, ()))

    def test_unknown_duplicate_and_noncanonical_contracts_are_rejected(self):
        for values in (["arbitrary-target"], [GATES[0], GATES[0]], "fem-demag-poisson", [None]):
            with self.subTest(values=values), self.assertRaises(volume.BuildControlError):
                volume._native_contracts(values)
        document = {"services": {"backend": {"command": ["start", "--native-contract=" + GATES[0]]}}}
        with self.assertRaises(volume.BuildControlError):
            volume._retained_native_contracts({"inputs": {"native_contracts": list(GATES)}}, document)

    def test_launcher_and_backend_only_accept_allowlisted_contract(self):
        args = docker_dev._parser().parse_args(["up", "--native-contract", GATES[0]])
        self.assertEqual(tuple(args.native_contract), GATES)
        args = backend._parser().parse_args(["start", "--native-contract", GATES[0]])
        self.assertEqual(backend._requested_native_contracts(args), GATES)
        for parser, action in ((docker_dev._parser(), "up"), (backend._parser(), "start")):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parser.parse_args([action, "--native-contract", "arbitrary-target"])


if __name__ == "__main__":
    unittest.main()
