/*
 * multilayer_create_v2_contract.cpp - native FDM v2 create contract.
 *
 * The v2 entrypoint must validate multilayer plans explicitly and report that
 * native multilayer execution is not implemented yet.  It must not silently
 * reinterpret a multilayer plan as the legacy single-grid ABI.
 */

#include "fullmag_fdm.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

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

fullmag_fdm_layer_desc_v2 make_layer(uint32_t index, const double *m) {
    fullmag_fdm_layer_desc_v2 layer{};
    layer.native_grid = {1, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    layer.convolution_grid = {1, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
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
    kernel.fft_grid = {1, 1, 1, 1.0e-9, 1.0e-9, 1.0e-9};
    kernel.dst_layer = dst_layer;
    kernel.src_layer = src_layer;
    kernel.kernel_xx = component;
    kernel.kernel_yy = component;
    kernel.kernel_zz = component;
    kernel.kernel_xy = component;
    kernel.kernel_xz = component;
    kernel.kernel_yz = component;
    kernel.kernel_len = 1;
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

void valid_plan_reports_unimplemented_execution() {
    if (fullmag_fdm_is_available() == 0) {
        std::printf("valid create_v2 upload check skipped: CUDA backend unavailable\n");
        return;
    }

    const double m0[3] = {1.0, 0.0, 0.0};
    const double m1[3] = {0.0, 1.0, 0.0};
    const fullmag_fdm_layer_desc_v2 layers[2] = {
        make_layer(0, m0),
        make_layer(1, m1),
    };
    const fullmag_fdm_complex64 kernel_component[1] = {{1.0, 0.0}};
    const fullmag_fdm_tensor_kernel_desc_v2 kernels[4] = {
        make_kernel(0, 0, kernel_component),
        make_kernel(0, 1, kernel_component),
        make_kernel(1, 0, kernel_component),
        make_kernel(1, 1, kernel_component),
    };
    fullmag_fdm_multilayer_plan_desc_v2 plan = make_plan(layers, 2);
    plan.enable_demag = 1;
    plan.kernels = kernels;
    plan.kernel_count = 4;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create_v2(&plan);
    check(handle != nullptr, "valid create_v2 plan should return an explicit unsupported handle");
    check_error_contains(handle, "uploaded 2 layers and 4 tensor kernels");
    check_error_contains(handle, "native multilayer CUDA execution is not implemented");
    fullmag_fdm_backend_destroy(handle);
}

} // namespace

int main() {
    invalid_plan_reports_validation_error();
    valid_plan_reports_unimplemented_execution();
    std::printf("multilayer create_v2 contract: PASS\n");
    return 0;
}
