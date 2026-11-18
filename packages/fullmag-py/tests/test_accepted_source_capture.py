"""Filesystem capture regressions; no DSL/scientific fixture execution."""
from __future__ import annotations
import importlib.util
from io import BytesIO
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).parents[1] / "src/fullmag/runtime/accepted_source_capture.py"
spec = importlib.util.spec_from_file_location("accepted_capture_under_test", MODULE)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

class SourceCaptureTests(unittest.TestCase):
    def test_material_snapshot_input_is_bounded_and_must_be_an_array(self):
        self.assertEqual(capture.read_material_catalog(BytesIO(b'[{"source": {}}]')), [{"source": {}}])
        self.assertIsNone(capture.read_material_catalog(BytesIO(b'{"unavailable":true}')))
        with self.assertRaisesRegex(RuntimeError, "material_catalog_invalid"):
            capture.read_material_catalog(BytesIO(b'{}'))
        with self.assertRaisesRegex(RuntimeError, "material_catalog_invalid"):
            capture.read_material_catalog(BytesIO(b'['))
        with patch.object(capture, "MATERIAL_CATALOG_LIMIT", 2):
            with self.assertRaisesRegex(RuntimeError, "material_catalog_budget"):
                capture.read_material_catalog(BytesIO(b'[1]'))

    def test_catalog_stdin_descriptor_is_closed_before_script_execution(self):
        check = """
import os
import runpy
import sys
read = runpy.run_path(sys.argv[1])["read_material_catalog_stdin"]
assert read() == []
try:
    os.fstat(0)
except OSError:
    pass
else:
    raise AssertionError("material catalog input descriptor is still open")
"""
        with tempfile.TemporaryFile() as incoming:
            incoming.write(b"[]")
            incoming.seek(0)
            result = subprocess.run(
                [sys.executable, "-B", "-c", check, str(MODULE)],
                stdin=incoming, capture_output=True, timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_exact_bytes_identity(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "script.py"
            file.write_bytes(b"# stable\n")
            size, digest = capture.read_identity(file)
            self.assertEqual(size, 9)
            self.assertEqual(digest, capture.hashlib.sha256(b"# stable\n").hexdigest())

    def test_size_budget_before_file_read(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "script.py"
            file.write_bytes(b"large")
            with patch.object(capture, "FILE_LIMIT", 2):
                with self.assertRaisesRegex(RuntimeError, "file_budget"):
                    capture.read_identity(file)

    def test_missing_and_directory_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FileNotFoundError):
                capture.regular(Path(root) / "missing")
            with self.assertRaisesRegex(RuntimeError, "regular_file"):
                capture.regular(Path(root))

    def test_symlink_refused_even_if_target_exists(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "target"
            target.write_bytes(b"x")
            link = Path(root) / "alias"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("symlink privilege unavailable")
            with self.assertRaisesRegex(RuntimeError, "alias_or_symlink"):
                capture.read_identity(link)

if __name__ == "__main__":
    unittest.main()
