/*
 * GPU CUDA mesh geometry upload source contract.
 *
 * Keeps uploaded mesh geometry validation, device allocation, and transfer
 * accounting in the CUDA mesh module instead of FemGpuState lifecycle code.
 */

#include "gpu/cuda/mesh/mesh_geometry_upload.hpp"

#include "gpu/cuda/state/device_memory.hpp"

#include <algorithm>
#include <limits>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

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

} // namespace

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
    std::string &error)
{
    mesh_geometry.element_count = 0;
    mesh_geometry.uploaded = false;
    if (!lifecycle.allocated) {
        return true;
    }
    const uint64_t expected_nodes_len = lifecycle.node_count * 3ull;
    if (nodes_xyz == nullptr || nodes_xyz_len != expected_nodes_len) {
        error = "FemGpuState mesh geometry upload requires 3 coordinates per node";
        return false;
    }
    if (elements == nullptr || elements_len == 0 || elements_len % 4ull != 0) {
        error = "FemGpuState mesh geometry upload requires tetrahedral element connectivity";
        return false;
    }
    const uint64_t element_count = elements_len / 4ull;
    if (magnetic_element_mask != nullptr &&
        magnetic_element_mask_len != 0 &&
        magnetic_element_mask_len != element_count) {
        error = "FemGpuState mesh geometry upload received magnetic element mask length mismatch";
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (nodes_xyz_len > std::numeric_limits<size_t>::max() / sizeof(double) ||
        elements_len > std::numeric_limits<size_t>::max() / sizeof(uint32_t) ||
        element_count > std::numeric_limits<size_t>::max()) {
        error = "FemGpuState mesh geometry buffer is too large for upload";
        return false;
    }
    if (mesh_geometry.nodes_xyz == nullptr &&
        !gpu_device_allocate_double(mesh_geometry.nodes_xyz, expected_nodes_len, lifecycle.device_bytes, error)) {
        return false;
    }
    if (mesh_geometry.elements == nullptr &&
        !gpu_device_allocate_u32(mesh_geometry.elements, elements_len, lifecycle.device_bytes, error)) {
        return false;
    }
    if (mesh_geometry.magnetic_element_mask == nullptr &&
        !gpu_device_allocate_u8(mesh_geometry.magnetic_element_mask, element_count, lifecycle.device_bytes, error)) {
        return false;
    }
    const size_t nodes_bytes = static_cast<size_t>(nodes_xyz_len) * sizeof(double);
    const size_t elements_bytes = static_cast<size_t>(elements_len) * sizeof(uint32_t);
    std::vector<uint8_t> element_mask(static_cast<size_t>(element_count), 1u);
    if (magnetic_element_mask != nullptr && magnetic_element_mask_len == element_count) {
        std::copy(magnetic_element_mask, magnetic_element_mask + element_count, element_mask.begin());
    }
    const size_t mask_bytes = static_cast<size_t>(element_count) * sizeof(uint8_t);
    if (!cuda_ok(cudaMemcpy(mesh_geometry.nodes_xyz, nodes_xyz, nodes_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState nodes_xyz host->device", error) ||
        !cuda_ok(cudaMemcpy(mesh_geometry.elements, elements, elements_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState elements host->device", error) ||
        !cuda_ok(cudaMemcpy(mesh_geometry.magnetic_element_mask, element_mask.data(), mask_bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetic_element_mask host->device", error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(nodes_bytes + elements_bytes + mask_bytes));
    mesh_geometry.element_count = element_count;
    mesh_geometry.uploaded = true;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

} // namespace fullmag::fem
