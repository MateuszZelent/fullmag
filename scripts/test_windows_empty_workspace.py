"""Exercise native launcher dispatch without building or starting a runtime."""
import json
import hashlib
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


@pytest.mark.parametrize("case", ["valid", "missing", "changed", "missing_hash", "empty"])
def test_desktop_runtime_requires_file_and_matching_manifest_hash(tmp_path, case):
    binary = tmp_path / "fullmag-ui.exe"
    original = b"desktop artifact hash fixture; not an executable"
    expected = hashlib.sha256(original).hexdigest()
    if case != "missing":
        binary.write_bytes(b"changed" if case == "changed" else original)
    if case == "missing_hash":
        expected = ""
    if case == "empty":
        binary.write_bytes(b"")
        expected = hashlib.sha256(b"").hexdigest()
    probe = tmp_path / "desktop.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Binary, [string]$ExpectedHash)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @("Get-Sha256File", "Assert-FullmagDesktopRuntime")) {
  $functions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq $name
  }, $true))
  if ($functions.Count -ne 1) { throw "Expected one function $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
Assert-FullmagDesktopRuntime -Path $Binary -ExpectedHash $ExpectedHash
[Console]::Write("verified")
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(LAUNCHER), str(binary), expected],
                            capture_output=True, text=True, timeout=20)
    if case == "valid":
        assert result.returncode == 0, result.stderr
        assert result.stdout == "verified"
    else:
        assert result.returncode != 0
        assert "rerun with build=True" in result.stderr


@pytest.mark.parametrize("cuda,desktop", [(False, False), (True, False), (False, True), (True, True)])
def test_desktop_build_never_inherits_solver_cuda_feature(tmp_path, cuda, desktop):
    source = LAUNCHER.read_text(encoding="utf-8")
    build = source.split('  $cargoArguments = @(\n', 1)[1].split(
        '  if (-not (Test-Path -LiteralPath $FullmagExe', 1)[0]
    probe = tmp_path / "build-argv.ps1"
    probe.write_text('''
param([string]$Cuda, [string]$Desktop, [string]$RepoRoot)
$ErrorActionPreference = "Stop"
$useCuda = $Cuda -eq "true"
$needsControlRoomToolchain = $Desktop -eq "true"
$TargetTriple = "x86_64-pc-windows-msvc"
$calls = [System.Collections.Generic.List[object]]::new()
function Invoke-External {
  param([string]$Command, [string[]]$Arguments)
  $calls.Add(@{command=$Command; arguments=@($Arguments)})
}
  $cargoArguments = @(
''' + build + '\nConvertTo-Json -InputObject @($calls.ToArray()) -Depth 5 -Compress\n', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(cuda).lower(), str(desktop).lower(), str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    calls = json.loads(result.stdout)
    solver = ["build", "--locked", "--release", "--target", "x86_64-pc-windows-msvc",
              "-p", "fullmag-cli", "-p", "fullmag-api"]
    if cuda:
        solver += ["--features", "cuda"]
    expected = [{"command": "cargo", "arguments": solver}]
    if desktop:
        expected.append({"command": "cargo", "arguments": [
            "build", "--locked", "--release", "--target", "x86_64-pc-windows-msvc",
            "-p", "fullmag-desktop"]})
    assert calls == expected
