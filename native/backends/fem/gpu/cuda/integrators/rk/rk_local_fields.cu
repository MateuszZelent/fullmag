/*
 * GPU CUDA RK local field contributions source contract.
 *
 * This source owns per-stage local effective-field contribution orchestration
 * used by the device-resident RK RHS. It delegates uniaxial/cubic anisotropy,
 * prescribed-strain magnetoelasticity, and deterministic Brown thermal field
 * generation. It does not own exchange, demag dispatch, H_eff accumulation,
 * LLG RHS evaluation, direct torque terms, RK step scheduling, final
 * statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"

#include "gpu/cuda/integrators/rk/rk_anisotropy_field.hpp"
#include "gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp"
#include "gpu/cuda/integrators/rk/rk_thermal_field.hpp"

#include <string>

namespace fullmag::fem {

bool gpu_rk_compute_local_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (!gpu_rk_compute_anisotropy_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_compute_magnetoelastic_field_contribution(ctx, m, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_compute_thermal_field_contribution(ctx, stream, n, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
