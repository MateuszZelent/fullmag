#pragma once

/*
 * Native FEM CPU HYPRE host-policy owner.
 *
 * The production stack links one CUDA-enabled HYPRE for both FEM lanes. Its
 * process default places HYPRE memory and execution on the device, so a CPU
 * context that never binds the policy silently runs AMG on a visible GPU and
 * aborts in cudaMalloc when the worker has no GPU (CUDA_VISIBLE_DEVICES="").
 * A CPU context binds HOST memory and execution before any HYPRE object is
 * created; a process whose HYPRE runtime is already initialized keeps its
 * existing policy (the GPU lane owns the device policy) and reports it.
 */

#include <string>

namespace fullmag::fem {

struct HypreHostPolicySnapshot {
    bool hypre_gpu_build = false;
    /* This call (or an earlier CPU context in the process) bound HOST. */
    bool bound_by_cpu_lane = false;
    bool memory_location_host = true;
    bool execution_policy_host = true;
};

/* Thread-safe; returns false with `error` only when a HYPRE setter fails. */
bool configure_hypre_host_policy(std::string &error);

/* Current process-wide HYPRE policy for runtime logs. */
HypreHostPolicySnapshot current_hypre_host_policy() noexcept;

const char *hypre_memory_location_name(const HypreHostPolicySnapshot &snapshot) noexcept;
const char *hypre_execution_policy_name(const HypreHostPolicySnapshot &snapshot) noexcept;

} // namespace fullmag::fem
