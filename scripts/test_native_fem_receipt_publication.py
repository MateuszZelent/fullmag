#!/usr/bin/env python3
"""Regression checks for ordered native FEM receipt publication."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fullmag_storage as storage  # noqa: E402


class NativeFemReceiptPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        project = Path(self.temporary.name).resolve()
        self.repo = project / "fullmag"
        self.repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True)
        self.layout = storage.resolve_layout(
            self.repo, profile="windows-native-fem-gpu", environ={}
        )
        storage.initialize(self.layout)

    def _receipt(self, attempt_id, state="completed", execution_mode="windows-fem"):
        return {
            "schema": storage.WINDOWS_NATIVE_FEM_RECEIPT_SCHEMA,
            "worktree_id": self.layout["worktree_id"],
            "profile": self.layout["profile"],
            "repo_root": self.layout["repo_root"],
            "attempt_id": attempt_id,
            "execution_mode": execution_mode,
            "state": state,
            "exit_code": 0 if state == "completed" else 1,
            "started_at": f"{attempt_id}-started",
            "finished_at": f"{attempt_id}-finished",
        }

    def _write_status(self, receipt):
        status_path = Path(self.layout["build_root"]) / "build-status.json"
        storage.atomic_json(status_path, {
            "schema": storage.SCHEMA,
            "worktree_id": self.layout["worktree_id"],
            "profile": self.layout["profile"],
            "repo_root": self.layout["repo_root"],
            "attempt_id": receipt["attempt_id"],
            "execution_mode": receipt["execution_mode"],
            "state": receipt["state"],
            "exit_code": receipt["exit_code"],
            "build_manifest_sha256": receipt.get("build_manifest_sha256"),
        })

    def _read_alias(self):
        return json.loads(
            (Path(self.layout["runtime_root"]) / "native-fem-receipt.json")
            .read_text(encoding="utf-8")
        )

    def _read_attempt(self, attempt_id):
        return json.loads(
            storage._native_fem_receipt_attempt_path(self.layout, attempt_id)
            .read_text(encoding="utf-8")
        )

    def test_normal_flow_publishes_alias_and_per_attempt_evidence(self):
        receipt = self._receipt("a" * 32)
        self._write_status(receipt)

        self.assertTrue(storage._publish_native_fem_receipt(self.layout, receipt))
        self.assertEqual(self._read_alias()["attempt_id"], "a" * 32)
        self.assertEqual(self._read_attempt("a" * 32), receipt)

    def test_old_finalization_after_new_cannot_regress_alias(self):
        newer = self._receipt("b" * 32)
        self._write_status(newer)
        self.assertTrue(storage._publish_native_fem_receipt(self.layout, newer))

        older = self._receipt("a" * 32)
        self.assertFalse(storage._publish_native_fem_receipt(self.layout, older))
        self.assertEqual(self._read_alias()["attempt_id"], "b" * 32)
        self.assertEqual(self._read_attempt("a" * 32), older)

    def test_cross_attempt_without_current_authority_keeps_evidence_only(self):
        current = self._receipt("c" * 32, state="failed")
        self._write_status(current)
        stale = self._receipt("d" * 32)

        self.assertFalse(storage._publish_native_fem_receipt(self.layout, stale))
        self.assertFalse(
            (Path(self.layout["runtime_root"]) / "native-fem-receipt.json").exists()
        )
        self.assertEqual(self._read_attempt("d" * 32), stale)


    def test_same_attempt_metadata_mismatch_cannot_publish_alias(self):
        receipt = self._receipt("e" * 32)
        for field, value in (
            ("execution_mode", "windows-fem-build"),
            ("state", "failed"),
            ("exit_code", 1),
            ("build_manifest_sha256", "1" * 64),
        ):
            with self.subTest(field=field):
                status = dict(receipt)
                status[field] = value
                self._write_status(status)
                self.assertFalse(storage._publish_native_fem_receipt(self.layout, receipt))
        self.assertFalse(
            (Path(self.layout["runtime_root"]) / "native-fem-receipt.json").exists()
        )
        self.assertEqual(self._read_attempt("e" * 32), receipt)

    def test_same_attempt_different_receipt_is_rejected_without_overwrite(self):
        receipt = self._receipt("f" * 32)
        self._write_status(receipt)
        self.assertTrue(storage._publish_native_fem_receipt(self.layout, receipt))

        conflicting = dict(receipt, state="failed", exit_code=1)
        with self.assertRaisesRegex(storage.StorageError, "differs for the same attempt"):
            storage._publish_native_fem_receipt(self.layout, conflicting)
        self.assertEqual(self._read_attempt("f" * 32), receipt)
        self.assertEqual(self._read_alias(), receipt)


if __name__ == "__main__":
    unittest.main()
