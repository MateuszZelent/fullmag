/*
 * GPU CUDA RK DMI field contributions source contract.
 *
 * This source owns per-stage interfacial and bulk DMI weak-residual field
 * generation used by the device-resident RK RHS. It does not own RHS
 * orchestration, exchange, demag dispatch, H_eff accumulation, LLG RHS
 * evaluation, direct torque terms, RK step scheduling, final statistics, GPU
 * RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"

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

bool gpu_rk_compute_one_dmi_field(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    bool bulk_mode,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu.mesh_geometry.uploaded ||
        gpu.mesh_geometry.element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
        gpu.mesh_geometry.nodes_xyz == nullptr || gpu.mesh_geometry.elements == nullptr ||
        gpu.mesh_geometry.magnetic_element_mask == nullptr ||
        gpu.materials.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr ||
        gpu.zhang_li_rhs.x == nullptr || gpu.zhang_li_rhs.y == nullptr ||
        gpu.zhang_li_rhs.z == nullptr) {
        reason = "GPU RK DMI requires device-resident mesh geometry, Ms, lumped mass, and residual buffers";
        return false;
    }
    FemGpuComponentField &field = bulk_mode ? gpu.h_bulk_dmi : gpu.h_dmi;
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        reason = "GPU RK DMI requires device-resident H_dmi buffers";
        return false;
    }
    fullmag_cuda_dmi_field_energy(
        gpu.mesh_geometry.nodes_xyz,
        gpu.mesh_geometry.elements,
        gpu.mesh_geometry.magnetic_element_mask,
        m.x,
        m.y,
        m.z,
        gpu.materials.ms,
        bulk_mode ? gpu.materials.dbulk : gpu.materials.dind,
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.zhang_li_rhs.x,
        gpu.zhang_li_rhs.y,
        gpu.zhang_li_rhs.z,
        field.x,
        field.y,
        field.z,
        gpu.scalar_reduce_workspace,
        ctx.material_fields.material.saturation_magnetisation,
        bulk_mode ? ctx.dmi.bulk_D : ctx.dmi.interfacial_D,
        ctx.dmi.interface_normal[0],
        ctx.dmi.interface_normal[1],
        ctx.dmi.interface_normal[2],
        bulk_mode ? !ctx.material_fields.Dbulk_field.empty() : !ctx.material_fields.Dind_field.empty(),
        bulk_mode,
        static_cast<int>(ctx.mesh.n_elements),
        n,
        stream);
    return cuda_launch_ok(
        bulk_mode ? "launch GPU RK bulk DMI field" : "launch GPU RK interfacial DMI field",
        reason);
}

} // namespace

bool gpu_rk_compute_dmi_field_contributions(
    Context &ctx,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (ctx.dmi.interfacial_enabled &&
        !gpu_rk_compute_one_dmi_field(ctx, m, stream, n, false, reason)) {
        return false;
    }
    if (ctx.dmi.bulk_enabled &&
        !gpu_rk_compute_one_dmi_field(ctx, m, stream, n, true, reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
