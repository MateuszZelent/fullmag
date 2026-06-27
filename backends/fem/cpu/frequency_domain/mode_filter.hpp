#pragma once

#include <complex>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct ModalCandidate {
    double frequency_hz = 0.0;
    double relative_residual = 0.0;
    int source_index = -1;
    std::vector<std::complex<double>> mode;
};

std::vector<ModalCandidate> filter_modes_for_window(
    const std::vector<ModalCandidate> &candidates,
    double frequency_min_hz,
    double frequency_max_hz,
    double residual_tolerance);

} // namespace fullmag::fem::frequency_domain
