/*
 * multilayer_effective_field.cu - Effective field assembly for staged FDM v2 layers.
 *
 * This owner assembles per-layer H_EFF from already-owned staged local fields.
 * The output uses the layer tmp scratch buffer, matching the single-grid
 * backend pattern where H_EFF is an observable scratch field, not persistent
 * solver state.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <limits>
#include <string>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

namespace {

constexpr int BLOCK_SIZE = 256;

template <typename Scalar>
__global__ void multilayer_effective_field_kernel(
    const Scalar *__restrict__ h_ex_x,
    const Scalar *__restrict__ h_ex_y,
    const Scalar *__restrict__ h_ex_z,
    const Scalar *__restrict__ h_demag_x,
    const Scalar *__restrict__ h_demag_y,
    const Scalar *__restrict__ h_demag_z,
    const Scalar *__restrict__ h_dmi_x,
    const Scalar *__restrict__ h_dmi_y,
    const Scalar *__restrict__ h_dmi_z,
    const Scalar *__restrict__ h_ani_x,
    const Scalar *__restrict__ h_ani_y,
    const Scalar *__restrict__ h_ani_z,
    const uint8_t *__restrict__ active_mask,
    Scalar *__restrict__ h_eff_x,
    Scalar *__restrict__ h_eff_y,
    Scalar *__restrict__ h_eff_z,
    uint64_t n,
    int has_external_field,
    double h_ext_x,
    double h_ext_y,
    double h_ext_z)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (active_mask && active_mask[idx] == 0) {
        h_eff_x[idx] = static_cast<Scalar>(0);
        h_eff_y[idx] = static_cast<Scalar>(0);
        h_eff_z[idx] = static_cast<Scalar>(0);
        return;
    }

    double hx = static_cast<double>(h_ex_x[idx]) +
                static_cast<double>(h_demag_x[idx]) +
                static_cast<double>(h_dmi_x[idx]) +
                static_cast<double>(h_ani_x[idx]);
    double hy = static_cast<double>(h_ex_y[idx]) +
                static_cast<double>(h_demag_y[idx]) +
                static_cast<double>(h_dmi_y[idx]) +
                static_cast<double>(h_ani_y[idx]);
    double hz = static_cast<double>(h_ex_z[idx]) +
                static_cast<double>(h_demag_z[idx]) +
                static_cast<double>(h_dmi_z[idx]) +
                static_cast<double>(h_ani_z[idx]);

    if (has_external_field) {
        hx += h_ext_x;
        hy += h_ext_y;
        hz += h_ext_z;
    }

    h_eff_x[idx] = static_cast<Scalar>(hx);
    h_eff_y[idx] = static_cast<Scalar>(hy);
    h_eff_z[idx] = static_cast<Scalar>(hz);
}

bool layer_launch_grid(Context &ctx, uint64_t n, const char *operation, int &grid)
{
    const uint64_t blocks = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    if (blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = std::string(operation) + ": CUDA grid dimension exceeds int range";
        return false;
    }
    grid = static_cast<int>(blocks);
    return true;
}

template <typename Scalar>
bool launch_multilayer_effective_field_impl(Context &ctx, const char *operation)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = std::string(operation) + " requires a staged v2 multilayer plan";
        return false;
    }
    if (!context_begin_compute_stream_work(ctx, operation)) {
        return false;
    }

    cudaStream_t stream = context_compute_stream(ctx);
    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        int grid = 0;
        if (!layer_launch_grid(ctx, layer.cell_count, operation, grid)) {
            context_end_compute_stream_work(ctx, operation);
            return false;
        }

        multilayer_effective_field_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.h_ex.x),
            static_cast<const Scalar *>(layer.h_ex.y),
            static_cast<const Scalar *>(layer.h_ex.z),
            static_cast<const Scalar *>(layer.h_demag.x),
            static_cast<const Scalar *>(layer.h_demag.y),
            static_cast<const Scalar *>(layer.h_demag.z),
            static_cast<const Scalar *>(layer.h_dmi.x),
            static_cast<const Scalar *>(layer.h_dmi.y),
            static_cast<const Scalar *>(layer.h_dmi.z),
            static_cast<const Scalar *>(layer.h_ani.x),
            static_cast<const Scalar *>(layer.h_ani.y),
            static_cast<const Scalar *>(layer.h_ani.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.tmp.x),
            static_cast<Scalar *>(layer.tmp.y),
            static_cast<Scalar *>(layer.tmp.z),
            layer.cell_count,
            ctx.has_external_field ? 1 : 0,
            ctx.external_field[0],
            ctx.external_field[1],
            ctx.external_field[2]);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        context_end_compute_stream_work(ctx, operation);
        return false;
    }
    if (!context_end_compute_stream_work(ctx, operation)) return false;
    fullmag_fdm_note_operator_device_execution(
        ctx, FULLMAG_FDM_OPERATOR_MULTILAYER_INTERACTIONS);
    if (ctx.has_external_field) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_EXTERNAL_FIELD);
    }
    if (ctx.has_active_mask || ctx.has_frozen_mask || ctx.has_region_mask) {
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_MASKS);
    }
    return true;
}

} // namespace

bool launch_multilayer_effective_field_fp64(Context &ctx)
{
    return launch_multilayer_effective_field_impl<double>(
        ctx,
        "launch_multilayer_effective_field_fp64");
}

bool launch_multilayer_effective_field_fp32(Context &ctx)
{
    return launch_multilayer_effective_field_impl<float>(
        ctx,
        "launch_multilayer_effective_field_fp32");
}

} // namespace fdm
} // namespace fullmag
