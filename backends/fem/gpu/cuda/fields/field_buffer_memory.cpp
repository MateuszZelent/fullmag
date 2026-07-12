/*
 * GPU CUDA field-buffer memory source contract.
 *
 * Keeps field-buffer device allocation and cleanup details in the CUDA fields
 * module instead of FemGpuState lifecycle policy code.
 */

#include "gpu/cuda/fields/field_buffer_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

namespace fullmag::fem {

bool gpu_field_buffers_allocate(
    FemGpuFieldBufferDeviceState &fields,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    return gpu_device_allocate_component(fields.h_ex, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_demag, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_ext, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_ani, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_cubic_ani, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_dmi, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_bulk_dmi, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_oe_basis_per_ampere, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_oe, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_therm, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_mel, node_count, device_bytes, error) &&
           gpu_device_allocate_component(fields.h_eff, node_count, device_bytes, error);
}

void gpu_field_buffers_free(FemGpuFieldBufferDeviceState &fields)
{
    gpu_device_free_component(fields.h_ex);
    gpu_device_free_component(fields.h_demag);
    gpu_device_free_component(fields.h_ext);
    gpu_device_free_component(fields.h_ani);
    gpu_device_free_component(fields.h_cubic_ani);
    gpu_device_free_component(fields.h_dmi);
    gpu_device_free_component(fields.h_bulk_dmi);
    gpu_device_free_component(fields.h_oe_basis_per_ampere);
    gpu_device_free_component(fields.h_oe);
    gpu_device_free_component(fields.h_therm);
    gpu_device_free_component(fields.h_mel);
    gpu_device_free_component(fields.h_eff);
}

} // namespace fullmag::fem
