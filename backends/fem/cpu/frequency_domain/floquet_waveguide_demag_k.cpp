#include "frequency_domain/floquet_waveguide_demag_k.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstddef>
#include <limits>
#include <string>
#include <iterator>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

using Complex = std::complex<double>;

constexpr std::uint64_t kMaxDenseWaveguideDofs = 4096;

void copy_error(FloquetWaveguideDemagKDiagnostics *diagnostics, const char *message) noexcept
{
    if (diagnostics == nullptr) {
        return;
    }
    std::fill(std::begin(diagnostics->error_message),
              std::end(diagnostics->error_message),
              '\0');
    if (message == nullptr) {
        return;
    }
    std::size_t index = 0;
    for (; message[index] != '\0' && index + 1u < sizeof(diagnostics->error_message); ++index) {
        diagnostics->error_message[index] = message[index];
    }
    diagnostics->error_message[index] = '\0';
}

bool valid_gauge(FloquetWaveguideDemagKGaugePolicy policy) noexcept
{
    return policy == FloquetWaveguideDemagKGaugePolicy::require_invertible ||
        policy == FloquetWaveguideDemagKGaugePolicy::pin_first_dof;
}

bool valid_matrix(const double *values, std::uint64_t rows, std::uint64_t columns) noexcept
{
    if (values == nullptr || rows == 0 || columns == 0) {
        return false;
    }
    if (rows > std::numeric_limits<std::size_t>::max() / columns) {
        return false;
    }
    const std::size_t value_count = static_cast<std::size_t>(rows * columns);
    for (std::size_t index = 0; index < value_count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

struct DenseFactorization {
    std::size_t size = 0;
    std::vector<Complex> lu{};
    std::vector<std::size_t> pivots{};
    double max_pivot_abs = 0.0;
};

bool factorize(
    const std::vector<Complex> &matrix,
    std::size_t size,
    double pivot_tolerance,
    DenseFactorization &out) noexcept
{
    try {
        out = DenseFactorization{};
        out.size = size;
        out.lu = matrix;
        out.pivots.resize(size);
        for (std::size_t column = 0; column < size; ++column) {
            std::size_t pivot = column;
            double pivot_abs = std::abs(out.lu[column * size + column]);
            for (std::size_t row = column + 1u; row < size; ++row) {
                const double candidate = std::abs(out.lu[row * size + column]);
                if (candidate > pivot_abs) {
                    pivot = row;
                    pivot_abs = candidate;
                }
            }
            if (!std::isfinite(pivot_abs) || pivot_abs <= pivot_tolerance) {
                return false;
            }
            out.max_pivot_abs = std::max(out.max_pivot_abs, pivot_abs);
            out.pivots[column] = pivot;
            if (pivot != column) {
                for (std::size_t entry = 0; entry < size; ++entry) {
                    std::swap(out.lu[column * size + entry], out.lu[pivot * size + entry]);
                }
            }
            const Complex diagonal = out.lu[column * size + column];
            for (std::size_t row = column + 1u; row < size; ++row) {
                const Complex multiplier = out.lu[row * size + column] / diagonal;
                out.lu[row * size + column] = multiplier;
                for (std::size_t entry = column + 1u; entry < size; ++entry) {
                    out.lu[row * size + entry] -=
                        multiplier * out.lu[column * size + entry];
                }
            }
        }
    } catch (...) {
        out = DenseFactorization{};
        return false;
    }
    return true;
}

bool solve_factored(
    const DenseFactorization &factorization,
    const std::vector<Complex> &rhs,
    std::vector<Complex> &out) noexcept
{
    const std::size_t size = factorization.size;
    if (rhs.size() != size || factorization.lu.size() != size * size ||
        factorization.pivots.size() != size) {
        return false;
    }
    try {
        out = rhs;
        for (std::size_t column = 0; column < size; ++column) {
            const std::size_t pivot = factorization.pivots[column];
            if (pivot != column) {
                std::swap(out[column], out[pivot]);
            }
            for (std::size_t row = column + 1u; row < size; ++row) {
                out[row] -= factorization.lu[row * size + column] * out[column];
            }
        }
        for (std::size_t row = size; row-- > 0;) {
            for (std::size_t column = row + 1u; column < size; ++column) {
                out[row] -= factorization.lu[row * size + column] * out[column];
            }
            const Complex diagonal = factorization.lu[row * size + row];
            if (std::abs(diagonal) <= 0.0 || !std::isfinite(std::abs(diagonal))) {
                return false;
            }
            out[row] /= diagonal;
        }
    } catch (...) {
        out.clear();
        return false;
    }
    return std::all_of(out.begin(), out.end(), [](Complex value) {
        return std::isfinite(value.real()) && std::isfinite(value.imag());
    });
}

std::size_t reduced_offset(
    std::size_t full_index,
    std::size_t pinned_offset,
    std::size_t reduced_size) noexcept
{
    if (pinned_offset != 0 && full_index == 0) {
        return reduced_size;
    }
    return full_index - pinned_offset;
}

double matrix_abs_max(const std::vector<Complex> &matrix) noexcept
{
    double maximum = 0.0;
    for (const Complex value : matrix) {
        maximum = std::max(maximum, std::abs(value));
    }
    return maximum;
}

} // namespace

FrequencyDomainStatus build_floquet_waveguide_demag_k_real_split(
    const FloquetWaveguideDemagKProblem &problem,
    double *out_real_split_row_major,
    std::uint64_t out_value_count,
    FloquetWaveguideDemagKDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = FloquetWaveguideDemagKDiagnostics{};
        out_diagnostics->q_dof_count = problem.q_dof_count;
        out_diagnostics->phi_dof_count = problem.phi_dof_count;
        out_diagnostics->k_rad_per_m = problem.k_rad_per_m;
        out_diagnostics->k_squared = problem.k_rad_per_m * problem.k_rad_per_m;
    }

    if (out_real_split_row_major == nullptr || out_diagnostics == nullptr) {
        copy_error(out_diagnostics, "waveguide demag-k output buffer and diagnostics are required");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.q_dof_count == 0 || problem.phi_dof_count == 0 ||
        problem.q_dof_count > kMaxDenseWaveguideDofs ||
        problem.phi_dof_count > kMaxDenseWaveguideDofs) {
        copy_error(out_diagnostics, "waveguide demag-k requires small positive q and phi dimensions");
        return FrequencyDomainStatus::validation_error;
    }
    if (!std::isfinite(problem.k_rad_per_m) || !valid_gauge(problem.gauge_policy) ||
        !std::isfinite(problem.pivot_tolerance) || problem.pivot_tolerance <= 0.0 ||
        problem.workspace_budget_bytes == 0) {
        copy_error(out_diagnostics, "waveguide demag-k k, gauge, pivot tolerance, or budget is invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const std::uint64_t q = problem.q_dof_count;
    const std::uint64_t phi = problem.phi_dof_count;
    const std::uint64_t expected_output = 2u * q;
    if (expected_output > std::numeric_limits<std::uint64_t>::max() / expected_output ||
        out_value_count != expected_output * expected_output) {
        copy_error(out_diagnostics, "waveguide demag-k real-split output shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }
    if (!valid_matrix(problem.k_perp_row_major, phi, phi) ||
        !valid_matrix(problem.mass_row_major, phi, phi) ||
        !valid_matrix(problem.a_qphi_perp_row_major, q, phi) ||
        !valid_matrix(problem.a_qphi_axial_row_major, q, phi) ||
        !valid_matrix(problem.a_phiq_perp_row_major, phi, q) ||
        !valid_matrix(problem.a_phiq_axial_row_major, phi, q)) {
        copy_error(out_diagnostics, "waveguide demag-k input blocks must be finite and complete");
        return FrequencyDomainStatus::validation_error;
    }

    const std::size_t pinned_offset =
        problem.gauge_policy == FloquetWaveguideDemagKGaugePolicy::pin_first_dof ? 1u : 0u;
    if (pinned_offset != 0 && phi == 1u) {
        copy_error(out_diagnostics, "waveguide demag-k pinning removes every potential degree of freedom");
        return FrequencyDomainStatus::solve_error;
    }
    const std::size_t reduced_phi = static_cast<std::size_t>(phi) - pinned_offset;
    const std::size_t q_size = static_cast<std::size_t>(q);
    const std::size_t phi_size = static_cast<std::size_t>(phi);
    const long double matrix_entries =
        static_cast<long double>(reduced_phi) * reduced_phi +
        static_cast<long double>(q_size) * reduced_phi * 2.0L +
        static_cast<long double>(reduced_phi) * q_size * 2.0L +
        static_cast<long double>(q_size) * q_size * 2.0L;
    if (!std::isfinite(static_cast<double>(matrix_entries)) ||
        matrix_entries > static_cast<long double>(problem.workspace_budget_bytes) /
            (sizeof(Complex) + sizeof(double))) {
        copy_error(out_diagnostics, "waveguide demag-k dense workspace exceeds the configured budget");
        return FrequencyDomainStatus::validation_error;
    }

    try {
        std::vector<Complex> poisson(reduced_phi * reduced_phi, Complex{0.0, 0.0});
        const double k_squared = problem.k_rad_per_m * problem.k_rad_per_m;
        if (!std::isfinite(k_squared)) {
            copy_error(out_diagnostics, "waveguide demag-k squared wavevector is non-finite");
            return FrequencyDomainStatus::validation_error;
        }
        for (std::size_t row = 0; row < phi_size; ++row) {
            if (pinned_offset != 0 && row == 0) {
                continue;
            }
            const std::size_t reduced_row = reduced_offset(row, pinned_offset, reduced_phi);
            for (std::size_t column = 0; column < phi_size; ++column) {
                if (pinned_offset != 0 && column == 0) {
                    continue;
                }
                const std::size_t reduced_column = reduced_offset(column, pinned_offset, reduced_phi);
                poisson[reduced_row * reduced_phi + reduced_column] =
                    Complex(
                        problem.k_perp_row_major[row * phi_size + column] +
                            k_squared * problem.mass_row_major[row * phi_size + column],
                        0.0);
            }
        }

        DenseFactorization factorization;
        if (!factorize(poisson, reduced_phi, problem.pivot_tolerance, factorization)) {
            copy_error(out_diagnostics, "waveguide demag-k modified-Helmholtz block is singular");
            return FrequencyDomainStatus::solve_error;
        }
        out_diagnostics->max_pivot_abs = factorization.max_pivot_abs;

        std::vector<Complex> schur(q_size * q_size, Complex{0.0, 0.0});
        std::vector<Complex> rhs(reduced_phi);
        std::vector<Complex> solution;
        for (std::size_t column = 0; column < q_size; ++column) {
            std::fill(rhs.begin(), rhs.end(), Complex{0.0, 0.0});
            for (std::size_t row = 0; row < phi_size; ++row) {
                if (pinned_offset != 0 && row == 0) {
                    continue;
                }
                const std::size_t reduced_row = reduced_offset(row, pinned_offset, reduced_phi);
                rhs[reduced_row] = Complex(
                    problem.a_phiq_perp_row_major[row * q_size + column],
                    problem.k_rad_per_m * problem.a_phiq_axial_row_major[row * q_size + column]);
            }
            if (!solve_factored(factorization, rhs, solution)) {
                copy_error(out_diagnostics, "waveguide demag-k modified-Helmholtz solve failed");
                return FrequencyDomainStatus::solve_error;
            }
            for (std::size_t row = 0; row < q_size; ++row) {
                Complex value{0.0, 0.0};
                for (std::size_t inner = 0; inner < reduced_phi; ++inner) {
                    const std::size_t full_inner = inner + pinned_offset;
                    const Complex a_qphi(
                        problem.a_qphi_perp_row_major[row * phi_size + full_inner],
                        problem.k_rad_per_m * problem.a_qphi_axial_row_major[row * phi_size + full_inner]);
                    value += a_qphi * solution[inner];
                }
                schur[row * q_size + column] = -value;
            }
        }

        out_diagnostics->max_schur_abs = matrix_abs_max(schur);
        double hermitian_residual = 0.0;
        for (std::size_t row = 0; row < q_size; ++row) {
            for (std::size_t column = 0; column < q_size; ++column) {
                const Complex difference = schur[row * q_size + column] -
                    std::conj(schur[column * q_size + row]);
                hermitian_residual = std::max(hermitian_residual, std::abs(difference));
                const std::size_t rr = row;
                const std::size_t cc = column;
                out_real_split_row_major[rr * (2u * q_size) + cc] =
                    schur[row * q_size + column].real();
                out_real_split_row_major[rr * (2u * q_size) + q_size + cc] =
                    -schur[row * q_size + column].imag();
                out_real_split_row_major[(q_size + rr) * (2u * q_size) + cc] =
                    schur[row * q_size + column].imag();
                out_real_split_row_major[(q_size + rr) * (2u * q_size) + q_size + cc] =
                    schur[row * q_size + column].real();
            }
        }
        out_diagnostics->max_hermitian_residual = hermitian_residual;
        return FrequencyDomainStatus::ok;
    } catch (...) {
        copy_error(out_diagnostics, "waveguide demag-k dense provider failed while allocating workspace");
        return FrequencyDomainStatus::operator_error;
    }
}

} // namespace fullmag::fem::frequency_domain
