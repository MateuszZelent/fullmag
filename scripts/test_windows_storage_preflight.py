"""Exercise the Windows contract launcher before it can start Docker or write."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import fullmag_storage


@unittest.skipUnless(os.name == "nt", "Windows PowerShell launcher")
class WindowsStoragePreflightTests(unittest.TestCase):
    def test_invalid_override_and_forged_entry_stop_before_storage_creation(self):
        source = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            repo = project / "fullmag"
            scripts = repo / "scripts"
            windows = scripts / "windows"
            windows.mkdir(parents=True)
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
            shutil.copyfile(source / "fullmag_storage.py", scripts / "fullmag_storage.py")
            for name in ("fullmag_storage.ps1", "verify_fem_frequency_domain_native_contract.ps1"):
                shutil.copyfile(source / "windows" / name, windows / name)
            (repo / "compose.windows.yaml").write_text("services: {}\n")
            env = {key: value for key, value in os.environ.items()
                   if key not in fullmag_storage.MANAGED_VARIABLES
                   and key != "FULLMAG_STORAGE_MANAGED_ENTRY"}
            command = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                       "-ExecutionPolicy", "Bypass", "-File",
                       str(windows / "verify_fem_frequency_domain_native_contract.ps1"),
                       "-Device", "cpu", "-RepoRoot", str(repo)]
            cases = (
                ({"FULLMAG_WINDOWS_BUILD_ROOT": str(project / "forbidden")}, "must be contained"),
                ({"FULLMAG_STORAGE_MANAGED_ENTRY": "1"}, "No inherited managed lock"),
            )
            for overrides, expected in cases:
                with self.subTest(overrides=overrides):
                    result = subprocess.run(command, env={**env, **overrides},
                                            capture_output=True, text=True, timeout=30)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(expected, result.stdout + result.stderr)
                    self.assertFalse((project / "storage").exists())
                    self.assertFalse((project / "forbidden").exists())


if __name__ == "__main__":
    unittest.main()
