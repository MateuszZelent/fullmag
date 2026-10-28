"""Interpreted checks for strict Windows physical-path identity pins."""
import copy
import hashlib
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import windows_bind_identity as identity


class FakeBackend:
    """Small native-handle stand-in; no filesystem calls are made by the tests."""

    volume_guid = "12345678-1234-5678-9abc-123456789abc"
    volume_serial = 0x0123456789ABCDEF

    def __init__(self):
        self.opened = []
        self.open_calls = []
        self.closed = []
        self.overrides = {}
        self.inspect_count = {}
        self.fail_open_path = None

    def open(self, path):
        self.open_calls.append(path)
        if path == self.fail_open_path:
            raise OSError("mock open failure")
        handle = {"path": path}
        self.opened.append(handle)
        return handle

    def inspect(self, handle):
        path = handle["path"]
        count = self.inspect_count.get(path, 0) + 1
        self.inspect_count[path] = count
        parts = path[3:].split("\\") if len(path) > 3 else []
        final = "\\\\?\\Volume{" + self.volume_guid + "}\\"
        if parts:
            final += "\\".join(parts)
        is_directory = (
            len(parts) == 0
            or path.lower().endswith("\\root")
            or path.lower().endswith("\\dir")
        )
        record = {
            "attributes": identity.FILE_ATTRIBUTE_DIRECTORY if is_directory else 0x80,
            "reparse_tag": 0,
            "final_path": final,
            "volume_serial": self.volume_serial,
            "file_id": bytes.fromhex(hashlib.sha256(path.lower().encode()).hexdigest()[:32]),
            "number_of_links": 1,
            "is_directory": is_directory,
            "delete_pending": False,
            "filesystem": "NTFS",
            "drive_type": identity.DRIVE_FIXED,
        }
        record.update(self.overrides.get(path, {}))
        if callable(record.get("file_id")):
            record["file_id"] = record["file_id"](count)
        return copy.deepcopy(record)

    def close(self, handle):
        self.closed.append(handle)
        return True


def request(path=r"C:\root\data.bin", *, label="source", kind="file", single_link=True):
    return {"label": label, "path": path, "kind": kind, "single_link": single_link}


class CanonicalDrivePathTests(unittest.TestCase):
    def test_accepts_absolute_mixed_separators_and_normalizes(self):
        self.assertEqual(identity.canonical_drive_path("c:/alpha\\beta"), r"C:\alpha\beta")
        self.assertEqual(identity.canonical_drive_path("C:\\"), "C:\\")

    def test_rejects_ambiguous_or_unsafe_paths(self):
        invalid = [
            "relative\\file", "C:file", r"\\server\share\file", "//server/share",
            r"\\?\C:\file", r"\\.\C:\file", r"\??\C:\file", "C:/a//b",
            "C:/a/./b", "C:/a/../b", "C:/a/", "C:/a.", "C:/a ",
            "C:/a:b", "C:/a*", "C:/CON", "C:/nul.txt", "C:/COM1.log",
            "C:/LPT².txt", "C:/CONIN$", "C:/bad\x00name", "C:/bad\nname",
            "C:/bad\ud800name", "C:/bad\u202ename",
        ]
        for value in invalid:
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError):
                    identity.canonical_drive_path(value)


class PinPathsTests(unittest.TestCase):
    def test_snapshot_contains_target_and_each_ancestor_and_closes_on_exit(self):
        backend = FakeBackend()
        with identity.pin_paths([request()], backend=backend) as pins:
            result = pins.snapshot()
            record = result["source"]
            self.assertEqual(record["canonical_input"], r"C:\root\data.bin")
            self.assertEqual(record["target"]["kind"], "file")
            self.assertTrue(record["target"]["no_reparse"])
            self.assertEqual(record["target"]["number_of_links"], 1)
            self.assertEqual(record["target"]["filesystem"], "NTFS")
            self.assertEqual(record["target"]["drive_type"], identity.DRIVE_FIXED)
            self.assertEqual([item["canonical_input"] for item in record["ancestors"]],
                             ["C:\\", r"C:\root"])
            self.assertEqual(len(record["target"]["file_id_hex"]), 32)
            self.assertEqual(pins.verify_unchanged(), result)
        self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_request_shape_duplicate_labels_and_overlapping_paths_rejected(self):
        backend = FakeBackend()
        malformed = [{"label": "x", "path": r"C:\root\data.bin", "kind": "file"}]
        with self.assertRaises(ValueError):
            with identity.pin_paths(malformed, backend=backend):
                pass
        with self.assertRaises(ValueError):
            duplicate = [request(label="x"), request(label="x", path=r"C:\root\other")]
            with identity.pin_paths(duplicate, backend=backend):
                pass
        with self.assertRaises(ValueError):
            with identity.pin_paths([request(path=r"C:\root", kind="directory", single_link=False),
                                     request(path=r"C:\root\data.bin")], backend=backend):
                pass
        with self.assertRaises(ValueError):
            with identity.pin_paths([request(path="C:\\", kind="directory", single_link=False),
                                     request(path=r"C:\root\data.bin")], backend=backend):
                pass
        self.assertEqual(backend.opened, [])

    def test_reparse_remote_filesystem_wrong_kind_and_multilink_are_rejected(self):
        cases = [
            (r"C:\root\data.bin", {
                "attributes": identity.FILE_ATTRIBUTE_REPARSE_POINT
            }, "file", True),
            (r"C:\root\data.bin", {"filesystem": "SMB"}, "file", True),
            (r"C:\root\data.bin", {"drive_type": identity.DRIVE_REMOTE}, "file", True),
            (r"C:\root\data.bin", {"is_directory": True}, "file", True),
            (r"C:\root\data.bin", {"delete_pending": True}, "file", True),
            (r"C:\root\data.bin", {"number_of_links": 2}, "file", True),
            (r"C:\root\dir", {"is_directory": False}, "directory", False),
        ]
        for path, overrides, kind, single_link in cases:
            with self.subTest(path=path, overrides=overrides):
                backend = FakeBackend()
                backend.overrides[path] = overrides
                with self.assertRaises(ValueError):
                    current = request(path, kind=kind, single_link=single_link)
                    with identity.pin_paths([current], backend=backend):
                        pass
                self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_reparse_ancestor_and_changed_volume_serial_are_rejected(self):
        for path, overrides in (
                ("C:\\root", {"attributes": identity.FILE_ATTRIBUTE_DIRECTORY
                                | identity.FILE_ATTRIBUTE_REPARSE_POINT}),
                ("C:\\root\\data.bin", {"volume_serial": 7})):
            with self.subTest(path=path):
                backend = FakeBackend()
                backend.overrides[path] = overrides
                with self.assertRaises(ValueError):
                    with identity.pin_paths([request()], backend=backend):
                        pass
                self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_reparse_ancestor_is_rejected_before_opening_its_child(self):
        backend = FakeBackend()
        backend.overrides[r"C:\root"] = {
            "attributes": identity.FILE_ATTRIBUTE_DIRECTORY
            | identity.FILE_ATTRIBUTE_REPARSE_POINT,
        }
        with self.assertRaises(identity.WindowsBindIdentityError):
            with identity.pin_paths([request()], backend=backend):
                pass
        self.assertEqual(backend.open_calls, ["C:\\", r"C:\root"])
        self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_malformed_mock_backend_types_are_rejected(self):
        malformed_values = [
            {"attributes": "128"},
            {"is_directory": 0},
            {"delete_pending": 0},
            {"number_of_links": True},
        ]
        for override in malformed_values:
            with self.subTest(override=override):
                backend = FakeBackend()
                backend.overrides[r"C:\root\data.bin"] = override
                with self.assertRaises(identity.WindowsBindIdentityError):
                    with identity.pin_paths([request()], backend=backend):
                        pass
                self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_rejects_volume_or_final_path_alias_mismatch(self):
        aliases = [
            r"\\?\Volume{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}\root",
            r"\\?\Volume{12345678-1234-5678-9abc-123456789abc}\elsewhere",
        ]
        for final_path in aliases:
            with self.subTest(final_path=final_path):
                backend = FakeBackend()
                backend.overrides[r"C:\root"] = {"final_path": final_path}
                with self.assertRaises(ValueError):
                    with identity.pin_paths([request()], backend=backend):
                        pass
                self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_verification_rejects_identity_drift_and_closes_all_handles(self):
        backend = FakeBackend()
        path = r"C:\root\data.bin"
        backend.overrides[path] = {"file_id": lambda count: b"a" * 16 if count == 1 else b"b" * 16}
        with self.assertRaises(ValueError):
            with identity.pin_paths([request(path)], backend=backend) as pins:
                pins.verify_unchanged()
        self.assertEqual(backend.closed, list(reversed(backend.opened)))

    def test_open_failure_closes_every_previously_opened_handle(self):
        backend = FakeBackend()
        backend.fail_open_path = r"C:\root\data.bin"
        with self.assertRaises(OSError):
            with identity.pin_paths([request()], backend=backend):
                pass
        self.assertEqual(backend.closed, list(reversed(backend.opened)))

    @unittest.skipIf(os.name == "nt", "Native Windows filesystem access")
    def test_native_io_requires_windows_unless_test_backend_injected(self):
        with self.assertRaises(identity.WindowsBindIdentityError):
            with identity.pin_paths([request()]):
                pass


if __name__ == "__main__":
    unittest.main()
