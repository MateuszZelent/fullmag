from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


try:
    from scripts.local_runner.source import SourceError, capture_source
except ModuleNotFoundError:
    # ``unittest discover -s scripts`` places ``scripts`` itself on
    # sys.path, while direct execution from the repository root does not.
    from local_runner.source import SourceError, capture_source


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("git", *args),
        cwd=repo,
        text=True,
        capture_output=True,
        check=check,
    )


def _repository(root: Path) -> tuple[Path, str]:
    repo = root / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Local runner source tests")
    _git(repo, "config", "user.email", "local-runner-source@example.invalid")
    (repo / "tracked.txt").write_text("committed\n", encoding="utf-8")
    (repo / "deleted.txt").write_text("delete me\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt", "deleted.txt")
    _git(repo, "commit", "-qm", "initial")
    commit = _git(repo, "rev-parse", "HEAD").stdout.strip()
    return repo, commit


class LocalRunnerSourceTests(unittest.TestCase):
    def test_snapshot_captures_current_tracked_bytes_and_explicit_untracked(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, head = _repository(root)
            (repo / "tracked.txt").write_text("working tree\n", encoding="utf-8")
            (repo / "deleted.txt").unlink()
            (repo / "input.txt").write_text("explicit input\n", encoding="utf-8")
            output = root / "capsule"
            output.mkdir()

            before_index = _git(repo, "diff", "--cached", "--name-status").stdout
            manifest = capture_source(repo, output, include_untracked=("input.txt",))
            after_index = _git(repo, "diff", "--cached", "--name-status").stdout

            self.assertEqual(manifest["schema_version"], "fullmag.source-capsule.v1")
            self.assertEqual(manifest["resolved_commit"], head)
            self.assertTrue(manifest["dirty"])
            self.assertEqual(
                {item["path"] for item in manifest["files"]},
                {"tracked.txt", "input.txt"},
            )
            self.assertEqual(manifest["deleted"], ["deleted.txt"])
            self.assertEqual(
                (output / "tree" / "tracked.txt").read_text(encoding="utf-8"),
                "working tree\n",
            )
            self.assertEqual(
                (output / "tree" / "input.txt").read_text(encoding="utf-8"),
                "explicit input\n",
            )
            self.assertFalse((output / "tree" / "deleted.txt").exists())
            self.assertEqual(before_index, after_index)
            on_disk = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(on_disk["source_digest"], manifest["source_digest"])
            self.assertEqual(
                manifest["source_digest"],
                hashlib.sha256(
                    json.dumps(
                        {
                            "schema_version": manifest["schema_version"],
                            "source_mode": manifest["source_mode"],
                            "resolved_commit": manifest["resolved_commit"],
                            "files": manifest["files"],
                            "deleted": manifest["deleted"],
                            "included_untracked": manifest["included_untracked"],
                            "excluded": manifest["excluded"],
                        },
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    ).encode()
                    + b"\n"
                ).hexdigest(),
            )

    def test_clean_snapshot_marks_mode_dirty_but_records_clean_worktree(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            output = root / "capsule"
            output.mkdir()

            manifest = capture_source(repo, output)

            self.assertTrue(manifest["dirty"])
            self.assertFalse(manifest["working_tree_dirty"])

    def test_commit_captures_exact_ref_and_omits_dirty_worktree(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, initial = _repository(root)
            (repo / "tracked.txt").write_text("dirty\n", encoding="utf-8")
            (repo / "untracked.txt").write_text("not in commit\n", encoding="utf-8")
            output = root / "capsule"
            output.mkdir()

            manifest = capture_source(repo, output, mode="commit", ref=initial)

            self.assertEqual(manifest["source_mode"], "commit")
            self.assertEqual(manifest["resolved_commit"], initial)
            self.assertFalse(manifest["dirty"])
            self.assertTrue(manifest["working_tree_dirty"])
            self.assertEqual(
                (output / "tree" / "tracked.txt").read_text(encoding="utf-8"),
                "committed\n",
            )
            self.assertFalse((output / "tree" / "untracked.txt").exists())

    def test_manifest_is_accepted_by_trusted_source_verifier(self) -> None:
        try:
            from scripts.local_runner.worker_entrypoint import verify_source
        except ModuleNotFoundError:
            from local_runner.worker_entrypoint import verify_source

        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, initial = _repository(root)
            output = root / "capsule"
            output.mkdir()

            manifest = capture_source(repo, output, mode="commit", ref=initial)

            verified = verify_source(output, manifest["source_digest"])
            self.assertEqual(verified["source_digest"], manifest["source_digest"])

    def test_rejects_overlap_and_nonempty_destination(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            with self.assertRaisesRegex(SourceError, "overlaps"):
                capture_source(repo, repo)
            nested = repo / "nested"
            nested.mkdir()
            with self.assertRaisesRegex(SourceError, "overlaps"):
                capture_source(repo, nested)
            output = root / "capsule"
            output.mkdir()
            (output / "existing").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(SourceError, "empty"):
                capture_source(repo, output)

    def test_rejects_secrets_and_unsupported_lfs_pointer(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            (repo / ".env").write_text("TOKEN=do-not-copy\n", encoding="utf-8")
            _git(repo, "add", ".env")
            _git(repo, "commit", "-qm", "secret")
            output = root / "capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "EXCLUDED_SOURCE"):
                capture_source(repo, output, mode="commit", ref="HEAD")

            # The pointer remains an unsupported LFS source even when its
            # path itself is otherwise safe.
            _git(repo, "rm", "-q", ".env")
            pointer = (
                "version https://git-lfs.github.com/spec/v1\n"
                "oid sha256:" + "a" * 64 + "\n"
                "size 12\n"
            )
            (repo / "large.bin").write_text(pointer, encoding="ascii")
            _git(repo, "add", "large.bin")
            _git(repo, "commit", "-qm", "lfs pointer")
            output = root / "lfs-capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "UNSUPPORTED_LFS"):
                capture_source(repo, output, mode="commit", ref="HEAD")

            # Attribute-based LFS detection also travels through Git's
            # NUL-delimited stdin path, not a command-line path list.
            (repo / ".gitattributes").write_text("large.bin filter=lfs\n", encoding="utf-8")
            (repo / "large.bin").write_bytes(b"materialised bytes\n")
            _git(repo, "add", ".gitattributes", "large.bin")
            _git(repo, "commit", "-qm", "lfs attribute")
            output = root / "lfs-attribute-capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "UNSUPPORTED_LFS"):
                capture_source(repo, output, mode="commit", ref="HEAD")

    def test_allows_design_system_tokens_stylesheet(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            stylesheet = repo / "apps" / "control-room" / "src" / "design" / "styles"
            stylesheet.mkdir(parents=True)
            (stylesheet / "tokens.css").write_text(":root { --space: 1px; }\n", encoding="utf-8")
            _git(repo, "add", "apps/control-room/src/design/styles/tokens.css")
            _git(repo, "commit", "-qm", "design tokens")
            output = root / "capsule"
            output.mkdir()

            manifest = capture_source(repo, output, mode="commit", ref="HEAD")

            self.assertIn(
                "apps/control-room/src/design/styles/tokens.css",
                {item["path"] for item in manifest["files"]},
            )

    def test_rejects_gitlinks_without_silent_omission(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            submodule = root / "submodule"
            submodule.mkdir()
            _git(submodule, "init", "-q")
            _git(submodule, "config", "user.name", "Submodule")
            _git(submodule, "config", "user.email", "submodule@example.invalid")
            (submodule / "code.txt").write_text("submodule\n", encoding="utf-8")
            _git(submodule, "add", "code.txt")
            _git(submodule, "commit", "-qm", "submodule")
            added = _git(
                repo,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(submodule),
                "external",
                check=False,
            )
            if added.returncode:
                self.skipTest(added.stderr.strip() or "Git cannot create local test submodule")
            _git(repo, "commit", "-qm", "submodule")
            output = root / "capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "UNSUPPORTED_SUBMODULE"):
                capture_source(repo, output)

    def test_discloses_allowlisted_external_solver_gitlink_pin(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            submodule = root / "submodule"
            submodule.mkdir()
            _git(submodule, "init", "-q")
            _git(submodule, "config", "user.name", "Submodule")
            _git(submodule, "config", "user.email", "submodule@example.invalid")
            (submodule / "code.txt").write_text("first\n", encoding="utf-8")
            _git(submodule, "add", "code.txt")
            _git(submodule, "commit", "-qm", "first")
            first_pin = _git(submodule, "rev-parse", "HEAD").stdout.strip()
            added = _git(
                repo,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(submodule),
                "external_solvers/3",
                check=False,
            )
            if added.returncode:
                self.skipTest(added.stderr.strip() or "Git cannot create local test submodule")
            _git(repo, "commit", "-qm", "external solver pin")

            first_output = root / "first-capsule"
            first_output.mkdir()
            first_manifest = capture_source(repo, first_output, mode="commit", ref="HEAD")
            first_disclosures = [
                item
                for item in first_manifest["excluded"]
                if isinstance(item, dict) and item.get("path") == "external_solvers/3"
            ]
            self.assertEqual(
                first_disclosures,
                [
                    {
                        "path": "external_solvers/3",
                        "type": "gitlink",
                        "pinned_commit": first_pin,
                    }
                ],
            )
            self.assertFalse((first_output / "tree" / "external_solvers" / "3").exists())

            (submodule / "code.txt").write_text("second\n", encoding="utf-8")
            _git(submodule, "add", "code.txt")
            _git(submodule, "commit", "-qm", "second")
            second_pin = _git(submodule, "rev-parse", "HEAD").stdout.strip()
            # Update only the superproject's pinned gitlink.  The nested
            # checkout is intentionally not part of this capsule test.
            _git(
                repo,
                "update-index",
                "--add",
                "--cacheinfo",
                f"160000,{second_pin},external_solvers/3",
            )
            _git(repo, "commit", "-qm", "update external solver pin")

            second_output = root / "second-capsule"
            second_output.mkdir()
            second_manifest = capture_source(repo, second_output, mode="commit", ref="HEAD")
            second_disclosures = [
                item
                for item in second_manifest["excluded"]
                if isinstance(item, dict) and item.get("path") == "external_solvers/3"
            ]
            self.assertEqual(second_disclosures[0]["pinned_commit"], second_pin)
            self.assertNotEqual(first_manifest["source_digest"], second_manifest["source_digest"])
            self.assertNotEqual(first_pin, second_pin)

    def test_discloses_known_administrative_trees_without_following_them(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            (repo / ".agents").mkdir()
            (repo / ".agents" / "local-note.txt").write_text("metadata\n", encoding="utf-8")
            token_path = repo / ".superpowers" / "brainstorm"
            token_path.mkdir(parents=True)
            (token_path / ".last-token").write_text("test-only-placeholder\n", encoding="utf-8")
            _git(repo, "add", ".agents/local-note.txt", ".superpowers/brainstorm/.last-token")
            _git(repo, "commit", "-qm", "agent metadata")
            output = root / "capsule"
            output.mkdir()

            manifest = capture_source(repo, output, mode="commit", ref="HEAD")

            self.assertNotIn(".agents/local-note.txt", {item["path"] for item in manifest["files"]})
            self.assertIn(".agents/local-note.txt", manifest["excluded"])
            self.assertIn(".superpowers/brainstorm/.last-token", manifest["excluded"])
            self.assertFalse((output / "tree" / ".agents").exists())
            self.assertFalse((output / "tree" / ".superpowers").exists())

    def test_rejects_external_symlink_when_supported(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            outside = root / "outside.txt"
            outside.write_text("outside\n", encoding="utf-8")
            link = repo / "escape.txt"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlinks unavailable: {error}")
            _git(repo, "add", "escape.txt")
            _git(repo, "commit", "-qm", "escape link")
            output = root / "capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "UNSAFE_SYMLINK"):
                capture_source(repo, output, mode="commit", ref="HEAD")

    def test_rejects_internal_symlinked_parent_when_supported(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            tracked_directory = repo / "tracked-directory"
            tracked_directory.mkdir()
            (tracked_directory / "source.txt").write_text("committed\n", encoding="utf-8")
            _git(repo, "add", "tracked-directory/source.txt")
            _git(repo, "commit", "-qm", "tracked directory")

            internal_target = repo / "internal-target"
            internal_target.mkdir()
            (internal_target / "source.txt").write_text("working tree\n", encoding="utf-8")
            (tracked_directory / "source.txt").unlink()
            tracked_directory.rmdir()
            try:
                tracked_directory.symlink_to(internal_target, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"directory symlinks unavailable: {error}")

            output = root / "capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "symlink or reparse point"):
                capture_source(repo, output)

    def test_rejects_known_credential_directories_and_suffixes(self) -> None:
        blocked_paths = (
            "secrets/api.json",
            "credentials/prod.json",
            ".secrets/config",
            "config/foo.token",
            "auth.credentials",
            "session.secret",
        )
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            for index, relative in enumerate(blocked_paths):
                with self.subTest(relative=relative):
                    case_root = root / f"case-{index}"
                    case_root.mkdir()
                    repo, _ = _repository(case_root)
                    candidate = repo / Path(*relative.split("/"))
                    candidate.parent.mkdir(parents=True, exist_ok=True)
                    candidate.write_text("credential placeholder\n", encoding="utf-8")
                    _git(repo, "add", relative)
                    _git(repo, "commit", "-qm", "credential policy")
                    output = case_root / "capsule"
                    output.mkdir()
                    with self.assertRaisesRegex(SourceError, "EXCLUDED_SOURCE"):
                        capture_source(repo, output, mode="commit", ref="HEAD")

    def test_allows_similar_noncredential_names(self) -> None:
        allowed_paths = (
            "credentialing/prod.json",
            "secretsauce/config.json",
            "config/foo.tokenizer",
            "auth.credentials_helper",
            "session.secretary",
        )
        with tempfile.TemporaryDirectory(prefix="fullmag-source-test-") as raw:
            root = Path(raw)
            repo, _ = _repository(root)
            for relative in allowed_paths:
                candidate = repo / Path(*relative.split("/"))
                candidate.parent.mkdir(parents=True, exist_ok=True)
                candidate.write_text("not credential material\n", encoding="utf-8")
            _git(repo, "add", *allowed_paths)
            _git(repo, "commit", "-qm", "noncredential names")
            output = root / "capsule"
            output.mkdir()

            manifest = capture_source(repo, output, mode="commit", ref="HEAD")

            self.assertTrue(set(allowed_paths).issubset({item["path"] for item in manifest["files"]}))


if __name__ == "__main__":
    unittest.main()
