/*
 * GPU CUDA RK Oersted field accumulation source contract.
 *
 * This source owns time-dependent Oersted scaling and scaled H_oe accumulation
 * into H_eff for the device-resident RK RHS. It does not own generic H_eff
 * composition, local-field generation, LLG RHS evaluation, RK step scheduling,
 * final statistics, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_oersted_field.hpp"

#include "context.hpp"
#include "gpu/cuda/interactions/oersted/oersted_kernels.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <string>

namespace fullmag::fem {

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

double gpu_rk_oersted_scale(const Context &ctx)
{
    if (!ctx.oersted.has_cylinder) {
        return 1.0;
    }
    double scale = ctx.oersted.current;
    switch (ctx.oersted.time_dep_kind) {
        case 1:
            scale *= std::sin(
                         2.0 * kPi * ctx.oersted.time_dep_freq * ctx.state.current_time +
                         ctx.oersted.time_dep_phase) +
                     ctx.oersted.time_dep_offset;
            break;
        case 2:
            scale *= (ctx.state.current_time >= ctx.oersted.time_dep_t_on &&
                      ctx.state.current_time < ctx.oersted.time_dep_t_off)
                         ? 1.0
                         : 0.0;
            break;
        default:
            break;
    }
    return scale;
}

} // namespace

bool gpu_rk_accumulate_oersted_field(
    Context &ctx,
    cudaStream_t stream,
    int n,
    std::string &reason)
{
    if (!ctx.oersted.has_cylinder && !ctx.oersted.has_explicit_field) {
        return true;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.fields.h_oe.x == nullptr || gpu.fields.h_oe.y == nullptr || gpu.fields.h_oe.z == nullptr) {
        reason = "GPU RK Oersted field requires device-resident H_oe buffers";
        return false;
    }
    const double scale = gpu_rk_oersted_scale(ctx);
    fullmag_cuda_add_scaled_field_inplace(gpu.fields.h_oe.x, gpu.fields.h_eff.x, scale, n, stream);
    fullmag_cuda_add_scaled_field_inplace(gpu.fields.h_oe.y, gpu.fields.h_eff.y, scale, n, stream);
    fullmag_cuda_add_scaled_field_inplace(gpu.fields.h_oe.z, gpu.fields.h_eff.z, scale, n, stream);
    return cuda_launch_ok("launch GPU RK Oersted h_eff accumulation", reason);
}

} // namespace fullmag::fem
