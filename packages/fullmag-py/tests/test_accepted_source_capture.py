"""Filesystem capture regressions; no DSL/scientific fixture execution."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).parents[1] / "src/fullmag/runtime/accepted_source_capture.py"
spec = importlib.util.spec_from_file_location("accepted_capture_under_test", MODULE)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

class SourceCaptureTests(unittest.TestCase):
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
