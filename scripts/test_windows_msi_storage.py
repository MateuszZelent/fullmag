"""Execute MSI path preflight and DLL discovery without builds or cleanup."""

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts/windows/build_windows_msi.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
pytestmark = pytest.mark.skipif(os.name != "nt" or not POWERSHELL, reason="Windows/PowerShell is required")


def run_driver(tmp_path, text, *arguments):
    driver = tmp_path / "driver.ps1"
    driver.write_text(text, encoding="utf-8")
    return subprocess.run([POWERSHELL, "-NoProfile", "-File", str(driver), *map(str, arguments)],
                          capture_output=True, text=True, errors="replace", timeout=20)


@pytest.mark.parametrize("case", ["valid", "target_escape", "native_escape"])
def test_msi_initialization_uses_resolver_and_preflights_before_links(tmp_path, case):
    result = run_driver(tmp_path, '''param($Repo, $Installer, $Fixture, $Case)
$ErrorActionPreference = 'Stop'
. (Join-Path $Repo 'scripts/windows/fullmag_storage.ps1')
$RepoRoot = Join-Path $Fixture 'source'
$StorageProfile = 'windows-msi-cpu'
$TargetTriple = 'x86_64-pc-windows-msvc'
$storage = Join-Path $Fixture 'storage'
$build = Join-Path $storage 'builds/test/windows-msi-cpu'
$target = if ($Case -eq 'target_escape') { Join-Path $Fixture 'outside' } else { Join-Path $build 'target' }
$script:fakeLayout = [pscustomobject]@{ storage_root=$storage; build_root=$build; runs_root=(Join-Path $build 'runs'); env=[pscustomobject]@{CARGO_TARGET_DIR=$target} }
function Resolve-FullmagStorageLayout { param($RepoRoot, $Profile) if ($Profile -ne 'windows-msi-cpu') { throw 'Wrong profile' }; return $script:fakeLayout }
function Prepare-FullmagStorageLinks { param($RepoRoot, $Profile, [switch]$Frontend); if (-not $Frontend) { throw 'Missing frontend route' }; $script:linksPrepared=$true }
$env:FULLMAG_FDM_NATIVE_BUILD_ROOT = if ($Case -eq 'native_escape') { Join-Path $Fixture 'outside' } else { $null }
$script:linksPrepared=$false
$source = Get-Content -LiteralPath $Installer -Raw
$start = $source.IndexOf('$StorageLayout = Resolve-FullmagStorageLayout')
$end = $source.IndexOf('function Require-Command', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Storage preflight missing' }
try {
  Invoke-Expression $source.Substring($start, $end-$start)
  $firstRun=$DistRoot
  Invoke-Expression $source.Substring($start, $end-$start)
  @{target=$TargetRoot; run=$DistRoot; first_run=$firstRun; stage=$StageRoot; wix=$WixRoot; wheel=$WheelRoot; native=$nativeFdmBuildRoot; links=$script:linksPrepared} | ConvertTo-Json -Compress
} catch {
  @{error=$_.Exception.Message; links=$script:linksPrepared} | ConvertTo-Json -Compress
  exit 2
}
''', ROOT, INSTALLER, tmp_path, case)
    data = json.loads(result.stdout)
    if case != "valid":
        assert result.returncode == 2
        assert "must be contained" in data["error"]
        assert data["links"] is False
    else:
        assert result.returncode == 0, result.stderr
        build = tmp_path / "storage/builds/test/windows-msi-cpu"
        assert Path(data["target"]) == build / "target"
        assert Path(data["native"]) == build / "native"
        assert Path(data["run"]).parent == build / "runs"
        assert data["run"] != data["first_run"]
        for key in ("stage", "wix", "wheel"):
            assert Path(data[key]).parent == Path(data["run"])
        assert data["links"] is True
        assert not Path(data["run"]).exists(), "Path selection must not create staging"


@pytest.mark.parametrize("case", ["release", "flat", "missing", "ambiguous", "stale_cargo_only"])
def test_native_dll_discovery_uses_current_profile_root(tmp_path, case):
    native = tmp_path / "native"
    locations = []
    if case in ("release", "ambiguous"):
        locations.append(native / "backends/fdm/Release/fullmag_fdm.dll")
    if case in ("flat", "ambiguous"):
        locations.append(native / "backends/fdm/fullmag_fdm.dll")
    stale = tmp_path / "cargo/x86_64-pc-windows-msvc/release/build/fullmag-fdm-sys-old/out/native-build/backends/fdm/fullmag_fdm.dll"
    locations.append(stale)
    for path in locations:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"DLL discovery fixture, not a binary")
    result = run_driver(tmp_path, '''param($Installer, $NativeRoot, $StaleRoot)
$ErrorActionPreference='Stop'
$nativeFdmBuildRoot=$NativeRoot
$TargetRoot=$StaleRoot
$TargetTriple='x86_64-pc-windows-msvc'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Find-NativeFdmDll'},$true)
Invoke-Expression $fn.Extent.Text
(Find-NativeFdmDll).FullName | ConvertTo-Json -Compress
''', INSTALLER, native, tmp_path / "cargo")
    if case in ("release", "flat"):
        assert result.returncode == 0, result.stderr
        expected = native / ("backends/fdm/Release/fullmag_fdm.dll" if case == "release" else "backends/fdm/fullmag_fdm.dll")
        assert Path(json.loads(result.stdout)) == expected
    else:
        assert result.returncode != 0
        assert "exactly one canonical" in result.stderr


def test_invalid_version_fails_before_storage_wrapper(tmp_path):
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(INSTALLER), "-Version", "invalid"],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode != 0
    assert "MSI version must be" in result.stderr


def test_msi_and_container_wrapper_do_not_delete_previous_staging_or_container():
    installer = INSTALLER.read_text(encoding="utf-8")
    wrapper = (ROOT / "scripts/windows/build_installer_windows_container.ps1").read_text(encoding="utf-8")
    assert "Remove-Item -Recurse -Force $StageRoot" not in installer
    assert "fullmag-build\\cargo-targets\\fullmag-windows-msi" not in installer
    assert "docker rm -f" not in wrapper
    assert '[Guid]::NewGuid().ToString("N")' in wrapper
    assert '.fullmag\\dist\\fullmag.msi' not in wrapper
    assert "-m build --outdir $WheelRoot" in installer


@pytest.mark.parametrize("case", ["valid", "missing", "empty", "directory"])
def test_artifact_locations_are_emitted_only_for_nonempty_outputs(tmp_path, case):
    msi = tmp_path / "fullmag.msi"
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}")
    if case == "valid":
        msi.write_bytes(b"MSI output fixture, not an installer")
    elif case == "empty":
        msi.write_bytes(b"")
    elif case == "directory":
        msi.mkdir()
    outputs = tmp_path / "github-output"
    outputs.write_text("previous=value\n")
    result = run_driver(tmp_path, '''param($Installer, $Msi, $Manifest, $Output)
$ErrorActionPreference='Stop'
$env:GITHUB_OUTPUT=$Output
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-MsiArtifactLocations'},$true)
Invoke-Expression $fn.Extent.Text
Write-MsiArtifactLocations -MsiPath $Msi -StageManifestPath $Manifest
''', INSTALLER, msi, manifest, outputs)
    lines = outputs.read_text(encoding="utf-8-sig").splitlines()
    if case == "valid":
        assert result.returncode == 0, result.stderr
        assert lines == ["previous=value", f"msi_path={msi}", f"manifest_path={manifest}"]
    else:
        assert result.returncode != 0
        assert "MSI output must be a nonempty file" in result.stderr
        assert lines == ["previous=value"]


def test_native_workflow_consumes_validated_artifact_outputs():
    import yaml

    workflow = yaml.load((ROOT / ".github/workflows/windows-msi-container.yml").read_text(), Loader=yaml.BaseLoader)
    job = workflow["jobs"]["build-windows-msi"]
    assert job["runs-on"] == ["self-hosted", "windows", "x64", "fullmag-native-msvc-wix"]
    assert job["concurrency"]["cancel-in-progress"] == "false"
    package = next(step for step in job["steps"] if step.get("id") == "package")
    assert package["run"].strip().endswith(".\\scripts\\windows\\build_windows_msi.ps1")
    assert '$env:FULLMAG_FEM_DEPENDENCY_PREFIX = $env:FULLMAG_WINDOWS_FEM_GPU_PREFIX' in package["run"]
    uploads = [step for step in job["steps"] if "upload-artifact" in step.get("uses", "")]
    assert [step["with"]["path"] for step in uploads] == [
        "${{ steps.package.outputs.msi_path }}", "${{ steps.package.outputs.manifest_path }}"
    ]
    assert all(step["with"]["if-no-files-found"] == "error" for step in uploads)
