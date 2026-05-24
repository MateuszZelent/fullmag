/*
 * GPU CUDA RK45 stage sequence source contract.
 *
 * This source owns the Dormand-Prince RK45 stage kernels, RHS evaluations, and
 * DP54 accept sequence for one device-resident RK attempt. It does not own
 * generic attempt backup, FSAL reuse, BS23 adaptive k3 handling, step-loop
 * orchestration, adaptive PI policy, accepted-step finalization, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk45_stage_sequence.hpp"

#include "context.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_dp54_accept_kernel.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp"
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

bool gpu_rk_run_rk45_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double active_dt,
    uint32_t &stage_rhs_evaluations,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    fullmag_cuda_rk45_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        3.0 / 40.0, 9.0 / 40.0, 0.0, 0.0, 0.0, 0.0,
        active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK45 stage-2/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx, gpu.m_stage, gpu.k[2], stream, n,
            "launch GPU RK45 stage-2 h_eff accumulation", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    fullmag_cuda_rk45_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        44.0 / 45.0, -56.0 / 15.0, 32.0 / 9.0, 0.0, 0.0, 0.0,
        active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK45 stage-3/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx, gpu.m_stage, gpu.k[3], stream, n,
            "launch GPU RK45 stage-3 h_eff accumulation", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    fullmag_cuda_rk45_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        19372.0 / 6561.0, -25360.0 / 2187.0, 64448.0 / 6561.0,
        -212.0 / 729.0, 0.0, 0.0,
        active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK45 stage-4/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx, gpu.m_stage, gpu.k[4], stream, n,
            "launch GPU RK45 stage-4 h_eff accumulation", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    fullmag_cuda_rk45_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        9017.0 / 3168.0, -355.0 / 33.0, 46732.0 / 5247.0,
        49.0 / 176.0, -5103.0 / 18656.0, 0.0,
        active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK45 stage-5/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx, gpu.m_stage, gpu.k[5], stream, n,
            "launch GPU RK45 stage-5 h_eff accumulation", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    fullmag_cuda_rk45_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        35.0 / 384.0, 0.0, 500.0 / 1113.0,
        125.0 / 192.0, -2187.0 / 6784.0, 11.0 / 84.0,
        active_dt,
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK45 stage-6/normalize", reason)) {
        return false;
    }
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx, gpu.m_stage, gpu.k[6], stream, n,
            "launch GPU RK45 stage-6 h_eff accumulation", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    fullmag_cuda_dp54_accept(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
        gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
        gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
        gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
        active_dt,
        n,
        stream);
    return true;
}

} // namespace fullmag::fem
