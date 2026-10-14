"""Interpreted fixture publication checks; no native build or solver."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


@unittest.skipUnless(os.name == "nt", "Windows native writer lock contract")
class FixturePublicationChecks(unittest.TestCase):
    def setUp(self):
        import msvcrt
        import verify_development_backend_api as verifier
        self.msvcrt = msvcrt
        self.verifier = verifier
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ["FULLMAG_TEST_TEMP_ROOT"])
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = self.root / "store"
        self.store.mkdir()
        self.lock = self.store / "WRITER.lock"
        self.original = b"fullmag.writer.lock.v1\n"
        self.lock.write_bytes(self.original)
        self.target = self.store / "runs/fixture/preparation_resource_leases/outside/lease.json"

    def acquire(self, descriptor):
        descriptor.seek(0)
        self.msvcrt.locking(descriptor.fileno(), self.msvcrt.LK_NBLCK, 1)

    def release(self, descriptor):
        descriptor.seek(0)
        self.msvcrt.locking(descriptor.fileno(), self.msvcrt.LK_UNLCK, 1)

    def assert_released(self):
        with self.lock.open("r+b", buffering=0) as descriptor:
            self.acquire(descriptor)
            self.release(descriptor)

    def test_atomic_publication_holds_native_lock_and_preserves_descriptor(self):
        original_atomic = self.verifier.storage.atomic_json
        inode = self.lock.stat().st_ino

        def observe(path, document):
            with self.lock.open("r+b", buffering=0) as competitor:
                with self.assertRaises(OSError):
                    self.acquire(competitor)
            original_atomic(path, document)

        with patch.object(self.verifier.storage, "atomic_json", side_effect=observe):
            self.verifier._publish_owned_store_fixture_json(self.store, self.target, {"state": "active"})
        self.assertEqual(json.loads(self.target.read_text()), {"state": "active"})
        self.assertEqual(self.lock.read_bytes(), self.original)
        self.assertEqual(self.lock.stat().st_ino, inode)
        self.assert_released()

    def test_contended_writer_prevents_publication_until_released(self):
        retried = threading.Event()
        failures = []
        original_sleep = time.sleep

        def wait(seconds):
            retried.set()
            original_sleep(seconds)

        def publish():
            try:
                self.verifier._publish_owned_store_fixture_json(self.store, self.target, {"state": "released"})
            except Exception as error:
                failures.append(error)

        with self.lock.open("r+b", buffering=0) as holder:
            self.acquire(holder)
            with patch.object(self.verifier.time, "sleep", side_effect=wait):
                worker = threading.Thread(target=publish)
                worker.start()
                try:
                    self.assertTrue(retried.wait(2), "fixture did not observe the competing writer")
                    self.assertFalse(self.target.exists())
                finally:
                    self.release(holder)
                    worker.join(timeout=3)
                self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(json.loads(self.target.read_text()), {"state": "released"})
        self.assert_released()

    def test_publication_failure_releases_lock(self):
        with patch.object(self.verifier.storage, "atomic_json", side_effect=OSError("fixture publication failed")):
            with self.assertRaisesRegex(OSError, "fixture publication failed"):
                self.verifier._publish_owned_store_fixture_json(self.store, self.target, {})
        self.assertEqual(self.lock.read_bytes(), self.original)
        self.assert_released()

    def test_missing_or_invalid_descriptor_is_not_created_or_repaired(self):
        self.lock.unlink()
        with self.assertRaises(FileNotFoundError):
            self.verifier._publish_owned_store_fixture_json(self.store, self.target, {})
        self.assertFalse(self.lock.exists())
        self.lock.write_bytes(b"unknown descriptor")
        with self.assertRaisesRegex(self.verifier.storage.StorageError, "descriptor"):
            self.verifier._publish_owned_store_fixture_json(self.store, self.target, {})
        self.assertEqual(self.lock.read_bytes(), b"unknown descriptor")
        self.assertFalse(self.target.exists())
        self.assert_released()

    def test_publication_outside_owned_store_is_refused(self):
        outside = self.root / "outside.json"
        with self.assertRaises(self.verifier.storage.StorageError):
            self.verifier._publish_owned_store_fixture_json(self.store, outside, {})
        self.assertFalse(outside.exists())
        self.assert_released()
