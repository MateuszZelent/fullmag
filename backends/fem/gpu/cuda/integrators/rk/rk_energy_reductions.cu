/*
 * GPU CUDA RK final energy reductions source contract.
 *
 * This source owns final energy kernel launches and reductions for the
 * device-resident RK stats path. It does not own RK step orchestration, RHS
 * assembly, scalar readback, stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp"
#include <string>

namespace fullmag::fem {

bool gpu_rk_reduce_final_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    if (!gpu_rk_reduce_final_exchange_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_demag_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_external_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_dmi_energy_terms(ctx, stream, n, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_anisotropy_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_magnetoelastic_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
