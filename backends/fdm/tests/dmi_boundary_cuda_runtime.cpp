#include "fullmag_fdm.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern "C" int fullmag_fdm_test_inject_step_transaction_failure_once(
    fullmag_fdm_backend *handle,
    uint32_t phase);

namespace {

constexpr double MU0 = 4.0 * 3.141592653589793238462643383279502884e-7;

using Vec3 = std::array<double, 3>;

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

uint32_t neighbor(uint32_t coordinate, uint32_t count, int delta, bool periodic) {
    if (periodic) {
        return static_cast<uint32_t>(
            (static_cast<int64_t>(coordinate) + delta + count) % count);
    }
    if (delta < 0) return coordinate == 0 ? 0 : coordinate - 1;
    return coordinate + 1 == count ? coordinate : coordinate + 1;
}

std::vector<Vec3> dmi_oracle(
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    double dx,
    double dy,
    double dz,
    double ms,
    double d_interfacial,
    double d_bulk,
    bool periodic_x,
    bool periodic_y,
    bool periodic_z,
    const std::vector<uint8_t> &active,
    const std::vector<Vec3> &m)
{
    const uint64_t plane = static_cast<uint64_t>(nx) * ny;
    std::vector<Vec3> result(m.size(), Vec3{});
    for (uint64_t index = 0; index < m.size(); ++index) {
        if (active[index] == 0) continue;
        const uint32_t z = static_cast<uint32_t>(index / plane);
        const uint64_t remainder = index - static_cast<uint64_t>(z) * plane;
        const uint32_t y = static_cast<uint32_t>(remainder / nx);
        const uint32_t x = static_cast<uint32_t>(remainder - static_cast<uint64_t>(y) * nx);
        const auto flat = [=](uint32_t xx, uint32_t yy, uint32_t zz) {
            return static_cast<uint64_t>(zz) * plane + static_cast<uint64_t>(yy) * nx + xx;
        };
        uint64_t xm = flat(neighbor(x, nx, -1, periodic_x), y, z);
        uint64_t xp = flat(neighbor(x, nx, 1, periodic_x), y, z);
        uint64_t ym = flat(x, neighbor(y, ny, -1, periodic_y), z);
        uint64_t yp = flat(x, neighbor(y, ny, 1, periodic_y), z);
        uint64_t zm = flat(x, y, neighbor(z, nz, -1, periodic_z));
        uint64_t zp = flat(x, y, neighbor(z, nz, 1, periodic_z));
        const bool missing_xm = (!periodic_x && x == 0) || active[xm] == 0;
        const bool missing_xp = (!periodic_x && x + 1 == nx) || active[xp] == 0;
        const bool missing_ym = (!periodic_y && y == 0) || active[ym] == 0;
        const bool missing_yp = (!periodic_y && y + 1 == ny) || active[yp] == 0;
        const bool missing_zm = (!periodic_z && z == 0) || active[zm] == 0;
        const bool missing_zp = (!periodic_z && z + 1 == nz) || active[zp] == 0;
        if (missing_xm) xm = index;
        if (missing_xp) xp = index;
        if (missing_ym) ym = index;
        if (missing_yp) yp = index;
        if (missing_zm) zm = index;
        if (missing_zp) zp = index;

        Vec3 h{};
        const double prefactor = 2.0 / (MU0 * ms);
        if (d_interfacial != 0.0) {
            const double dmz_dx = (m[xp][2] - m[xm][2]) / (2.0 * dx);
            const double dmz_dy = (m[yp][2] - m[ym][2]) / (2.0 * dy);
            const double dmx_dx = (m[xp][0] - m[xm][0]) / (2.0 * dx);
            const double dmy_dy = (m[yp][1] - m[ym][1]) / (2.0 * dy);
            h[0] += prefactor * d_interfacial * dmz_dx;
            h[1] += prefactor * d_interfacial * dmz_dy;
            h[2] -= prefactor * d_interfacial * (dmx_dx + dmy_dy);
            const double qx = d_interfacial / (MU0 * ms * dx);
            const double qy = d_interfacial / (MU0 * ms * dy);
            if (missing_xp) { h[0] -= qx * m[index][2]; h[2] += qx * m[index][0]; }
            if (missing_xm) { h[0] += qx * m[index][2]; h[2] -= qx * m[index][0]; }
            if (missing_yp) { h[1] -= qy * m[index][2]; h[2] += qy * m[index][1]; }
            if (missing_ym) { h[1] += qy * m[index][2]; h[2] -= qy * m[index][1]; }
        }
        if (d_bulk != 0.0) {
            const double dmz_dy = (m[yp][2] - m[ym][2]) / (2.0 * dy);
            const double dmy_dz = (m[zp][1] - m[zm][1]) / (2.0 * dz);
            const double dmx_dz = (m[zp][0] - m[zm][0]) / (2.0 * dz);
            const double dmz_dx = (m[xp][2] - m[xm][2]) / (2.0 * dx);
            const double dmy_dx = (m[xp][1] - m[xm][1]) / (2.0 * dx);
            const double dmx_dy = (m[yp][0] - m[ym][0]) / (2.0 * dy);
            h[0] -= prefactor * d_bulk * (dmz_dy - dmy_dz);
            h[1] -= prefactor * d_bulk * (dmx_dz - dmz_dx);
            h[2] -= prefactor * d_bulk * (dmy_dx - dmx_dy);
            const double qx = d_bulk / (MU0 * ms * dx);
            const double qy = d_bulk / (MU0 * ms * dy);
            const double qz = d_bulk / (MU0 * ms * dz);
            if (missing_xp) { h[1] -= qx * m[index][2]; h[2] += qx * m[index][1]; }
            if (missing_xm) { h[1] += qx * m[index][2]; h[2] -= qx * m[index][1]; }
            if (missing_yp) { h[0] += qy * m[index][2]; h[2] -= qy * m[index][0]; }
            if (missing_ym) { h[0] -= qy * m[index][2]; h[2] += qy * m[index][0]; }
            if (missing_zp) { h[0] -= qz * m[index][1]; h[1] += qz * m[index][0]; }
            if (missing_zm) { h[0] += qz * m[index][1]; h[1] -= qz * m[index][0]; }
        }
        result[index] = h;
    }
    return result;
}

std::vector<double> flatten(const std::vector<Vec3> &values) {
    std::vector<double> flat(values.size() * 3);
    for (size_t i = 0; i < values.size(); ++i) {
        for (size_t component = 0; component < 3; ++component) {
            flat[3 * i + component] = values[i][component];
        }
    }
    return flat;
}

void compare_field(
    const std::vector<double> &actual,
    const std::vector<Vec3> &expected,
    double relative_tolerance,
    const char *label)
{
    double max_expected = 0.0;
    double max_error = 0.0;
    for (size_t i = 0; i < expected.size(); ++i) {
        for (size_t component = 0; component < 3; ++component) {
            max_expected = std::max(max_expected, std::fabs(expected[i][component]));
            max_error = std::max(
                max_error,
                std::fabs(actual[3 * i + component] - expected[i][component]));
        }
    }
    const double tolerance = std::max(1.0e-8, relative_tolerance * max_expected);
    if (max_error > tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s max_error=%.17g tolerance=%.17g max_expected=%.17g\n",
            label,
            max_error,
            tolerance,
            max_expected);
        std::exit(1);
    }
}

fullmag_fdm_execution_receipt_v2 receipt(fullmag_fdm_backend *backend) {
    fullmag_fdm_execution_receipt_v2 value{};
    value.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
    value.struct_size = sizeof(value);
    check(fullmag_fdm_backend_execution_receipt_v2(backend, &value) == FULLMAG_FDM_OK,
          "execution receipt query failed");
    std::printf(
        "receipt required=%llu executed_device=%llu executed_host=%llu executed_unknown=%llu backend=%d\n",
        static_cast<unsigned long long>(value.required_operator_mask),
        static_cast<unsigned long long>(value.executed_device_operator_mask),
        static_cast<unsigned long long>(value.executed_host_operator_mask),
        static_cast<unsigned long long>(value.executed_unknown_operator_mask),
        static_cast<int>(value.executed_backend));
    check(value.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM,
          "DMI qualification did not execute CUDA FDM");
    check(value.fallback_count == 0, "DMI qualification used a fallback");
    check(value.accounting_valid == 1, "DMI qualification accounting is invalid");
    static bool printed_device = false;
    if (!printed_device) {
        fullmag_fdm_device_info device{};
        check(fullmag_fdm_backend_get_device_info(backend, &device) == FULLMAG_FDM_OK,
              "DMI qualification device identity query failed");
        std::printf(
            "device=%s compute_capability=%d.%d driver=%d runtime=%d ordinal=%d\n",
            device.name,
            device.compute_capability_major,
            device.compute_capability_minor,
            device.driver_version,
            device.runtime_version,
            value.device_ordinal);
        printed_device = true;
    }
    return value;
}

fullmag_fdm_step_transaction_telemetry_v1 transaction_telemetry(
    fullmag_fdm_backend *backend)
{
    fullmag_fdm_step_transaction_telemetry_v1 value{};
    value.abi_version = FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    value.struct_size = sizeof(value);
    check(fullmag_fdm_backend_get_step_transaction_telemetry_v1(
              backend, &value) == FULLMAG_FDM_OK,
          "step transaction telemetry query failed");
    return value;
}

void verify_single_grid(
    fullmag_fdm_precision precision,
    bool bulk,
    bool periodic,
    const char *label)
{
    constexpr uint32_t nx = 3;
    constexpr uint32_t ny = 3;
    constexpr uint32_t nz = 3;
    constexpr double spacing = 2.0e-9;
    constexpr double ms = 8.0e5;
    constexpr double d = 2.0e-3;
    const size_t count = static_cast<size_t>(nx) * ny * nz;
    std::vector<uint8_t> active(count, 1);
    active[14] = 0;
    std::vector<Vec3> magnetization(count);
    for (size_t i = 0; i < count; ++i) {
        const double angle = 0.17 * static_cast<double>(i + 1);
        const double z = 0.35 + 0.01 * static_cast<double>(i % 5);
        const double xy = std::sqrt(1.0 - z * z);
        magnetization[i] = {xy * std::cos(angle), xy * std::sin(angle), z};
    }
    magnetization[14] = {};
    const auto expected = dmi_oracle(
        nx, ny, nz, spacing, spacing, spacing, ms,
        bulk ? 0.0 : d, bulk ? d : 0.0,
        periodic, periodic, periodic, active, magnetization);
    const auto m_flat = flatten(magnetization);

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, ny, nz, spacing, spacing, spacing};
    plan.material = {ms, 1.3e-11, 0.05, 2.211e5};
    plan.precision = precision;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.initial_magnetization_xyz = m_flat.data();
    plan.initial_magnetization_len = m_flat.size();
    plan.active_mask = active.data();
    plan.active_mask_len = active.size();
    plan.has_interfacial_dmi = bulk ? 0 : 1;
    plan.dmi_D_interfacial = bulk ? 0.0 : d;
    plan.has_bulk_dmi = bulk ? 1 : 0;
    plan.dmi_D_bulk = bulk ? d : 0.0;
    plan.periodic_x = periodic ? 1 : 0;
    plan.periodic_y = periodic ? 1 : 0;
    plan.periodic_z = periodic ? 1 : 0;
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;

    fullmag_fdm_backend *backend = fullmag_fdm_backend_create(&plan);
    check(backend != nullptr, "single-grid DMI backend create returned null");
    check(fullmag_fdm_backend_last_error(backend) == nullptr,
          "single-grid DMI backend create failed");
    std::vector<double> actual(count * 3);
    check(fullmag_fdm_backend_copy_field_f64(
              backend, FULLMAG_FDM_OBSERVABLE_H_EFF, actual.data(), actual.size()) ==
              FULLMAG_FDM_OK,
          "single-grid DMI H_eff copy failed");
    compare_field(actual, expected, precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2e-12 : 3e-5, label);
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(backend, 1.0e-15, &stats) == FULLMAG_FDM_OK,
          "single-grid DMI step failed");
    const auto execution = receipt(backend);
    check((execution.executed_device_operator_mask & FULLMAG_FDM_OPERATOR_DMI) != 0,
          "single-grid DMI operator was not recorded as device-executed");
    check(execution.hot_loop_full_vector_h2d_count == 0 &&
              execution.hot_loop_full_vector_d2h_count == 0 &&
              execution.hot_loop_host_compute_count == 0,
          "single-grid DMI step performed forbidden hot-loop host work or full transfer");
    fullmag_fdm_backend_destroy(backend);
}

void verify_multilayer(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator,
    const char *label)
{
    constexpr uint32_t nx = 3;
    constexpr uint32_t ny = 1;
    constexpr uint32_t nz = 1;
    constexpr double spacing = 2.0e-9;
    constexpr double ms = 8.0e5;
    constexpr double d = 2.0e-3;
    const std::vector<uint8_t> active = {1, 1, 0};
    const std::vector<Vec3> magnetization = {
        Vec3{0.6, 0.0, 0.8}, Vec3{0.0, 0.8, 0.6}, Vec3{0.0, 0.0, 0.0}};
    const auto expected = dmi_oracle(
        nx, ny, nz, spacing, spacing, spacing, ms, d, 0.0,
        false, false, false, active, magnetization);
    const auto m_flat = flatten(magnetization);

    fullmag_fdm_layer_desc_v2 layer{};
    layer.native_grid = {nx, ny, nz, spacing, spacing, spacing};
    layer.convolution_grid = layer.native_grid;
    layer.transfer_kind = FULLMAG_FDM_TRANSFER_IDENTITY;
    layer.material = {ms, 1.3e-11, 0.05, 2.211e5};
    layer.initial_magnetization_xyz = m_flat.data();
    layer.initial_magnetization_len = m_flat.size();
    layer.active_mask = active.data();
    layer.active_mask_len = active.size();
    std::array<fullmag_fdm_layer_desc_v2, 2> layers = {layer, layer};
    layers[1].layer_index = 1;

    fullmag_fdm_multilayer_plan_desc_v2 plan{};
    plan.kind = FULLMAG_FDM_PLAN_MULTILAYER_CONV;
    plan.precision = precision;
    plan.integrator = integrator;
    plan.has_interfacial_dmi = 1;
    plan.dmi_D_interfacial = d;
    plan.layers = layers.data();
    plan.layer_count = layers.size();
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;
    plan.stats_stride = 1;

    fullmag_fdm_backend *backend = fullmag_fdm_backend_create_v2(&plan);
    check(backend != nullptr, "multilayer DMI backend create returned null");
    const char *create_status = fullmag_fdm_backend_last_error(backend);
    check(create_status != nullptr && std::string(create_status).find("uploaded 2 layers") != std::string::npos,
          "multilayer DMI backend create failed");
    std::vector<double> actual(m_flat.size());
    check(fullmag_fdm_backend_copy_layer_field_f64(
              backend, 0, FULLMAG_FDM_OBSERVABLE_H_DMI, actual.data(), actual.size()) ==
              FULLMAG_FDM_OK,
          "multilayer DMI H_DMI copy failed");
    compare_field(
        actual,
        expected,
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2e-12 : 3e-5,
        label);
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(backend, 1.0e-15, &stats) == FULLMAG_FDM_OK,
          "multilayer DMI step failed");
    const auto execution = receipt(backend);
    check((execution.executed_device_operator_mask & FULLMAG_FDM_OPERATOR_DMI) != 0,
          "multilayer DMI operator was not recorded as device-executed");
    check(execution.hot_loop_full_vector_h2d_count == 0 &&
              execution.hot_loop_full_vector_d2h_count == 0 &&
              execution.hot_loop_host_compute_count == 0,
          "multilayer DMI step performed forbidden hot-loop host work or full transfer");
    check(fullmag_fdm_backend_copy_layer_field_f64(
              backend, 0, FULLMAG_FDM_OBSERVABLE_M,
              actual.data(), actual.size()) == FULLMAG_FDM_OK,
          "multilayer accepted magnetization copy failed");
    const auto accepted_m = actual;
    std::vector<double> accepted_m_second(m_flat.size());
    check(fullmag_fdm_backend_copy_layer_field_f64(
              backend, 1, FULLMAG_FDM_OBSERVABLE_M,
              accepted_m_second.data(), accepted_m_second.size()) == FULLMAG_FDM_OK,
          "second multilayer accepted magnetization copy failed");
    fullmag_fdm_backend_destroy(backend);

    const uint64_t scalar_bytes = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? sizeof(double) : sizeof(float);
    const uint64_t payload_bytes =
        layers.size() * layer.initial_magnetization_len * scalar_bytes;
    for (const uint32_t phase : {2U, 3U, 4U, 5U}) {
        auto *replayed = fullmag_fdm_backend_create_v2(&plan);
        check(replayed != nullptr, "multilayer transaction backend create returned null");
        const char *replay_status = fullmag_fdm_backend_last_error(replayed);
        check(replay_status != nullptr &&
                  std::string(replay_status).find("uploaded 2 layers") !=
                      std::string::npos,
              "multilayer transaction backend create failed");
        std::vector<double> before_failure(m_flat.size());
        check(fullmag_fdm_backend_copy_layer_field_f64(
                  replayed, 0, FULLMAG_FDM_OBSERVABLE_M,
                  before_failure.data(), before_failure.size()) == FULLMAG_FDM_OK,
              "multilayer pre-failure magnetization copy failed");
        std::vector<double> before_failure_second(m_flat.size());
        check(fullmag_fdm_backend_copy_layer_field_f64(
                  replayed, 1, FULLMAG_FDM_OBSERVABLE_M,
                  before_failure_second.data(), before_failure_second.size()) ==
                  FULLMAG_FDM_OK,
              "second multilayer pre-failure magnetization copy failed");
        check(fullmag_fdm_test_inject_step_transaction_failure_once(
                  replayed, phase) == FULLMAG_FDM_OK,
              "multilayer transaction fault setup failed");
        fullmag_fdm_step_stats failed_stats{};
        std::memset(&failed_stats, 0x5a, sizeof(failed_stats));
        const auto failed_stats_before = failed_stats;
        check(fullmag_fdm_backend_step(replayed, 1.0e-15, &failed_stats) ==
                  FULLMAG_FDM_ERR_CUDA,
              "multilayer injected fault did not fail the transaction");
        check(std::memcmp(
                  &failed_stats, &failed_stats_before, sizeof(failed_stats)) == 0,
              "failed multilayer transaction published caller step stats");
        std::vector<double> after_failure(m_flat.size());
        check(fullmag_fdm_backend_copy_layer_field_f64(
                  replayed, 0, FULLMAG_FDM_OBSERVABLE_M,
                  after_failure.data(), after_failure.size()) == FULLMAG_FDM_OK,
              "multilayer rolled-back magnetization copy failed");
        check(after_failure == before_failure,
              "failed multilayer transaction did not restore accepted magnetization exactly");
        std::vector<double> after_failure_second(m_flat.size());
        check(fullmag_fdm_backend_copy_layer_field_f64(
                  replayed, 1, FULLMAG_FDM_OBSERVABLE_M,
                  after_failure_second.data(), after_failure_second.size()) ==
                  FULLMAG_FDM_OK,
              "second multilayer rolled-back magnetization copy failed");
        check(after_failure_second == before_failure_second,
              "failed multilayer transaction did not restore the second layer exactly");
        const auto failed_transaction = transaction_telemetry(replayed);
        check(failed_transaction.accounting_valid == 1 &&
                  failed_transaction.capture_count == 1 &&
                  failed_transaction.rollback_count == 1 &&
                  failed_transaction.capture_d2d_bytes == payload_bytes &&
                  failed_transaction.rollback_d2d_bytes == payload_bytes &&
                  failed_transaction.accepted_step_index == 0 &&
                  failed_transaction.attempt_generation == 1,
              "failed multilayer transaction did not publish an exact D2D rollback receipt");
        fullmag_fdm_step_stats retry_stats{};
        check(fullmag_fdm_backend_step(replayed, 1.0e-15, &retry_stats) ==
                  FULLMAG_FDM_OK,
              "multilayer retry after rollback failed");
        std::vector<double> retried_m(m_flat.size());
        check(fullmag_fdm_backend_copy_layer_field_f64(
                  replayed, 0, FULLMAG_FDM_OBSERVABLE_M,
                  retried_m.data(), retried_m.size()) == FULLMAG_FDM_OK,
              "multilayer retried magnetization copy failed");
        check(retried_m == accepted_m,
              "multilayer retry did not reproduce the clean accepted step exactly");
        std::vector<double> retried_m_second(m_flat.size());
        check(fullmag_fdm_backend_copy_layer_field_f64(
                  replayed, 1, FULLMAG_FDM_OBSERVABLE_M,
                  retried_m_second.data(), retried_m_second.size()) == FULLMAG_FDM_OK,
              "second multilayer retried magnetization copy failed");
        check(retried_m_second == accepted_m_second,
              "multilayer retry did not reproduce the second clean layer exactly");
        const auto committed_transaction = transaction_telemetry(replayed);
        check(committed_transaction.capture_count == 2 &&
                  committed_transaction.rollback_count == 1 &&
                  committed_transaction.accepted_step_index == 1 &&
                  committed_transaction.attempt_generation == 2,
              "multilayer retry did not commit one accepted transaction");
        fullmag_fdm_backend_destroy(replayed);
    }
}

} // namespace

int main() {
    check(fullmag_fdm_is_available() != 0, "CUDA FDM backend is unavailable");
    verify_single_grid(FULLMAG_FDM_PRECISION_DOUBLE, false, false,
                       "single-grid iDMI fp64 open/mask boundary oracle");
    verify_single_grid(FULLMAG_FDM_PRECISION_SINGLE, false, false,
                       "single-grid iDMI fp32 open/mask boundary oracle");
    verify_single_grid(FULLMAG_FDM_PRECISION_DOUBLE, true, true,
                       "single-grid bulk DMI fp64 periodic/mask boundary oracle");
    verify_single_grid(FULLMAG_FDM_PRECISION_SINGLE, true, true,
                       "single-grid bulk DMI fp32 periodic/mask boundary oracle");
    for (const auto integrator : {FULLMAG_FDM_INTEGRATOR_HEUN,
                                  FULLMAG_FDM_INTEGRATOR_RK4,
                                  FULLMAG_FDM_INTEGRATOR_RK23}) {
        verify_multilayer(
            FULLMAG_FDM_PRECISION_DOUBLE,
            integrator,
            "multilayer iDMI fp64 boundary oracle");
        verify_multilayer(
            FULLMAG_FDM_PRECISION_SINGLE,
            integrator,
            "multilayer iDMI fp32 boundary oracle");
    }
    std::printf("FDM CUDA DMI boundary runtime qualification: PASS\n");
    return 0;
}
