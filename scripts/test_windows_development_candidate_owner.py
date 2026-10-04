"""Interpreted checks for the sealed candidate owner authority boundary."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_windows_development_restore_launch import _write_candidate
from windows import development_handoff as capsule
from windows import validate_candidate_owner as owner


class CandidateOwnerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Path(temp.name) / "storage"
        self.runtime = self.store / "runtimes" / "fixture"
        self.runtime.mkdir(parents=True)
        self.root, self.manifest = _write_candidate(self.runtime)
        self.layout = {"storage_root": str(self.store), "worktree_id": "fixture"}
        patched = patch.object(owner.restore, "_verified_workspace", return_value=(self.layout, self.runtime))
        patched.start()
        self.addCleanup(patched.stop)
        self.request = {"schema": owner.REQUEST_SCHEMA, "storage_root": str(self.store),
                        "worktree_id": "fixture", "candidate_bundle_root": str(self.root),
                        "candidate_manifest_sha256": self.digest()}

    def digest(self):
        return hashlib.sha256((self.root / "manifest.json").read_bytes()).hexdigest()

    def validate(self):
        return owner.validate_request("fixture-repo", self.request)

    def test_valid_candidate_returns_its_build_identity_without_mutation(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        ack = self.validate()
        self.assertEqual(ack["git_commit"], "a" * 40)
        self.assertEqual(ack["source_snapshot_sha256"], "d" * 64)
        self.assertEqual(ack["candidate_manifest_sha256"], self.digest())
        self.assertEqual(ack["candidate_bundle_id"], self.root.name)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_wrong_manifest_digest_is_rejected(self):
        self.request["candidate_manifest_sha256"] = "0" * 64
        with self.assertRaises(capsule.HandoffError): self.validate()

    def test_windows_extended_path_is_the_same_verified_candidate(self):
        if os.name != "nt":
            self.skipTest("Windows extended paths")
        self.request["candidate_bundle_root"] = "\\\\?\\" + str(self.root)
        self.assertEqual(self.validate()["candidate_bundle_id"], self.root.name)

    def test_foreign_worktree_is_rejected(self):
        self.request["worktree_id"] = "other"
        with self.assertRaises(capsule.HandoffError): self.validate()

    def test_foreign_storage_is_rejected(self):
        foreign = self.store.parent / "foreign"
        foreign.mkdir()
        self.request["storage_root"] = str(foreign)
        with self.assertRaises(capsule.HandoffError): self.validate()

    def test_altered_api_binary_is_rejected(self):
        (self.root / "bin" / "fullmag-api.exe").write_bytes(b"changed executable")
        with self.assertRaises(capsule.HandoffError): self.validate()

    def test_manifest_authority_constraints(self):
        for field, value in (("workspace_namespace", "other"), ("target_triple", "x86_64-unknown-linux-gnu"),
                             ("compiler_profile", "release")):
            with self.subTest(field=field):
                original = self.manifest["source"][field]
                self.manifest["source"][field] = value
                (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
                self.request["candidate_manifest_sha256"] = self.digest()
                with self.assertRaises(capsule.HandoffError): self.validate()
                self.manifest["source"][field] = original

    def test_unknown_request_fields_are_rejected(self):
        self.request["owner_token"] = "untrusted"
        with self.assertRaises(capsule.HandoffError): self.validate()

    def test_invalid_product_version_is_rejected(self):
        self.manifest["source"]["build_version"]["product_version"] = "../escape"
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        self.request["candidate_manifest_sha256"] = self.digest()
        with self.assertRaises(capsule.HandoffError): self.validate()
