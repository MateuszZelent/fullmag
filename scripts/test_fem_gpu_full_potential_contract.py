from __future__ import annotations

import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

FEM_BEM_TASK1_SHA256 = {
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem_dispatch.hpp":
        "8fc1ca7ed78e59928fe322cf971cf8ea3c43b2b25f85b4575df1e0957ca20969",
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu":
        "034fb0b7b498fa2615b214e66d1a975f76447ff01819b9a1949b836c23fa7d24",
    "backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp":
        "6ff5d292ddb5d83d61d51830022448d7982d2af93a7969c49373d4cdb3a0ef45",
    "docs/audits/2026-09-02-fem-gpu-solver-audit.md":
        "64a3ac03aa5e04485d83e0b7348b74be25f396617cc066ef91cb76469628b85b",
    "docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md":
        "a82db339cc64d36f16c451e05179d195d019a319ffba3608cd5a21a50644aec1",
}


class FemGpuFullPotentialContractTests(unittest.TestCase):
    def test_fem_bem_baseline_is_tracked_and_wired(self) -> None:
        for relative_path, expected_sha256 in FEM_BEM_TASK1_SHA256.items():
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

        operator_header = (
            ROOT
            / "backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp"
        ).read_text(encoding="utf-8")
        workspace_header = (
            ROOT
            / "backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.hpp"
        ).read_text(encoding="utf-8")
        gpu_source = (
            ROOT / "backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp"
        ).read_text(encoding="utf-8")
        gpu_header = (
            ROOT / "backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp"
        ).read_text(encoding="utf-8")
        validation_policy = (
            ROOT / "backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp"
        ).read_text(encoding="utf-8")
        poisson_operators = (
            ROOT / "backends/fem/gpu/cuda/demag_poisson/operators.cpp"
        ).read_text(encoding="utf-8")
        transfer_audit = (
            ROOT / "backends/fem/gpu/cuda/transfer/transfer_audit.cpp"
        ).read_text(encoding="utf-8")
        operator_source = (
            ROOT
            / "backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp"
        ).read_text(encoding="utf-8")
        self.assertIn("class AcaHMatrixDemagBemOperator", operator_header)
        self.assertIn('return "hierarchical_aca_hmatrix"', operator_header)
        self.assertIn(
            "std::unique_ptr<DenseDemagBemOperator> cpu_boundary_operator",
            workspace_header,
        )
        self.assertIn("gpu_workspace_destroy", workspace_header)
        self.assertIn("build_fredkin_koehler_demag_operators", gpu_source)
        self.assertIn("destroy_attached_demag_fem_bem_gpu_workspace", gpu_source)
        self.assertIn("workspace->d_boundary_tdofs", gpu_source)
        self.assertIn("HypreStreamLease stream_lease", gpu_header)
        self.assertIn("hypre_wait_for_fullmag", gpu_source)
        self.assertIn("fullmag_wait_for_hypre", gpu_source)
        self.assertNotIn("cudaStreamSynchronize", gpu_source)
        self.assertNotIn("record_mfem_host_sync", gpu_source)
        self.assertIn("FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL", validation_policy)
        self.assertIn("read_force_independent_residual_validation", gpu_source)
        self.assertIn("close_hypre_dependency", gpu_source)
        self.assertIn("allow_fredkin_koehler", poisson_operators)
        self.assertIn("hot_loop_compute_host_sync_count += 1", transfer_audit)
        for fingerprint_field in (
            '"boundary_node_x"',
            '"cell_type"',
            '"cell_node"',
            '"surface_triangle_node_0"',
            '"max_memory_bytes"',
            '"near_value"',
            '"far_u_value"',
            '"far_v_value"',
        ):
            self.assertIn(fingerprint_field, operator_source)


if __name__ == "__main__":
    unittest.main()
