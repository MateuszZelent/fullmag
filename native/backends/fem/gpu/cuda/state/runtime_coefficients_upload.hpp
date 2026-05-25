#pragma once

/*
 * GPU CUDA runtime-coefficients upload module header.
 *
 * Owns fallback expansion, periodic-map construction, host-to-device transfer,
 * and readiness marking for runtime material, mesh-metric, and mesh-region
 * coefficients.
 */

#include "gpu/cuda/materials/material_state.hpp"
#include "gpu/cuda/mesh/mesh_metrics_state.hpp"
#include "gpu/cuda/mesh/mesh_regions_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/state/runtime_coefficients_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_runtime_coefficients_upload(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuRuntimeCoefficientDeviceState &runtime_coefficients,
    FemGpuMaterialDeviceState &materials,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    FemGpuMeshRegionDeviceState &mesh_regions,
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

} // namespace fullmag::fem
