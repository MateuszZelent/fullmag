#pragma once

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <limits>

namespace fullmag::fem::frequency_domain {

// Cancellation-safe row scales for a diagnostic backward error. This is
// |A| |x|, not |A x|: a physically charge-free source can have a nonzero
// assembly scale even when its signed CSR action cancels to roundoff.
inline bool poisson_probe_absolute_csr_action(
    const CsrMatrixView &matrix, const std::vector<double> &input,
    std::vector<double> *scale)
{
    if (scale == nullptr || matrix.row_offsets == nullptr ||
        matrix.column_indices == nullptr || matrix.values == nullptr ||
        matrix.column_count != input.size() ||
        matrix.row_offsets_len != matrix.row_count + 1u ||
        matrix.column_indices_len != matrix.values_len ||
        matrix.row_offsets[0] != 0u ||
        matrix.row_offsets[matrix.row_count] != matrix.values_len) {
        return false;
    }
    scale->assign(static_cast<std::size_t>(matrix.row_count), 0.0);
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        const auto begin = matrix.row_offsets[row];
        const auto end = matrix.row_offsets[row + 1u];
        if (begin > end || end > matrix.values_len) {
            return false;
        }
        long double sum = 0.0L;
        for (auto entry = begin; entry < end; ++entry) {
            const auto column = matrix.column_indices[entry];
            if (column >= matrix.column_count ||
                !std::isfinite(matrix.values[entry]) ||
                !std::isfinite(input[column])) {
                return false;
            }
            sum += std::abs(static_cast<long double>(matrix.values[entry]) *
                            static_cast<long double>(input[column]));
        }
        (*scale)[row] = static_cast<double>(sum);
        if (!std::isfinite((*scale)[row])) {
            return false;
        }
    }
    return true;
}

inline double poisson_probe_componentwise_residual(
    const std::vector<double> &residual,
    const std::vector<double> &poisson_scale,
    const std::vector<double> &source_scale,
    const double *gauge_weights = nullptr, double eta = 0.0)
{
    if (residual.size() != poisson_scale.size() ||
        residual.size() != source_scale.size() || !std::isfinite(eta)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    double worst = 0.0;
    for (std::size_t row = 0; row < residual.size(); ++row) {
        const double gauge = gauge_weights == nullptr ? 0.0 :
            std::abs(gauge_weights[row] * eta);
        const double scale = poisson_scale[row] + source_scale[row] + gauge;
        if (!std::isfinite(residual[row]) || !std::isfinite(scale) ||
            poisson_scale[row] < 0.0 || source_scale[row] < 0.0) {
            return std::numeric_limits<double>::quiet_NaN();
        }
        const double value = scale > 0.0 ? std::abs(residual[row]) / scale :
            residual[row] == 0.0 ? 0.0 : std::numeric_limits<double>::infinity();
        worst = std::max(worst, value);
    }
    return worst;
}

constexpr std::uint32_t kPoissonAirboxSchurMatShellCertificationAbiVersion = 1;

struct PoissonAirboxSchurMatShellCertificateKey {
    std::uint64_t mesh_signature = 0;
    std::uint64_t material_signature = 0;
    std::uint64_t m0_signature = 0;
    std::uint64_t h_eff0_signature = 0;
    std::uint64_t static_demag_signature = 0;
    std::uint64_t boundary_signature = 0;
    std::uint64_t k_signature = 0;
    std::uint64_t gauge_signature = 0;
    std::uint64_t operator_signature = 0;
};

struct PoissonAirboxSchurMatShellCertificationResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_phi_dof_count = 0;

    double schur_apply_relative_error = 0.0;
    double schur_eigen_residual_relative = 0.0;
    double full_residual_reconstruction_relative_error = 0.0;
    double poisson_constraint_relative_residual = 0.0;
    double gauge_mean_abs = 0.0;
    double full_sparse_reference_frequency_hz = 0.0;
    double schur_frequency_hz = 0.0;
    double full_sparse_reference_relative_frequency_error = 0.0;

    bool created_petsc_matshell = false;
    bool reused_mean_zero_poisson_setup = false;
    bool schur_certified = false;
    bool full_sparse_reference_certified = false;
    bool full_residual_certified = false;

    PoissonAirboxSchurMatShellCertificateKey certificate_key{};
    char certificate_key_json[2048]{};
    char diagnostics_json[8192]{};
};

FrequencyDomainStatus certify_poisson_airbox_schur_matshell_cpu(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxSchurMatShellCertificationResult *out_result) noexcept;

// Formats the measured per-subwindow EPS termination fields as JSON members.
// Unavailable, hard-error, or invalid-context snapshots remain false/null.
bool format_poisson_airbox_subwindow_termination_json(
    const PoissonAirboxModalEigenResult &result,
    char *destination,
    std::size_t destination_size) noexcept;

// Production shared-domain K0 lane.  The scalar Poisson block is eliminated
// through a persistent PETSc factorization and SLEPc operates on the
// real-frequency-rotated Schur pencil.  Synthetic/dense certification remains
// owned by certify_poisson_airbox_schur_matshell_cpu().
FrequencyDomainStatus solve_poisson_airbox_modal_eigen_cpu_schur(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
