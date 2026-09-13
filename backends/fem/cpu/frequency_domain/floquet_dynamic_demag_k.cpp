#include "frequency_domain/floquet_dynamic_demag_k.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

using Complex = std::complex<double>;

constexpr std::uint64_t kMaxDenseFloquetDofs = 4096;

void copy_error(FloquetDynamicDemagKDiagnostics *diagnostics, const char *message) noexcept
{
    if (diagnostics == nullptr) {
        return;
    }
    std::strncpy(diagnostics->error_message, message, sizeof(diagnostics->error_message) - 1);
    diagnostics->error_message[sizeof(diagnostics->error_message) - 1] = '\0';
}

bool checked_product(std::uint64_t lhs, std::uint64_t rhs, std::uint64_t *out) noexcept
{
    if (out == nullptr || (rhs != 0 && lhs > std::numeric_limits<std::uint64_t>::max() / rhs)) {
        return false;
    }
    *out = lhs * rhs;
    return true;
}

bool checked_square(std::uint64_t value, std::uint64_t *out) noexcept
{
    return checked_product(value, value, out);
}

bool finite_complex_values(const Complex *values, std::uint64_t count) noexcept
{
    if (values == nullptr) {
        return false;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index].real()) || !std::isfinite(values[index].imag())) {
            return false;
        }
    }
    return true;
}

bool valid_gauge_policy(FloquetDynamicDemagKGaugePolicy policy) noexcept
{
    switch (policy) {
    case FloquetDynamicDemagKGaugePolicy::require_invertible:
    case FloquetDynamicDemagKGaugePolicy::pin_first_dof:
        return true;
    }
    return false;
}

FrequencyDomainStatus validate_problem(
    const FloquetDynamicDemagKProblem &problem,
    std::uint64_t *factored_phi_dof_count,
    FloquetDynamicDemagKDiagnostics *diagnostics) noexcept
{
    if (diagnostics != nullptr) {
        *diagnostics = FloquetDynamicDemagKDiagnostics{};
        diagnostics->q_dof_count = problem.q_dof_count;
        diagnostics->phi_dof_count = problem.phi_dof_count;
    }
    if (factored_phi_dof_count == nullptr ||
        problem.q_dof_count == 0 || problem.phi_dof_count == 0 ||
        problem.q_dof_count > kMaxDenseFloquetDofs ||
        problem.phi_dof_count > kMaxDenseFloquetDofs) {
        copy_error(
            diagnostics,
            "Floquet dynamic demag-k dense provider requires small positive q and phi dimensions");
        return FrequencyDomainStatus::validation_error;
    }
    std::uint64_t q_phi_count = 0;
    std::uint64_t phi_q_count = 0;
    std::uint64_t phi_phi_count = 0;
    if (!checked_product(problem.q_dof_count, problem.phi_dof_count, &q_phi_count) ||
        !checked_product(problem.phi_dof_count, problem.q_dof_count, &phi_q_count) ||
        !checked_square(problem.phi_dof_count, &phi_phi_count) ||
        problem.a_qphi_value_count != q_phi_count ||
        problem.a_phiq_value_count != phi_q_count ||
        problem.p_value_count != phi_phi_count) {
        copy_error(diagnostics, "Floquet dynamic demag-k block shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }

    long double k_squared = 0.0L;
    for (double component : problem.k_rad_per_m) {
        if (!std::isfinite(component)) {
            copy_error(diagnostics, "Floquet dynamic demag-k vector must be finite");
            return FrequencyDomainStatus::validation_error;
        }
        k_squared += static_cast<long double>(component) * component;
    }
    if (!(k_squared > 0.0L) || !std::isfinite(static_cast<double>(k_squared))) {
        copy_error(
            diagnostics,
            "Floquet dynamic demag-k provider requires a nonzero finite wavevector");
        return FrequencyDomainStatus::validation_error;
    }
    if (diagnostics != nullptr) {
        diagnostics->k_norm_rad_per_m = std::sqrt(static_cast<double>(k_squared));
    }
    if (!valid_gauge_policy(problem.gauge_policy) ||
        !std::isfinite(problem.pivot_tolerance) || problem.pivot_tolerance <= 0.0 ||
        problem.workspace_budget_bytes == 0) {
        copy_error(
            diagnostics,
            "Floquet dynamic demag-k gauge, pivot tolerance, or workspace budget is invalid");
        return FrequencyDomainStatus::validation_error;
    }
    *factored_phi_dof_count = problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof
        ? problem.phi_dof_count - 1
        : problem.phi_dof_count;
    if (*factored_phi_dof_count == 0) {
        copy_error(
            diagnostics,
            "Floquet dynamic demag-k gauge pinning removes every scalar-potential degree of freedom");
        return FrequencyDomainStatus::validation_error;
    }

    if (!finite_complex_values(problem.a_qphi_row_major, q_phi_count) ||
        !finite_complex_values(problem.p_row_major, phi_phi_count) ||
        !finite_complex_values(problem.a_phiq_row_major, phi_q_count)) {
        copy_error(diagnostics, "Floquet dynamic demag-k blocks must contain finite values");
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t output_dimension = 0;
    if (!checked_product(problem.q_dof_count, 2, &output_dimension) ||
        output_dimension > std::numeric_limits<std::uint64_t>::max() / output_dimension) {
        copy_error(diagnostics, "Floquet dynamic demag-k real-split output size overflow");
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t factor_values = 0;
    std::uint64_t schur_values = 0;
    std::uint64_t rhs_values = 0;
    if (!checked_square(*factored_phi_dof_count, &factor_values) ||
        !checked_square(problem.q_dof_count, &schur_values) ||
        !checked_product(*factored_phi_dof_count, 2, &rhs_values)) {
        copy_error(diagnostics, "Floquet dynamic demag-k workspace size overflow");
        return FrequencyDomainStatus::validation_error;
    }
    // The output buffer belongs to the caller.  The budget covers the copied
    // factor, Schur accumulator, RHS/solution, and pivot bookkeeping.
    const std::uint64_t complex_bytes = sizeof(Complex);
    const std::uint64_t pivot_bytes = sizeof(std::uint64_t);
    long double internal_bytes =
        static_cast<long double>(factor_values + schur_values) * complex_bytes +
        static_cast<long double>(rhs_values) * complex_bytes +
        static_cast<long double>(*factored_phi_dof_count) * pivot_bytes;
    if (!std::isfinite(static_cast<double>(internal_bytes)) ||
        internal_bytes > static_cast<long double>(problem.workspace_budget_bytes)) {
        copy_error(diagnostics, "Floquet dynamic demag-k dense workspace exceeds the configured budget");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

bool factorize(
    std::vector<Complex> &matrix,
    std::uint64_t dimension,
    double pivot_tolerance,
    std::vector<std::uint64_t> &pivot_rows,
    double *max_abs_pivot)
{
    pivot_rows.assign(static_cast<std::size_t>(dimension), 0);
    double observed_max_pivot = 0.0;
    for (std::uint64_t pivot = 0; pivot < dimension; ++pivot) {
        std::uint64_t pivot_row = pivot;
        double pivot_abs = std::abs(matrix[static_cast<std::size_t>(pivot * dimension + pivot)]);
        for (std::uint64_t row = pivot + 1; row < dimension; ++row) {
            const double candidate_abs =
                std::abs(matrix[static_cast<std::size_t>(row * dimension + pivot)]);
            if (candidate_abs > pivot_abs) {
                pivot_abs = candidate_abs;
                pivot_row = row;
            }
        }
        if (!std::isfinite(pivot_abs) || !(pivot_abs > pivot_tolerance)) {
            return false;
        }
        observed_max_pivot = std::max(observed_max_pivot, pivot_abs);
        pivot_rows[static_cast<std::size_t>(pivot)] = pivot_row;
        if (pivot_row != pivot) {
            for (std::uint64_t column = 0; column < dimension; ++column) {
                std::swap(
                    matrix[static_cast<std::size_t>(pivot * dimension + column)],
                    matrix[static_cast<std::size_t>(pivot_row * dimension + column)]);
            }
        }
        const Complex pivot_value = matrix[static_cast<std::size_t>(pivot * dimension + pivot)];
        for (std::uint64_t row = pivot + 1; row < dimension; ++row) {
            const std::size_t row_pivot = static_cast<std::size_t>(row * dimension + pivot);
            const Complex factor = matrix[row_pivot] / pivot_value;
            matrix[row_pivot] = factor;
            for (std::uint64_t column = pivot + 1; column < dimension; ++column) {
                matrix[static_cast<std::size_t>(row * dimension + column)] -=
                    factor * matrix[static_cast<std::size_t>(pivot * dimension + column)];
            }
        }
    }
    if (max_abs_pivot != nullptr) {
        *max_abs_pivot = observed_max_pivot;
    }
    return true;
}

bool solve_factored(
    const std::vector<Complex> &factor,
    const std::vector<std::uint64_t> &pivot_rows,
    std::uint64_t dimension,
    const std::vector<Complex> &rhs,
    std::vector<Complex> &solution)
{
    if (rhs.size() != static_cast<std::size_t>(dimension) ||
        pivot_rows.size() != static_cast<std::size_t>(dimension)) {
        return false;
    }
    solution = rhs;
    for (std::uint64_t pivot = 0; pivot < dimension; ++pivot) {
        const std::uint64_t pivot_row = pivot_rows[static_cast<std::size_t>(pivot)];
        if (pivot_row != pivot) {
            std::swap(
                solution[static_cast<std::size_t>(pivot)],
                solution[static_cast<std::size_t>(pivot_row)]);
        }
        for (std::uint64_t row = pivot + 1; row < dimension; ++row) {
            solution[static_cast<std::size_t>(row)] -=
                factor[static_cast<std::size_t>(row * dimension + pivot)] *
                solution[static_cast<std::size_t>(pivot)];
        }
    }
    for (std::uint64_t back = 0; back < dimension; ++back) {
        const std::uint64_t row = dimension - 1 - back;
        Complex value = solution[static_cast<std::size_t>(row)];
        for (std::uint64_t column = row + 1; column < dimension; ++column) {
            value -= factor[static_cast<std::size_t>(row * dimension + column)] *
                solution[static_cast<std::size_t>(column)];
        }
        const Complex diagonal = factor[static_cast<std::size_t>(row * dimension + row)];
        if (!(std::abs(diagonal) > 0.0) || !std::isfinite(std::abs(diagonal))) {
            return false;
        }
        solution[static_cast<std::size_t>(row)] = value / diagonal;
    }
    for (const Complex value : solution) {
        if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
            return false;
        }
    }
    return true;
}

} // namespace

FrequencyDomainStatus build_floquet_dynamic_demag_k_real_split(
    const FloquetDynamicDemagKProblem &problem,
    double *out_real_split_row_major,
    std::uint64_t out_value_count,
    FloquetDynamicDemagKDiagnostics *out_diagnostics) noexcept
{
    if (out_real_split_row_major == nullptr) {
        copy_error(out_diagnostics, "Floquet dynamic demag-k output buffer is missing");
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t factored_phi_dof_count = 0;
    const FrequencyDomainStatus validation_status =
        validate_problem(problem, &factored_phi_dof_count, out_diagnostics);
    if (validation_status != FrequencyDomainStatus::ok) {
        return validation_status;
    }
    std::uint64_t output_dimension = 0;
    std::uint64_t expected_output_values = 0;
    if (!checked_product(problem.q_dof_count, 2, &output_dimension) ||
        !checked_square(output_dimension, &expected_output_values) ||
        out_value_count != expected_output_values) {
        copy_error(out_diagnostics, "Floquet dynamic demag-k output shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }

    try {
        std::vector<Complex> factor(
            static_cast<std::size_t>(factored_phi_dof_count * factored_phi_dof_count));
        for (std::uint64_t row = 0; row < factored_phi_dof_count; ++row) {
            const std::uint64_t source_row =
                row + (problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1 : 0);
            for (std::uint64_t column = 0; column < factored_phi_dof_count; ++column) {
                const std::uint64_t source_column =
                    column + (problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1 : 0);
                factor[static_cast<std::size_t>(row * factored_phi_dof_count + column)] =
                    problem.p_row_major[static_cast<std::size_t>(source_row * problem.phi_dof_count + source_column)];
            }
        }

        std::vector<std::uint64_t> pivot_rows;
        double max_abs_pivot = 0.0;
        if (factored_phi_dof_count > 0 &&
            !factorize(
                factor,
                factored_phi_dof_count,
                problem.pivot_tolerance,
                pivot_rows,
                &max_abs_pivot)) {
            copy_error(out_diagnostics, "Floquet dynamic demag-k scalar-potential block is singular");
            return FrequencyDomainStatus::operator_error;
        }
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_pivot = max_abs_pivot;
        }

        const std::size_t schur_size =
            static_cast<std::size_t>(problem.q_dof_count * problem.q_dof_count);
        std::vector<Complex> schur(schur_size, Complex(0.0, 0.0));
        std::vector<Complex> rhs(static_cast<std::size_t>(factored_phi_dof_count));
        std::vector<Complex> solution;
        for (std::uint64_t column = 0; column < problem.q_dof_count; ++column) {
            for (std::uint64_t row = 0; row < factored_phi_dof_count; ++row) {
                const std::uint64_t source_row =
                    row + (problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1 : 0);
                rhs[static_cast<std::size_t>(row)] = problem.a_phiq_row_major[
                    static_cast<std::size_t>(source_row * problem.q_dof_count + column)];
            }
            if (factored_phi_dof_count > 0 &&
                !solve_factored(factor, pivot_rows, factored_phi_dof_count, rhs, solution)) {
                copy_error(out_diagnostics, "Floquet dynamic demag-k scalar-potential solve failed");
                return FrequencyDomainStatus::operator_error;
            }
            double rhs_inf_norm = 0.0;
            for (const Complex value : rhs) {
                rhs_inf_norm = std::max(rhs_inf_norm, std::abs(value));
            }
            const double residual_scale = std::max(rhs_inf_norm, 1.0e-300);
            double residual_inf_norm = 0.0;
            for (std::uint64_t row = 0; row < factored_phi_dof_count; ++row) {
                const std::uint64_t source_row =
                    row + (problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1 : 0);
                Complex reconstructed(0.0, 0.0);
                for (std::uint64_t column = 0; column < factored_phi_dof_count; ++column) {
                    const std::uint64_t source_column =
                        column + (problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1 : 0);
                    reconstructed += problem.p_row_major[
                        static_cast<std::size_t>(source_row * problem.phi_dof_count + source_column)] *
                        solution[static_cast<std::size_t>(column)];
                }
                const double residual = std::abs(
                    reconstructed - rhs[static_cast<std::size_t>(row)]);
                if (!std::isfinite(residual)) {
                    copy_error(
                        out_diagnostics,
                        "Floquet dynamic demag-k scalar-potential residual is non-finite");
                    return FrequencyDomainStatus::operator_error;
                }
                residual_inf_norm = std::max(residual_inf_norm, residual);
            }
            const double relative_residual = residual_inf_norm / residual_scale;
            if (!std::isfinite(relative_residual)) {
                copy_error(
                    out_diagnostics,
                    "Floquet dynamic demag-k scalar-potential relative residual is non-finite");
                return FrequencyDomainStatus::operator_error;
            }
            if (out_diagnostics != nullptr) {
                out_diagnostics->max_relative_potential_solve_residual = std::max(
                    out_diagnostics->max_relative_potential_solve_residual,
                    relative_residual);
            }
            for (std::uint64_t row = 0; row < problem.q_dof_count; ++row) {
                Complex feedback(0.0, 0.0);
                for (std::uint64_t phi = 0; phi < factored_phi_dof_count; ++phi) {
                    const std::uint64_t source_phi =
                        phi + (problem.gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1 : 0);
                    feedback += problem.a_qphi_row_major[
                        static_cast<std::size_t>(row * problem.phi_dof_count + source_phi)] *
                        solution[static_cast<std::size_t>(phi)];
                }
                schur[static_cast<std::size_t>(row * problem.q_dof_count + column)] = -feedback;
            }
        }

        double max_abs_schur_entry = 0.0;
        double max_abs_hermitian_residual = 0.0;
        for (std::uint64_t row = 0; row < problem.q_dof_count; ++row) {
            for (std::uint64_t column = 0; column < problem.q_dof_count; ++column) {
                const Complex value = schur[
                    static_cast<std::size_t>(row * problem.q_dof_count + column)];
                const Complex transpose_conjugate = std::conj(schur[
                    static_cast<std::size_t>(column * problem.q_dof_count + row)]);
                max_abs_schur_entry = std::max(max_abs_schur_entry, std::abs(value));
                max_abs_hermitian_residual = std::max(
                    max_abs_hermitian_residual,
                    std::abs(value - transpose_conjugate));
                const std::size_t real_row = static_cast<std::size_t>(row);
                const std::size_t imag_row = static_cast<std::size_t>(problem.q_dof_count + row);
                const std::size_t real_column = static_cast<std::size_t>(column);
                const std::size_t imag_column = static_cast<std::size_t>(problem.q_dof_count + column);
                const std::size_t dimension = static_cast<std::size_t>(output_dimension);
                out_real_split_row_major[real_row * dimension + real_column] = value.real();
                out_real_split_row_major[real_row * dimension + imag_column] = -value.imag();
                out_real_split_row_major[imag_row * dimension + real_column] = value.imag();
                out_real_split_row_major[imag_row * dimension + imag_column] = value.real();
            }
        }
        if (out_diagnostics != nullptr) {
            out_diagnostics->max_abs_schur_entry = max_abs_schur_entry;
            out_diagnostics->max_abs_hermitian_residual = max_abs_hermitian_residual;
        }
    } catch (...) {
        copy_error(out_diagnostics, "Floquet dynamic demag-k dense provider allocation or arithmetic failed");
        return FrequencyDomainStatus::operator_error;
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
