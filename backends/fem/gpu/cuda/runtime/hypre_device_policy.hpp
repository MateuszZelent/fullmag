#pragma once

/*
 * Shared HYPRE CUDA device-policy owner.
 *
 * Both native FEM GPU Poisson consumers use this owner before creating any
 * device PCHYPRE graph.  The returned snapshot records only setters that
 * actually succeeded; partial policy is never promoted to device-ready.
 */

#include <string>

namespace fullmag::fem {

inline constexpr const char *kHypreCudaDevicePolicyUnavailable =
    "k0_poisson_airbox_gpu_hypre_device_policy_unavailable";

struct HypreDevicePolicySnapshot {
    bool configured = false;
    bool memory_location_device = false;
    bool execution_policy_device = false;
    bool vendor_sptrans_enabled = false;
    bool vendor_spmv_enabled = false;
    bool vendor_spgemm_enabled = false;
    int first_error_code = 0;
    std::string failure_reason{};
};

/* Test adapter for deterministic negative setter injection. */
struct HypreDevicePolicyApi {
    int (*set_memory_location_device)() noexcept = nullptr;
    int (*set_execution_policy_device)() noexcept = nullptr;
    int (*set_vendor_sptrans)() noexcept = nullptr;
    int (*set_vendor_spmv)() noexcept = nullptr;
    int (*set_vendor_spgemm)() noexcept = nullptr;
    void (*clear_all_errors)() noexcept = nullptr;
};

bool hypre_cuda_device_policy_is_available(
    const HypreDevicePolicySnapshot &snapshot) noexcept;

/* Thread-safe and idempotent for the process-wide HYPRE runtime. */
HypreDevicePolicySnapshot configure_hypre_cuda_device_policy() noexcept;

namespace detail {

/* Uncached core used only by the policy contract test. */
HypreDevicePolicySnapshot configure_hypre_cuda_device_policy_uncached(
    const HypreDevicePolicyApi &api) noexcept;

} // namespace detail
} // namespace fullmag::fem
