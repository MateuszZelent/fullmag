"""Interpreted integrity regressions for managed runtime artifact binding."""
import hashlib
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import managed_runtime_artifact_root as resolver


class RuntimeArtifactRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.case = "de-smoke-k10"
        (self.root / self.case).mkdir()
        self.sha = "a" * 64
        self.run_id = "run-session-17"
        self.session_id = "session-17"
        self.workspace = self.root / f"{self.case}-{self.run_id}-0"
        (self.workspace / "artifacts").mkdir(parents=True)
        container = resolver.CONTAINER_ROOT + "/" + self.workspace.name
        self.summary = {"status": "completed", "backend": "fem", "mode": "strict", "precision": "double",
                        "workspace_dir": container, "artifact_dir": container + "/artifacts",
                        "run_id": self.run_id, "session_id": self.session_id}
        self.manifest = {"schema": "fullmag.run_manifest.v1", "status": "completed", "exit_code": 0,
                         "source": {"sha256": self.sha}, "run_id": self.run_id, "session_id": self.session_id,
                         "outputs": [{"path": "artifacts/metadata.json", "kind": "metadata"}]}
        self.storage = {"schema": "fullmag.output_storage.resolved.v1", "state": "succeeded",
                        "resolved": {"output_dir": container, "run_id": self.run_id}}
        self.metadata = {"source_hash": self.sha, "problem_meta": {"runtime_metadata": {"producer_run_id": self.run_id}},
                         "completion": {"converged": False}}
        self.save(issue_attestation=True)

    def save(self, suffix="", *, issue_attestation=False):
        self.log = self.root / self.case / "runtime.log"
        self.log.write_text("[solver] progress\n" + json.dumps(self.summary, indent=2) + "\n" + suffix, encoding="utf-8")
        manifest_bytes = json.dumps(self.manifest).encode("utf-8")
        metadata_bytes = json.dumps(self.metadata).encode("utf-8")
        (self.workspace / "fullmag-run.json").write_bytes(manifest_bytes)
        (self.workspace / "output-storage.json").write_text(json.dumps(self.storage), encoding="utf-8")
        (self.workspace / "artifacts/metadata.json").write_bytes(metadata_bytes)
        if issue_attestation:
            attestation = {
                "schema": resolver.ARTIFACT_ATTESTATION_SCHEMA,
                "status": "completed",
                "exit_code": 0,
                "run_id": self.run_id,
                "session_id": self.session_id,
                "source_sha256": self.sha,
                "metadata_relative_path": resolver.METADATA_RELATIVE_PATH,
                "metadata_sha256": hashlib.sha256(metadata_bytes).hexdigest(),
                "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            }
            (self.workspace / resolver.ARTIFACT_ATTESTATION_FILE).write_bytes(
                json.dumps(attestation, separators=(",", ":")).encode("utf-8")
            )

    def resolve(self):
        return resolver.resolve_runtime_artifact_root(self.root, self.case, self.sha)

    def test_session_sibling_mapping_and_exact_evidence_hashes(self):
        artifact, binding = self.resolve()
        self.assertEqual(artifact, self.workspace / "artifacts")
        self.assertEqual(binding["run_id"], self.run_id)
        self.assertEqual(binding["session_id"], self.session_id)
        for key in ("runtime_log", "run_manifest", "output_storage", "metadata", "producer_attestation"):
            self.assertEqual(binding[key + "_sha256"], hashlib.sha256(Path(binding[key]).read_bytes()).hexdigest())

    def test_post_terminal_metadata_edit_with_same_identity_is_rejected(self):
        self.metadata["completion"]["converged"] = True
        self.save()
        with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "Producer artifact attestation"):
            self.resolve()

    def test_post_terminal_manifest_edit_with_same_identity_is_rejected(self):
        self.manifest["finished_at"] = "2026-10-10T12:00:00Z"
        self.save()
        with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "Producer artifact attestation"):
            self.resolve()

    def test_missing_duplicate_malformed_and_oversized_attestations_are_rejected(self):
        path = self.workspace / resolver.ARTIFACT_ATTESTATION_FILE
        original = path.read_bytes()
        path.unlink()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()

        path.write_bytes(b'{"schema":"wrong","schema":"duplicate"}')
        with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "duplicate JSON keys"):
            self.resolve()
        path.write_bytes(b"{malformed")
        with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "malformed"):
            self.resolve()
        path.write_bytes(original)
        with patch.object(resolver, "MAX_ATTESTATION_BYTES", 8):
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()

    def test_wrong_attestation_binding_fields_are_rejected(self):
        path = self.workspace / resolver.ARTIFACT_ATTESTATION_FILE
        original = json.loads(path.read_bytes())
        mutations = (
            ("schema", "unknown"), ("run_id", "other-run"), ("session_id", "other-session"),
            ("source_sha256", "b" * 64), ("metadata_relative_path", "other/metadata.json"),
            ("metadata_sha256", "c" * 64), ("manifest_sha256", "d" * 64),
            ("status", "running"), ("exit_code", False),
        )
        for key, value in mutations:
            with self.subTest(key=key):
                path.write_bytes(json.dumps({**original, key: value}).encode("utf-8"))
                with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "Producer artifact attestation"):
                    self.resolve()
        path.write_bytes(json.dumps(original, separators=(",", ":")).encode("utf-8"))

    def test_attestation_replacement_during_read_is_rejected(self):
        path = self.workspace / resolver.ARTIFACT_ATTESTATION_FILE
        real_lstat = Path.lstat
        calls = {"count": 0}

        class ChangedMetadata:
            def __init__(self, original):
                self.original = original

            def __getattr__(self, name):
                return getattr(self.original, name)

            @property
            def st_mtime_ns(self):
                return self.original.st_mtime_ns + 1

        def changed_lstat(candidate):
            info = real_lstat(candidate)
            if candidate == path:
                calls["count"] += 1
                if calls["count"] >= 4:
                    return ChangedMetadata(info)
            return info

        with patch.object(Path, "lstat", changed_lstat):
            with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "changed or exceeded"):
                self.resolve()

    def test_attestation_symlink_is_rejected(self):
        path = self.workspace / resolver.ARTIFACT_ATTESTATION_FILE
        external = self.root / "attestation-copy.json"
        external.write_bytes(path.read_bytes())
        path.unlink()
        try:
            path.symlink_to(external)
        except OSError:
            self.skipTest("Host cannot create symlinks")
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()

    def test_paths_refuse_escape_traversal_noncanonical_and_wrong_artifact_parent(self):
        original = dict(self.summary)
        for value in ("/other/output/x", resolver.CONTAINER_ROOT + "/../escape", resolver.CONTAINER_ROOT + "//x",
                      resolver.CONTAINER_ROOT + "/./x", resolver.CONTAINER_ROOT + "/x/", "C:/host/x",
                      resolver.CONTAINER_ROOT + "/x\\escape"):
            with self.subTest(value=value):
                self.summary = {**original, "workspace_dir": value}
                self.save()
                with self.assertRaises(resolver.RuntimeArtifactRootError):
                    self.resolve()
        self.summary = {**original, "artifact_dir": resolver.CONTAINER_ROOT + "/" + self.case}
        self.save()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()

    def test_symlinked_root_workspace_artifact_and_receipt_are_rejected(self):
        for target in (self.root / "alias", self.root / "workspace-alias", self.workspace / "artifact-alias", self.workspace / "manifest-alias"):
            try:
                target.symlink_to(self.workspace if "manifest" not in target.name else self.workspace / "fullmag-run.json", target_is_directory="manifest" not in target.name)
            except OSError:
                self.skipTest("Host cannot create symlinks")
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            resolver.resolve_runtime_artifact_root(self.root / "alias", self.case, self.sha)
        original = dict(self.summary)
        self.summary["workspace_dir"] = resolver.CONTAINER_ROOT + "/workspace-alias"
        self.save()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()
        self.summary = {**original, "artifact_dir": original["workspace_dir"] + "/artifact-alias"}
        self.save()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()
        self.summary = original
        self.save()
        receipt = self.workspace / "fullmag-run.json"
        receipt.unlink()
        receipt.symlink_to(self.workspace / "manifest-alias")
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()

    def test_wrong_hash_run_and_nonterminal_receipts_are_rejected(self):
        for key, value in (("schema", "unknown"), ("status", "running"), ("exit_code", True), ("exit_code", 1),
                           ("run_id", ""), ("source", {"sha256": "b" * 64})):
            old = self.manifest[key]
            self.manifest[key] = value
            self.save()
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()
            self.manifest[key] = old
        for key, value in (("schema", "unknown"), ("state", "running"), ("resolved", {"run_id": "wrong", "output_dir": self.summary["workspace_dir"]})):
            old = self.storage[key]
            self.storage[key] = value
            self.save()
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()
            self.storage[key] = old
        self.summary["run_id"] = "wrong"
        self.save()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()

    def test_summary_and_manifest_run_session_ids_are_required_and_match(self):
        original_summary = dict(self.summary)
        original_manifest = dict(self.manifest)
        for key in ("run_id", "session_id"):
            with self.subTest(source="summary_missing", key=key):
                self.summary = dict(original_summary)
                self.summary.pop(key)
                self.save()
                with self.assertRaises(resolver.RuntimeArtifactRootError):
                    self.resolve()
            with self.subTest(source="summary_mismatch", key=key):
                self.summary = {**original_summary, key: "mismatched-" + key}
                self.save()
                with self.assertRaises(resolver.RuntimeArtifactRootError):
                    self.resolve()
            with self.subTest(source="manifest_missing", key=key):
                self.summary = dict(original_summary)
                self.manifest = dict(original_manifest)
                self.manifest.pop(key)
                self.save()
                with self.assertRaises(resolver.RuntimeArtifactRootError):
                    self.resolve()
            with self.subTest(source="manifest_mismatch", key=key):
                self.summary = dict(original_summary)
                self.manifest = {**original_manifest, key: "mismatched-" + key}
                self.save()
                with self.assertRaises(resolver.RuntimeArtifactRootError):
                    self.resolve()
        self.summary = original_summary
        self.manifest = original_manifest
        self.save()

    def test_workspace_must_belong_to_requested_case_and_attempt(self):
        other_case = "de-smoke-k2"
        other_workspace = self.root / f"{other_case}-{self.run_id}-0"
        (other_workspace / "artifacts").mkdir(parents=True)
        container = resolver.CONTAINER_ROOT + "/" + other_workspace.name
        self.summary = {**self.summary, "workspace_dir": container, "artifact_dir": container + "/artifacts"}
        self.save()
        with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "requested case"):
            self.resolve()

        for attempt in ("attempt", "01", "100"):
            with self.subTest(attempt=attempt):
                workspace = self.root / f"{self.case}-{self.run_id}-{attempt}"
                (workspace / "artifacts").mkdir(parents=True)
                container = resolver.CONTAINER_ROOT + "/" + workspace.name
                self.summary = {**self.summary, "workspace_dir": container, "artifact_dir": container + "/artifacts"}
                self.save()
                with self.assertRaisesRegex(resolver.RuntimeArtifactRootError, "output attempt"):
                    self.resolve()

    def test_artifact_metadata_and_manifest_membership_must_match(self):
        self.metadata["source_hash"] = "b" * 64
        self.save()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()
        self.metadata["source_hash"] = self.sha
        self.metadata["problem_meta"]["runtime_metadata"]["producer_run_id"] = "different-run"
        self.save()
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()
        self.metadata["problem_meta"]["runtime_metadata"]["producer_run_id"] = self.run_id
        for outputs in ([], [self.manifest["outputs"][0]] * 2, [{"path": "artifacts/metadata.json", "kind": "unknown"}]):
            self.manifest["outputs"] = outputs
            self.save()
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()

    def test_nonterminal_ambiguous_or_malformed_log_is_rejected(self):
        original = dict(self.summary)
        for key, value in (("status", "running"), ("backend", "fdm"), ("mode", "auto"), ("precision", "single")):
            self.summary = {**original, key: value}
            self.save()
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()
        self.summary = original
        for suffix in ("still running", json.dumps(original), "{}", "\n{"):
            self.save(suffix)
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()
        self.log.write_text('{"broken":\n' + json.dumps(original), encoding="utf-8")
        with self.assertRaises(resolver.RuntimeArtifactRootError):
            self.resolve()

    def test_oversized_log_and_reparse_metadata_are_rejected(self):
        with patch.object(resolver, "MAX_LOG_BYTES", 8):
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()
        real_lstat = Path.lstat
        class ReparseMetadata:
            st_mode = 0o40755
            st_file_attributes = 0x400
        def marked(path):
            return ReparseMetadata() if path == self.workspace else real_lstat(path)
        with patch.object(Path, "lstat", marked):
            with self.assertRaises(resolver.RuntimeArtifactRootError):
                self.resolve()


class RuntimeArtifactReadRaceTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, "mkfifo") and hasattr(os, "O_NONBLOCK"), "POSIX FIFO required")
    def test_regular_to_fifo_swap_fails_without_blocking_open(self):
        # A subprocess watchdog keeps the regression bounded even if open blocks.
        program = textwrap.dedent("""
            import os
            from pathlib import Path
            import tempfile
            from unittest.mock import patch
            import managed_runtime_artifact_root as resolver
            with tempfile.TemporaryDirectory() as root:
                target = Path(root).resolve() / 'evidence.json'
                target.write_bytes(b'{}')
                real_open = os.open
                swapped = False
                def replace_before_open(path, flags, *args, **kwargs):
                    global swapped
                    if Path(path) == target and not swapped:
                        swapped = True
                        target.unlink()
                        os.mkfifo(target)
                    return real_open(path, flags, *args, **kwargs)
                with patch.object(resolver.os, 'open', side_effect=replace_before_open):
                    try:
                        resolver._read(target, 1024)
                    except resolver.RuntimeArtifactRootError as error:
                        assert swapped
                        assert 'bounded regular file' in str(error)
                    else:
                        raise AssertionError('FIFO substitution was accepted')
                print('FIFO swap rejected before read')
        """)
        result = subprocess.run([sys.executable, '-B', '-c', program],
                                cwd=str(Path(__file__).resolve().parent),
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('FIFO swap rejected before read', result.stdout)


if __name__ == "__main__":
    unittest.main()
