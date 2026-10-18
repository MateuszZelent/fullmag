"""Startup identity compatibility and fail-closed regression checks."""
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from validate_managed_fem_runtime_bundle import validate_startup_identity

COMMIT = "971b03666c7089aa38cc7ee67248593d5f44966e"
SNAPSHOT = "2212a4305f8f5d75f0f14f452f6cd88ff273d69db8b737d676ec14555c1b7add"
IDENTITY = (COMMIT, "clean", SNAPSHOT)
LEGACY = f"[fullmag] build: 2026-10-17T14:28:16Z | commit: {COMMIT} | clean | source snapshot: {SNAPSHOT}"
CURRENT = LEGACY.replace("[fullmag] build:", "[fullmag] version: 0.1.0-dev.20261017.g971b03666c70+9786 | build:")

class StartupIdentityTests(unittest.TestCase):
    def validate(self, stamp, expected=IDENTITY, status=0):
        result = subprocess.CompletedProcess([], status, "", stamp + "\n")
        with patch("validate_managed_fem_runtime_bundle.subprocess.run", return_value=result):
            validate_startup_identity(Path("fullmag"), ("--help",), "CLI", expected, Path.cwd())

    def test_current_and_legacy_stamps_preserve_exact_identity(self):
        for stamp in (CURRENT, LEGACY):
            with self.subTest(stamp=stamp):
                self.validate(stamp)

    def test_each_identity_mismatch_is_rejected(self):
        for expected in (("a" * 40, "clean", SNAPSHOT), (COMMIT, "dirty", SNAPSHOT), (COMMIT, "clean", "b" * 64)):
            with self.subTest(expected=expected), self.assertRaisesRegex(ValueError, "identity mismatch"):
                self.validate(CURRENT, expected)

    def test_missing_or_malformed_identity_is_rejected(self):
        for stamp in ("", CURRENT.replace(COMMIT, "unknown"), CURRENT + " trailing"):
            with self.subTest(stamp=stamp), self.assertRaisesRegex(ValueError, "identity is missing"):
                self.validate(stamp)

    def test_failed_query_is_rejected_even_with_valid_stamp(self):
        with self.assertRaisesRegex(ValueError, "exited with status 2"):
            self.validate(CURRENT, status=2)

if __name__ == "__main__":
    unittest.main()
