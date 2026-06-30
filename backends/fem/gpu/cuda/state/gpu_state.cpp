/*
 * GPU CUDA state source contract.
 *
 * This source owns FemGpuState lifecycle policy, host-device buffer transfers,
 * runtime coefficient uploads, mesh/material/stage storage, and CUDA/no-CUDA
 * fallback behavior for the native FEM GPU scaffold. It does not own low-level
 * device-memory helpers, MFEM device selection, Context construction, exchange
 * operator assembly, integrator execution, or C ABI entrypoints.
 */

#include "gpu/cuda/state/gpu_state.hpp"

#include "context.hpp"
#include "gpu/cuda/exchange/exchange_upload.hpp"
#include "gpu/cuda/fields/field_buffer_memory.hpp"
#include "gpu/cuda/fields/field_buffer_upload.hpp"
#include "gpu/cuda/integrators/rk/rk_workspace_memory.hpp"
#include "gpu/cuda/interactions/local_interaction_workspace_memory.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_memory.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.hpp"
#include "gpu/cuda/mesh/mesh_geometry_upload.hpp"
#include "gpu/cuda/reductions/reduction_workspace_memory.hpp"
#include "gpu/cuda/relaxation/relaxation_memory.hpp"
#include "gpu/cuda/state/device_memory.hpp"
#include "gpu/cuda/state/magnetization_memory.hpp"
#include "gpu/cuda/state/magnetization_transfer.hpp"
#include "gpu/cuda/state/runtime_coefficients_memory.hpp"
#include "gpu/cuda/state/runtime_coefficients_upload.hpp"
#include "gpu/cuda/transfer/component_transfer.hpp"

#include <cstddef>
#include <limits>
#include <vector>

namespace fullmag::fem {

namespace {

void reset_metadata(FemGpuState &state)
{
    state.lifecycle.initialized = false;
    state.lifecycle.allocated = false;
    state.lifecycle.node_count = 0;
    state.lifecycle.dof_len = 0;
    state.lifecycle.stage_count = 0;
    state.lifecycle.device_bytes = 0;
    state.lifecycle.reduction_workspace_bytes = 0;
    state.reductions.temp_storage_bytes = 0;
    state.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.residency.host_state = FemGpuSyncState::HostClean;
    state.residency.device_state = FemGpuSyncState::HostStale;
    state.runtime_coefficients.uploaded = false;
    state.rk.fsal_valid = false;
    state.legacy_exchange.uploaded = false;
    state.legacy_exchange.rows = 0;
    state.legacy_exchange.cols = 0;
    state.legacy_exchange.nnz = 0;
    state.legacy_exchange.device_bytes = 0;
    state.materials.node_count = 0;
    state.mesh_metrics.uploaded = false;
    state.mesh_metrics.node_count = 0;
    state.mesh_metrics.device_bytes = 0;
    state.mesh_regions.node_count = 0;
    state.mesh_regions.has_periodic_reduced_nodes = false;
    state.magnetoelastic.strain_voigt_len = 0;
    state.magnetoelastic.strain_uploaded = false;
    state.mesh_geometry.element_count = 0;
    state.mesh_geometry.uploaded = false;
    state.relaxation.node_count = 0;
    state.relaxation.nonlinear_cg_direction_valid = false;
    state.demag_poisson.hybrid_stage_m_xyz.clear();
    state.demag_poisson.hybrid_demag_xyz.clear();
    state.demag_poisson.hybrid_demag_energy_joules = 0.0;
}

} // namespace

uint32_t gpu_state_stage_count(fullmag_fem_integrator integrator)
{
    switch (integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:
            return 2;
        case FULLMAG_FEM_INTEGRATOR_RK4:
            return 4;
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:
            return 4;
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54:
            return 7;
        default:
            return 2;
    }
}

bool gpu_state_upload_magnetization_aos(
    FemGpuState &state,
    const double *m_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.lifecycle.allocated) {
        return true;
    }
    if (m_xyz == nullptr) {
        error = "FemGpuState magnetization upload received a null pointer";
        return false;
    }
    if (len != state.lifecycle.dof_len) {
        error = "FemGpuState magnetization upload length mismatch";
        return false;
    }

    if (!gpu_magnetization_upload_aos(
            state.lifecycle,
            state.magnetization,
            m_xyz,
            len,
            audit,
            error)) {
        return false;
    }
    state.residency.device_state = FemGpuSyncState::DeviceClean;
    state.residency.host_state = FemGpuSyncState::HostClean;
    state.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.rk.fsal_valid = false;
    state.relaxation.nonlinear_cg_direction_valid = false;
    return true;
}

bool gpu_state_download_magnetization_aos(
    FemGpuState &state,
    std::vector<double> &out_m_xyz,
    TransferAudit &audit,
    std::string &error)
{
    if (!state.lifecycle.allocated) {
        return true;
    }
    if (state.magnetization.m.x == nullptr || state.magnetization.m.y == nullptr || state.magnetization.m.z == nullptr) {
        error = "FemGpuState magnetization readback requires allocated device buffers";
        return false;
    }

    if (!gpu_magnetization_download_aos(
            state.lifecycle,
            state.magnetization,
            out_m_xyz,
            audit,
            error)) {
        return false;
    }

    state.residency.host_state = FemGpuSyncState::HostClean;
    return true;
}

bool gpu_state_download_component_aos(
    FemGpuState &state,
    const FemGpuComponentField &field,
    std::vector<double> &out_xyz,
    TransferAudit &audit,
    const char *label,
    std::string &error)
{
    return gpu_component_download_aos(state.lifecycle, field, out_xyz, audit, label, error);
}

bool gpu_state_upload_effective_fields_aos(
    FemGpuState &state,
    const double *h_ex_xyz,
    const double *h_demag_xyz,
    const double *h_ext_xyz,
    const double *h_eff_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!gpu_field_buffers_upload_effective_fields_aos(
            state.lifecycle,
            state.fields,
            h_ex_xyz,
            h_demag_xyz,
            h_ext_xyz,
            h_eff_xyz,
            len,
            audit,
            error)) {
        return false;
    }
    state.residency.device_state = FemGpuSyncState::DeviceClean;
    return true;
}

bool gpu_state_upload_demag_field_aos(
    FemGpuState &state,
    const double *h_demag_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_field_buffers_upload_demag_field_aos(
        state.lifecycle,
        state.fields,
        h_demag_xyz,
        len,
        audit,
        error);
}

bool gpu_state_upload_local_vector_fields_aos(
    FemGpuState &state,
    const double *h_ani_xyz,
    const double *h_cubic_ani_xyz,
    const double *h_dmi_xyz,
    const double *h_bulk_dmi_xyz,
    const double *h_oe_xyz,
    const double *h_therm_xyz,
    const double *h_mel_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!gpu_field_buffers_upload_local_vector_fields_aos(
            state.lifecycle,
            state.fields,
            h_ani_xyz,
            h_cubic_ani_xyz,
            h_dmi_xyz,
            h_bulk_dmi_xyz,
            h_oe_xyz,
            h_therm_xyz,
            h_mel_xyz,
            len,
            audit,
            error)) {
        return false;
    }
    state.residency.device_state = FemGpuSyncState::DeviceClean;
    return true;
}

bool gpu_state_upload_magnetoelastic_strain(
    FemGpuState &state,
    const double *strain_voigt,
    uint64_t strain_len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_magnetoelastic_upload_strain(
        state.lifecycle,
        state.magnetoelastic,
        strain_voigt,
        strain_len,
        audit,
        error);
}

bool gpu_state_upload_mesh_geometry(
    FemGpuState &state,
    const double *nodes_xyz,
    uint64_t nodes_xyz_len,
    const uint32_t *elements,
    uint64_t elements_len,
    const uint8_t *magnetic_element_mask,
    uint64_t magnetic_element_mask_len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_mesh_geometry_upload(
        state.lifecycle,
        state.mesh_geometry,
        nodes_xyz,
        nodes_xyz_len,
        elements,
        elements_len,
        magnetic_element_mask,
        magnetic_element_mask_len,
        audit,
        error);
}

bool gpu_state_upload_runtime_coefficients(
    FemGpuState &state,
    const double *node_volumes,
    uint64_t node_volumes_len,
    const double *ms_field,
    uint64_t ms_field_len,
    double uniform_ms,
    const double *a_field,
    uint64_t a_field_len,
    double uniform_a,
    const double *alpha_field,
    uint64_t alpha_field_len,
    double uniform_alpha,
    const double *ku_field,
    uint64_t ku_field_len,
    const double *ku2_field,
    uint64_t ku2_field_len,
    const double *anisotropy_axis_x_field,
    uint64_t anisotropy_axis_x_field_len,
    double uniform_anisotropy_axis_x,
    const double *anisotropy_axis_y_field,
    uint64_t anisotropy_axis_y_field_len,
    double uniform_anisotropy_axis_y,
    const double *anisotropy_axis_z_field,
    uint64_t anisotropy_axis_z_field_len,
    double uniform_anisotropy_axis_z,
    const double *dind_field,
    uint64_t dind_field_len,
    const double *dbulk_field,
    uint64_t dbulk_field_len,
    const double *kc1_field,
    uint64_t kc1_field_len,
    const double *kc2_field,
    uint64_t kc2_field_len,
    const double *kc3_field,
    uint64_t kc3_field_len,
    const uint8_t *magnetic_node_mask,
    uint64_t magnetic_node_mask_len,
    const uint32_t *periodic_reduced_node,
    uint64_t periodic_reduced_node_len,
    const uint32_t *periodic_representative_nodes,
    uint64_t periodic_representative_nodes_len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_runtime_coefficients_upload(
        state.lifecycle,
        state.runtime_coefficients,
        state.materials,
        state.mesh_metrics,
        state.mesh_regions,
        node_volumes,
        node_volumes_len,
        ms_field,
        ms_field_len,
        uniform_ms,
        a_field,
        a_field_len,
        uniform_a,
        alpha_field,
        alpha_field_len,
        uniform_alpha,
        ku_field,
        ku_field_len,
        ku2_field,
        ku2_field_len,
        anisotropy_axis_x_field,
        anisotropy_axis_x_field_len,
        uniform_anisotropy_axis_x,
        anisotropy_axis_y_field,
        anisotropy_axis_y_field_len,
        uniform_anisotropy_axis_y,
        anisotropy_axis_z_field,
        anisotropy_axis_z_field_len,
        uniform_anisotropy_axis_z,
        dind_field,
        dind_field_len,
        dbulk_field,
        dbulk_field_len,
        kc1_field,
        kc1_field_len,
        kc2_field,
        kc2_field_len,
        kc3_field,
        kc3_field_len,
        magnetic_node_mask,
        magnetic_node_mask_len,
        periodic_reduced_node,
        periodic_reduced_node_len,
        periodic_representative_nodes,
        periodic_representative_nodes_len,
        audit,
        error);
}

bool gpu_state_upload_exchange_legacy_sparse(
    FemGpuState &state,
    uint64_t rows,
    uint64_t cols,
    const uint32_t *csr_row_offsets,
    uint64_t csr_row_offsets_len,
    const uint32_t *csr_col_indices,
    uint64_t csr_col_indices_len,
    const double *csr_values,
    uint64_t csr_values_len,
    const double *lumped_mass,
    uint64_t lumped_mass_len,
    const double *inv_lumped_mass,
    uint64_t inv_lumped_mass_len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_exchange_upload_legacy_sparse(
        state.lifecycle,
        state.legacy_exchange,
        state.mesh_metrics,
        rows,
        cols,
        csr_row_offsets,
        csr_row_offsets_len,
        csr_col_indices,
        csr_col_indices_len,
        csr_values,
        csr_values_len,
        lumped_mass,
        lumped_mass_len,
        inv_lumped_mass,
        inv_lumped_mass_len,
        audit,
        error);
}

bool gpu_state_initialize(
    FemGpuState &state,
    uint64_t node_count,
    fullmag_fem_integrator integrator,
    bool allocate_device,
    bool allocate_demag_workspace,
    const double *initial_magnetization_xyz,
    uint64_t initial_magnetization_len,
    TransferAudit &audit,
    std::string &error)
{
    gpu_state_destroy(state);
    if (node_count > std::numeric_limits<uint64_t>::max() / 3ull) {
        error = "FemGpuState node count is too large for vector DOF metadata";
        return false;
    }
    state.lifecycle.initialized = true;
    state.lifecycle.node_count = node_count;
    state.lifecycle.dof_len = node_count * 3ull;
    state.lifecycle.stage_count = gpu_state_stage_count(integrator);
    state.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.residency.host_state = FemGpuSyncState::HostClean;
    state.residency.device_state = FemGpuSyncState::HostStale;
    state.rk.fsal_valid = false;

    if (!allocate_device || node_count == 0) {
        return true;
    }
    if (initial_magnetization_xyz == nullptr || initial_magnetization_len != state.lifecycle.dof_len) {
        error = "FemGpuState initial magnetization is missing or has invalid length";
        gpu_state_destroy(state);
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    uint64_t device_bytes = 0;
    if (!gpu_magnetization_allocate(state.magnetization, node_count, device_bytes, error) ||
        !gpu_field_buffers_allocate(state.fields, node_count, device_bytes, error) ||
        !gpu_rk_workspace_allocate(state.rk, node_count, state.lifecycle.stage_count, device_bytes, error) ||
        !gpu_relaxation_state_allocate(state.relaxation, node_count, device_bytes, error) ||
        !gpu_local_interaction_workspace_allocate(state.local_interactions, node_count, device_bytes, error) ||
        !gpu_magnetoelastic_allocate(state.magnetoelastic, node_count, device_bytes, error) ||
        !gpu_reduction_workspace_allocate(
            state.reductions,
            node_count,
            device_bytes,
            state.lifecycle.reduction_workspace_bytes,
            error) ||
        !gpu_runtime_coefficients_allocate(
            state.materials,
            state.mesh_metrics,
            state.mesh_regions,
            node_count,
            device_bytes,
            error)) {
        gpu_state_destroy(state);
        return false;
    }

    if (allocate_demag_workspace &&
        (!gpu_device_allocate_double(state.demag_poisson.poisson_rhs, node_count, device_bytes, error) ||
            !gpu_device_allocate_double(state.demag_poisson.poisson_solution, node_count, device_bytes, error) ||
            !gpu_device_allocate_component(state.demag_poisson.poisson_gradient, node_count, device_bytes, error))) {
        gpu_state_destroy(state);
        return false;
    }

    state.lifecycle.allocated = true;
    state.lifecycle.device_bytes = device_bytes;

    if (!gpu_state_upload_magnetization_aos(
            state,
            initial_magnetization_xyz,
            initial_magnetization_len,
            audit,
            error)) {
        gpu_state_destroy(state);
        return false;
    }
    return true;
#else
    (void)audit;
    error = "FemGpuState device allocation requested but fullmag_fem was built without CUDA runtime support";
    gpu_state_destroy(state);
    return false;
#endif
}

void gpu_state_destroy(FemGpuState &state)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    gpu_magnetization_free(state.magnetization);
    gpu_field_buffers_free(state.fields);
    gpu_rk_workspace_free(state.rk);
    gpu_relaxation_state_free(state.relaxation);
    gpu_local_interaction_workspace_free(state.local_interactions);
    gpu_magnetoelastic_free(state.magnetoelastic);
    gpu_reduction_workspace_free(state.reductions);
    gpu_runtime_coefficients_free(state.materials, state.mesh_metrics, state.mesh_regions);
    gpu_device_free_double(state.mesh_geometry.nodes_xyz);
    gpu_device_free_u32(state.mesh_geometry.elements);
    gpu_device_free_u8(state.mesh_geometry.magnetic_element_mask);
    gpu_device_free_double(state.demag_poisson.poisson_rhs);
    gpu_device_free_double(state.demag_poisson.poisson_solution);
    gpu_device_free_component(state.demag_poisson.poisson_gradient);
    gpu_exchange_reset_legacy_sparse(
        state.lifecycle,
        state.legacy_exchange,
        state.mesh_metrics);
#endif
    reset_metadata(state);
}

fullmag_fem_gpu_state_info gpu_state_info(const FemGpuState &state)
{
    fullmag_fem_gpu_state_info info{};
    info.allocated = state.lifecycle.allocated ? 1 : 0;
    info.node_count = state.lifecycle.node_count;
    info.dof_len = state.lifecycle.dof_len;
    info.stage_count = state.lifecycle.stage_count;
    info.device_bytes = state.lifecycle.device_bytes;
    info.reduction_workspace_bytes = state.lifecycle.reduction_workspace_bytes;
    info.source_of_truth = state.residency.source_of_truth;
    return info;
}

fullmag_fem_gpu_state_info gpu_state_info(const Context &ctx)
{
    return gpu_state_info(ctx.gpu_state.device);
}

} // namespace fullmag::fem
