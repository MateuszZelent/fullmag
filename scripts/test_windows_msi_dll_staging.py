"""Exercise installer DLL copying in PowerShell; fixtures are not binaries."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import pytest


INSTALLER = Path(__file__).resolve().parent / "windows/build_windows_msi.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


def invoke_staging(tmp_path, sources, bin_dir):
    if not POWERSHELL:
        pytest.skip("PowerShell is required")
    inputs = tmp_path / "inputs.json"
    inputs.write_text(json.dumps([str(path) for path in sources]), encoding="utf-8")
    driver = tmp_path / "driver.ps1"
    driver.write_text('''param($Installer, $InputsFile, $BinDirectory)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Copy-RuntimeDllSet' }, $true)
if (-not $fn) { throw 'Production DLL staging function missing' }
Invoke-Expression $fn.Extent.Text
$sources = @(Get-Content -LiteralPath $InputsFile -Raw | ConvertFrom-Json)
@(Copy-RuntimeDllSet -SourcePaths $sources -BinDirectory $BinDirectory) | ConvertTo-Json -Compress -Depth 4
''', encoding="utf-8")
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-File", str(driver), str(INSTALLER), str(inputs), str(bin_dir)],
        capture_output=True, text=True, errors="replace", timeout=20,
    )


def test_runtime_dlls_are_copied_beside_executables_with_hash_inventory(tmp_path):
    release = tmp_path / "release with spaces"
    native = tmp_path / "native"
    bin_dir = tmp_path / "bin"
    for directory in (release, native, bin_dir):
        directory.mkdir()
    first = release / "dependency.dll"
    second = native / "fullmag_fdm.dll"
    first.write_bytes(b"dependency fixture")
    second.write_bytes(b"FDM fixture")
    result = invoke_staging(tmp_path, [second, first], bin_dir)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [
        {"path": f"bin/{p.name}", "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in (first, second)
    ]
    for source in (first, second):
        assert (bin_dir / source.name).read_bytes() == source.read_bytes()


@pytest.mark.parametrize("case,error", [
    ("missing", "Runtime DLL is missing"),
    ("directory", "Runtime DLL is missing"),
    ("empty", "nonempty .dll"),
    ("extension", "nonempty .dll"),
    ("collision", "Conflicting runtime DLL basename"),
    ("existing", "Conflicting staged runtime DLL"),
])
def test_invalid_dll_set_is_rejected_before_any_copy(tmp_path, case, error):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    first = tmp_path / "first.dll"
    first.write_bytes(b"first")
    bad = tmp_path / "bad.dll"
    if case == "directory":
        bad.mkdir()
    elif case == "empty":
        bad.write_bytes(b"")
    elif case == "extension":
        bad = tmp_path / "bad.so"
        bad.write_bytes(b"other platform")
    elif case == "collision":
        parent = tmp_path / "duplicate"
        parent.mkdir()
        bad = parent / "FIRST.dll"
        bad.write_bytes(b"different")
    elif case == "existing":
        bad.write_bytes(b"valid")
        (bin_dir / first.name).write_bytes(b"preserve this")
    result = invoke_staging(tmp_path, [first, bad], bin_dir)
    assert result.returncode != 0
    assert error in result.stderr
    expected_files = [first.name] if case == "existing" else []
    assert sorted(p.name for p in bin_dir.iterdir()) == expected_files
    if case == "existing":
        assert (bin_dir / first.name).read_bytes() == b"preserve this"


def test_identical_case_insensitive_dll_duplicates_are_idempotent(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    first = tmp_path / "dependency.dll"
    second_dir = tmp_path / "second"
    second_dir.mkdir()
    second = second_dir / "DEPENDENCY.dll"
    for source in (first, second):
        source.write_bytes(b"same fixture")
    for _ in range(2):
        result = invoke_staging(tmp_path, [first, second], bin_dir)
        assert result.returncode == 0, result.stderr
        inventory = json.loads(result.stdout)
        assert inventory["path"].lower() == "bin/dependency.dll"
    assert len(list(bin_dir.iterdir())) == 1
