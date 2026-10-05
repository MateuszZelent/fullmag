"""Interpreted checks for opt-in disposable compiler storage."""
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fullmag_storage as storage
from windows import volatile_build_storage as volatile


class VolatileStorageChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("FULLMAG_TEST_TEMP_ROOT"))
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "ram"
        self.layout = {"project_root": str(self.base / "project"),
                       "storage_root": str(self.base / "project/storage"),
                       "repo_root": str(self.base / "project/repo"),
                       "worktrees_root": str(self.base / "project/worktrees"),
                       "worktree_id": "fixture", "build_root": str(self.base / "project/storage/builds/fixture/dev")}
        for target, value in (("_layout", self.layout), ("configured_root", self.root)):
            mocked = patch.object(volatile, target, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)
        mocked = patch.object(storage, "worktree_records", return_value=[])
        mocked.start()
        self.addCleanup(mocked.stop)

    def prepare(self):
        return volatile.prepare(self.layout["repo_root"], "dev", self.layout["build_root"])

    @unittest.skipUnless(os.name == "nt", "Native Windows routing")
    def test_temporary_paths_are_separate_and_owner_bound(self):
        result = self.prepare()
        self.assertTrue(result["enabled"])
        self.assertEqual(result["durable_build_root"], self.layout["build_root"])
        self.assertTrue(Path(result["temp_root"]).is_dir())
        inputs = Path(result["compiler_inputs_root"])
        self.assertFalse(inputs.exists())
        self.assertEqual(volatile.validate_working_root(self.layout["build_root"], inputs), inputs)
        with self.assertRaises(storage.StorageError):
            volatile.validate_working_root(self.base / "other-build", inputs)

    @unittest.skipUnless(os.name == "nt", "Native Windows routing")
    def test_nonempty_foreign_directory_is_preserved(self):
        self.root.mkdir()
        foreign = self.root / "foreign.txt"
        foreign.write_text("keep")
        with self.assertRaises(storage.StorageError):
            self.prepare()
        self.assertEqual(foreign.read_text(), "keep")

    @unittest.skipUnless(os.name == "nt", "Native Windows routing")
    def test_missing_optional_configuration_does_not_create_data(self):
        with patch.object(volatile, "configured_root", return_value=None):
            self.assertEqual(self.prepare(), {"enabled": False})
        self.assertFalse(self.root.exists())

    def test_permanent_storage_overlap_is_refused(self):
        with self.assertRaises(storage.StorageError):
            volatile._validate_root(Path(self.layout["storage_root"]) / "tmp", self.layout)

    @unittest.skipUnless(os.name == "nt", "Native Windows routing")
    def test_tampered_owner_marker_is_refused(self):
        result = self.prepare()
        inputs = Path(result["compiler_inputs_root"])
        marker = inputs.parent / volatile.MARKER
        record = json.loads(marker.read_text())
        record["worktree_id"] = "foreign"
        marker.write_text(json.dumps(record))
        with self.assertRaises(storage.StorageError):
            volatile.validate_working_root(self.layout["build_root"], inputs)

    @unittest.skipUnless(os.name == "nt", "PowerShell launcher")
    def test_launcher_restores_temporary_environment_after_compiler_failure(self):
        source = (Path(__file__).parent / "windows/run_fullmag.ps1").read_text(encoding="utf-8-sig")
        start = source.index("  $useVolatileTemp =")
        end = source.index("\n  if ($BuildSnapshot) {", start)
        temp = str(self.base).replace("'", "''")
        prefix = """
$ErrorActionPreference='Stop'
$oldTemp=$env:TEMP; $oldTmp=$env:TMP
$oldTmpdir=[Environment]::GetEnvironmentVariable('TMPDIR','Process')
$VolatileBuild=[pscustomobject]@{enabled=$true;temp_root='TEMP_PATH'}
$CompilerSourceRoot=$VolatileBuild.temp_root
$RepoRoot=$CompilerSourceRoot
$cargoArguments=@('build'); $needsControlRoomToolchain=$false
$script:observed=$false
function Invoke-External {
 param($Command,$Arguments)
 if ($env:TEMP -ne $VolatileBuild.temp_root -or $env:TMP -ne $VolatileBuild.temp_root -or $env:TMPDIR -ne $VolatileBuild.temp_root) {throw 'wrong temp routing'}
 $script:observed=$true
 throw 'expected compiler failure'
}
try {
""".replace("TEMP_PATH", temp)
        suffix = """
} catch {if ($_.Exception.Message -ne 'expected compiler failure') {throw}}
if (-not $script:observed -or $env:TEMP -ne $oldTemp -or $env:TMP -ne $oldTmp -or [Environment]::GetEnvironmentVariable('TMPDIR','Process') -ne $oldTmpdir) {throw 'temporary environment was not restored'}
Write-Output 'PASS'
"""
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                                 prefix + source[start:end] + suffix], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "PASS")

    @unittest.skipUnless(os.name == "nt", "Native Windows routing")
    def test_unsupported_path_normalization_disables_only_source_mirror(self):
        with patch.object(volatile, "_supports_normalized_paths", return_value=False):
            result = self.prepare()
        self.assertTrue(result["enabled"])
        self.assertFalse(result["compiler_inputs_enabled"])
        self.assertTrue(Path(result["temp_root"]).is_dir())
        self.assertEqual(result["durable_build_root"], self.layout["build_root"])

    @unittest.skipUnless(os.name == "nt", "Windows path API")
    def test_other_path_api_failures_are_not_silently_ignored(self):
        for error, unsupported in ((1, True), (5, False)):
            with self.subTest(win32_error=error):
                kernel = MagicMock()
                kernel.CreateFileW.return_value = 123
                kernel.GetFinalPathNameByHandleW.return_value = 0
                with patch.object(volatile.ctypes, "WinDLL", return_value=kernel), patch.object(volatile.ctypes, "get_last_error", return_value=error):
                    if unsupported:
                        self.assertFalse(volatile._supports_normalized_paths(self.base))
                    else:
                        with self.assertRaises(storage.StorageError):
                            volatile._supports_normalized_paths(self.base)
                kernel.CloseHandle.assert_called_once_with(123)


if __name__ == "__main__":
    unittest.main()
