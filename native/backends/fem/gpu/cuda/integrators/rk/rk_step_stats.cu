/*
 * GPU CUDA RK final step stats source contract.
 *
 * This source owns final scalar reductions, scalar readback, and publication of
 * device-resident RK step statistics. It does not own RK step scheduling, RHS
 * assembly, interaction physics kernels, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

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

double *gpu_rk_final_scalar_result(FemGpuState &gpu, GpuFinalScalarSlot slot)
{
    return gpu.scalar_reduce_result + static_cast<int>(slot);
}

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        gpu.scalar_reduce_result == nullptr ||
        gpu.scalar_reduce_temp_storage == nullptr) {
        return true;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    std::array<double, kGpuFinalScalarSlots> scalars{};

    const int n = static_cast<int>(gpu.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    if (blocks <= 0) {
        return true;
    }

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

    fullmag_cuda_field_metric_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.h_eff.x,
        gpu.h_eff.y,
        gpu.h_eff.z,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        gpu.error.x,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK field metric blocks", reason)) {
        return false;
    }

    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxHEff),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK max H_eff reduction", reason)) {
        return false;
    }

    if (ctx.demag.enabled) {
        // Use gpu.error.y as a scratch target for block_max_torque — we only
        // need block_max_h (scalar_reduce_workspace) from this call. gpu.error.x
        // must not be overwritten here because it holds the per-block H_eff
        // torque values that are reduced into max_torque immediately below.
        fullmag_cuda_field_metric_blocks(
            gpu.m.x,
            gpu.m.y,
            gpu.m.z,
            gpu.h_demag.x,
            gpu.h_demag.y,
            gpu.h_demag.z,
            gpu.magnetic_node_mask,
            gpu.scalar_reduce_workspace,
            gpu.error.y,
            n,
            stream);
        if (!cuda_launch_ok("launch GPU RK demag field metric blocks", reason)) {
            return false;
        }
        reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
        fullmag_cuda_device_max(
            gpu.scalar_reduce_workspace,
            blocks,
            gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxHDemag),
            gpu.scalar_reduce_temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_launch_ok("launch GPU RK max H_demag reduction", reason)) {
            return false;
        }
    }

    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.error.x,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxTorque),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK max torque reduction", reason)) {
        return false;
    }

    fullmag_cuda_magnetization_sum_blocks(
        gpu.m.x,
        gpu.m.y,
        gpu.m.z,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        gpu.error.x,
        gpu.error.y,
        gpu.error.z,
        n,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetization average blocks", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MxSum),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK mx average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.x,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MySum),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK my average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.y,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MzSum),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK mz average reduction", reason)) {
        return false;
    }
    reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.error.z,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MagneticCount),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK magnetic count reduction", reason)) {
        return false;
    }

    if (!gpu_rk_read_scalar_results(
        ctx,
        stream,
        "cudaMemcpyAsync GPU RK final scalar stats device->host",
        scalars.data(),
        scalars.size(),
        reason)) {
        return false;
    }

    auto scalar = [&](GpuFinalScalarSlot slot) {
        return scalars[static_cast<size_t>(slot)];
    };

    const double max_rhs = scalar(GpuFinalScalarSlot::MaxRhs);
    const double exchange_energy = scalar(GpuFinalScalarSlot::ExchangeEnergy);
    const double demag_robin_boundary_energy =
        ctx.demag.enabled &&
                ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
                ctx.poisson_demag.robin_effective_beta > 0.0
            ? scalar(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)
            : 0.0;
    if (ctx.demag.enabled) {
        ctx.demag.cached_robin_boundary_energy = demag_robin_boundary_energy;
    }
    const double demag_energy =
        ctx.demag.enabled
            ? scalar(GpuFinalScalarSlot::DemagEnergy) + ctx.demag.cached_robin_boundary_energy
            : 0.0;
    const double external_energy =
        ctx.zeeman.has_external_field ? scalar(GpuFinalScalarSlot::ExternalEnergy) : 0.0;
    const double anisotropy_energy =
        ctx.anisotropy.uniaxial_enabled ? scalar(GpuFinalScalarSlot::AnisotropyEnergy) : 0.0;
    const double cubic_anisotropy_energy =
        ctx.anisotropy.cubic_enabled ? scalar(GpuFinalScalarSlot::CubicAnisotropyEnergy) : 0.0;
    const double dmi_energy =
        ctx.dmi.interfacial_enabled ? scalar(GpuFinalScalarSlot::DmiEnergy) : 0.0;
    const double bulk_dmi_energy =
        ctx.dmi.bulk_enabled ? scalar(GpuFinalScalarSlot::BulkDmiEnergy) : 0.0;
    const double magnetoelastic_energy =
        ctx.magnetoelastic.enabled ? scalar(GpuFinalScalarSlot::MagnetoelasticEnergy) : 0.0;
    const double max_h_eff = scalar(GpuFinalScalarSlot::MaxHEff);
    const double max_h_demag =
        ctx.demag.enabled ? scalar(GpuFinalScalarSlot::MaxHDemag) : 0.0;
    const double max_torque = scalar(GpuFinalScalarSlot::MaxTorque);
    const double mx_sum = scalar(GpuFinalScalarSlot::MxSum);
    const double my_sum = scalar(GpuFinalScalarSlot::MySum);
    const double mz_sum = scalar(GpuFinalScalarSlot::MzSum);
    const double magnetic_count = scalar(GpuFinalScalarSlot::MagneticCount);

    stats.max_rhs_amplitude = max_rhs;
    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = demag_energy;
    stats.external_energy_joules = external_energy;
    stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy;
    stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy;
    stats.magnetoelastic_energy_joules = magnetoelastic_energy;
    stats.total_energy_joules =
        exchange_energy + demag_energy + external_energy + anisotropy_energy + cubic_anisotropy_energy +
        dmi_energy + bulk_dmi_energy + magnetoelastic_energy;
    stats.max_effective_field_amplitude = max_h_eff;
    stats.max_demag_field_amplitude = max_h_demag;
    stats.max_torque_Apm = max_torque;
    if (magnetic_count > 0.0) {
        stats.mx = mx_sum / magnetic_count;
        stats.my = my_sum / magnetic_count;
        stats.mz = mz_sum / magnetic_count;
    } else {
        stats.mx = 0.0;
        stats.my = 0.0;
        stats.mz = 0.0;
    }
    if (ctx.demag.enabled) {
        fill_demag_solver_stats(ctx, stats);
        if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON &&
            ctx.poisson_demag.solves_current_step > 0) {
            DemagPoissonPhaseTimings demag_timings{};
            demag_timings.solve_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns;
            demag_timings.solver_setup_wall_time_ns = ctx.poisson_demag.last_setup_wall_time_ns;
            demag_timings.solver_apply_wall_time_ns = ctx.poisson_demag.step_solver_apply_wall_time_ns;
            demag_timings.solver_setup_reused = ctx.poisson_demag.last_solver_setup_reused;
            fill_demag_poisson_phase_stats(demag_timings, stats);
        }
    } else {
        stats.demag_solve_count = 0;
        stats.demag_linear_iterations = 0;
        stats.demag_linear_residual = 0.0;
    }
    stats.requested_omp_threads = ctx.cpu_threads.requested_omp_threads;
    stats.effective_omp_threads = ctx.cpu_threads.effective_omp_threads;
    context_update_stage_completion_from_stats(ctx, stats);
    return true;
}

} // namespace fullmag::fem
