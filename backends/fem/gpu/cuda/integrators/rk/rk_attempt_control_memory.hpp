#pragma once

#include "gpu/cuda/integrators/rk/rk_attempt_control_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_rk_attempt_control_allocate(
    GpuRkAttemptControlDeviceState &control,
    uint64_t &device_bytes,
    std::string &error);

void gpu_rk_attempt_control_free(GpuRkAttemptControlDeviceState &control);

} // namespace fullmag::fem
