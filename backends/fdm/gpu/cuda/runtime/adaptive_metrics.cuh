#pragma once

#include <cuda_runtime.h>

#include <cmath>

namespace fullmag {
namespace fdm {

struct AdaptiveLocalMetrics {
    double norm_defect;
    double spin_rotation_radians;
};

template <typename Scalar>
__device__ __forceinline__ AdaptiveLocalMetrics adaptive_local_metrics(
    Scalar m0x,
    Scalar m0y,
    Scalar m0z,
    Scalar m1x,
    Scalar m1y,
    Scalar m1z)
{
    const double x0 = static_cast<double>(m0x);
    const double y0 = static_cast<double>(m0y);
    const double z0 = static_cast<double>(m0z);
    const double x1 = static_cast<double>(m1x);
    const double y1 = static_cast<double>(m1y);
    const double z1 = static_cast<double>(m1z);
    const double norm0 = sqrt(x0 * x0 + y0 * y0 + z0 * z0);
    const double norm1 = sqrt(x1 * x1 + y1 * y1 + z1 * z1);
    if (!isfinite(norm0) || !isfinite(norm1) || !(norm0 > 0.0) ||
        !(norm1 > 0.0)) {
        return {CUDART_INF, CUDART_INF};
    }
    const double cosine = fmin(
        1.0,
        fmax(-1.0, (x0 * x1 + y0 * y1 + z0 * z1) / (norm0 * norm1)));
    return {fabs(norm1 - 1.0), acos(cosine)};
}

template <int BlockSize>
__device__ __forceinline__ void reduce_adaptive_metric_triplet_block(
    double error_sq,
    double norm_defect,
    double spin_rotation_radians,
    double *shared_error,
    double *shared_norm_defect,
    double *shared_spin_rotation,
    double *output,
    uint64_t metric_stride)
{
    shared_error[threadIdx.x] = error_sq;
    shared_norm_defect[threadIdx.x] = norm_defect;
    shared_spin_rotation[threadIdx.x] = spin_rotation_radians;
    __syncthreads();
    for (int offset = BlockSize / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared_error[threadIdx.x] = fmax(
                shared_error[threadIdx.x], shared_error[threadIdx.x + offset]);
            shared_norm_defect[threadIdx.x] = fmax(
                shared_norm_defect[threadIdx.x],
                shared_norm_defect[threadIdx.x + offset]);
            shared_spin_rotation[threadIdx.x] = fmax(
                shared_spin_rotation[threadIdx.x],
                shared_spin_rotation[threadIdx.x + offset]);
        }
        __syncthreads();
    }
    if (threadIdx.x == 0) {
        output[blockIdx.x] = shared_error[0];
        output[metric_stride + blockIdx.x] = shared_norm_defect[0];
        output[2 * metric_stride + blockIdx.x] = shared_spin_rotation[0];
    }
}

} // namespace fdm
} // namespace fullmag
