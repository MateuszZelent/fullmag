"""Tests for the bounded Linux storage capability probe."""

from __future__ import annotations

import errno
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import storage_capabilities as capabilities


class StorageCapabilityPolicyTests(unittest.TestCase):
    def test_roles_are_closed(self):
        with self.assertRaises(ValueError):
            capabilities.probe(tempfile.gettempdir(), "gpu")

    def test_require_target_rejects_relative_root(self):
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.require_target("relative-storage")

    def test_require_target_rejects_filesystem_root(self):
        root = Path(Path.cwd().anchor)
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.require_target(root)

    def test_allowed_root_requires_strict_descendant(self):
        with tempfile.TemporaryDirectory() as temporary:
            allowed = Path(temporary).resolve()
            child = allowed / "child"
            child.mkdir()
            self.assertEqual(child, capabilities.require_target(child, allowed))
            with self.assertRaises(capabilities.CapabilityError):
                capabilities.require_target(allowed, allowed)

    def test_probe_reports_invalid_target_without_receipt_bypass(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / "missing"
            report = capabilities.probe(missing, "artifact")
        self.assertEqual(capabilities.SCHEMA, report["schema"])
        self.assertEqual("artifact", report["role"])
        self.assertEqual("failed", report["state"])
        self.assertEqual("NOT VERIFIED", report["qualification"])
        self.assertTrue(report["errors"])
        self.assertNotIn("receipt", report)

    def test_report_evaluator_checks_evidence_and_does_not_allow_v9fs_blindly(self):
        report = {
            "schema": capabilities.SCHEMA,
            "role": "build",
            "root": "/probe",
            "fingerprint": {
                "before": {
                    "target": "/probe",
                    "source": "//host/c",
                    "fstype": "v9fs",
                    "options": "rw",
                    "stat_device": 7,
                },
                "after": {
                    "target": "/probe",
                    "source": "//host/c",
                    "fstype": "v9fs",
                    "options": "rw",
                    "stat_device": 7,
                },
                "stable": True,
            },
            "checks": {
                name: {"status": "PASS"}
                for name in capabilities.ROLE_CHECKS["build"]
            },
            "errors": [],
            "state": "passed",
            "qualification": "NOT VERIFIED",
        }
        report["checks"]["case_sensitivity"] = {
            "status": "FAIL",
            "error": "distinct names resolve to one v9fs entry",
        }
        decision = capabilities.evaluate_capability_report(report)
        self.assertFalse(decision["accepted"])
        self.assertTrue(any("case_sensitivity" in item for item in decision["errors"]))

    def test_report_evaluator_requires_not_verified_qualification(self):
        report = {
            "schema": capabilities.SCHEMA,
            "role": "source",
            "root": "/probe",
            "fingerprint": {"stable": True},
            "checks": {"write_read_hash": {"status": "PASS"}},
            "errors": [],
            "state": "passed",
            "qualification": "PASS",
        }
        decision = capabilities.evaluate_capability_report(report)
        self.assertFalse(decision["accepted"])
        self.assertTrue(any("qualification" in item for item in decision["errors"]))

    def test_report_evaluator_compares_fingerprint_evidence(self):
        report = {
            "schema": capabilities.SCHEMA,
            "role": "source",
            "root": "/probe",
            "fingerprint": {
                "before": {"target": "/probe", "source": "s", "fstype": "v9fs", "options": "rw", "stat_device": 1},
                "after": {"target": "/probe", "source": "s", "fstype": "v9fs", "options": "rw", "stat_device": 2},
                "stable": True,
            },
            "checks": {"write_read_hash": {"status": "PASS"}},
            "errors": [],
            "state": "passed",
            "qualification": "NOT VERIFIED",
        }
        decision = capabilities.evaluate_capability_report(report)
        self.assertFalse(decision["accepted"])
        self.assertTrue(any("before/after" in item for item in decision["errors"]))

    def test_output_is_new_path_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            report = {"schema": capabilities.SCHEMA, "state": "failed"}
            capabilities.write_report(output, report)
            with self.assertRaises(capabilities.CapabilityError):
                capabilities.write_report(output, report)
            self.assertEqual(report, json.loads(output.read_text(encoding="utf-8")))

    def test_output_falls_back_to_exclusive_file_when_hardlinks_are_unavailable(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            report = {"schema": capabilities.SCHEMA, "state": "failed"}
            with patch.object(
                capabilities.os,
                "link",
                side_effect=OSError(errno.EOPNOTSUPP, "hard links unavailable"),
            ):
                capabilities.write_report(output, report)
            self.assertEqual(report, json.loads(output.read_text(encoding="utf-8")))

    def test_cli_writes_failure_report_on_windows_or_non_linux(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "root"
            root.mkdir()
            output = Path(temporary) / "report.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(capabilities.__file__).resolve()),
                    "--root",
                    str(root),
                    "--role",
                    "source",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(0 if sys.platform.startswith("linux") else 2, result.returncode)
            self.assertTrue(output.exists())
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(capabilities.SCHEMA, report["schema"])
            self.assertEqual("source", report["role"])


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux mount and subprocess contract")
class LinuxStorageCapabilityTests(unittest.TestCase):
    def test_flock_check_releases_lock_when_own_child_is_terminated(self):
        with tempfile.TemporaryDirectory() as temporary:
            scratch = Path(temporary).resolve()
            result = capabilities._check_flock(scratch)
        self.assertEqual("PASS", result["status"])
        self.assertTrue(result["terminated_child_released"])

    def test_probe_retains_unique_scratch_and_collects_role_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "probe-root"
            root.mkdir()
            report = capabilities.probe(root, "artifact")
            self.assertEqual(capabilities.SCHEMA, report["schema"])
            self.assertEqual("artifact", report["role"])
            self.assertTrue(report["scratch"])
            scratch = Path(report["scratch"])
            self.assertTrue(scratch.is_dir())
            self.assertTrue(scratch.parent == root)
            self.assertEqual(
                set(capabilities.ROLE_CHECKS["artifact"]),
                set(report["checks"]),
            )
            self.assertIn("benchmarks", report)
            self.assertIn("bytes", report["benchmarks"])
            self.assertIn("megabytes", report["benchmarks"])
            self.assertIn("elapsed_ms", report["benchmarks"])
            self.assertIn("before", report["fingerprint"])
            self.assertIn("after", report["fingerprint"])

    def test_build_probe_runs_all_checks_without_short_circuiting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "probe-root"
            root.mkdir()
            report = capabilities.probe(root, "build")
        self.assertEqual(set(capabilities.ROLE_CHECKS["build"]), set(report["checks"]))
        self.assertEqual("NOT VERIFIED", report["qualification"])
        for check in report["checks"].values():
            self.assertIn(check["status"], {"PASS", "FAIL"})

    def test_fingerprint_change_fails_closed_after_checks(self):
        first = {
            "target": "/tmp",
            "source": "overlay",
            "fstype": "overlay",
            "options": "rw",
            "stat_device": 1,
        }
        second = dict(first, stat_device=2)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "probe-root"
            root.mkdir()
            with patch.object(capabilities, "filesystem_fingerprint", side_effect=[first, second]):
                report = capabilities.probe(root, "source")
        self.assertEqual("failed", report["state"])
        self.assertFalse(report["fingerprint"]["stable"])
        self.assertTrue(any("fingerprint changed" in item for item in report["errors"]))

    def test_symlink_root_is_rejected_before_scratch_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            real = base / "real"
            real.mkdir()
            link = base / "link"
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"symlink unavailable: {error}")
            report = capabilities.probe(link, "source")
        self.assertEqual("failed", report["state"])
        self.assertIsNone(report["scratch"])
        self.assertTrue(any("symlink" in item.lower() for item in report["errors"]))


if __name__ == "__main__":
    unittest.main()
