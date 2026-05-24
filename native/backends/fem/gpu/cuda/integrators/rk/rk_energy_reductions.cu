/*
 * GPU CUDA RK final energy reductions source contract.
 *
 * This source owns final energy kernel launches and reductions for the
 * device-resident RK stats path. It does not own RK step orchestration, RHS
 * assembly, scalar readback, stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"

#include "context.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/kernels/kernels.hpp"

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

bool gpu_rk_reduce_final_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);

    fullmag_cuda_legacy_sparse_exchange_energy_blocks(
        gpu.exchange_csr_row_offsets,
        gpu.exchange_csr_col_indices,
        gpu.exchange_csr_values,
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK exchange energy blocks", reason)) {
        return false;
    }
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::ExchangeEnergy),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK exchange energy reduction", reason)) {
        return false;
    }

    if (ctx.demag.enabled) {
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_demag.x == nullptr || gpu.h_demag.y == nullptr || gpu.h_demag.z == nullptr) {
            reason = "GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag";
            return false;
        }
        fullmag_cuda_demag_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.h_demag.x,
            gpu.h_demag.y,
            gpu.h_demag.z,
            gpu.ms,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.scalar_reduce_workspace,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK demag energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::DemagEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK demag energy reduction", reason)) {
            return false;
        }

        if (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
            ctx.poisson_demag.robin_effective_beta > 0.0) {
            if (!reduce_device_demag_robin_boundary_energy(
                    ctx,
                    gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::DemagRobinBoundaryEnergy),
                    stream,
                    reason)) {
                return false;
            }
        }
    }

    if (ctx.zeeman.has_external_field) {
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_ext.x == nullptr || gpu.h_ext.y == nullptr || gpu.h_ext.z == nullptr) {
            reason = "GPU RK external energy requires device-resident Ms, lumped mass, and H_ext";
            return false;
        }
        fullmag_cuda_external_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.h_ext.x,
            gpu.h_ext.y,
            gpu.h_ext.z,
            gpu.ms,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.scalar_reduce_workspace,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK external energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::ExternalEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK external energy reduction", reason)) {
            return false;
        }
    }

    auto compute_dmi_energy = [&](bool bulk_mode, GpuFinalScalarSlot slot) -> bool {
        if (!gpu.mesh_geometry_uploaded ||
            gpu.mesh_element_count != static_cast<uint64_t>(ctx.mesh.n_elements) ||
            gpu.nodes_xyz == nullptr || gpu.elements == nullptr ||
            gpu.magnetic_element_mask == nullptr ||
            gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.zhang_li_rhs.x == nullptr || gpu.zhang_li_rhs.y == nullptr ||
            gpu.zhang_li_rhs.z == nullptr) {
            reason = "GPU RK DMI energy requires device-resident mesh geometry, Ms, lumped mass, and residual buffers";
            return false;
        }
        FemGpuComponentField &field = bulk_mode ? gpu.h_bulk_dmi : gpu.h_dmi;
        fullmag_cuda_dmi_field_energy(
            gpu.nodes_xyz,
            gpu.elements,
            gpu.magnetic_element_mask,
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            bulk_mode ? gpu.dbulk : gpu.dind,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
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
        if (!cuda_launch_ok(bulk_mode ? "launch GPU RK bulk DMI energy blocks" : "launch GPU RK interfacial DMI energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            1,
            gpu_rk_final_scalar_result(gpu, slot),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok(bulk_mode ? "launch GPU RK bulk DMI energy reduction" : "launch GPU RK interfacial DMI energy reduction", reason)) {
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

    if (ctx.anisotropy.uniaxial_enabled) {
        if (gpu.ms == nullptr || gpu.ku == nullptr || gpu.ku2 == nullptr ||
            gpu.exchange_lumped_mass == nullptr ||
            gpu.h_ani.x == nullptr || gpu.h_ani.y == nullptr || gpu.h_ani.z == nullptr) {
            reason = "GPU RK uniaxial anisotropy energy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers";
            return false;
        }
        fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.ku,
            gpu.ku2,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_ani.x,
            gpu.h_ani.y,
            gpu.h_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy.uniaxial_Ku,
            ctx.anisotropy.uniaxial_Ku2,
            ctx.anisotropy.uniaxial_axis[0],
            ctx.anisotropy.uniaxial_axis[1],
            ctx.anisotropy.uniaxial_axis[2],
            !ctx.material_fields.Ku_field.empty(),
            !ctx.material_fields.Ku2_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::AnisotropyEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK uniaxial anisotropy energy reduction", reason)) {
            return false;
        }
    }

    if (ctx.anisotropy.cubic_enabled) {
        if (gpu.ms == nullptr || gpu.kc1 == nullptr || gpu.kc2 == nullptr ||
            gpu.kc3 == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_cubic_ani.x == nullptr || gpu.h_cubic_ani.y == nullptr ||
            gpu.h_cubic_ani.z == nullptr) {
            reason = "GPU RK cubic anisotropy energy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers";
            return false;
        }
        fullmag_cuda_cubic_anisotropy_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.kc1,
            gpu.kc2,
            gpu.kc3,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            gpu.h_cubic_ani.x,
            gpu.h_cubic_ani.y,
            gpu.h_cubic_ani.z,
            gpu.scalar_reduce_workspace,
            ctx.anisotropy.cubic_Kc1,
            ctx.anisotropy.cubic_Kc2,
            ctx.anisotropy.cubic_Kc3,
            ctx.anisotropy.cubic_axis1[0],
            ctx.anisotropy.cubic_axis1[1],
            ctx.anisotropy.cubic_axis1[2],
            ctx.anisotropy.cubic_axis2[0],
            ctx.anisotropy.cubic_axis2[1],
            ctx.anisotropy.cubic_axis2[2],
            !ctx.material_fields.Kc1_field.empty(),
            !ctx.material_fields.Kc2_field.empty(),
            !ctx.material_fields.Kc3_field.empty(),
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::CubicAnisotropyEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK cubic anisotropy energy reduction", reason)) {
            return false;
        }
    }

    if (ctx.magnetoelastic.enabled) {
        const uint64_t per_node_strain_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 6ull;
        const bool use_per_node_strain = !ctx.magnetoelastic.uniform_strain;
        if (!use_per_node_strain && ctx.magnetoelastic.strain_voigt.size() < 6u) {
            reason = "GPU RK magnetoelastic energy requires prescribed strain data";
            return false;
        }
        if (use_per_node_strain &&
            static_cast<uint64_t>(ctx.magnetoelastic.strain_voigt.size()) != per_node_strain_len) {
            reason = "GPU RK magnetoelastic energy requires 6 prescribed strain Voigt values per node";
            return false;
        }
        if (use_per_node_strain &&
            (gpu.mel_strain_voigt == nullptr || !gpu.mel_strain_uploaded ||
                gpu.mel_strain_voigt_len != per_node_strain_len)) {
            reason = "GPU RK magnetoelastic energy requires device-resident per-node strain";
            return false;
        }
        if (gpu.ms == nullptr || gpu.exchange_lumped_mass == nullptr ||
            gpu.h_mel.x == nullptr || gpu.h_mel.y == nullptr || gpu.h_mel.z == nullptr) {
            reason = "GPU RK magnetoelastic energy requires device-resident Ms, lumped mass, and H_mel buffers";
            return false;
        }
        const double *eps = ctx.magnetoelastic.strain_voigt.data();
        fullmag_cuda_magnetoelastic_field_energy_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.ms,
            gpu.exchange_lumped_mass,
            gpu.magnetic_node_mask,
            use_per_node_strain ? gpu.mel_strain_voigt : nullptr,
            gpu.h_mel.x,
            gpu.h_mel.y,
            gpu.h_mel.z,
            gpu.scalar_reduce_workspace,
            ctx.magnetoelastic.b1,
            ctx.magnetoelastic.b2,
            eps[0],
            eps[1],
            eps[2],
            eps[3] * 0.5,
            eps[4] * 0.5,
            eps[5] * 0.5,
            use_per_node_strain,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic energy blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MagnetoelasticEnergy),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK magnetoelastic energy reduction", reason)) {
            return false;
        }
    }

    return true;
}

} // namespace fullmag::fem
