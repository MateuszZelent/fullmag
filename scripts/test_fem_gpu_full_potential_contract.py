from __future__ import annotations

import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

FEM_BEM_BASELINE_SHA256 = {
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem_dispatch.hpp":
        "8fc1ca7ed78e59928fe322cf971cf8ea3c43b2b25f85b4575df1e0957ca20969",
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu":
        "94ff6a12d90fbdb6fe7c0e6e37472760d47535a06a888a263108c87259f23550",
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp":
        "d9df53f8cb4fb2b7c20f1933dbe603944f2bc7a17db5dbe1b0b0e91892422aa7",
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp":
        "8980051c8a333b9d2abd6f2e5b1e79da27280cd8040dd4759f7c2ed96209fbf2",
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp":
        "b3220bd0db8d44512bb8fab0cb63110575bd64d9ad1f71ff49e415ac8a52b87d",
    "backends/fem/tests/demag_fem_bem_gpu_contract.cpp":
        "fe4a06a0a49ec528e7940e2f09b4db0c40843299e9419574bfef9b3f23d4d9bb",
    "docs/audits/2026-09-02-fem-gpu-solver-audit.md":
        "64a3ac03aa5e04485d83e0b7348b74be25f396617cc066ef91cb76469628b85b",
    "docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md":
        "6c978a7805d806df80f0801b9c3c685e2a56ff3541987158b21e2f4d86b5d674",
}


class FemGpuFullPotentialContractTests(unittest.TestCase):
    def test_fem_bem_baseline_is_tracked_and_wired(self) -> None:
        for relative_path, expected_sha256 in FEM_BEM_BASELINE_SHA256.items():
            path = ROOT / relative_path
            self.assertTrue(path.is_file(), relative_path)
            self.assertEqual(
                hashlib.sha256(path.read_bytes()).hexdigest(),
                expected_sha256,
                relative_path,
            )

        cmake = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
        self.assertIn("gpu/cuda/demag_fem_bem/fem_bem.cpp", cmake)
        self.assertIn("gpu/cuda/demag_fem_bem/fem_bem_kernels.cu", cmake)
        self.assertIn("fem_demag_fem_bem_gpu_contract", cmake)

        enum_entry = "FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM = 3"
        native_header = (ROOT / "native/include/fullmag_fem.h").read_text(
            encoding="utf-8"
        )
        rust_ffi = (ROOT / "crates/fullmag-fem-sys/src/lib.rs").read_text(
            encoding="utf-8"
        )
        self.assertIn(enum_entry, native_header)
        self.assertIn(enum_entry, rust_ffi)


if __name__ == "__main__":
    unittest.main()
