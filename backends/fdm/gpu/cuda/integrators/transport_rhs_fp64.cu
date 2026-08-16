#include "context.hpp"

#include <cuda_runtime.h>

#include <cmath>

namespace fullmag::fdm {
namespace {

__global__ void add_gpu_transport_torque_fp64_kernel(
    const double *mx,
    const double *my,
    const double *mz,
    const double *tx,
    const double *ty,
    const double *tz,
    double *rhs_x,
    double *rhs_y,
    double *rhs_z,
    uint64_t cells,
    double alpha)
{
    const uint64_t cell = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
    if (cell >= cells) return;
    const double m0 = mx[cell];
    const double m1 = my[cell];
    const double m2 = mz[cell];
    const double t0 = tx[cell];
    const double t1 = ty[cell];
    const double t2 = tz[cell];
    const double cross0 = m1 * t2 - m2 * t1;
    const double cross1 = m2 * t0 - m0 * t2;
    const double cross2 = m0 * t1 - m1 * t0;
    const double inverse_gilbert = 1.0 / (1.0 + alpha * alpha);
    rhs_x[cell] += (t0 + alpha * cross0) * inverse_gilbert;
    rhs_y[cell] += (t1 + alpha * cross1) * inverse_gilbert;
    rhs_z[cell] += (t2 + alpha * cross2) * inverse_gilbert;
}

} // namespace

bool launch_add_gpu_transport_torque_fp64(
    Context &ctx,
    const DeviceVectorField &m_stage,
    DeviceVectorField &rhs)
{
    if (!ctx.gpu_transport_rhs.active) return true;
    if (!context_begin_compute_stream_work(ctx, "GPU transport torque RHS"))
        return false;
    const DeviceVectorField &torque = ctx.gpu_transport_rhs.torque_view;
    const uint32_t blocks = static_cast<uint32_t>((ctx.cell_count + 255) / 256);
    const bool inject_launch_failure =
        ctx.gpu_transport_test_completion_fault == 1;
    cudaError_t launch_status = cudaSuccess;
    if (!inject_launch_failure) {
        add_gpu_transport_torque_fp64_kernel<<<
            blocks, 256, 0, context_compute_stream(ctx)>>>(
            static_cast<const double *>(m_stage.x),
            static_cast<const double *>(m_stage.y),
            static_cast<const double *>(m_stage.z),
            static_cast<const double *>(torque.x),
            static_cast<const double *>(torque.y),
            static_cast<const double *>(torque.z),
            static_cast<double *>(rhs.x),
            static_cast<double *>(rhs.y),
            static_cast<double *>(rhs.z),
            ctx.cell_count,
            ctx.alpha);
        launch_status = cudaPeekAtLastError();
    }
    const bool completion_ok = context_complete_gpu_transport_rhs(ctx);
    const bool consumer_ordered = context_end_compute_stream_work(
        ctx, "GPU transport torque RHS");
    if (inject_launch_failure || launch_status != cudaSuccess || !completion_ok ||
        !consumer_ordered) {
        ctx.last_error = "failed to complete the bound GPU transport torque RHS";
        return false;
    }
    return true;
}

} // namespace fullmag::fdm
