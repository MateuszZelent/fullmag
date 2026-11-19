#pragma once

/*
 * Dedicated persistent device staging state for synchronous packed field
 * readback. This buffer is owned by FemGpuState and is separate from the
 * asynchronous snapshot pool.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuPackedFieldDownloadDeviceState {
    double *aos_device = nullptr;
    uint64_t dof_len = 0;
};

} // namespace fullmag::fem
