// ── GPU CUDA RK RHS runtime source contract ───────────────────────────
// This source owns device-resident RHS assembly orchestration for GPU RK:
// exchange dispatch delegation, DMI field contribution dispatch, demag dispatch
// delegation, local-field contribution dispatch, H_eff accumulation, LLG RHS
// dispatch delegation, and direct torque dispatch. It does not own exchange
// validation/kernel dispatch, demag mode dispatch, fused LLG RHS launch, DMI
// field generation, local-field generation, direct torque RHS additions, RK
// step orchestration, final stats, stage kernels, adaptive policy, interaction
// kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_demag_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"
#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"
#include "gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp"
#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"

#include <string>

namespace fullmag::fem {

bool gpu_rk_compute_rhs_for_magnetization(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    const char *label,
    std::string &reason)
{
    if (!gpu_rk_compute_legacy_sparse_exchange(ctx.gpu_state.device, m, stream, reason)) {
        return false;
    }
    if (!gpu_rk_compute_dmi_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_compute_demag_for_device_stage(ctx, m, stream, reason)) {
        return false;
    }
    if (!gpu_rk_compute_local_field_contributions(ctx, m, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_accumulate_effective_field(ctx, stream, n, label, reason)) {
        return false;
    }

    if (!gpu_rk_compute_llg_rhs(ctx, m, rhs, stream, n, reason)) {
        return false;
    }
    if (!gpu_rk_add_direct_torques(ctx, m, rhs, stream, n, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
