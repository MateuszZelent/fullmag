"""Executable PowerShell contract checks for the all-capabilities installer receipt."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER_ENV = ROOT / "scripts" / "windows" / "run_installer_environment.ps1"


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


def _native_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
    environment["PATH"] = ";".join(
        (
            r"C:\Windows\System32\WindowsPowerShell\v1.0",
            r"C:\Program Files\Git\cmd",
            r"C:\Users\Mateusz\miniconda3",
            environment.get("PATH", ""),
        )
    )
    return environment


def _windows_path(path: Path) -> str:
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if wslpath is None:
        raise unittest.SkipTest("wslpath is required for native PowerShell")
    result = subprocess.run(
        [wslpath, "-w", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _extract_existing_receipt_validator() -> str:
    return _extract_function(
        "function Get-ExistingInitialReceipt",
        "\nfunction Invoke-Setup",
    )


def _extract_function(start_marker: str, end_marker: str) -> str:
    source = INSTALLER_ENV.read_text(encoding="utf-8-sig")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def _write_native_script(powershell: str, script: str) -> str:
    writer = r"""
$ErrorActionPreference = 'Stop'
$content = [Console]::In.ReadToEnd()
$path = Join-Path ([IO.Path]::GetTempPath()) ('fullmag-receipt-contract-' + [guid]::NewGuid().ToString('N') + '.ps1')
[IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
Write-Output $path
"""
    result = subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", writer],
        input=script,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_native_environment(),
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    paths = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not paths:
        raise AssertionError("PowerShell did not return the temporary script path")
    return paths[-1]


def _remove_native_path(powershell: str, path: str) -> None:
    command = (
        "$ErrorActionPreference='Stop'; "
        f"Remove-Item -LiteralPath '{path.replace(chr(39), chr(39) * 2)}' "
        "-Force -ErrorAction SilentlyContinue"
    )
    subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_native_environment(),
        timeout=30,
        check=False,
    )


def _receipt_contract_script() -> str:
    validator = _extract_existing_receipt_validator()
    return f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Stop-Workflow {{
  param([Parameter(Mandatory = $true)][string]$Code)
  throw $Code
}}
function Assert-LocalAbsolutePath {{
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not [IO.Path]::IsPathRooted($Path)) {{ throw ($Label + '_not_absolute') }}
  return [IO.Path]::GetFullPath($Path)
}}
function Assert-Inside {{
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)
  $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\\')
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\\')
  if (-not [String]::Equals($candidate, $base, [StringComparison]::OrdinalIgnoreCase) -and
      -not $candidate.StartsWith($base + '\\', [StringComparison]::OrdinalIgnoreCase)) {{ throw ($Label + '_outside_root') }}
  return $candidate
}}
function Assert-RegularFile {{
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -eq $false -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ throw ($Label + '_not_regular') }}
}}
function Get-FileSha256Value {{
  param([Parameter(Mandatory = $true)][string]$Path)
  return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant())
}}
function Assert-Sha256Value {{
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($Value -notmatch '^[0-9a-fA-F]{{64}}$') {{ throw ($Label + '_invalid_sha256') }}
  return $Value.ToLowerInvariant()
}}
function Compare-SourceIdentity {{
  param([Parameter(Mandatory = $true)][object]$Expected, [Parameter(Mandatory = $true)][object]$Actual)
  $left = $Expected | ConvertTo-Json -Depth 30 -Compress
  $right = $Actual | ConvertTo-Json -Depth 30 -Compress
  return [String]::Equals($left, $right, [StringComparison]::Ordinal)
}}
function Assert-AdmissionUnchanged {{
  param([Parameter(Mandatory = $true)][object]$Admission)
  if ((Get-FileSha256Value ([string]$Admission.path)) -ne [string]$Admission.sha256) {{ throw 'admission_changed' }}
}}

{validator}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('fullmag-receipt-v2-' + [guid]::NewGuid().ToString('N'))
$storageRoot = Join-Path $fixtureRoot 'storage'
$setupBuildRoot = Join-Path $storageRoot 'builds\\wt\\windows-setup'
$fullBuildRoot = Join-Path $storageRoot 'builds\\wt\\windows-native-fem-gpu'
$setupRunsRoot = Join-Path $storageRoot 'runs\\wt\\windows-setup'
$fullRunsRoot = Join-Path $storageRoot 'runs\\wt\\windows-native-fem-gpu'
$receiptPath = Join-Path $setupRunsRoot 'receipts\\full-runtime.json'
$admissionPath = Join-Path $setupRunsRoot 'admission.json'
$manifestPath = Join-Path $fullBuildRoot 'windows-full-runtime\\build-manifest.json'
$originManifestPath = Join-Path $fullBuildRoot 'physical-build-manifest.json'
$toolsRoot = Join-Path $fixtureRoot 'tools'
$utf8 = [Text.UTF8Encoding]::new($false)

try {{
  foreach ($directory in @($setupBuildRoot, $fullBuildRoot, (Split-Path $manifestPath), $setupRunsRoot, $fullRunsRoot, $toolsRoot, (Split-Path $receiptPath))) {{
    $null = New-Item -ItemType Directory -Force -Path $directory
  }}
  [IO.File]::WriteAllText($admissionPath, 'admission-v2', $utf8)
  foreach ($tool in @('git.exe', 'python.exe', 'just.exe')) {{
    [IO.File]::WriteAllText((Join-Path $toolsRoot $tool), $tool, $utf8)
  }}

  $layout = [pscustomobject]@{{
    profile = 'windows-setup'
    build_root = $setupBuildRoot
    runs_root = $setupRunsRoot
  }}
  $runtimeLayout = [pscustomobject]@{{
    profile = 'windows-native-fem-gpu'
    build_root = $fullBuildRoot
    runs_root = $fullRunsRoot
  }}
  $mapping = [pscustomobject]@{{ backend = 'full'; lane = 'all'; device = 'auto' }}
  $identity = [ordered]@{{
    source_identity_sha256 = ('1' * 64)
    requested_checkout = $fixtureRoot
    main_checkout = $fixtureRoot
    template_hash = ('2' * 64)
    manifest_hash = ('3' * 64)
    resolver_hash = ('4' * 64)
    main_git_head = ('5' * 40)
  }}
  $admission = [pscustomobject]@{{
    path = $admissionPath
    sha256 = Get-FileSha256Value $admissionPath
    session_id = 'session-v2-all'
    environment_hash = ('e' * 64)
  }}

  function Write-Baseline {{
    [IO.File]::WriteAllText($originManifestPath, 'origin-v2', $utf8)
    [IO.File]::WriteAllText($manifestPath, 'capability-v2', $utf8)
    $manifestSha = Get-FileSha256Value $manifestPath
    $originSha = Get-FileSha256Value $originManifestPath
    $receipt = [ordered]@{{
      schema = 'fullmag.windows-installer-environment-receipt.v2'
      version = '2.0.0'
      state = 'completed'
      mode = 'initial-build'
      profile = 'windows-native-fem-gpu'
      lane = 'all'
      backend = 'full'
      device = 'auto'
      scope = 'all'
      storage_root = $storageRoot
      runs_root = $setupRunsRoot
      storage_profile = 'windows-setup'
      environment_hash = $admission.environment_hash
      admission_path = $admission.path
      admission_sha256 = $admission.sha256
      session = [ordered]@{{ session_id = $admission.session_id }}
      initial_build = [ordered]@{{
        requested = $true
        state = 'completed'
        exit_code = 0
        expected_build_id = $manifestSha
        manifest_sha256 = $manifestSha
        manifest_path = $manifestPath
      }}
      runtime_qualification = 'NOT VERIFIED'
      sanitized_output = $true
      source_identity = $identity
      tools = [ordered]@{{
        git = (Join-Path $toolsRoot 'git.exe')
        python = (Join-Path $toolsRoot 'python.exe')
        just = (Join-Path $toolsRoot 'just.exe')
      }}
      full_runtime = [ordered]@{{
        scope = 'all'
        installed_support = @('fdm_cpu', 'fdm_gpu', 'fem_cpu', 'fem_gpu')
        capability_manifest_path = $manifestPath
        capability_manifest_sha256 = $manifestSha
        aggregate_manifest_sha256 = $manifestSha
        origin_manifest_path = $originManifestPath
        origin_manifest_sha256 = $originSha
        source_snapshot_sha256 = ('a' * 64)
        attempt_id = ('b' * 32)
        source_environment_receipt = [ordered]@{{ path = $admissionPath; sha256 = $admission.sha256 }}
      }}
    }}
    $receipt | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  }}
  function Invoke-Admission {{
    try {{
      $null = Get-ExistingInitialReceipt -Requested $receiptPath -Layout $layout -Admission $admission -Identity $identity -Mapping $mapping -Profile 'windows-native-fem-gpu' -StorageRoot $storageRoot -RuntimeLayout $runtimeLayout
      return $true
    }} catch {{
      return $false
    }}
  }}

  $results = [ordered]@{{}}
  Write-Baseline; $results.positive_all = Invoke-Admission
  Write-Baseline
  $single = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $single.scope = 'fem_gpu'
  $single | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $results.single_lane_rejected = -not (Invoke-Admission)
  Write-Baseline
  $missing = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $missing.full_runtime.installed_support = @('fdm_cpu', 'fdm_gpu', 'fem_cpu')
  $missing | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $results.missing_component_rejected = -not (Invoke-Admission)
  Write-Baseline
  [IO.File]::WriteAllText($manifestPath, 'capability-v2-mutated', $utf8)
  $results.changed_artifact_hash_rejected = -not (Invoke-Admission)
  Write-Baseline
  [IO.File]::WriteAllText($originManifestPath, 'origin-v2-mutated', $utf8)
  $results.changed_provenance_artifact_rejected = -not (Invoke-Admission)
  Write-Baseline
  $stale = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $stale.source_identity.main_git_head = ('0' * 40)
  $stale | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $results.stale_source_rejected = -not (Invoke-Admission)
  Write-Baseline
  $legacy = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $legacy.schema = 'fullmag.windows-installer-environment-receipt.v1'
  $legacy.version = '1.0.0'
  $legacy | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $results.legacy_single_lane_rejected = -not (Invoke-Admission)

  $failed = @($results.GetEnumerator() | Where-Object {{ -not [bool]$_.Value }})
  if ($failed.Count -ne 0) {{ throw ('receipt contract failures: ' + (($failed | ForEach-Object Name) -join ', ')) }}
  Write-Output ($results | ConvertTo-Json -Compress)
}} finally {{
  if (Test-Path -LiteralPath $fixtureRoot) {{ Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }}
}}
"""


class WindowsInstallerFullReceiptContract(unittest.TestCase):
    def test_full_initial_build_recipe_uses_supported_arguments(self) -> None:
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell 5.1 is unavailable")
        source = INSTALLER_ENV.read_text(encoding="utf-8-sig")
        self.assertIn(
            '@("just", "windows-full-workspace-build", "static", "0")',
            source,
        )
        self.assertNotIn(
            '@("just", "windows-full-workspace-build", "static", "0", "true")',
            source,
        )
        self.assertIn("-BuildRoot $buildRoot", source)
        recipe = _extract_function(
            "function Invoke-InitialBuild",
            "\nfunction Invoke-WorkspaceLaunch",
        )
        script = f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert-RegularFile {{
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {{ throw ($Label + '_missing') }}
}}
function Invoke-Captured {{
  param([Parameter(Mandatory = $true)][string]$Command, [Parameter(Mandatory = $true)][object[]]$Arguments)
  [ordered]@{{ command = $Command; arguments = @($Arguments); exit_code = 0; output = '{{}}' }}
}}
{recipe}
$checkout = [IO.Path]::GetTempPath()
$captured = Invoke-InitialBuild -Just 'just' -Checkout $checkout -StorageRoot $checkout -Backend 'full' -Device 'auto'
Write-Output ($captured | ConvertTo-Json -Depth 10 -Compress)
"""
        script_path = _write_native_script(powershell, script)
        try:
            result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    script_path,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=_native_environment(),
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            self.assertTrue(lines, result.stdout + result.stderr)
            captured = json.loads(lines[-1])
            self.assertEqual(
                captured["arguments"],
                ["windows-full-workspace-build", "static", "0"],
            )
        finally:
            _remove_native_path(powershell, script_path)

    def test_v2_all_receipt_is_admitted_and_invalid_variants_are_rejected(self) -> None:
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell 5.1 is unavailable")
        script_path = _write_native_script(powershell, _receipt_contract_script())
        try:
            result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    script_path,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=_native_environment(),
                timeout=60,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
            self.assertTrue(lines, result.stdout + result.stderr)
            outcome = json.loads(lines[-1])
            self.assertEqual(
                outcome,
                {
                    "positive_all": True,
                    "single_lane_rejected": True,
                    "missing_component_rejected": True,
                    "changed_artifact_hash_rejected": True,
                    "changed_provenance_artifact_rejected": True,
                    "stale_source_rejected": True,
                    "legacy_single_lane_rejected": True,
                },
            )
        finally:
            _remove_native_path(powershell, script_path)


if __name__ == "__main__":
    unittest.main()
