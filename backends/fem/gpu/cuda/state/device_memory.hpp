#pragma once

/*
 * GPU CUDA device-memory helper module header.
 *
 * Owns low-level CUDA device allocation, zero-fill, and free helpers used by
 * FemGpuState and its RK workspace.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_device_checked_node_bytes(uint64_t node_count, size_t &bytes, std::string &error);

bool gpu_device_allocate_bytes(void **ptr, size_t bytes, uint64_t &device_bytes, std::string &error);
bool gpu_device_allocate_double(double *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error);
bool gpu_device_allocate_u8(uint8_t *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error);
bool gpu_device_allocate_u32(uint32_t *&ptr, uint64_t count, uint64_t &device_bytes, std::string &error);
bool gpu_device_allocate_component(
    FemGpuComponentField &field,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);
bool gpu_device_zero_component(
    FemGpuComponentField &field,
    uint64_t node_count,
    std::string &error);

void gpu_device_free_double(double *&ptr);
void gpu_device_free_bytes(void *&ptr);
void gpu_device_free_u8(uint8_t *&ptr);
void gpu_device_free_u32(uint32_t *&ptr);
void gpu_device_free_component(FemGpuComponentField &field);

} // namespace fullmag::fem
