#pragma once

/*
 * GPU CUDA residency device-state module header.
 *
 * Owns host/device synchronization state and the current data-residency source
 * of truth for the native FEM CUDA realization.
 */

#include "fullmag_fem.h"

namespace fullmag::fem {

enum class FemGpuSyncState {
    HostClean,
    HostDirty,
    HostStale,
    DeviceClean,
    DeviceDirty,
};

struct FemGpuResidencyDeviceState {
    fullmag_fem_data_residency source_of_truth =
        FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH;
    FemGpuSyncState host_state = FemGpuSyncState::HostClean;
    FemGpuSyncState device_state = FemGpuSyncState::HostStale;
};

} // namespace fullmag::fem
