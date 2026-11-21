#include "fullmag_fdm.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fullmag_fdm_endpoint_cache_telemetry_v1 endpoint_cache_telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_endpoint_cache_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    check(fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(handle, &telemetry) ==
              FULLMAG_FDM_OK,
          "endpoint cache telemetry query failed");
    return telemetry;
}

void accepted_endpoint_dt_survives_snapshot_and_cache_paths() {
    constexpr double initial_dt = 1.0e-13;
    constexpr double accepted_dt = 1.0e-14;
    static const double initial_magnetization[3] = {1.0, 0.0, 0.0};
    static const uint8_t active_mask[1] = {1};

    fullmag_fdm_plan_desc plan{};
    plan.grid = {1, 1, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    plan.material = {8.0e5, 1.0e-30, 0.1, 2.211e5};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.has_external_field = 1;
    plan.external_field_am[2] = 2.0e4;
    plan.initial_magnetization_xyz = initial_magnetization;
    plan.initial_magnetization_len = 3;
    plan.active_mask = active_mask;
    plan.active_mask_len = 1;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    plan.stats_stride = 1;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "dt snapshot backend creation returned null");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "dt snapshot backend creation failed");

    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &stats) == FULLMAG_FDM_OK,
          "initial endpoint stats snapshot failed");
    check(stats.step == 0 && stats.time_seconds == 0.0,
          "initial endpoint stats reported a stepped state");
    check(stats.dt_seconds == initial_dt,
          "initial endpoint stats did not report current_dt");

    static const double initial_static_field[3] = {0.0, 0.0, 2.0e4};
    check(fullmag_fdm_backend_set_static_external_field_f64(
              handle, initial_static_field, 3) == FULLMAG_FDM_OK,
          "initial static field profile setup failed");

    check(fullmag_fdm_backend_step(handle, accepted_dt, &stats) == FULLMAG_FDM_OK,
          "single accepted CUDA step failed");
    check(stats.step == 1 && stats.time_seconds == accepted_dt,
          "accepted step stats reported the wrong endpoint");
    check(stats.dt_seconds == accepted_dt,
          "accepted step stats did not report the staged accepted dt");

    const auto after_step = endpoint_cache_telemetry(handle);
    check(after_step.stats_valid == 1,
          "accepted step did not publish cacheable endpoint stats");
    fullmag_fdm_step_stats cached_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &cached_stats) == FULLMAG_FDM_OK,
          "cached endpoint stats snapshot failed");
    check(cached_stats.dt_seconds == accepted_dt,
          "cached endpoint stats lost the accepted dt");
    const auto after_cached_snapshot = endpoint_cache_telemetry(handle);
    check(after_cached_snapshot.stats_snapshot_cache_hit_count ==
              after_step.stats_snapshot_cache_hit_count + 1,
          "endpoint stats snapshot did not use the cache");

    static const double changed_external_field[3] = {0.0, 1.0e4, 0.0};
    check(fullmag_fdm_backend_set_static_external_field_f64(
              handle, changed_external_field, 3) == FULLMAG_FDM_OK,
          "endpoint source revision update failed");
    fullmag_fdm_step_stats refreshed_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &refreshed_stats) == FULLMAG_FDM_OK,
          "uncached endpoint stats refresh failed");
    check(refreshed_stats.step == 1 && refreshed_stats.time_seconds == accepted_dt,
          "uncached endpoint refresh reported the wrong accepted state");
    check(refreshed_stats.dt_seconds == accepted_dt,
          "uncached endpoint refresh lost current_dt");
    const auto after_uncached_snapshot = endpoint_cache_telemetry(handle);
    check(after_uncached_snapshot.stats_snapshot_cache_hit_count ==
              after_cached_snapshot.stats_snapshot_cache_hit_count,
          "source revision refresh unexpectedly reused endpoint stats");

    fullmag_fdm_backend_destroy(handle);
}

} // namespace

int main() {
    if (!fullmag_fdm_is_available()) {
        std::puts("SKIP: CUDA device unavailable");
        return 0;
    }
    accepted_endpoint_dt_survives_snapshot_and_cache_paths();
    std::puts("PASS: FDM CUDA accepted endpoint dt snapshot contract");
    return 0;
}
