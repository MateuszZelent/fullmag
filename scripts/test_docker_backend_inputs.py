"""Focused interpreted checks for the direct Docker backend source boundary."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from copy import deepcopy
from pathlib import Path
import tarfile
import subprocess
import tempfile
import unittest

from docker_backend_inputs import (
    ARCHIVE_MANIFEST_SCHEMA,
    _canonical_bytes,
    build_backend_archive,
    source_manifest_digest,
    _restore_sparse_snapshot_files,
)
from local_runner.source import capture_source


def _load_backend_source():
    path = Path(__file__).parents[1] / "docker" / "all-in-one" / "backend_source.py"
    spec = importlib.util.spec_from_file_location("fullmag_backend_source_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load backend source helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backend_source = _load_backend_source()


class DirectBackendSourceChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.tree = self.root / "tree"
        self.tree.mkdir()
        (self.tree / "src").mkdir()
        (self.tree / "src" / "main.rs").write_bytes(b"fn main() {}\n")
        self.files = [{
            "path": "src/main.rs",
            "type": "file",
            "mode": "100644",
            "size": 13,
            "sha256": hashlib.sha256(b"fn main() {}\n").hexdigest(),
        }]
        self.source = {
            "schema_version": "fullmag.source-capsule.v1",
            "schema": "fullmag.source-capsule.v1",
            "manifest_filename": "manifest.json",
            "source_mode": "commit",
            "repo_root": "C:/git/fullmag/worktrees/example",
            "git_common_dir": "C:/git/fullmag/.git",
            "requested_ref": "a" * 40,
            "resolved_commit": "a" * 40,
            "head_commit": "a" * 40,
            "dirty": False,
            "working_tree_dirty": False,
            "files": self.files,
            "entries": self.files,
            "deleted": [],
            "included_untracked": [],
            "excluded": [],
        }
        digest = source_manifest_digest(self.source)
        self.source["source_digest"] = digest
        self.source["source_digest_sha256"] = digest
        self.native = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": "a" * 40,
            "head_tree_sha256": "b" * 64,
            "git_status_porcelain_v1": [],
            "dirty_path_content": [],
            "ignored_non_runtime_dirty": True,
            "source_snapshot_dirty": False,
            "dirty_content_sha256": "c" * 64,
            "source_snapshot_sha256": "d" * 64,
        }

    def tearDown(self):
        self.temp.cleanup()

    def _build(self):
        return build_backend_archive(
            self.tree,
            self.source,
            self.native,
            self.root / "bundle",
            capture_id="capture-test",
            source_root="C:/git/fullmag/worktrees/example",
        )

    def test_round_trip_produces_read_only_frozen_source(self):
        bundle = self._build()
        verified = backend_source.verify_frozen_source_archive(
            Path(bundle["archive_path"]), Path(bundle["manifest_path"])
        )
        self.assertEqual(verified["archive_sha256"], bundle["archive_sha256"])
        destination = self.root / "frozen"
        result = backend_source.extract_frozen_source(
            Path(bundle["archive_path"]), Path(bundle["manifest_path"]), destination
        )
        self.assertEqual(result["source_digest"], self.source["source_digest"])
        self.assertEqual((destination / "src" / "main.rs").read_bytes(), b"fn main() {}\n")
        self.assertFalse((destination / "src" / "main.rs").stat().st_mode & 0o222)

    def test_rejects_tar_traversal_symlink_hardlink_and_duplicate(self):
        bundle = self._build()
        manifest = json.loads(Path(bundle["manifest_path"]).read_text())
        archive = Path(bundle["archive_path"])
        cases = ("../escape", "symlink", "hardlink", "duplicate")
        for case in cases:
            candidate = self.root / f"{case}.tar"
            with tarfile.open(candidate, "w") as output:
                embedded = _canonical_bytes(manifest["source_manifest"])
                info = tarfile.TarInfo("backend-source-manifest.json")
                info.size = len(embedded)
                output.addfile(info, __import__("io").BytesIO(embedded))
                if case == "symlink":
                    info = tarfile.TarInfo("src/link")
                    info.type = tarfile.SYMTYPE
                    info.linkname = "main.rs"
                    output.addfile(info)
                elif case == "hardlink":
                    info = tarfile.TarInfo("src/link")
                    info.type = tarfile.LNKTYPE
                    info.linkname = "src/main.rs"
                    output.addfile(info)
                else:
                    info = tarfile.TarInfo("../escape" if case == "../escape" else "src/main.rs")
                    payload = b"bad\n" if case == "../escape" else b"fn main() {}\n"
                    info.size = len(payload)
                    output.addfile(info, __import__("io").BytesIO(payload))
                    if case == "duplicate":
                        output.addfile(info, __import__("io").BytesIO(payload))
            changed = dict(manifest)
            changed["archive_filename"] = candidate.name
            changed["archive_sha256"] = hashlib.sha256(candidate.read_bytes()).hexdigest()
            changed["archive_bytes"] = candidate.stat().st_size
            changed_manifest = self.root / f"{case}.json"
            changed_manifest.write_bytes(_canonical_bytes(changed))
            with self.assertRaises(backend_source.BackendSourceError):
                backend_source.extract_frozen_source(candidate, changed_manifest, self.root / f"out-{case}")
            with self.assertRaises(backend_source.BackendSourceError):
                backend_source.verify_frozen_source_archive(candidate, changed_manifest)

    def test_rejects_archive_tampering_against_external_digest(self):
        bundle = self._build()
        archive = Path(bundle["archive_path"])
        archive.chmod(0o600)
        archive.write_bytes(archive.read_bytes() + b"tamper")
        with self.assertRaises(backend_source.BackendSourceError):
            backend_source.extract_frozen_source(
                archive, Path(bundle["manifest_path"]), self.root / "tampered"
            )

    def test_accepts_selected_untracked_file_disclosed_in_source_manifest(self):
        source = deepcopy(self.source)
        source["source_mode"] = "snapshot"
        source["dirty"] = True
        source["included_untracked"] = ["src/main.rs"]
        digest = source_manifest_digest(source)
        source["source_digest"] = digest
        source["source_digest_sha256"] = digest
        bundle = build_backend_archive(
            self.tree,
            source,
            self.native,
            self.root / "untracked-bundle",
            capture_id="capture-untracked",
            source_root="C:/git/fullmag/worktrees/example",
        )
        verified = backend_source.verify_frozen_source_archive(
            Path(bundle["archive_path"]), Path(bundle["manifest_path"])
        )
        self.assertEqual(verified["file_count"], 1)

    def test_snapshot_restores_only_skip_worktree_files_from_head(self):
        repo = self.root / "sparse-repo"
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(("git", "-C", str(repo), *args), text=True).strip()
        subprocess.run(("git", "init", "-q", str(repo)), check=True)
        subprocess.run(("git", "-C", str(repo), "config", "user.email", "test@example.invalid"), check=True)
        subprocess.run(("git", "-C", str(repo), "config", "user.name", "Test"), check=True)
        (repo / "build.rs").write_text("fn build() {}\n", encoding="utf-8")
        (repo / "actually-deleted.rs").write_text("fn old() {}\n", encoding="utf-8")
        subprocess.run(("git", "-C", str(repo), "add", "build.rs", "actually-deleted.rs"), check=True)
        subprocess.run(("git", "-C", str(repo), "commit", "-qm", "fixture"), check=True)
        commit = git("rev-parse", "HEAD")
        subprocess.run(("git", "-C", str(repo), "update-index", "--skip-worktree", "build.rs"), check=True)
        (repo / "build.rs").unlink()
        (repo / "actually-deleted.rs").unlink()
        capsule = self.root / "sparse-capsule"
        capsule.mkdir()
        source = capture_source(repo, capsule, mode="snapshot")
        self.assertEqual(source["deleted"], ["actually-deleted.rs", "build.rs"])
        restored = _restore_sparse_snapshot_files(repo, capsule, source)
        self.assertEqual(restored["deleted"], ["actually-deleted.rs"])
        self.assertEqual(
            (capsule / "tree" / "build.rs").read_text(encoding="utf-8"),
            "fn build() {}\n",
        )
        self.assertNotIn("actually-deleted.rs", {entry["path"] for entry in restored["files"]})


if __name__ == "__main__":
    unittest.main()
