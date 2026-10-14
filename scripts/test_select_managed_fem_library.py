"""Interpreted regressions for source-bound native library publication."""
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

from select_managed_fem_library import select_library


class ManagedFemLibrarySelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.snapshot = "a" * 64

    def candidate(self, name, snapshot, data=b"current", mtime=1000, profile="release"):
        native = self.root / profile / "build" / f"fullmag-fem-sys-{name}" / "out" / "native-build"
        library = native / "backends" / "fem" / "libfullmag_fem.so.0"
        library.parent.mkdir(parents=True)
        library.write_bytes(data)
        os.utime(library, (mtime, mtime))
        cache = native / "CMakeCache.txt"
        cache.write_text(f"FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256:STRING={snapshot}\n", encoding="utf-8")
        return library.parent

    def test_current_older_library_wins_over_newer_stale_and_unbound(self):
        current = self.candidate("current", self.snapshot, mtime=1000)
        self.candidate("stale", "b" * 64, b"stale", mtime=2000)
        self.candidate("unbound", "", b"old", mtime=3000)
        self.assertEqual(select_library(self.root, self.snapshot), current)

    def test_matching_snapshot_with_different_bytes_is_ambiguous(self):
        self.candidate("a", self.snapshot, b"one")
        self.candidate("b", self.snapshot, b"two")
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            select_library(self.root, self.snapshot)

    def test_identical_library_groups_choose_path_order_not_mtime(self):
        expected = self.candidate("a", self.snapshot, mtime=1000)
        self.candidate("b", self.snapshot, mtime=3000)
        self.assertEqual(select_library(self.root, self.snapshot), expected)

    def test_no_stale_or_debug_fallback(self):
        self.candidate("stale", "b" * 64)
        self.candidate("debug", self.snapshot, profile="debug")
        with self.assertRaisesRegex(ValueError, "no release"):
            select_library(self.root, self.snapshot)

    def test_missing_library_fails(self):
        directory = self.candidate("current", self.snapshot)
        (directory / "libfullmag_fem.so.0").unlink()
        with self.assertRaisesRegex(ValueError, "no native FEM"):
            select_library(self.root, self.snapshot)

    def test_malformed_snapshot_rejected(self):
        for snapshot in ("", "a" * 63, "A" * 64):
            with self.subTest(snapshot=snapshot), self.assertRaises(ValueError):
                select_library(self.root, snapshot)

    def test_redirected_library_directory_is_rejected(self):
        directory = self.candidate("current", self.snapshot)
        original_resolve = Path.resolve
        outside = self.root.parent / "outside-target"
        def redirected(path, *args, **kwargs):
            return outside if path == directory else original_resolve(path, *args, **kwargs)
        with patch.object(Path, "resolve", redirected):
            with self.assertRaisesRegex(ValueError, "directory escapes"):
                select_library(self.root, self.snapshot)

    def test_managed_make_publication_does_not_ignore_copy_failure(self):
        bash = os.environ.get("FULLMAG_TEST_BASH")
        if not bash and os.name != "nt":
            bash = shutil.which("bash")
        if not bash:
            self.skipTest("explicit native Bash required on Windows; do not use WSL")
        makefile = Path(__file__).resolve().parents[1] / "Makefile"
        text = makefile.read_text(encoding="utf-8")
        start = text.index('\tif [ "$$build_mode" = "cuda-fem-gpu" ]')
        end = text.index('\n\tprintf', start)
        body = text[start:end].replace("\t", "").replace("$$", "$")
        directory = self.candidate("current", self.snapshot)
        script = (
            'set -e\nbuild_mode=fem-cpu\ncargo_target_dir="$1"\ncandidate_library="$2"\n'
            'python3() { printf "%s\\n" "$candidate_library"; }\n'
            'cp() { printf "copy-attempt\\n" >&2; return 17; }\n'
            + body + '\nprintf "published\\n"\n'
        )
        result = subprocess.run(
            [bash, "--noprofile", "--norc", "-c", script, "test", str(self.root), str(directory)],
            env={**os.environ, "FULLMAG_SOURCE_SNAPSHOT_SHA256": self.snapshot},
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertIn("copy-attempt", result.stderr)
        self.assertNotIn("published", result.stdout)

    def test_duplicate_snapshot_in_cache_rejected(self):
        directory = self.candidate("current", self.snapshot)
        cache = directory.parent.parent / "CMakeCache.txt"
        with cache.open("a", encoding="utf-8") as stream:
            stream.write(f"FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256:STRING={self.snapshot}\n")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            select_library(self.root, self.snapshot)


if __name__ == "__main__":
    unittest.main()
