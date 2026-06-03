/*
 * GPU CUDA relaxation memory source contract.
 *
 * Allocates persistent relaxation algorithm buffers. It does not own RK scratch
 * fields, effective-field kernels, line-search policy, or public C ABI
 * dispatch.
 */

#include "gpu/cuda/relaxation/relaxation_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

namespace fullmag::fem {

bool gpu_relaxation_state_allocate(
    FemGpuRelaxationDeviceState &relaxation,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    relaxation.node_count = node_count;
    relaxation.nonlinear_cg_direction_valid = false;
    if (!gpu_device_allocate_component(
            relaxation.nonlinear_cg_direction,
            node_count,
            device_bytes,
            error) ||
        !gpu_device_allocate_component(
            relaxation.nonlinear_cg_direction_backup,
            node_count,
            device_bytes,
            error)) {
        gpu_relaxation_state_free(relaxation);
        return false;
    }
    return true;
}

void gpu_relaxation_state_free(FemGpuRelaxationDeviceState &relaxation)
{
    gpu_device_free_component(relaxation.nonlinear_cg_direction);
    gpu_device_free_component(relaxation.nonlinear_cg_direction_backup);
    relaxation.node_count = 0;
    relaxation.nonlinear_cg_direction_valid = false;
}

} // namespace fullmag::fem
