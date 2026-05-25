#pragma once

/*
 * GPU CUDA field-buffer memory module header.
 *
 * Owns device allocation and cleanup helpers for effective-field and local
 * interaction field buffers.
 */

#include "gpu/cuda/fields/field_buffer_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_field_buffers_allocate(
    FemGpuFieldBufferDeviceState &fields,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_field_buffers_free(FemGpuFieldBufferDeviceState &fields);

} // namespace fullmag::fem
