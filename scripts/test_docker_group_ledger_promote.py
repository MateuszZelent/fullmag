"""Interpreted group-migration promotion and canonical rollback regressions."""
import ast
from contextlib import contextmanager, ExitStack
from copy import deepcopy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import docker_group_ledger_promote as promotion
import docker_group_ledger_bootstrap as boot
from test_docker_group_ledger_bootstrap import request_fixture


def evidence_fixture():
    original, _, _ = request_fixture()
    bootstrap_root = boot.CONTROL / "group-ledger-bootstrap/attempts" / original["request_id"]
    root = boot.CONTROL / "group-ledger-relocation/attempts" / ("9" * 32)
    program = {"image_id": "sha256:" + "a" * 64, "package_volume": "shared-package", "package_subpath": "groups/" + "b" * 64,
        "candidate": "/opt/fullmag/package/.development/candidates/.backend-package-candidate-demo",
        "receipt_sha256": "d" * 64, "cli_sha256": "c" * 64}
    inspection = {"host_id": "h" * 64, "schema_version": "fullmag.group-ledger-relocation-inspection.v1"}
    preview = {"schema_version": "fullmag.group-ledger-relocation-preview.v1", "status": "verified",
               "expected_inspection_sha256": boot.digest(boot.canonical(inspection)), "inspection": inspection}
    terminal = {"schema": "fullmag.docker-build-operation.v1", "phase": "group-ledger-bootstrap", "state": "succeeded",
        "compose_project": original["compose_project"], "bootstrap_backend_container": "b" * 64,
        "bootstrap_started_at": "bootstrap-start", "bootstrap_exit_code": 0,
        "source_group_ledger": {"volume_name": "legacy-ledger", "host_id": inspection["host_id"]}}
    result = {"schema": boot.SCHEMA, "state": "candidate-ready", "candidate": program["candidate"],
        "candidate_receipt_sha256": program["receipt_sha256"], "candidate_cli_sha256": program["cli_sha256"],
        "source": {"resolved_commit": original["source_commit"]}, "request_sha256": boot.digest(boot.canonical(original)),
        "package_promoted": False, "runtime_started": False}
    relocation = {"schema": "fullmag.group-ledger-relocation.v1", "compose_project": original["compose_project"],
        "control_volume": original["control_volume"], "source_root": original["source_root"],
        "source_commit": original["source_commit"], "logical_root": "/host-ledger/ledger", "target_subpath": "private/ledger",
        "source_volume": "legacy-ledger", "host_id": inspection["host_id"], "native_program": program,
        "expected_inspection": inspection, "bootstrap": {"terminal_path": str((bootstrap_root / "terminal.json").relative_to(boot.CONTROL)),
            "terminal_sha256": boot.digest(boot.canonical(terminal)),
            "result_path": str((bootstrap_root / "result.json").relative_to(boot.CONTROL)),
            "result_sha256": boot.digest(boot.canonical(result)), "container_id": "b" * 64, "started_at": "bootstrap-start"}}
    receipt = {"schema": relocation["schema"], "state": "verified", "runtime_started": False, "solve_started": False,
               "request": relocation, "source_inspection": inspection, "target_preview": preview}
    raw = {str(bootstrap_root / "request.json"): boot.canonical(original), str(bootstrap_root / "terminal.json"): boot.canonical(terminal),
           str(bootstrap_root / "result.json"): boot.canonical(result), str(root / "relocation.json"): boot.canonical(receipt) + b"\n",
           str(root / "source-inspection.json"): boot.canonical(inspection)}
    request = {"schema": promotion.SCHEMA, "request_id": "f" * 32, "compose_project": original["compose_project"],
        "control_volume": original["control_volume"], "source_root": original["source_root"],
        "bootstrap_request": {"path": str(bootstrap_root / "request.json"), "sha256": boot.digest(boot.canonical(original))},
        "relocation_receipt": {"path": str(root / "relocation.json"), "sha256": boot.digest(boot.canonical(receipt))},
        "provenance_sha256": "a" * 64, "promote_script_sha256": "b" * 64,
        "result_path": str(boot.CONTROL / "group-ledger-promote/attempts" / ("f" * 32) / "result.json")}
    return request, original, receipt, raw


class PromotionTests(unittest.TestCase):
    def test_closed_request_and_linked_verified_receipts(self):
        request, original, receipt, raw = evidence_fixture()
        promotion.validate_request(request)
        with patch.object(boot, "regular", side_effect=lambda path: raw[str(path)]):
            observed = promotion.evidence(request)
            self.assertEqual(observed[:2], (original, receipt))
        with self.assertRaises(ValueError): promotion.validate_request(dict(request, extra=True))
        with self.assertRaises(ValueError): promotion.validate_request(dict(request, result_path="/tmp/result"))

    def test_rehashed_nonverified_runtime_started_or_wrong_target_is_refused(self):
        for key, value in (("state", "copying"), ("runtime_started", True), ("solve_started", True)):
            request, _, receipt, raw = evidence_fixture()
            receipt[key] = value
            raw[request["relocation_receipt"]["path"]] = boot.canonical(receipt)
            request["relocation_receipt"]["sha256"] = boot.digest(boot.canonical(receipt))
            with self.subTest(key=key), patch.object(boot, "regular", side_effect=lambda path: raw[str(path)]), self.assertRaises(ValueError):
                promotion.evidence(request)
        request, _, receipt, raw = evidence_fixture()
        receipt["request"]["target_subpath"] = "foreign/ledger"
        raw[request["relocation_receipt"]["path"]] = boot.canonical(receipt)
        request["relocation_receipt"]["sha256"] = boot.digest(boot.canonical(receipt))
        with patch.object(boot, "regular", side_effect=lambda path: raw[str(path)]), self.assertRaises(ValueError): promotion.evidence(request)

    def test_native_preview_uses_exact_target_program_and_expected_source_bytes(self):
        _, _, receipt, _ = evidence_fixture()
        expected = receipt["target_preview"]
        def run(argv, **kwargs):
            self.assertIn("ledger-relocation-preview", argv)
            self.assertEqual(argv[argv.index("--ledger-root") + 1], "/host-ledger/ledger")
            self.assertEqual(argv[argv.index("--expected-inspection-sha256") + 1], "a" * 64)
            self.assertEqual(kwargs["env"]["LD_LIBRARY_PATH"], "/candidate/lib")
            return SimpleNamespace(returncode=0, stdout=boot.canonical(expected), stderr=b"")
        with patch.object(promotion.subprocess, "run", side_effect=run):
            self.assertEqual(promotion.native_preview(Path("/candidate"), receipt, Path("/inspection"), "a" * 64), expected)
        with patch.object(promotion.subprocess, "run", return_value=SimpleNamespace(returncode=2, stdout=b"", stderr=b"rejected")):
            with self.assertRaises(ValueError): promotion.native_preview(Path("/candidate"), receipt, Path("/inspection"), "a" * 64)

    def physical_rotation(self, fail_publish=False):
        from test_docker_backend_dev import BackendPackageTests, backend
        fixture = BackendPackageTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            request, original, receipt, _ = evidence_fixture()
            env = {"FULLMAG_COMPOSE_PROJECT": request["compose_project"], "FULLMAG_BUILD_CONTROL_VOLUME": request["control_volume"],
                   "FULLMAG_SOURCE_HOST_ROOT": request["source_root"], "FULLMAG_DOCKER_ROLE": "backend",
                   "FULLMAG_RUNTIME_IMAGE_ID": receipt["request"]["native_program"]["image_id"]}
            stack.enter_context(patch.dict(os.environ, env))
            package, build_root, control, candidate, current, incoming_bytes = fixture._ready_rotation_fixture(root, ".backend-package-candidate-promote")
            incoming = backend._validated_package(candidate, "fixture candidate", exclude_candidate_marker=True)
            backend._write_candidate_marker(candidate, package, Path("/build"), state="ready", records=incoming[0]["artifacts"])
            program = receipt["request"]["native_program"]
            program["receipt_sha256"] = boot.digest(incoming_bytes)
            program["cli_sha256"] = backend._sha256_file(candidate / "bin/fullmag-bin", "fixture CLI", package_artifact=True)[0]
            backend.PROVENANCE_PATH.parent.mkdir(parents=True, exist_ok=True)
            backend.PROVENANCE_PATH.write_bytes(backend._canonical({"old": "provenance"}))
            request["provenance_sha256"] = boot.digest(backend.PROVENANCE_PATH.read_bytes())
            request["promote_script_sha256"] = boot.digest(Path(promotion.__file__).read_bytes())
            request["result_path"] = str(root / "result.json")
            @contextmanager
            def guards(*_): yield lambda: None
            def publish(_):
                if fail_publish: raise OSError("publication fixture failure")
                backend.PROVENANCE_PATH.write_bytes(boot.canonical({"image_id": program["image_id"],
                    "build_receipt_sha256": program["receipt_sha256"], "commit": original["source_commit"],
                    "source_snapshot_sha256": original["source_snapshot_sha256"]}))
            real_lock = backend._runtime_build_lock
            stack.enter_context(patch.object(backend, "PACKAGE_ROOT", package))
            stack.enter_context(patch.object(backend, "_runtime_build_lock", side_effect=lambda _: real_lock(build_root)))
            stack.enter_context(patch.object(backend, "_publish_runtime_provenance", side_effect=publish))
            stack.enter_context(patch.object(promotion, "evidence", return_value=(original, receipt, candidate, root / "inspection", "a" * 64)))
            stack.enter_context(patch.object(promotion, "native_preview", return_value=receipt["target_preview"]))
            real_read_text = Path.read_text
            stack.enter_context(patch.object(Path, "read_text", autospec=True,
                side_effect=lambda path, *args, **kwargs: "mountinfo" if str(path) == "/proc/self/mountinfo"
                    else real_read_text(path, *args, **kwargs)))
            for name, effect in {"check_mounts": lambda _: None, "runtime_guards": guards,
                "check_native_aliases": lambda *_: None, "read_records": lambda _: None, "no_native_processes": lambda: None,
                "capture": lambda *_: None, "package_pin": lambda *_: current, "safe_path": lambda value: Path(value)}.items():
                stack.enter_context(patch.object(boot, name, side_effect=effect))
            runtime = SimpleNamespace(canonical_paths=lambda: None)
            if fail_publish:
                with self.assertRaisesRegex(OSError, "publication fixture failure"):
                    promotion.promote(request, backend, runtime)
                self.assertEqual((package / "backend-build-receipt.json").read_bytes(), current[1])
                self.assertEqual(backend.PROVENANCE_PATH.read_bytes(), backend._canonical({"old": "provenance"}))
                self.assertTrue(candidate.exists())
                self.assertFalse((root / "result.json").exists())
            else:
                result = promotion.promote(request, backend, runtime)
                self.assertEqual((package / "backend-build-receipt.json").read_bytes(), incoming_bytes)
                self.assertEqual((Path(result["rollback_package"]) / "backend-build-receipt.json").read_bytes(), current[1])
                self.assertFalse(candidate.exists())
                self.assertFalse((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).exists())
                self.assertTrue(result["package_promoted"])
                self.assertFalse(result["runtime_started"])

    def test_actual_canonical_rotation_preserves_current_as_rollback(self):
        self.physical_rotation()

    def test_failed_publication_restores_package_and_provenance(self):
        self.physical_rotation(fail_publish=True)

    def test_promotion_contains_no_build_or_runtime_start(self):
        tree = ast.parse(Path(promotion.__file__).read_text())
        calls = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertIn("_rotate_package", calls)
        self.assertIn("_finalize_published_candidate", calls)
        self.assertFalse(calls & {"_prepare_locked", "_prepare_with_shared_package", "_serve", "prepare_storage",
                                  "initialize_host_configuration", "ensure_configuration"})


if __name__ == "__main__":
    unittest.main()
