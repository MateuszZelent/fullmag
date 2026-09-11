"""Behavioral check for the PowerShell managed-launcher process boundary."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "scripts/windows/fullmag_storage.ps1"


@unittest.skipUnless(os.name == "nt", "requires Windows PowerShell")
class ManagedLauncherExitTests(unittest.TestCase):
    def test_stdout_is_streamed_without_corrupting_native_exit_code(self):
        powershell = shutil.which("powershell.exe")
        self.assertIsNotNone(powershell)
        for native_exit in (0, 37):
            with self.subTest(native_exit=native_exit), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "scripts").mkdir()
                # A stand-in for the resolver tests only the adapter's output
                # boundary; it does not run a real launcher or modify storage.
                (root / "scripts/fullmag_storage.py").write_text(
                    "import os, sys\n"
                    "assert sys.argv[1] == 'run'\n"
                    "assert os.environ['FULLMAG_STORAGE_MANAGED_ENTRY'] == '1'\n"
                    "print('managed-child-output', flush=True)\n"
                    f"sys.exit({native_exit})\n",
                    encoding="utf-8",
                )
                quote = lambda value: "'" + str(value).replace("'", "''") + "'"
                command = (
                    f". {quote(ADAPTER)}; "
                    "$env:FULLMAG_STORAGE_MANAGED_ENTRY='previous'; "
                    "$result = Invoke-FullmagStorageManagedScript "
                    f"-RepoRoot {quote(root)} -Profile windows-fem-gpu "
                    f"-ScriptPath {quote(root / 'unused.ps1')}; "
                    "if ($result -isnot [int]) { Write-Error 'non-scalar exit result'; exit 99 }; "
                    "if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne 'previous') { exit 98 }; "
                    "exit $result"
                )
                result = subprocess.run(
                    [powershell, "-NoProfile", "-NonInteractive", "-Command", command],
                    text=True, capture_output=True, timeout=30,
                )
                self.assertEqual(result.returncode, native_exit, result.stdout + result.stderr)
                self.assertIn("managed-child-output", result.stdout)


if __name__ == "__main__":
    unittest.main()
