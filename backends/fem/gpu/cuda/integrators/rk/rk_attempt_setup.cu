/*
 * GPU CUDA RK attempt setup source contract.
 *
 * This source owns common device-resident setup for one RK attempt: backup,
 * FSAL reuse detection, optional k0 RHS refresh, first predictor,
 * normalization, k1 RHS refresh, and RHS accounting for those common stages.
 * It does not own per-integrator stages, accept kernels, RK23 adaptive k3,
 * step-loop orchestration, adaptive PI policy, accepted-step finalization, or
 * C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_attempt_setup.hpp"

#include "context.hpp"
#include "gpu/cuda/constraints/frozen_spins.cuh"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_control_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cstdint>
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

bool gpu_rk_prepare_stage_attempt(
    Context &ctx,
    cudaStream_t stream,
    int n,
    bool is_heun,
    bool is_rk45,
    bool fsal_method,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    bool &fsal_reused,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    // Periodic projection is applied at the RHS boundary. Until the projected
    // candidate and the final-stage endpoint have a device identity proof, do
    // not carry an FSAL token across periodic steps.
    fsal_reused = fsal_method &&
        !gpu.mesh_regions.has_periodic_reduced_nodes &&
        gpu.rk.fsal_valid;

    if (!gpu_rk_copy_component_device(
            gpu.magnetization.m,
            gpu.rk.m_backup,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU RK backup magnetization device copy",
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    if (gpu.rk.attempt_control.device == nullptr) {
        reason = "GPU RK attempt-control packet is not allocated";
        return false;
    }
    fullmag_cuda_reset_attempt_control_packet(gpu.rk.attempt_control.device, stream);
    if (!cuda_launch_ok("launch GPU RK attempt-control reset", reason)) {
        return false;
    }
    if (!fsal_reused) {
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx,
                gpu.magnetization.m,
                gpu.rk.k[0],
                stream,
                n,
                ctx.state.current_time,
                "launch GPU RK stage-0 h_eff accumulation",
                reason)) {
            gpu.rk.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
    }

    fullmag_cuda_euler_stage(
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        gpu.rk.k[0].x, gpu.rk.k[0].y, gpu.rk.k[0].z,
        gpu.rk.m_stage.x, gpu.rk.m_stage.y, gpu.rk.m_stage.z,
        is_heun ? active_dt : (is_rk45 ? 0.2 * active_dt : 0.5 * active_dt),
        n,
        stream);
    fullmag_cuda_normalize_vectors_deferred(
        gpu.rk.m_stage,
        gpu.rk.m_backup,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.rk.attempt_control.device,
        n,
        stream,
        &ctx.gpu_state.performance_counters);
    if (!cuda_launch_ok("launch GPU RK predictor/normalize", reason)) {
        return false;
    }
    if (ctx.frozen_spins.enabled()) {
        gpu_project_frozen_reference(
            gpu.rk.m_stage,
            gpu.mesh_regions.frozen_mask,
            gpu.mesh_regions.frozen_reference_x,
            gpu.mesh_regions.frozen_reference_y,
            gpu.mesh_regions.frozen_reference_z,
            n,
            stream);
    }

    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.rk.m_stage,
            gpu.rk.k[1],
            stream,
            n,
            ctx.state.current_time + (is_heun ? 1.0 : (is_rk45 ? 0.2 : 0.5)) * active_dt,
            "launch GPU RK stage-1 h_eff accumulation",
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;
    return true;
}

bool gpu_rk_capture_pre_normalization_candidate(
    Context &ctx,
    cudaStream_t stream,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    return gpu_rk_copy_component_device(
        gpu.magnetization.m,
        gpu.rk.m_stage,
        gpu.lifecycle.node_count,
        stream,
        "cudaMemcpyAsync GPU RK pre-normalization high-order candidate copy",
        reason);
}

} // namespace fullmag::fem
