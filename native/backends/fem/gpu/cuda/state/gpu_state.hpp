#pragma once

/*
 * GPU CUDA state module header.
 *
 * Declares FemGpuState ownership, device buffers, transfer helpers, and GPU
 * state telemetry for the native FEM CUDA realization.
 */

#include "fullmag_fem.h"
#include "gpu/cuda/demag_poisson/demag_state.hpp"
#include "gpu/cuda/exchange/exchange_state.hpp"
#include "gpu/cuda/fields/field_buffer_state.hpp"
#include "gpu/cuda/integrators/rk/rk_workspace_state.hpp"
#include "gpu/cuda/interactions/local_interaction_workspace_state.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_state.hpp"
#include "gpu/cuda/materials/material_state.hpp"
#include "gpu/cuda/mesh/mesh_geometry_state.hpp"
#include "gpu/cuda/mesh/mesh_metrics_state.hpp"
#include "gpu/cuda/mesh/mesh_regions_state.hpp"
#include "gpu/cuda/reductions/reduction_workspace_state.hpp"
#include "gpu/cuda/state/component_field.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/state/magnetization_state.hpp"
#include "gpu/cuda/state/residency_state.hpp"
#include "gpu/cuda/state/runtime_coefficients_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

struct FemGpuState {
    FemGpuLifecycleDeviceState lifecycle{};
    FemGpuResidencyDeviceState residency{};

    FemGpuMagnetizationDeviceState magnetization{};
    FemGpuRuntimeCoefficientDeviceState runtime_coefficients{};

    FemGpuDemagPoissonDeviceState demag_poisson{};
    LegacyGpuExchangeDeviceState legacy_exchange{};
    FemGpuFieldBufferDeviceState fields{};
    FemGpuRkWorkspaceDeviceState rk{};
    FemGpuLocalInteractionWorkspaceDeviceState local_interactions{};
    FemGpuMagnetoelasticDeviceState magnetoelastic{};
    FemGpuMaterialDeviceState materials{};
    FemGpuMeshGeometryDeviceState mesh_geometry{};
    FemGpuMeshMetricsDeviceState mesh_metrics{};
    FemGpuMeshRegionDeviceState mesh_regions{};
    FemGpuReductionWorkspaceDeviceState reductions{};
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
