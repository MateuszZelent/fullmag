"""Regression checks for private source freshness; no compiler invocation."""
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from refresh_managed_source_mtimes import is_link, refresh


class FreshnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ("crates/example/src", ".fullmag-build", ".fullmag-cargo", ".fullmag-rustup"):
            (self.root / name).mkdir(parents=True)
        self.source = self.root / "crates/example/src/lib.rs"
        self.source.write_bytes(b"pub fn current() {}\n")
        self.cache = self.root / ".fullmag-build/fingerprint"
        self.cache.write_bytes(b"retained cache")
        for path in (self.source, self.cache):
            os.utime(path, (1000, 1000))

    def test_refresh_changes_only_private_source_time(self):
        before = self.source.read_bytes(), self.source.stat().st_mode
        result = refresh(self.root, str(self.root))
        self.assertEqual(result["files"], 1)
        self.assertGreater(self.source.stat().st_mtime, 1000)
        self.assertEqual((self.source.read_bytes(), self.source.stat().st_mode), before)
        self.assertEqual(self.cache.stat().st_mtime, 1000)
        self.assertEqual(self.cache.read_bytes(), b"retained cache")

    def test_live_checkout_without_workspace_is_unchanged(self):
        (self.root / ".git").mkdir()
        self.assertEqual(refresh(self.root, None)["state"], "not_managed")
        self.assertEqual(self.source.stat().st_mtime, 1000)

    def test_checkout_with_managed_environment_is_rejected(self):
        (self.root / ".git").write_text("gitdir: elsewhere")
        with self.assertRaisesRegex(ValueError, "Git checkout"):
            refresh(self.root, str(self.root))
        self.assertEqual(self.source.stat().st_mtime, 1000)

    def test_mismatched_workspace_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "physical working directory"):
            refresh(self.root, str(self.root / "other"))
        self.assertEqual(self.source.stat().st_mtime, 1000)

    def test_missing_mountpoint_is_rejected(self):
        (self.root / ".fullmag-rustup").rmdir()
        with self.assertRaisesRegex(ValueError, "mountpoint"):
            refresh(self.root, str(self.root))
        self.assertEqual(self.source.stat().st_mtime, 1000)

    def test_link_is_rejected_before_any_changes(self):
        link = self.root / "crates/link"
        try:
            link.symlink_to(self.cache)
        except OSError:
            self.skipTest("host does not permit symlink creation")
        with self.assertRaisesRegex(ValueError, "link"):
            refresh(self.root, str(self.root))
        self.assertEqual(self.source.stat().st_mtime, 1000)

    def test_reparse_attribute_does_not_require_python_312(self):
        observed = SimpleNamespace(st_mode=0o100644, st_file_attributes=0x400)
        with patch.object(Path, "lstat", return_value=observed):
            self.assertTrue(is_link(self.source))


if __name__ == "__main__":
    unittest.main()
