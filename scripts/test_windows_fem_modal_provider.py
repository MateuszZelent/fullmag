"""Exercise the pinned Windows PETSc/SLEPc/MPI adapter contract.

The fixtures use ``project(... LANGUAGES NONE)`` and non-empty named files. They
exercise CMake discovery and target-property validation only; they are not PE,
ABI, solver, or runtime qualification.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "native/cmake/FindFullmagWindowsModal.cmake"


def _write_nonempty(path: Path, content: bytes = b"fixture file, not a binary") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _config_target(name: str, kind: str, properties: str, links: str = "", link_options: str = "") -> str:
    link_property = f" INTERFACE_LINK_LIBRARIES \"{links}\"" if links else ""
    option_property = f" INTERFACE_LINK_OPTIONS \"{link_options}\"" if link_options else ""
    return f"""
if(NOT TARGET {name})
    add_library({name} {kind} IMPORTED GLOBAL)
    set_target_properties({name} PROPERTIES {properties}{link_property}{option_property})
endif()
"""


def _make_prefix(
    root: Path,
    *,
    mpi_interface: bool = False,
    missing: str | None = None,
    wrong_petsc: bool = False,
    outside_petsc: Path | None = None,
    duplicate_petsc: bool = False,
    debug: bool = False,
    bare_mpi: bool = False,
    linker_option_mpi: bool = False,
    map_petsc_release: str | None = None,
    map_petsc_debug: str | None = None,
) -> Path:
    prefix = root / "prefix"
    lib = prefix / "lib"
    bin_dir = prefix / "bin"
    for stem in ("mpi", "mpi_impl", "petsc", "slepc"):
        _write_nonempty(lib / f"{stem}.lib")
        _write_nonempty(lib / f"{stem}-debug.lib")
    _write_nonempty(bin_dir / "petsc.dll")
    _write_nonempty(root / "outside" / "petsc.lib")

    mpi_config = prefix / "lib/cmake/mpi/MPIConfig.cmake"
    petsc_config = prefix / "lib/cmake/petsc/PETScConfig.cmake"
    slepc_config = prefix / "lib/cmake/slepc/SLEPcConfig.cmake"
    mpi_location = lib / "mpi_impl.lib" if mpi_interface else lib / "mpi.lib"
    mpi_release = mpi_location.as_posix()
    mpi_debug = (lib / ("mpi_impl-debug.lib" if mpi_interface else "mpi-debug.lib")).as_posix()
    mpi_target = (
        _config_target(
            "MPI::MPI_CXX_impl",
            "STATIC",
            f'IMPORTED_LOCATION_RELEASE "{mpi_release}" IMPORTED_LOCATION_DEBUG "{mpi_debug}"',
        )
        + "\n"
        + (
            _config_target(
                "MPI::MPI_CXX",
                "INTERFACE",
                "",
                link_options="LINKER:/DEFAULTLIB:msmpi" if linker_option_mpi else "",
            )
            if linker_option_mpi
            else _config_target(
                "MPI::MPI_CXX",
                "INTERFACE",
                "",
                'MPI::MPI_CXX_impl' if not bare_mpi else "msmpi",
            )
        )
        if mpi_interface or bare_mpi or linker_option_mpi
        else _config_target(
            "MPI::MPI_CXX",
            "STATIC",
            f'IMPORTED_LOCATION_RELEASE "{mpi_release}" IMPORTED_LOCATION_DEBUG "{mpi_debug}"',
        )
    )
    mpi_config.parent.mkdir(parents=True, exist_ok=True)
    mpi_config.write_text(
        f"set(MPI_CONFIG \"${{CMAKE_CURRENT_LIST_FILE}}\")\nset(MPI_FOUND TRUE)\n{mpi_target}\n",
        encoding="utf-8",
    )

    petsc_path = outside_petsc or (bin_dir / "petsc.dll" if wrong_petsc else lib / "petsc.lib")
    petsc_kind = "SHARED" if wrong_petsc else "STATIC"
    petsc_properties = (
        f'IMPORTED_LOCATION_RELEASE "{petsc_path.as_posix()}" '
        f'IMPORTED_LOCATION_DEBUG "{(lib / "petsc-debug.lib").as_posix()}"'
    )
    if map_petsc_release is not None:
        petsc_properties += f' MAP_IMPORTED_CONFIG_RELEASE "{map_petsc_release}"'
    if map_petsc_debug is not None:
        petsc_properties += f' MAP_IMPORTED_CONFIG_DEBUG "{map_petsc_debug}"'
    petsc_config.parent.mkdir(parents=True, exist_ok=True)
    petsc_config.write_text(
        f"set(PETSc_CONFIG \"${{CMAKE_CURRENT_LIST_FILE}}\")\nset(PETSc_FOUND TRUE)\n"
        + _config_target("PETSC::petsc", petsc_kind, petsc_properties, "MPI::MPI_CXX")
        + "\n",
        encoding="utf-8",
    )

    if missing != "SLEPc":
        slepc_config.parent.mkdir(parents=True, exist_ok=True)
        slepc_config.write_text(
            f"set(SLEPc_CONFIG \"${{CMAKE_CURRENT_LIST_FILE}}\")\nset(SLEPc_FOUND TRUE)\n"
            + _config_target(
                "SLEPC::slepc",
                "STATIC",
                f'IMPORTED_LOCATION_RELEASE "{(lib / "slepc.lib").as_posix()}" '
                f'IMPORTED_LOCATION_DEBUG "{(lib / "slepc-debug.lib").as_posix()}"',
                "PETSC::petsc",
            )
            + "\n",
            encoding="utf-8",
        )
    if duplicate_petsc:
        duplicate = prefix / "PETScConfig.cmake"
        duplicate.write_text(petsc_config.read_text(encoding="utf-8"), encoding="utf-8")
    return prefix


def _write_project(source: Path, *, prefix: Path, build_type: str = "Release", mfem: bool = False) -> None:
    mfem_config = ""
    if mfem:
        mfem_config = f"""
include(CMakeFindDependencyMacro)
set(MFEM_DIR "{prefix.as_posix()}")
find_package(MFEM CONFIG REQUIRED PATHS "{prefix.as_posix()}" NO_DEFAULT_PATH)
fullmag_validate_windows_modal()
"""
        _write_nonempty(
            prefix / "MFEMConfig.cmake",
            (
                "include(CMakeFindDependencyMacro)\n"
                "find_dependency(MPI CONFIG REQUIRED)\n"
                "set(MFEM_CONFIG \"${CMAKE_CURRENT_LIST_FILE}\")\n"
                "set(MFEM_FOUND TRUE)\n"
            ).encode(),
        )
    result = source / "modal-result.cmake"
    source.mkdir(parents=True, exist_ok=True)
    source.joinpath("CMakeLists.txt").write_text(
        f"""cmake_minimum_required(VERSION 3.18)
project(fullmag_windows_modal_fixture LANGUAGES NONE)
# LANGUAGES NONE intentionally has no compiler. These explicit fixture values
# exercise the Windows/MSVC branch without claiming a compiler or PE result.
set(WIN32 ON)
set(MSVC ON)
set(CMAKE_SIZEOF_VOID_P 8)
set(CMAKE_BUILD_TYPE "{build_type}" CACHE STRING "" FORCE)
set(FULLMAG_FEM_WITH_SLEPC ON)
set(FULLMAG_FEM_DEPENDENCY_PREFIX "{prefix.as_posix()}" CACHE PATH "" FORCE)
include("{MODULE.as_posix()}")
fullmag_find_windows_modal()
{mfem_config}
fullmag_validate_windows_modal()
file(WRITE "{result.as_posix()}"
    "set(TEST_PREFIX \\\"${{FULLMAG_WINDOWS_MODAL_PROVIDER_PREFIX}}\\\")\\n"
    "set(TEST_PROFILE \\\"${{FULLMAG_WINDOWS_MODAL_PROVIDER_PROFILE}}\\\")\\n"
    "set(TEST_FILES \\\"${{FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_FILES}}\\\")\\n"
    "set(TEST_CONFIGS \\\"${{FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_CONFIGS}}\\\")\\n"
)
""",
        encoding="utf-8",
    )


def _configure(tmp_path: Path, prefix: Path, *, build_type: str = "Release", mfem: bool = False, extra: list[str] | None = None, source: Path | None = None, build: Path | None = None) -> subprocess.CompletedProcess[str]:
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("CMake is required")
    source = source or (tmp_path / "source")
    build = build or (tmp_path / "build")
    _write_project(source, prefix=prefix, build_type=build_type, mfem=mfem)
    command = [cmake, "-S", str(source), "-B", str(build), "-DFULLMAG_FEM_DEPENDENCY_PREFIX=" + str(prefix)]
    if extra:
        command.extend(extra)
    return subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=60)


def _combined(result: subprocess.CompletedProcess[str]) -> str:
    return result.stdout + "\n" + result.stderr


def _read_result(source: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (source / "modal-result.cmake").read_text(encoding="utf-8").splitlines():
        match = re.match(r'^set\((TEST_[A-Z]+) "(.*)"\)$', line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def _normalized_path(value: str | Path) -> str:
    return str(value).replace("\\", "/").lower()


def test_pinned_static_provider_and_receipt(tmp_path: Path) -> None:
    prefix = _make_prefix(tmp_path)
    source = tmp_path / "source"
    result = _configure(tmp_path, prefix, source=source)
    assert result.returncode == 0, _combined(result)
    values = _read_result(source)
    assert values["TEST_PROFILE"] == "Release"
    assert _normalized_path(prefix) in _normalized_path(values["TEST_PREFIX"])
    assert "MPIConfig.cmake" in values["TEST_CONFIGS"]
    assert "petsc.lib" in values["TEST_FILES"]
    assert "slepc.lib" in values["TEST_FILES"]


def test_interface_mpi_target_is_traversed(tmp_path: Path) -> None:
    prefix = _make_prefix(tmp_path, mpi_interface=True)
    source = tmp_path / "source"
    result = _configure(tmp_path, prefix, source=source)
    assert result.returncode == 0, _combined(result)
    assert "mpi_impl.lib" in _read_result(source)["TEST_FILES"]


def test_mfem_find_dependency_reuses_pinned_mpi(tmp_path: Path) -> None:
    prefix = _make_prefix(tmp_path)
    source = tmp_path / "source"
    result = _configure(tmp_path, prefix, mfem=True, source=source)
    assert result.returncode == 0, _combined(result)


def test_stale_cache_is_rebound_to_new_prefix(tmp_path: Path) -> None:
    prefix_a = _make_prefix(tmp_path / "a")
    prefix_b = _make_prefix(tmp_path / "b")
    source = tmp_path / "source"
    build = tmp_path / "build"
    first = _configure(tmp_path, prefix_a, source=source, build=build)
    assert first.returncode == 0, _combined(first)
    second = _configure(
        tmp_path,
        prefix_b,
        source=source,
        build=build,
        extra=[
            "-DMPI_DIR=" + str(prefix_a / "lib/cmake/mpi"),
            "-DPETSc_DIR=" + str(prefix_a / "lib/cmake/petsc"),
            "-DSLEPc_DIR=" + str(prefix_a / "lib/cmake/slepc"),
        ],
    )
    assert second.returncode == 0, _combined(second)
    values = _read_result(source)
    assert _normalized_path(prefix_b) in _normalized_path(values["TEST_PREFIX"])
    assert _normalized_path(prefix_a) not in _normalized_path(values["TEST_FILES"])


def test_external_redirect_directory_cannot_override_prefix(tmp_path: Path) -> None:
    prefix = _make_prefix(tmp_path / "sdk")
    redirect = tmp_path / "redirect"
    redirect.mkdir()
    _write_nonempty(redirect / "MPIConfig.cmake", b"message(FATAL_ERROR \"redirect used\")\n")
    source = tmp_path / "source"
    result = _configure(
        tmp_path,
        prefix,
        source=source,
        extra=["-DCMAKE_FIND_PACKAGE_REDIRECTS_DIR=" + str(redirect)],
    )
    assert result.returncode == 0, _combined(result)
    assert _normalized_path(prefix) in _normalized_path(_read_result(source)["TEST_PREFIX"])


@pytest.mark.parametrize(
    "kwargs, needle",
    [
        ({"duplicate_petsc": True}, "found 2"),
        ({"missing": "SLEPc"}, "found 0"),
        ({"wrong_petsc": True}, "requires both Release DLL"),
        ({"outside_petsc": Path("OUTSIDE")}, "FULLMAG_FEM_DEPENDENCY_PREFIX"),
        ({"bare_mpi": True}, "concrete imported library target"),
        ({"linker_option_mpi": True}, "concrete imported library target"),
    ],
)
def test_invalid_provider_contracts_fail_closed(tmp_path: Path, kwargs: dict[str, object], needle: str) -> None:
    outside = tmp_path / "outside-real.lib"
    _write_nonempty(outside)
    if kwargs.get("outside_petsc") == Path("OUTSIDE"):
        kwargs = {**kwargs, "outside_petsc": outside}
    prefix = _make_prefix(tmp_path / "case", **kwargs)
    result = _configure(tmp_path, prefix)
    assert result.returncode != 0
    assert needle in _combined(result)


@pytest.mark.parametrize(
    "build_type,kwargs,expected_success",
    [
        ("Release", {"map_petsc_release": "Release"}, True),
        ("Release", {"map_petsc_release": "RELEASE"}, True),
        ("Release", {"map_petsc_release": ""}, False),
        ("Release", {"map_petsc_release": "RelWithDebInfo"}, False),
        ("Debug", {"map_petsc_debug": "Release"}, False),
    ],
)
def test_imported_config_mapping_is_identity_only(
    tmp_path: Path,
    build_type: str,
    kwargs: dict[str, str],
    expected_success: bool,
) -> None:
    prefix = _make_prefix(tmp_path, **kwargs)
    result = _configure(tmp_path, prefix, build_type=build_type)
    if expected_success:
        assert result.returncode == 0, _combined(result)
    else:
        assert result.returncode != 0
        assert "MAP_IMPORTED_CONFIG" in _combined(result)


def test_debug_profile_selects_debug_libraries(tmp_path: Path) -> None:
    prefix = _make_prefix(tmp_path, debug=True)
    source = tmp_path / "source"
    result = _configure(tmp_path, prefix, build_type="Debug", source=source)
    assert result.returncode == 0, _combined(result)
    values = _read_result(source)
    assert values["TEST_PROFILE"] == "Debug"
    assert "petsc-debug.lib" in values["TEST_FILES"]
    assert "petsc.lib" not in values["TEST_FILES"]


def test_backend_wiring_is_windows_only_and_linux_preserving() -> None:
    backend = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
    assert 'if(WIN32 AND FULLMAG_FEM_WITH_SLEPC)' in backend
    assert "FindFullmagWindowsModal.cmake" in backend
    assert "fullmag_find_windows_modal()" in backend
    assert "fullmag_validate_windows_modal()" in backend
    assert "find_package(PETSc REQUIRED)" in backend
    assert "find_package(SLEPc REQUIRED)" in backend


def test_backend_module_include_resolves_from_native_frontdoor(tmp_path: Path) -> None:
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("CMake is required")
    backend = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
    includes = re.findall(r'include\("[^"\n]*FindFullmagWindowsModal\.cmake"\)', backend)
    assert len(includes) == 1
    source = tmp_path / "native"
    (source / "cmake").mkdir(parents=True)
    shutil.copyfile(MODULE, source / "cmake" / MODULE.name)
    (source / "CMakeLists.txt").write_text(
        'cmake_minimum_required(VERSION 3.18)\n'
        'project(fullmag_native_frontdoor_fixture LANGUAGES NONE)\n'
        + includes[0] + '\n',
        encoding="utf-8",
    )
    result = subprocess.run([cmake, "-S", str(source), "-B", str(tmp_path / "build")],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, _combined(result)
