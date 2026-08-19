/*
 * Shared HYPRE CUDA device-policy source contract.
 *
 * This module is the sole owner of process-wide HYPRE device memory,
 * execution, and vendor sparse-kernel setters.  It preserves the first HYPRE
 * failure before clearing the library error stack and publishes an immutable
 * snapshot to all native FEM GPU consumers.
 */

#include "gpu/cuda/runtime/hypre_device_policy.hpp"

#include "fem_common.hpp"

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

#include <mutex>

namespace fullmag::fem {
namespace {

HypreDevicePolicySnapshot unavailable_snapshot(int error_code) noexcept
{
    HypreDevicePolicySnapshot snapshot{};
    snapshot.first_error_code = error_code;
    try {
        snapshot.failure_reason = kHypreCudaDevicePolicyUnavailable;
    } catch (...) {
        // The numeric failure and false configured flag remain fail-closed if
        // allocation of the diagnostic reason itself is unavailable.
    }
    return snapshot;
}

bool record_setter(
    int (*setter)() noexcept,
    void (*clear_errors)() noexcept,
    bool &attested,
    HypreDevicePolicySnapshot &snapshot) noexcept
{
    if (setter == nullptr) {
        snapshot = unavailable_snapshot(-1);
        return false;
    }
    const int status = setter();
    if (status != 0) {
        snapshot.first_error_code = status;
        try {
            snapshot.failure_reason = kHypreCudaDevicePolicyUnavailable;
        } catch (...) {
        }
        if (clear_errors != nullptr) {
            clear_errors();
        }
        return false;
    }
    attested = true;
    return true;
}

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && \
    (defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || \
     defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP))
int set_memory_location_device() noexcept
{
    return static_cast<int>(HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE));
}

int set_execution_policy_device() noexcept
{
    return static_cast<int>(HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE));
}

int set_vendor_sptrans() noexcept
{
    return static_cast<int>(HYPRE_SetSpTransUseVendor(1));
}

int set_vendor_spmv() noexcept
{
    return static_cast<int>(HYPRE_SetSpMVUseVendor(1));
}

int set_vendor_spgemm() noexcept
{
    return static_cast<int>(HYPRE_SetSpGemmUseVendor(1));
}

void clear_all_errors() noexcept
{
    HYPRE_ClearAllErrors();
}
#endif

} // namespace

bool hypre_cuda_device_policy_is_available(
    const HypreDevicePolicySnapshot &snapshot) noexcept
{
    return snapshot.configured && snapshot.memory_location_device &&
        snapshot.execution_policy_device && snapshot.vendor_sptrans_enabled &&
        snapshot.vendor_spmv_enabled && snapshot.vendor_spgemm_enabled &&
        snapshot.first_error_code == 0 && snapshot.failure_reason.empty();
}

namespace detail {

HypreDevicePolicySnapshot configure_hypre_cuda_device_policy_uncached(
    const HypreDevicePolicyApi &api) noexcept
{
    HypreDevicePolicySnapshot snapshot{};
    if (!record_setter(
            api.set_memory_location_device,
            api.clear_all_errors,
            snapshot.memory_location_device,
            snapshot) ||
        !record_setter(
            api.set_execution_policy_device,
            api.clear_all_errors,
            snapshot.execution_policy_device,
            snapshot) ||
        !record_setter(
            api.set_vendor_sptrans,
            api.clear_all_errors,
            snapshot.vendor_sptrans_enabled,
            snapshot) ||
        !record_setter(
            api.set_vendor_spmv,
            api.clear_all_errors,
            snapshot.vendor_spmv_enabled,
            snapshot) ||
        !record_setter(
            api.set_vendor_spgemm,
            api.clear_all_errors,
            snapshot.vendor_spgemm_enabled,
            snapshot)) {
        return snapshot;
    }
    snapshot.configured = true;
    return snapshot;
}

} // namespace detail

HypreDevicePolicySnapshot configure_hypre_cuda_device_policy() noexcept
{
    static std::mutex mutex;
    static bool attempted = false;
    static HypreDevicePolicySnapshot snapshot{};
    const std::lock_guard<std::mutex> lock(mutex);
    if (!attempted) {
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && \
    (defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || \
     defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP))
        const HypreDevicePolicyApi api{
            set_memory_location_device,
            set_execution_policy_device,
            set_vendor_sptrans,
            set_vendor_spmv,
            set_vendor_spgemm,
            clear_all_errors};
        snapshot = detail::configure_hypre_cuda_device_policy_uncached(api);
#else
        snapshot = unavailable_snapshot(-1);
#endif
        attempted = true;
    }
    HypreDevicePolicySnapshot result{};
    try {
        result = snapshot;
    } catch (...) {
        return unavailable_snapshot(-1);
    }
    return result;
}

} // namespace fullmag::fem
