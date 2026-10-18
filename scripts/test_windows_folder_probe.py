"""Focused regression checks for the Docker Windows-folder probe."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


@unittest.skipIf(os.name == "nt", "The guest probe contract is Linux-only")
class WindowsFolderProbeTest(unittest.TestCase):
    @staticmethod
    def _load_probe():
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/windows_folder_probe.py"
        spec = importlib.util.spec_from_file_location("windows_folder_probe_regression", path)
        if spec is None or spec.loader is None:
            raise AssertionError("Could not load windows_folder_probe.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_path_helpers_reject_a_reparse_like_ancestor(self):
        probe = self._load_probe()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real = root / "real"
            real.mkdir()
            (real / "payload").write_bytes(b"owned")
            alias = root / "alias"
            alias.symlink_to(real, target_is_directory=True)

            for operation in (
                    lambda: probe.read_regular(alias / "payload"),
                    lambda: probe.publish(alias / "published", b"owned"),
                    lambda: probe.sync_dir(alias),
            ):
                with self.assertRaises((OSError, RuntimeError)):
                    operation()
            self.assertFalse((real / "published").exists())

    def test_sqlite_stays_on_pinned_directory_when_ancestor_is_replaced(self):
        probe = self._load_probe()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live = root / "live"
            held = root / "held"
            evil = root / "evil"
            live.mkdir()
            evil.mkdir()
            directory_fd = probe._open_pinned_directory(live)
            try:
                os.rename(live, held)
                live.symlink_to(evil, target_is_directory=True)
                probe._sqlite_probe(directory_fd, "owner-token")
            finally:
                os.close(directory_fd)

            self.assertTrue((held / "transactions.sqlite").is_file())
            self.assertFalse((evil / "transactions.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
