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
#include "gpu/cuda/mesh/mesh_geometry_upload.hpp"
#include "gpu/cuda/state/device_memory.hpp"
#include "gpu/cuda/transfer/component_transfer.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#endif

#include <algorithm>
#include <cstddef>
#include <limits>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr uint32_t kCudaBlockSize = 256;

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}
#endif

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
    state.magnetoelastic.strain_voigt_len = 0;
    state.magnetoelastic.strain_uploaded = false;
    state.mesh_geometry.element_count = 0;
    state.mesh_geometry.uploaded = false;
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

    if (!gpu_component_upload_aos(
            state.lifecycle,
            state.magnetization.m,
            m_xyz,
            len,
            "m",
            audit,
            error)) {
        return false;
    }
    state.residency.device_state = FemGpuSyncState::DeviceClean;
    state.residency.host_state = FemGpuSyncState::HostClean;
    state.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    state.rk.fsal_valid = false;
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

    if (!gpu_component_download_aos(
            state.lifecycle,
            state.magnetization.m,
            out_m_xyz,
            audit,
            "m",
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
    if (!state.lifecycle.allocated) {
        return true;
    }
    if (!gpu_component_upload_aos(
            state.lifecycle, state.fields.h_ex, h_ex_xyz, len, "h_ex", audit, error) ||
        !gpu_component_upload_aos(
            state.lifecycle, state.fields.h_demag, h_demag_xyz, len, "h_demag", audit, error) ||
        !gpu_component_upload_aos(
            state.lifecycle, state.fields.h_ext, h_ext_xyz, len, "h_ext", audit, error) ||
        !gpu_component_upload_aos(
            state.lifecycle, state.fields.h_eff, h_eff_xyz, len, "h_eff", audit, error)) {
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
    return gpu_component_upload_aos(
        state.lifecycle,
        state.fields.h_demag,
        h_demag_xyz,
        len,
        "h_demag",
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
    if (!state.lifecycle.allocated) {
        return true;
    }
    if (!gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_ani, h_ani_xyz, len, "h_ani", audit, error) ||
        !gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_cubic_ani, h_cubic_ani_xyz, len, "h_cubic_ani", audit, error) ||
        !gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_dmi, h_dmi_xyz, len, "h_dmi", audit, error) ||
        !gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_bulk_dmi, h_bulk_dmi_xyz, len, "h_bulk_dmi", audit, error) ||
        !gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_oe, h_oe_xyz, len, "h_oe", audit, error) ||
        !gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_therm, h_therm_xyz, len, "h_therm", audit, error) ||
        !gpu_component_upload_optional_aos(
            state.lifecycle, state.fields.h_mel, h_mel_xyz, len, "h_mel", audit, error)) {
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
    state.magnetoelastic.strain_voigt_len = 0;
    state.magnetoelastic.strain_uploaded = false;
    if (!state.lifecycle.allocated) {
        return true;
    }
    const uint64_t expected_len = state.lifecycle.node_count * 6ull;
    if (strain_voigt == nullptr || strain_len != expected_len) {
        error = "FemGpuState magnetoelastic strain upload requires 6 Voigt values per node";
        return false;
    }
    if (state.magnetoelastic.strain_voigt == nullptr) {
        error = "FemGpuState magnetoelastic strain upload requires allocated device buffer";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    if (strain_len > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState magnetoelastic strain buffer is too large for upload";
        return false;
    }
    const size_t bytes = static_cast<size_t>(strain_len) * sizeof(double);
    if (!cuda_ok(cudaMemcpy(state.magnetoelastic.strain_voigt, strain_voigt, bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetoelastic.strain_voigt host->device", error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(bytes));
    state.magnetoelastic.strain_voigt_len = strain_len;
    state.magnetoelastic.strain_uploaded = true;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
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
    if (!state.lifecycle.allocated) {
        return true;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    const size_t node_count = static_cast<size_t>(state.lifecycle.node_count);
    const size_t double_bytes = node_count * sizeof(double);
    const size_t u8_bytes = node_count * sizeof(uint8_t);
    const size_t u32_bytes = node_count * sizeof(uint32_t);

    auto scalar_values = [node_count](const double *field, uint64_t len, double fallback) {
        std::vector<double> values(node_count, fallback);
        if (field != nullptr && len == static_cast<uint64_t>(node_count)) {
            std::copy(field, field + node_count, values.begin());
        }
        return values;
    };

    const auto node_volume_values = scalar_values(node_volumes, node_volumes_len, 0.0);
    const auto ms_values = scalar_values(ms_field, ms_field_len, uniform_ms);
    const auto a_values = scalar_values(a_field, a_field_len, uniform_a);
    const auto alpha_values = scalar_values(alpha_field, alpha_field_len, uniform_alpha);
    const auto ku_values = scalar_values(ku_field, ku_field_len, 0.0);
    const auto ku2_values = scalar_values(ku2_field, ku2_field_len, 0.0);
    const auto dind_values = scalar_values(dind_field, dind_field_len, 0.0);
    const auto dbulk_values = scalar_values(dbulk_field, dbulk_field_len, 0.0);
    const auto kc1_values = scalar_values(kc1_field, kc1_field_len, 0.0);
    const auto kc2_values = scalar_values(kc2_field, kc2_field_len, 0.0);
    const auto kc3_values = scalar_values(kc3_field, kc3_field_len, 0.0);

    std::vector<uint8_t> magnetic_mask(node_count, 1u);
    if (magnetic_node_mask != nullptr &&
        magnetic_node_mask_len == static_cast<uint64_t>(node_count)) {
        std::copy(magnetic_node_mask, magnetic_node_mask + node_count, magnetic_mask.begin());
    }

    std::vector<uint32_t> reduced_node(node_count);
    std::vector<uint32_t> representative_node(node_count);
    for (size_t node = 0; node < node_count; ++node) {
        reduced_node[node] = static_cast<uint32_t>(node);
        representative_node[node] = static_cast<uint32_t>(node);
    }
    if (periodic_reduced_node != nullptr &&
        periodic_reduced_node_len == static_cast<uint64_t>(node_count)) {
        std::copy(periodic_reduced_node, periodic_reduced_node + node_count, reduced_node.begin());
        if (periodic_representative_nodes != nullptr) {
            for (size_t node = 0; node < node_count; ++node) {
                const uint32_t reduced = reduced_node[node];
                if (reduced < periodic_representative_nodes_len) {
                    representative_node[node] =
                        periodic_representative_nodes[static_cast<size_t>(reduced)];
                }
            }
        }
    }

    if (!cuda_ok(cudaMemcpy(state.mesh_metrics.node_volumes, node_volume_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState node_volumes host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.ms, ms_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ms host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.a, a_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState a host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.alpha, alpha_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState alpha host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.ku, ku_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ku host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.ku2, ku2_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState ku2 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.dind, dind_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState dind host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.dbulk, dbulk_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState dbulk host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.kc1, kc1_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc1 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.kc2, kc2_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc2 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.materials.kc3, kc3_values.data(), double_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState kc3 host->device", error) ||
        !cuda_ok(cudaMemcpy(state.mesh_regions.magnetic_node_mask, magnetic_mask.data(), u8_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetic_node_mask host->device", error) ||
        !cuda_ok(cudaMemcpy(state.mesh_regions.periodic_reduced_node, reduced_node.data(), u32_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState periodic_reduced_node host->device", error) ||
        !cuda_ok(cudaMemcpy(state.mesh_regions.periodic_representative_nodes, representative_node.data(), u32_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState periodic_representative_nodes host->device", error)) {
        return false;
    }
    record_host_to_device(
        audit,
        static_cast<uint64_t>(double_bytes) * 11ull +
            static_cast<uint64_t>(u8_bytes) +
            static_cast<uint64_t>(u32_bytes) * 2ull);
    state.mesh_metrics.node_count = static_cast<uint64_t>(node_count);
    state.materials.node_count = static_cast<uint64_t>(node_count);
    state.mesh_regions.node_count = static_cast<uint64_t>(node_count);
    state.runtime_coefficients.uploaded = true;
    return true;
#else
    (void)node_volumes;
    (void)node_volumes_len;
    (void)ms_field;
    (void)ms_field_len;
    (void)uniform_ms;
    (void)a_field;
    (void)a_field_len;
    (void)uniform_a;
    (void)alpha_field;
    (void)alpha_field_len;
    (void)uniform_alpha;
    (void)ku_field;
    (void)ku_field_len;
    (void)ku2_field;
    (void)ku2_field_len;
    (void)dind_field;
    (void)dind_field_len;
    (void)dbulk_field;
    (void)dbulk_field_len;
    (void)kc1_field;
    (void)kc1_field_len;
    (void)kc2_field;
    (void)kc2_field_len;
    (void)kc3_field;
    (void)kc3_field_len;
    (void)magnetic_node_mask;
    (void)magnetic_node_mask_len;
    (void)periodic_reduced_node;
    (void)periodic_reduced_node_len;
    (void)periodic_representative_nodes;
    (void)periodic_representative_nodes_len;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
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
    if (!gpu_device_allocate_component(state.magnetization.m, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_ex, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_demag, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_ext, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_ani, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_cubic_ani, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_dmi, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_bulk_dmi, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_oe, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_therm, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_mel, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.fields.h_eff, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.rk.m_backup, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.rk.m_stage, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.rk.error, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(state.local_interactions.vector, node_count, device_bytes, error)) {
        gpu_state_destroy(state);
        return false;
    }

    for (uint32_t stage = 0; stage < state.lifecycle.stage_count; ++stage) {
        if (!gpu_device_allocate_component(state.rk.k[stage], node_count, device_bytes, error)) {
            gpu_state_destroy(state);
            return false;
        }
    }

    const uint64_t reduce_blocks = (node_count + kCudaBlockSize - 1ull) / kCudaBlockSize;
    if (node_count > std::numeric_limits<uint64_t>::max() / 6ull) {
        error = "FemGpuState node count is too large for magnetoelastic strain allocation";
        gpu_state_destroy(state);
        return false;
    }
    const uint64_t mel_strain_values = node_count * 6ull;
    if (!gpu_device_allocate_double(state.reductions.scalar_workspace, reduce_blocks, device_bytes, error) ||
        !gpu_device_allocate_double(state.reductions.scalar_result, FEM_GPU_SCALAR_RESULT_SLOTS, device_bytes, error) ||
        !gpu_device_allocate_double(state.local_interactions.node_weight, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.mesh_metrics.node_volumes, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.ms, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.a, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.alpha, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.ku, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.ku2, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.dind, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.dbulk, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.kc1, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.kc2, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.materials.kc3, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(state.magnetoelastic.strain_voigt, mel_strain_values, device_bytes, error) ||
        !gpu_device_allocate_u8(state.mesh_regions.magnetic_node_mask, node_count, device_bytes, error) ||
        !gpu_device_allocate_u32(state.mesh_regions.periodic_reduced_node, node_count, device_bytes, error) ||
        !gpu_device_allocate_u32(state.mesh_regions.periodic_representative_nodes, node_count, device_bytes, error)) {
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

    size_t reduce_temp_storage_bytes = 0;
    if (reduce_blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "FemGpuState reduction block count is too large for CUB device max";
        gpu_state_destroy(state);
        return false;
    }
    fullmag_cuda_device_max(
        state.reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        state.reductions.scalar_result,
        nullptr,
        reduce_temp_storage_bytes,
        nullptr);
    size_t reduce_sum_temp_storage_bytes = 0;
    fullmag_cuda_device_sum(
        state.reductions.scalar_workspace,
        static_cast<int>(reduce_blocks),
        state.reductions.scalar_result,
        nullptr,
        reduce_sum_temp_storage_bytes,
        nullptr);
    reduce_temp_storage_bytes =
        std::max(reduce_temp_storage_bytes, reduce_sum_temp_storage_bytes);
    if (reduce_temp_storage_bytes > 0 &&
        !gpu_device_allocate_bytes(
            &state.reductions.temp_storage,
            reduce_temp_storage_bytes,
            device_bytes,
            error)) {
        gpu_state_destroy(state);
        return false;
    }

    state.lifecycle.allocated = true;
    state.lifecycle.device_bytes = device_bytes;
    state.mesh_metrics.node_count = node_count;
    state.materials.node_count = node_count;
    state.mesh_regions.node_count = node_count;
    state.reductions.temp_storage_bytes =
        static_cast<uint64_t>(reduce_temp_storage_bytes);
    state.lifecycle.reduction_workspace_bytes =
        (reduce_blocks + FEM_GPU_SCALAR_RESULT_SLOTS) * sizeof(double) +
        state.reductions.temp_storage_bytes;

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
    gpu_device_free_component(state.magnetization.m);
    gpu_device_free_component(state.fields.h_ex);
    gpu_device_free_component(state.fields.h_demag);
    gpu_device_free_component(state.fields.h_ext);
    gpu_device_free_component(state.fields.h_ani);
    gpu_device_free_component(state.fields.h_cubic_ani);
    gpu_device_free_component(state.fields.h_dmi);
    gpu_device_free_component(state.fields.h_bulk_dmi);
    gpu_device_free_component(state.fields.h_oe);
    gpu_device_free_component(state.fields.h_therm);
    gpu_device_free_component(state.fields.h_mel);
    gpu_device_free_component(state.fields.h_eff);
    gpu_device_free_component(state.rk.m_backup);
    gpu_device_free_component(state.rk.m_stage);
    gpu_device_free_component(state.rk.error);
    gpu_device_free_component(state.local_interactions.vector);
    for (auto &stage : state.rk.k) {
        gpu_device_free_component(stage);
    }
    gpu_device_free_double(state.reductions.scalar_workspace);
    gpu_device_free_double(state.reductions.scalar_result);
    gpu_device_free_double(state.local_interactions.node_weight);
    gpu_device_free_bytes(state.reductions.temp_storage);
    gpu_device_free_double(state.mesh_metrics.node_volumes);
    gpu_device_free_double(state.materials.ms);
    gpu_device_free_double(state.materials.a);
    gpu_device_free_double(state.materials.alpha);
    gpu_device_free_double(state.materials.ku);
    gpu_device_free_double(state.materials.ku2);
    gpu_device_free_double(state.materials.dind);
    gpu_device_free_double(state.materials.dbulk);
    gpu_device_free_double(state.materials.kc1);
    gpu_device_free_double(state.materials.kc2);
    gpu_device_free_double(state.materials.kc3);
    gpu_device_free_double(state.magnetoelastic.strain_voigt);
    gpu_device_free_u8(state.mesh_regions.magnetic_node_mask);
    gpu_device_free_u32(state.mesh_regions.periodic_reduced_node);
    gpu_device_free_u32(state.mesh_regions.periodic_representative_nodes);
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
