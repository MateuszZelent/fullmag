/*
 * GPU CUDA device-memory helper source contract.
 *
 * Owns low-level device allocation, byte accounting, overflow checks, zero
 * fill, and device pointer cleanup for the native FEM CUDA state layer. It
 * does not own FemGpuState lifecycle policy, runtime uploads, transfer
 * auditing, or RK execution.
 */

#include "gpu/cuda/state/device_memory.hpp"

#include <limits>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

bool gpu_device_checked_node_bytes(uint64_t node_count, size_t &bytes, std::string &error)
{
    if (node_count > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState node count is too large for device allocation";
        return false;
    }
    bytes = static_cast<size_t>(node_count) * sizeof(double);
    return true;
}

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

} // namespace
#endif

bool gpu_device_allocate_bytes(void **ptr, size_t bytes, uint64_t &device_bytes, std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (bytes == 0) {
        *ptr = nullptr;
        return true;
    }
    if (!cuda_ok(cudaMalloc(ptr, bytes), "cudaMalloc", error)) {
        *ptr = nullptr;
        return false;
    }
    device_bytes += static_cast<uint64_t>(bytes);
    return true;
#else
    (void)bytes;
    (void)device_bytes;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    if (ptr != nullptr) {
        *ptr = nullptr;
    }
    return false;
#endif
}

bool gpu_device_allocate_double(double *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error)
{
    if (count > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState double buffer is too large for device allocation";
        return false;
    }
    void *raw = nullptr;
    if (!gpu_device_allocate_bytes(&raw, static_cast<size_t>(count) * sizeof(double), device_bytes, error)) {
        return false;
    }
    ptr = static_cast<double *>(raw);
    return true;
}

bool gpu_device_allocate_u8(uint8_t *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error)
{
    void *raw = nullptr;
    if (!gpu_device_allocate_bytes(&raw, static_cast<size_t>(count), device_bytes, error)) {
        return false;
    }
    ptr = static_cast<uint8_t *>(raw);
    return true;
}

bool gpu_device_allocate_u32(uint32_t *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error)
{
    if (count > std::numeric_limits<size_t>::max() / sizeof(uint32_t)) {
        error = "FemGpuState u32 buffer is too large for device allocation";
        return false;
    }
    void *raw = nullptr;
    if (!gpu_device_allocate_bytes(&raw, static_cast<size_t>(count) * sizeof(uint32_t), device_bytes, error)) {
        return false;
    }
    ptr = static_cast<uint32_t *>(raw);
    return true;
}

bool gpu_device_allocate_component(
    FemGpuComponentField &field,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error)
{
    return gpu_device_allocate_double(field.x, node_count, device_bytes, error) &&
           gpu_device_allocate_double(field.y, node_count, device_bytes, error) &&
           gpu_device_allocate_double(field.z, node_count, device_bytes, error);
}

bool gpu_device_zero_component(
    FemGpuComponentField &field,
    uint64_t node_count,
    std::string &error)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    size_t component_bytes = 0;
    if (!gpu_device_checked_node_bytes(node_count, component_bytes, error)) {
        return false;
    }
    if (node_count == 0) {
        return true;
    }
    if (field.x == nullptr || field.y == nullptr || field.z == nullptr) {
        error = "GPU component zero fill received an unallocated device component";
        return false;
    }
    if (!cuda_ok(cudaMemset(field.x, 0, component_bytes), "cudaMemset component x", error) ||
        !cuda_ok(cudaMemset(field.y, 0, component_bytes), "cudaMemset component y", error) ||
        !cuda_ok(cudaMemset(field.z, 0, component_bytes), "cudaMemset component z", error)) {
        return false;
    }
    return true;
#else
    (void)field;
    (void)node_count;
    error = "GPU component zero fill requires CUDA runtime support";
    return false;
#endif
}

void gpu_device_free_double(double *&ptr)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
#else
    ptr = nullptr;
#endif
}

void gpu_device_free_bytes(void *&ptr)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
#else
    ptr = nullptr;
#endif
}

void gpu_device_free_u8(uint8_t *&ptr)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
#else
    ptr = nullptr;
#endif
}

void gpu_device_free_u32(uint32_t *&ptr)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
#else
    ptr = nullptr;
#endif
}

void gpu_device_free_component(FemGpuComponentField &field)
{
    gpu_device_free_double(field.x);
    gpu_device_free_double(field.y);
    gpu_device_free_double(field.z);
}

} // namespace fullmag::fem
