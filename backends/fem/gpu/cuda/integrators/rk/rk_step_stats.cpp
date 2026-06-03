/*
 * GPU CUDA RK final step stats fallback source contract.
 *
 * Provides the no-CUDA fallback for final stats publication. CUDA final scalar
 * reductions live in rk_step_stats.cu.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#if !FULLMAG_HAS_CUDA_RUNTIME

namespace fullmag::fem {

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    (void)ctx;
    (void)stats;
    (void)reason;
    return true;
}

} // namespace fullmag::fem

#endif
