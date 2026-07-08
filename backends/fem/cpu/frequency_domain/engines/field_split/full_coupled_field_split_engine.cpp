#include "cpu/frequency_domain/engines/field_split/full_coupled_field_split_engine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr std::uint64_t kMaxPrototypeDofs = 4096;

void copy_error(FullCoupledFieldSplitSolveResult *result, const char *message) noexcept
{
    if (result == nullptr) {
        return;
    }
    std::strncpy(result->error_message, message, sizeof(result->error_message) - 1);
    result->error_message[sizeof(result->error_message) - 1] = '\0';
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

FrequencyDomainStatus validate_operator(
    const FullCoupledBlockOperator &op,
    FullCoupledFieldSplitSolveResult *result) noexcept
{
    if (op.q_dof_count == 0 || op.phi_dof_count == 0 ||
        op.q_dof_count > kMaxPrototypeDofs ||
        op.phi_dof_count > kMaxPrototypeDofs) {
        copy_error(result, "field-split prototype requires small positive q and phi dimensions");
        return FrequencyDomainStatus::validation_error;
    }
    if (!checked_square_count(op.q_dof_count, op.a_qq_value_count) ||
        !checked_matrix_count(op.q_dof_count, op.phi_dof_count, op.a_qphi_value_count) ||
        !checked_matrix_count(op.phi_dof_count, op.q_dof_count, op.a_phiq_value_count) ||
        !checked_square_count(op.phi_dof_count, op.a_phiphi_value_count) ||
        op.b_q_value_count != op.q_dof_count ||
        op.b_phi_value_count != op.phi_dof_count) {
        copy_error(result, "field-split prototype matrix or RHS shape mismatch");
        return FrequencyDomainStatus::validation_error;
    }
    if (!finite_values(op.a_qq_row_major, op.a_qq_value_count) ||
        !finite_values(op.a_qphi_row_major, op.a_qphi_value_count) ||
        !finite_values(op.a_phiq_row_major, op.a_phiq_value_count) ||
        !finite_values(op.a_phiphi_row_major, op.a_phiphi_value_count) ||
        !finite_values(op.b_q, op.b_q_value_count) ||
        !finite_values(op.b_phi, op.b_phi_value_count)) {
        copy_error(result, "field-split prototype inputs must be finite");
        return FrequencyDomainStatus::validation_error;
    }
    for (std::uint64_t row = 0; row < op.q_dof_count; ++row) {
        const double diagonal = op.a_qq_row_major[row * op.q_dof_count + row];
        if (!(std::abs(diagonal) > 1.0e-14) || !std::isfinite(diagonal)) {
            copy_error(result, "field-split prototype requires nonzero A_qq diagonal");
            return FrequencyDomainStatus::validation_error;
        }
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
    std::fill(out_solution, out_solution + n, 0.0);

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

bool initialize_poisson_adapter(
    const FullCoupledBlockOperator &op,
    PoissonBlockSolverAdapter *adapter) noexcept
{
    if (adapter == nullptr) {
        return false;
    }
    adapter->phi_dof_count = op.phi_dof_count;
    adapter->setup_count += 1;
    adapter->solve_count = 0;
    adapter->inverse_row_major.assign(
        static_cast<std::size_t>(op.phi_dof_count * op.phi_dof_count),
        0.0);

    std::vector<double> rhs(static_cast<std::size_t>(op.phi_dof_count), 0.0);
    std::vector<double> solution(static_cast<std::size_t>(op.phi_dof_count), 0.0);
    for (std::uint64_t col = 0; col < op.phi_dof_count; ++col) {
        std::fill(rhs.begin(), rhs.end(), 0.0);
        rhs[static_cast<std::size_t>(col)] = 1.0;
        if (!solve_dense_linear_system(
                op.a_phiphi_row_major,
                rhs.data(),
                op.phi_dof_count,
                solution.data())) {
            return false;
        }
        for (std::uint64_t row = 0; row < op.phi_dof_count; ++row) {
            adapter->inverse_row_major[static_cast<std::size_t>(
                row * op.phi_dof_count + col)] = solution[static_cast<std::size_t>(row)];
        }
    }
    return finite_values(adapter->inverse_row_major.data(), op.phi_dof_count * op.phi_dof_count);
}

bool poisson_solve(
    PoissonBlockSolverAdapter *adapter,
    const double *rhs,
    double *out_solution) noexcept
{
    if (adapter == nullptr || rhs == nullptr || out_solution == nullptr ||
        adapter->phi_dof_count == 0 ||
        adapter->inverse_row_major.size() !=
            static_cast<std::size_t>(adapter->phi_dof_count * adapter->phi_dof_count)) {
        return false;
    }
    for (std::uint64_t row = 0; row < adapter->phi_dof_count; ++row) {
        double value = 0.0;
        for (std::uint64_t col = 0; col < adapter->phi_dof_count; ++col) {
            value += adapter->inverse_row_major[static_cast<std::size_t>(
                row * adapter->phi_dof_count + col)] * rhs[col];
        }
        if (!std::isfinite(value)) {
            return false;
        }
        out_solution[row] = value;
    }
    adapter->solve_count += 1;
    return true;
}

void apply_full_operator(
    const FullCoupledBlockOperator &op,
    const double *q,
    const double *phi,
    double *out_q,
    double *out_phi) noexcept
{
    for (std::uint64_t row = 0; row < op.q_dof_count; ++row) {
        double value = 0.0;
        for (std::uint64_t col = 0; col < op.q_dof_count; ++col) {
            value += op.a_qq_row_major[row * op.q_dof_count + col] * q[col];
        }
        for (std::uint64_t col = 0; col < op.phi_dof_count; ++col) {
            value += op.a_qphi_row_major[row * op.phi_dof_count + col] * phi[col];
        }
        out_q[row] = value;
    }
    for (std::uint64_t row = 0; row < op.phi_dof_count; ++row) {
        double value = 0.0;
        for (std::uint64_t col = 0; col < op.q_dof_count; ++col) {
            value += op.a_phiq_row_major[row * op.q_dof_count + col] * q[col];
        }
        for (std::uint64_t col = 0; col < op.phi_dof_count; ++col) {
            value += op.a_phiphi_row_major[row * op.phi_dof_count + col] * phi[col];
        }
        out_phi[row] = value;
    }
}

double residual_norm(
    const FullCoupledBlockOperator &op,
    const double *q,
    const double *phi,
    std::vector<double> &work_q,
    std::vector<double> &work_phi) noexcept
{
    apply_full_operator(op, q, phi, work_q.data(), work_phi.data());
    double norm_squared = 0.0;
    for (std::uint64_t index = 0; index < op.q_dof_count; ++index) {
        const double residual = op.b_q[index] - work_q[static_cast<std::size_t>(index)];
        norm_squared += residual * residual;
        work_q[static_cast<std::size_t>(index)] = residual;
    }
    for (std::uint64_t index = 0; index < op.phi_dof_count; ++index) {
        const double residual = op.b_phi[index] - work_phi[static_cast<std::size_t>(index)];
        norm_squared += residual * residual;
        work_phi[static_cast<std::size_t>(index)] = residual;
    }
    return std::sqrt(norm_squared);
}

double rhs_norm(const FullCoupledBlockOperator &op) noexcept
{
    double norm_squared = 0.0;
    for (std::uint64_t index = 0; index < op.q_dof_count; ++index) {
        norm_squared += op.b_q[index] * op.b_q[index];
    }
    for (std::uint64_t index = 0; index < op.phi_dof_count; ++index) {
        norm_squared += op.b_phi[index] * op.b_phi[index];
    }
    return std::sqrt(norm_squared);
}

double vector_norm(const double *values, std::uint64_t count) noexcept
{
    double norm_squared = 0.0;
    for (std::uint64_t index = 0; index < count; ++index) {
        norm_squared += values[index] * values[index];
    }
    return std::sqrt(norm_squared);
}

double full_operator_max_abs_row_sum(const FullCoupledBlockOperator &op) noexcept
{
    double max_row_sum = 0.0;
    for (std::uint64_t row = 0; row < op.q_dof_count; ++row) {
        double row_sum = 0.0;
        for (std::uint64_t col = 0; col < op.q_dof_count; ++col) {
            row_sum += std::abs(op.a_qq_row_major[row * op.q_dof_count + col]);
        }
        for (std::uint64_t col = 0; col < op.phi_dof_count; ++col) {
            row_sum += std::abs(op.a_qphi_row_major[row * op.phi_dof_count + col]);
        }
        max_row_sum = std::max(max_row_sum, row_sum);
    }
    for (std::uint64_t row = 0; row < op.phi_dof_count; ++row) {
        double row_sum = 0.0;
        for (std::uint64_t col = 0; col < op.q_dof_count; ++col) {
            row_sum += std::abs(op.a_phiq_row_major[row * op.q_dof_count + col]);
        }
        for (std::uint64_t col = 0; col < op.phi_dof_count; ++col) {
            row_sum += std::abs(op.a_phiphi_row_major[row * op.phi_dof_count + col]);
        }
        max_row_sum = std::max(max_row_sum, row_sum);
    }
    return max_row_sum > 0.0 ? max_row_sum : 1.0;
}

bool apply_field_split_preconditioner(
    FieldSplitPreconditioner &preconditioner,
    const double *residual_q,
    const double *residual_phi,
    double *out_z_q,
    double *out_z_phi,
    std::vector<double> &magnetic_rhs) noexcept
{
    const FullCoupledBlockOperator &op = *preconditioner.op;
    if (!poisson_solve(preconditioner.poisson, residual_phi, out_z_phi)) {
        return false;
    }
    for (std::uint64_t row = 0; row < op.q_dof_count; ++row) {
        double rhs = residual_q[row];
        for (std::uint64_t col = 0; col < op.phi_dof_count; ++col) {
            rhs -= op.a_qphi_row_major[row * op.phi_dof_count + col] * out_z_phi[col];
        }
        magnetic_rhs[static_cast<std::size_t>(row)] = rhs;
        const double diagonal = op.a_qq_row_major[row * op.q_dof_count + row];
        out_z_q[row] = rhs / diagonal;
        if (!std::isfinite(out_z_q[row])) {
            return false;
        }
    }
    return true;
}

double unpreconditioned_reference_final_residual(
    const FullCoupledBlockOperator &op,
    std::uint64_t max_iterations,
    double relaxation) noexcept
{
    std::vector<double> q(static_cast<std::size_t>(op.q_dof_count), 0.0);
    std::vector<double> phi(static_cast<std::size_t>(op.phi_dof_count), 0.0);
    std::vector<double> residual_q(static_cast<std::size_t>(op.q_dof_count), 0.0);
    std::vector<double> residual_phi(static_cast<std::size_t>(op.phi_dof_count), 0.0);
    double residual_l2 = residual_norm(op, q.data(), phi.data(), residual_q, residual_phi);
    const double step_scale = full_operator_max_abs_row_sum(op);
    for (std::uint64_t iteration = 0; iteration < max_iterations; ++iteration) {
        for (std::uint64_t index = 0; index < op.q_dof_count; ++index) {
            q[static_cast<std::size_t>(index)] +=
                relaxation * residual_q[static_cast<std::size_t>(index)] / step_scale;
        }
        for (std::uint64_t index = 0; index < op.phi_dof_count; ++index) {
            phi[static_cast<std::size_t>(index)] +=
                relaxation * residual_phi[static_cast<std::size_t>(index)] / step_scale;
        }
        residual_l2 = residual_norm(op, q.data(), phi.data(), residual_q, residual_phi);
        if (!std::isfinite(residual_l2)) {
            return std::numeric_limits<double>::infinity();
        }
    }
    return residual_l2;
}

} // namespace

FrequencyDomainStatus initialize_field_split_preconditioner(
    const FieldSplitPreconditionerSetup &setup,
    FieldSplitPreconditioner *out_preconditioner) noexcept
{
    if (setup.op == nullptr || setup.poisson == nullptr || out_preconditioner == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    FullCoupledFieldSplitSolveResult validation_result{};
    FrequencyDomainStatus status = validate_operator(*setup.op, &validation_result);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!initialize_poisson_adapter(*setup.op, setup.poisson)) {
        return FrequencyDomainStatus::operator_error;
    }
    out_preconditioner->op = setup.op;
    out_preconditioner->poisson = setup.poisson;
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus solve_full_coupled_field_split(
    const FullCoupledFieldSplitProblem &problem,
    FullCoupledFieldSplitSolveResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FullCoupledFieldSplitSolveResult{};
    if (problem.op == nullptr ||
        problem.preconditioner == nullptr ||
        problem.preconditioner->op != problem.op ||
        problem.preconditioner->poisson == nullptr ||
        problem.out_q == nullptr ||
        problem.out_phi == nullptr ||
        problem.max_iterations == 0 ||
        problem.out_q_capacity < problem.op->q_dof_count ||
        problem.out_phi_capacity < problem.op->phi_dof_count ||
        !std::isfinite(problem.relaxation) ||
        !(problem.relaxation > 0.0)) {
        copy_error(out_result, "field-split solve requires initialized operator, preconditioner, outputs, and positive iteration policy");
        return FrequencyDomainStatus::validation_error;
    }
    FrequencyDomainStatus status = validate_operator(*problem.op, out_result);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }

    const FullCoupledBlockOperator &op = *problem.op;
    std::fill(problem.out_q, problem.out_q + op.q_dof_count, 0.0);
    std::fill(problem.out_phi, problem.out_phi + op.phi_dof_count, 0.0);

    std::vector<double> residual_q(static_cast<std::size_t>(op.q_dof_count), 0.0);
    std::vector<double> residual_phi(static_cast<std::size_t>(op.phi_dof_count), 0.0);
    std::vector<double> z_q(static_cast<std::size_t>(op.q_dof_count), 0.0);
    std::vector<double> z_phi(static_cast<std::size_t>(op.phi_dof_count), 0.0);
    std::vector<double> magnetic_rhs(static_cast<std::size_t>(op.q_dof_count), 0.0);

    const double rhs_l2 = rhs_norm(op);
    const double relative_denominator = rhs_l2 > 0.0 ? rhs_l2 : 1.0;
    const double phi_rhs_l2 = vector_norm(op.b_phi, op.phi_dof_count);
    const double relative_phi_denominator = phi_rhs_l2 > 0.0 ? phi_rhs_l2 : 1.0;
    out_result->initial_residual_l2_norm =
        residual_norm(op, problem.out_q, problem.out_phi, residual_q, residual_phi);
    out_result->initial_relative_residual_l2_norm =
        out_result->initial_residual_l2_norm / relative_denominator;
    out_result->initial_phi_residual_l2_norm =
        vector_norm(residual_phi.data(), op.phi_dof_count);
    out_result->initial_relative_phi_residual_l2_norm =
        out_result->initial_phi_residual_l2_norm / relative_phi_denominator;
    out_result->unpreconditioned_reference_final_residual_l2_norm =
        unpreconditioned_reference_final_residual(
            op,
            problem.max_iterations,
            problem.relaxation);
    out_result->unpreconditioned_reference_final_relative_residual_l2_norm =
        out_result->unpreconditioned_reference_final_residual_l2_norm / relative_denominator;

    for (std::uint64_t iteration = 0; iteration < problem.max_iterations; ++iteration) {
        if (!apply_field_split_preconditioner(
                *problem.preconditioner,
                residual_q.data(),
                residual_phi.data(),
                z_q.data(),
                z_phi.data(),
                magnetic_rhs)) {
            copy_error(out_result, "field-split preconditioner application failed");
            return FrequencyDomainStatus::operator_error;
        }
        for (std::uint64_t index = 0; index < op.q_dof_count; ++index) {
            problem.out_q[index] += problem.relaxation * z_q[static_cast<std::size_t>(index)];
        }
        for (std::uint64_t index = 0; index < op.phi_dof_count; ++index) {
            problem.out_phi[index] += problem.relaxation * z_phi[static_cast<std::size_t>(index)];
        }
        out_result->completed_iterations = iteration + 1;
        out_result->final_residual_l2_norm =
            residual_norm(op, problem.out_q, problem.out_phi, residual_q, residual_phi);
        out_result->final_relative_residual_l2_norm =
            out_result->final_residual_l2_norm / relative_denominator;
        out_result->final_phi_residual_l2_norm =
            vector_norm(residual_phi.data(), op.phi_dof_count);
        out_result->final_relative_phi_residual_l2_norm =
            out_result->final_phi_residual_l2_norm / relative_phi_denominator;
        if (!std::isfinite(out_result->final_relative_residual_l2_norm)) {
            copy_error(out_result, "field-split solve produced nonfinite residual");
            return FrequencyDomainStatus::solve_error;
        }
    }

    out_result->poisson_setup_count = problem.preconditioner->poisson->setup_count;
    out_result->poisson_solve_count = problem.preconditioner->poisson->solve_count;
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
