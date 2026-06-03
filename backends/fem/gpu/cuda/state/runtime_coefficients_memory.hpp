#pragma once

/*
 * GPU CUDA runtime-coefficients memory module header.
 *
 * Owns device allocation and cleanup helpers for runtime material fields,
 * mesh metrics, and mesh-region maps.
 */

#include "gpu/cuda/materials/material_state.hpp"
#include "gpu/cuda/mesh/mesh_metrics_state.hpp"
#include "gpu/cuda/mesh/mesh_regions_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_runtime_coefficients_allocate(
    FemGpuMaterialDeviceState &materials,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    FemGpuMeshRegionDeviceState &mesh_regions,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_runtime_coefficients_free(
    FemGpuMaterialDeviceState &materials,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    FemGpuMeshRegionDeviceState &mesh_regions);

} // namespace fullmag::fem
