"""Focused contract checks for the pinned Next development route patch."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PATCH_PATH = REPO_ROOT / "patches" / "next@16.3.8.patch"
LOCK_PATH = REPO_ROOT / "pnpm-lock.yaml"
FIXTURE_PATH = REPO_ROOT / "scripts" / "test_next_route_patch_fixture.mjs"
PATCH_HASH_RE = re.compile(
    r"next@16\.3\.8:\n\s+hash: ([0-9a-f]{64})\n\s+path: patches/next@16\.3\.8\.patch"
)


class NextRoutePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = PATCH_PATH.read_text(encoding="utf-8")
        cls.lock = LOCK_PATH.read_text(encoding="utf-8")

    def test_lock_pin_matches_patch_bytes(self) -> None:
        patch_hash = hashlib.sha256(PATCH_PATH.read_bytes()).hexdigest()
        match = PATCH_HASH_RE.search(self.lock)
        self.assertIsNotNone(match, "pnpm lock must register the pinned Next patch")
        self.assertEqual(match.group(1), patch_hash)
        self.assertIn(f"patch_hash={patch_hash}", self.lock)

    def test_patched_next_route_fixture(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for the pinned Next fixture")
        completed = subprocess.run(
            [node, str(FIXTURE_PATH)],
            cwd=REPO_ROOT,
            env={
                **os.environ,
                "FULLMAG_NEXT_ROUTE_PATCH_REPO_ROOT": str(REPO_ROOT),
            },
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"patched Next fixture failed:\nstdout={completed.stdout}\nstderr={completed.stderr}",
        )
        self.assertIn("metadata included", completed.stdout)


if __name__ == "__main__":
    unittest.main()
