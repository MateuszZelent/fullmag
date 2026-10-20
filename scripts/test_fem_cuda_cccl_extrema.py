"""Check the CUDA extrema source migration without compiling CUDA code."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CUDA_SOURCES = {
    Path("backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu"): 1,
    Path("backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu"): 2,
    Path("backends/fem/gpu/cuda/observables/observable_kernels.cu"): 2,
    Path("backends/fem/gpu/cuda/interactions/sot/sot_kernels.cu"): 1,
    Path("backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu"): 1,
    Path("backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu"): 2,
}
EXTREMA_HEADER = ROOT / "backends/fem/gpu/cuda/runtime/cccl_extrema.hpp"


class CudaCccLExtremaTests(unittest.TestCase):
    def test_cuda_sources_use_cccl_compatibility_functors(self):
        header = EXTREMA_HEADER.read_text(encoding="utf-8")
        self.assertIn("cuda::maximum/cuda::minimum", header)
        self.assertIn("both CCCL 2 and CCCL 3", header)
        self.assertIn("legacy_maximum", header)
        self.assertIn("legacy_minimum", header)

        for relative_path, max_count in CUDA_SOURCES.items():
            source = (ROOT / relative_path).read_text(encoding="utf-8")
            self.assertEqual(source.count("#include <cub/cub.cuh>"), 1, relative_path)
            self.assertEqual(
                source.count('#include "gpu/cuda/runtime/cccl_extrema.hpp"'),
                1,
                relative_path,
            )
            self.assertNotIn("cub::Max", source)
            self.assertNotIn("cub::Min", source)
            self.assertEqual(
                source.count("cuda_compat::legacy_maximum{}"),
                max_count,
                relative_path,
            )
            expected_min_count = 1 if "adaptive_error_kernels.cu" in str(relative_path) else 0
            self.assertEqual(
                source.count("cuda_compat::legacy_minimum{}"),
                expected_min_count,
                relative_path,
            )


if __name__ == "__main__":
    unittest.main()
