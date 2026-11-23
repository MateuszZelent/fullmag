#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace fullmag::fem::frequency_domain {

// Compute the first and last refinement shifts used to probe outside a
// requested frequency interval.  For a strictly positive lower bound, keep
// the lower probe strictly positive and representably below that bound.  A
// zero lower bound retains the historical symmetric negative probe.
inline bool compute_modal_window_refinement_shift_bounds(
    double frequency_min_hz,
    double frequency_max_hz,
    std::uint32_t refinement_partition_count,
    double *first_shift_hz,
    double *last_shift_hz) noexcept
{
    if (first_shift_hz == nullptr || last_shift_hz == nullptr ||
        !std::isfinite(frequency_min_hz) ||
        !std::isfinite(frequency_max_hz) ||
        frequency_min_hz < 0.0 ||
        !(frequency_max_hz > frequency_min_hz) ||
        refinement_partition_count == 0u) {
        return false;
    }

    const double width_hz = frequency_max_hz - frequency_min_hz;
    const double spacing_hz =
        width_hz / static_cast<double>(refinement_partition_count);
    const double half_spacing_hz = 0.5 * spacing_hz;
    if (!std::isfinite(width_hz) || !(spacing_hz > 0.0) ||
        !std::isfinite(half_spacing_hz)) {
        return false;
    }

    double lower_shift_hz = frequency_min_hz - half_spacing_hz;
    if (frequency_min_hz > 0.0) {
        const double lower_offset_hz =
            std::min(frequency_min_hz / 2.0, half_spacing_hz);
        lower_shift_hz = frequency_min_hz - lower_offset_hz;
        if (!(lower_shift_hz > 0.0 && lower_shift_hz < frequency_min_hz)) {
            lower_shift_hz = std::nextafter(frequency_min_hz, 0.0);
        }
        if (!(lower_shift_hz > 0.0 && lower_shift_hz < frequency_min_hz)) {
            return false;
        }
    }
    const double upper_shift_hz = frequency_max_hz + half_spacing_hz;
    if (!std::isfinite(lower_shift_hz) ||
        !std::isfinite(upper_shift_hz) ||
        !(upper_shift_hz > frequency_max_hz)) {
        return false;
    }

    *first_shift_hz = lower_shift_hz;
    *last_shift_hz = upper_shift_hz;
    return true;
}

inline double modal_window_refinement_shift_hz(
    double frequency_min_hz,
    double spacing_hz,
    std::uint32_t subwindow_index,
    std::uint32_t partition_count,
    double first_shift_hz,
    double last_shift_hz) noexcept
{
    if (subwindow_index == 0u) {
        return first_shift_hz;
    }
    if (subwindow_index == partition_count + 1u) {
        return last_shift_hz;
    }
    return frequency_min_hz + (static_cast<double>(subwindow_index) - 0.5) * spacing_hz;
}

} // namespace fullmag::fem::frequency_domain
