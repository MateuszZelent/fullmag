"""Interpreted shared-package crash and concurrency regressions."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker/all-in-one"))
import backend_dev as backend
import backend_shared_store as shared
import test_docker_backend_dev as fixtures


class SharedRecoveryTests(unittest.TestCase):
    def test_interrupted_shared_restore_is_recovered_without_changing_payload(self):
        for complete, private_receipt, interrupt_cleanup in ((False, False, False), (True, False, False), (True, True, False), (True, True, True)):
            with self.subTest(complete=complete, receipt=private_receipt), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                fixture = fixtures.BackendPackageTests()
                producer, records = fixture._published_package(root / "producer")
                _, manifest = fixture._live_manifest(root)
                receipt = fixture._receipt_for_manifest(records, manifest, fixture._toolchain_fixture())
                store_root = root / "store"
                store_root.mkdir()
                store = shared.Store(store_root)
                package = root / "package"
                package.mkdir()
                build = root / "build"
                build.mkdir()
                control = backend._ensure_package_development_root(package)
                candidate = Path(tempfile.mkdtemp(prefix=".backend-package-candidate-", dir=control / backend.PACKAGE_CANDIDATES_DIRNAME))
                backend._write_candidate_marker(candidate, package, build, state="building")
                with store.claim({"source": "fixture"}) as entry:
                    entry.publish(producer, receipt)
                    backend._write_candidate_marker(candidate, package, build, state="building",
                        shared_restore={"key": entry.key, "artifacts": records})
                    if complete:
                        entry.restore(candidate, entry.read())
                    else:
                        relative = records[0]["path"]
                        target = candidate / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        os.link(entry.path / relative, target)
                    if private_receipt:
                        backend._write_json(candidate / "backend-build-receipt.json", receipt, "consumer receipt")
                    before = {r["path"]: ((producer / r["path"]).read_bytes(), (producer / r["path"]).stat().st_mode) for r in records}
                if interrupt_cleanup:
                    class SimulatedStop(BaseException):
                        pass
                    unlink = Path.unlink
                    def stop_after_payload_unlink(path, *args, **kwargs):
                        result = unlink(path, *args, **kwargs)
                        if candidate in path.parents and path.name != backend.PACKAGE_CANDIDATE_MARKER:
                            raise SimulatedStop()
                        return result
                    with patch.object(Path, "unlink", stop_after_payload_unlink):
                        with self.assertRaises(SimulatedStop):
                            backend._reject_partial_package_candidates(package, control, build)
                    self.assertTrue((candidate / backend.PACKAGE_CANDIDATE_MARKER).is_file())
                backend._reject_partial_package_candidates(package, control, build)
                self.assertFalse(candidate.exists())
                for relative, expected in before.items():
                    path = producer / relative
                    self.assertEqual((path.read_bytes(), path.stat().st_mode), expected)
                with store.claim({"source": "fixture"}) as entry:
                    self.assertIsNotNone(entry.read())

    def test_other_group_restore_or_gc_does_not_invalidate_rotation(self):
        for action in ("restore", "gc"):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                fixture = fixtures.BackendPackageTests()
                package, build, control, candidate, _, candidate_bytes = fixture._ready_rotation_fixture(root, ".backend-package-candidate-shared-race")
                store_root = root / "store"
                store_root.mkdir()
                store = shared.Store(store_root)
                receipt, _, _ = backend._validated_package(package, "current", exclude_development_control=True)
                with store.claim({"source": "fixture"}) as entry:
                    entry.publish(package, receipt)
                previous = backend._validated_package(package, "current", exclude_development_control=True)
                if action == "restore":
                    other = root / "other-group"
                    other.mkdir()
                    with store.claim({"source": "fixture"}) as entry:
                        entry.restore(other, entry.read())
                else:
                    store.collect(max_entries=0)
                rotation = backend._rotate_package(package, candidate, control, previous[2], previous[1], candidate_bytes)
                self.assertIsInstance(rotation, dict)
                backend._validated_package(package, "rotated", exclude_development_control=True)

    def test_ready_publisher_and_cache_hit_recover_without_make_attempt(self):
        import backend_shared_recovery as recovery
        for operation, evicted in (("direct-compose-build", False), ("direct-compose-cache-reuse", False), ("direct-compose-cache-reuse", True)):
            with self.subTest(operation=operation, evicted=evicted), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                fixture = fixtures.BackendPackageTests()
                store_root = root / "store"
                store_root.mkdir()
                store = shared.Store(store_root)
                group = "groups/" + "a" * 64
                package = store_root / group
                package.mkdir(parents=True)
                build = root / "build"
                build.mkdir()
                archive = root / "control"
                archive.mkdir()
                control = backend._ensure_package_development_root(package)
                candidate = Path(tempfile.mkdtemp(prefix=".backend-package-candidate-", dir=control / backend.PACKAGE_CANDIDATES_DIRNAME))
                backend._write_candidate_marker(candidate, package, build, state="building")
                workspace = fixture._package_workspace(root / "source")
                records = fixture._copy_into_marked_candidate(workspace, candidate, package, build)
                (candidate / "bin/fullmag").unlink()
                manifest_path, manifest = fixture._live_manifest(root)
                toolchain = fixture._toolchain_fixture()
                receipt = fixture._receipt_for_manifest(records, manifest, toolchain)
                receipt["source"]["runtime_source_digest"] = backend._runtime_source_digest(backend._validate_live_manifest(manifest)[0])
                identity = backend._shared_package_identity(manifest_path, toolchain, None)
                receipt["operation"] = operation
                receipt["shared_package"] = {"schema": shared.SCHEMA, "key": shared.key_for(identity), "inputs": identity}
                backend._write_json(candidate / "backend-build-receipt.json", receipt, "shared ready receipt")
                with store.claim(identity) as entry:
                    entry.publish(candidate, receipt)
                if evicted:
                    store.collect(max_entries=0)
                # New worktree content must not strand a valid old ready payload.
                fixture._live_manifest(root, commit="b" * 40, capture_id="new-source")
                with patch.object(shared, "ROOT", store_root), patch.object(backend, "BACKEND_CONTROL_ROOT", archive), \
                        patch.dict(os.environ, {"FULLMAG_SHARED_BACKEND_STORE": str(store_root), "FULLMAG_SHARED_BACKEND_GROUP": group}):
                    recovery.recover_ready(backend, package, control, build)
                self.assertFalse(candidate.exists())
                self.assertEqual(backend._candidate_retirement_entries(control), [])
                self.assertIsNone(backend._read_failed_make_attempt(build, candidate))
                self.assertTrue((archive / "shared-candidate-recovery.json").is_file())
                self.assertIn(b"direct build fixture", (archive / "shared-candidate-recovery.log").read_bytes())
                with store.claim(identity) as entry:
                    self.assertEqual(entry.read()["receipt"]["artifacts"], records)

    def test_sealed_package_content_tampering_still_fails_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = fixtures.BackendPackageTests()
            package, records = fixture._published_package(root / "producer")
            _, manifest = fixture._live_manifest(root)
            receipt = fixture._receipt_for_manifest(records, manifest, fixture._toolchain_fixture())
            backend._write_json(package / "backend-build-receipt.json", receipt, "fixture receipt")
            store_root = root / "store"
            store_root.mkdir()
            store = shared.Store(store_root)
            with store.claim({"source": "fixture"}) as entry:
                entry.publish(package, receipt)
            target = package / "_fullmag_core.so"
            original_mode = target.stat().st_mode & 0o777
            target.chmod(original_mode | 0o200)
            target.write_bytes(b"tampered")
            target.chmod(original_mode)
            with self.assertRaises(backend.BackendBuildError):
                backend._validated_package(package, "tampered package")


if __name__ == "__main__":
    unittest.main()
