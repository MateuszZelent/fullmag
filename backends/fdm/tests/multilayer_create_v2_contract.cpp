/*
 * multilayer_create_v2_contract.cpp - native FDM v2 create contract.
 *
 * The v2 entrypoint must validate multilayer plans explicitly and keep staged
 * multilayer execution out of the legacy single-grid ABI.
 */

#include "fullmag_fdm.h"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>

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

fullmag_fdm_plan_desc make_single_grid_plan(const double *m) {
    fullmag_fdm_plan_desc plan{};
    plan.grid = {1, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    plan.material = {800000.0, 1.3e-11, 0.02, 2.211e5};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.initial_magnetization_xyz = m;
    plan.initial_magnetization_len = 3;
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

void check_failed_before_workspace_setup(fullmag_fdm_backend *handle) {
    fullmag_fdm_gpu_workspace_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    check(
        fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(handle, &telemetry) ==
            FULLMAG_FDM_OK,
        "overflowed descriptor should expose fail-before-setup telemetry");
    check(telemetry.setup_complete == 0,
          "overflowed descriptor must fail before workspace setup completes");
    check(telemetry.total_device_allocation_count == 0 &&
              telemetry.total_fft_plan_creation_count == 0 &&
              telemetry.observed_step_count == 0,
          "overflowed descriptor must fail before allocations, plans, or steps");
}

void overflowed_single_grid_is_rejected_before_workspace_setup() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("overflowed single grid check skipped: CUDA backend unavailable\n");
        return;
    }

    const double dummy_m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc plan = make_single_grid_plan(dummy_m);
    plan.grid.nx = 1U << 31;
    plan.grid.ny = 1U << 31;
    plan.grid.nz = 4;
    plan.initial_magnetization_len = 0;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "overflowed single grid should return an error handle");
    check_error_contains(handle, "grid cell count overflows uint64_t");
    check_failed_before_workspace_setup(handle);
    fullmag_fdm_backend_destroy(handle);
}

void overflowed_fft_spectrum_is_rejected_before_workspace_setup() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("overflowed FFT spectrum check skipped: CUDA backend unavailable\n");
        return;
    }

    const double dummy_m[3] = {1.0, 0.0, 0.0};
    const double dummy_spectrum[2] = {0.0, 0.0};
    fullmag_fdm_plan_desc plan = make_single_grid_plan(dummy_m);
    plan.enable_demag = 1;
    plan.demag_fft_nx = 1U << 31;
    plan.demag_fft_ny = 1U << 31;
    plan.demag_fft_nz = 4;
    plan.demag_kernel_spectrum_len = 1;
    plan.demag_kernel_xx_spectrum = dummy_spectrum;
    plan.demag_kernel_yy_spectrum = dummy_spectrum;
    plan.demag_kernel_zz_spectrum = dummy_spectrum;
    plan.demag_kernel_xy_spectrum = dummy_spectrum;
    plan.demag_kernel_xz_spectrum = dummy_spectrum;
    plan.demag_kernel_yz_spectrum = dummy_spectrum;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "overflowed FFT spectrum should return an error handle");
    check_error_contains(handle, "demag FFT spectrum length overflows uint64_t");
    check_failed_before_workspace_setup(handle);
    fullmag_fdm_backend_destroy(handle);
}

void overflowed_grid_is_rejected_before_workspace_setup() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("overflowed grid check skipped: CUDA backend unavailable\n");
        return;
    }

    const double dummy_m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_layer_desc_v2 layer = make_layer(0, dummy_m);
    layer.native_grid.nx = 1U << 31;
    layer.native_grid.ny = 1U << 31;
    layer.native_grid.nz = 4;
    layer.initial_magnetization_len = 0;
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(&layer, 1);

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "overflowed grid should return an error handle");
    check_error_contains(handle, "layer native_grid cell count overflows uint64_t");

    check_failed_before_workspace_setup(handle);
    fullmag_fdm_backend_destroy(handle);
}

uint32_t oversized_fp64_cell_count() {
    size_t free_bytes = 0;
    size_t total_bytes = 0;
    check(cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess,
          "cudaMemGetInfo failed before device-memory preflight check");
    check(total_bytes > 0 && free_bytes <= total_bytes,
          "cudaMemGetInfo returned an invalid device-memory range");
    const uint64_t oversized_cells =
        static_cast<uint64_t>(free_bytes / sizeof(double)) + 1;
    check(oversized_cells > 0 && oversized_cells <= UINT32_MAX,
          "test device capacity cannot be represented by a one-dimensional FDM grid");
    return static_cast<uint32_t>(oversized_cells);
}

uint32_t aggregate_oversized_fp64_cell_count() {
    size_t free_bytes = 0;
    size_t total_bytes = 0;
    check(cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess,
          "cudaMemGetInfo failed before aggregate workspace preflight check");
    check(total_bytes > 0 && free_bytes <= total_bytes,
          "cudaMemGetInfo returned an invalid device-memory range");
    constexpr uint64_t minimum_safety_reserve =
        uint64_t{256} * 1024 * 1024;
    const uint64_t proportional_reserve =
        static_cast<uint64_t>(total_bytes) / 20;
    const uint64_t safety_reserve =
        std::max(minimum_safety_reserve, proportional_reserve);
    const uint64_t usable_bytes =
        static_cast<uint64_t>(free_bytes) > safety_reserve
            ? static_cast<uint64_t>(free_bytes) - safety_reserve
            : 0;
    check(usable_bytes > 64 * sizeof(double),
          "test device has no usable memory for aggregate workspace preflight");

    // One component consumes only one eighth of the usable device budget, so
    // the existing per-allocation preflight accepts it.  The minimal Heun
    // workspace owns at least 57 component-equivalents and cannot fit.
    const uint64_t oversized_cells =
        usable_bytes / (8 * sizeof(double));
    check(oversized_cells > 0 && oversized_cells <= UINT32_MAX,
          "aggregate test grid cannot be represented by a one-dimensional FDM grid");
    return static_cast<uint32_t>(oversized_cells);
}

class DeviceMemoryReserve {
public:
    ~DeviceMemoryReserve() {
        for (void *allocation : allocations_) {
            cudaFree(allocation);
        }
    }

    uint64_t reserve_until_usable_bytes(uint64_t target_usable_bytes) {
        constexpr uint64_t chunk_bytes = uint64_t{256} * 1024 * 1024;
        for (;;) {
            size_t free_bytes = 0;
            size_t total_bytes = 0;
            check(cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess,
                  "cudaMemGetInfo failed while reserving optional-preflight budget");
            const uint64_t safety_reserve = std::max(
                uint64_t{256} * 1024 * 1024,
                static_cast<uint64_t>(total_bytes) / 20);
            const uint64_t usable_bytes =
                static_cast<uint64_t>(free_bytes) > safety_reserve
                    ? static_cast<uint64_t>(free_bytes) - safety_reserve
                    : 0;
            if (usable_bytes <= target_usable_bytes) {
                return usable_bytes;
            }
            const uint64_t request = std::min(
                chunk_bytes, usable_bytes - target_usable_bytes);
            void *allocation = nullptr;
            check(cudaMalloc(&allocation, static_cast<size_t>(request)) == cudaSuccess,
                  "failed to reserve device memory for optional-preflight RED");
            allocations_.push_back(allocation);
        }
    }

private:
    std::vector<void *> allocations_;
};

void optional_demag_workspace_is_rejected_before_any_allocation() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("optional demag preflight check skipped: CUDA backend unavailable\n");
        return;
    }

    DeviceMemoryReserve reserve;
    const uint64_t usable_bytes = reserve.reserve_until_usable_bytes(
        uint64_t{512} * 1024 * 1024);
    check(usable_bytes > uint64_t{128} * 1024 * 1024,
          "test device has too little usable memory for optional-preflight RED");

    // The current mandatory Heun lower bound uses 456 bytes/cell in FP64.
    // Choosing one cell per 550 usable bytes leaves that lower bound below the
    // budget, while the mandatory demag FFT buffers and six spectra raise the
    // setup above it.  A complete aggregate preflight must reject before any
    // backend allocation or cuFFT plan is created.
    const uint64_t cell_count = usable_bytes / 550;
    check(cell_count > 0 && cell_count <= UINT32_MAX,
          "optional-preflight grid is not representable by the public ABI");
    std::vector<double> initial_m(static_cast<size_t>(3 * cell_count), 0.0);
    for (uint64_t index = 0; index < cell_count; ++index) {
        initial_m[static_cast<size_t>(3 * index)] = 1.0;
    }
    std::vector<double> spectrum(static_cast<size_t>(2 * cell_count), 0.0);

    fullmag_fdm_plan_desc plan = make_single_grid_plan(initial_m.data());
    plan.grid.nx = static_cast<uint32_t>(cell_count);
    plan.initial_magnetization_len = 3 * cell_count;
    plan.enable_demag = 1;
    plan.demag_fft_nx = static_cast<uint32_t>(cell_count);
    plan.demag_fft_ny = 1;
    plan.demag_fft_nz = 1;
    plan.demag_kernel_spectrum_len = 2 * cell_count;
    plan.demag_kernel_xx_spectrum = spectrum.data();
    plan.demag_kernel_yy_spectrum = spectrum.data();
    plan.demag_kernel_zz_spectrum = spectrum.data();
    plan.demag_kernel_xy_spectrum = spectrum.data();
    plan.demag_kernel_xz_spectrum = spectrum.data();
    plan.demag_kernel_yz_spectrum = spectrum.data();

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr,
          "optional demag oversized setup should return an error handle");
    check_error_contains(handle, "required_aggregate_workspace_bytes=");
    check_failed_before_workspace_setup(handle);
    fullmag_fdm_backend_destroy(handle);
}

void oversized_single_grid_allocation_is_rejected_by_memory_preflight() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("device-memory preflight check skipped: CUDA backend unavailable\n");
        return;
    }

    const uint32_t oversized_cells = oversized_fp64_cell_count();

    const double dummy_m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc plan = make_single_grid_plan(dummy_m);
    plan.grid.nx = oversized_cells;
    plan.initial_magnetization_len = static_cast<uint64_t>(oversized_cells) * 3;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr,
          "oversized setup allocation should return an error handle");
    check_error_contains(handle, "fdm_gpu_workspace_oom_preflight");
    check_error_contains(handle, "required_aggregate_workspace_bytes=");
    check_error_contains(handle, "usable_device_bytes=");
    check_failed_before_workspace_setup(handle);
    fullmag_fdm_backend_destroy(handle);
}

void oversized_multilayer_allocation_is_rejected_by_memory_preflight() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("multilayer device-memory preflight check skipped: CUDA backend unavailable\n");
        return;
    }

    const uint32_t oversized_cells = oversized_fp64_cell_count();
    const double dummy_m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_layer_desc_v2 layer = make_layer(0, dummy_m);
    layer.native_grid.nx = oversized_cells;
    layer.convolution_grid.nx = oversized_cells;
    layer.initial_magnetization_len =
        static_cast<uint64_t>(oversized_cells) * 3;
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(&layer, 1);

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr,
          "oversized multilayer setup allocation should return an error handle");
    check_error_contains(handle, "fdm_gpu_workspace_oom_preflight");
    check_error_contains(handle, "required_new_bytes=");
    check_error_contains(handle, "usable_device_bytes=");
    check_failed_before_workspace_setup(handle);
    fullmag_fdm_backend_destroy(handle);
}

void aggregate_single_grid_workspace_is_rejected_before_any_allocation() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("aggregate workspace preflight check skipped: CUDA backend unavailable\n");
        return;
    }

    const uint32_t oversized_cells = aggregate_oversized_fp64_cell_count();
    const double dummy_m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc plan = make_single_grid_plan(dummy_m);
    plan.grid.nx = oversized_cells;
    plan.initial_magnetization_len =
        static_cast<uint64_t>(oversized_cells) * 3;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr,
          "aggregate oversized setup should return an error handle");
    check_error_contains(handle, "fdm_gpu_workspace_oom_preflight");
    check_error_contains(handle, "required_aggregate_workspace_bytes=");
    check_failed_before_workspace_setup(handle);
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

void run_repeated_multilayer_demag_session() {
    const double m0[3] = {1.0, 0.0, 0.0};
    const fullmag_fdm_complex64 kernel_component[8] = {
        {1.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0},
        {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0},
    };
    fullmag_fdm_layer_desc_v2 layer = make_layer(0, m0);
    fullmag_fdm_tensor_kernel_desc_v2 kernel =
        make_kernel(0, 0, kernel_component);
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(&layer, 1);
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.kernels = &kernel;
    plan.kernel_count = 1;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "repeated create_v2 returned null");
    check_error_contains(handle, "prepared all FFT workspaces");
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, 1.0e-13, &stats) == FULLMAG_FDM_OK,
          "repeated create_v2 session step failed");
    fullmag_fdm_backend_destroy(handle);
}

void run_repeated_single_grid_session() {
    const double magnetization[12] = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    const double static_field[12] = {
        1.0e3, 0.0, 0.0,
        0.0, 1.0e3, 0.0,
        0.0, 0.0, 1.0e3,
        1.0e3, 1.0e3, 1.0e3,
    };
    fullmag_fdm_plan_desc plan = make_single_grid_plan(magnetization);
    plan.grid = {4, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    plan.initial_magnetization_len = 12;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "repeated single-grid create returned null");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "repeated single-grid create failed");
    check(fullmag_fdm_backend_set_static_external_field_f64(
              handle, static_field, 12) == FULLMAG_FDM_OK,
          "repeated single-grid setup profile failed");
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, 1.0e-13, &stats) == FULLMAG_FDM_OK,
          "repeated single-grid session step failed");
    fullmag_fdm_backend_destroy(handle);
}

uint64_t free_device_bytes() {
    check(cudaDeviceSynchronize() == cudaSuccess,
          "failed to synchronize before CUDA memory query");
    size_t free_bytes = 0;
    size_t total_bytes = 0;
    check(cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess,
          "cudaMemGetInfo failed during repeated-session qualification");
    check(total_bytes > 0 && free_bytes <= total_bytes,
          "cudaMemGetInfo returned an invalid device-memory range");
    return static_cast<uint64_t>(free_bytes);
}

void repeated_create_destroy_reclaims_cuda_workspace() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("repeated create/destroy check skipped: CUDA backend unavailable\n");
        return;
    }

    // Warm up module loading and allocator metadata before taking each baseline.
    run_repeated_single_grid_session();
    run_repeated_single_grid_session();
    const uint64_t single_grid_baseline_free_bytes = free_device_bytes();
    constexpr uint32_t session_count = 32;
    for (uint32_t session = 0; session < session_count; ++session) {
        run_repeated_single_grid_session();
    }
    const uint64_t single_grid_final_free_bytes = free_device_bytes();
    if (single_grid_final_free_bytes < single_grid_baseline_free_bytes) {
        std::fprintf(
            stderr,
            "FAIL: repeated single-grid create/destroy retained %llu device bytes after %u sessions\n",
            static_cast<unsigned long long>(
                single_grid_baseline_free_bytes - single_grid_final_free_bytes),
            session_count);
        std::exit(1);
    }

    run_repeated_multilayer_demag_session();
    run_repeated_multilayer_demag_session();
    const uint64_t baseline_free_bytes = free_device_bytes();
    for (uint32_t session = 0; session < session_count; ++session) {
        run_repeated_multilayer_demag_session();
    }
    const uint64_t final_free_bytes = free_device_bytes();
    if (final_free_bytes < baseline_free_bytes) {
        std::fprintf(
            stderr,
            "FAIL: repeated create/destroy retained %llu device bytes after %u sessions\n",
            static_cast<unsigned long long>(
                baseline_free_bytes - final_free_bytes),
            session_count);
        std::exit(1);
    }
    std::printf(
        "repeated create/destroy reclaimed single-grid and multilayer CUDA workspace across %u sessions each\n",
        session_count);
}

} // namespace

int main() {
    invalid_plan_reports_validation_error();
    invalid_transfer_kind_reports_validation_error();
    overflowed_single_grid_is_rejected_before_workspace_setup();
    overflowed_fft_spectrum_is_rejected_before_workspace_setup();
    overflowed_grid_is_rejected_before_workspace_setup();
    oversized_single_grid_allocation_is_rejected_by_memory_preflight();
    oversized_multilayer_allocation_is_rejected_by_memory_preflight();
    aggregate_single_grid_workspace_is_rejected_before_any_allocation();
    optional_demag_workspace_is_rejected_before_any_allocation();
    valid_plan_runs_heun_step_with_demag_and_exchange();
    valid_plan_runs_heun_step_without_demag();
    valid_plan_runs_fixed_step_rk23_without_demag();
    repeated_create_destroy_reclaims_cuda_workspace();
    std::printf("multilayer create_v2 contract: PASS\n");
    return 0;
}
