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
#include <cstdlib>
#include <cstring>
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

bool resolve_dmi_deterministic_reduction(
    bool &deterministic_reduction,
    std::string &reason)
{
    const char *mode = std::getenv("FULLMAG_FEM_DMI_QUALIFICATION_REDUCTION");
    if (mode == nullptr || mode[0] == '\0' || std::strcmp(mode, "cub") == 0) {
        deterministic_reduction = false;
        return true;
    }
    if (std::strcmp(mode, "pairwise") == 0) {
        deterministic_reduction = true;
        return true;
    }
    reason =
        "FULLMAG_FEM_DMI_QUALIFICATION_REDUCTION must be 'cub' or 'pairwise'";
    return false;
}

} // namespace

bool gpu_rk_reduce_final_dmi_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    bool deterministic_reduction = false;
    if (!resolve_dmi_deterministic_reduction(deterministic_reduction, reason)) {
        return false;
    }

    auto compute_dmi_energy = [&](bool bulk_mode, GpuFinalScalarSlot slot) -> bool {
        if (!gpu.mesh_geometry.uploaded ||
            gpu.mesh_geometry.element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
            gpu.mesh_geometry.nodes_xyz == nullptr || gpu.mesh_geometry.elements == nullptr ||
            gpu.mesh_geometry.magnetic_element_mask == nullptr ||
            gpu.materials.ms == nullptr || gpu.mesh_metrics.lumped_mass == nullptr ||
            gpu.local_interactions.vector.x == nullptr || gpu.local_interactions.vector.y == nullptr ||
            gpu.local_interactions.vector.z == nullptr ||
            gpu.reductions.scalar_workspace == nullptr ||
            gpu.reductions.scalar_result == nullptr ||
            gpu.reductions.dmi_diagnostics == nullptr ||
            (!deterministic_reduction && gpu.reductions.temp_storage == nullptr)) {
            reason = "GPU RK DMI energy requires device-resident mesh geometry, material data, and persistent reduction workspace";
            return false;
        }
        FemGpuComponentField &field = bulk_mode ? gpu.fields.h_bulk_dmi : gpu.fields.h_dmi;
        const int dmi_energy_partial_count = fullmag::fem::dmi_energy_partial_count(n);
        auto *diagnostics = reinterpret_cast<DmiDiagnostics *>(
            gpu.reductions.dmi_diagnostics);
        cudaError_t status = cudaSuccess;
        if (gpu.mesh_geometry.dmi_cache.is_built()) {
            status = fullmag_cuda_dmi_field_energy_cached(
                gpu.mesh_geometry.dmi_cache.device_view(),
                gpu.mesh_geometry.elements,
                gpu.mesh_geometry.magnetic_element_mask,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.materials.ms,
                bulk_mode ? gpu.materials.dbulk : gpu.materials.dind,
                gpu.mesh_metrics.lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.local_interactions.vector.x,
                gpu.local_interactions.vector.y,
                gpu.local_interactions.vector.z,
                field.x,
                field.y,
                field.z,
                gpu.reductions.scalar_workspace,
                diagnostics,
                DmiApplyRequest{false, true},
                ctx.material_fields.material.saturation_magnetisation,
                bulk_mode ? ctx.dmi.bulk_D : ctx.dmi.interfacial_D,
                ctx.dmi.interface_normal[0],
                ctx.dmi.interface_normal[1],
                ctx.dmi.interface_normal[2],
                bulk_mode ? !ctx.material_fields.Dbulk_field.empty() : !ctx.material_fields.Dind_field.empty(),
                bulk_mode,
                static_cast<int>(ctx.mesh.n_elements),
                n,
                stream,
                gpu.mesh_geometry.dmi_cache.accumulation_mode());
            if (status == cudaSuccess) {
                gpu.mesh_geometry.dmi_cache.record_apply();
            }
        } else {
            status = fullmag_cuda_dmi_field_energy(
                gpu.mesh_geometry.nodes_xyz,
                gpu.mesh_geometry.elements,
                gpu.mesh_geometry.magnetic_element_mask,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.materials.ms,
                bulk_mode ? gpu.materials.dbulk : gpu.materials.dind,
                gpu.mesh_metrics.lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.local_interactions.vector.x,
                gpu.local_interactions.vector.y,
                gpu.local_interactions.vector.z,
                field.x,
                field.y,
                field.z,
                gpu.reductions.scalar_workspace,
                diagnostics,
                DmiApplyRequest{false, true},
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
        }
        if (!cuda_ok(status,
                bulk_mode ? "launch GPU RK bulk DMI energy blocks" :
                            "launch GPU RK interfacial DMI energy blocks",
                reason)) {
            return false;
        }
        if (deterministic_reduction) {
            if (!cuda_ok(
                    fullmag_cuda_dmi_pairwise_sum(
                        gpu.reductions.scalar_workspace,
                        gpu.reductions.scalar_workspace + dmi_energy_partial_count,
                        dmi_energy_partial_count,
                        gpu_rk_final_scalar_result(gpu, slot),
                        stream),
                    bulk_mode ? "launch deterministic GPU RK bulk DMI energy reduction" :
                                "launch deterministic GPU RK interfacial DMI energy reduction",
                    reason)) {
                return false;
            }
        } else {
            size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
            fullmag_cuda_device_sum(
                gpu.reductions.scalar_workspace,
                dmi_energy_partial_count,
                gpu_rk_final_scalar_result(gpu, slot),
                gpu.reductions.temp_storage,
                reduce_bytes,
                stream);
        }
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
