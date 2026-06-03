/*
 * GPU CUDA RK step preflight source contract.
 *
 * This source owns device-resident GPU RK step validation, launch-parameter
 * preparation, source-of-truth enforcement, exchange-mode validation, adaptive
 * step flagging, and FSAL policy resolution. It does not own accepted-attempt
 * looping, per-integrator stage schedules, RHS assembly, accepted-step final
 * refresh, final statistics, snapshot recomputation, interaction physics, or
 * C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

} // namespace

bool gpu_rk_prepare_step_preflight(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    GpuRkStepPreflight &result,
    std::string &reason)
{
    result = {};
    const auto plan = gpu_rk_plan_device_resident(ctx, reason);
    if (!plan.enabled) {
        return false;
    }
    result.is_heun =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_HEUN && tableau.stages == 2;
    result.is_rk4 =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK4 && tableau.stages == 4;
    result.is_rk23 =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS && tableau.stages == 4;
    result.is_rk45 =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54 && tableau.stages == 7;
    if (!result.is_heun && !result.is_rk4 && !result.is_rk23 && !result.is_rk45) {
        reason = "GPU RK execution surface currently implements fixed-step Heun, RK4, RK23, and RK45 only";
        return false;
    }
    if (dt_seconds <= 0.0) {
        reason = "GPU RK device-resident step requires a positive dt";
        return false;
    }

    auto &gpu = ctx.gpu_state.device;
    result.n = static_cast<int>(gpu.lifecycle.node_count);
    result.blocks = (result.n + kBlockSize - 1) / kBlockSize;
    result.stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);

    if (gpu.residency.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH &&
        gpu.residency.device_state == FemGpuSyncState::DeviceClean &&
        gpu.residency.host_state == FemGpuSyncState::HostClean) {
        gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    }
    if (gpu.residency.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH) {
        reason = "GPU RK device-resident step requires FemGpuState device source of truth";
        return false;
    }
    if (plan.exchange_operator_mode == nullptr ||
        std::string(plan.exchange_operator_mode) != "legacy_sparse_gpu") {
        reason = "GPU RK device-resident step requires legacy_sparse_gpu exchange operator mode";
        return false;
    }

    result.adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled;
    result.fsal_method = (result.is_rk23 || result.is_rk45) && gpu_rk_rhs_allows_fsal_reuse(ctx);
    return true;
}

} // namespace fullmag::fem
