/*
 * GPU CUDA RK FSAL policy source contract.
 *
 * This source owns the host-side policy deciding whether an accepted FSAL RHS
 * may be reused for the next GPU RK attempt. Stochastic Brown thermal fields
 * disable reuse. Deterministic time-dependent Oersted remains eligible because
 * the accepted endpoint source state is identical to the next first stage.
 */

#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
