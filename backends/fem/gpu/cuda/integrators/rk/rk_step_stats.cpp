/*
 * GPU CUDA RK final step stats fallback source contract.
 *
 * Provides the no-CUDA fallback for final stats publication. CUDA final scalar
 * reductions live in rk_step_stats.cu.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#if !FULLMAG_HAS_CUDA_RUNTIME

namespace fullmag::fem {

double *gpu_rk_final_scalar_result(FemGpuState &gpu, GpuFinalScalarSlot slot)
{
    return gpu.reductions.scalar_result + static_cast<int>(slot);
}

bool gpu_rk_prepare_phase_timing_events(
    Context &ctx,
    const ExplicitTableau &tableau,
    std::string &reason)
{
    (void)ctx;
    (void)tableau;
    (void)reason;
    return true;
}

bool gpu_rk_prepare_phase_timing_event_count(
    Context &ctx,
    size_t required_count,
    std::string &reason)
{
    (void)ctx;
    (void)required_count;
    (void)reason;
    return true;
}

void gpu_rk_reset_phase_timing_events(Context &ctx)
{
    (void)ctx;
}

void gpu_rk_destroy_phase_timing_events(Context &ctx)
{
    (void)ctx;
}

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

bool gpu_rk_finalize_step_stats_control_readback(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    return gpu_rk_finalize_step_stats(ctx, stats, reason);
}

} // namespace fullmag::fem

#endif
