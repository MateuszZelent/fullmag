/*
 * GPU CUDA state-runtime source contract.
 *
 * This source owns GPU-state bootstrap, runtime coefficient upload, host-resident
 * fallback metadata, and teardown coordination when bootstrap fails. It does not choose MFEM devices, assemble exchange operators, execute RK stages, or own state I/O.
 */

#include "gpu/cuda/runtime/gpu_state_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/interactions/zeeman/regional_field_kernels.cuh"
#include "gpu/cuda/transfer/snapshot_pool.hpp"

#include <cstdint>
#include <memory>

namespace fullmag::fem {

namespace {

bool gpu_bootstrap_failed(Context &ctx) {
#if FULLMAG_HAS_MFEM_STACK
    context_destroy_mfem(ctx);
#else
    (void)ctx;
#endif
    return false;
}

} // namespace

bool initialize_context_gpu_state(Context &ctx, std::string &error) {
    bool allocate_gpu_state = false;
#if FULLMAG_HAS_CUDA_RUNTIME
    allocate_gpu_state = ctx.mfem_device.device_info_cache.is_gpu_enabled != 0;
#endif
    if (!gpu_state_initialize(
            ctx.gpu_state.device,
            ctx.mesh.n_nodes,
            ctx.base_plan.integrator,
            allocate_gpu_state,
            ctx.demag.enabled,
            ctx.state.m_xyz.data(),
            static_cast<uint64_t>(ctx.state.m_xyz.size()),
            ctx.transfer_audit.audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.gpu_state.device.lifecycle.allocated) {
        ctx.gpu_state.cuda.snapshot_pool = std::make_shared<FemGpuSnapshotPoolState>();
        if (!initialize_gpu_snapshot_pool(
                *ctx.gpu_state.cuda.snapshot_pool,
                ctx.gpu_state.device.lifecycle.node_count,
                error)) {
            return gpu_bootstrap_failed(ctx);
        }
    }
#endif
#if FULLMAG_HAS_MFEM_STACK
    if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON &&
        !ctx.gpu_state.device.lifecycle.allocated) {
        error =
            "strict FEM GPU demag requires an MFEM GPU device before FemGpuState demag buffers can be allocated";
        return gpu_bootstrap_failed(ctx);
    }
#endif
    if (!gpu_state_upload_runtime_coefficients(
            ctx.gpu_state.device,
            ctx.mesh.node_volumes.data(),
            static_cast<uint64_t>(ctx.mesh.node_volumes.size()),
            ctx.material_fields.Ms_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Ms_field.size()),
            ctx.material_fields.material.saturation_magnetisation,
            ctx.material_fields.A_field.data(),
            static_cast<uint64_t>(ctx.material_fields.A_field.size()),
            ctx.material_fields.material.exchange_stiffness,
            ctx.material_fields.alpha_field.data(),
            static_cast<uint64_t>(ctx.material_fields.alpha_field.size()),
            ctx.material_fields.material.damping,
            ctx.material_fields.Ku_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Ku_field.size()),
            ctx.material_fields.Ku2_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Ku2_field.size()),
            ctx.anisotropy.uniaxial_axis_x_field.data(),
            static_cast<uint64_t>(ctx.anisotropy.uniaxial_axis_x_field.size()),
            ctx.anisotropy.uniaxial_axis[0],
            ctx.anisotropy.uniaxial_axis_y_field.data(),
            static_cast<uint64_t>(ctx.anisotropy.uniaxial_axis_y_field.size()),
            ctx.anisotropy.uniaxial_axis[1],
            ctx.anisotropy.uniaxial_axis_z_field.data(),
            static_cast<uint64_t>(ctx.anisotropy.uniaxial_axis_z_field.size()),
            ctx.anisotropy.uniaxial_axis[2],
            ctx.material_fields.Dind_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Dind_field.size()),
            ctx.material_fields.Dbulk_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Dbulk_field.size()),
            ctx.material_fields.Kc1_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Kc1_field.size()),
            ctx.material_fields.Kc2_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Kc2_field.size()),
            ctx.material_fields.Kc3_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Kc3_field.size()),
            ctx.mesh.magnetic_node_mask.data(),
            static_cast<uint64_t>(ctx.mesh.magnetic_node_mask.size()),
            ctx.mesh.periodic_reduced_node.data(),
            static_cast<uint64_t>(ctx.mesh.periodic_reduced_node.size()),
            ctx.mesh.periodic_representative_nodes.data(),
            static_cast<uint64_t>(ctx.mesh.periodic_representative_nodes.size()),
            ctx.transfer_audit.audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
    if (ctx.magnetoelastic.enabled && !ctx.magnetoelastic.uniform_strain) {
        if (!gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state.device,
                ctx.magnetoelastic.strain_voigt.data(),
                static_cast<uint64_t>(ctx.magnetoelastic.strain_voigt.size()),
                ctx.transfer_audit.audit,
                error)) {
            return gpu_bootstrap_failed(ctx);
        }
    }
    if (!gpu_state_upload_mesh_geometry(
            ctx.gpu_state.device,
            ctx.mesh.nodes_xyz.data(),
            static_cast<uint64_t>(ctx.mesh.nodes_xyz.size()),
            ctx.mesh.elements.data(),
            static_cast<uint64_t>(ctx.mesh.elements.size()),
            ctx.mesh.magnetic_element_mask.data(),
            static_cast<uint64_t>(ctx.mesh.magnetic_element_mask.size()),
            ctx.transfer_audit.audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
#if FULLMAG_HAS_MFEM_STACK
    if (!context_upload_mfem_exchange_to_gpu_state(ctx, error)) {
        context_destroy_mfem(ctx);
        return false;
    }
    if (!gpu_demag_poisson_initialize(ctx, error)) {
        context_destroy_mfem(ctx);
        return false;
    }
#endif
    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state.device,
            ctx.exchange.h_xyz.data(),
            ctx.demag.h_xyz.data(),
            ctx.zeeman.h_ext_xyz.data(),
            ctx.effective_field.h_xyz.data(),
            static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
            ctx.transfer_audit.audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state.device,
            ctx.anisotropy.h_uniaxial_xyz.data(),
            ctx.anisotropy.h_cubic_xyz.data(),
            ctx.dmi.h_interfacial_xyz.data(),
            ctx.dmi.h_bulk_xyz.data(),
            ctx.oersted.h_basis_per_ampere_xyz.data(),
            ctx.oersted.h_xyz.data(),
            ctx.thermal_brown.h_xyz.data(),
            ctx.magnetoelastic.h_xyz.data(),
            static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
            ctx.transfer_audit.audit,
            error)) {
        return gpu_bootstrap_failed(ctx);
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (!gpu_regional_field_drive_upload(ctx, error)) {
        return gpu_bootstrap_failed(ctx);
    }
#endif
    return true;
}

void set_gpu_step_profile(Context &ctx, bool enabled)
{
    auto &timings = ctx.gpu_state.rk_phase_timings;
    timings.override_configured = true;
    timings.override_enabled = enabled;
    timings.configured = false;
}

} // namespace fullmag::fem
