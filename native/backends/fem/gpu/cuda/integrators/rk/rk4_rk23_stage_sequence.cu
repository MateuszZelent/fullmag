/*
 * GPU CUDA RK4/RK23 stage sequence source contract.
 *
 * This source owns the RK4 midpoint/endpoint predictor sequence, the
 * Bogacki-Shampine RK23 midpoint predictor, RHS evaluations after the common
 * stage-1 RHS, and RK4/BS23 accept kernels for one device-resident RK attempt.
 * It does not own generic attempt backup, FSAL reuse, Heun accept, RK45 stage
 * sequencing, BS23 adaptive k3 handling, step-loop orchestration, adaptive PI
 * policy, accepted-step finalization, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
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

bool gpu_rk_run_rk4_rk23_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    bool is_rk23,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    fullmag_cuda_euler_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        is_rk23 ? 0.75 * active_dt : 0.5 * active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK4 midpoint-2/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.m_stage,
            gpu.k[2],
            stream,
            n,
            "launch GPU RK stage-2 h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;
    if (is_rk23) {
        fullmag_cuda_bs23_accept(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            active_dt,
            n,
            stream);
        return true;
    }

    fullmag_cuda_euler_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK4 endpoint/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.m_stage,
            gpu.k[3],
            stream,
            n,
            "launch GPU RK stage-3 h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;
    fullmag_cuda_rk4_accept(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        active_dt,
        n,
        stream);
    return true;
}

} // namespace fullmag::fem
