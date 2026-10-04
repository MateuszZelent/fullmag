"""Run production PowerShell staging with real offline pip and fixture wheels."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts/windows/python_package.ps1"


@pytest.mark.parametrize("case", ["valid", "content_changed", "wrong_name", "wrong_version", "embedded_name", "embedded_version", "duplicate_metadata"])
def test_staged_project_wheel_matches_frozen_hash_and_identity(tmp_path, case):
    project = tmp_path / "pyproject.toml"
    project.write_text('[project]\nname="fullmag"\nversion="0.1.0"\n', encoding="utf-8")
    name = "other" if case == "wrong_name" else "fullmag"
    version = "0.2.0" if case == "wrong_version" else "0.1.0"
    path = wheel(tmp_path, name, version)
    if case in {"embedded_name", "embedded_version", "duplicate_metadata"}:
        with zipfile.ZipFile(path) as archive:
            contents = {entry: archive.read(entry) for entry in archive.namelist()}
        key = "fullmag-0.1.0.dist-info/METADATA"
        if case == "embedded_name":
            contents[key] = contents[key].replace(b"Name: fullmag", b"Name: other")
        elif case == "embedded_version":
            contents[key] = contents[key].replace(b"Version: 0.1.0", b"Version: 0.2.0")
        else:
            contents["other-0.1.0.dist-info/METADATA"] = contents[key]
        with zipfile.ZipFile(path, "w") as archive:
            for key, content in contents.items():
                archive.writestr(key, content)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if case == "content_changed":
        with path.open("ab") as stream:
            stream.write(b"modified after staging")
    result = subprocess.run([sys.executable, str(ROOT / "scripts/check_staged_python_wheel.py"),
                             "--wheel", str(path), "--project", str(project), "--sha256", digest],
                            capture_output=True, text=True, timeout=10)
    assert (result.returncode == 0) == (case == "valid"), result.stdout + result.stderr
    expected = {"content_changed": "hash differs", "wrong_name": "filename differs", "wrong_version": "filename differs",
                "embedded_name": "embedded name/version differs", "embedded_version": "embedded name/version differs",
                "duplicate_metadata": "one matching metadata directory"}
    if case != "valid":
        assert expected[case] in result.stderr


def wheel(directory, name, version):
    target = directory / f"{name}-{version}-py3-none-any.whl"
    info = f"{name}-{version}.dist-info"
    contents = {
        f"{name}/__init__.py": "FIXTURE = True\n",
        f"{info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        f"{info}/WHEEL": "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    contents[f"{info}/RECORD"] = "".join(f"{path},,\n" for path in [*contents, f"{info}/RECORD"])
    with zipfile.ZipFile(target, "w") as archive:
        for name, content in contents.items():
            archive.writestr(name, content)
    return target


@pytest.mark.parametrize("case", ["valid", "export_fail", "download_fail", "lock_changed", "requirements_changed", "wheel_tampered", "project_install_fail", "dirty_site", "host_mismatch"])
def test_locked_staging_runs_offline_and_stops_on_errors(tmp_path, case):
    shell = shutil.which("pwsh") or shutil.which("powershell")
    if os.name != "nt" or not shell:
        pytest.skip("Native Windows PowerShell required")
    inputs = tmp_path / "source with spaces"
    project = inputs / "packages/fullmag-py"
    project.mkdir(parents=True)
    (project / "pyproject.toml").write_text("fixture project", encoding="utf-8")
    (project / "uv.lock").write_text("fixture lock", encoding="utf-8")
    wheels = tmp_path / "fixture wheels"
    wheels.mkdir()
    dependency = wheel(wheels, "fixturedep", "1.0")
    fullmag = wheel(wheels, "fullmag", "0.1.0")
    requirements = tmp_path / "export fixture.txt"
    requirements.write_text(f"fixturedep==1.0 --hash=sha256:{hashlib.sha256(dependency.read_bytes()).hexdigest()}\n", encoding="utf-8")
    site = tmp_path / "staged site"
    if case == "dirty_site":
        site.mkdir()
        (site / "preserve.txt").write_text("preserve", encoding="utf-8")
    driver = tmp_path / "driver.ps1"
    driver.write_text('''param($Module,$RepoRoot,$Wheel,$Site,$Proof,$PythonExe,$Requirements,$Case,$Output)
$ErrorActionPreference='Stop'
. $Module
$script:calls=@()
$script:exportFixture=$Requirements
function fixture-uv {
  $script:calls += 'export'
  if ($Case -eq 'export_fail') { $global:LASTEXITCODE=17; return }
  $index=[Array]::IndexOf($args,'--output-file')
  Copy-Item -LiteralPath $script:exportFixture -Destination $args[$index+1]
  $global:LASTEXITCODE=0
}
function fixture-python {
  $arguments=@($args)
  $operation=if ($arguments -contains 'download') { 'download' } elseif ($arguments -contains 'install') { if ($arguments -contains '--no-deps') { 'project' } else { 'dependencies' } } else { 'inspect' }
  $script:calls += $operation
  if (($Case -eq 'download_fail' -and $operation -eq 'download') -or ($Case -eq 'project_install_fail' -and $operation -eq 'project')) { $global:LASTEXITCODE=17; return }
  if ($Case -eq 'wheel_tampered' -and $operation -eq 'dependencies') {
    $file=Get-ChildItem (Join-Path $Proof 'wheelhouse') -Filter '*.whl' | Select-Object -First 1
    [System.IO.File]::AppendAllText($file.FullName,'changed')
  }
  & $PythonExe @arguments
  $code=$LASTEXITCODE
  if ($operation -eq 'download' -and $code -eq 0) {
    if ($Case -eq 'lock_changed') { [System.IO.File]::AppendAllText((Join-Path $RepoRoot 'packages/fullmag-py/uv.lock'),'changed') }
    if ($Case -eq 'requirements_changed') { [System.IO.File]::AppendAllText((Join-Path $Proof 'requirements.txt'),'changed') }
  }
  $global:LASTEXITCODE=$code
}
try {
  $minor=if ($Case -eq 'host_mismatch') { 99 } else { 12 }
  $result=Stage-FullmagLockedPythonPackages -RepoRoot $RepoRoot -WheelPath $Wheel -SiteDirectory $Site -ProofDirectory $Proof -PythonCommand 'fixture-python' -UvCommand 'fixture-uv' -ExpectedPythonMinor $minor
  [System.IO.File]::WriteAllText($Output,($result | ConvertTo-Json -Depth 10),[System.Text.UTF8Encoding]::new($false))
} finally {
  [System.IO.File]::WriteAllText(($Output+'.calls'),(ConvertTo-Json -InputObject @($script:calls)),[System.Text.UTF8Encoding]::new($false))
}
''', encoding="utf-8")
    output = tmp_path / "inventory.json"
    env = dict(os.environ, PIP_NO_INDEX="1", PIP_FIND_LINKS=wheels.as_uri(), PIP_CONFIG_FILE=os.devnull)
    result = subprocess.run([shell, "-NoProfile", "-File", str(driver), str(MODULE), str(inputs), str(fullmag), str(site),
                             str(tmp_path / "proof"), sys.executable, str(requirements), case, str(output)],
                            env=env, capture_output=True, text=True, errors="replace", timeout=50)
    calls = json.loads(Path(str(output) + ".calls").read_text(encoding="utf-8"))
    if case == "valid":
        assert result.returncode == 0, result.stdout + result.stderr
        inventory = json.loads(output.read_text(encoding="utf-8"))
        assert calls == ["inspect", "export", "download", "dependencies", "project"]
        assert inventory["wheels"][0]["sha256"] == hashlib.sha256(dependency.read_bytes()).hexdigest()
        assert inventory["requirements_sha256"] == hashlib.sha256(requirements.read_bytes()).hexdigest()
        assert (site / "fullmag/__init__.py").is_file()
        assert (site / "fixturedep/__init__.py").is_file()
        assert not list(site.rglob("*.pyc"))
    else:
        assert result.returncode != 0
        assert not output.exists()
        expected = {
            "export_fail": ["inspect", "export"],
            "download_fail": ["inspect", "export", "download"],
            "lock_changed": ["inspect", "export", "download"],
            "requirements_changed": ["inspect", "export", "download"],
            "wheel_tampered": ["inspect", "export", "download", "dependencies"],
            "project_install_fail": ["inspect", "export", "download", "dependencies", "project"],
            "dirty_site": [],
            "host_mismatch": ["inspect"],
        }
        assert calls == expected[case], result.stdout + result.stderr
        messages = {"export_fail": "requirements export failed", "download_fail": "wheel download failed",
                    "lock_changed": "input changed", "requirements_changed": "requirements changed",
                    "project_install_fail": "Fullmag wheel installation failed", "dirty_site": "site directory must be empty",
                    "host_mismatch": "host ABI does not match"}
        if case in messages:
            assert messages[case] in result.stdout + result.stderr
        if case in {"export_fail", "download_fail", "lock_changed", "requirements_changed", "dirty_site"}:
            assert "dependencies" not in calls
        if case == "wheel_tampered":
            assert "project" not in calls
            assert "HASHES" in (result.stdout + result.stderr).upper()
