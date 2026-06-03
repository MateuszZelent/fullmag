/*
 * GPU CUDA RK Zhang-Li torque source contract.
 *
 * This source owns Zhang-Li STT direct-torque validation and kernel launch for
 * the device-resident RK RHS. It does not own generic direct-torque
 * orchestration, Slonczewski STT, H_eff accumulation, LLG RHS evaluation, RK
 * step scheduling, final statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/stt/stt_kernels.hpp"

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

bool gpu_rk_add_zhang_li_torque(
    Context &ctx,
    const FemGpuComponentField &m,
    FemGpuComponentField &rhs,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (!ctx.stt.zhang_li_enabled) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    if (!gpu.mesh_geometry.uploaded ||
        gpu.mesh_geometry.element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
        gpu.mesh_geometry.nodes_xyz == nullptr || gpu.mesh_geometry.elements == nullptr ||
        gpu.mesh_geometry.magnetic_element_mask == nullptr) {
        reason = "GPU RK Zhang-Li STT requires device-resident mesh geometry";
        return false;
    }
    if (gpu.materials.ms == nullptr || gpu.materials.alpha == nullptr ||
        gpu.local_interactions.vector.x == nullptr ||
        gpu.local_interactions.vector.y == nullptr || gpu.local_interactions.vector.z == nullptr ||
        gpu.local_interactions.node_weight == nullptr) {
        reason = "GPU RK Zhang-Li STT requires device-resident Ms, alpha, and Zhang-Li work buffers";
        return false;
    }
    fullmag_cuda_add_zhang_li_stt_rhs(
        gpu.mesh_geometry.nodes_xyz,
        gpu.mesh_geometry.elements,
        gpu.mesh_geometry.magnetic_element_mask,
        m.x,
        m.y,
        m.z,
        gpu.materials.ms,
        gpu.materials.alpha,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.local_interactions.vector.x,
        gpu.local_interactions.vector.y,
        gpu.local_interactions.vector.z,
        gpu.local_interactions.node_weight,
        rhs.x,
        rhs.y,
        rhs.z,
        gpu.reductions.scalar_workspace,
        ctx.stt.current_density_am2[0],
        ctx.stt.current_density_am2[1],
        ctx.stt.current_density_am2[2],
        ctx.stt.degree,
        ctx.stt.beta,
        ctx.material_fields.material.damping,
        static_cast<int>(ctx.mesh.n_elements),
        n,
        stream);
    return cuda_launch_ok("launch GPU RK Zhang-Li STT RHS", reason);
}

} // namespace fullmag::fem
