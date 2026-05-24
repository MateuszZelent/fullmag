// ── GPU CUDA RK stage kernels source contract ──────────────────────────
// This compatibility source owns no low-level CUDA kernel implementation.
// Predictor kernels live in rk_stage_predictor_kernels.cu and accept kernels
// live in rk_stage_accept_kernels.cu. RK orchestration remains in rk_step.cu.

#include "gpu/cuda/integrators/rk/rk_stage_kernels.hpp"

namespace fullmag::fem {

// Intentionally empty compatibility translation unit.

} // namespace fullmag::fem
