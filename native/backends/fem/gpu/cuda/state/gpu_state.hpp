#pragma once

/*
 * GPU CUDA state module header.
 *
 * Declares FemGpuState ownership, device buffers, transfer helpers, and GPU
 * state telemetry for the native FEM CUDA realization.
 */

#include "fullmag_fem.h"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

static constexpr uint32_t FEM_GPU_MAX_RK_STAGES = 7;
static constexpr uint32_t FEM_GPU_SCALAR_RESULT_SLOTS = 17;

enum class FemGpuSyncState {
    HostClean,
    HostDirty,
    HostStale,
    DeviceClean,
    DeviceDirty,
};

struct FemGpuComponentField {
    double *x = nullptr;
    double *y = nullptr;
    double *z = nullptr;
};

struct FemGpuState {
    bool initialized = false;
    bool allocated = false;
    uint64_t node_count = 0;
    uint64_t dof_len = 0;
    uint32_t stage_count = 0;
    uint64_t device_bytes = 0;
    uint64_t reduction_workspace_bytes = 0;
    fullmag_fem_data_residency source_of_truth =
        FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;

    FemGpuSyncState host_state = FemGpuSyncState::HostClean;
    FemGpuSyncState device_state = FemGpuSyncState::HostStale;

    FemGpuComponentField m;
    FemGpuComponentField h_ex;
    FemGpuComponentField h_demag;
    FemGpuComponentField h_ext;
    FemGpuComponentField h_ani;
    FemGpuComponentField h_cubic_ani;
    FemGpuComponentField h_dmi;
    FemGpuComponentField h_bulk_dmi;
    FemGpuComponentField h_oe;
    FemGpuComponentField h_therm;
    FemGpuComponentField h_mel;
    FemGpuComponentField h_eff;
    FemGpuComponentField m_backup;
    FemGpuComponentField m_stage;
    FemGpuComponentField error;
    FemGpuComponentField zhang_li_rhs;
    std::array<FemGpuComponentField, FEM_GPU_MAX_RK_STAGES> k{};
    bool fsal_valid = false;

    double *scalar_reduce_workspace = nullptr;
    double *scalar_reduce_result = nullptr;
    double *zhang_li_node_weight = nullptr;
    void *scalar_reduce_temp_storage = nullptr;
    uint64_t scalar_reduce_temp_storage_bytes = 0;

    double *node_volumes = nullptr;
    double *ms = nullptr;
    double *a = nullptr;
    double *alpha = nullptr;
    double *ku = nullptr;
    double *ku2 = nullptr;
    double *dind = nullptr;
    double *dbulk = nullptr;
    double *kc1 = nullptr;
    double *kc2 = nullptr;
    double *kc3 = nullptr;
    double *mel_strain_voigt = nullptr;
    uint64_t mel_strain_voigt_len = 0;
    bool mel_strain_uploaded = false;
    uint8_t *magnetic_node_mask = nullptr;
    uint32_t *periodic_reduced_node = nullptr;
    uint32_t *periodic_representative_nodes = nullptr;
    bool runtime_coefficients_uploaded = false;

    double *nodes_xyz = nullptr;
    uint32_t *elements = nullptr;
    uint8_t *magnetic_element_mask = nullptr;
    uint64_t mesh_element_count = 0;
    bool mesh_geometry_uploaded = false;

    double *poisson_rhs = nullptr;
    double *poisson_solution = nullptr;
    FemGpuComponentField poisson_gradient;
    std::vector<double> hybrid_stage_m_xyz;
    std::vector<double> hybrid_demag_xyz;
    double hybrid_demag_energy_joules = 0.0;

    bool exchange_legacy_sparse_uploaded = false;
    uint64_t exchange_legacy_sparse_rows = 0;
    uint64_t exchange_legacy_sparse_cols = 0;
    uint64_t exchange_legacy_sparse_nnz = 0;
    uint64_t exchange_legacy_sparse_device_bytes = 0;
    uint32_t *exchange_csr_row_offsets = nullptr;
    uint32_t *exchange_csr_col_indices = nullptr;
    double *exchange_csr_values = nullptr;
    double *exchange_lumped_mass = nullptr;
    double *exchange_inv_lumped_mass = nullptr;
};

uint32_t gpu_state_stage_count(fullmag_fem_integrator integrator);

bool gpu_state_initialize(
    FemGpuState &state,
    uint64_t node_count,
    fullmag_fem_integrator integrator,
    bool allocate_device,
    bool allocate_demag_workspace,
    const double *initial_magnetization_xyz,
    uint64_t initial_magnetization_len,
    TransferAudit &audit,
    std::string &error);

bool gpu_state_upload_magnetization_aos(
    FemGpuState &state,
    const double *m_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

bool gpu_state_download_magnetization_aos(
    FemGpuState &state,
    std::vector<double> &out_m_xyz,
    TransferAudit &audit,
    std::string &error);

bool gpu_state_download_component_aos(
    FemGpuState &state,
    const FemGpuComponentField &field,
    std::vector<double> &out_xyz,
    TransferAudit &audit,
    const char *label,
    std::string &error);

bool gpu_state_upload_effective_fields_aos(
    FemGpuState &state,
    const double *h_ex_xyz,
    const double *h_demag_xyz,
    const double *h_ext_xyz,
    const double *h_eff_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

bool gpu_state_upload_demag_field_aos(
    FemGpuState &state,
    const double *h_demag_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

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
    std::string &error);

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
    std::string &error);

bool gpu_state_upload_magnetoelastic_strain(
    FemGpuState &state,
    const double *strain_voigt,
    uint64_t strain_len,
    TransferAudit &audit,
    std::string &error);

bool gpu_state_upload_mesh_geometry(
    FemGpuState &state,
    const double *nodes_xyz,
    uint64_t nodes_xyz_len,
    const uint32_t *elements,
    uint64_t elements_len,
    const uint8_t *magnetic_element_mask,
    uint64_t magnetic_element_mask_len,
    TransferAudit &audit,
    std::string &error);

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
    std::string &error);

void gpu_state_destroy(FemGpuState &state);

fullmag_fem_gpu_state_info gpu_state_info(const FemGpuState &state);

/*
 * Return public GPU-state diagnostics for a backend Context.
 *
 * Keeps C ABI diagnostics entrypoints from reaching into Context storage
 * directly; this module owns the GPU-state info read boundary even when the
 * state is embedded in the compatibility Context facade.
 */
fullmag_fem_gpu_state_info gpu_state_info(const Context &ctx);

} // namespace fullmag::fem
