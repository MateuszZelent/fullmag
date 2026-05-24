/*
 * GPU CUDA RK Slonczewski torque source contract.
 *
 * This source owns Slonczewski STT direct-torque validation and kernel launch
 * for the device-resident RK RHS. It does not own generic direct-torque
 * orchestration, Zhang-Li STT, H_eff accumulation, LLG RHS evaluation, RK step
 * scheduling, final statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/interactions/stt/stt_kernels.hpp"

#include <cuda_runtime.h>

#include <cmath>
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

double gpu_rk_current_density_magnitude(const Context &ctx)
{
    const double jx = ctx.stt.current_density_am2[0];
    const double jy = ctx.stt.current_density_am2[1];
    const double jz = ctx.stt.current_density_am2[2];
    return std::sqrt(jx * jx + jy * jy + jz * jz);
}

} // namespace

bool gpu_rk_add_slonczewski_torque(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (!ctx.stt.slonczewski_enabled) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    const double slonczewski_thickness = gpu_rk_resolve_slonczewski_thickness(ctx);
    if (slonczewski_thickness <= 0.0) {
        reason = "GPU RK Slonczewski STT requires explicit or geometry-derived free-layer thickness";
        return false;
    }
    if (gpu.ms == nullptr) {
        reason = "GPU RK Slonczewski STT requires device-resident Ms";
        return false;
    }
    fullmag_cuda_add_slonczewski_stt_rhs(
        m.x,
        m.y,
        m.z,
        gpu.ms,
        gpu.magnetic_node_mask,
        rhs.x,
        rhs.y,
        rhs.z,
        gpu.scalar_reduce_workspace,
        gpu_rk_current_density_magnitude(ctx),
        ctx.stt.current_sign,
        slonczewski_thickness,
        ctx.stt.degree > 0.0 ? ctx.stt.degree : 1.0,
        ctx.stt.lambda,
        ctx.stt.epsilon_prime,
        ctx.stt.spin_polarization[0],
        ctx.stt.spin_polarization[1],
        ctx.stt.spin_polarization[2],
        n,
        stream);
    return cuda_launch_ok("launch GPU RK Slonczewski STT RHS", reason);
}

} // namespace fullmag::fem
