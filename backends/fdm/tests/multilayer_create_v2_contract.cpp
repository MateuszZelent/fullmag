/*
 * multilayer_create_v2_contract.cpp - native FDM v2 create contract.
 *
 * The v2 entrypoint must validate multilayer plans explicitly and keep staged
 * multilayer execution out of the legacy single-grid ABI.
 */

#include "fullmag_fdm.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_error_contains(fullmag_fdm_backend *handle, const char *needle) {
    const char *message = fullmag_fdm_backend_last_error(handle);
    check(message != nullptr, "expected create_v2 to expose a last_error message");
    check(std::strstr(message, needle) != nullptr, message);
}

void check_close(double actual, double expected, double tolerance, const char *msg) {
    if (std::fabs(actual - expected) > tolerance) {
        std::fprintf(stderr, "FAIL: %s (actual=%g expected=%g)\n", msg, actual, expected);
        std::exit(1);
    }
}

fullmag_fdm_layer_desc_v2 make_layer(uint32_t index, const double *m) {
    fullmag_fdm_layer_desc_v2 layer{};
    layer.native_grid = {1, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    layer.convolution_grid = {1, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    layer.transfer_kind = FULLMAG_FDM_TRANSFER_IDENTITY;
    layer.layer_index = index;
    layer.z_offset_cells = static_cast<int32_t>(index);
    layer.material = {800000.0, 1.3e-11, 0.02, 2.211e5};
    layer.initial_magnetization_xyz = m;
    layer.initial_magnetization_len = 3;
    return layer;
}

fullmag_fdm_multilayer_plan_desc_v2 make_plan(
    const fullmag_fdm_layer_desc_v2 *layers,
    uint32_t layer_count)
{
    fullmag_fdm_multilayer_plan_desc_v2 plan{};
    plan.kind = FULLMAG_FDM_PLAN_MULTILAYER_CONV;
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.layers = layers;
    plan.layer_count = layer_count;
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;
    plan.stats_stride = 1;
    return plan;
}

fullmag_fdm_tensor_kernel_desc_v2 make_kernel(
    uint32_t dst_layer,
    uint32_t src_layer,
    const fullmag_fdm_complex64 *component)
{
    fullmag_fdm_tensor_kernel_desc_v2 kernel{};
    kernel.fft_grid = {2, 2, 2, 1.0e-9, 1.0e-9, 1.0e-9};
    kernel.dst_layer = dst_layer;
    kernel.src_layer = src_layer;
    kernel.kernel_xx = component;
    kernel.kernel_yy = component;
    kernel.kernel_zz = component;
    kernel.kernel_xy = component;
    kernel.kernel_xz = component;
    kernel.kernel_yz = component;
    kernel.kernel_len = 8;
    return kernel;
}

void invalid_plan_reports_validation_error() {
    fullmag_fdm_multilayer_plan_desc_v2 plan{};
    plan.kind = FULLMAG_FDM_PLAN_MULTILAYER_CONV;
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "invalid create_v2 plan should return an error handle");
    check_error_contains(handle, "layer_count must be greater than zero");
    fullmag_fdm_backend_destroy(handle);
}

void invalid_transfer_kind_reports_validation_error() {
    const double m0[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_layer_desc_v2 layer = make_layer(0, m0);
    layer.transfer_kind = static_cast<fullmag_fdm_transfer_kind>(999);
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(&layer, 1);

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "invalid transfer_kind should return an error handle");
    check_error_contains(handle, "unknown layer transfer_kind in v2 plan");
    fullmag_fdm_backend_destroy(handle);
}

void valid_plan_runs_heun_step_with_demag_and_exchange() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("valid create_v2 upload check skipped: CUDA backend unavailable\n");
        return;
    }

    const double m0[3] = {1.0, 0.0, 0.0};
    const double m1[3] = {0.0, 1.0, 0.0};
    fullmag_fdm_layer_desc_v2 layers[2] = {
        make_layer(0, m0),
        make_layer(1, m1),
    };
    // Force the assisted push/pull realization so distinct FFT grids remain
    // legal and every cached workspace is exercised in one public step.
    layers[0].transfer_kind = FULLMAG_FDM_TRANSFER_PUSH_PULL;
    layers[0].has_uniaxial_anisotropy = 1;
    layers[0].uniaxial_anisotropy_constant = 4.0e4;
    layers[0].anisotropy_axis[0] = 1.0;
    layers[0].anisotropy_axis[1] = 0.0;
    layers[0].anisotropy_axis[2] = 0.0;
    const fullmag_fdm_complex64 kernel_component[8] = {
        {1.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0},
        {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0},
    };
    fullmag_fdm_complex64 large_kernel_component[27] = {};
    large_kernel_component[0] = {1.0, 0.0};
    fullmag_fdm_tensor_kernel_desc_v2 kernels[4] = {
        make_kernel(0, 0, kernel_component),
        make_kernel(0, 1, kernel_component),
        make_kernel(1, 0, kernel_component),
        make_kernel(1, 1, large_kernel_component),
    };
    kernels[3].fft_grid = {3, 3, 3, 1.0e-9, 1.0e-9, 1.0e-9};
    kernels[3].kernel_len = 27;
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(layers, 2);
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.has_external_field = 1;
    plan.external_field_am[0] = 1.5e3;
    plan.external_field_am[1] = -2.0e3;
    plan.external_field_am[2] = 7.5e2;
    plan.has_interfacial_dmi = 1;
    plan.dmi_D_interfacial = 2.0e-3;
    plan.kernels = kernels;
    plan.kernel_count = 4;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "valid create_v2 plan should return a staged v2 handle");
    check_error_contains(handle, "uploaded 2 layers and 4 tensor kernels");
    check_error_contains(handle, "native Heun/RK4/fixed-step RK23 timestep with optional demag and layer-local exchange is available");

    fullmag_fdm_gpu_workspace_telemetry_v1 setup_telemetry{};
    setup_telemetry.abi_version =
        FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    setup_telemetry.struct_size = sizeof(setup_telemetry);
    check(
        fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
            handle, &setup_telemetry) == FULLMAG_FDM_OK,
        "GPU workspace telemetry should be available after create_v2");
    check(setup_telemetry.accounting_valid == 1,
          "GPU workspace accounting should be valid after create_v2");
    check(setup_telemetry.setup_complete == 1,
          "GPU workspace setup should be complete before the first stage");
    check(setup_telemetry.prepared_fft_workspace_count >= 2,
          "heterogeneous FFT grids should prepare at least two workspaces");
    check(setup_telemetry.setup_fft_plan_creation_count >= 2,
          "heterogeneous FFT grids should create every plan during setup");
    check(setup_telemetry.total_fft_plan_creation_count ==
              setup_telemetry.setup_fft_plan_creation_count,
          "all FFT plans should be setup-time plans after create_v2");
    check(setup_telemetry.step_device_allocation_count == 0 &&
              setup_telemetry.step_fft_plan_creation_count == 0,
          "no step-time allocation or plan should exist before stepping");
    check(setup_telemetry.workspace_bytes > 0 &&
              setup_telemetry.peak_vram_bytes >= setup_telemetry.workspace_bytes,
          "workspace footprint telemetry should report live and peak bytes");

    double h_ani[3] = {};
    const int h_ani_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_ANI,
        h_ani,
        3);
    check(h_ani_status == FULLMAG_FDM_OK, "copy layer H_ANI should succeed for anisotropy-enabled v2 multilayer handles");
    const double mu0 = 4.0 * 3.141592653589793238462643383279502884 * 1.0e-7;
    const double expected_h_ani_x =
        2.0 * layers[0].uniaxial_anisotropy_constant /
        (mu0 * layers[0].material.saturation_magnetisation);
    check_close(h_ani[0], expected_h_ani_x, expected_h_ani_x * 1e-10, "copy layer H_ANI should return the staged uniaxial field");
    check_close(h_ani[1], 0.0, 1e-12, "copy layer H_ANI y should remain zero for x-axis anisotropy");
    check_close(h_ani[2], 0.0, 1e-12, "copy layer H_ANI z should remain zero for x-axis anisotropy");

    double h_eff[3] = {};
    const int h_eff_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_EFF,
        h_eff,
        3);
    check(h_eff_status == FULLMAG_FDM_OK, "copy layer H_EFF should succeed for v2 multilayer handles");
    check_close(
        h_eff[0],
        expected_h_ani_x + plan.external_field_am[0],
        expected_h_ani_x * 1e-10,
        "copy layer H_EFF x should include staged H_ANI and H_EXT");
    check_close(
        h_eff[1],
        plan.external_field_am[1],
        1e-12,
        "copy layer H_EFF y should include staged H_EXT");
    check_close(
        h_eff[2],
        plan.external_field_am[2],
        1e-12,
        "copy layer H_EFF z should include staged H_EXT");

    const int refresh_status = fullmag_fdm_backend_refresh_multilayer_demag(handle);
    check(
        refresh_status == FULLMAG_FDM_OK,
        "explicit v2 multilayer demag refresh should succeed for staged handles");

    fullmag_fdm_gpu_workspace_telemetry_v1 refresh_telemetry{};
    refresh_telemetry.abi_version =
        FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    refresh_telemetry.struct_size = sizeof(refresh_telemetry);
    check(
        fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
            handle, &refresh_telemetry) == FULLMAG_FDM_OK,
        "GPU workspace telemetry should remain available after demag refresh");
    check(refresh_telemetry.total_device_allocation_count ==
              setup_telemetry.total_device_allocation_count &&
              refresh_telemetry.total_fft_plan_creation_count ==
                  setup_telemetry.total_fft_plan_creation_count,
          "demag refresh must reuse setup-time allocations and FFT plans");

    fullmag_fdm_step_stats stats{};
    const int step_status = fullmag_fdm_backend_step(handle, 1.0e-13, &stats);
    check(step_status == FULLMAG_FDM_OK, "v2 multilayer Heun step with exchange should succeed");
    check(stats.step == 1, "v2 multilayer Heun step should advance step metadata");
    check(stats.time_seconds > 0.0, "v2 multilayer Heun step should advance time metadata");

    fullmag_fdm_gpu_workspace_telemetry_v1 step_telemetry{};
    step_telemetry.abi_version =
        FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    step_telemetry.struct_size = sizeof(step_telemetry);
    check(
        fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
            handle, &step_telemetry) == FULLMAG_FDM_OK,
        "GPU workspace telemetry should remain available after a step");
    check(step_telemetry.accounting_valid == 1,
          "GPU workspace accounting should remain valid after a step");
    check(step_telemetry.total_device_allocation_count ==
              setup_telemetry.total_device_allocation_count &&
              step_telemetry.total_device_allocation_bytes ==
                  setup_telemetry.total_device_allocation_bytes,
          "the public step must not allocate device memory");
    check(step_telemetry.total_fft_plan_creation_count ==
              setup_telemetry.total_fft_plan_creation_count,
          "the public step must not create FFT plans");
    check(step_telemetry.step_device_allocation_count == 0 &&
              step_telemetry.step_device_allocation_bytes == 0 &&
              step_telemetry.step_fft_plan_creation_count == 0,
          "step-local allocation and plan counters must stay zero");
    check(step_telemetry.observed_step_count == 1,
          "workspace telemetry should observe exactly one public step");

    double h_demag[3] = {};
    const int h_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_DEMAG,
        h_demag,
        3);
    check(h_status == FULLMAG_FDM_OK, "copy layer H_DEMAG should succeed after demag refresh");

    double h_ex[3] = {};
    const int h_ex_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_EX,
        h_ex,
        3);
    check(h_ex_status == FULLMAG_FDM_OK, "copy layer H_EX should succeed after Heun step");

    double h_dmi[3] = {};
    const int h_dmi_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_DMI,
        h_dmi,
        3);
    check(h_dmi_status == FULLMAG_FDM_OK, "copy layer H_DMI should succeed for DMI-enabled v2 multilayer handles");

    double h_ext[3] = {};
    const int h_ext_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_EXT,
        h_ext,
        3);
    check(h_ext_status == FULLMAG_FDM_OK, "copy layer H_EXT should succeed for external-field v2 multilayer handles");
    check(
        h_ext[0] == plan.external_field_am[0] &&
            h_ext[1] == plan.external_field_am[1] &&
            h_ext[2] == plan.external_field_am[2],
        "copy layer H_EXT should return the staged uniform external field");

    double m_copy[3] = {};
    const int m_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_M,
        m_copy,
        3);
    check(m_status == FULLMAG_FDM_OK, "copy layer M should succeed for v2 multilayer handles");
    fullmag_fdm_backend_destroy(handle);
}

void valid_plan_runs_heun_step_without_demag() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("non-demag create_v2 step check skipped: CUDA backend unavailable\n");
        return;
    }

    const double m0[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_layer_desc_v2 layer = make_layer(0, m0);
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(&layer, 1);
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[1] = 1.0e3;
    plan.kernels = nullptr;
    plan.kernel_count = 0;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "valid non-demag create_v2 plan should return a staged v2 handle");
    check_error_contains(handle, "native Heun/RK4/fixed-step RK23 timestep with optional demag and layer-local exchange is available");

    fullmag_fdm_step_stats stats{};
    const int step_status = fullmag_fdm_backend_step(handle, 1.0e-13, &stats);
    check(step_status == FULLMAG_FDM_OK, "v2 multilayer Heun step without demag should succeed");
    check(stats.step == 1, "non-demag v2 multilayer Heun step should advance step metadata");

    double h_demag[3] = {1.0, 1.0, 1.0};
    const int h_status = fullmag_fdm_backend_copy_layer_field_f64(
        handle,
        0,
        FULLMAG_FDM_OBSERVABLE_H_DEMAG,
        h_demag,
        3);
    check(h_status == FULLMAG_FDM_OK, "copy layer H_DEMAG should succeed for non-demag v2 handles");
    check_close(h_demag[0], 0.0, 1e-12, "non-demag v2 H_DEMAG x should remain zero");
    check_close(h_demag[1], 0.0, 1e-12, "non-demag v2 H_DEMAG y should remain zero");
    check_close(h_demag[2], 0.0, 1e-12, "non-demag v2 H_DEMAG z should remain zero");

    fullmag_fdm_backend_destroy(handle);
}

void valid_plan_runs_fixed_step_rk23_without_demag() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("fixed-step RK23 create_v2 step check skipped: CUDA backend unavailable\n");
        return;
    }

    const double m0[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_layer_desc_v2 layer = make_layer(0, m0);
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(&layer, 1);
    plan.integrator = FULLMAG_FDM_INTEGRATOR_RK23;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[1] = 1.0e3;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "valid fixed-step RK23 plan should return a staged v2 handle");

    fullmag_fdm_step_stats stats{};
    const int step_status = fullmag_fdm_backend_step(handle, 1.0e-13, &stats);
    check(step_status == FULLMAG_FDM_OK, "v2 multilayer fixed-step RK23 should succeed");
    check(stats.step == 1, "v2 multilayer fixed-step RK23 should advance step metadata");
    check(stats.time_seconds > 0.0, "v2 multilayer fixed-step RK23 should advance time metadata");

    fullmag_fdm_backend_destroy(handle);
}

} // namespace

int main() {
    invalid_plan_reports_validation_error();
    invalid_transfer_kind_reports_validation_error();
    valid_plan_runs_heun_step_with_demag_and_exchange();
    valid_plan_runs_heun_step_without_demag();
    valid_plan_runs_fixed_step_rk23_without_demag();
    std::printf("multilayer create_v2 contract: PASS\n");
    return 0;
}
