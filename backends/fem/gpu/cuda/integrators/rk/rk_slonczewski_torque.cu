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
    if (gpu.materials.ms == nullptr || gpu.materials.alpha == nullptr) {
        reason = "GPU RK Slonczewski STT requires device-resident Ms and alpha";
        return false;
    }
    fullmag_cuda_add_slonczewski_stt_rhs(
        m.x,
        m.y,
        m.z,
        gpu.materials.ms,
        gpu.materials.alpha,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.mesh_regions.stt_active_node_mask,
        rhs.x,
        rhs.y,
        rhs.z,
        gpu.reductions.scalar_workspace,
        ctx.stt.current_density_am2[0],
        ctx.stt.current_density_am2[1],
        ctx.stt.current_density_am2[2],
        ctx.stt.current_sign,
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.material.damping,
        slonczewski_thickness,
        ctx.stt.degree > 0.0 ? ctx.stt.degree : 1.0,
        ctx.stt.lambda,
        ctx.stt.epsilon_prime,
        ctx.stt.spin_polarization[0],
        ctx.stt.spin_polarization[1],
        ctx.stt.spin_polarization[2],
        ctx.stt.stack_normal[0],
        ctx.stt.stack_normal[1],
        ctx.stt.stack_normal[2],
        ctx.stt.formula_version,
        n,
        stream);
    return cuda_launch_ok("launch GPU RK Slonczewski STT RHS", reason);
}

} // namespace fullmag::fem
