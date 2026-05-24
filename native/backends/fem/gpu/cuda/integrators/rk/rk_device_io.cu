// ── GPU CUDA RK device I/O source contract ─────────────────────────────
// This compatibility source owns no low-level CUDA transfer implementation.
// Scalar readback lives in rk_scalar_readback.cu and component copies live in
// rk_component_copy.cu. RK orchestration remains in rk_step.cu.

#include "gpu/cuda/integrators/rk/rk_device_io.hpp"

namespace fullmag::fem {

// Intentionally empty compatibility translation unit.

} // namespace fullmag::fem
