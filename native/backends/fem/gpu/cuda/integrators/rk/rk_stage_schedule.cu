/*
 * GPU CUDA RK stage schedule source contract.
 *
 * This source owns one device-resident RK stage attempt: backup, FSAL reuse,
 * stage RHS evaluation, predictor/accept kernel sequencing, normalization, and
 * BS23 adaptive k3 evaluation. It does not own step-loop orchestration,
 * adaptive PI policy, accepted-step finalization, final statistics, GPU RK
 * planning, interaction physics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
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
    const bool fsal_reused = fsal_method && gpu.fsal_valid;
    result.fsal_reused = fsal_reused;

    if (!gpu_rk_copy_component_device(
            gpu.m,
            gpu.m_backup,
            gpu.node_count,
            stream,
            "cudaMemcpyAsync GPU RK backup magnetization device copy",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    if (!fsal_reused) {
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx,
                gpu.m,
                gpu.k[0],
                stream,
                n,
                "launch GPU RK stage-0 h_eff accumulation",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
    }

    fullmag_cuda_euler_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        is_heun ? active_dt : (is_rk45 ? 0.2 * active_dt : 0.5 * active_dt),
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK predictor/normalize", reason)) {
        return false;
    }

    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.m_stage,
            gpu.k[1],
            stream,
            n,
            "launch GPU RK stage-1 h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    if (is_rk45) {
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
    } else if (is_rk4 || is_rk23) {
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
        } else {
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
        }
    } else {
        fullmag_cuda_heun_accept(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            active_dt,
            n,
            stream);
    }
    fullmag_cuda_normalize_vectors(gpu.m.x, gpu.m.y, gpu.m.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK accept/normalize", reason)) {
        gpu.fsal_valid = false;
        return false;
    }

    // BS23 (RK23) is FSAL and its embedded error estimate includes k[3] = f(m_{n+1})
    // (b_lo[3] = 1/8 != 0). k[3] must be available before compute_adaptive_error_norm_device.
    // For adaptive BS23, compute k[3] here after the accepted + normalized m. On a rejected
    // step the cost is wasted, but there is no way to avoid it without restructuring the loop.
    // The post-loop final-RHS path still runs for FSAL k[0] and h_eff update; the two
    // evaluations are numerically identical (same m, same fields) and the redundancy is benign.
    if (is_rk23 && adaptive) {
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx,
                gpu.m,
                gpu.k[3],
                stream,
                n,
                "launch GPU RK23 BS23 k3 for adaptive error estimate",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
    }

    result.rhs_evaluations = stage_rhs_evaluations;
    return true;
}

} // namespace fullmag::fem
