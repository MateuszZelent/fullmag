"""Interpreted host-side live manifest checks; no Docker or native build."""
from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest

import docker_backend_inputs as inputs
from local_runner.build_source import bind_identity


class LiveSourceManifestTests(unittest.TestCase):
    def _repo(self) -> tuple[Path, str]:
        directory = tempfile.TemporaryDirectory()
        repo = Path(directory.name)
        subprocess.run(("git", "init", "-q", str(repo)), check=True)
        subprocess.run(("git", "-C", str(repo), "config", "user.email", "test@example.invalid"), check=True)
        subprocess.run(("git", "-C", str(repo), "config", "user.name", "Test"), check=True)
        (repo / "build.rs").write_text("fn build() {}\n", encoding="utf-8")
        subprocess.run(("git", "-C", str(repo), "add", "build.rs"), check=True)
        subprocess.run(("git", "-C", str(repo), "commit", "-qm", "fixture"), check=True)
        return repo, directory

    def test_manifest_is_compact_and_includes_only_explicit_untracked(self):
        repo, lifetime = self._repo()
        try:
            (repo / "local.rs").write_text("pub fn local() {}\n", encoding="utf-8")
            manifest, git_objects, _common = inputs._compact_live_source_manifest(
                repo, include_untracked=("local.rs",)
            )
            self.assertNotIn("archive_path", manifest)
            self.assertEqual(git_objects, {})
            self.assertIn("local.rs", manifest["included_untracked"])
            self.assertEqual(
                {entry["path"] for entry in manifest["files"]},
                {"build.rs", "local.rs"},
            )
        finally:
            lifetime.cleanup()

    def test_sparse_missing_file_is_pinned_to_git_object(self):
        repo, lifetime = self._repo()
        try:
            subprocess.run(("git", "-C", str(repo), "update-index", "--skip-worktree", "build.rs"), check=True)
            (repo / "build.rs").unlink()
            manifest, git_objects, _common = inputs._compact_live_source_manifest(
                repo, include_untracked=()
            )
            self.assertIn("build.rs", git_objects)
            self.assertEqual(manifest["deleted"], [])
            self.assertEqual(manifest["files"][0]["path"], "build.rs")
        finally:
            lifetime.cleanup()

    def test_live_symlink_is_rejected(self):
        repo, lifetime = self._repo()
        try:
            (repo / "link.rs").symlink_to(repo / "build.rs")
            with self.assertRaises(inputs.BackendInputError):
                inputs._compact_live_source_manifest(repo, include_untracked=("link.rs",))
        finally:
            lifetime.cleanup()

    def test_native_identity_binding_rejects_unlisted_dirty_input(self):
        repo, lifetime = self._repo()
        try:
            manifest, _git_objects, _common = inputs._compact_live_source_manifest(
                repo, include_untracked=()
            )
            native = {
                "head_commit_full": manifest["resolved_commit"],
                "dirty_path_content": [{
                    "path": "local.rs",
                    "kind": "regular_file",
                    "sha256": "a" * 64,
                }],
            }
            with self.assertRaises(ValueError):
                bind_identity(native, manifest)
        finally:
            lifetime.cleanup()


if __name__ == "__main__":
    unittest.main()
