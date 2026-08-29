/*
 * GPU CUDA runtime-coefficients memory source contract.
 *
 * Keeps runtime material, mesh metric, and mesh-region allocation details in
 * the CUDA runtime-coefficients module instead of FemGpuState lifecycle policy
 * code.
 */

#include "gpu/cuda/state/runtime_coefficients_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

namespace fullmag::fem {

bool gpu_runtime_coefficients_allocate(
    FemGpuMaterialDeviceState &materials,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    FemGpuMeshRegionDeviceState &mesh_regions,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    if (!gpu_device_allocate_double(mesh_metrics.node_volumes, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.ms, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.a, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.alpha, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.ku, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.ku2, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.anisotropy_axis_x, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.anisotropy_axis_y, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.anisotropy_axis_z, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.dind, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.dbulk, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.kc1, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.kc2, node_count, device_bytes, error) ||
        !gpu_device_allocate_double(materials.kc3, node_count, device_bytes, error) ||
        !gpu_device_allocate_u8(mesh_regions.magnetic_node_mask, node_count, device_bytes, error) ||
        !gpu_device_allocate_u32(mesh_regions.periodic_reduced_node, node_count, device_bytes, error) ||
        !gpu_device_allocate_u32(mesh_regions.periodic_representative_nodes, node_count, device_bytes, error)) {
        return false;
    }
    mesh_metrics.node_count = node_count;
    materials.node_count = node_count;
    mesh_regions.node_count = node_count;
    return true;
}

void gpu_runtime_coefficients_free(
    FemGpuMaterialDeviceState &materials,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    FemGpuMeshRegionDeviceState &mesh_regions)
{
    gpu_device_free_double(mesh_metrics.node_volumes);
    gpu_device_free_double(materials.ms);
    gpu_device_free_double(materials.a);
    gpu_device_free_double(materials.alpha);
    gpu_device_free_double(materials.ku);
    gpu_device_free_double(materials.ku2);
    gpu_device_free_double(materials.anisotropy_axis_x);
    gpu_device_free_double(materials.anisotropy_axis_y);
    gpu_device_free_double(materials.anisotropy_axis_z);
    gpu_device_free_double(materials.dind);
    gpu_device_free_double(materials.dbulk);
    gpu_device_free_double(materials.kc1);
    gpu_device_free_double(materials.kc2);
    gpu_device_free_double(materials.kc3);
    gpu_device_free_u8(mesh_regions.magnetic_node_mask);
    gpu_device_free_u8(mesh_regions.stt_active_node_mask);
    mesh_regions.stt_active_node_count = 0;
    gpu_device_free_u8(mesh_regions.stt_active_element_mask);
    mesh_regions.stt_active_element_count = 0;
    gpu_device_free_u8(mesh_regions.frozen_mask);
    gpu_device_free_u8(mesh_regions.free_node_mask);
    mesh_regions.free_node_mask_count = 0;
    mesh_regions.frozen_node_count = 0;
    gpu_device_free_double(mesh_regions.frozen_reference_x);
    gpu_device_free_double(mesh_regions.frozen_reference_y);
    gpu_device_free_double(mesh_regions.frozen_reference_z);
    gpu_device_free_u32(mesh_regions.periodic_reduced_node);
    gpu_device_free_u32(mesh_regions.periodic_representative_nodes);
}

} // namespace fullmag::fem
