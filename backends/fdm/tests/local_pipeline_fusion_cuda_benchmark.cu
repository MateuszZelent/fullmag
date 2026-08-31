#include "fullmag_fdm.h"
#include "kernels.hpp"

#include <cuda_runtime.h>
#include <cuda_profiler_api.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace {

using fullmag::fdm::Context;
using fullmag::fdm::LocalPipelineKernelResources;

[[noreturn]] void fail(const char *message) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

void require(bool condition, const char *message) {
    if (!condition) fail(message);
}

const char *realization_name(
    fullmag_fdm_local_pipeline_realization_v1 realization)
{
    switch (realization) {
    case FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED:
        return "direct_fused";
    case FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED:
        return "direct_unfused";
    default:
        return "unexpected";
    }
}

} // namespace

int main(int argc, char **argv) {
    if (argc != 5) {
        std::fprintf(
            stderr,
            "usage: %s <cells> <measured-steps> <fused|unfused> <fp64|fp32>\n",
            argv[0]);
        return 2;
    }
    const uint64_t cell_count = std::stoull(argv[1]);
    const uint32_t measured_steps = static_cast<uint32_t>(std::stoul(argv[2]));
    const std::string mode = argv[3];
    const std::string precision_name = argv[4];
    require(cell_count > 0 &&
                cell_count <= std::numeric_limits<uint32_t>::max(),
            "cell count is outside the single-grid ABI range");
    require(measured_steps > 0, "measured step count must be positive");
    require(mode == "fused" || mode == "unfused", "invalid pipeline mode");
    require(precision_name == "fp64" || precision_name == "fp32",
            "invalid precision");
    const bool force_unfused = mode == "unfused";
    const auto precision = precision_name == "fp64"
        ? FULLMAG_FDM_PRECISION_DOUBLE
        : FULLMAG_FDM_PRECISION_SINGLE;
    constexpr uint32_t warmup_steps = 8;
    constexpr double dt = 2.5e-14;

    std::vector<double> magnetization(3 * cell_count, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        const double x = (cell & 1U) == 0 ? 0.8 : 0.6;
        const double y = (cell & 1U) == 0 ? 0.6 : -0.8;
        magnetization[3 * cell] = x;
        magnetization[3 * cell + 1] = y;
    }

    fullmag_fdm_plan_desc plan{};
    plan.grid = {
        static_cast<uint32_t>(cell_count), 1, 1, 2e-9, 2e-9, 2e-9};
    plan.material = {8.0e5, 0.0, 0.12, 2.211e5};
    plan.precision = precision;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[0] = 1.25e4;
    plan.external_field_am[2] = -0.5e4;
    plan.has_uniaxial_anisotropy = 1;
    plan.uniaxial_anisotropy_constant = 4.0e5;
    plan.uniaxial_anisotropy_k2 = 2.0e4;
    plan.anisotropy_axis[2] = 1.0;
    plan.has_magnetoelastic = 1;
    plan.mel_b1 = -3.4e6;
    plan.mel_b2 = 7.8e6;
    plan.mel_strain[0] = 1.0e-4;
    plan.mel_strain[1] = -0.5e-4;
    plan.mel_strain[5] = 0.25e-4;
    plan.initial_magnetization_xyz = magnetization.data();
    plan.initial_magnetization_len = magnetization.size();
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;

    auto *handle = fullmag_fdm_backend_create(&plan);
    require(handle != nullptr, "benchmark backend creation returned null");
    require(fullmag_fdm_backend_last_error(handle) == nullptr,
            "benchmark backend creation failed");
    auto *context = reinterpret_cast<Context *>(handle);
    context->adaptive_enabled = false;
    context->local_pipeline_force_unfused_for_testing = force_unfused;

    fullmag_fdm_step_stats stats{};
    for (uint32_t step = 0; step < warmup_steps; ++step) {
        require(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
                "benchmark warmup step failed");
    }

    const bool profile_range =
        std::getenv("FULLMAG_FDM_BENCHMARK_PROFILE_RANGE") != nullptr;
    if (profile_range) {
        require(cudaProfilerStart() == cudaSuccess,
                "benchmark profiler range start failed");
    }

    cudaEvent_t start = nullptr;
    cudaEvent_t stop = nullptr;
    require(cudaEventCreate(&start) == cudaSuccess &&
                cudaEventCreate(&stop) == cudaSuccess,
            "benchmark CUDA event creation failed");
    require(cudaEventRecord(start) == cudaSuccess,
            "benchmark start event record failed");
    for (uint32_t step = 0; step < measured_steps; ++step) {
        require(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
                "benchmark measured step failed");
    }
    require(cudaEventRecord(stop) == cudaSuccess &&
                cudaEventSynchronize(stop) == cudaSuccess,
            "benchmark stop event failed");
    float elapsed_ms = 0.0f;
    require(cudaEventElapsedTime(&elapsed_ms, start, stop) == cudaSuccess,
            "benchmark elapsed-time query failed");
    if (profile_range) {
        require(cudaProfilerStop() == cudaSuccess,
                "benchmark profiler range stop failed");
    }
    cudaEventDestroy(stop);
    cudaEventDestroy(start);

    fullmag_fdm_local_pipeline_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_LOCAL_PIPELINE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_local_pipeline_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "benchmark telemetry query failed");
    const uint64_t total_steps = warmup_steps + measured_steps;
    const uint64_t expected_stage_count = 2 * total_steps;
    const auto expected_realization = force_unfused
        ? FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED
        : FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED;
    require(telemetry.accounting_valid == 1 &&
                telemetry.requested_policy ==
                    FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE &&
                telemetry.resolved_realization == expected_realization &&
                telemetry.executed_realization == expected_realization,
            "benchmark requested/resolved/executed realization mismatch");
    if (force_unfused) {
        require(telemetry.direct_fused_field_rhs_launch_count == 0 &&
                    telemetry.direct_unfused_effective_field_launch_count ==
                        expected_stage_count &&
                    telemetry.direct_unfused_rhs_launch_count ==
                        expected_stage_count,
                "benchmark unfused launch count mismatch");
    } else {
        require(telemetry.direct_fused_field_rhs_launch_count ==
                    expected_stage_count &&
                    telemetry.direct_unfused_effective_field_launch_count == 0 &&
                    telemetry.direct_unfused_rhs_launch_count == 0,
                "benchmark fused launch count mismatch");
    }

    require(fullmag_fdm_backend_copy_field_f64(
                handle,
                FULLMAG_FDM_OBSERVABLE_M,
                magnetization.data(),
                magnetization.size()) == FULLMAG_FDM_OK,
            "benchmark final magnetization readback failed");
    double checksum = 0.0;
    for (size_t index = 0; index < magnetization.size(); ++index) {
        checksum += magnetization[index] * static_cast<double>((index % 17) + 1);
    }
    require(std::isfinite(checksum), "benchmark final checksum is non-finite");
    fullmag_fdm_device_info device{};
    require(fullmag_fdm_backend_get_device_info(handle, &device) == FULLMAG_FDM_OK,
            "benchmark device identity query failed");
    LocalPipelineKernelResources kernel_resources{};
    const cudaError_t resource_status = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? fullmag::fdm::query_local_pipeline_kernel_resources_fp64(
              &kernel_resources)
        : fullmag::fdm::query_local_pipeline_kernel_resources_fp32(
              &kernel_resources);
    require(resource_status == cudaSuccess,
            "benchmark fused-kernel resource query failed");

    const double ns_per_step =
        static_cast<double>(elapsed_ms) * 1.0e6 / measured_steps;
    std::printf(
        "{\"schema\":\"fullmag.fdm_gpu.local_pipeline_benchmark.v1\","
        "\"cells\":%llu,\"warmup_steps\":%u,\"measured_steps\":%u,"
        "\"precision\":\"%s\",\"requested_policy\":\"auto_safe\","
        "\"resolved_realization\":\"%s\",\"executed_realization\":\"%s\","
        "\"fused_launches\":%llu,\"unfused_field_launches\":%llu,"
        "\"unfused_rhs_launches\":%llu,\"elapsed_ms\":%.9g,"
        "\"ns_per_step\":%.17g,\"checksum\":%.17g,"
        "\"device\":\"%s\",\"compute_capability\":\"%d.%d\","
        "\"kernel_resources_schema\":"
        "\"fullmag.fdm_gpu.local_pipeline_kernel_resources.v1\","
        "\"kernel_block_threads\":%u,"
        "\"kernel_registers_per_thread\":%u,"
        "\"kernel_static_shared_bytes\":%llu,"
        "\"kernel_local_bytes_per_thread\":%llu,"
        "\"kernel_max_active_blocks_per_sm\":%u,"
        "\"kernel_max_threads_per_sm\":%u,"
        "\"kernel_multiprocessor_count\":%u,"
        "\"kernel_theoretical_occupancy_permyriad\":%u}\n",
        static_cast<unsigned long long>(cell_count),
        warmup_steps,
        measured_steps,
        precision_name.c_str(),
        realization_name(telemetry.resolved_realization),
        realization_name(telemetry.executed_realization),
        static_cast<unsigned long long>(
            telemetry.direct_fused_field_rhs_launch_count),
        static_cast<unsigned long long>(
            telemetry.direct_unfused_effective_field_launch_count),
        static_cast<unsigned long long>(telemetry.direct_unfused_rhs_launch_count),
        static_cast<double>(elapsed_ms),
        ns_per_step,
        checksum,
        device.name,
        device.compute_capability_major,
        device.compute_capability_minor,
        kernel_resources.block_threads,
        kernel_resources.registers_per_thread,
        static_cast<unsigned long long>(kernel_resources.static_shared_bytes),
        static_cast<unsigned long long>(kernel_resources.local_bytes_per_thread),
        kernel_resources.max_active_blocks_per_sm,
        kernel_resources.max_threads_per_sm,
        kernel_resources.multiprocessor_count,
        kernel_resources.theoretical_occupancy_permyriad);
    fullmag_fdm_backend_destroy(handle);
    return 0;
}
