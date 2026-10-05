"""PowerShell-level checks for enrolled scratch path containment."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


POWERSHELL = shutil.which("powershell.exe")


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell is required")
class WindowsScratchPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parents[1], prefix=".volatile-scratch-test-"
        )
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.storage = self.base / "durable-storage"
        self.storage.mkdir()
        self.scratch_build_root = self.base / "scratch" / "builds" / "worktree-current"
        self.build_temp_root = self.base / "scratch" / "tmp" / "worktree-current"
        self.scratch_build_root.mkdir(parents=True)
        self.build_temp_root.mkdir(parents=True)
        self.other_worktree_root = self.base / "scratch" / "builds" / "worktree-other"
        self.other_worktree_root.mkdir(parents=True)
        self.adapter = Path(__file__).resolve().parent / "windows" / "fullmag_storage.ps1"

    @staticmethod
    def _ps_quote(value):
        return "'" + str(value).replace("'", "''") + "'"

    def _layout_expression(self, *, scratch_build_root=None, build_temp_root=None):
        scratch_build_root = scratch_build_root or self.scratch_build_root
        build_temp_root = build_temp_root or self.build_temp_root
        return (
            "[pscustomobject]@{"
            f"storage_root = {self._ps_quote(self.storage)}; "
            f"scratch_build_root = {self._ps_quote(scratch_build_root)}; "
            f"build_temp_root = {self._ps_quote(build_temp_root)}"
            "}"
        )

    def _invoke_assert(self, *, path, parent=None, scratch_build_root=None):
        parent_argument = ""
        if parent is not None:
            parent_argument = f" -Parent {self._ps_quote(parent)}"
        command = "\n".join((
            "$ErrorActionPreference = 'Stop'",
            f". {self._ps_quote(self.adapter)}",
            f"$layout = {self._layout_expression(scratch_build_root=scratch_build_root)}",
            "try {",
            f"  $null = Assert-FullmagStoragePath -Layout $layout -Path {self._ps_quote(path)} -Label 'scratch fixture'{parent_argument}",
            "  exit 0",
            "} catch {",
            "  [Console]::Error.WriteLine([string]$_.Exception.Message)",
            "  exit 1",
            "}",
        ))
        script = self.base / "assert-scratch-path.ps1"
        script.write_text(command, encoding="utf-8")
        return subprocess.run(
            [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True,
            text=True,
            timeout=20,
        )

    def test_exact_registered_scratch_roots_are_accepted_with_explicit_parent(self):
        for root in (self.scratch_build_root, self.build_temp_root):
            with self.subTest(root=root):
                result = self._invoke_assert(path=root, parent=root)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_scratch_path_is_rejected_when_default_parent_is_durable_storage(self):
        result = self._invoke_assert(path=self.scratch_build_root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be contained", result.stdout + result.stderr)

    def test_other_worktree_scratch_path_is_rejected_even_with_its_own_parent(self):
        candidate = self.other_worktree_root / "target"
        result = self._invoke_assert(path=candidate, parent=self.other_worktree_root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must stay in durable storage or this worktree/profile's enrolled scratch", result.stdout + result.stderr)

    def test_existing_leaf_below_nested_ancestor_junction_is_rejected(self):
        junction_parent = self.base / "approved-parent"
        junction_parent.mkdir()
        redirected_target = self.base / "outside-target"
        redirected_target.mkdir()
        junction = junction_parent / "redirect"

        create_command = (
            f"New-Item -ItemType Junction -Path {self._ps_quote(junction)} "
            f"-Target {self._ps_quote(redirected_target)} -ErrorAction Stop | Out-Null"
        )
        created = subprocess.run(
            [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", create_command],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if created.returncode != 0:
            self.skipTest(f"Host could not create a temporary junction: {created.stdout}{created.stderr}")
        self.addCleanup(self._remove_junction, junction)

        redirected_scratch_root = junction / "scratch-builds"
        redirected_scratch_root.mkdir()
        existing_leaf = redirected_scratch_root / "existing-leaf.bin"
        existing_leaf.write_bytes(b"fixture")

        result = self._invoke_assert(
            path=existing_leaf,
            parent=redirected_scratch_root,
            scratch_build_root=redirected_scratch_root,
        )
        message = (result.stdout + result.stderr).casefold()
        self.assertNotEqual(result.returncode, 0, message)
        self.assertIn("junction or symlink", message)
        self.assertTrue(
            str(redirected_target).casefold() in message or
            (" -> " not in message and str(junction).casefold() in message),
            message,
        )

    @staticmethod
    def _remove_junction(path):
        try:
            os.rmdir(path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    unittest.main()
