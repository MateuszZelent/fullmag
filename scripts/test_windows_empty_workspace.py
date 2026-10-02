"""Exercise native launcher dispatch without building or starting a runtime."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest


LAUNCHER = Path(__file__).parent / "windows" / "run_fullmag.ps1"
POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")
pytestmark = pytest.mark.skipif(not POWERSHELL, reason="PowerShell required")


@pytest.mark.parametrize("frontend,expected", [
    ("static", ["ui", "--web-port", "3197"]),
    ("dev", ["ui", "--web-port", "3197", "--dev"]),
])
def test_workspace_dispatch_opens_ui_without_script_or_solve(tmp_path, frontend, expected):
    # Parse the actual launcher, then execute only its workspace dispatch block.
    # All build/storage checks remain outside this focused argv regression.
    probe = tmp_path / "dispatch.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Frontend, [string]$RepoRoot)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$blocks = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.IfStatementAst] -and
  $node.Extent.Text.StartsWith('if ($RunMode -eq "workspace") {')
}, $true))
if ($blocks.Count -ne 1) { throw "Expected one workspace dispatch" }
function Invoke-External {
  param([string]$Command, [string[]]$Arguments)
  [ordered]@{command=$Command; arguments=@($Arguments)} | ConvertTo-Json -Compress
}
$RunMode = "workspace"; $WebPort = 3197; $FullmagExe = "native-fullmag.exe"
& ([scriptblock]::Create($blocks[0].Extent.Text))
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(LAUNCHER), frontend, str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"command": "native-fullmag.exe", "arguments": expected}


@pytest.mark.parametrize("extra", [
    ["-ScriptPath", "must-not-execute.py"],
    ["-Backend", "fem"],
    ["-Device", "gpu"],
    ["-InitialMagnetizationStateSampleIndex", "0"],
    ["-OutputDir", "must-not-create"],
])
def test_workspace_rejects_simulation_inputs_before_storage_or_build(extra):
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(LAUNCHER),
                             "-BuildMode", "false", "-RunMode", "workspace", *extra],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode != 0
    assert "Workspace mode opens an empty authoring shell" in result.stderr
