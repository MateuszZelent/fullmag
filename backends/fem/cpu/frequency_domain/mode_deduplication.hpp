#pragma once

#include "cpu/frequency_domain/mode_filter.hpp"

#include <vector>

namespace fullmag::fem::frequency_domain {

std::vector<ModalCandidate> deduplicate_modes_by_frequency_and_overlap(
    const std::vector<ModalCandidate> &candidates,
    const double *mass_matrix_row_major,
    std::size_t dof_count,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold);

} // namespace fullmag::fem::frequency_domain
