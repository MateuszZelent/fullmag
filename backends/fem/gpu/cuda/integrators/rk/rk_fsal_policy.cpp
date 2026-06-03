/*
 * GPU CUDA RK FSAL policy source contract.
 *
 * This source owns the host-side policy deciding whether an accepted FSAL RHS
 * may be reused for the next GPU RK attempt. Stochastic Brown thermal fields
 * and time-dependent Oersted fields make the RHS non-autonomous and therefore
 * disable FSAL reuse.
 */

#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0) {
        return false;
    }
    if (ctx.oersted.time_dep_kind != 0u) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
