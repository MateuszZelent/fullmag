#include "gpu/cuda/runtime/multi_gpu_binding.hpp"

#include <cstdlib>

namespace fullmag::fem::gpu {

namespace {

int parse_env_int(const std::map<std::string, std::string>& env, const std::vector<std::string>& keys, int default_val = 0)
{
    for (const auto& key : keys) {
        auto it = env.find(key);
        if (it != env.end() && !it->second.empty()) {
            char* end = nullptr;
            long val = std::strtol(it->second.c_str(), &end, 10);
            if (end != it->second.c_str() && val >= 0) {
                return static_cast<int>(val);
            }
        }
    }
    return default_val;
}

} // namespace

GpuRankBinding resolve_gpu_rank_binding(
    const std::map<std::string, std::string>& env,
    const std::vector<std::string>& visible_devices
) {
    GpuRankBinding binding{};

    binding.world_rank = parse_env_int(env, {
        "OMPI_COMM_WORLD_RANK",
        "PMI_RANK",
        "MV2_COMM_WORLD_RANK",
        "RANK"
    }, 0);

    binding.local_rank = parse_env_int(env, {
        "OMPI_COMM_WORLD_LOCAL_RANK",
        "MPI_LOCALRANKID",
        "MV2_COMM_WORLD_LOCAL_RANK",
        "LOCAL_RANK",
        "PMI_LOCAL_RANK"
    }, 0);

    if (!visible_devices.empty()) {
        binding.device_ordinal = binding.local_rank % static_cast<int>(visible_devices.size());
        binding.device_uuid = visible_devices[binding.device_ordinal];
    } else {
        binding.device_ordinal = 0;
        binding.device_uuid = "GPU-default";
    }

    auto it_cuda_aware = env.find("FULLMAG_CUDA_AWARE_MPI");
    if (it_cuda_aware != env.end() && it_cuda_aware->second == "1") {
        binding.cuda_aware_mpi = true;
    }

    auto it_host_stage = env.find("FULLMAG_HOST_STAGING");
    if (it_host_stage != env.end() && it_host_stage->second == "1") {
        binding.host_staging_detected = true;
    }

    return binding;
}

MultiGpuPreflightResult preflight_multi_gpu(
    const GpuRankBinding& binding,
    bool forced_multi_gpu
) {
    MultiGpuPreflightResult res{};

    if (forced_multi_gpu) {
        if (!binding.cuda_aware_mpi) {
            res.passed = false;
            res.reason = "Forced multi-GPU requires CUDA-aware MPI transport; none detected";
            return res;
        }
        if (binding.host_staging_detected) {
            res.passed = false;
            res.reason = "Forced multi-GPU rejects host staging; direct device-to-device transport required";
            return res;
        }
    }

    res.passed = true;
    res.reason = "Multi-GPU preflight passed";
    return res;
}

} // namespace fullmag::fem::gpu
