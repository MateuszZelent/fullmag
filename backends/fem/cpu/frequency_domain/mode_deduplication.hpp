#pragma once

#include "cpu/frequency_domain/mode_filter.hpp"

#include <complex>
#include <cstddef>
#include <vector>

namespace fullmag::fem::frequency_domain {

enum class ModalDeduplicationStatus {
    success,
    invalid_metric,
    mass_action_failed,
    invalid_candidate,
    invalid_parameters,
};

struct ModalDeduplicationResult {
    ModalDeduplicationStatus status = ModalDeduplicationStatus::invalid_parameters;
    std::vector<ModalCandidate> modes;
};

// The callback applies the caller-owned linear mass action to each input.
// The caller remains responsible for global Hermitian validation; this API
// validates each candidate self-norm. The callback must fill the count-sized
// output buffer completely. The original candidate vectors are never changed.
using ModalMassAction = bool (*)(
    const void *context,
    const std::complex<double> *input,
    std::complex<double> *output,
    std::size_t dof_count);

// Strict mass-action API: a missing/invalid metric or a failed callback returns
// an explicit status. Only normalized comparison copies are used for overlap;
// accepted modes retain their original amplitudes, residuals and provenance.
ModalDeduplicationResult deduplicate_modes_by_frequency_and_overlap_with_mass_action(
    const std::vector<ModalCandidate> &candidates,
    std::size_t dof_count,
    ModalMassAction mass_action,
    const void *mass_action_context,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold);

// Legacy dense API retained for existing callers. New strict callers should
// use the mass-action API above so a missing metric cannot imply identity mass.
std::vector<ModalCandidate> deduplicate_modes_by_frequency_and_overlap(
    const std::vector<ModalCandidate> &candidates,
    const double *mass_matrix_row_major,
    std::size_t dof_count,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold);

} // namespace fullmag::fem::frequency_domain
