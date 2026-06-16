#include "cpu/frequency_domain/mode_filter.hpp"

#include <cmath>

namespace fullmag::fem::frequency_domain {

std::vector<ModalCandidate> filter_modes_for_window(
    const std::vector<ModalCandidate> &candidates,
    double frequency_min_hz,
    double frequency_max_hz,
    double residual_tolerance)
{
    std::vector<ModalCandidate> filtered;
    for (const ModalCandidate &candidate : candidates) {
        if (!std::isfinite(candidate.frequency_hz) ||
            !std::isfinite(candidate.relative_residual)) {
            continue;
        }
        if (candidate.frequency_hz < frequency_min_hz ||
            candidate.frequency_hz > frequency_max_hz) {
            continue;
        }
        if (candidate.relative_residual > residual_tolerance) {
            continue;
        }
        filtered.push_back(candidate);
    }
    return filtered;
}

} // namespace fullmag::fem::frequency_domain
