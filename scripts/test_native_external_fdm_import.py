"""Configure the real imported target using fixture files; never compile/link."""

from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "native/cmake/ImportFullmagFdm.cmake"


def configure_import(tmp_path, system, msvc, files, directories=()):
    cmake = shutil.which("cmake")
    if not cmake:
        pytest.skip("CMake is required for the imported-target configure gate")
    libraries = tmp_path / "library directory"
    includes = tmp_path / "include directory"
    libraries.mkdir()
    includes.mkdir()
    for name in files:
        (libraries / name).write_bytes(b"configure fixture, not a loadable library")
    for name in directories:
        (libraries / name).mkdir()
    source = tmp_path / "source"
    source.mkdir()
    (source / "CMakeLists.txt").write_text(
        f'''cmake_minimum_required(VERSION 3.18)
set(CMAKE_SYSTEM_NAME {system})
project(import_contract LANGUAGES NONE)
set(MSVC {'TRUE' if msvc else 'FALSE'})
include("{MODULE.as_posix()}")
fullmag_import_external_fdm("{libraries.as_posix()}" "{includes.as_posix()}")
get_target_property(runtime fullmag_fdm IMPORTED_LOCATION)
get_target_property(implib fullmag_fdm IMPORTED_IMPLIB)
get_target_property(headers fullmag_fdm INTERFACE_INCLUDE_DIRECTORIES)
file(WRITE "${{CMAKE_BINARY_DIR}}/properties.txt" "${{runtime}}\\n${{implib}}\\n${{headers}}\\n")
''', encoding="utf-8",
    )
    build = tmp_path / "configure"
    result = subprocess.run(
        [cmake, "-S", str(source), "-B", str(build)],
        capture_output=True, text=True, errors="replace", check=False,
    )
    properties = build / "properties.txt"
    return result, properties, libraries, includes


@pytest.mark.parametrize("system,msvc,files,runtime,implib", [
    ("Windows", True, ["fullmag_fdm.dll", "fullmag_fdm.lib"], "fullmag_fdm.dll", "fullmag_fdm.lib"),
    ("Windows", False, ["fullmag_fdm.dll", "libfullmag_fdm.dll.a"], "fullmag_fdm.dll", "libfullmag_fdm.dll.a"),
    ("Linux", False, ["libfullmag_fdm.so"], "libfullmag_fdm.so", None),
    ("Linux", False, ["libfullmag_fdm.so.0"], "libfullmag_fdm.so.0", None),
    ("Linux", False, ["libfullmag_fdm.so", "libfullmag_fdm.so.0"], "libfullmag_fdm.so", None),
])
def test_imported_target_separates_runtime_and_import_library(
    tmp_path, system, msvc, files, runtime, implib
):
    result, properties, libraries, includes = configure_import(tmp_path, system, msvc, files)
    assert result.returncode == 0, result.stdout + result.stderr
    runtime_path, import_path, header_path = properties.read_text().splitlines()
    assert runtime_path == (libraries / runtime).as_posix()
    assert import_path == ((libraries / implib).as_posix() if implib else "implib-NOTFOUND")
    assert header_path == includes.as_posix()


@pytest.mark.parametrize("system,msvc,files,directories,error", [
    ("Windows", True, ["fullmag_fdm.dll"], [], "import library is missing"),
    ("Windows", True, ["fullmag_fdm.lib"], [], "runtime is missing"),
    ("Windows", True, ["libfullmag_fdm.so"], [], "runtime is missing"),
    ("Windows", True, ["fullmag_fdm.dll", "libfullmag_fdm.dll.a"], [], "import library is missing"),
    ("Windows", True, ["fullmag_fdm.dll"], ["fullmag_fdm.lib"], "import library is missing"),
    ("Linux", False, ["fullmag_fdm.dll", "fullmag_fdm.lib"], [], "does not contain"),
    ("Linux", False, [], ["libfullmag_fdm.so"], "does not contain"),
])
def test_wrong_or_incomplete_target_libraries_fail_configuration(
    tmp_path, system, msvc, files, directories, error
):
    result, properties, _, _ = configure_import(tmp_path, system, msvc, files, directories)
    assert result.returncode != 0
    assert error in result.stderr
    assert not properties.exists()
