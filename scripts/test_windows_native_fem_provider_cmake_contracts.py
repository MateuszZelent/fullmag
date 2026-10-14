"""Exercise native FEM CMake boundary contracts without compiling providers."""

from __future__ import annotations

import subprocess
from pathlib import Path
import shutil
import time

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts/windows/native_fem_dependencies.ps1"
HYPRE_HOOK = ROOT / "scripts/windows/native_fem/hypre_cmake_compat.cmake"


def _write_utf8(path: Path, contents: str) -> None:
    """Keep CMake fixtures LF encoded on both Linux and native Windows."""
    path.write_bytes(contents.encode("utf-8"))


def _configure(source: Path, build: Path, *, hook: Path | None = None, provider_root: Path | None = None) -> subprocess.CompletedProcess[str]:
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("cmake is required for the no-compiler CMake fixture")
    command = [cmake, "-S", str(source), "-B", str(build)]
    if hook is not None:
        assert provider_root is not None
        command.extend(
            [
                f"-DCMAKE_PROJECT_INCLUDE_BEFORE={hook.as_posix()}",
                "-DFULLMAG_HYPRE_COMPAT_ENABLE=ON",
                f"-DFULLMAG_HYPRE_COMPAT_SOURCE_ROOT={provider_root.as_posix()}",
            ]
        )
    return subprocess.run(
        command,
        cwd=source / "seq_mv" if (source / "seq_mv").is_dir() else source,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_hypre_hook_is_scoped_to_pinned_seq_mv_templates() -> None:
    hook_source = HYPRE_HOOK.read_text(encoding="utf-8")
    module_source = MODULE.read_text(encoding="utf-8")
    assert "FULLMAG_HYPRE_COMPAT_SOURCE_ROOT" in hook_source
    assert "csr_spgemm_device_numer.in" in hook_source
    assert "csr_spgemm_device_symbl.in" in hook_source
    assert "file(WRITE \"${_fullmag_hypre_generated}\"" in hook_source
    assert 'if("${_fullmag_hypre_existing}" STREQUAL "${_fullmag_hypre_expected}")' in hook_source
    assert "-DCMAKE_PROJECT_INCLUDE_BEFORE=$hypreCmakeCompatCMake" in module_source
    assert "-WorkingDirectory (Join-Path $sourceRoots.hypre \"src\\seq_mv\")" in module_source
    assert "$hypreSourceCMake = ConvertTo-FullmagCMakePath $sourceRoots.hypre" in module_source


def test_hypre_generated_sources_keep_identity_and_regenerate_changed_templates(tmp_path: Path) -> None:
    """The scoped hook protects only equal generated contents, never stale templates."""
    provider_root = tmp_path / "provider root with spaces"
    source = provider_root / "src"
    seq_mv = source / "seq_mv"
    seq_mv.mkdir(parents=True)
    template_numer = "/* numer template */\n"
    template_symbl = "/* symbl template */\n"
    _write_utf8(seq_mv / "csr_spgemm_device_numer.in", template_numer)
    _write_utf8(seq_mv / "csr_spgemm_device_symbl.in", template_symbl)
    _write_utf8(
        source / "CMakeLists.txt",
        "cmake_minimum_required(VERSION 3.19)\n"
        "project(fake_hypre NONE)\n"
        "add_subdirectory(seq_mv)\n",
    )
    _write_utf8(
        seq_mv / "CMakeLists.txt",
        "file(READ \"csr_spgemm_device_numer.in\" NUMER_CONTENTS)\n"
        "foreach(number RANGE 1 10)\n"
        "  set(fn \"csr_spgemm_device_numer${number}.c\")\n"
        "  if(NOT EXISTS ${fn})\n"
        "    file(WRITE ${fn} \"#define HYPRE_SPGEMM_BIN ${number}\")\n"
        "    file(APPEND ${fn} \"${NUMER_CONTENTS}\")\n"
        "  endif()\n"
        "endforeach()\n"
        "file(READ \"csr_spgemm_device_symbl.in\" SYMBL_CONTENTS)\n"
        "foreach(number RANGE 1 10)\n"
        "  set(fn \"csr_spgemm_device_symbl${number}.c\")\n"
        "  if(NOT EXISTS ${fn})\n"
        "    file(WRITE ${fn} \"#define HYPRE_SPGEMM_BIN ${number}\")\n"
        "    file(APPEND ${fn} \"${SYMBL_CONTENTS}\")\n"
        "  endif()\n"
        "endforeach()\n",
    )
    build = tmp_path / "build"

    first = _configure(source, build, hook=HYPRE_HOOK, provider_root=provider_root)
    assert first.returncode == 0, first.stdout + first.stderr
    generated = [
        seq_mv / f"csr_spgemm_device_{kind}{number}.c"
        for kind in ("numer", "symbl")
        for number in range(1, 11)
    ]
    assert all(path.is_file() for path in generated)
    first_mtimes = {path: path.stat().st_mtime_ns for path in generated}
    assert (generated[0]).read_text(encoding="utf-8") == "#define HYPRE_SPGEMM_BIN 1" + template_numer

    time.sleep(1.1)
    second = _configure(source, build, hook=HYPRE_HOOK, provider_root=provider_root)
    assert second.returncode == 0, second.stdout + second.stderr
    assert {path: path.stat().st_mtime_ns for path in generated} == first_mtimes

    changed_template = "/* numer template changed */\n"
    _write_utf8(seq_mv / "csr_spgemm_device_numer.in", changed_template)
    time.sleep(1.1)
    third = _configure(source, build, hook=HYPRE_HOOK, provider_root=provider_root)
    assert third.returncode == 0, third.stdout + third.stderr
    for number in range(1, 11):
        path = seq_mv / f"csr_spgemm_device_numer{number}.c"
        assert path.stat().st_mtime_ns != first_mtimes[path]
        assert path.read_text(encoding="utf-8") == f"#define HYPRE_SPGEMM_BIN {number}" + changed_template
    for number in range(1, 11):
        path = seq_mv / f"csr_spgemm_device_symbl{number}.c"
        assert path.stat().st_mtime_ns == first_mtimes[path]


def test_mfem_like_config_consumes_forward_slash_mpi_path_with_spaces(tmp_path: Path) -> None:
    """A generated package config must parse a Windows MPI path as CMake data."""
    module_source = MODULE.read_text(encoding="utf-8")
    assert "function ConvertTo-FullmagCMakePath" in module_source
    assert "$mpiIncludeCMake = ConvertTo-FullmagCMakePath $mpiInclude" in module_source
    assert "$mpiLibraryCMake = ConvertTo-FullmagCMakePath $mpiLibrary" in module_source
    assert '"-DMPI_CXX_INCLUDE_DIRS=$mpiIncludeCMake"' in module_source
    assert '"-DMPI_CXX_LIBRARIES=$mpiLibraryCMake"' in module_source
    assert '"-DMPI_C_INCLUDE_DIRS=$mpiIncludeCMake"' in module_source
    assert '"-DMPI_C_LIBRARIES=$mpiLibraryCMake"' in module_source
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("cmake is required for the no-compiler CMake fixture")
    prefix = tmp_path / "installed prefix with spaces"
    config_dir = prefix / "lib" / "cmake" / "mfem"
    config_dir.mkdir(parents=True)
    normalized_mpi_include = "C:/git/fullmag/storage/MS MPI SDK/PFiles/Microsoft SDKs/MPI/Include"
    _write_utf8(
        config_dir / "MFEMConfig.cmake",
        "set(MFEM_MPI_CXX_INCLUDE_DIRS "
        f'"{normalized_mpi_include}")\n'
        "set(MFEM_MPI_CXX_LIBRARIES "
        '"C:/git/fullmag/storage/MS MPI SDK/PFiles/Microsoft SDKs/MPI/Lib/x64/msmpi.lib")\n'
        "add_library(MFEM::mfem INTERFACE IMPORTED)\n",
    )
    source = tmp_path / "consumer"
    source.mkdir()
    _write_utf8(
        source / "CMakeLists.txt",
        "cmake_minimum_required(VERSION 3.19)\n"
        "project(mfem_consumer NONE)\n"
        "find_package(MFEM CONFIG REQUIRED)\n"
        "file(WRITE \"${CMAKE_BINARY_DIR}/observed.txt\"\n"
        "  \"${MFEM_MPI_CXX_INCLUDE_DIRS}\\n${MFEM_MPI_CXX_LIBRARIES}\\n\")\n",
    )
    build = tmp_path / "consumer-build"
    result = subprocess.run(
        [
            cmake,
            "-S",
            str(source),
            "-B",
            str(build),
            f"-DCMAKE_PREFIX_PATH={prefix}",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Invalid character escape" not in result.stdout + result.stderr
    assert (build / "observed.txt").read_text(encoding="utf-8").splitlines() == [
        normalized_mpi_include,
        "C:/git/fullmag/storage/MS MPI SDK/PFiles/Microsoft SDKs/MPI/Lib/x64/msmpi.lib",
    ]
