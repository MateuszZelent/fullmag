/*
 * GPU CUDA local interaction workspace memory source contract.
 *
 * Keeps local-interaction scratch allocation and cleanup details in the CUDA
 * interactions module instead of FemGpuState lifecycle policy code.
 */

#include "gpu/cuda/interactions/local_interaction_workspace_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

namespace fullmag::fem {

bool gpu_local_interaction_workspace_allocate(
    FemGpuLocalInteractionWorkspaceDeviceState &local_interactions,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    return gpu_device_allocate_component(
               local_interactions.vector,
               node_count,
               device_bytes,
               error) &&
           gpu_device_allocate_double(
               local_interactions.node_weight,
               node_count,
               device_bytes,
               error);
}

void gpu_local_interaction_workspace_free(
    FemGpuLocalInteractionWorkspaceDeviceState &local_interactions)
{
    gpu_device_free_component(local_interactions.vector);
    gpu_device_free_double(local_interactions.node_weight);
}

} // namespace fullmag::fem
