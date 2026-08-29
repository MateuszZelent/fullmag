/*
 * GPU CUDA RK workspace memory source contract.
 *
 * Keeps RK scratch, stage-buffer, and atomic rollback allocation details in
 * the CUDA RK module instead of FemGpuState lifecycle policy code.
 */

#include "gpu/cuda/integrators/rk/rk_workspace_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

namespace fullmag::fem {

bool gpu_rk_workspace_allocate(
    FemGpuRkWorkspaceDeviceState &rk,
    uint64_t node_count,
    uint32_t stage_count,
    uint64_t &device_bytes,
    std::string &error)
{
    if (stage_count > FEM_GPU_MAX_RK_STAGES) {
        error = "FemGpuState RK stage count exceeds RK workspace capacity";
        return false;
    }
    if (!gpu_device_allocate_component(rk.m_backup, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(rk.m_stage, node_count, device_bytes, error) ||
        !gpu_device_allocate_component(rk.error, node_count, device_bytes, error)) {
        return false;
    }
    for (uint32_t stage = 0; stage < stage_count; ++stage) {
        if (!gpu_device_allocate_component(rk.k[stage], node_count, device_bytes, error) ||
            !gpu_device_zero_component(rk.k[stage], node_count, error)) {
            return false;
        }
    }
    return gpu_device_allocate_component(
               rk.transaction_m, node_count, device_bytes, error) &&
        gpu_device_allocate_component(
               rk.transaction_k0, node_count, device_bytes, error);
}

void gpu_rk_workspace_free(FemGpuRkWorkspaceDeviceState &rk)
{
    gpu_device_free_component(rk.m_backup);
    gpu_device_free_component(rk.m_stage);
    gpu_device_free_component(rk.error);
    for (auto &stage : rk.k) {
        gpu_device_free_component(stage);
    }
    gpu_device_free_component(rk.transaction_m);
    gpu_device_free_component(rk.transaction_k0);
}

} // namespace fullmag::fem
