/*
 * GPU CUDA RK snapshot fallback source contract.
 *
 * Provides the no-CUDA fallback for strict device-source snapshot
 * recomputation. CUDA snapshot recomputation lives in rk_snapshot.cu.
 */

#include "gpu/cuda/integrators/rk/rk_snapshot.hpp"

#if !FULLMAG_HAS_CUDA_RUNTIME

namespace fullmag::fem {

bool gpu_rk_snapshot_current_state(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    (void)ctx;
    stats = {};
    reason = "GPU RK snapshot requires CUDA runtime support";
    return false;
}

} // namespace fullmag::fem

#endif
