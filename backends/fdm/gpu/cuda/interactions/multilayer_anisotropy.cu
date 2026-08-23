/*
 * multilayer_anisotropy.cu - Layer-local anisotropy field for staged FDM v2 layers.
 *
 * This owner mirrors the staged v2 RHS anisotropy equations so per-layer H_ANI
 * observables can be copied without rebuilding a full effective field.
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
constexpr double MU0 = 4.0 * 3.141592653589793238462643383279502884 * 1.0e-7;

template <typename Scalar>
__global__ void multilayer_anisotropy_field_kernel(
    const Scalar *__restrict__ mx,
    const Scalar *__restrict__ my,
    const Scalar *__restrict__ mz,
    const uint8_t *__restrict__ active_mask,
    Scalar *__restrict__ hx,
    Scalar *__restrict__ hy,
    Scalar *__restrict__ hz,
    uint64_t n,
    double ms,
    int has_uniaxial_anisotropy,
    double ku1,
    double ku2,
    double anis_u_x,
    double anis_u_y,
    double anis_u_z,
    int has_cubic_anisotropy,
    double kc1,
    double kc2,
    double kc3,
    double cubic_axis1_x,
    double cubic_axis1_y,
    double cubic_axis1_z,
    double cubic_axis2_x,
    double cubic_axis2_y,
    double cubic_axis2_z)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if ((active_mask && active_mask[idx] == 0) ||
        ms <= 0.0 ||
        (!has_uniaxial_anisotropy && !has_cubic_anisotropy))
    {
        hx[idx] = static_cast<Scalar>(0);
        hy[idx] = static_cast<Scalar>(0);
        hz[idx] = static_cast<Scalar>(0);
        return;
    }

    const double m0 = static_cast<double>(mx[idx]);
    const double m1 = static_cast<double>(my[idx]);
    const double m2 = static_cast<double>(mz[idx]);
    double h0 = 0.0;
    double h1 = 0.0;
    double h2 = 0.0;

    if (has_uniaxial_anisotropy) {
        const double m_dot_u = m0 * anis_u_x + m1 * anis_u_y + m2 * anis_u_z;
        const double term =
            (2.0 / (MU0 * ms)) *
            (ku1 * m_dot_u + 2.0 * ku2 * m_dot_u * m_dot_u * m_dot_u);
        h0 += term * anis_u_x;
        h1 += term * anis_u_y;
        h2 += term * anis_u_z;
    }

    if (has_cubic_anisotropy) {
        const double c3x = cubic_axis1_y * cubic_axis2_z - cubic_axis1_z * cubic_axis2_y;
        const double c3y = cubic_axis1_z * cubic_axis2_x - cubic_axis1_x * cubic_axis2_z;
        const double c3z = cubic_axis1_x * cubic_axis2_y - cubic_axis1_y * cubic_axis2_x;

        const double mc1 = m0 * cubic_axis1_x + m1 * cubic_axis1_y + m2 * cubic_axis1_z;
        const double mc2 = m0 * cubic_axis2_x + m1 * cubic_axis2_y + m2 * cubic_axis2_z;
        const double mc3 = m0 * c3x + m1 * c3y + m2 * c3z;
        const double m1sq = mc1 * mc1;
        const double m2sq = mc2 * mc2;
        const double m3sq = mc3 * mc3;
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
        const double pf = -2.0 / (MU0 * ms);

        const double g1 =
            pf * (kc1 * mc1 * (m2sq + m3sq) +
                  kc2 * mc1 * m2sq * m3sq +
                  2.0 * kc3 * sigma * mc1 * (m2sq + m3sq));
        const double g2 =
            pf * (kc1 * mc2 * (m1sq + m3sq) +
                  kc2 * m1sq * mc2 * m3sq +
                  2.0 * kc3 * sigma * mc2 * (m1sq + m3sq));
        const double g3 =
            pf * (kc1 * mc3 * (m1sq + m2sq) +
                  kc2 * m1sq * m2sq * mc3 +
                  2.0 * kc3 * sigma * mc3 * (m1sq + m2sq));

        h0 += g1 * cubic_axis1_x + g2 * cubic_axis2_x + g3 * c3x;
        h1 += g1 * cubic_axis1_y + g2 * cubic_axis2_y + g3 * c3y;
        h2 += g1 * cubic_axis1_z + g2 * cubic_axis2_z + g3 * c3z;
    }

    hx[idx] = static_cast<Scalar>(h0);
    hy[idx] = static_cast<Scalar>(h1);
    hz[idx] = static_cast<Scalar>(h2);
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
bool launch_multilayer_anisotropy_field_impl(Context &ctx, const char *operation)
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

        multilayer_anisotropy_field_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.m.x),
            static_cast<const Scalar *>(layer.m.y),
            static_cast<const Scalar *>(layer.m.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.h_ani.x),
            static_cast<Scalar *>(layer.h_ani.y),
            static_cast<Scalar *>(layer.h_ani.z),
            layer.cell_count,
            layer.material.saturation_magnetisation,
            layer.has_uniaxial_anisotropy ? 1 : 0,
            layer.Ku1,
            layer.Ku2,
            layer.anisU[0],
            layer.anisU[1],
            layer.anisU[2],
            layer.has_cubic_anisotropy ? 1 : 0,
            layer.Kc1,
            layer.Kc2,
            layer.Kc3,
            layer.cubic_axis1[0],
            layer.cubic_axis1[1],
            layer.cubic_axis1[2],
            layer.cubic_axis2[0],
            layer.cubic_axis2[1],
            layer.cubic_axis2[2]);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        context_end_compute_stream_work(ctx, operation);
        return false;
    }
    if (!context_end_compute_stream_work(ctx, operation)) return false;
    if (ctx.has_uniaxial_anisotropy || ctx.has_cubic_anisotropy) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_ANISOTROPY);
    }
    return true;
}

} // namespace

bool launch_multilayer_anisotropy_field_fp64(Context &ctx)
{
    return launch_multilayer_anisotropy_field_impl<double>(
        ctx,
        "launch_multilayer_anisotropy_field_fp64");
}

bool launch_multilayer_anisotropy_field_fp32(Context &ctx)
{
    return launch_multilayer_anisotropy_field_impl<float>(
        ctx,
        "launch_multilayer_anisotropy_field_fp32");
}

} // namespace fdm
} // namespace fullmag
