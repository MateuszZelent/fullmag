"""Interpreted candidate recovery checks; run in the managed backend container."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker" / "all-in-one"))
import backend_candidate_recovery as recovery
import backend_dev as backend
import test_docker_backend_dev as fixtures


@unittest.skipIf(os.name == "nt", "Linux backend filesystem contract")
class CandidateRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.package, self.build, self.development, self.source, workspace = fixtures.BackendPackageTests._direct_candidate_fixture(root)
        pins = patch.dict(os.environ, {"FULLMAG_RECOVERY_HELPER_SHA256": self.sha(Path(recovery.__file__)), "FULLMAG_RECOVERY_BACKEND_SHA256": self.sha(Path(backend.__file__))})
        pins.start()
        self.addCleanup(pins.stop)
        self.control = root / "control"
        self.control.mkdir()
        log = backend._begin_failed_make_attempt(self.build, self.source, "install-cli-dev")
        log.write_bytes((self.source / "direct-backend-build.log").read_bytes())
        backend._finish_failed_make_attempt(self.build, self.source, 0)
        records = backend._copy_package(workspace, self.source, direct_install=True, package_root=self.package, build_root=self.build)
        backend._write_json(self.source / "backend-build-receipt.json", {
            "schema": backend.RECEIPT_SCHEMA, "state": "succeeded",
            "execution_lanes": {lane: {"status": "compiled"} for lane in backend.LANES},
            "artifacts": records}, "fixture receipt")
        backend._write_candidate_marker(self.source, self.package, self.build, state="ready", records=records)
        self.request = {"schema": recovery.SCHEMA, "candidate_basename": self.source.name,
            "marker_sha256": self.sha(self.source / backend.PACKAGE_CANDIDATE_MARKER),
            "receipt_sha256": self.sha(self.source / "backend-build-receipt.json"),
            "make_attempt_sha256": self.sha(backend._failed_make_paths(self.build, self.source)[1])}
        self.destination = self.development / "quarantine" / self.source.name

    @staticmethod
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def run_recovery(self, apply=True):
        return recovery.recover(self.request, apply=apply, package=self.package, build=self.build, control=self.control)

    def test_dry_run_preserves_candidate(self):
        self.assertEqual(self.run_recovery(False)["state"], "dry-run")
        self.assertTrue(self.source.exists())
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.control.iterdir()), [])

    def test_success_preserves_bytes_and_retries(self):
        before = {p.relative_to(self.source).as_posix(): p.read_bytes() for p in self.source.rglob("*") if p.is_file()}
        first = self.run_recovery()
        self.assertFalse(self.source.exists())
        after = {p.relative_to(self.destination).as_posix(): p.read_bytes() for p in self.destination.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(first, self.run_recovery())

    def test_bad_pins(self):
        for key in ("marker_sha256", "receipt_sha256", "make_attempt_sha256"):
            with self.subTest(key=key):
                saved = self.request[key]
                self.request[key] = "0" * 64
                with self.assertRaises(backend.BackendBuildError):
                    self.run_recovery()
                self.request[key] = saved
        self.assertTrue(self.source.exists())

    def test_building_marker(self):
        backend._write_candidate_marker(self.source, self.package, self.build, state="building")
        self.request["marker_sha256"] = self.sha(self.source / backend.PACKAGE_CANDIDATE_MARKER)
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()

    def test_unknown_payload(self):
        (self.source / "unknown").write_bytes(b"preserve me")
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()
        self.assertTrue((self.source / "unknown").exists())

    def test_pending_rotation(self):
        (self.development / backend.PACKAGE_ROTATION_JOURNAL_NAME).write_text("{}")
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()

    def test_destination_collision(self):
        self.destination.mkdir(parents=True)
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()

    def test_retry_before_rename(self):
        with patch.object(recovery.os, "rename", side_effect=OSError("before rename")):
            with self.assertRaises(OSError):
                self.run_recovery()
        self.assertTrue(self.source.exists())
        self.assertEqual(self.run_recovery()["state"], "quarantined")

    def test_retry_after_rename(self):
        write = backend._write_json
        def fail_result(path, value, name):
            if path.name == "result.json":
                raise OSError("after rename")
            return write(path, value, name)
        with patch.object(backend, "_write_json", side_effect=fail_result):
            with self.assertRaises(OSError):
                self.run_recovery()
        self.assertTrue(self.destination.exists())
        self.assertEqual(self.run_recovery()["state"], "quarantined")

    def test_changed_artifact_same_size(self):
        binary = self.source / "bin/fullmag-api"
        binary.write_bytes(b"x" * binary.stat().st_size)
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()

    def test_foreign_marker(self):
        marker_path = self.source / backend.PACKAGE_CANDIDATE_MARKER
        marker = json.loads(marker_path.read_bytes())
        marker["package_root"] = "/foreign"
        backend._write_json(marker_path, marker, "fixture foreign marker")
        self.request["marker_sha256"] = self.sha(marker_path)
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()

    def test_relocated_candidate_needs_same_request(self):
        self.destination.parent.mkdir()
        self.source.rename(self.destination)
        with self.assertRaises(backend.BackendBuildError):
            self.run_recovery()


if __name__ == "__main__":
    unittest.main()
