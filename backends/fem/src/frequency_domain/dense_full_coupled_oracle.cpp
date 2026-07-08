#include "frequency_domain/dense_full_coupled_oracle.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr std::uint64_t kMaxDenseOracleDofs = 4096;

void copy_error(DenseFullCoupledOracleDiagnostics *diagnostics, const char *message) noexcept
{
    if (diagnostics == nullptr) {
        return;
    }
    std::strncpy(diagnostics->error_message, message, sizeof(diagnostics->error_message) - 1);
    diagnostics->error_message[sizeof(diagnostics->error_message) - 1] = '\0';
}

bool checked_square_count(std::uint64_t n, std::uint64_t count) noexcept
{
    return n <= std::numeric_limits<std::uint64_t>::max() / n && count == n * n;
}

bool checked_matrix_count(std::uint64_t rows, std::uint64_t cols, std::uint64_t count) noexcept
{
    return cols == 0 || rows <= std::numeric_limits<std::uint64_t>::max() / cols ?
        count == rows * cols :
        false;
}

bool finite_values(const double *values, std::uint64_t count) noexcept
{
    if (values == nullptr) {
        return false;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

bool valid_phi_gauge_policy(DensePhiGaugePolicy policy) noexcept
{
    switch (policy) {
    case DensePhiGaugePolicy::require_invertible:
    case DensePhiGaugePolicy::pin_first_dof:
        return true;
    }
    return false;
}

FrequencyDomainStatus validate_problem(
    const DenseFullCoupledMagnetostaticProblem &problem,
    DenseFullCoupledOracleDiagnostics *diagnostics) noexcept
{
    if (diagnostics != nullptr) {
        *diagnostics = DenseFullCoupledOracleDiagnostics{};
        diagnostics->q_dof_count = problem.q_dof_count;
        diagnostics->phi_dof_count = problem.phi_dof_count;
        diagnostics->phi_gauge_policy = problem.phi_gauge_policy;
    }
    if (problem.q_dof_count == 0 || problem.phi_dof_count == 0 ||
        problem.q_dof_count > kMaxDenseOracleDofs ||
        problem.phi_dof_count > kMaxDenseOracleDofs) {
        copy_error(diagnostics, "dense full-coupled oracle requires small positive q and phi dimensions");
        return FrequencyDomainStatus::validation_error;
    }
    if (!checked_square_count(problem.q_dof_count, problem.a_qq_value_count) ||
        !checked_matrix_count(problem.q_dof_count, problem.phi_dof_count, problem.a_qphi_value_count) ||
        !checked_matrix_count(problem.phi_dof_count, problem.q_dof_count, problem.a_phiq_value_count) ||
        !checked_square_count(problem.phi_dof_count, problem.a_phiphi_value_count) ||
        problem.b_q_value_count != problem.q_dof_count ||
        problem.b_phi_value_count != problem.phi_dof_count) {
        copy_error(diagnostics, "dense full-coupled oracle matrix or RHS shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }
    if (!valid_phi_gauge_policy(problem.phi_gauge_policy)) {
        copy_error(diagnostics, "dense full-coupled oracle phi gauge policy is unknown");
        return FrequencyDomainStatus::validation_error;
    }
    if (!finite_values(problem.a_qq_row_major, problem.a_qq_value_count) ||
        !finite_values(problem.a_qphi_row_major, problem.a_qphi_value_count) ||
        !finite_values(problem.a_phiq_row_major, problem.a_phiq_value_count) ||
        !finite_values(problem.a_phiphi_row_major, problem.a_phiphi_value_count) ||
        !finite_values(problem.b_q, problem.b_q_value_count) ||
        !finite_values(problem.b_phi, problem.b_phi_value_count)) {
        copy_error(diagnostics, "dense full-coupled oracle inputs must be finite");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

bool solve_dense_linear_system(
    const double *matrix_row_major,
    const double *rhs,
    std::uint64_t n,
    double *out_solution) noexcept
{
    std::vector<double> a(matrix_row_major, matrix_row_major + n * n);
    std::vector<double> b(rhs, rhs + n);

    for (std::uint64_t pivot = 0; pivot < n; ++pivot) {
        std::uint64_t pivot_row = pivot;
        double pivot_abs = std::abs(a[pivot * n + pivot]);
        for (std::uint64_t row = pivot + 1; row < n; ++row) {
            const double candidate_abs = std::abs(a[row * n + pivot]);
            if (candidate_abs > pivot_abs) {
                pivot_abs = candidate_abs;
                pivot_row = row;
            }
        }
        if (!(pivot_abs > 1.0e-14) || !std::isfinite(pivot_abs)) {
            return false;
        }
        if (pivot_row != pivot) {
            for (std::uint64_t col = pivot; col < n; ++col) {
                std::swap(a[pivot * n + col], a[pivot_row * n + col]);
            }
            std::swap(b[pivot], b[pivot_row]);
        }

        const double pivot_value = a[pivot * n + pivot];
        for (std::uint64_t row = pivot + 1; row < n; ++row) {
            const double factor = a[row * n + pivot] / pivot_value;
            a[row * n + pivot] = 0.0;
            for (std::uint64_t col = pivot + 1; col < n; ++col) {
                a[row * n + col] -= factor * a[pivot * n + col];
            }
            b[row] -= factor * b[pivot];
        }
    }

    for (std::uint64_t back = 0; back < n; ++back) {
        const std::uint64_t row = n - 1 - back;
        double sum = b[row];
        for (std::uint64_t col = row + 1; col < n; ++col) {
            sum -= a[row * n + col] * out_solution[col];
        }
        const double diagonal = a[row * n + row];
        if (!(std::abs(diagonal) > 1.0e-14) || !std::isfinite(diagonal)) {
            return false;
        }
        out_solution[row] = sum / diagonal;
    }
    return finite_values(out_solution, n);
}

bool solve_dense_pinned_first_phi_system(
    const double *matrix_row_major,
    const double *rhs,
    std::uint64_t n,
    double *out_solution) noexcept
{
    std::fill(out_solution, out_solution + n, 0.0);
    if (n == 1) {
        return std::abs(rhs[0]) <= 1.0e-12;
    }

    const std::uint64_t reduced_n = n - 1;
    std::vector<double> reduced_matrix(reduced_n * reduced_n, 0.0);
    std::vector<double> reduced_rhs(reduced_n, 0.0);
    std::vector<double> reduced_solution(reduced_n, 0.0);
    for (std::uint64_t row = 0; row < reduced_n; ++row) {
        reduced_rhs[row] = rhs[row + 1];
        for (std::uint64_t col = 0; col < reduced_n; ++col) {
            reduced_matrix[row * reduced_n + col] =
                matrix_row_major[(row + 1) * n + (col + 1)];
        }
    }
    if (!solve_dense_linear_system(
            reduced_matrix.data(),
            reduced_rhs.data(),
            reduced_n,
            reduced_solution.data())) {
        return false;
    }
    for (std::uint64_t index = 0; index < reduced_n; ++index) {
        out_solution[index + 1] = reduced_solution[index];
    }

    double max_abs_residual = 0.0;
    double max_abs_rhs = 0.0;
    for (std::uint64_t row = 0; row < n; ++row) {
        double residual = -rhs[row];
        for (std::uint64_t col = 0; col < n; ++col) {
            residual += matrix_row_major[row * n + col] * out_solution[col];
        }
        max_abs_residual = std::max(max_abs_residual, std::abs(residual));
        max_abs_rhs = std::max(max_abs_rhs, std::abs(rhs[row]));
    }
    return max_abs_residual <= 1.0e-10 * std::max(1.0, max_abs_rhs);
}

bool solve_dense_phi_system(
    const DenseFullCoupledMagnetostaticProblem &problem,
    const double *rhs,
    double *out_solution) noexcept
{
    switch (problem.phi_gauge_policy) {
    case DensePhiGaugePolicy::require_invertible:
        return solve_dense_linear_system(
            problem.a_phiphi_row_major,
            rhs,
            problem.phi_dof_count,
            out_solution);
    case DensePhiGaugePolicy::pin_first_dof:
        return solve_dense_pinned_first_phi_system(
            problem.a_phiphi_row_major,
            rhs,
            problem.phi_dof_count,
            out_solution);
    }
    return false;
}

void apply_matrix(
    const double *matrix_row_major,
    std::uint64_t rows,
    std::uint64_t cols,
    const double *x,
    double *out) noexcept
{
    for (std::uint64_t row = 0; row < rows; ++row) {
        double value = 0.0;
        for (std::uint64_t col = 0; col < cols; ++col) {
            value += matrix_row_major[row * cols + col] * x[col];
        }
        out[row] = value;
    }
}

double max_abs_difference(const double *lhs, const double *rhs, std::uint64_t count) noexcept
{
    double result = 0.0;
    for (std::uint64_t index = 0; index < count; ++index) {
        result = std::max(result, std::abs(lhs[index] - rhs[index]));
    }
    return result;
}

double max_abs_value(const double *values, std::uint64_t count) noexcept
{
    double result = 0.0;
    for (std::uint64_t index = 0; index < count; ++index) {
        result = std::max(result, std::abs(values[index]));
    }
    return result;
}

} // namespace

FrequencyDomainStatus build_dense_explicit_schur(
    const DenseSchurExplicitBuilder &builder,
    DenseFullCoupledOracleDiagnostics *out_diagnostics) noexcept
{
    if (builder.problem == nullptr ||
        builder.out_schur_row_major == nullptr ||
        builder.out_reduced_rhs == nullptr) {
        copy_error(out_diagnostics, "dense Schur builder requires problem and output buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const DenseFullCoupledMagnetostaticProblem &problem = *builder.problem;
    FrequencyDomainStatus status = validate_problem(problem, out_diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!checked_square_count(problem.q_dof_count, builder.out_schur_value_count) ||
        builder.out_reduced_rhs_value_count != problem.q_dof_count) {
        copy_error(out_diagnostics, "dense Schur builder output shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t q_count = problem.q_dof_count;
    const std::uint64_t phi_count = problem.phi_dof_count;
    std::vector<double> phi_solution(phi_count, 0.0);
    std::vector<double> rhs(phi_count, 0.0);

    for (std::uint64_t col = 0; col < q_count; ++col) {
        for (std::uint64_t row = 0; row < phi_count; ++row) {
            rhs[row] = problem.a_phiq_row_major[row * q_count + col];
        }
        if (!solve_dense_phi_system(problem, rhs.data(), phi_solution.data())) {
            copy_error(out_diagnostics, "dense Schur builder requires solvable A_phiphi under selected phi gauge");
            return FrequencyDomainStatus::operator_error;
        }
        for (std::uint64_t row = 0; row < q_count; ++row) {
            double feedback = 0.0;
            for (std::uint64_t phi = 0; phi < phi_count; ++phi) {
                feedback += problem.a_qphi_row_major[row * phi_count + phi] *
                    phi_solution[phi];
            }
            builder.out_schur_row_major[row * q_count + col] =
                problem.a_qq_row_major[row * q_count + col] - feedback;
        }
    }

    if (!solve_dense_phi_system(problem, problem.b_phi, phi_solution.data())) {
        copy_error(out_diagnostics, "dense Schur builder requires solvable A_phiphi for RHS reduction under selected phi gauge");
        return FrequencyDomainStatus::operator_error;
    }
    for (std::uint64_t row = 0; row < q_count; ++row) {
        double feedback = 0.0;
        for (std::uint64_t phi = 0; phi < phi_count; ++phi) {
            feedback += problem.a_qphi_row_major[row * phi_count + phi] *
                phi_solution[phi];
        }
        builder.out_reduced_rhs[row] = problem.b_q[row] - feedback;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_dense_full_coupled_schur(
    const DenseFullCoupledMagnetostaticProblem &problem,
    const double *q,
    std::uint64_t q_value_count,
    double *out_schur_q,
    std::uint64_t out_schur_q_value_count,
    DenseFullCoupledOracleDiagnostics *out_diagnostics) noexcept
{
    FrequencyDomainStatus status = validate_problem(problem, out_diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (q == nullptr || out_schur_q == nullptr ||
        q_value_count != problem.q_dof_count ||
        out_schur_q_value_count != problem.q_dof_count ||
        !finite_values(q, q_value_count)) {
        copy_error(out_diagnostics, "dense Schur apply requires finite q and output buffers");
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t q_count = problem.q_dof_count;
    const std::uint64_t phi_count = problem.phi_dof_count;
    std::vector<double> phi_rhs(phi_count, 0.0);
    std::vector<double> phi_solution(phi_count, 0.0);
    std::vector<double> a_qq_q(q_count, 0.0);
    apply_matrix(problem.a_phiq_row_major, phi_count, q_count, q, phi_rhs.data());
    if (!solve_dense_phi_system(problem, phi_rhs.data(), phi_solution.data())) {
        copy_error(out_diagnostics, "dense Schur apply requires solvable A_phiphi under selected phi gauge");
        return FrequencyDomainStatus::operator_error;
    }
    apply_matrix(problem.a_qq_row_major, q_count, q_count, q, a_qq_q.data());
    for (std::uint64_t row = 0; row < q_count; ++row) {
        double feedback = 0.0;
        for (std::uint64_t phi = 0; phi < phi_count; ++phi) {
            feedback += problem.a_qphi_row_major[row * phi_count + phi] *
                phi_solution[phi];
        }
        out_schur_q[row] = a_qq_q[row] - feedback;
    }
    return finite_values(out_schur_q, out_schur_q_value_count) ?
        FrequencyDomainStatus::ok :
        FrequencyDomainStatus::operator_error;
}

FrequencyDomainStatus reconstruct_dense_full_residual_from_schur_solution(
    const FullReducedResidualReconstructionTest &test,
    DenseFullCoupledOracleDiagnostics *out_diagnostics) noexcept
{
    if (test.problem == nullptr ||
        test.q == nullptr ||
        test.reduced_residual == nullptr ||
        test.out_phi == nullptr ||
        test.out_full_residual_q == nullptr ||
        test.out_full_residual_phi == nullptr) {
        copy_error(out_diagnostics, "dense full residual reconstruction requires problem and buffers");
        return FrequencyDomainStatus::validation_error;
    }
    const DenseFullCoupledMagnetostaticProblem &problem = *test.problem;
    FrequencyDomainStatus status = validate_problem(problem, out_diagnostics);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (test.q_value_count != problem.q_dof_count ||
        test.reduced_residual_value_count != problem.q_dof_count ||
        test.out_phi_value_count != problem.phi_dof_count ||
        test.out_full_residual_q_value_count != problem.q_dof_count ||
        test.out_full_residual_phi_value_count != problem.phi_dof_count ||
        !finite_values(test.q, test.q_value_count) ||
        !finite_values(test.reduced_residual, test.reduced_residual_value_count)) {
        copy_error(out_diagnostics, "dense full residual reconstruction shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t q_count = problem.q_dof_count;
    const std::uint64_t phi_count = problem.phi_dof_count;
    std::vector<double> phi_rhs(phi_count, 0.0);
    std::vector<double> a_qq_q(q_count, 0.0);
    std::vector<double> a_qphi_phi(q_count, 0.0);
    std::vector<double> a_phiphi_phi(phi_count, 0.0);
    apply_matrix(problem.a_phiq_row_major, phi_count, q_count, test.q, phi_rhs.data());
    for (std::uint64_t phi = 0; phi < phi_count; ++phi) {
        phi_rhs[phi] = problem.b_phi[phi] - phi_rhs[phi];
    }
    if (!solve_dense_phi_system(problem, phi_rhs.data(), test.out_phi)) {
        copy_error(out_diagnostics, "dense full residual reconstruction requires solvable A_phiphi under selected phi gauge");
        return FrequencyDomainStatus::operator_error;
    }

    apply_matrix(problem.a_qq_row_major, q_count, q_count, test.q, a_qq_q.data());
    apply_matrix(problem.a_qphi_row_major, q_count, phi_count, test.out_phi, a_qphi_phi.data());
    for (std::uint64_t row = 0; row < q_count; ++row) {
        test.out_full_residual_q[row] =
            a_qq_q[row] + a_qphi_phi[row] - problem.b_q[row];
    }

    apply_matrix(problem.a_phiq_row_major, phi_count, q_count, test.q, test.out_full_residual_phi);
    apply_matrix(problem.a_phiphi_row_major, phi_count, phi_count, test.out_phi, a_phiphi_phi.data());
    for (std::uint64_t row = 0; row < phi_count; ++row) {
        test.out_full_residual_phi[row] += a_phiphi_phi[row] - problem.b_phi[row];
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_reduced_residual_mismatch = max_abs_difference(
            test.out_full_residual_q,
            test.reduced_residual,
            q_count);
        out_diagnostics->max_abs_full_q_residual =
            max_abs_value(test.out_full_residual_q, q_count);
        out_diagnostics->max_abs_full_phi_residual =
            max_abs_value(test.out_full_residual_phi, phi_count);
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
