"""Interpreted native qualification integration; no native or Docker execution."""
import contextlib
import hashlib
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
import backend_native_contracts as native_contracts
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

    def test_native_contract_success_reaches_publication_with_valid_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            build_root = root / "build"
            build_root.mkdir()
            control = backend._ensure_package_development_root(package)
            candidate = control / backend.PACKAGE_CANDIDATES_DIRNAME / ".backend-package-candidate-native-contract"
            candidate.mkdir()
            backend._write_candidate_marker(candidate, package, build_root, state="building")
            workspace = root / "workspace"
            workspace.mkdir()
            manifest = root / "manifest.json"
            manifest.write_bytes(b"native contract integration fixture")
            source_snapshot = "a" * 64
            native = {
                "source_snapshot_sha256": source_snapshot,
                "head_commit_full": "b" * 40,
                "source_snapshot_dirty": False,
            }
            capsule = {
                "source_digest": "c" * 64,
                "resolved_commit": "b" * 40,
                "files": [],
                "deleted": [],
            }
            native_root = root / "native-build"
            environment = {"FULLMAG_FEM_NATIVE_BUILD_ROOT": str(native_root)}
            package_library = candidate / native_contracts.PACKAGE_LIBRARY_ARTIFACT_PATH
            make_log_bytes = b"mocked canonical Make success\n"
            reports = []

            def fake_make(_command, _workspace, make_environment, log_path):
                install_root = Path(make_environment["FULLMAG_INTERNAL_INSTALL_ROOT"])
                for relative in backend.REQUIRED_PACKAGE_PATHS:
                    if relative in backend.RUNTIME_MANIFEST_PATHS:
                        continue
                    path = install_root.joinpath(*relative.split("/"))
                    path.parent.mkdir(parents=True, exist_ok=True)
                    content = b"cuda-fem-gpu\n" if relative == "launcher-build-mode" else b"package fixture\n"
                    path.write_bytes(content)
                    if relative.startswith("bin/"):
                        path.chmod(0o755)
                library_root = install_root / "lib"
                library_root.mkdir(parents=True, exist_ok=True)
                (library_root / "libfullmag_fdm.so.1").write_bytes(b"FDM package library fixture")
                (library_root / "libfullmag_fem.so.1").write_bytes(b"FEM package library fixture")
                (library_root / "libfullmag_fem.so").symlink_to("libfullmag_fem.so.1")
                log_path.write_bytes(make_log_bytes)
                return 0

            def fake_run_contracts(**kwargs):
                self.assertEqual(kwargs["requested"], GATES)
                self.assertEqual(kwargs["package_root"], candidate)
                library_sha256 = hashlib.sha256(package_library.read_bytes()).hexdigest()
                attempt_id = "d" * 32
                test_binary_sha256 = "e" * 64
                report = {
                    "schema": native_contracts.SCHEMA,
                    "contract_revision": native_contracts.CONTRACT_REVISION,
                    "state": "succeeded",
                    "source_snapshot_sha256": source_snapshot,
                    "requested": list(GATES),
                    "attempt_id": attempt_id,
                    "evidence": {
                        "log_sha256": "f" * 64,
                        "log_size_bytes": 1,
                        "log_path": f"attempt-{attempt_id}/native-contract.log",
                        "report_path": f"attempt-{attempt_id}/report.json",
                    },
                    "contracts": {
                        GATES[0]: {
                            "contract_revision": native_contracts.CONTRACT_REVISION,
                            "state": "passed",
                            "compile": {
                                "state": "succeeded",
                                "exit_code": 0,
                                "argv": [
                                    "cmake", "--build", str(native_root), "--target",
                                    native_contracts.TEST_BINARY_RELATIVE_PATH.name,
                                    "--parallel", "2",
                                ],
                                "duration_seconds": 0.001,
                            },
                            "test": {
                                "state": "succeeded",
                                "exit_code": 0,
                                "argv": [str(native_root / native_contracts.TEST_BINARY_RELATIVE_PATH)],
                                "duration_seconds": 0.001,
                            },
                            "test_binary": {
                                "path": native_contracts.TEST_BINARY_RELATIVE_PATH.as_posix(),
                                "sha256_before": test_binary_sha256,
                                "sha256_after": test_binary_sha256,
                            },
                            "libraries": {
                                "build": {
                                    "path": native_contracts.BUILD_LIBRARY_RELATIVE_PATH.as_posix(),
                                    "sha256": library_sha256,
                                },
                                "package": {
                                    "path": native_contracts.PACKAGE_LIBRARY_ARTIFACT_PATH,
                                    "sha256": library_sha256,
                                },
                            },
                        }
                    },
                }
                reports.append(report)
                return report

            args = backend.argparse.Namespace(
                source_tar=None,
                manifest=manifest,
                source_root=root / "source",
                git_common_root=root / "git-common",
                native_contract=list(GATES),
            )
            errors = io.StringIO()
            publish_completed_build = backend._publish_completed_build

            def publish(*publish_args, **kwargs):
                self.assertEqual(kwargs["native_contract_report"], reports[0])
                self.assertIn(
                    "backend-dev: phase=native-contract state=complete",
                    errors.getvalue(),
                )
                return publish_completed_build(*publish_args, **kwargs)

            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.dict(
                    os.environ,
                    {
                        "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                        "FULLMAG_PRIVATE_GROUP_STORAGE": "",
                    },
                    clear=False,
                ),
                patch.object(
                    backend,
                    "_materialize_source",
                    return_value=(workspace, capsule, native, "1" * 64, None, "snapshot"),
                ),
                patch.object(backend, "_build_environment", return_value=environment),
                patch.object(backend, "_run_canonical_make", side_effect=fake_make),
                patch.object(native_contracts, "run_contracts", side_effect=fake_run_contracts),
                patch.object(backend, "_publish_completed_build", side_effect=publish),
                contextlib.redirect_stderr(errors),
            ):
                self.assertEqual(
                    backend._prepare_locked(
                        args, build_root, candidate, 2, {}, candidate
                    ),
                    0,
                )

            self.assertEqual(len(reports), 1)
            self.assertTrue(
                native_contracts.receipt_satisfies(
                    reports[0],
                    requested=GATES,
                    source_snapshot_sha256=source_snapshot,
                    package_root=candidate,
                )
            )
            receipt, _ = backend._read_json(
                candidate / "backend-build-receipt.json",
                "native contract integration build receipt",
            )
            self.assertEqual(receipt["state"], "succeeded")
            self.assertEqual(receipt["native_contracts"], reports[0])

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
