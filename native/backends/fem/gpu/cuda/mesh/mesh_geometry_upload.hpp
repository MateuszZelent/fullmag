#pragma once

/*
 * GPU CUDA mesh geometry upload module header.
 *
 * Owns validation, allocation, and host-to-device transfer for uploaded FEM
 * mesh geometry used by GPU-side local interaction kernels.
 */

#include "gpu/cuda/mesh/mesh_geometry_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_mesh_geometry_upload(
    FemGpuLifecycleDeviceState &lifecycle,
    FemGpuMeshGeometryDeviceState &mesh_geometry,
    const double *nodes_xyz,
    uint64_t nodes_xyz_len,
    const uint32_t *elements,
    uint64_t elements_len,
    const uint8_t *magnetic_element_mask,
    uint64_t magnetic_element_mask_len,
    TransferAudit &audit,
    std::string &error);

} // namespace fullmag::fem
