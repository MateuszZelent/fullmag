"""Exercise native discovery cache invalidation without a compiler or FEM build."""
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
