"""Exercise native discovery cache invalidation without a compiler or FEM build."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import unittest


class DependencyCacheTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("cmake"), "CMake unavailable: cache contract NOT VERIFIED")
    def test_changed_prefix_replaces_retained_discovery_without_compiling(self):
        source = (Path(__file__).resolve().parents[1] / "crates/fullmag-fem-sys/build.rs").read_text(encoding="utf-8")
        flags = re.findall(r'\.arg\("(-U(?:PETSc_\*|SLEPc_\*|MFEM_DIR|CMAKE_PREFIX_PATH))"\)', source)
        self.assertEqual(set(flags), {"-UPETSc_*", "-USLEPc_*", "-UMFEM_DIR", "-UCMAKE_PREFIX_PATH"})
        with tempfile.TemporaryDirectory(prefix="fullmag-cmake-discovery-") as directory:
            root = Path(directory)
            (root / "CMakeLists.txt").write_text(
                'cmake_minimum_required(VERSION 3.20)\nproject(discovery NONE)\n'
                'set(CMAKE_PREFIX_PATH "${REQUESTED_PREFIX}" CACHE PATH "")\n'
                'set(PETSc_LIBRARY "${REQUESTED_PREFIX}/petsc" CACHE FILEPATH "")\n'
                'set(SLEPc_LIBRARY "${REQUESTED_PREFIX}/slepc" CACHE FILEPATH "")\n'
                'set(MFEM_DIR "${REQUESTED_PREFIX}/mfem" CACHE PATH "")\n', encoding="utf-8")
            def configure(prefix, extra=()):
                result = subprocess.run([shutil.which("cmake"), "-S", str(root), "-B", str(root / "build"),
                                         "-DREQUESTED_PREFIX=" + prefix, *extra], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return (root / "build/CMakeCache.txt").read_text(encoding="utf-8")
            first = configure("old-gpu")
            retained = configure("new-cpu")
            self.assertIn("PETSc_LIBRARY:FILEPATH=old-gpu/petsc", first)
            self.assertIn("PETSc_LIBRARY:FILEPATH=old-gpu/petsc", retained)
            refreshed = configure("new-cpu", flags)
            self.assertIn("CMAKE_PREFIX_PATH:PATH=new-cpu", refreshed)
            for name, kind, suffix in (("PETSc_LIBRARY", "FILEPATH", "petsc"),
                                       ("SLEPc_LIBRARY", "FILEPATH", "slepc"), ("MFEM_DIR", "PATH", "mfem")):
                self.assertIn(f"{name}:{kind}=new-cpu/{suffix}", refreshed)


class PkgConfigPrimaryLibraryTests(unittest.TestCase):
    cmake = shutil.which("cmake")
    pkg_config = shutil.which("pkg-config") or shutil.which("pkgconf")

    @unittest.skipUnless(cmake, "CMake unavailable: dependency cache contract NOT VERIFIED")
    @unittest.skipUnless(
        pkg_config,
        "pkg-config/pkgconf unavailable: native dependency cache contract NOT VERIFIED",
    )
    def test_public_libraries_match_imported_primary_libraries(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-pkgconfig-primary-") as directory:
            root = Path(directory)
            preferred = self._make_prefix(root, "preferred-324", "3.24.6", "3.24.3")
            legacy = self._make_legacy_prefix(root)
            build = root / "build"
            self._configure_and_assert(build, preferred, legacy)

    @unittest.skipUnless(cmake, "CMake unavailable: dependency cache contract NOT VERIFIED")
    @unittest.skipUnless(
        pkg_config,
        "pkg-config/pkgconf unavailable: native dependency cache contract NOT VERIFIED",
    )
    def test_seeded_cache_is_replaced_and_prefix_changes_are_observed(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-pkgconfig-cache-") as directory:
            root = Path(directory)
            first = self._make_prefix(root, "preferred-324", "3.24.6", "3.24.3")
            second = self._make_prefix(root, "preferred-325", "3.25.0", "3.25.0")
            legacy = self._make_legacy_prefix(root)
            build = root / "build"

            self._configure_and_assert(build, first, legacy)
            stale_cache = [
                "-DPETSc_LIBRARY:FILEPATH=" + str(legacy / "lib" / "libpetsc_real.so"),
                "-DSLEPc_LIBRARY:FILEPATH=" + str(legacy / "lib" / "libslepc_real.so"),
                "-Dpkgcfg_lib_PETSc_PKG_petsc:FILEPATH=" + str(legacy / "lib" / "libpetsc_real.so"),
                "-Dpkgcfg_lib_SLEPc_PKG_slepc:FILEPATH=" + str(legacy / "lib" / "libslepc_real.so"),
            ]
            self._configure_and_assert(build, first, legacy, extra=stale_cache)
            self._configure_and_assert(build, second, legacy, extra=stale_cache)

    @unittest.skipUnless(cmake, "CMake unavailable: dependency cache contract NOT VERIFIED")
    @unittest.skipUnless(
        pkg_config,
        "pkg-config/pkgconf unavailable: native dependency cache contract NOT VERIFIED",
    )
    def test_missing_declared_primary_fails_despite_legacy_real_library(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-pkgconfig-missing-") as directory:
            root = Path(directory)
            legacy = self._make_legacy_prefix(root)
            cases = (
                ("PETSc", self._make_prefix(root, "missing-petsc", "3.24.6", "3.24.3", missing_petsc=True)),
                ("SLEPc", self._make_prefix(root, "missing-slepc", "3.24.6", "3.24.3", missing_slepc=True)),
            )
            for package, preferred in cases:
                with self.subTest(package=package):
                    build = root / f"build-{package}"
                    source = root / f"missing-project-{package}"
                    source.mkdir()
                    self._write_missing_project(source, legacy, package)
                    result = self._run_configure(source, build, preferred)
                    self.assertEqual(
                        result.returncode,
                        0,
                        f"Find{package} must reject a pkg-config prefix without its declared primary library;\n"
                        + result.stdout
                        + result.stderr,
                    )
                    self.assertTrue((build / "rejected-missing-primary.txt").exists())

    def _make_prefix(
        self,
        root,
        name,
        petsc_version,
        slepc_version,
        missing_petsc=False,
        missing_slepc=False,
    ):
        prefix = root / name
        library_dir = prefix / "lib"
        pkgconfig_dir = library_dir / "pkgconfig"
        include_dir = prefix / "include"
        pkgconfig_dir.mkdir(parents=True)
        (include_dir / "petsc").mkdir(parents=True)
        (include_dir / "slepc").mkdir(parents=True)
        if not missing_petsc:
            (library_dir / "libpetsc.so").write_bytes(b"fixture")
        if not missing_slepc:
            (library_dir / "libslepc.so").write_bytes(b"fixture")
        (library_dir / "libfixturedep.so").write_bytes(b"dependency fixture")
        prefix_text = prefix.as_posix()
        (pkgconfig_dir / "PETSc.pc").write_text(
            "\n".join(
                (
                    f"prefix={prefix_text}",
                    "exec_prefix=${prefix}",
                    "libdir=${prefix}/lib",
                    "includedir=${prefix}/include",
                    "Name: PETSc",
                    "Description: Fullmag dependency discovery fixture",
                    f"Version: {petsc_version}",
                    f"Libs: -L${{libdir}} -lpetsc -lfixturedep -Wl,--fixture-{name}",
                    f"Cflags: -I${{includedir}}/petsc -DFULLMAG_FIXTURE_PROVIDER={name}",
                    "",
                )
            ),
            encoding="utf-8",
        )
        (pkgconfig_dir / "SLEPc.pc").write_text(
            "\n".join(
                (
                    f"prefix={prefix_text}",
                    "exec_prefix=${prefix}",
                    "libdir=${prefix}/lib",
                    "includedir=${prefix}/include",
                    "Name: SLEPc",
                    "Description: Fullmag dependency discovery fixture",
                    f"Version: {slepc_version}",
                    "Requires: PETSc",
                    f"Libs: -L${{libdir}} -lslepc -Wl,--fixture-{name}",
                    f"Cflags: -I${{includedir}}/slepc -DFULLMAG_FIXTURE_PROVIDER={name}",
                    "",
                )
            ),
            encoding="utf-8",
        )
        return prefix

    def _make_legacy_prefix(self, root):
        library_dir = root / "legacy-system" / "lib"
        library_dir.mkdir(parents=True)
        (library_dir / "libpetsc_real.so").write_bytes(b"legacy fixture")
        (library_dir / "libslepc_real.so").write_bytes(b"legacy fixture")
        return library_dir.parent

    def _write_project(self, source, legacy):
        module_dir = Path(__file__).resolve().parents[1] / "backends" / "fem" / "cmake"
        (source / "CMakeLists.txt").write_text(
            "\n".join(
                (
                    "cmake_minimum_required(VERSION 3.20)",
                    "project(fullmag_cmake_dependency_probe NONE)",
                    f'list(PREPEND CMAKE_MODULE_PATH "{module_dir.as_posix()}")',
                    f'set(CMAKE_LIBRARY_PATH "{(legacy / "lib").as_posix()}")',
                    "find_package(PETSc REQUIRED)",
                    "find_package(SLEPc REQUIRED)",
                    "get_target_property(_petsc_links PkgConfig::PETSc_PKG INTERFACE_LINK_LIBRARIES)",
                    "get_target_property(_slepc_links PkgConfig::SLEPc_PKG INTERFACE_LINK_LIBRARIES)",
                    "foreach(_pair IN ITEMS PETSc SLEPc)",
                    "  if(_pair STREQUAL PETSc)",
                    "    set(_public_library \"${PETSc_LIBRARY}\")",
                    "    set(_target_links \"${_petsc_links}\")",
                    "    set(_expected_prefix \"${EXPECTED_PETSC_PREFIX}\")",
                    "  else()",
                    "    set(_public_library \"${SLEPc_LIBRARY}\")",
                    "    set(_target_links \"${_slepc_links}\")",
                    "    set(_expected_prefix \"${EXPECTED_SLEPC_PREFIX}\")",
                    "  endif()",
                    "  if(NOT _public_library OR NOT EXISTS \"${_public_library}\")",
                    "    message(FATAL_ERROR \"${_pair}_LIBRARY is missing or does not exist: ${_public_library}\")",
                    "  endif()",
                    "  file(REAL_PATH \"${_public_library}\" _public_real)",
                    "  file(REAL_PATH \"${_expected_prefix}\" _prefix_real)",
                    "  string(FIND \"${_public_real}\" \"${_prefix_real}/lib/\" _prefix_position)",
                    "  if(NOT _prefix_position EQUAL 0)",
                    "    message(FATAL_ERROR \"${_pair}_LIBRARY escaped selected pkg-config prefix: ${_public_real}\")",
                    "  endif()",
                    "  set(_target_match FALSE)",
                    "  foreach(_target_library IN LISTS _target_links)",
                    "    if(EXISTS \"${_target_library}\")",
                    "      file(REAL_PATH \"${_target_library}\" _target_real)",
                    "      if(_target_real STREQUAL _public_real)",
                    "        set(_target_match TRUE)",
                    "      endif()",
                    "    endif()",
                    "  endforeach()",
                    "  if(NOT _target_match)",
                    "    message(FATAL_ERROR \"${_pair}_LIBRARY does not match the PkgConfig imported target: ${_public_real} vs ${_target_links}\")",
                    "  endif()",
                    "endforeach()",
                    "foreach(_family IN ITEMS PETSc SLEPc)",
                    "  get_target_property(_includes PkgConfig::${_family}_PKG INTERFACE_INCLUDE_DIRECTORIES)",
                    "  get_target_property(_compile_options PkgConfig::${_family}_PKG INTERFACE_COMPILE_OPTIONS)",
                    "  get_target_property(_link_options PkgConfig::${_family}_PKG INTERFACE_LINK_OPTIONS)",
                    "  get_target_property(_links PkgConfig::${_family}_PKG INTERFACE_LINK_LIBRARIES)",
                    "  string(TOLOWER ${_family} _lower)",
                    '  set(_expected_include "${EXPECTED_PETSC_PREFIX}/include/${_lower}")',
                    '  if(NOT _expected_include IN_LIST _includes OR NOT _expected_include IN_LIST ${_family}_INCLUDE_DIRS)',
                    '    message(FATAL_ERROR "${_family} retained stale include directories: ${_includes}")',
                    "  endif()",
                    '  if(NOT "${${_family}_VERSION}" STREQUAL "${EXPECTED_${_family}_VERSION}")',
                    '    message(FATAL_ERROR "${_family} retained stale version: ${${_family}_VERSION}")',
                    "  endif()",
                    '  if(NOT "-DFULLMAG_FIXTURE_PROVIDER=${EXPECTED_PROVIDER}" IN_LIST _compile_options)',
                    '    message(FATAL_ERROR "${_family} lost/staled compile options: ${_compile_options}")',
                    "  endif()",
                    '  if(NOT "-Wl,--fixture-${EXPECTED_PROVIDER}" IN_LIST _link_options)',
                    '    message(FATAL_ERROR "${_family} lost/staled link options: ${_link_options}")',
                    "  endif()",
                    '  if(NOT "${EXPECTED_PETSC_PREFIX}/lib/libfixturedep.so" IN_LIST _links)',
                    '    message(FATAL_ERROR "${_family} lost/staled transitive dependency: ${_links}")',
                    "  endif()",
                    "endforeach()",
                    "",
                )
            ),
            encoding="utf-8",
        )

    def _run_configure(self, source, build, preferred, extra=()):
        command = [
            self.cmake,
            "-S",
            str(source),
            "-B",
            str(build),
            "-DPKG_CONFIG_EXECUTABLE=" + self.pkg_config,
            "-DEXPECTED_PETSC_PREFIX=" + str(preferred),
            "-DEXPECTED_SLEPC_PREFIX=" + str(preferred),
            *extra,
        ]
        environment = os.environ.copy()
        pkgconfig_dir = preferred / "lib" / "pkgconfig"
        environment["PKG_CONFIG_PATH"] = str(pkgconfig_dir)
        environment["PKG_CONFIG_LIBDIR"] = str(pkgconfig_dir)
        return subprocess.run(command, capture_output=True, text=True, env=environment)

    def _configure_and_assert(self, build, preferred, legacy, extra=()):
        source = build.parent / "probe-project"
        source.mkdir(exist_ok=True)
        self._write_project(source, legacy)
        command = [
            self.cmake,
            "-S",
            str(source),
            "-B",
            str(build),
            "-DPKG_CONFIG_EXECUTABLE=" + self.pkg_config,
            "-DEXPECTED_PETSC_PREFIX=" + str(preferred),
            "-DEXPECTED_SLEPC_PREFIX=" + str(preferred),
            "-DEXPECTED_PROVIDER=" + preferred.name,
            *["-DEXPECTED_" + family + "_VERSION=" + next(
                line.split("Version: ", 1)[1] for line in
                (preferred / "lib/pkgconfig" / (family + ".pc")).read_text().splitlines()
                if line.startswith("Version: ")) for family in ("PETSc", "SLEPc")],
            *extra,
        ]
        environment = os.environ.copy()
        pkgconfig_dir = preferred / "lib" / "pkgconfig"
        environment["PKG_CONFIG_PATH"] = str(pkgconfig_dir)
        environment["PKG_CONFIG_LIBDIR"] = str(pkgconfig_dir)
        result = subprocess.run(command, capture_output=True, text=True, env=environment)
        self.assertEqual(
            result.returncode,
            0,
            "CMake dependency discovery did not select matching PETSc/SLEPc libraries;\n"
            + result.stdout
            + result.stderr,
        )

    def _write_missing_project(self, source, legacy, package):
        module_dir = Path(__file__).resolve().parents[1] / "backends" / "fem" / "cmake"
        if package == "PETSc":
            find_package = "PETSc"
            public_library = "PETSc_LIBRARY"
        else:
            find_package = "SLEPc"
            public_library = "SLEPc_LIBRARY"
        (source / "CMakeLists.txt").write_text(
            "\n".join(
                (
                    "cmake_minimum_required(VERSION 3.20)",
                    "project(fullmag_missing_dependency_probe NONE)",
                    f'list(PREPEND CMAKE_MODULE_PATH "{module_dir.as_posix()}")',
                    f'set(CMAKE_LIBRARY_PATH "{(legacy / "lib").as_posix()}")',
                    f"find_package({find_package} QUIET)",
                    f"if({find_package}_FOUND)",
                    f"  message(FATAL_ERROR \"Find{find_package} accepted a package without its declared primary library\")",
                    "endif()",
                    f"if({public_library} AND EXISTS \"${{{public_library}}}\")",
                    f"  message(FATAL_ERROR \"Find{find_package} exposed an external fallback as its primary library: ${{{public_library}}}\")",
                    "endif()",
                    'file(WRITE "${CMAKE_BINARY_DIR}/rejected-missing-primary.txt" "rejected")',
                    "",
                )
            ),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
