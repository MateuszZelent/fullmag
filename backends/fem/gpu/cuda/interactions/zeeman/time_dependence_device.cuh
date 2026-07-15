#pragma once

#include "fullmag_fem.h"

#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

struct RegionalFieldDriveDeviceDesc {
    uint32_t kind;
    uint32_t time_origin;
    uint64_t point_offset;
    uint64_t point_count;
    double p0;
    double p1;
    double p2;
};

__device__ inline double stable_device_sinc(double x)
{
    const double ax = fabs(x);
    if (ax <= 1.0e-4) {
        const double x2 = x * x;
        return 1.0 - x2 / 6.0 + x2 * x2 / 120.0;
    }
    return sin(x) / x;
}

__device__ inline double evaluate_device_time_dependence(
    const RegionalFieldDriveDeviceDesc &waveform,
    const double *point_times,
    const double *point_values,
    double evaluation_time_s,
    double stage_start_time_s)
{
    constexpr double kTwoPi = 6.283185307179586476925286766559;
    const double time_s = waveform.time_origin == FULLMAG_FEM_TIME_STAGE_LOCAL
        ? evaluation_time_s - stage_start_time_s
        : evaluation_time_s;
    switch (waveform.kind) {
    case FULLMAG_FEM_TIME_CONSTANT:
        return 1.0;
    case FULLMAG_FEM_TIME_SINUSOIDAL:
        return waveform.p2 + sin(kTwoPi * waveform.p0 * time_s + waveform.p1);
    case FULLMAG_FEM_TIME_PULSE:
        return time_s >= waveform.p0 && time_s < waveform.p1 ? 1.0 : 0.0;
    case FULLMAG_FEM_TIME_PIECEWISE_LINEAR: {
        if (waveform.point_count == 0) return 0.0;
        const uint64_t first = waveform.point_offset;
        const uint64_t last = first + waveform.point_count - 1;
        if (time_s <= point_times[first]) return point_values[first];
        if (time_s >= point_times[last]) return point_values[last];
        uint64_t upper = first + 1;
        while (upper <= last && point_times[upper] <= time_s) ++upper;
        const uint64_t lower = upper - 1;
        const double u = (time_s - point_times[lower]) /
            (point_times[upper] - point_times[lower]);
        return point_values[lower] + u * (point_values[upper] - point_values[lower]);
    }
    case FULLMAG_FEM_TIME_SINC_PULSE:
        return waveform.p2 * stable_device_sinc(
            kTwoPi * waveform.p0 * (time_s - waveform.p1));
    default:
        return 0.0;
    }
}

} // namespace fullmag::fem
