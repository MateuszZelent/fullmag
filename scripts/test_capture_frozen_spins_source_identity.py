from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "capture_frozen_spins_source_identity.py"
SPEC = importlib.util.spec_from_file_location("capture_frozen_spins_source_identity", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def git(repo: Path, *args: str) -> None:
    subprocess.run(("git", *args), cwd=repo, check=True, capture_output=True)


def repository(root: Path) -> Path:
    repo = root / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.invalid")
    git(repo, "config", "user.name", "Frozen Spins Test")
    (repo / "tracked.txt").write_text("baseline\n", encoding="utf-8")
    git(repo, "add", "tracked.txt")
    git(repo, "commit", "-qm", "baseline")
    return repo


class FrozenSpinsSourceIdentityTests(unittest.TestCase):
    def test_clean_dirty_and_untracked_content_change_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = repository(Path(temp))
            clean = MODULE.capture(repo)
            self.assertFalse(clean["source"]["git_dirty"])
            (repo / "tracked.txt").write_text("dirty\n", encoding="utf-8")
            (repo / "untracked.txt").write_text("first\n", encoding="utf-8")
            dirty = MODULE.capture(repo)
            self.assertTrue(dirty["source"]["git_dirty"])
            self.assertNotEqual(clean["source_snapshot_id"], dirty["source_snapshot_id"])
            (repo / "untracked.txt").write_text("second\n", encoding="utf-8")
            changed = MODULE.capture(repo)
            self.assertNotEqual(
                dirty["source"]["untracked_manifest_sha256"],
                changed["source"]["untracked_manifest_sha256"],
            )

    def test_require_clean_fails_for_dirty_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = repository(Path(temp))
            (repo / "tracked.txt").write_text("dirty\n", encoding="utf-8")
            result = subprocess.run(
                (sys.executable, str(SCRIPT), "--repo-root", str(repo), "--require-clean"),
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("qualification source tree is dirty", result.stderr)


if __name__ == "__main__":
    unittest.main()
