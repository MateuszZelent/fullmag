/*
 * GPU CUDA RK stage schedule source contract.
 *
 * This source owns one device-resident RK stage attempt: common attempt setup
 * delegation, per-integrator stage dispatch, accepted-state normalization,
 * adaptive RK23 k3 dispatch, and final stage RHS accounting. It does not own
 * common attempt setup internals, per-integrator accept/stage internals,
 * step-loop orchestration, adaptive PI policy, accepted-step finalization,
 * final statistics, GPU RK planning, interaction physics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/heun_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp"
#include "gpu/cuda/integrators/rk/rk23_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk4_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk45_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_setup.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

} // namespace

bool gpu_rk_run_stage_attempt(
    Context &ctx,
    cudaStream_t stream,
    int n,
    bool is_heun,
    bool is_rk4,
    bool is_rk23,
    bool is_rk45,
    bool adaptive,
    bool fsal_method,
    double active_dt,
    GpuRkStageAttemptResult &result,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    result = {};
    uint32_t stage_rhs_evaluations = 0;
    bool fsal_reused = false;

    if (!gpu_rk_prepare_stage_attempt(ctx, stream, n, is_heun, is_rk45, fsal_method, active_dt, stage_rhs_evaluations, fsal_reused, reason)) {
        return false;
    }
    result.fsal_reused = fsal_reused;

    if (is_rk45) {
        if (!gpu_rk_run_rk45_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)) {
            return false;
        }
    } else if (is_rk4) {
        if (!gpu_rk_run_rk4_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)) {
            return false;
        }
    } else if (is_rk23) {
        if (!gpu_rk_run_rk23_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)) {
            return false;
        }
    } else {
        gpu_rk_run_heun_stage_sequence(ctx, stream, n, active_dt);
    }
    if (adaptive && !gpu_rk_capture_pre_normalization_candidate(ctx, stream, reason)) {
        return false;
    }
    if (!fullmag_cuda_normalize_vectors(
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            gpu.mesh_regions.magnetic_node_mask,
            gpu.reductions.scalar_result,
            n,
            stream,
            reason)) {
        return false;
    }
    if (!cuda_launch_ok("launch GPU RK accept/normalize", reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }

    // BS23 (RK23) is FSAL and its embedded error estimate includes k[3] = f(m_{n+1})
    // (b_lo[3] = 1/8 != 0). k[3] must be available before compute_adaptive_error_norm_device.
    // For adaptive BS23, compute k[3] here after the accepted + normalized m. On a rejected
    // step the cost is wasted, but there is no way to avoid it without restructuring the loop.
    // The post-loop final-RHS path still runs for FSAL k[0] and h_eff update; the two
    // evaluations are numerically identical (same m, same fields) and the redundancy is benign.
    if (is_rk23 && adaptive) {
        if (!gpu_rk_compute_rk23_adaptive_k3(ctx, stream, n, stage_rhs_evaluations, reason)) {
            return false;
        }
    }

    result.rhs_evaluations = stage_rhs_evaluations;
    return true;
}

} // namespace fullmag::fem
