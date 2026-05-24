/*
 * GPU CUDA RK DMI final energy reductions source contract.
 *
 * This source owns final interfacial and bulk DMI energy kernel launches and
 * reductions for the device-resident RK stats path. It does not own generic
 * final energy orchestration, scalar readback, stats publication, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"

#include <cuda_runtime.h>

#include <cstddef>
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

bool gpu_rk_reduce_final_dmi_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    auto compute_dmi_energy = [&](bool bulk_mode, GpuFinalScalarSlot slot) -> bool {
        if (!gpu.mesh_geometry.uploaded ||
            gpu.mesh_geometry.element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
            gpu.mesh_geometry.nodes_xyz == nullptr || gpu.mesh_geometry.elements == nullptr ||
            gpu.mesh_geometry.magnetic_element_mask == nullptr ||
            gpu.materials.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr ||
            gpu.zhang_li_rhs.x == nullptr || gpu.zhang_li_rhs.y == nullptr ||
            gpu.zhang_li_rhs.z == nullptr) {
            reason = "GPU RK DMI energy requires device-resident mesh geometry, Ms, lumped mass, and residual buffers";
            return false;
        }
        FemGpuComponentField &field = bulk_mode ? gpu.h_bulk_dmi : gpu.h_dmi;
        fullmag_cuda_dmi_field_energy(
            gpu.mesh_geometry.nodes_xyz,
            gpu.mesh_geometry.elements,
            gpu.mesh_geometry.magnetic_element_mask,
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
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
        if (!cuda_launch_ok(
                bulk_mode ? "launch GPU RK bulk DMI energy blocks" :
                            "launch GPU RK interfacial DMI energy blocks",
                reason)) {
            return false;
        }
        size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            1,
            gpu_rk_final_scalar_result(gpu, slot),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok(
                bulk_mode ? "launch GPU RK bulk DMI energy reduction" :
                            "launch GPU RK interfacial DMI energy reduction",
                reason)) {
            return false;
        }
        return true;
    };
    if (ctx.dmi.interfacial_enabled &&
        !compute_dmi_energy(false, GpuFinalScalarSlot::DmiEnergy)) {
        return false;
    }
    if (ctx.dmi.bulk_enabled &&
        !compute_dmi_energy(true, GpuFinalScalarSlot::BulkDmiEnergy)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
