#include "fullmag_fdm.h"
#include "../gpu/cuda/runtime/step_transaction_controller.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

extern "C" int fullmag_fdm_test_inject_step_transaction_failure_once(
    fullmag_fdm_backend *handle,
    uint32_t phase);

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fullmag_fdm_endpoint_cache_telemetry_v1 telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_endpoint_cache_telemetry_v1 result{};
    result.abi_version = FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1;
    result.struct_size = sizeof(result);
    check(
        fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(handle, &result) ==
            FULLMAG_FDM_OK,
        "endpoint cache telemetry query failed");
    return result;
}

void qualify_integrator(
    fullmag_fdm_integrator integrator,
    uint64_t expected_field_evaluations)
{
    constexpr uint32_t nx = 4;
    constexpr uint32_t ny = 4;
    constexpr uint32_t nz = 1;
    constexpr uint64_t cell_count = nx * ny * nz;
    const uint32_t fft_nx = nx * 2;
    const uint32_t fft_ny = ny * 2;
    const uint32_t fft_nz = nz;
    const uint64_t fft_cell_count =
        static_cast<uint64_t>(fft_nx) * fft_ny * fft_nz;

    std::vector<double> magnetization(cell_count * 3, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        magnetization[3 * cell] = 1.0;
    }
    std::array<std::vector<double>, 6> kernel;
    for (auto &component : kernel) component.assign(fft_cell_count * 2, 0.0);
    for (uint64_t frequency = 0; frequency < fft_cell_count; ++frequency) {
        kernel[0][2 * frequency] = 1.0;
        kernel[1][2 * frequency] = 1.0;
        kernel[2][2 * frequency] = 1.0;
    }

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, ny, nz, 2e-9, 2e-9, 2e-9};
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.5;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = integrator;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.has_external_field = 1;
    plan.external_field_am[2] = 1e4;
    plan.initial_magnetization_xyz = magnetization.data();
    plan.initial_magnetization_len = magnetization.size();
    plan.demag_kernel_xx_spectrum = kernel[0].data();
    plan.demag_kernel_yy_spectrum = kernel[1].data();
    plan.demag_kernel_zz_spectrum = kernel[2].data();
    plan.demag_kernel_xy_spectrum = kernel[3].data();
    plan.demag_kernel_xz_spectrum = kernel[4].data();
    plan.demag_kernel_yz_spectrum = kernel[5].data();
    plan.demag_kernel_spectrum_len = fft_cell_count * 2;
    plan.demag_fft_nx = fft_nx;
    plan.demag_fft_ny = fft_ny;
    plan.demag_fft_nz = fft_nz;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    plan.stats_stride = 1;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "endpoint cache backend creation returned null");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "endpoint cache backend creation failed");

    const auto before = telemetry(handle);
    fullmag_fdm_step_stats step_stats{};
    check(fullmag_fdm_backend_step(handle, 1e-14, &step_stats) == FULLMAG_FDM_OK,
          "endpoint cache integrator step failed");
    const auto after_step = telemetry(handle);
    check(after_step.cache_identity_valid == 1, "accepted cache identity is invalid");
    check(after_step.stats_valid == 1, "accepted full stats were not published");
    check(after_step.demag_evaluation_count - before.demag_evaluation_count ==
              expected_field_evaluations,
          "unexpected demag evaluations per accepted step");
    check(after_step.demag_forward_fft_count - before.demag_forward_fft_count ==
              expected_field_evaluations,
          "unexpected forward FFT count per accepted step");
    check(after_step.demag_inverse_fft_count - before.demag_inverse_fft_count ==
              expected_field_evaluations,
          "unexpected inverse FFT count per accepted step");
    check(after_step.exchange_evaluation_count - before.exchange_evaluation_count ==
              expected_field_evaluations,
          "unexpected exchange evaluations per accepted step");
    check(after_step.effective_field_evaluation_count -
              before.effective_field_evaluation_count == expected_field_evaluations,
          "unexpected effective-field evaluations per accepted step");
    check(after_step.last_step_demag_evaluation_count == expected_field_evaluations,
          "last-step demag telemetry is inconsistent");
    check(after_step.last_step_demag_forward_fft_count == expected_field_evaluations,
          "last-step forward FFT telemetry is inconsistent");
    check(after_step.last_step_energy_reduction_count >= 6,
          "full stats did not account for energy reductions");

    fullmag_fdm_step_stats snapshot_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &snapshot_stats) == FULLMAG_FDM_OK,
          "cached stats snapshot failed");
    const auto after_stats = telemetry(handle);
    check(after_stats.demag_evaluation_count == after_step.demag_evaluation_count,
          "stats snapshot reran demag for a fresh accepted endpoint");
    check(after_stats.energy_reduction_count == after_step.energy_reduction_count,
          "stats snapshot reran energy reductions for cached full stats");
    check(after_stats.stats_snapshot_cache_hit_count ==
              after_step.stats_snapshot_cache_hit_count + 1,
          "stats snapshot did not report a cache hit");

    fullmag_fdm_field_snapshot *field_snapshot =
        fullmag_fdm_backend_begin_field_snapshot(
            handle, FULLMAG_FDM_OBSERVABLE_H_EFF);
    check(field_snapshot != nullptr, "H_eff field snapshot creation failed");
    const void *field_data = nullptr;
    uint64_t field_bytes = 0;
    fullmag_fdm_snapshot_desc field_desc{};
    check(fullmag_fdm_field_snapshot_wait(
              field_snapshot, &field_data, &field_bytes, &field_desc) == FULLMAG_FDM_OK,
          "H_eff field snapshot wait failed");
    check(field_data != nullptr && field_bytes == cell_count * 3 * sizeof(double),
          "H_eff field snapshot payload is invalid");
    fullmag_fdm_field_snapshot_destroy(field_snapshot);
    const auto after_field = telemetry(handle);
    check(after_field.demag_evaluation_count == after_step.demag_evaluation_count,
          "H_eff snapshot reran demag for a fresh accepted endpoint");
    check(after_field.field_snapshot_request_count ==
              after_step.field_snapshot_request_count + 1,
          "field snapshot request was not accounted");
    check(after_field.field_snapshot_latency_total_ns > 0,
          "field snapshot latency was not accounted");

    fullmag_fdm_stats_policy_v1 invalid_policy{};
    invalid_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1 + 1;
    invalid_policy.struct_size = sizeof(invalid_policy);
    invalid_policy.mode = FULLMAG_FDM_STATS_FULL;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &invalid_policy) ==
              FULLMAG_FDM_ERR_INVALID,
          "stats policy accepted an incompatible ABI version");

    fullmag_fdm_stats_policy_v1 requested_policy{};
    requested_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    requested_policy.struct_size = sizeof(requested_policy);
    requested_policy.mode = FULLMAG_FDM_STATS_REQUESTED;
    requested_policy.stride = 7;
    requested_policy.quantity_mask = FULLMAG_FDM_STATS_QUANTITY_E_DEMAG;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &requested_policy) ==
              FULLMAG_FDM_OK,
          "requested stats policy setup failed");
    const auto before_requested_stats = telemetry(handle);
    fullmag_fdm_step_stats requested_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &requested_stats) ==
              FULLMAG_FDM_OK,
          "requested demag-energy snapshot failed");
    const auto after_requested_stats = telemetry(handle);
    check(after_requested_stats.demag_evaluation_count ==
              before_requested_stats.demag_evaluation_count,
          "requested demag energy reran a fresh demag field");
    check(after_requested_stats.energy_reduction_count ==
              before_requested_stats.energy_reduction_count + 1,
          "requested demag energy did not execute exactly one energy reduction");
    check(requested_stats.exchange_energy_joules == 0.0 &&
              requested_stats.external_energy_joules == 0.0 &&
              requested_stats.total_energy_joules == 0.0,
          "requested demag energy populated unrequested quantities");

    fullmag_fdm_stats_policy_v1 control_policy{};
    control_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    control_policy.struct_size = sizeof(control_policy);
    control_policy.mode = FULLMAG_FDM_STATS_CONTROL;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &control_policy) ==
              FULLMAG_FDM_OK,
          "control stats policy setup failed");
    const auto before_control_stats = telemetry(handle);
    fullmag_fdm_step_stats control_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &control_stats) ==
              FULLMAG_FDM_OK,
          "control stats snapshot failed");
    const auto after_control_stats = telemetry(handle);
    check(after_control_stats.demag_evaluation_count ==
              before_control_stats.demag_evaluation_count,
          "control stats reran demag for fresh endpoint fields");
    check(after_control_stats.energy_reduction_count ==
              before_control_stats.energy_reduction_count,
          "control stats executed an energy reduction");
    check(control_stats.total_energy_joules == 0.0,
          "control stats populated full energy diagnostics");

    fullmag_fdm_stats_policy_v1 full_policy{};
    full_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    full_policy.struct_size = sizeof(full_policy);
    full_policy.mode = FULLMAG_FDM_STATS_FULL;
    full_policy.stride = 1;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &full_policy) ==
              FULLMAG_FDM_OK,
          "full stats policy restore failed");

    std::vector<double> static_field(cell_count * 3, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        static_field[3 * cell + 1] = 2e4;
    }
    check(fullmag_fdm_backend_set_static_external_field_f64(
              handle, static_field.data(), static_field.size()) == FULLMAG_FDM_OK,
          "static field revision update failed");
    const auto after_source_change = telemetry(handle);
    check(after_source_change.cache_identity_valid == 0,
          "static field revision did not invalidate the cache identity");
    check(fullmag_fdm_backend_snapshot_stats(handle, &snapshot_stats) == FULLMAG_FDM_OK,
          "stats refresh after source revision failed");
    const auto after_source_refresh = telemetry(handle);
    check(after_source_refresh.cache_identity_valid == 1,
          "source revision refresh did not publish the new cache identity");
    check(after_source_refresh.demag_evaluation_count ==
              after_field.demag_evaluation_count + 1,
          "source revision refresh did not recompute demag exactly once");

    const uint64_t accepted_revision = after_source_refresh.accepted_state_revision;
    check(fullmag_fdm_test_inject_step_transaction_failure_once(
              handle,
              static_cast<uint32_t>(
                  fullmag::fdm::StepTransactionPhase::FinalStats)) ==
              FULLMAG_FDM_OK,
          "endpoint cache fault injection setup failed");
    fullmag_fdm_step_stats failed_stats{};
    check(fullmag_fdm_backend_step(handle, 1e-14, &failed_stats) ==
              FULLMAG_FDM_ERR_CUDA,
          "injected endpoint cache transaction did not fail");
    const auto after_failed_attempt = telemetry(handle);
    check(after_failed_attempt.cache_identity_valid == 1,
          "failed attempt left an invalid accepted cache identity");
    check(after_failed_attempt.accepted_state_revision == accepted_revision,
          "failed attempt published a trial state revision");
    check(after_failed_attempt.stats_valid == 0,
          "failed attempt published trial endpoint statistics");

    fullmag_fdm_backend_destroy(handle);
}

} // namespace

int main() {
    if (!fullmag_fdm_is_available()) {
        std::puts("SKIP: CUDA device unavailable");
        return 0;
    }
    qualify_integrator(FULLMAG_FDM_INTEGRATOR_HEUN, 3);
    qualify_integrator(FULLMAG_FDM_INTEGRATOR_RK4, 5);
    qualify_integrator(FULLMAG_FDM_INTEGRATOR_RK23, 4);
    qualify_integrator(FULLMAG_FDM_INTEGRATOR_DP45, 7);
    std::puts("PASS: endpoint cache CUDA runtime contract");
    return 0;
}
