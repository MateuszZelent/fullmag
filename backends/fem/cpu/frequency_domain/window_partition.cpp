#include "cpu/frequency_domain/window_partition.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem::frequency_domain {

namespace {

int clamp_int(int value, int min_value, int max_value) noexcept
{
    return std::max(min_value, std::min(value, max_value));
}

int ceil_div_count(int count, int divisor) noexcept
{
    if (count <= 0 || divisor <= 0) {
        return 1;
    }
    return (count + divisor - 1) / divisor;
}

} // namespace

FrequencyWindowPartition partition_frequency_window(
    const FrequencyWindowPartitionRequest &request)
{
    FrequencyWindowPartition partition{};
    partition.completeness_policy =
        request.completeness_policy == 1 ? "certified_count" : "best_effort";
    partition.certification_method = "none";

    if (!std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !(request.frequency_min_hz < request.frequency_max_hz) ||
        request.frequency_min_hz < 0.0) {
        return partition;
    }

    const double window_width =
        request.frequency_max_hz - request.frequency_min_hz;
    const double denominator =
        request.frequency_min_hz > 0.0 ? request.frequency_min_hz : window_width;
    const double relative_width =
        denominator > 0.0 ? window_width / denominator : 0.0;
    const double max_width_ratio =
        request.max_subwindow_width_ratio > 0.0 ?
            request.max_subwindow_width_ratio :
            0.35;
    int subwindow_count = static_cast<int>(std::ceil(relative_width / max_width_ratio));
    subwindow_count = std::max(1, subwindow_count);
    subwindow_count = clamp_int(
        subwindow_count,
        std::max(1, request.min_subwindow_count),
        std::max(1, request.max_subwindow_count));

    const double guard_fraction =
        request.guard_fraction >= 0.0 ? request.guard_fraction : 0.25;
    const int guard_modes_per_shift =
        std::max(4, ceil_div_count(request.requested_mode_count, subwindow_count));

    partition.subwindows.reserve(static_cast<std::size_t>(subwindow_count));
    partition.uncertified_subwindows.reserve(static_cast<std::size_t>(subwindow_count));
    for (int i = 0; i < subwindow_count; ++i) {
        const double sub_min =
            request.frequency_min_hz +
            static_cast<double>(i) * window_width / static_cast<double>(subwindow_count);
        const double sub_max =
            request.frequency_min_hz +
            static_cast<double>(i + 1) * window_width / static_cast<double>(subwindow_count);
        const double sub_width = sub_max - sub_min;

        FrequencySubwindow subwindow{};
        subwindow.index = static_cast<std::size_t>(i);
        subwindow.requested_min_hz = sub_min;
        subwindow.requested_max_hz = sub_max;
        subwindow.search_min_hz = std::max(0.0, sub_min - guard_fraction * sub_width);
        subwindow.search_max_hz = sub_max + guard_fraction * sub_width;
        subwindow.shift_hz = 0.5 * (sub_min + sub_max);
        subwindow.guard_modes_per_shift = guard_modes_per_shift;
        partition.subwindows.push_back(subwindow);
        partition.uncertified_subwindows.push_back(subwindow.index);
    }

    if (request.expected_mode_density > 0.0) {
        partition.estimated_modes_in_window =
            static_cast<int>(std::ceil(request.expected_mode_density * window_width));
    }
    return partition;
}

} // namespace fullmag::fem::frequency_domain
