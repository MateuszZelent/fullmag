"""Check FEM CMake library metadata for single- and multi-config generators.

The fixture uses an imported target and a ``NONE`` project, so this exercises
CMake generation only.  It never compiles a FEM source or a Rust crate.
"""

from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[1]
FEM_CMAKE = ROOT / "backends/fem/CMakeLists.txt"
FEM_SYS_BUILD = ROOT / "crates/fullmag-fem-sys/build.rs"


def _configure(cmake: str, source: Path, build: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [cmake, "-S", str(source), "-B", str(build), *extra],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def _cmake_path(path: Path) -> str:
    """Compare CMake's slash style consistently on native Windows and WSL."""
    value = str(path).replace("\\", "/")
    if value.startswith("/mnt/c/"):
        value = "C:/" + value[len("/mnt/c/") :]
    return value.casefold()


def _require_cmake() -> str:
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("CMake unavailable: metadata generation NOT VERIFIED")
    return cmake


def _production_metadata_block() -> str:
    production = FEM_CMAKE.read_text(encoding="utf-8")
    match = re.search(
        r"(?ms)^if\(CMAKE_CONFIGURATION_TYPES\)\n.*?^file\(GENERATE OUTPUT .*?\n    CONTENT .*?\)\n",
        production,
    )
    assert match is not None, "production CMake metadata generation block is missing"
    return match.group(0)


def _write_fixture(source: Path) -> None:
    backend_source = source / "backends" / "fem"
    backend_source.mkdir(parents=True)
    metadata_block = _production_metadata_block()
    (source / "CMakeLists.txt").write_text(
        textwrap.dedent(
            r"""
            cmake_minimum_required(VERSION 3.20)
            project(fullmag_fem_library_metadata NONE)
            add_subdirectory(backends/fem)
            """
        ).lstrip(),
        encoding="utf-8",
        newline="\n",
    )
    fixture = textwrap.dedent(
        r"""
            add_library(fullmag_fem SHARED IMPORTED GLOBAL)
            file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/backends/fem")
            if(CMAKE_CONFIGURATION_TYPES)
                set_target_properties(fullmag_fem PROPERTIES
                    IMPORTED_CONFIGURATIONS "Debug;Release"
                    IMPORTED_LOCATION_DEBUG "${CMAKE_BINARY_DIR}/Debug/fullmag_fem.dll"
                    IMPORTED_LOCATION_RELEASE "${CMAKE_BINARY_DIR}/Release/fullmag_fem.dll"
                )
            else()
                set_target_properties(fullmag_fem PROPERTIES
                    IMPORTED_LOCATION "${CMAKE_BINARY_DIR}/fullmag_fem.so"
                )
            endif()
            """
    ).lstrip() + metadata_block + "\n"
    (backend_source / "CMakeLists.txt").write_text(
        fixture,
        encoding="utf-8",
        newline="\n",
    )


def test_production_uses_config_specific_metadata_only_for_multi_config() -> None:
    cmake_source = FEM_CMAKE.read_text(encoding="utf-8")
    assert 'if(CMAKE_CONFIGURATION_TYPES)' in cmake_source
    assert 'fullmag-fem-library-path-$<CONFIG>.txt' in cmake_source
    assert 'fullmag-fem-library-path.txt' in cmake_source
    assert 'file(GENERATE OUTPUT "${FULLMAG_FEM_LIBRARY_PATH_METADATA}"' in cmake_source

    build_source = FEM_SYS_BUILD.read_text(encoding="utf-8")
    assert 'CMAKE_CONFIGURATION_TYPES:' in build_source
    assert 'fullmag-fem-library-path-{cmake_build_type}.txt' in build_source
    assert 'fullmag-fem-library-path.txt' in build_source
    assert 'native FEM library metadata escaped its canonical CMake output directory' in build_source
    assert 'canonical_target_path = target_path.canonicalize()' in build_source
    assert 'target_path.starts_with(&native_lib_root)' not in build_source
    assert 'let configured = native_lib_root.join(cmake_build_type)' not in build_source


def test_cmake_metadata_fixture_preserves_single_config_path(tmp_path: Path) -> None:
    cmake = _require_cmake()
    if shutil.which("ninja") is None:
        pytest.skip("Ninja unavailable: single-config metadata generation NOT VERIFIED")
    source = tmp_path / "source"
    _write_fixture(source)

    single_build = tmp_path / "single-build"
    single = _configure(cmake, source, single_build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release")
    assert single.returncode == 0, single.stdout + single.stderr
    single_metadata = single_build / "backends/fem/fullmag-fem-library-path.txt"
    assert _cmake_path(Path(single_metadata.read_text(encoding="utf-8").strip())) == _cmake_path(
        single_build / "fullmag_fem.so"
    )
    assert not (single_build / "backends/fem/fullmag-fem-library-path-Release.txt").exists()


def test_cmake_metadata_fixture_preserves_multi_config_paths(tmp_path: Path) -> None:
    cmake = _require_cmake()
    source = tmp_path / "source"
    _write_fixture(source)

    if shutil.which("ninja") is not None:
        generator = ("-G", "Ninja Multi-Config")
    else:
        cmake_help = subprocess.run(
            [cmake, "--help"], capture_output=True, text=True, timeout=30, check=True
        ).stdout
        if "Visual Studio 17 2022" not in cmake_help:
            pytest.skip("No supported multi-config generator: metadata generation NOT VERIFIED")
        generator = ("-G", "Visual Studio 17 2022", "-A", "x64")

    multi_build = tmp_path / "multi-build"
    multi = _configure(cmake, source, multi_build, *generator)
    assert multi.returncode == 0, multi.stdout + multi.stderr
    for configuration in ("Debug", "Release"):
        metadata = multi_build / f"backends/fem/fullmag-fem-library-path-{configuration}.txt"
        assert _cmake_path(Path(metadata.read_text(encoding="utf-8").strip())) == _cmake_path(
            multi_build / configuration / "fullmag_fem.dll"
        )
    assert not (multi_build / "backends/fem/fullmag-fem-library-path.txt").exists()
