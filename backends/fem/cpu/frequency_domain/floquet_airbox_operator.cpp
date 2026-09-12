#include "cpu/frequency_domain/floquet_airbox_operator.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstring>
#include <limits>

namespace fullmag::fem::frequency_domain {
namespace {

using Complex = std::complex<double>;

constexpr std::uint64_t kMaxMaterializedDofs = 512;

void copy_error(FloquetDynamicDemagKDiagnostics &diagnostics, const char *message) noexcept
{
    std::strncpy(diagnostics.error_message, message != nullptr ? message : "", 191u);
    diagnostics.error_message[191] = '\0';
}

bool checked_product(std::uint64_t lhs, std::uint64_t rhs, std::uint64_t *out) noexcept
{
    if (out == nullptr || (rhs != 0u && lhs > std::numeric_limits<std::uint64_t>::max() / rhs)) {
        return false;
    }
    *out = lhs * rhs;
    return true;
}

bool finite_complex(Complex value) noexcept
{
    return std::isfinite(value.real()) && std::isfinite(value.imag());
}

bool matrix_shape(
    const mfem::ComplexSparseMatrix *matrix,
    std::uint64_t *rows,
    std::uint64_t *columns) noexcept
{
    if (matrix == nullptr || rows == nullptr || columns == nullptr) {
        return false;
    }
    const mfem::SparseMatrix &real = matrix->real();
    const mfem::SparseMatrix &imaginary = matrix->imag();
    if (real.Height() != imaginary.Height() || real.Width() != imaginary.Width() ||
        real.Height() <= 0 || real.Width() <= 0) {
        return false;
    }
    *rows = static_cast<std::uint64_t>(real.Height());
    *columns = static_cast<std::uint64_t>(real.Width());
    return true;
}

Complex matrix_entry(const mfem::ComplexSparseMatrix &matrix, int row, int column) noexcept
{
    return Complex(matrix.real()(row, column), matrix.imag()(row, column));
}

bool finite_matrix(const mfem::ComplexSparseMatrix &matrix) noexcept
{
    const mfem::SparseMatrix &real = matrix.real();
    const mfem::SparseMatrix &imaginary = matrix.imag();
    for (int row = 0; row < real.Height(); ++row) {
        for (int column = 0; column < real.Width(); ++column) {
            if (!std::isfinite(real(row, column)) || !std::isfinite(imaginary(row, column))) {
                return false;
            }
        }
    }
    return true;
}

bool dense_workspace_fits(
    std::uint64_t reduced_phi,
    std::uint64_t q,
    FloquetDynamicDemagKGaugePolicy gauge_policy,
    std::uint64_t budget_bytes) noexcept
{
    // P_red, A_phiq and A_qphi are retained simultaneously.  Include the
    // output and the provider's LU/RHS workspace so the single budget bounds
    // the complete bounded bridge rather than each allocation independently.
    const std::uint64_t pinned =
        gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1u : 0u;
    if (reduced_phi <= pinned) {
        return false;
    }
    const std::uint64_t factored_phi = reduced_phi - pinned;
    long double complex_entries = static_cast<long double>(reduced_phi) * reduced_phi +
        static_cast<long double>(reduced_phi) * q * 2.0L +
        static_cast<long double>(factored_phi) * factored_phi +
        static_cast<long double>(q) * q +
        static_cast<long double>(factored_phi) * 2.0L;
    long double byte_count = complex_entries * static_cast<long double>(sizeof(Complex));
    byte_count += static_cast<long double>(factored_phi * sizeof(std::uint64_t));
    byte_count += static_cast<long double>(2u * q) * static_cast<long double>(2u * q) *
        static_cast<long double>(sizeof(double));
    if (!std::isfinite(static_cast<double>(byte_count))) {
        return false;
    }
    return byte_count <= static_cast<long double>(budget_bytes);
}

FrequencyDomainStatus fail(
    FloquetAirboxDynamicDemagKResult *result,
    const char *message,
    FrequencyDomainStatus status = FrequencyDomainStatus::validation_error) noexcept
{
    if (result != nullptr) {
        result->real_split_row_major.clear();
        copy_error(result->diagnostics, message);
    }
    return status;
}

} // namespace

FrequencyDomainStatus assemble_floquet_airbox_dynamic_demag_k(
    const FloquetAirboxDynamicDemagKProblem &problem,
    FloquetAirboxDynamicDemagKResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetAirboxDynamicDemagKResult{};

    if (problem.scalar_operator == nullptr || problem.scalar_constraint == nullptr ||
        problem.tangent_source == nullptr) {
        return fail(out_result, "Floquet airbox dynamic demag-k blocks are missing");
    }

    std::uint64_t full_phi_from_operator = 0;
    std::uint64_t full_phi_columns = 0;
    std::uint64_t constraint_rows = 0;
    std::uint64_t reduced_phi = 0;
    std::uint64_t source_rows = 0;
    std::uint64_t q = 0;
    if (!matrix_shape(
            problem.scalar_operator,
            &full_phi_from_operator,
            &full_phi_columns) ||
        !matrix_shape(problem.scalar_constraint, &constraint_rows, &reduced_phi) ||
        !matrix_shape(problem.tangent_source, &source_rows, &q) ||
        full_phi_from_operator != full_phi_columns ||
        constraint_rows != full_phi_from_operator || source_rows != full_phi_from_operator ||
        full_phi_from_operator > kMaxMaterializedDofs || reduced_phi > kMaxMaterializedDofs ||
        q > kMaxMaterializedDofs) {
        return fail(out_result, "Floquet airbox dynamic demag-k block dimensions are invalid");
    }
    if (problem.scalar_operator->GetConvention() != mfem::ComplexOperator::HERMITIAN ||
        problem.scalar_constraint->GetConvention() != mfem::ComplexOperator::HERMITIAN ||
        problem.tangent_source->GetConvention() != mfem::ComplexOperator::HERMITIAN) {
        return fail(out_result, "Floquet airbox dynamic demag-k blocks require Hermitian convention");
    }
    if (!finite_matrix(*problem.scalar_operator) ||
        !finite_matrix(*problem.scalar_constraint) || !finite_matrix(*problem.tangent_source)) {
        return fail(out_result, "Floquet airbox dynamic demag-k blocks contain non-finite values");
    }
    if (problem.workspace_budget_bytes == 0u ||
        !dense_workspace_fits(
            reduced_phi,
            q,
            problem.gauge_policy,
            problem.workspace_budget_bytes)) {
        return fail(out_result, "Floquet airbox dynamic demag-k materialization exceeds its workspace budget");
    }

    try {
        const int full_phi = static_cast<int>(full_phi_from_operator);
        const int reduced = static_cast<int>(reduced_phi);
        const int q_count = static_cast<int>(q);
        std::vector<Complex> p_reduced(
            static_cast<std::size_t>(reduced_phi * reduced_phi), Complex(0.0, 0.0));
        std::vector<Complex> a_phiq(
            static_cast<std::size_t>(reduced_phi * q), Complex(0.0, 0.0));

        for (int reduced_row = 0; reduced_row < reduced; ++reduced_row) {
            for (int reduced_column = 0; reduced_column < reduced; ++reduced_column) {
                Complex value(0.0, 0.0);
                for (int row = 0; row < full_phi; ++row) {
                    const Complex constraint_row =
                        matrix_entry(*problem.scalar_constraint, row, reduced_row);
                    if (std::abs(constraint_row) == 0.0) {
                        continue;
                    }
                    for (int column = 0; column < full_phi; ++column) {
                        const Complex constraint_column =
                            matrix_entry(*problem.scalar_constraint, column, reduced_column);
                        if (std::abs(constraint_column) == 0.0) {
                            continue;
                        }
                        value += std::conj(constraint_row) *
                            matrix_entry(*problem.scalar_operator, row, column) *
                            constraint_column;
                    }
                }
                if (!finite_complex(value)) {
                    return fail(out_result, "Floquet airbox reduced scalar block is non-finite");
                }
                p_reduced[static_cast<std::size_t>(reduced_row * reduced + reduced_column)] = value;
            }
        }

        for (int reduced_row = 0; reduced_row < reduced; ++reduced_row) {
            for (int column = 0; column < q_count; ++column) {
                Complex value(0.0, 0.0);
                for (int row = 0; row < full_phi; ++row) {
                    value += std::conj(matrix_entry(
                        *problem.scalar_constraint,
                        row,
                        reduced_row)) *
                        matrix_entry(*problem.tangent_source, row, column);
                }
                if (!finite_complex(value)) {
                    return fail(out_result, "Floquet airbox reduced magnetic-potential coupling is non-finite");
                }
                a_phiq[static_cast<std::size_t>(reduced_row * q + column)] = value;
            }
        }

        std::vector<Complex> a_qphi(static_cast<std::size_t>(q * reduced));
        for (std::uint64_t row = 0; row < q; ++row) {
            for (std::uint64_t column = 0; column < reduced_phi; ++column) {
                a_qphi[static_cast<std::size_t>(row * reduced_phi + column)] = std::conj(
                    a_phiq[static_cast<std::size_t>(column * q + row)]);
            }
        }

        FloquetDynamicDemagKProblem schur_problem{};
        schur_problem.q_dof_count = q;
        schur_problem.phi_dof_count = reduced_phi;
        schur_problem.a_qphi_row_major = a_qphi.data();
        schur_problem.a_qphi_value_count = q * reduced_phi;
        schur_problem.p_row_major = p_reduced.data();
        schur_problem.p_value_count = reduced_phi * reduced_phi;
        schur_problem.a_phiq_row_major = a_phiq.data();
        schur_problem.a_phiq_value_count = reduced_phi * q;
        schur_problem.k_rad_per_m[0] = problem.k_rad_per_m[0];
        schur_problem.k_rad_per_m[1] = problem.k_rad_per_m[1];
        schur_problem.k_rad_per_m[2] = problem.k_rad_per_m[2];
        schur_problem.gauge_policy = problem.gauge_policy;
        schur_problem.pivot_tolerance = problem.pivot_tolerance;
        schur_problem.workspace_budget_bytes = problem.workspace_budget_bytes;

        std::uint64_t output_dimension = 0;
        std::uint64_t output_values = 0;
        if (!checked_product(q, 2u, &output_dimension) ||
            !checked_product(output_dimension, output_dimension, &output_values)) {
            return fail(out_result, "Floquet airbox dynamic demag-k output dimensions overflow");
        }
        out_result->real_split_row_major.assign(static_cast<std::size_t>(output_values), 0.0);
        const FrequencyDomainStatus status = build_floquet_dynamic_demag_k_real_split(
            schur_problem,
            out_result->real_split_row_major.data(),
            output_values,
            &out_result->diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            out_result->real_split_row_major.clear();
        }
        return status;
    } catch (...) {
        return fail(
            out_result,
            "Floquet airbox dynamic demag-k materialization failed while allocating workspace",
            FrequencyDomainStatus::operator_error);
    }
}

} // namespace fullmag::fem::frequency_domain

#endif
