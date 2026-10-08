"""Configure isolated projects against the production FEM CUDA driver selector."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
CUDA_DRIVER_MODULE = REPO_ROOT / "backends" / "fem" / "cmake"
DRIVER_FILENAME = "cuda.lib" if os.name == "nt" else "libcuda.so"


class CudaDriverSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cmake = shutil.which("cmake")
        if not cls.cmake:
            raise RuntimeError("CMake is required for the CUDA driver selection check")

        ninja = shutil.which("ninja")
        make = shutil.which("make")
        if ninja:
            cls.generator = "Ninja"
            cls.generator_program = Path(ninja).resolve()
        elif make:
            cls.generator = "Unix Makefiles"
            cls.generator_program = Path(make).resolve()
        else:
            raise RuntimeError("Ninja or make is required for the CUDA driver selection check")

    def test_toolkit_stub_hint_is_not_a_driver_candidate(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-stub-hint-") as directory:
            root = Path(directory)
            toolkit = root / "toolkit"
            stubs = toolkit / "targets" / "x86_64-linux" / "lib" / "stubs"
            stubs.mkdir(parents=True)
            (stubs / DRIVER_FILENAME).write_bytes(b"stub")

            result = self._configure(
                root,
                f"-DCMAKE_CUDA_COMPILER_TOOLKIT_ROOT:PATH={toolkit}",
            )

            self._assert_rejected(result, "CUDA driver or compatibility library")

    def test_default_library_search_rejects_stub_directory(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-default-stub-") as directory:
            root = Path(directory)
            stubs = root / "toolkit" / "lib" / "stubs"
            stubs.mkdir(parents=True)
            (stubs / DRIVER_FILENAME).write_bytes(b"stub")

            result = self._configure(root, f"-DCMAKE_LIBRARY_PATH:PATH={stubs}")

            self._assert_rejected(result, "CUDA toolkit stub library")

    def test_cached_stub_path_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-cache-stub-") as directory:
            root = Path(directory)
            stubs = root / "toolkit" / "lib" / "stubs"
            stubs.mkdir(parents=True)
            stub = stubs / DRIVER_FILENAME
            stub.write_bytes(b"stub")

            result = self._configure(
                root,
                f"-DFULLMAG_CUDA_DRIVER_LIBRARY:FILEPATH={stub}",
            )

            self._assert_rejected(result, "CUDA toolkit stub library")

    @unittest.skipIf(os.name == "nt", "POSIX symlink fixture required")
    def test_compat_symlink_resolving_into_stubs_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-symlink-stub-") as directory:
            root = Path(directory)
            toolkit = root / "toolkit"
            compat = toolkit / "compat"
            stubs = toolkit / "targets" / "x86_64-linux" / "lib" / "stubs"
            compat.mkdir(parents=True)
            stubs.mkdir(parents=True)
            stub = stubs / DRIVER_FILENAME
            stub.write_bytes(b"stub")
            (compat / DRIVER_FILENAME).symlink_to(stub)

            result = self._configure(
                root,
                f"-DCMAKE_CUDA_COMPILER_TOOLKIT_ROOT:PATH={toolkit}",
            )

            self._assert_rejected(result, "CUDA toolkit stub library")

    def test_real_compatibility_driver_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-real-compat-") as directory:
            root = Path(directory)
            toolkit = root / "toolkit"
            compat = toolkit / "compat"
            compat.mkdir(parents=True)
            driver = compat / DRIVER_FILENAME
            driver.write_bytes(b"driver")

            result = self._configure(
                root,
                f"-DCMAKE_CUDA_COMPILER_TOOLKIT_ROOT:PATH={toolkit}",
            )

            self._assert_selected(result, driver)

    def test_real_default_search_driver_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-real-system-") as directory:
            root = Path(directory)
            system_library = root / "system-lib"
            system_library.mkdir()
            driver = system_library / DRIVER_FILENAME
            driver.write_bytes(b"driver")

            result = self._configure(
                root,
                f"-DCMAKE_LIBRARY_PATH:PATH={system_library}",
            )

            self._assert_selected(result, driver)

    def test_existing_windows_import_library_outside_stubs_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-import-library-") as directory:
            root = Path(directory)
            import_library = root / "driver" / "cuda.lib"
            import_library.parent.mkdir()
            import_library.write_bytes(b"import library")

            result = self._configure(
                root,
                f"-DFULLMAG_CUDA_DRIVER_LIBRARY:FILEPATH={import_library}",
            )

            self._assert_selected(result, import_library)

    def test_relative_cached_path_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-relative-cache-") as directory:
            result = self._configure(
                Path(directory),
                "-DFULLMAG_CUDA_DRIVER_LIBRARY:FILEPATH=relative/libcuda.so",
            )

            self._assert_rejected(result, "must be an absolute path")

    def test_missing_driver_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-cuda-driver-missing-") as directory:
            root = Path(directory)
            result = self._configure(root)

            self._assert_rejected(result, "CUDA driver or compatibility library")

    def _configure(self, root, *arguments):
        source = root / "project"
        source.mkdir()
        cmake_lists = "\n".join(
            (
                "cmake_minimum_required(VERSION 3.18)",
                "project(fullmag_cuda_driver_selection NONE)",
                "set(CMAKE_FIND_USE_PACKAGE_ROOT_PATH FALSE)",
                "set(CMAKE_FIND_USE_CMAKE_ENVIRONMENT_PATH FALSE)",
                "set(CMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH FALSE)",
                "set(CMAKE_FIND_USE_CMAKE_SYSTEM_PATH FALSE)",
                "set(CMAKE_FIND_USE_INSTALL_PREFIX FALSE)",
                f'list(PREPEND CMAKE_MODULE_PATH "{CUDA_DRIVER_MODULE.as_posix()}")',
                "include(FullmagCudaDriverLibrary)",
                "fullmag_find_cuda_driver_library(FULLMAG_CUDA_DRIVER_LIBRARY)",
                "add_library(fem_cuda_driver_selection_target INTERFACE)",
                "target_link_libraries(fem_cuda_driver_selection_target INTERFACE \"${FULLMAG_CUDA_DRIVER_LIBRARY}\")",
                "get_target_property(_selected_links fem_cuda_driver_selection_target INTERFACE_LINK_LIBRARIES)",
                'list(FIND _selected_links "${FULLMAG_CUDA_DRIVER_LIBRARY}" _selected_driver_index)',
                "if(_selected_driver_index EQUAL -1)",
                '  message(FATAL_ERROR "Selected CUDA driver is absent from INTERFACE_LINK_LIBRARIES")',
                "endif()",
                'message(STATUS "FULLMAG_TEST_SELECTED_CUDA_DRIVER_LIBRARY=${FULLMAG_CUDA_DRIVER_LIBRARY}")',
                'message(STATUS "FULLMAG_TEST_CUDA_DRIVER_INTERFACE_LINK=${_selected_links}")',
                "",
            )
        )
        (source / "CMakeLists.txt").write_text(cmake_lists, encoding="utf-8")
        return subprocess.run(
            [
                self.cmake,
                "-G",
                self.generator,
                "-S",
                str(source),
                "-B",
                str(root / "build"),
                f"-DCMAKE_MAKE_PROGRAM:FILEPATH={self.generator_program}",
                *arguments,
            ],
            capture_output=True,
            text=True,
        )

    def _assert_rejected(self, result, expected_message):
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn(expected_message, " ".join(output.split()), output)

    def _assert_selected(self, result, expected_path):
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertIn(
            f"FULLMAG_TEST_SELECTED_CUDA_DRIVER_LIBRARY={expected_path.resolve()}",
            output,
        )
        self.assertIn(
            f"FULLMAG_TEST_CUDA_DRIVER_INTERFACE_LINK={expected_path.resolve()}",
            output,
        )


if __name__ == "__main__":
    unittest.main()
