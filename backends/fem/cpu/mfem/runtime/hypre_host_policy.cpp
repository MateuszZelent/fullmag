/*
 * Native FEM CPU HYPRE host-policy source contract.
 *
 * This source owns the process-wide HYPRE memory-location and execution-policy
 * binding for native FEM CPU contexts. It never configures the device policy
 * (gpu/cuda/runtime/hypre_device_policy.cpp owns that) and never touches CUDA.
 */

#include "cpu/mfem/runtime/hypre_host_policy.hpp"

#include "fem_common.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem/config/_config.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_config.h>
#include <HYPRE_utilities.h>
#endif

#include <mutex>

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && \
    (defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || \
     defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP))
#define FULLMAG_FEM_HYPRE_GPU_BUILD 1
#else
#define FULLMAG_FEM_HYPRE_GPU_BUILD 0
#endif

namespace fullmag::fem {
namespace {

std::mutex policy_mutex;
bool cpu_lane_bound_host = false;

#if FULLMAG_FEM_HYPRE_GPU_BUILD
HypreHostPolicySnapshot read_policy_locked() noexcept
{
    HypreHostPolicySnapshot snapshot{};
    snapshot.hypre_gpu_build = true;
    snapshot.bound_by_cpu_lane = cpu_lane_bound_host;
    if (!HYPRE_Initialized()) {
        // Without an initialized runtime the GPU default would apply on the
        // first allocation; report it as such instead of guessing HOST.
        snapshot.memory_location_host = false;
        snapshot.execution_policy_host = false;
        return snapshot;
    }
    HYPRE_MemoryLocation location = HYPRE_MEMORY_DEVICE;
    HYPRE_ExecutionPolicy policy = HYPRE_EXEC_DEVICE;
    const bool location_known = HYPRE_GetMemoryLocation(&location) == 0;
    const bool policy_known = HYPRE_GetExecutionPolicy(&policy) == 0;
    snapshot.memory_location_host = location_known && location == HYPRE_MEMORY_HOST;
    snapshot.execution_policy_host = policy_known && policy == HYPRE_EXEC_HOST;
    return snapshot;
}
#endif

} // namespace

bool configure_hypre_host_policy(std::string &error)
{
    const std::lock_guard<std::mutex> lock(policy_mutex);
#if FULLMAG_FEM_HYPRE_GPU_BUILD
    // An initialized runtime belongs to an earlier context of this process
    // (possibly a GPU context that owns the device policy); keep it.
    if (!HYPRE_Initialized()) {
        if (HYPRE_Initialize() != 0) {
            HYPRE_ClearAllErrors();
            error = "HYPRE_Initialize failed while binding the native FEM CPU host policy";
            return false;
        }
        if (HYPRE_SetMemoryLocation(HYPRE_MEMORY_HOST) != 0 ||
            HYPRE_SetExecutionPolicy(HYPRE_EXEC_HOST) != 0) {
            HYPRE_ClearAllErrors();
            error = "HYPRE host memory/execution policy setter failed for native FEM CPU";
            return false;
        }
        cpu_lane_bound_host = true;
    }
#else
    (void)error;
#endif
    return true;
}

HypreHostPolicySnapshot current_hypre_host_policy() noexcept
{
    const std::lock_guard<std::mutex> lock(policy_mutex);
#if FULLMAG_FEM_HYPRE_GPU_BUILD
    return read_policy_locked();
#else
    return HypreHostPolicySnapshot{};
#endif
}

const char *hypre_memory_location_name(const HypreHostPolicySnapshot &snapshot) noexcept
{
    return snapshot.memory_location_host ? "host" : "device";
}

const char *hypre_execution_policy_name(const HypreHostPolicySnapshot &snapshot) noexcept
{
    return snapshot.execution_policy_host ? "host" : "device";
}

} // namespace fullmag::fem
