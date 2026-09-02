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
#include "gpu/cuda/constraints/frozen_spins.cuh"
#include "gpu/cuda/integrators/rk/heun_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp"
#include "gpu/cuda/integrators/rk/rk23_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk4_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk45_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_setup.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_control_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
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
    gpu.rk.endpoint_valid = false;
    gpu.rk.endpoint_consumed = false;

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
    if (gpu.mesh_regions.has_periodic_reduced_nodes) {
        if (gpu.mesh_regions.periodic_representative_nodes == nullptr) {
            reason = "GPU periodic RK candidate requires a representative-node projection map";
            return false;
        }
        // Match the CPU RK contract: project the accepted high-order
        // candidate before error estimation and final normalization. The
        // per-stage projection is performed by the RHS owner above.
        fullmag_cuda_relax_project_static_periodic_field(
            gpu.magnetization.m.x,
            gpu.magnetization.m.y,
            gpu.magnetization.m.z,
            gpu.mesh_regions.periodic_representative_nodes,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU periodic RK candidate projection", reason)) {
            return false;
        }
    }
    if (is_rk45) {
        // DP54 stage-6 is evaluated at the exact normalized high-order
        // endpoint. Preserve it before adaptive error bookkeeping overwrites
        // m_stage with the raw candidate used by the embedded estimator.
        if (!gpu_rk_copy_component_device(
                gpu.rk.m_stage,
                gpu.rk.error,
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU DP54 exact endpoint cache",
                reason)) {
            return false;
        }
        if (ctx.frozen_spins.enabled()) {
            gpu_project_frozen_reference(
                gpu.rk.error,
                gpu.mesh_regions.frozen_mask,
                gpu.mesh_regions.frozen_reference_x,
                gpu.mesh_regions.frozen_reference_y,
                gpu.mesh_regions.frozen_reference_z,
                n,
                stream);
        }
        if (fsal_method && !gpu.mesh_regions.has_periodic_reduced_nodes) {
            gpu.rk.endpoint_valid = true;
            gpu.rk.endpoint_integrator = FULLMAG_FEM_INTEGRATOR_RK45_DP54;
            gpu.rk.endpoint_generation += 1;
            gpu.rk.endpoint_time_seconds = ctx.state.current_time + active_dt;
            gpu.rk.endpoint_operator_signature = gpu_rk_fsal_operator_signature(ctx);
            gpu.rk.endpoint_consumed = false;
        }
    }
    if (adaptive && !gpu_rk_capture_pre_normalization_candidate(ctx, stream, reason)) {
        return false;
    }
    fullmag_cuda_normalize_vectors_deferred(
        gpu.magnetization.m,
        gpu.rk.m_backup,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.rk.attempt_control.device,
        n,
        stream,
        &ctx.gpu_state.performance_counters);
    if (!cuda_launch_ok("launch GPU RK accept/normalize", reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    if (ctx.frozen_spins.enabled()) {
        gpu_project_frozen_reference(
            gpu.magnetization.m,
            gpu.mesh_regions.frozen_mask,
            gpu.mesh_regions.frozen_reference_x,
            gpu.mesh_regions.frozen_reference_y,
            gpu.mesh_regions.frozen_reference_z,
            n,
            stream);
    }
    if (rk_step_inject_failure(
            ctx,
            RkStepFailurePoint::AfterCandidateMagnetization,
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }

    // BS23 (RK23) is FSAL and its embedded error estimate includes k[3] = f(m_{n+1})
    // (b_lo[3] = 1/8 != 0). k[3] must be available before compute_adaptive_error_norm_device.
    // For adaptive BS23, compute k[3] here after the accepted + normalized m. On a rejected
    // step the cost is wasted, but there is no way to avoid it without restructuring the loop.
    // Accepted-step finalization consumes the cached k[3] endpoint for FSAL and
    // therefore does not launch a second endpoint RHS evaluation. The cache is
    // only published after the accepted, normalized endpoint is available.
    if (is_rk23 && adaptive) {
        if (!gpu_rk_compute_rk23_adaptive_k3(ctx, stream, n, stage_rhs_evaluations, reason)) {
            return false;
        }
        if (fsal_method && !gpu.mesh_regions.has_periodic_reduced_nodes) {
            gpu.rk.endpoint_valid = true;
            gpu.rk.endpoint_integrator = FULLMAG_FEM_INTEGRATOR_RK23_BS;
            gpu.rk.endpoint_generation += 1;
            gpu.rk.endpoint_time_seconds = ctx.state.current_time + active_dt;
            gpu.rk.endpoint_operator_signature = gpu_rk_fsal_operator_signature(ctx);
            gpu.rk.endpoint_consumed = false;
        }
    }

    if (!adaptive) {
        GpuRkAttemptControlPacket packet{};
        if (!gpu_rk_read_attempt_control_packet(ctx, stream, packet, reason)) {
            return false;
        }
    }

    result.rhs_evaluations = stage_rhs_evaluations;
    return true;
}

} // namespace fullmag::fem
