/*
 * GPU RK attempt-control packet allocation owner.
 *
 * Allocation happens once with the RK workspace. No device allocation or
 * pinned-host allocation is permitted in the per-attempt hot loop.
 */

#include "gpu/cuda/integrators/rk/rk_attempt_control_memory.hpp"

#include "gpu/cuda/state/device_memory.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

bool gpu_rk_attempt_control_allocate(
    GpuRkAttemptControlDeviceState &control,
    uint64_t &device_bytes,
    std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    void *device_raw = nullptr;
    if (!gpu_device_allocate_bytes(
            &device_raw,
            sizeof(GpuRkAttemptControlPacket),
            device_bytes,
            error)) {
        return false;
    }
    control.device = static_cast<GpuRkAttemptControlPacket *>(device_raw);
    void *host_raw = nullptr;
    if (cudaHostAlloc(
            &host_raw,
            sizeof(GpuRkAttemptControlPacket),
            cudaHostAllocPortable) != cudaSuccess) {
        error = "cudaHostAlloc GPU RK attempt-control packet failed";
        gpu_device_free_bytes(device_raw);
        const uint64_t packet_bytes = sizeof(GpuRkAttemptControlPacket);
        device_bytes = device_bytes >= packet_bytes ? device_bytes - packet_bytes : 0u;
        control.device = nullptr;
        return false;
    }
    control.host_pinned = static_cast<GpuRkAttemptControlPacket *>(host_raw);
    control.host_pinned_owned = true;
    *control.host_pinned = {};
    return true;
#else
    (void)control;
    (void)device_bytes;
    error = "GPU RK attempt-control packet requires CUDA runtime support";
    return false;
#endif
}

void gpu_rk_attempt_control_free(GpuRkAttemptControlDeviceState &control)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (control.host_pinned != nullptr && control.host_pinned_owned) {
        cudaFreeHost(control.host_pinned);
    }
#else
    (void)control;
#endif
    control.host_pinned = nullptr;
    control.host_pinned_owned = false;
    void *device_raw = control.device;
    gpu_device_free_bytes(device_raw);
    control.device = nullptr;
}

} // namespace fullmag::fem
