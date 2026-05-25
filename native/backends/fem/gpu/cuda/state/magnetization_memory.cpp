/*
 * GPU CUDA magnetization memory source contract.
 *
 * Keeps current-magnetization device allocation and cleanup details in the CUDA
 * state module instead of FemGpuState lifecycle policy code.
 */

#include "gpu/cuda/state/magnetization_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

namespace fullmag::fem {

bool gpu_magnetization_allocate(
    FemGpuMagnetizationDeviceState &magnetization,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    return gpu_device_allocate_component(
        magnetization.m,
        node_count,
        device_bytes,
        error);
}

void gpu_magnetization_free(FemGpuMagnetizationDeviceState &magnetization)
{
    gpu_device_free_component(magnetization.m);
}

} // namespace fullmag::fem
