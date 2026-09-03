/*
 * GPU CUDA DMI tetrahedral geometry and gradient math.
 *
 * Provides shared device helpers for computing shape function gradients,
 * volume, and conditioning on linear tetrahedra (P1/TET4).
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cmath>
#include <cstdint>

namespace fullmag::fem {

static __device__ inline bool dmi_tetra_gradients_device(
    const double *nodes_xyz,
    uint32_t n0,
    uint32_t n1,
    uint32_t n2,
    uint32_t n3,
    double grads[4][3],
    double &volume,
    double *condition_scale = nullptr,
    double gradient_scales[4][3] = nullptr,
    bool *nonfinite_geometry = nullptr)
{
    constexpr double kGeomEpsDevice = 1.0e-30;
    const double p0x = nodes_xyz[static_cast<size_t>(n0) * 3u + 0u];
    const double p0y = nodes_xyz[static_cast<size_t>(n0) * 3u + 1u];
    const double p0z = nodes_xyz[static_cast<size_t>(n0) * 3u + 2u];
    const double d1x = nodes_xyz[static_cast<size_t>(n1) * 3u + 0u] - p0x;
    const double d1y = nodes_xyz[static_cast<size_t>(n1) * 3u + 1u] - p0y;
    const double d1z = nodes_xyz[static_cast<size_t>(n1) * 3u + 2u] - p0z;
    const double d2x = nodes_xyz[static_cast<size_t>(n2) * 3u + 0u] - p0x;
    const double d2y = nodes_xyz[static_cast<size_t>(n2) * 3u + 1u] - p0y;
    const double d2z = nodes_xyz[static_cast<size_t>(n2) * 3u + 2u] - p0z;
    const double d3x = nodes_xyz[static_cast<size_t>(n3) * 3u + 0u] - p0x;
    const double d3y = nodes_xyz[static_cast<size_t>(n3) * 3u + 1u] - p0y;
    const double d3z = nodes_xyz[static_cast<size_t>(n3) * 3u + 2u] - p0z;

    const double c23x = d2y * d3z - d2z * d3y;
    const double c23y = d2z * d3x - d2x * d3z;
    const double c23z = d2x * d3y - d2y * d3x;
    const double det = d1x * c23x + d1y * c23y + d1z * c23z;
    if (!isfinite(det)) {
        if (nonfinite_geometry != nullptr) {
            *nonfinite_geometry = true;
        }
        volume = 0.0;
        return false;
    }
    if (!(fabs(det) > kGeomEpsDevice)) {
        if (nonfinite_geometry != nullptr) {
            *nonfinite_geometry = false;
        }
        volume = 0.0;
        return false;
    }
    volume = fabs(det) / 6.0;
    const double a1x = fabs(nodes_xyz[static_cast<size_t>(n1) * 3u + 0u]) + fabs(p0x);
    const double a1y = fabs(nodes_xyz[static_cast<size_t>(n1) * 3u + 1u]) + fabs(p0y);
    const double a1z = fabs(nodes_xyz[static_cast<size_t>(n1) * 3u + 2u]) + fabs(p0z);
    const double a2x = fabs(nodes_xyz[static_cast<size_t>(n2) * 3u + 0u]) + fabs(p0x);
    const double a2y = fabs(nodes_xyz[static_cast<size_t>(n2) * 3u + 1u]) + fabs(p0y);
    const double a2z = fabs(nodes_xyz[static_cast<size_t>(n2) * 3u + 2u]) + fabs(p0z);
    const double a3x = fabs(nodes_xyz[static_cast<size_t>(n3) * 3u + 0u]) + fabs(p0x);
    const double a3y = fabs(nodes_xyz[static_cast<size_t>(n3) * 3u + 1u]) + fabs(p0y);
    const double a3z = fabs(nodes_xyz[static_cast<size_t>(n3) * 3u + 2u]) + fabs(p0z);
    if (condition_scale != nullptr) {
        const double det_scale =
            a1x * (a2y * a3z + a2z * a3y) +
            a1y * (a2z * a3x + a2x * a3z) +
            a1z * (a2x * a3y + a2y * a3x);
        *condition_scale = fmax(1.0, det_scale / fabs(det));
    }
    const double inv_det = 1.0 / det;
    grads[1][0] =  (d2y * d3z - d2z * d3y) * inv_det;
    grads[1][1] = -(d2x * d3z - d2z * d3x) * inv_det;
    grads[1][2] =  (d2x * d3y - d2y * d3x) * inv_det;
    grads[2][0] = -(d1y * d3z - d1z * d3y) * inv_det;
    grads[2][1] =  (d1x * d3z - d1z * d3x) * inv_det;
    grads[2][2] = -(d1x * d3y - d1y * d3x) * inv_det;
    grads[3][0] =  (d1y * d2z - d1z * d2y) * inv_det;
    grads[3][1] = -(d1x * d2z - d1z * d2x) * inv_det;
    grads[3][2] =  (d1x * d2y - d1y * d2x) * inv_det;
    for (int dir = 0; dir < 3; ++dir) {
        grads[0][dir] = -(grads[1][dir] + grads[2][dir] + grads[3][dir]);
    }
    if (gradient_scales != nullptr) {
        const double inv_det_abs = fabs(inv_det);
        gradient_scales[1][0] = (a2y*a3z + a2z*a3y) * inv_det_abs;
        gradient_scales[1][1] = (a2x*a3z + a2z*a3x) * inv_det_abs;
        gradient_scales[1][2] = (a2x*a3y + a2y*a3x) * inv_det_abs;
        gradient_scales[2][0] = (a1y*a3z + a1z*a3y) * inv_det_abs;
        gradient_scales[2][1] = (a1x*a3z + a1z*a3x) * inv_det_abs;
        gradient_scales[2][2] = (a1x*a3y + a1y*a3x) * inv_det_abs;
        gradient_scales[3][0] = (a1y*a2z + a1z*a2y) * inv_det_abs;
        gradient_scales[3][1] = (a1x*a2z + a1z*a2x) * inv_det_abs;
        gradient_scales[3][2] = (a1x*a2y + a1y*a2x) * inv_det_abs;
        for (int dir = 0; dir < 3; ++dir) {
            gradient_scales[0][dir] =
                gradient_scales[1][dir] + gradient_scales[2][dir] +
                gradient_scales[3][dir];
        }
    }
    return true;
}

} // namespace fullmag::fem
#endif
