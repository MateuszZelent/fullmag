/*
 * GPU CUDA magnetoelastic memory source contract.
 *
 * Keeps prescribed-strain allocation details in the CUDA magnetoelastic
 * interaction module instead of FemGpuState lifecycle policy code.
 */

#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

#include <limits>

namespace fullmag::fem {

bool gpu_magnetoelastic_allocate(
    FemGpuMagnetoelasticDeviceState &magnetoelastic,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    if (node_count > std::numeric_limits<uint64_t>::max() / 6ull) {
        error = "FemGpuState node count is too large for magnetoelastic strain allocation";
        return false;
    }
    const uint64_t strain_values = node_count * 6ull;
    return gpu_device_allocate_double(magnetoelastic.strain_voigt, strain_values, device_bytes, error);
}

void gpu_magnetoelastic_free(FemGpuMagnetoelasticDeviceState &magnetoelastic)
{
    gpu_device_free_double(magnetoelastic.strain_voigt);
}

} // namespace fullmag::fem
