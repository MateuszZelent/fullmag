#include "gpu/cuda/runtime/multi_gpu_binding.hpp"

#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void test_rank_to_device_binding()
{
    using namespace fullmag::fem::gpu;

    std::vector<std::string> visible_devices = {
        "GPU-11111111-2222-3333-4444-555555555555",
        "GPU-66666666-7777-8888-9999-000000000000",
        "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "GPU-ffffffff-0000-1111-2222-333333333333"
    };

    // Test rank 0 (local rank 0)
    {
        std::map<std::string, std::string> env = {
            {"OMPI_COMM_WORLD_RANK", "0"},
            {"OMPI_COMM_WORLD_LOCAL_RANK", "0"},
            {"OMPI_COMM_WORLD_SIZE", "4"}
        };
        auto binding = resolve_gpu_rank_binding(env, visible_devices);
        check(binding.world_rank == 0, "world_rank should be 0");
        check(binding.local_rank == 0, "local_rank should be 0");
        check(binding.device_ordinal == 0, "device_ordinal should be 0");
        check(binding.device_uuid == visible_devices[0], "device_uuid should match visible_devices[0]");
    }

    // Test rank 2 (local rank 2)
    {
        std::map<std::string, std::string> env = {
            {"MPI_LOCALRANKID", "2"},
            {"PMI_RANK", "2"}
        };
        auto binding = resolve_gpu_rank_binding(env, visible_devices);
        check(binding.world_rank == 2, "world_rank should be 2");
        check(binding.local_rank == 2, "local_rank should be 2");
        check(binding.device_ordinal == 2, "device_ordinal should be 2");
        check(binding.device_uuid == visible_devices[2], "device_uuid should match visible_devices[2]");
    }

    // Test wrap-around when more local ranks than devices: local rank 5 with 4 devices -> device 1
    {
        std::map<std::string, std::string> env = {
            {"LOCAL_RANK", "5"},
            {"RANK", "5"}
        };
        auto binding = resolve_gpu_rank_binding(env, visible_devices);
        check(binding.world_rank == 5, "world_rank should be 5");
        check(binding.local_rank == 5, "local_rank should be 5");
        check(binding.device_ordinal == 1, "device_ordinal should be 5 % 4 = 1");
        check(binding.device_uuid == visible_devices[1], "device_uuid should match visible_devices[1]");
        check(!binding.device_uuid.empty(), "device_uuid must not be empty");
    }
}

void test_fail_closed_preflight()
{
    using namespace fullmag::fem::gpu;

    // Normal binding with CUDA-aware MPI and no host staging
    GpuRankBinding good_binding{0, 0, 0, "GPU-uuid-1", true, false};
    auto good_res = preflight_multi_gpu(good_binding, true);
    check(good_res.passed, "Preflight should pass when CUDA-aware MPI is available and no host staging");

    // Lack of CUDA-aware MPI under forced multi-GPU must fail closed
    GpuRankBinding no_cuda_aware{0, 0, 0, "GPU-uuid-1", false, false};
    auto fail_res1 = preflight_multi_gpu(no_cuda_aware, true);
    check(!fail_res1.passed, "Preflight must fail closed when CUDA-aware MPI is missing under forced multi-GPU");

    // Detected host staging under forced multi-GPU must fail closed
    GpuRankBinding host_staging{0, 0, 0, "GPU-uuid-1", true, true};
    auto fail_res2 = preflight_multi_gpu(host_staging, true);
    check(!fail_res2.passed, "Preflight must fail closed when host staging is detected under forced multi-GPU");

    // Not forced: does not fail closed, but records non-CUDA-aware
    auto non_forced_res = preflight_multi_gpu(no_cuda_aware, false);
    check(non_forced_res.passed, "Preflight should pass in permissive mode when not forced");
}

} // namespace

int main()
{
    test_rank_to_device_binding();
    test_fail_closed_preflight();

    std::printf("gpu_multi_gpu_binding_contract: all tests passed\n");
    return 0;
}
