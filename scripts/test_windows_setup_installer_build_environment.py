"""Native interpreted guards for the installer producer storage roots.

The fixture extracts only ``Assert-LayoutPath`` from the production PowerShell
script. It does not install WiX, download an archive, invoke CMake, or build
any target.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "scripts/windows/setup_installer_build_environment.ps1"


def _powershell() -> str | None:
    if os.name == "nt":
        return shutil.which("powershell.exe") or shutil.which("powershell")
    for candidate in (
        Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
        Path("/mnt/c/Windows/Sysnative/WindowsPowerShell/v1.0/powershell.exe"),
    ):
        if candidate.is_file():
            return str(candidate)
    return shutil.which("powershell.exe") or shutil.which("powershell")


def _windows_path(path: Path) -> str:
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if wslpath is None:
        raise unittest.SkipTest("wslpath is required to invoke native Windows PowerShell")
    result = subprocess.run(
        [wslpath, "-w", str(path)], check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


class InstallerLayoutPathContract(unittest.TestCase):
    def test_build_temp_sibling_and_reparse_boundaries(self) -> None:
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell is required for this native interpreted fixture")

        with tempfile.TemporaryDirectory(prefix="fullmag-installer-layout-") as temporary:
            driver = Path(temporary) / "layout_guard.ps1"
            driver.write_text(
                textwrap.dedent(
                    r"""
                    param([Parameter(Mandatory=$true)][string]$Setup)
                    $ErrorActionPreference = 'Stop'
                    $tokens = $null
                    $errors = $null
                    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                      $Setup, [ref]$tokens, [ref]$errors)
                    if ($errors.Count) { throw ($errors | Out-String) }
                    $function = $ast.Find({ param($node)
                      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                      $node.Name -eq 'Assert-LayoutPath'
                    }, $true)
                    if ($null -eq $function) { throw 'Assert-LayoutPath was not found' }
                    . ([scriptblock]::Create($function.Extent.Text))

                    $root = Join-Path ([System.IO.Path]::GetTempPath()) (
                      'fullmag-layout-' + [guid]::NewGuid().ToString('N'))
                    $build = Join-Path $root 'build'
                    $temp = Join-Path $root 'temp'
                    $outside = Join-Path $root 'outside'
                    $sibling = Join-Path $root 'sibling'
                    $junction = Join-Path $temp 'linked'
                    try {
                      New-Item -ItemType Directory -Path $build, $temp, $outside, $sibling -Force | Out-Null
                      $script:Layout = [pscustomobject]@{ build_root = $build; temp_root = $temp }

                      $buildCandidate = Assert-LayoutPath (Join-Path $build 'tools') 'build candidate'
                      if ($buildCandidate -ne [System.IO.Path]::GetFullPath((Join-Path $build 'tools')).TrimEnd('\', '/')) {
                        throw 'build candidate was not normalized'
                      }
                      $tempCandidate = Assert-LayoutPath (Join-Path $temp 'extract') 'temp candidate' -RootKind temp
                      if ($tempCandidate -ne [System.IO.Path]::GetFullPath((Join-Path $temp 'extract')).TrimEnd('\', '/')) {
                        throw 'temp candidate was not normalized'
                      }

                      try {
                        Assert-LayoutPath (Join-Path $sibling 'wrong') 'sibling candidate' -RootKind temp | Out-Null
                        throw 'sibling path was accepted as a temp path'
                      }
                      catch {
                        if ($_.Exception.Message -notmatch 'escapes the resolved temp root') { throw }
                      }

                      try {
                        New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop | Out-Null
                      }
                      catch {
                        throw ('junction fixture creation failed: ' + $_.Exception.Message)
                      }
                      if (-not (Test-Path -LiteralPath $junction)) {
                        throw 'junction fixture creation failed: junction was not created'
                      }
                      try {
                        Assert-LayoutPath (Join-Path $junction 'payload') 'reparse candidate' -RootKind temp | Out-Null
                        throw 'reparse path was accepted'
                      }
                      catch {
                        if ($_.Exception.Message -notmatch 'junction or symlink') { throw }
                      }
                      Write-Output 'installer layout path contract passed'
                    }
                    finally {
                      if (Test-Path -LiteralPath $junction) {
                        Remove-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue
                      }
                      if (Test-Path -LiteralPath $root) {
                        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
                      }
                    }
                    """
                ),
                encoding="utf-8",
            )
            environment = os.environ.copy()
            # WSL can export /tmp as a UNC path to Windows PowerShell. Keep the
            # reparse fixture on a native local volume so mklink /J exercises
            # the production path guard instead of the bridge.
            environment["TEMP"] = r"C:\Windows\Temp"
            environment["TMP"] = r"C:\Windows\Temp"
            result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    _windows_path(driver),
                    _windows_path(SETUP),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                env=environment,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("installer layout path contract passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
