"""Interpreted checks for the live-source shadow boundary; no Cargo/Docker build."""
from __future__ import annotations

import hashlib
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "docker" / "all-in-one"))
import backend_dev as backend


def _capsule(
    files: dict[str, bytes], *, commit: str = "a" * 40,
    excluded: list[object] | None = None,
) -> dict[str, object]:
    entries = [
        {
            "path": relative,
            "type": "file",
            "mode": "100644",
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        for relative, content in sorted(files.items())
    ]
    core = {
        "schema_version": "fullmag.source-capsule.v1",
        "schema": "fullmag.source-capsule.v1",
        "manifest_filename": "manifest.json",
        "source_mode": "snapshot",
        "repo_root": "/source",
        "git_common_dir": "/source-git",
        "requested_ref": None,
        "resolved_commit": commit,
        "head_commit": commit,
        "dirty": True,
        "working_tree_dirty": True,
        "files": entries,
        "entries": entries,
        "deleted": [],
        "included_untracked": [],
        "excluded": list(excluded or []),
    }
    material = {
        key: core[key]
        for key in (
            "schema_version", "source_mode", "resolved_commit", "files",
            "deleted", "included_untracked", "excluded",
        )
    }
    digest = hashlib.sha256(backend._canonical(material)).hexdigest()
    return {**core, "source_digest": digest, "source_digest_sha256": digest}


def _live_document(capsule: dict[str, object]) -> dict[str, object]:
    native = {
        "schema": "fullmag.source-snapshot.v2",
        "head_commit_full": capsule["resolved_commit"],
        "head_tree_sha256": "b" * 64,
        "git_status_porcelain_v1": [],
        "dirty_path_content": [],
        "source_snapshot_dirty": False,
        "ignored_non_runtime_dirty": False,
        "dirty_content_sha256": "c" * 64,
        "source_snapshot_sha256": "d" * 64,
    }
    document: dict[str, object] = {
        "schema": backend.LIVE_MANIFEST_SCHEMA,
        "capture_id": "fixture",
        "source_mode": backend.LIVE_SOURCE_MODE,
        "source_root": "/source",
        "git_common_dir": "/source-git",
        "resolved_commit": capsule["resolved_commit"],
        "source_digest": capsule["source_digest"],
        "source_snapshot_sha256": native["source_snapshot_sha256"],
        "native_source_identity": native,
        "source_manifest": capsule,
        "source_manifest_sha256": hashlib.sha256(backend._canonical(capsule)).hexdigest(),
        "git_object_ids": {},
        "created_at": "2026-10-16T00:00:00+00:00",
    }
    document["live_manifest_sha256"] = hashlib.sha256(backend._canonical(document)).hexdigest()
    return document


class LiveShadowSourceTests(unittest.TestCase):
    def test_live_manifest_validator_binds_capsule_and_rejects_tampering(self):
        capsule = _capsule({"src/main.rs": b"source\n"})
        document = _live_document(capsule)
        checked_capsule, native, git_objects, digest = backend._validate_live_manifest(document)
        self.assertEqual(checked_capsule["source_digest"], capsule["source_digest"])
        self.assertEqual(native["source_snapshot_sha256"], "d" * 64)
        self.assertEqual(git_objects, {})
        self.assertEqual(digest, document["live_manifest_sha256"])

        tampered = copy.deepcopy(document)
        tampered["live_manifest_sha256"] = "e" * 64
        with self.assertRaises(backend.BackendBuildError):
            backend._validate_live_manifest(tampered)

        extra = copy.deepcopy(document)
        extra["unexpected"] = True
        with self.assertRaises(backend.BackendBuildError):
            backend._validate_live_manifest(extra)

    def test_live_exclusions_use_the_host_source_policy_allowlist(self):
        allowed = _capsule(
            {"src/main.rs": b"source\n"},
            excluded=[
                {"path": "external_solvers/3", "type": "gitlink", "pinned_commit": "a" * 40},
                "untracked.py",
            ],
        )
        backend._validate_live_manifest(_live_document(allowed))

        for excluded in (
            ["src"],
            ["../generated"],
            [{"path": "external_solvers/foreign", "type": "gitlink", "pinned_commit": "a" * 40}],
        ):
            invalid = _capsule({"src/main.rs": b"source\n"}, excluded=excluded)
            with self.assertRaises(backend.BackendBuildError):
                backend._validate_live_manifest(_live_document(invalid))

    def test_delta_sync_keeps_ext4_cache_and_shadow_after_live_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "src").mkdir()
            (source / "src/main.rs").write_bytes(b"old\n")
            build_root = root / "build"
            workspace = backend._prepare_workspace(build_root)
            cache = workspace / ".fullmag-build" / "cargo-fingerprint"
            cache.write_bytes(b"cache")
            capsule = _capsule({"src/main.rs": b"old\n"})
            backend._sync_live_source_tree(
                source, root / "git-common", workspace, capsule, {}, "b" * 64
            )
            self.assertEqual((workspace / "src/main.rs").read_bytes(), b"old\n")
            self.assertFalse((workspace / "src/main.rs").stat().st_mode & 0o222)

            (source / "src/main.rs").write_bytes(b"new\n")
            new_capsule = _capsule({"src/main.rs": b"new\n"})
            backend._sync_live_source_tree(
                source, root / "git-common", workspace, new_capsule, {}, "c" * 64
            )
            self.assertEqual((workspace / "src/main.rs").read_bytes(), b"new\n")
            self.assertEqual(cache.read_bytes(), b"cache")
            # A later frontend/live-tree edit does not mutate or invalidate the
            # already synchronized shadow used by Make.
            (source / "src/main.rs").write_bytes(b"after-build-edit\n")
            backend._verify_shadow_source(workspace, new_capsule)
            self.assertEqual((workspace / "src/main.rs").read_bytes(), b"new\n")

    def test_missing_sparse_file_uses_pinned_git_object(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            build_root = root / "build"
            workspace = backend._prepare_workspace(build_root)
            content = b"from-git-object\n"
            capsule = _capsule({"src/missing.rs": content})
            (workspace / "src").mkdir()
            with mock.patch.object(
                backend, "_read_git_blobs", return_value={"src/missing.rs": content}
            ) as read_blobs:
                backend._sync_live_source_tree(
                    source,
                    root / "git-common",
                    workspace,
                    capsule,
                    {"src/missing.rs": "a" * 40},
                    "d" * 64,
                )
            read_blobs.assert_called_once_with(
                root / "git-common", {"src/missing.rs": "a" * 40}
            )
            self.assertEqual((workspace / "src/missing.rs").read_bytes(), content)
            self.assertFalse((workspace / "src/missing.rs").stat().st_mode & 0o222)

    def test_sparse_blob_reader_batches_objects_and_deduplicates_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(("git", "init", "-q", str(repo)), check=True)
            subprocess.run(("git", "-C", str(repo), "config", "user.email", "test@example.invalid"), check=True)
            subprocess.run(("git", "-C", str(repo), "config", "user.name", "Test"), check=True)
            (repo / "a.txt").write_bytes(b"a\n")
            (repo / "b.txt").write_bytes(b"b\n")
            subprocess.run(("git", "-C", str(repo), "add", "a.txt", "b.txt"), check=True)
            subprocess.run(("git", "-C", str(repo), "commit", "-qm", "fixture"), check=True)
            a_object = subprocess.check_output(("git", "-C", str(repo), "rev-parse", "HEAD:a.txt"), text=True).strip()
            b_object = subprocess.check_output(("git", "-C", str(repo), "rev-parse", "HEAD:b.txt"), text=True).strip()
            blobs = backend._read_git_blobs(
                repo / ".git",
                {"a.txt": a_object, "b.txt": b_object, "copy.txt": a_object},
            )
            self.assertEqual(blobs, {"a.txt": b"a\n", "b.txt": b"b\n", "copy.txt": b"a\n"})

    def test_live_symlink_is_rejected_before_shadow_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "src").mkdir()
            outside = root / "outside"
            outside.write_bytes(b"outside")
            (source / "src/link.rs").symlink_to(outside)
            workspace = backend._prepare_workspace(root / "build")
            capsule = _capsule({"src/link.rs": b"outside"})
            with self.assertRaises(backend.BackendBuildError):
                backend._sync_live_source_tree(
                    source, root / "git-common", workspace, capsule, {}, "e" * 64
                )
            self.assertFalse((workspace / "src/link.rs").exists())

    def test_generated_root_is_preserved_and_unowned_entries_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = backend._prepare_workspace(Path(directory) / "build")
            generated = workspace / ".fullmag"
            generated.mkdir()
            (generated / "local").mkdir()
            (generated / "local" / "old-package").write_bytes(b"owned")
            backend._remove_generated_build_output(workspace)
            self.assertTrue(generated.is_dir())
            self.assertFalse((generated / "local").exists())

            (generated / "foreign-output").write_bytes(b"keep")
            with self.assertRaises(backend.BackendBuildError):
                backend._remove_generated_build_output(workspace)
            self.assertEqual((generated / "foreign-output").read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
