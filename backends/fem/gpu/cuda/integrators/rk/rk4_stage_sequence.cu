/*
 * GPU CUDA RK4 stage sequence source contract.
 *
 * This source owns the RK4 midpoint/endpoint predictor sequence, RHS
 * evaluations after the common stage-1 RHS, and RK4 accept call for one
 * device-resident RK attempt. It does not own generic attempt backup, FSAL
 * reuse, RK23/BS23 sequencing, Heun accept, RK45 stage sequencing, step-loop
 * orchestration, adaptive PI policy, accepted-step finalization, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk4_stage_sequence.hpp"

#include "context.hpp"
#include "gpu/cuda/constraints/frozen_spins.cuh"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_control_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_rk4_accept_kernel.hpp"
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

bool gpu_rk_run_rk4_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    fullmag_cuda_euler_stage(
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        gpu.rk.k[1].x, gpu.rk.k[1].y, gpu.rk.k[1].z,
        gpu.rk.m_stage.x, gpu.rk.m_stage.y, gpu.rk.m_stage.z,
        0.5 * active_dt,
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
    if (!cuda_launch_ok("launch GPU RK4 midpoint-2/normalize", reason)) {
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
            gpu.rk.k[2],
            stream,
            n,
            ctx.state.current_time + 0.5 * active_dt,
            "launch GPU RK stage-2 h_eff accumulation",
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    fullmag_cuda_euler_stage(
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        gpu.rk.k[2].x, gpu.rk.k[2].y, gpu.rk.k[2].z,
        gpu.rk.m_stage.x, gpu.rk.m_stage.y, gpu.rk.m_stage.z,
        active_dt,
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
    if (!cuda_launch_ok("launch GPU RK4 endpoint/normalize", reason)) {
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
            gpu.rk.k[3],
            stream,
            n,
            ctx.state.current_time + active_dt,
            "launch GPU RK stage-3 h_eff accumulation",
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;
    fullmag_cuda_rk4_accept(
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        gpu.rk.k[0].x, gpu.rk.k[0].y, gpu.rk.k[0].z,
        gpu.rk.k[1].x, gpu.rk.k[1].y, gpu.rk.k[1].z,
        gpu.rk.k[2].x, gpu.rk.k[2].y, gpu.rk.k[2].z,
        gpu.rk.k[3].x, gpu.rk.k[3].y, gpu.rk.k[3].z,
        active_dt,
        n,
        stream);
    return true;
}

} // namespace fullmag::fem
