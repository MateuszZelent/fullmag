"""Exercise the public FEM header with MSVC preprocessing, without compilation."""

import os
from pathlib import Path
import re
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
HEADER = ROOT / "native/include/fullmag_fem.h"
DECLARATION = re.compile(
    r"(?m)^[ \t]*((?:__declspec\(\w+\)\s+)?"
    r"(?:int|void|const char\s*\*|fullmag_fem_\w+\s*\*|FullmagFemFrequencyDomainResult)"
    r"\s*)(fullmag_fem_\w+)\s*\("
)


@pytest.fixture(scope="module")
def msvc_preprocessor():
    if os.name != "nt":
        pytest.skip("Windows/MSVC preprocessor is required; this is not Linux proof")
    program_files = Path(os.environ["ProgramFiles(x86)"])
    vswhere = program_files / "Microsoft Visual Studio/Installer/vswhere.exe"
    if not vswhere.is_file():
        pytest.skip("Visual Studio discovery tool is unavailable")
    discovery = subprocess.run(
        [str(vswhere), "-latest", "-products", "*", "-requires",
         "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
         "-property", "installationPath"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    if not discovery:
        pytest.skip("MSVC toolchain is unavailable")
    versions = Path(discovery).joinpath("VC/Tools/MSVC")
    toolset = max(versions.iterdir(), key=lambda p: tuple(map(int, p.name.split("."))))
    sdk_root = program_files / "Windows Kits/10/Include"
    sdk = max(
        (p for p in sdk_root.iterdir() if p.joinpath("ucrt").is_dir()),
        key=lambda p: tuple(map(int, p.name.split("."))),
    )
    return [str(toolset / "bin/Hostx64/x64/cl.exe"), "/nologo", "/EP",
            f"/I{toolset / 'include'}", f"/I{sdk / 'ucrt'}"]


@pytest.mark.parametrize("language", ["/TC", "/TP"])
@pytest.mark.parametrize("mode", ["producer", "consumer", "non_windows"])
def test_public_fem_declarations_have_target_specific_dll_visibility(
    msvc_preprocessor, language, mode
):
    flags = {
        "producer": ["/DFULLMAG_FEM_BUILD_SHARED=1"],
        "consumer": [],
        "non_windows": ["/U_WIN32", "/U_WIN64"],
    }[mode]
    result = subprocess.run(
        [*msvc_preprocessor, language, *flags, str(HEADER)],
        capture_output=True, text=True, errors="replace", check=False,
    )
    assert result.returncode == 0, result.stderr
    declarations = DECLARATION.findall(result.stdout)
    expected = DECLARATION.findall(
        HEADER.read_text(encoding="utf-8").replace("FULLMAG_FEM_API ", "")
    )
    assert expected, "The public function inventory must not be empty"
    assert [name for _, name in declarations] == [name for _, name in expected]
    annotation = {"producer": "__declspec(dllexport)",
                  "consumer": "__declspec(dllimport)", "non_windows": ""}[mode]
    for prefix, name in declarations:
        if annotation:
            assert prefix.startswith(annotation), name
        else:
            assert "__declspec" not in prefix, name
    abi_record = re.findall(
        r"(?m)^extern[^\n;]*\bfullmag_fem_mesh_abi_record_v1;", result.stdout
    )
    assert len(abi_record) == 1, "The public ABI data symbol must remain declared"
    if annotation:
        assert annotation in abi_record[0]
    else:
        assert "__declspec" not in abi_record[0]
