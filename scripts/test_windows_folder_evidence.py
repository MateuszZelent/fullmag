"""Interpreted publication failure regressions for Docker Windows attestations."""
import ctypes
import json
import hashlib
import os
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import windows_folder_host as host


class _FakeWinFunction:
    def __init__(self, callback):
        self._callback = callback
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self._callback(*args)


class _FakeKernel32:
    def __init__(self, move, attributes=0x20):
        self.MoveFileExW = _FakeWinFunction(move)
        self.GetFileAttributesW = _FakeWinFunction(lambda path: attributes)


class WindowsFolderEvidence(unittest.TestCase):
    @staticmethod
    def _assembly(binary_hashes):
        return {
            "image_id": "sha256:" + "1" * 64,
            "commit": "a" * 40,
            "build_receipt_sha256": "b" * 64,
            "source_digest": "f" * 64,
            "source_snapshot_sha256": "d" * 64,
            "binary_hashes": binary_hashes,
        }

    @staticmethod
    def _development_build(binary_hashes):
        return {
            "schema": host.DEVELOPMENT_BUILD_SCHEMA,
            "cargo_profile": "backend-dev",
            "toolchain_image_id": "sha256:" + "2" * 64,
            "package_root": "/opt/fullmag/package",
            "provenance_path": host.DEVELOPMENT_PROVENANCE_PATH,
            "group_identity": "fullmag-worktree-test",
            "source_identity": {
                "commit": "a" * 40,
                "source_digest": "c" * 64,
                "source_snapshot_sha256": "e" * 64,
                "native_source_identity_sha256": "d" * 64,
            },
        }

    def test_development_build_rejects_host_visible_provenance_path(self):
        development_build = self._development_build({"fullmag": "e" * 64})
        self.assertEqual(host._validate_development_build(development_build), development_build)
        development_build["provenance_path"] = "/opt/fullmag/provenance.json"
        with self.assertRaisesRegex(ValueError, "provenance path is invalid"):
            host._validate_development_build(development_build)

    def test_flush_failure_retains_the_previously_published_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            with patch.object(host.os, "fsync", side_effect=OSError("flush failed")), \
                    patch.object(host, "_replace_write_through") as replace:
                with self.assertRaisesRegex(OSError, "flush failed"):
                    host.publish_evidence(target, {"owner": "new"})
                replace.assert_not_called()
            self.assertEqual(json.loads(target.read_text()), {"owner": "original"})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_replacement_failure_retains_the_previously_published_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            with patch.object(host, "_replace_write_through", side_effect=OSError("publish failed")):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    host.publish_evidence(target, {"owner": "new"})
            self.assertEqual(json.loads(target.read_text()), {"owner": "original"})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_successfully_published_evidence_is_complete_and_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            value = {"owner": "new", "checks": {"restart": True}}
            host.publish_evidence(target, value)
            self.assertEqual(json.loads(target.read_text()), value)
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_bound_writer_updates_the_existing_certificate_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}\n', encoding="utf-8")
            inode = target.stat().st_ino
            value = {"owner": "new", "checks": {"restart": True}}
            digest = host.write_bound_evidence(target, value)
            self.assertEqual(json.loads(target.read_text()), value)
            self.assertEqual(target.stat().st_ino, inode)
            self.assertEqual(
                digest,
                hashlib.sha256(
                    (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
                ).hexdigest(),
            )

    def test_bound_writer_write_failure_restores_bytes_and_keeps_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            original = b'{"owner": "original"}\n'
            target.write_bytes(original)
            inode = target.stat().st_ino
            real_fsync = host.os.fsync
            calls = 0

            def fail_once(fd):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("flush failed")
                return real_fsync(fd)

            with patch.object(host.os, "fsync", side_effect=fail_once), \
                    patch.object(host.os, "replace") as replace:
                with self.assertRaisesRegex(OSError, "flush failed"):
                    host.write_bound_evidence(target, {"owner": "new"})
                replace.assert_not_called()
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(target.stat().st_ino, inode)

    def test_bound_writer_rejects_final_and_ancestor_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_parent = root / "real"
            real_parent.mkdir()
            target = real_parent / "host.json"
            target.write_text('{"owner": "original"}\n', encoding="utf-8")
            final_link = root / "final.json"
            final_link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "reparse point"):
                host.write_bound_evidence(final_link, {"owner": "new"})

            parent_link = root / "linked-parent"
            parent_link.symlink_to(real_parent, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "reparse point"):
                host.write_bound_evidence(parent_link / "host.json", {"owner": "new"})


    def test_replace_target_identity_rejects_dangling_reparse_point(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "host.json"
            target.symlink_to(root / "missing.json")
            with self.assertRaisesRegex(ValueError, "reparse point"):
                host._replace_target_identity(target)

    def test_windows_replace_retries_known_sharing_errors_then_succeeds(self):
        for error_code in (5, 32, 33):
            with self.subTest(error_code=error_code), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "incoming.tmp"
                target = root / "host.json"
                source.write_text("new", encoding="utf-8")
                target.write_text("old", encoding="utf-8")
                calls = []
                clock = type("Clock", (), {"now": 0.0})()

                def move(source_name, destination_name, flags):
                    calls.append((source_name, destination_name, flags))
                    if len(calls) == 1:
                        return 0
                    os.replace(source_name, destination_name)
                    return 1

                api = _FakeKernel32(move)
                with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                        patch.object(host, "_pinned_replacement_parents", return_value=nullcontext()), \
                        patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                        patch.object(host.ctypes, "get_last_error", return_value=error_code, create=True), \
                        patch.object(host.ctypes, "WinError", create=True,
                                     side_effect=lambda code: OSError(code, "winerror")), \
                        patch.object(host.time, "monotonic",
                                     side_effect=lambda: clock.now), \
                        patch.object(host.time, "sleep",
                                     side_effect=lambda delay: setattr(clock, "now", clock.now + delay)):
                    host._replace_write_through(source, target)
                self.assertEqual(len(calls), 2)
                self.assertEqual(target.read_text(encoding="utf-8"), "new")


    def test_windows_replace_holds_parent_guard_for_all_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incoming.tmp"
            target = root / "host.json"
            source.write_text("new", encoding="utf-8")
            target.write_text("old", encoding="utf-8")
            calls = []
            state = {"active": False, "events": []}
            clock = type("Clock", (), {"now": 0.0})()

            @contextmanager
            def guard(_source, _destination):
                state["events"].append("enter")
                state["active"] = True
                try:
                    yield
                finally:
                    state["active"] = False
                    state["events"].append("exit")

            def move(source_name, destination_name, flags):
                self.assertTrue(state["active"])
                calls.append((source_name, destination_name, flags))
                if len(calls) == 1:
                    return 0
                os.replace(source_name, destination_name)
                return 1

            api = _FakeKernel32(move)
            with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                    patch.object(host, "_pinned_replacement_parents", side_effect=guard), \
                    patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                    patch.object(host.ctypes, "get_last_error", return_value=5, create=True), \
                    patch.object(host.ctypes, "WinError", create=True,
                                 side_effect=lambda code: OSError(code, "winerror")), \
                    patch.object(host.time, "monotonic",
                                 side_effect=lambda: clock.now), \
                    patch.object(host.time, "sleep",
                                 side_effect=lambda delay: setattr(clock, "now", clock.now + delay)):
                host._replace_write_through(source, target)
            self.assertEqual(len(calls), 2)
            self.assertEqual(state["events"], ["enter", "exit"])
            self.assertFalse(state["active"])
            self.assertEqual(target.read_text(encoding="utf-8"), "new")

    def test_windows_replace_rejects_readonly_destination_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incoming.tmp"
            target = root / "host.json"
            source.write_text("new", encoding="utf-8")
            target.write_text("old", encoding="utf-8")
            calls = []

            def move(source_name, destination_name, flags):
                calls.append((source_name, destination_name, flags))
                return 0

            api = _FakeKernel32(move, attributes=0x20 | 0x1)
            with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                    patch.object(host, "_pinned_replacement_parents", return_value=nullcontext()), \
                    patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                    patch.object(host.ctypes, "get_last_error", return_value=5, create=True), \
                    patch.object(host.ctypes, "WinError", create=True,
                                 side_effect=lambda code: OSError(code, "winerror")), \
                    patch.object(host.time, "monotonic", return_value=0.0):
                with self.assertRaises(OSError):
                    host._replace_write_through(source, target)
            self.assertEqual(len(calls), 1)
            self.assertEqual(target.read_text(encoding="utf-8"), "old")

    def test_windows_replace_rejects_destination_identity_change_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incoming.tmp"
            target = root / "host.json"
            source.write_text("new", encoding="utf-8")
            target.write_text("old", encoding="utf-8")
            calls = []

            def move(source_name, destination_name, flags):
                calls.append((source_name, destination_name, flags))
                target.write_text("changed", encoding="utf-8")
                return 0

            api = _FakeKernel32(move)
            with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                    patch.object(host, "_pinned_replacement_parents", return_value=nullcontext()), \
                    patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                    patch.object(host.ctypes, "get_last_error", return_value=5, create=True), \
                    patch.object(host.ctypes, "WinError", create=True,
                                 side_effect=lambda code: OSError(code, "winerror")), \
                    patch.object(host.time, "monotonic", return_value=0.0):
                with self.assertRaises(OSError):
                    host._replace_write_through(source, target)
            self.assertEqual(len(calls), 1)
            self.assertEqual(target.read_text(encoding="utf-8"), "changed")


    def test_windows_replace_rechecks_identity_after_wait_and_preserves_pending_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incoming.tmp"
            target = root / "host.json"
            source.write_text("pending", encoding="utf-8")
            target.write_text("published", encoding="utf-8")
            calls = []

            def move(source_name, destination_name, flags):
                calls.append((source_name, destination_name, flags))
                return 0

            def mutate_during_sleep(_delay):
                metadata = target.stat()
                os.utime(
                    target,
                    ns=(metadata.st_atime_ns, metadata.st_mtime_ns + 1_000_000_000),
                )

            api = _FakeKernel32(move)
            with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                    patch.object(host, "_pinned_replacement_parents", return_value=nullcontext()), \
                    patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                    patch.object(host.ctypes, "get_last_error", return_value=5, create=True), \
                    patch.object(host.ctypes, "WinError", create=True,
                                 side_effect=lambda code: OSError(code, "winerror")), \
                    patch.object(host.time, "monotonic", return_value=0.0), \
                    patch.object(host.time, "sleep", side_effect=mutate_during_sleep):
                with self.assertRaises(OSError):
                    host._replace_write_through(source, target)
            self.assertEqual(len(calls), 1)
            self.assertEqual(source.read_text(encoding="utf-8"), "pending")
            self.assertEqual(target.read_text(encoding="utf-8"), "published")

    def test_windows_replace_does_not_retry_nonsharing_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incoming.tmp"
            target = root / "host.json"
            source.write_text("pending", encoding="utf-8")
            target.write_text("published", encoding="utf-8")
            calls = []

            def move(source_name, destination_name, flags):
                calls.append((source_name, destination_name, flags))
                return 0

            api = _FakeKernel32(move)
            with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                    patch.object(host, "_pinned_replacement_parents", return_value=nullcontext()), \
                    patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                    patch.object(host.ctypes, "get_last_error", return_value=87, create=True), \
                    patch.object(host.ctypes, "WinError", create=True,
                                 side_effect=lambda code: OSError(code, "winerror")):
                with self.assertRaises(OSError):
                    host._replace_write_through(source, target)
            self.assertEqual(len(calls), 1)
            self.assertEqual(source.read_text(encoding="utf-8"), "pending")
            self.assertEqual(target.read_text(encoding="utf-8"), "published")

    def test_windows_replace_stops_known_sharing_retry_at_one_second(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incoming.tmp"
            target = root / "host.json"
            source.write_text("new", encoding="utf-8")
            target.write_text("old", encoding="utf-8")
            calls = []
            clock = type("Clock", (), {"now": 0.0})()

            def move(source_name, destination_name, flags):
                calls.append((source_name, destination_name, flags))
                return 0

            api = _FakeKernel32(move)
            with patch.object(host, "os", SimpleNamespace(name="nt", replace=os.replace)), \
                    patch.object(host, "_pinned_replacement_parents", return_value=nullcontext()), \
                    patch.object(host.ctypes, "WinDLL", return_value=api, create=True), \
                    patch.object(host.ctypes, "get_last_error", return_value=5, create=True), \
                    patch.object(host.ctypes, "WinError", create=True,
                                 side_effect=lambda code: OSError(code, "winerror")), \
                    patch.object(host.time, "monotonic",
                                 side_effect=lambda: clock.now), \
                    patch.object(host.time, "sleep",
                                 side_effect=lambda delay: setattr(clock, "now", clock.now + delay)):
                with self.assertRaises(OSError):
                    host._replace_write_through(source, target)
            self.assertGreaterEqual(clock.now, 1.0)
            self.assertEqual(len(calls), 21)
            self.assertEqual(target.read_text(encoding="utf-8"), "old")

    @unittest.skipUnless(os.name == "nt", "native Windows only")
    def test_native_reader_without_delete_share_releases_after_200ms(self):
        from ctypes import wintypes

        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        api.CreateFileW.restype = wintypes.HANDLE
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        api.CloseHandle.restype = wintypes.BOOL
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ".windows-folder-probe" / "host.json"
            target.parent.mkdir()
            value = {"reader": "held", "checks": {"restart": True}}
            target.write_text(
                json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            handle = api.CreateFileW(
                str(target), 0x80000000, 0x1 | 0x2, None, 3, 0x80, None
            )
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            lock = threading.Lock()
            released = threading.Event()

            def release_reader():
                nonlocal handle
                with lock:
                    if handle is not None:
                        api.CloseHandle(handle)
                        handle = None
                    released.set()

            timer = threading.Timer(0.2, release_reader)
            timer.daemon = True
            timer.start()
            started = time.perf_counter()
            try:
                host.publish_evidence(target, value)
            finally:
                with lock:
                    if handle is not None:
                        api.CloseHandle(handle)
                        handle = None
                    released.set()
                timer.join(2.0)
            elapsed = time.perf_counter() - started
            self.assertTrue(released.is_set())
            self.assertGreaterEqual(elapsed, 0.15)
            self.assertLess(elapsed, 1.0)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), value)
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_attest_emits_typed_development_build_delegation(self):
        binary_hashes = {"fullmag": "e" * 64}
        assembly = self._assembly(binary_hashes)
        development_build = self._development_build(binary_hashes)
        native = {
            "host_root": "C:/fullmag/state",
            "host_filesystem": "NTFS",
            "host_drive_type": 3,
            "host_volume_serial": 42,
            "host_root_no_reparse": True,
        }
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(host, "local_volume", return_value=native), \
                patch.object(host, "prepare_probe_link"), \
                patch.object(host, "publish_evidence") as publish:
            certificate = host.attest(
                directory, assembly, "engine-test", binary_hashes,
                development_build=development_build,
            )
        self.assertEqual(certificate["development_build"], development_build)
        publish.assert_called_once()

    def test_attest_legacy_certificate_has_no_development_delegation(self):
        binary_hashes = {"fullmag": "e" * 64}
        native = {
            "host_root": "C:/fullmag/state",
            "host_filesystem": "NTFS",
            "host_drive_type": 3,
            "host_volume_serial": 42,
            "host_root_no_reparse": True,
        }
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(host, "local_volume", return_value=native), \
                patch.object(host, "prepare_probe_link"), \
                patch.object(host, "publish_evidence"):
            certificate = host.attest(
                directory, self._assembly(binary_hashes), "engine-test", binary_hashes
            )
        self.assertNotIn("development_build", certificate)


if __name__ == "__main__":
    unittest.main()
