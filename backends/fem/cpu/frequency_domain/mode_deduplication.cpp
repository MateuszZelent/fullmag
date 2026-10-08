#include "cpu/frequency_domain/mode_deduplication.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <numeric>
#include <utility>

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

namespace {

struct PreparedModalCandidate {
    std::vector<std::complex<double>> normalized_mode;
    std::vector<std::complex<double>> normalized_mass_applied_mode;
};

bool finite_complex(const std::complex<double> &value)
{
    return std::isfinite(value.real()) && std::isfinite(value.imag());
}

ModalDeduplicationResult deduplication_failure(ModalDeduplicationStatus status)
{
    ModalDeduplicationResult result;
    result.status = status;
    return result;
}

} // namespace

ModalDeduplicationResult deduplicate_modes_by_frequency_and_overlap_with_mass_action(
    const std::vector<ModalCandidate> &candidates,
    std::size_t dof_count,
    ModalMassAction mass_action,
    const void *mass_action_context,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold)
{
    if (mass_action == nullptr || dof_count == 0) {
        return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
    }
    if (!std::isfinite(frequency_relative_tolerance) ||
        frequency_relative_tolerance < 0.0 ||
        !std::isfinite(frequency_absolute_tolerance_hz) ||
        frequency_absolute_tolerance_hz < 0.0 ||
        !std::isfinite(overlap_threshold) ||
        overlap_threshold < 0.0 || overlap_threshold > 1.0) {
        return deduplication_failure(ModalDeduplicationStatus::invalid_parameters);
    }

    std::vector<PreparedModalCandidate> prepared;
    prepared.reserve(candidates.size());
    for (std::size_t source_index = 0; source_index < candidates.size(); ++source_index) {
        const ModalCandidate &candidate = candidates[source_index];
        if (!std::isfinite(candidate.frequency_hz) ||
            !std::isfinite(candidate.relative_residual) ||
            candidate.relative_residual < 0.0 ||
            candidate.mode.size() != dof_count) {
            return deduplication_failure(ModalDeduplicationStatus::invalid_candidate);
        }

        double input_scale = 0.0;
        for (const std::complex<double> &entry : candidate.mode) {
            if (!finite_complex(entry)) {
                return deduplication_failure(ModalDeduplicationStatus::invalid_candidate);
            }
            input_scale = std::max(
                input_scale,
                std::max(std::abs(entry.real()), std::abs(entry.imag())));
        }
        if (!(input_scale > 0.0) || !std::isfinite(input_scale)) {
            return deduplication_failure(ModalDeduplicationStatus::invalid_candidate);
        }

        // This positive scaling is comparison-only and cancels from the
        // normalized mass overlap. It avoids forming q^H M q at raw amplitude.
        std::vector<std::complex<double>> scaled_mode(dof_count);
        const double uninitialized = std::numeric_limits<double>::quiet_NaN();
        std::vector<std::complex<double>> mass_applied_mode(
            dof_count,
            std::complex<double>{uninitialized, uninitialized});
        for (std::size_t i = 0; i < dof_count; ++i) {
            scaled_mode[i] = candidate.mode[i] / input_scale;
        }
        if (!mass_action(
                mass_action_context,
                scaled_mode.data(),
                mass_applied_mode.data(),
                dof_count)) {
            return deduplication_failure(ModalDeduplicationStatus::mass_action_failed);
        }

        std::complex<double> self_product{0.0, 0.0};
        double absolute_term_sum = 0.0;
        for (std::size_t i = 0; i < dof_count; ++i) {
            if (!finite_complex(mass_applied_mode[i])) {
                return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
            }
            const std::complex<double> term =
                std::conj(scaled_mode[i]) * mass_applied_mode[i];
            if (!finite_complex(term)) {
                return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
            }
            self_product += term;
            absolute_term_sum += std::abs(term);
            if (!finite_complex(self_product) || !std::isfinite(absolute_term_sum)) {
                return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
            }
        }

        // Require |Im(q^H M q)| <= 64 eps * max(|Re(q^H M q)|,
        // sum_i |conj(q_i) (M q)_i|). This relative Hermitian-roundoff bound
        // has no SI-unit floor, so small positive physical volumes remain valid.
        constexpr double kHermitianRoundoffUlps = 64.0;
        const double self_product_scale =
            std::max(std::abs(self_product.real()), absolute_term_sum);
        const double imaginary_bound =
            kHermitianRoundoffUlps * std::numeric_limits<double>::epsilon() *
            self_product_scale;
        if (!(self_product.real() > 0.0) ||
            !std::isfinite(self_product.real()) ||
            !std::isfinite(imaginary_bound) ||
            std::abs(self_product.imag()) > imaginary_bound) {
            return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
        }
        const double scaled_norm = std::sqrt(self_product.real());
        if (!(scaled_norm > 0.0) || !std::isfinite(scaled_norm)) {
            return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
        }

        PreparedModalCandidate prepared_candidate{};
        prepared_candidate.normalized_mode.resize(dof_count);
        prepared_candidate.normalized_mass_applied_mode.resize(dof_count);
        for (std::size_t i = 0; i < dof_count; ++i) {
            prepared_candidate.normalized_mode[i] = scaled_mode[i] / scaled_norm;
            prepared_candidate.normalized_mass_applied_mode[i] =
                mass_applied_mode[i] / scaled_norm;
            if (!finite_complex(prepared_candidate.normalized_mode[i]) ||
                !finite_complex(prepared_candidate.normalized_mass_applied_mode[i])) {
                return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
            }
        }
        prepared.push_back(std::move(prepared_candidate));
    }

    std::vector<std::size_t> frequency_order(candidates.size());
    std::iota(frequency_order.begin(), frequency_order.end(), 0);
    std::stable_sort(
        frequency_order.begin(),
        frequency_order.end(),
        [&candidates](std::size_t left, std::size_t right) {
            return candidates[left].frequency_hz < candidates[right].frequency_hz;
        });

    std::vector<std::size_t> accepted_indices;
    accepted_indices.reserve(candidates.size());
    for (const std::size_t candidate_index : frequency_order) {
        bool duplicate = false;
        for (std::size_t &existing_index : accepted_indices) {
            const ModalCandidate &candidate = candidates[candidate_index];
            const ModalCandidate &existing = candidates[existing_index];
            if (!frequency_close(
                    candidate.frequency_hz,
                    existing.frequency_hz,
                    frequency_relative_tolerance,
                    frequency_absolute_tolerance_hz)) {
                continue;
            }

            const PreparedModalCandidate &candidate_metric = prepared[candidate_index];
            const PreparedModalCandidate &existing_metric = prepared[existing_index];
            std::complex<double> overlap{0.0, 0.0};
            for (std::size_t i = 0; i < dof_count; ++i) {
                overlap += std::conj(candidate_metric.normalized_mode[i]) *
                    existing_metric.normalized_mass_applied_mode[i];
                if (!finite_complex(overlap)) {
                    return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
                }
            }
            const double overlap_magnitude = std::abs(overlap);
            if (!std::isfinite(overlap_magnitude)) {
                return deduplication_failure(ModalDeduplicationStatus::invalid_metric);
            }
            if (overlap_magnitude >= overlap_threshold) {
                duplicate = true;
                if (candidate.relative_residual < existing.relative_residual) {
                    existing_index = candidate_index;
                }
                break;
            }
        }
        if (!duplicate) {
            accepted_indices.push_back(candidate_index);
        }
    }

    std::stable_sort(
        accepted_indices.begin(),
        accepted_indices.end(),
        [&candidates](std::size_t left, std::size_t right) {
            return candidates[left].frequency_hz < candidates[right].frequency_hz;
        });

    ModalDeduplicationResult result;
    result.status = ModalDeduplicationStatus::success;
    result.modes.reserve(accepted_indices.size());
    for (const std::size_t source_index : accepted_indices) {
        result.modes.push_back(candidates[source_index]);
    }
    return result;
}

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
