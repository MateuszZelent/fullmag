#pragma once

#include <map>
#include <string>
#include <vector>

namespace fullmag::fem::gpu {

struct GpuRankBinding {
    int world_rank{0};
    int local_rank{0};
    int device_ordinal{0};
    std::string device_uuid;
    bool cuda_aware_mpi{false};
    bool host_staging_detected{false};
};

struct MultiGpuPreflightResult {
    bool passed{false};
    std::string reason;
};

GpuRankBinding resolve_gpu_rank_binding(
    const std::map<std::string, std::string>& env,
    const std::vector<std::string>& visible_devices
);

MultiGpuPreflightResult preflight_multi_gpu(
    const GpuRankBinding& binding,
    bool forced_multi_gpu
);

} // namespace fullmag::fem::gpu
