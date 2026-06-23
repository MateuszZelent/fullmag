#include "cpu/frequency_domain/mode_deduplication.hpp"

#include <algorithm>
#include <cmath>
#include <complex>

namespace fullmag::fem::frequency_domain {

namespace {

std::complex<double> mass_inner_product(
    const ModalCandidate &left,
    const ModalCandidate &right,
    const double *mass_matrix_row_major,
    std::size_t dof_count)
{
    std::complex<double> value{0.0, 0.0};
    if (left.mode.size() != dof_count || right.mode.size() != dof_count) {
        return value;
    }
    for (std::size_t i = 0; i < dof_count; ++i) {
        std::complex<double> weighted_right{0.0, 0.0};
        for (std::size_t j = 0; j < dof_count; ++j) {
            const double mass =
                mass_matrix_row_major != nullptr ?
                    mass_matrix_row_major[i * dof_count + j] :
                    (i == j ? 1.0 : 0.0);
            weighted_right += mass * right.mode[j];
        }
        value += std::conj(left.mode[i]) * weighted_right;
    }
    return value;
}

double mass_norm(
    const ModalCandidate &candidate,
    const double *mass_matrix_row_major,
    std::size_t dof_count)
{
    const std::complex<double> value = mass_inner_product(
        candidate,
        candidate,
        mass_matrix_row_major,
        dof_count);
    return std::sqrt(std::max(0.0, std::real(value)));
}

void normalize_mode(
    ModalCandidate &candidate,
    const double *mass_matrix_row_major,
    std::size_t dof_count)
{
    const double norm = mass_norm(candidate, mass_matrix_row_major, dof_count);
    if (!(norm > 0.0) || !std::isfinite(norm)) {
        return;
    }
    for (std::complex<double> &entry : candidate.mode) {
        entry /= norm;
    }
}

bool frequency_close(
    double left_hz,
    double right_hz,
    double relative_tolerance,
    double absolute_tolerance_hz)
{
    const double tolerance = std::max(
        relative_tolerance * std::max(std::abs(left_hz), std::abs(right_hz)),
        absolute_tolerance_hz);
    return std::abs(left_hz - right_hz) <= tolerance;
}

} // namespace

std::vector<ModalCandidate> deduplicate_modes_by_frequency_and_overlap(
    const std::vector<ModalCandidate> &candidates,
    const double *mass_matrix_row_major,
    std::size_t dof_count,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold)
{
    std::vector<ModalCandidate> sorted;
    sorted.reserve(candidates.size());
    for (ModalCandidate candidate : candidates) {
        if (!std::isfinite(candidate.frequency_hz) ||
            !std::isfinite(candidate.relative_residual) ||
            candidate.mode.size() != dof_count) {
            continue;
        }
        normalize_mode(candidate, mass_matrix_row_major, dof_count);
        sorted.push_back(candidate);
    }
    std::sort(
        sorted.begin(),
        sorted.end(),
        [](const ModalCandidate &left, const ModalCandidate &right) {
            return left.frequency_hz < right.frequency_hz;
        });

    std::vector<ModalCandidate> accepted;
    for (const ModalCandidate &candidate : sorted) {
        bool duplicate = false;
        for (ModalCandidate &existing : accepted) {
            if (!frequency_close(
                    candidate.frequency_hz,
                    existing.frequency_hz,
                    frequency_relative_tolerance,
                    frequency_absolute_tolerance_hz)) {
                continue;
            }
            const double overlap = std::abs(mass_inner_product(
                candidate,
                existing,
                mass_matrix_row_major,
                dof_count));
            if (overlap >= overlap_threshold) {
                duplicate = true;
                if (candidate.relative_residual < existing.relative_residual) {
                    existing = candidate;
                }
                break;
            }
        }
        if (!duplicate) {
            accepted.push_back(candidate);
        }
    }
    std::sort(
        accepted.begin(),
        accepted.end(),
        [](const ModalCandidate &left, const ModalCandidate &right) {
            return left.frequency_hz < right.frequency_hz;
        });
    return accepted;
}

} // namespace fullmag::fem::frequency_domain
