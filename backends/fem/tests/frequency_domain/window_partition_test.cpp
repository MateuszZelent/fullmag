#include "cpu/frequency_domain/window_partition.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void window_partition_covers_requested_interval()
{
    fd::FrequencyWindowPartitionRequest request{};
    request.frequency_min_hz = 1.0e8;
    request.frequency_max_hz = 5.0e9;
    request.requested_mode_count = 20;

    const fd::FrequencyWindowPartition partition =
        fd::partition_frequency_window(request);

    check(!partition.subwindows.empty(), "partition must create at least one subwindow");
    check(partition.subwindows.front().requested_min_hz <= request.frequency_min_hz,
          "first subwindow starts at requested minimum");
    check(partition.subwindows.back().requested_max_hz >= request.frequency_max_hz,
          "last subwindow ends at requested maximum");
    check(partition.subwindows.size() <= 16,
          "partition must honor the default maximum subwindow count");
    for (std::size_t i = 1; i < partition.subwindows.size(); ++i) {
        const fd::FrequencySubwindow &previous = partition.subwindows[i - 1];
        const fd::FrequencySubwindow &current = partition.subwindows[i];
        check(previous.requested_max_hz == current.requested_min_hz,
              "requested subwindows must be contiguous");
    }
}

void window_partition_adds_guard_bands()
{
    fd::FrequencyWindowPartitionRequest request{};
    request.frequency_min_hz = 1.0e8;
    request.frequency_max_hz = 5.0e9;
    request.requested_mode_count = 20;

    const fd::FrequencyWindowPartition partition =
        fd::partition_frequency_window(request);

    check(partition.subwindows.size() > 1, "wide window must be partitioned");
    const fd::FrequencySubwindow &first = partition.subwindows.front();
    check(first.search_min_hz < first.requested_min_hz,
          "first subwindow should include a lower guard band");
    check(first.search_max_hz > first.requested_max_hz,
          "first subwindow should include an upper guard band");
    check(first.shift_hz == 0.5 * (first.requested_min_hz + first.requested_max_hz),
          "shift must be the subwindow midpoint");
    check(first.guard_modes_per_shift >= 4, "guard mode count must have a floor");
}

void window_partition_never_uses_negative_frequency()
{
    fd::FrequencyWindowPartitionRequest request{};
    request.frequency_min_hz = 1.0e6;
    request.frequency_max_hz = 3.0e6;
    request.requested_mode_count = 3;
    request.guard_fraction = 2.0;

    const fd::FrequencyWindowPartition partition =
        fd::partition_frequency_window(request);

    for (const fd::FrequencySubwindow &subwindow : partition.subwindows) {
        check(subwindow.search_min_hz >= 0.0,
              "guarded lower search frequency must never be negative");
    }
}

} // namespace

int main()
{
    window_partition_covers_requested_interval();
    window_partition_adds_guard_bands();
    window_partition_never_uses_negative_frequency();
    return 0;
}
