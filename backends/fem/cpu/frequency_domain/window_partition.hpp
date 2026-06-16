#pragma once

#include <cstddef>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct FrequencySubwindow {
    std::size_t index = 0;
    double requested_min_hz = 0.0;
    double requested_max_hz = 0.0;
    double search_min_hz = 0.0;
    double search_max_hz = 0.0;
    double shift_hz = 0.0;
    int guard_modes_per_shift = 4;
};

struct FrequencyWindowPartitionRequest {
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    int requested_mode_count = 1;
    double expected_mode_density = 0.0;
    double max_subwindow_width_ratio = 0.35;
    int min_subwindow_count = 1;
    int max_subwindow_count = 16;
    double guard_fraction = 0.25;
    int completeness_policy = 0;
};

struct FrequencyWindowPartition {
    std::vector<FrequencySubwindow> subwindows;
    const char *completeness_policy = "best_effort";
    const char *certification_method = "none";
    int estimated_modes_in_window = 0;
    int certified_modes_in_window = 0;
    std::vector<std::size_t> uncertified_subwindows;
};

FrequencyWindowPartition partition_frequency_window(
    const FrequencyWindowPartitionRequest &request);

} // namespace fullmag::fem::frequency_domain
