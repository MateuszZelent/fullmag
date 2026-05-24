/*
 * GPU CUDA RK direct torque source contract.
 *
 * This source owns direct tau contributions added to the device-resident RK
 * RHS after the LLG effective-field RHS: Slonczewski and Zhang-Li STT. It does
 * not own RHS orchestration, exchange, demag dispatch, local field generation,
 * H_eff accumulation, LLG RHS evaluation, RK step scheduling, final
 * statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/interactions/stt/stt_kernels.hpp"

#include <cuda_runtime.h>

#include <cmath>
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

double gpu_rk_current_density_magnitude(const Context &ctx)
{
    const double jx = ctx.stt.current_density_am2[0];
    const double jy = ctx.stt.current_density_am2[1];
    const double jz = ctx.stt.current_density_am2[2];
    return std::sqrt(jx * jx + jy * jy + jz * jz);
}

} // namespace

bool gpu_rk_add_direct_torques(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (ctx.stt.slonczewski_enabled) {
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
        if (!cuda_launch_ok("launch GPU RK Slonczewski STT RHS", reason)) {
            return false;
        }
    }
    if (ctx.stt.zhang_li_enabled) {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
            gpu.nodes_xyz == nullptr || gpu.elements == nullptr ||
            gpu.magnetic_element_mask == nullptr) {
            reason = "GPU RK Zhang-Li STT requires device-resident mesh geometry";
            return false;
        }
        if (gpu.ms == nullptr || gpu.zhang_li_rhs.x == nullptr ||
            gpu.zhang_li_rhs.y == nullptr || gpu.zhang_li_rhs.z == nullptr ||
            gpu.zhang_li_node_weight == nullptr) {
            reason = "GPU RK Zhang-Li STT requires device-resident Ms and Zhang-Li work buffers";
            return false;
        }
        fullmag_cuda_add_zhang_li_stt_rhs(
            gpu.nodes_xyz,
            gpu.elements,
            gpu.magnetic_element_mask,
            m.x,
            m.y,
            m.z,
            gpu.ms,
            gpu.magnetic_node_mask,
            gpu.zhang_li_rhs.x,
            gpu.zhang_li_rhs.y,
            gpu.zhang_li_rhs.z,
            gpu.zhang_li_node_weight,
            rhs.x,
            rhs.y,
            rhs.z,
            gpu.scalar_reduce_workspace,
            ctx.stt.current_density_am2[0],
            ctx.stt.current_density_am2[1],
            ctx.stt.current_density_am2[2],
            ctx.stt.degree,
            ctx.stt.beta,
            static_cast<int>(ctx.mesh.n_elements),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK Zhang-Li STT RHS", reason)) {
            return false;
        }
    }
    return true;
}

} // namespace fullmag::fem
