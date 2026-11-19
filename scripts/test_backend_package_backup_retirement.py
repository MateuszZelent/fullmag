"""Interpreted recovery tests for interrupted package backup retirement."""
from contextlib import redirect_stderr, redirect_stdout
import importlib
import io
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT_ROOT = Path(__file__).resolve().parents[1] / "scripts"
DOCKER_HELPERS = SCRIPT_ROOT.parent / "docker" / "all-in-one"
sys.path.insert(0, str(SCRIPT_ROOT))
sys.path.insert(0, str(DOCKER_HELPERS))
import backend_dev as backend

# Reuse the existing receipt-backed rotation fixture without importing its
# TestCase class into this module's unittest discovery namespace.
_fixture_module = importlib.import_module("test_docker_backend_dev")
def _fixture_case(test_name):
    return getattr(_fixture_module, "BackendPackageTests")(test_name)


class BackendPackageBackupRetirementTests(unittest.TestCase):
    def _rotated(self, root, versions=3):
        fixture = _fixture_case("test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain")
        return fixture._rotated_package_fixture(root, versions=versions)

    @staticmethod
    def _current(package):
        return backend._validated_package(
            package, "retirement current package", exclude_development_control=True
        )

    def _run_retention(self, package, control):
        current = self._current(package)
        backend._retain_package_backups(package, control, current[0], current[1])

    def _roots(self, control):
        return (
            control / backend.PACKAGE_RETIREMENT_INTENTS_DIRNAME,
            control / backend.PACKAGE_RETIREMENT_TOMBSTONES_DIRNAME,
        )

    def _interrupt_after_rename(self, package, control):
        original_rename = backend._rename_backup_to_tombstone

        def rename_then_interrupt(source, target, backup_name):
            original_rename(source, target, backup_name)
            raise KeyboardInterrupt("simulated process interruption after rename")

        with patch.object(backend, "_rename_backup_to_tombstone", side_effect=rename_then_interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self._run_retention(package, control)

    def test_mid_payload_delete_resumes_and_preserves_current_and_direct_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, _toolchain = self._rotated(root, versions=3)
            current_before = self._current(package)
            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            direct = _fixture_case("test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain")._direct_backup_for_current(
                control, current_before[1]
            )
            direct_identity = (direct.stat().st_dev, direct.stat().st_ino)
            direct_receipt = (direct / "backend-build-receipt.json").read_bytes()
            obsolete = next(path for path in backups_root.iterdir() if path != direct)
            backup_receipt = backend._read_json(
                obsolete / "backend-build-receipt.json", "test obsolete receipt"
            )[0]
            artifact = backup_receipt["artifacts"][0]["path"]
            source_payload = obsolete / artifact
            external_alias = root / "shared-hardlink-alias"
            os.link(source_payload, external_alias)
            alias_identity = (external_alias.stat().st_dev, external_alias.stat().st_ino)
            alias_bytes = external_alias.read_bytes()
            original_unlink = backend._unlink_retirement_entry
            removed = 0

            def unlink_once_then_interrupt(path, entry_name):
                nonlocal removed
                original_unlink(path, entry_name)
                removed += 1
                if removed == 1:
                    raise KeyboardInterrupt("simulated process interruption during payload removal")

            with patch.object(backend, "_unlink_retirement_entry", side_effect=unlink_once_then_interrupt):
                with self.assertRaises(KeyboardInterrupt):
                    self._run_retention(package, control)

            intents, tombstones = self._roots(control)
            self.assertTrue(tuple(intents.iterdir()))
            self.assertTrue(tuple(tombstones.iterdir()))
            self._run_retention(package, control)

            current_after = self._current(package)
            direct_after = (control / backend.PACKAGE_BACKUPS_DIRNAME / direct.name)
            self.assertEqual(current_after[1], current_before[1])
            self.assertEqual(
                (direct_after.stat().st_dev, direct_after.stat().st_ino), direct_identity
            )
            self.assertEqual(
                (direct_after / "backend-build-receipt.json").read_bytes(), direct_receipt
            )
            backend._validated_package(direct_after, "direct rollback after retirement")
            self.assertEqual((external_alias.stat().st_dev, external_alias.stat().st_ino), alias_identity)
            self.assertEqual(external_alias.read_bytes(), alias_bytes)
            self.assertFalse(tuple(intents.iterdir()))
            self.assertFalse(tuple(tombstones.iterdir()))

    def test_crash_after_atomic_rename_recovers_before_chain_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, control, _toolchain = self._rotated(Path(temporary), versions=3)
            self._interrupt_after_rename(package, control)
            intents, tombstones = self._roots(control)
            self.assertTrue(tuple(intents.iterdir()))
            self.assertTrue(tuple(tombstones.iterdir()))

            self._run_retention(package, control)

            self.assertFalse(tuple(intents.iterdir()))
            self.assertFalse(tuple(tombstones.iterdir()))
            self.assertEqual(
                len(tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir())), 1
            )

    def test_completed_payload_with_pending_intent_is_idempotently_finalized(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, control, _toolchain = self._rotated(Path(temporary), versions=3)
            original_remove_intent = backend._remove_retirement_intent

            def interrupt_before_intent_unlink(path, backup_name, target_kind="backup"):
                raise KeyboardInterrupt("simulated process interruption after payload removal")

            with patch.object(backend, "_remove_retirement_intent", side_effect=interrupt_before_intent_unlink):
                with self.assertRaises(KeyboardInterrupt):
                    self._run_retention(package, control)

            intents, tombstones = self._roots(control)
            self.assertTrue(tuple(intents.iterdir()))
            self.assertFalse(tuple(tombstones.iterdir()))
            with patch.object(backend, "_remove_retirement_intent", wraps=original_remove_intent):
                self._run_retention(package, control)
            self.assertFalse(tuple(intents.iterdir()))
            self.assertFalse(tuple(tombstones.iterdir()))

    def test_archive_manifest_tampering_blocks_recovery_before_payload_removal(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, control, _toolchain = self._rotated(Path(temporary), versions=3)
            self._interrupt_after_rename(package, control)
            _, tombstones = self._roots(control)
            tombstone = next(tombstones.iterdir())
            surviving_files = sorted(path.relative_to(tombstone).as_posix() for path in tombstone.rglob("*"))
            archive = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME / tombstone.name
            manifest, _ = backend._read_json(archive / "retention.json", "test retention manifest")
            manifest["current_receipt_sha256"] = "0" * 64
            backend._write_json(archive / "retention.json", manifest, "tampered retention manifest")

            with self.assertRaises(backend.BackendBuildError):
                self._run_retention(package, control)

            self.assertEqual(
                sorted(path.relative_to(tombstone).as_posix() for path in tombstone.rglob("*")),
                surviving_files,
            )

    def test_changed_tombstone_inode_blocks_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, control, _toolchain = self._rotated(Path(temporary), versions=3)
            self._interrupt_after_rename(package, control)
            _, tombstones = self._roots(control)
            tombstone = next(tombstones.iterdir())
            original_identity = (tombstone.stat().st_dev, tombstone.stat().st_ino)
            replacement = tombstones / ("replacement-" + tombstone.name)
            shutil.copytree(tombstone, replacement)
            shutil.rmtree(tombstone)
            replacement.rename(tombstone)
            self.assertNotEqual(
                (tombstone.stat().st_dev, tombstone.stat().st_ino), original_identity
            )
            surviving = sorted(path.relative_to(tombstone).as_posix() for path in tombstone.rglob("*"))

            with self.assertRaises(backend.BackendBuildError):
                self._run_retention(package, control)

            self.assertTrue(tombstone.is_dir())
            self.assertEqual(
                sorted(path.relative_to(tombstone).as_posix() for path in tombstone.rglob("*")),
                surviving,
            )

    def test_unexpected_or_linked_tombstone_entry_blocks_recovery(self):
        for linked in (False, True):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as temporary:
                package, control, _toolchain = self._rotated(Path(temporary), versions=3)
                self._interrupt_after_rename(package, control)
                _, tombstones = self._roots(control)
                tombstone = next(tombstones.iterdir())
                if linked:
                    target = Path(temporary) / "outside-target"
                    target.write_text("retain me", encoding="utf-8")
                    injected = tombstone / "unexpected-link"
                    injected.symlink_to(target)
                else:
                    injected = tombstone / "unexpected-file"
                    injected.write_text("retain me", encoding="utf-8")

                with self.assertRaises(backend.BackendBuildError):
                    self._run_retention(package, control)

                self.assertTrue(injected.exists() or injected.is_symlink())
                if linked:
                    self.assertEqual(target.read_text(encoding="utf-8"), "retain me")

    def test_unknown_tombstone_is_rejected_before_any_retirement(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, control, _toolchain = self._rotated(Path(temporary), versions=3)
            intents, tombstones = self._roots(control)
            foreign = tombstones / "foreign-entry"
            foreign.mkdir()
            current_before = self._current(package)
            backups_before = sorted(
                path.name for path in (control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()
            )

            with self.assertRaises(backend.BackendBuildError):
                backend._retain_package_backups(package, control, current_before[0], current_before[1])

            self.assertTrue(foreign.is_dir())
            self.assertFalse(tuple(intents.iterdir()))
            self.assertEqual(
                sorted(path.name for path in (control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()),
                backups_before,
            )
            self.assertEqual(self._current(package)[1], current_before[1])


    def _rotate_once(self, root, package, control, toolchain):
        fixture = _fixture_case("test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain")
        candidate = control / backend.PACKAGE_CANDIDATES_DIRNAME / "candidate-after-retention-crash"
        candidate.mkdir()
        workspace = fixture._package_workspace(root / "retention-after-crash-workspace")
        candidate_records = backend._copy_package(workspace, candidate)
        (candidate / "bin/fullmag-bin").write_bytes(b"retention-after-crash\n")
        candidate_records = backend._hash_package(candidate)
        _, manifest = fixture._live_manifest(
            root, commit="f" * 40, capture_id="retention-after-crash"
        )
        backend._write_json(
            candidate / "backend-build-receipt.json",
            fixture._receipt_for_manifest(candidate_records, manifest, toolchain),
            "retention after-crash receipt",
        )
        previous = backend._validated_package(
            package, "retention pre-crash-rotation", exclude_development_control=True
        )
        rotation = backend._rotate_package(
            package,
            candidate,
            control,
            previous[2],
            previous[1],
            (candidate / "backend-build-receipt.json").read_bytes(),
        )
        backend._finalize_published_candidate(candidate, rotation)
        backend._clear_rotation_journal(rotation)

    def _archive_every_backup(self, package, control):
        archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
        current_receipt = self._current(package)[1]
        current_sha = backend._sha256_bytes(current_receipt)
        for backup in sorted((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()):
            receipt, raw, _ = backend._validated_package(backup, f"archive fixture {backup.name}")
            _rotation, rotation_raw = backend._read_json(backup / "rotation.json", "archive fixture rotation")
            backend._archive_retired_backup(
                backup,
                archive_root,
                current_sha,
                backend._sha256_bytes(raw),
                backend._sha256_bytes(rotation_raw),
            )

    def test_private_intent_temporary_recovery_covers_both_publication_windows(self):
        for crash_on_replace in (1, 2):
            with self.subTest(crash_on_replace=crash_on_replace), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                package, control, _toolchain = self._rotated(root, versions=2)
                original_replace = backend.os.replace
                calls = 0

                def replace_then_interrupt(source, destination):
                    nonlocal calls
                    if Path(destination).parent.name == backend.PACKAGE_RETIREMENT_INTENTS_DIRNAME:
                        calls += 1
                        if calls == crash_on_replace:
                            raise KeyboardInterrupt("simulated crash before intent replacement")
                    return original_replace(source, destination)

                with patch.object(backend.os, "replace", side_effect=replace_then_interrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        self._run_retention(package, control)

                intents, tombstones = self._roots(control)
                self.assertTrue(any(path.name.endswith(".tmp") for path in intents.iterdir()))
                if crash_on_replace == 1:
                    self.assertFalse(tuple(tombstones.iterdir()))
                else:
                    self.assertTrue(tuple(tombstones.iterdir()))
                self._run_retention(package, control)
                self.assertFalse(tuple(intents.iterdir()))
                self.assertFalse(tuple(tombstones.iterdir()))

    def test_archive_staging_crash_is_authenticated_and_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, _toolchain = self._rotated(root, versions=2)
            original_copy = backend._copy_regular_file_fsync
            copied = 0

            def copy_then_interrupt(source, target, name):
                nonlocal copied
                result = original_copy(source, target, name)
                copied += 1
                if copied == 1:
                    raise KeyboardInterrupt("simulated crash during archive staging")
                return result

            with patch.object(backend, "_copy_regular_file_fsync", side_effect=copy_then_interrupt):
                with self.assertRaises(KeyboardInterrupt):
                    self._run_retention(package, control)
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            stages = [path for path in archive_root.iterdir() if ".retention-" in path.name]
            self.assertEqual(len(stages), 1)
            self.assertTrue(tuple(stages[0].iterdir()))

            self._run_retention(package, control)

            self.assertFalse([path for path in archive_root.iterdir() if ".retention-" in path.name])
            self.assertEqual(
                len(tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir())), 1
            )



    def test_archive_staging_cleanup_resumes_after_manifest_then_receipt_unlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, _toolchain = self._rotated(root, versions=2)
            original_rename = backend.os.rename

            def interrupt_before_archive_publish(source, target):
                if ".retention-" in Path(source).name:
                    raise KeyboardInterrupt("simulated crash before archive publication")
                return original_rename(source, target)

            with patch.object(backend.os, "rename", side_effect=interrupt_before_archive_publish):
                with self.assertRaises(KeyboardInterrupt):
                    self._run_retention(package, control)
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            stage = next(path for path in archive_root.iterdir() if ".retention-" in path.name)
            self.assertEqual(
                {path.name for path in stage.iterdir()},
                {"backend-build-receipt.json", "rotation.json", "retention.json"},
            )
            original_unlink = backend._unlink_archive_staging_entry
            order = []

            def unlink_then_interrupt(path, entry_name):
                order.append(entry_name)
                original_unlink(path, entry_name)
                if entry_name == "backend-build-receipt.json":
                    raise KeyboardInterrupt("simulated crash during stage cleanup")

            with patch.object(backend, "_unlink_archive_staging_entry", side_effect=unlink_then_interrupt):
                with self.assertRaises(KeyboardInterrupt):
                    self._run_retention(package, control)
            self.assertEqual(order[:2], ["retention.json", "backend-build-receipt.json"])
            self.assertEqual({path.name for path in stage.iterdir()}, {"rotation.json"})

            self._run_retention(package, control)

            self.assertFalse([path for path in archive_root.iterdir() if ".retention-" in path.name])
            self.assertEqual(len(tuple(archive_root.iterdir())), 1)

    def test_archive_staging_unknown_or_linked_entries_are_preserved_and_blocked(self):
        for linked in (False, True):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                package, control, _toolchain = self._rotated(root, versions=2)
                original_copy = backend._copy_regular_file_fsync

                def copy_then_interrupt(source, target, name):
                    result = original_copy(source, target, name)
                    raise KeyboardInterrupt("simulated crash during archive staging")

                with patch.object(backend, "_copy_regular_file_fsync", side_effect=copy_then_interrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        self._run_retention(package, control)
                archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
                stage = next(path for path in archive_root.iterdir() if ".retention-" in path.name)
                if linked:
                    target = root / "outside-stage-target"
                    target.write_text("retain me", encoding="utf-8")
                    injected = stage / "unexpected-link"
                    injected.symlink_to(target)
                else:
                    injected = stage / "unexpected-file"
                    injected.write_text("retain me", encoding="utf-8")
                with self.assertRaises(backend.BackendBuildError):
                    self._run_retention(package, control)
                self.assertTrue(injected.exists() or injected.is_symlink())
                self.assertTrue(stage.is_dir())
                if linked:
                    self.assertEqual(target.read_text(encoding="utf-8"), "retain me")

    def test_archive_created_before_intent_survives_later_current_rotation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, toolchain = self._rotated(root, versions=3)
            original_current = self._current(package)[1]
            with patch.object(
                backend,
                "_create_retirement_intent",
                side_effect=KeyboardInterrupt("simulated interruption after archive commit"),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    self._run_retention(package, control)
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            self.assertTrue(tuple(archive_root.iterdir()))

            self._rotate_once(root, package, control, toolchain)
            self.assertNotEqual(self._current(package)[1], original_current)
            self._run_retention(package, control)

            self.assertEqual(
                len(tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir())), 1
            )
            self.assertFalse(tuple(self._roots(control)[0].iterdir()))
            self.assertFalse(tuple(self._roots(control)[1].iterdir()))

    def test_archive_prune_unlink_crash_resumes_and_keeps_current_and_backups(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, _toolchain = self._rotated(root, versions=3)
            current_before = self._current(package)[1]
            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            direct = _fixture_case("test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain")._direct_backup_for_current(
                control, current_before
            )
            direct_identity = (direct.stat().st_dev, direct.stat().st_ino)
            backups_before = {path.name: (path.stat().st_dev, path.stat().st_ino) for path in backups_root.iterdir()}
            self._archive_every_backup(package, control)
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            original_unlink = backend._unlink_retirement_entry
            removed = 0

            def unlink_then_interrupt(parent, entry_name):
                nonlocal removed
                original_unlink(parent, entry_name)
                removed += 1
                if removed == 1:
                    raise KeyboardInterrupt("simulated crash during archive pruning")

            with patch.object(backend, "PACKAGE_RETENTION_ARCHIVE_COUNT_LIMIT", 1):
                with patch.object(backend, "_unlink_retirement_entry", side_effect=unlink_then_interrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        backend._prune_retention_archives(archive_root)
                self.assertTrue(tuple(self._roots(control)[0].iterdir()))
                self.assertTrue(tuple(self._roots(control)[1].iterdir()))
                backend._prune_retention_archives(archive_root)

            self.assertEqual(self._current(package)[1], current_before)
            self.assertEqual(
                (direct.stat().st_dev, direct.stat().st_ino), direct_identity
            )
            self.assertEqual(
                {path.name: (path.stat().st_dev, path.stat().st_ino) for path in backups_root.iterdir()},
                backups_before,
            )
            self.assertEqual(len(tuple(archive_root.iterdir())), 1)
            self.assertFalse(tuple(self._roots(control)[0].iterdir()))
            self.assertFalse(tuple(self._roots(control)[1].iterdir()))

    def test_tampered_archive_retirement_manifest_blocks_pruning(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, _toolchain = self._rotated(root, versions=3)
            self._archive_every_backup(package, control)
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            original_rename = backend._rename_backup_to_tombstone

            def rename_then_interrupt(source, target, backup_name):
                original_rename(source, target, backup_name)
                raise KeyboardInterrupt("simulated crash after archive rename")

            with patch.object(backend, "PACKAGE_RETENTION_ARCHIVE_COUNT_LIMIT", 1):
                with patch.object(backend, "_rename_backup_to_tombstone", side_effect=rename_then_interrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        backend._prune_retention_archives(archive_root)
                _, tombstones = self._roots(control)
                tombstone = next(path for path in tombstones.iterdir() if path.name.startswith("archive-"))
                manifest_path = tombstone / "retention.json"
                manifest, _ = backend._read_json(manifest_path, "archive tombstone manifest")
                manifest["current_receipt_sha256"] = "0" * 64
                backend._write_json(manifest_path, manifest, "tampered archive tombstone manifest")
                before = sorted(path.name for path in tombstone.iterdir())
                with self.assertRaises(backend.BackendBuildError):
                    backend._prune_retention_archives(archive_root)
                self.assertEqual(sorted(path.name for path in tombstone.iterdir()), before)

    def test_runtime_lock_contention_has_typed_busy_error_and_maintenance_exit_75(self):
        self.assertTrue(issubclass(backend.BackendBuildBusy, backend.BackendBuildError))
        with patch.object(backend, "_maintain_packages", side_effect=backend.BackendBuildBusy("busy")):
            with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
                self.assertEqual(backend.main(["maintain-packages"]), 75)
        with patch.object(backend, "_start", side_effect=backend.BackendBuildBusy("busy")):
            with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
                self.assertEqual(backend.main(["start"]), 2)
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "manifest.json"
            manifest.write_text("{}", encoding="utf-8")
            with patch.object(backend, "_prepare", side_effect=backend.BackendBuildBusy("busy")):
                with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
                    self.assertEqual(backend.main(["prepare", "--manifest", str(manifest)]), 2)


if __name__ == "__main__":
    unittest.main()
