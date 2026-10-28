"""Interpreted concurrency and storage tests; never compiles native tests."""
import hashlib
import json
import multiprocessing as mp
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker" / "all-in-one"))
import backend_shared_store as shared


def payload(root, data=b"binary"):
    root.mkdir(parents=True, exist_ok=True)
    (root / "bin").mkdir()
    path = root / "bin" / "worker"
    path.write_bytes(data)
    path.chmod(0o755)
    return {"state": "succeeded", "artifacts": [{"path": "bin/worker",
        "size": len(data), "mode": "100755", "sha256": hashlib.sha256(data).hexdigest()}]}


def concurrent_builder(root, identity, candidate, counter):
    store = shared.Store(root)
    with store.claim(identity, timeout=5) as entry:
        cached = entry.read()
        if cached is None:
            receipt = payload(Path(candidate))
            with open(counter, "a") as stream:
                stream.write("build\n")
            time.sleep(0.15)
            entry.publish(Path(candidate), receipt)
        else:
            Path(candidate).mkdir()
            entry.restore(Path(candidate), cached)


def hold_claim(root, ready):
    with shared.Store(root).claim({"source": "same"}):
        ready.set()
        time.sleep(30)


class SharedStoreTests(unittest.TestCase):
    def test_equal_inputs_share_files_and_have_single_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = root / "store"
            store.mkdir()
            shared.Store(store)
            counter = root / "builds"
            context = mp.get_context("fork")
            processes = [context.Process(target=concurrent_builder, args=(store, {"source": "same"}, root / f"group{i}", counter)) for i in range(3)]
            for process in processes:
                process.start()
            for process in processes:
                process.join(10)
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(counter.read_text(), "build\n")
            self.assertEqual(len({(root / f"group{i}/bin/worker").stat().st_ino for i in range(3)}), 1)

    def test_different_inputs_do_not_serialize_builds(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = shared.Store(temporary)
            with store.claim({"source": "a"}, timeout=0):
                with store.claim({"source": "b"}, timeout=0):
                    pass
                with self.assertRaises(shared.StoreError):
                    with store.claim({"source": "a"}, timeout=0):
                        pass

    def test_eviction_preserves_current_and_rollback_hardlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = shared.Store(root)
            candidate = root / "group"
            receipt = payload(candidate)
            with store.claim({"source": "a"}) as entry:
                entry.publish(candidate, receipt)
                restored = root / "rollback"
                restored.mkdir()
                entry.restore(restored, entry.read())
            result = store.collect(max_entries=0)
            self.assertEqual(len(result["evicted"]), 1)
            self.assertEqual((candidate / "bin/worker").read_bytes(), b"binary")
            self.assertEqual((restored / "bin/worker").read_bytes(), b"binary")
            self.assertEqual((candidate / "bin/worker").stat().st_nlink, 2)

    def test_gc_refuses_active_publishers_without_deleting(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = shared.Store(temporary)
            with store.claim({"source": "a"}):
                with self.assertRaises(shared.StoreError):
                    store.collect(max_entries=0)

    def test_dead_publisher_releases_kernel_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            shared.Store(temporary)
            context = mp.get_context("fork")
            ready = context.Event()
            process = context.Process(target=hold_claim, args=(temporary, ready))
            process.start()
            self.assertTrue(ready.wait(5))
            process.terminate()
            process.join(5)
            with shared.Store(temporary).claim({"source": "same"}, timeout=0) as entry:
                self.assertIsNone(entry.read())

    def test_corruption_unrecorded_files_and_links_fail_closed(self):
        for corruption in ("bytes", "foreign", "symlink"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                store = shared.Store(root)
                receipt = payload(root / "group")
                with store.claim({"source": "a"}) as entry:
                    entry.publish(root / "group", receipt)
                    target = entry.path / "bin/worker"
                    if corruption == "bytes":
                        target.chmod(0o755)
                        target.write_bytes(b"broken")
                        target.chmod(0o555)
                    elif corruption == "foreign":
                        (entry.path / "foreign").write_bytes(b"retain")
                    else:
                        target.unlink()
                        target.symlink_to(root / "group/bin/worker")
                    with self.assertRaises(shared.StoreError):
                        entry.read()
                    with self.assertRaises(shared.StoreError):
                        store.collect(max_entries=0)
                    self.assertTrue(entry.path.exists())

    def test_interrupted_publish_never_exposes_partial_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = shared.Store(root)
            receipt = payload(root / "group")
            with store.claim({"source": "a"}) as entry:
                with patch.object(shared.os, "rename", side_effect=OSError("disk full")):
                    with self.assertRaises(OSError):
                        entry.publish(root / "group", receipt)
                self.assertIsNone(entry.read())
                self.assertEqual(list((root / "staging").iterdir()), [])
                self.assertEqual((root / "group/bin/worker").read_bytes(), b"binary")

    def test_interrupted_gc_never_exposes_a_partial_cache_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = shared.Store(root)
            receipt = payload(root / "group")
            with store.claim({"source": "a"}) as entry:
                entry.publish(root / "group", receipt)
            class SimulatedStop(BaseException):
                pass
            with patch.object(shared.shutil, "rmtree", side_effect=SimulatedStop()):
                with self.assertRaises(SimulatedStop):
                    store.collect(max_entries=0)
            self.assertFalse(entry.path.exists())
            self.assertEqual((root / "group/bin/worker").read_bytes(), b"binary")
            with store.claim({"source": "a"}) as entry:
                self.assertIsNone(entry.read())
                entry.publish(root / "group", receipt)
                self.assertIsNotNone(entry.read())

    def test_package_alias_must_prove_same_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = shared.Store(root)
            group = "groups/" + "a" * 64
            package = root / group
            candidate = package / ".development/candidates/test"
            candidate.mkdir(parents=True)
            self.assertEqual(store.private_alias(package, candidate, group), candidate)
            foreign = root / "foreign"
            foreign.mkdir()
            with self.assertRaises(shared.StoreError):
                store.private_alias(foreign, foreign, group)
            with self.assertRaises(shared.StoreError):
                store.private_alias(package, candidate, "groups/../wrong")

    def test_symlink_or_hardlink_lock_is_rejected(self):
        for linked in ("symlink", "hardlink"):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                store = shared.Store(root)
                original = root / "original"
                original.write_text("")
                lock = root / "locks" / shared.key_for({"source": "a"})
                if linked == "symlink":
                    lock.symlink_to(original)
                else:
                    os.link(original, lock)
                with self.assertRaises((shared.StoreError, OSError)):
                    with store.claim({"source": "a"}, timeout=0):
                        pass

    def test_input_identity_separates_commit_toolchain_and_cuda(self):
        base = {"commit": "a", "toolchain": "x", "cuda": "89-real"}
        keys = {shared.key_for(base)}
        for field in base:
            keys.add(shared.key_for({**base, field: "changed"}))
        self.assertEqual(len(keys), 4)


if __name__ == "__main__":
    unittest.main()
