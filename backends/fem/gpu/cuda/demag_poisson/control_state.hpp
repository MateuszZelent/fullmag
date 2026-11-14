#pragma once

#include <cstdint>

namespace fullmag::fem {

constexpr uint32_t kGpuPcgControlConfigAbiVersion = 1u;
constexpr uint32_t kGpuPcgControlConfigStructSize = 16u;
constexpr uint32_t kGpuPcgControlInfoAbiVersion = 1u;
constexpr uint32_t kGpuPcgControlInfoStructSize = 64u;
constexpr uint32_t kDefaultGpuPcgStatusBatchStride = 8u;

constexpr bool gpu_pcg_control_status_batch_stride_valid(uint32_t stride)
{
    return stride == 4u || stride == 8u;
}

constexpr bool gpu_pcg_control_config_fields_valid(
    uint32_t abi_version,
    uint32_t struct_size,
    uint32_t status_batch_stride,
    uint32_t reserved)
{
    return abi_version == kGpuPcgControlConfigAbiVersion &&
        struct_size == kGpuPcgControlConfigStructSize &&
        gpu_pcg_control_status_batch_stride_valid(status_batch_stride) &&
        reserved == 0u;
}

constexpr bool gpu_pcg_control_info_header_valid(uint32_t abi_version, uint32_t struct_size)
{
    return abi_version == kGpuPcgControlInfoAbiVersion &&
        struct_size == kGpuPcgControlInfoStructSize;
}

// Host-owned policy and raw API-invocation counters. This state deliberately
// lives in Context rather than the CUDA/HYPRE workspace and is not part of
// accepted/rejected TransferAudit rollback.
struct GpuPcgControlRuntimeState {
    uint32_t requested_status_batch_stride = 0u;
    bool first_attempt_started = false;
    uint64_t solve_attempts = 0u;
    uint64_t enqueued_iterations = 0u;
    uint64_t amg_apply_calls = 0u;
    uint64_t hot_loop_solve_attempts = 0u;
    uint64_t hot_loop_enqueued_iterations = 0u;
    uint64_t hot_loop_amg_apply_calls = 0u;

    constexpr uint32_t resolved_status_batch_stride() const
    {
        return requested_status_batch_stride == 0u
            ? kDefaultGpuPcgStatusBatchStride
            : requested_status_batch_stride;
    }

    bool try_set_status_batch_stride(uint32_t stride)
    {
        if (first_attempt_started || !gpu_pcg_control_status_batch_stride_valid(stride)) {
            return false;
        }
        requested_status_batch_stride = stride;
        return true;
    }

    void record_solve_attempt(bool hot_loop)
    {
        first_attempt_started = true;
        ++solve_attempts;
        if (hot_loop) ++hot_loop_solve_attempts;
    }

    void record_enqueued_iteration(bool hot_loop)
    {
        ++enqueued_iterations;
        if (hot_loop) ++hot_loop_enqueued_iterations;
    }

    void record_amg_apply(bool hot_loop)
    {
        ++amg_apply_calls;
        if (hot_loop) ++hot_loop_amg_apply_calls;
    }
};

} // namespace fullmag::fem
