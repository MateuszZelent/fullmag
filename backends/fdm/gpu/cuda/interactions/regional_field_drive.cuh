#pragma once

#include "context.hpp"

#include <cuda_runtime.h>

namespace fullmag::fdm {

__device__ inline double regional_field_drive_stable_sinc(double x)
{
    const double ax = fabs(x);
    if (ax <= 1.0e-4) {
        const double x2 = x * x;
        return 1.0 - x2 / 6.0 + x2 * x2 / 120.0;
    }
    return sin(x) / x;
}

__device__ inline double regional_field_drive_multiplier(
    const RegionalFieldDriveParams &params,
    const double *piecewise_points,
    double evaluation_time_s)
{
    constexpr double two_pi = 6.283185307179586476925286766559;
    const double time_s = evaluation_time_s - params.time_offset_s;
    switch (params.waveform) {
    case FULLMAG_FDM_REGIONAL_FIELD_DRIVE_CONSTANT:
        return 1.0;
    case FULLMAG_FDM_REGIONAL_FIELD_DRIVE_SINUSOIDAL:
        return params.offset + sin(
            two_pi * params.frequency_hz * time_s + params.phase_rad);
    case FULLMAG_FDM_REGIONAL_FIELD_DRIVE_PULSE:
        return time_s >= params.t_on_s && time_s < params.t_off_s ? 1.0 : 0.0;
    case FULLMAG_FDM_REGIONAL_FIELD_DRIVE_PIECEWISE_LINEAR: {
        if (piecewise_points == nullptr || params.point_count == 0) return 0.0;
        const uint64_t first = 2 * params.point_offset;
        const uint64_t last = first + 2 * (params.point_count - 1);
        if (time_s <= piecewise_points[first]) return piecewise_points[first + 1];
        if (time_s >= piecewise_points[last]) return piecewise_points[last + 1];
        uint64_t upper = first + 2;
        while (upper <= last && piecewise_points[upper] <= time_s) upper += 2;
        const uint64_t lower = upper - 2;
        const double u = (time_s - piecewise_points[lower]) /
            (piecewise_points[upper] - piecewise_points[lower]);
        return piecewise_points[lower + 1] + u *
            (piecewise_points[upper + 1] - piecewise_points[lower + 1]);
    }
    case FULLMAG_FDM_REGIONAL_FIELD_DRIVE_SINC_PULSE:
        return params.amplitude * regional_field_drive_stable_sinc(
            two_pi * params.cutoff_hz * (time_s - params.t0_s));
    default:
        return 0.0;
    }
}

template <typename Scalar>
__device__ inline double regional_field_drive_component(
    const Scalar *basis,
    const RegionalFieldDriveParams *params,
    const double *piecewise_points,
    uint32_t drive_count,
    uint64_t cell_count,
    uint64_t cell_index,
    double evaluation_time_s)
{
    if (basis == nullptr || params == nullptr || drive_count == 0) return 0.0;
    double value = 0.0;
    for (uint32_t drive = 0; drive < drive_count; ++drive) {
        const double multiplier = regional_field_drive_multiplier(
            params[drive], piecewise_points, evaluation_time_s);
        value += multiplier * static_cast<double>(
            basis[static_cast<uint64_t>(drive) * cell_count + cell_index]);
    }
    return value;
}

} // namespace fullmag::fdm
