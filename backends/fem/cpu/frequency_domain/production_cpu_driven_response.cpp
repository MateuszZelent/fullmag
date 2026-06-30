#include "cpu/frequency_domain/production_cpu_driven_response.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kTwoPi = 6.28318530717958647692;

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

double dot(const std::vector<double> &a, const double *b, std::uint64_t count) noexcept
{
    double value = 0.0;
    for (std::uint64_t index = 0; index < count; ++index) {
        value += a[index] * b[index];
    }
    return value;
}

double norm2(const double *values, std::uint64_t count) noexcept
{
    double value = 0.0;
    for (std::uint64_t index = 0; index < count; ++index) {
        value += values[index] * values[index];
    }
    return std::sqrt(value);
}

double complex_split_norm2(
    const std::vector<double> &values,
    std::uint64_t tangent_dof_count,
    std::uint64_t offset,
    std::uint64_t count) noexcept
{
    if (count == 0 || offset >= tangent_dof_count) {
        return 0.0;
    }
    const std::uint64_t bounded_count =
        std::min<std::uint64_t>(count, tangent_dof_count - offset);
    double value = 0.0;
    for (std::uint64_t index = 0; index < bounded_count; ++index) {
        const std::uint64_t dof = offset + index;
        const double real_part = values[static_cast<std::size_t>(dof)];
        const double imag_part =
            values[static_cast<std::size_t>(dof + tangent_dof_count)];
        value += real_part * real_part + imag_part * imag_part;
    }
    return std::sqrt(value);
}

bool all_finite(const double *values, std::uint64_t count) noexcept
{
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

bool all_zero(const double *values, std::uint64_t count) noexcept
{
    for (std::uint64_t index = 0; index < count; ++index) {
        if (values[index] != 0.0) {
            return false;
        }
    }
    return true;
}

bool checked_mul_u64(
    std::uint64_t lhs,
    std::uint64_t rhs,
    std::uint64_t &out) noexcept
{
    if (lhs != 0 &&
        rhs > std::numeric_limits<std::uint64_t>::max() / lhs) {
        return false;
    }
    out = lhs * rhs;
    return true;
}

void append_residual_history(
    std::vector<double> &history,
    double relative_residual) noexcept
{
    if (history.size() >= kProductionCpuGmresResidualHistoryCapacity ||
        !std::isfinite(relative_residual)) {
        return;
    }
    if (!history.empty() && history.back() == relative_residual) {
        return;
    }
    history.push_back(relative_residual);
}

void copy_residual_history(
    const std::vector<double> &history,
    ProductionCpuDrivenResponseResult &result) noexcept
{
    const std::uint64_t count = std::min<std::uint64_t>(
        static_cast<std::uint64_t>(history.size()),
        kProductionCpuGmresResidualHistoryCapacity);
    result.gmres_relative_residual_history_count = count;
    for (std::uint64_t index = 0; index < count; ++index) {
        result.gmres_relative_residual_history[index] = history[static_cast<std::size_t>(index)];
    }
}

void record_block_norms(
    const std::vector<double> &rhs,
    const std::vector<double> &residual,
    const std::vector<double> &x,
    std::uint64_t tangent_dof_count,
    ProductionCpuDrivenResponseResult &result) noexcept
{
    result.rhs_real_l2_norm = norm2(rhs.data(), tangent_dof_count);
    result.rhs_imag_l2_norm = norm2(rhs.data() + tangent_dof_count, tangent_dof_count);
    result.residual_real_l2_norm = norm2(residual.data(), tangent_dof_count);
    result.residual_imag_l2_norm = norm2(residual.data() + tangent_dof_count, tangent_dof_count);
    result.response_real_l2_norm = norm2(x.data(), tangent_dof_count);
    result.response_imag_l2_norm = norm2(x.data() + tangent_dof_count, tangent_dof_count);
}

void record_coupled_block_norms(
    const ProductionCpuDrivenResponseProblem &problem,
    const std::vector<double> &rhs,
    const std::vector<double> &residual,
    const std::vector<double> &x,
    ProductionCpuDrivenResponseResult &result) noexcept
{
    const std::uint64_t delta_m_count = problem.logical_delta_m_dof_count;
    const std::uint64_t delta_phi_count = problem.logical_delta_phi_dof_count;
    if (delta_m_count == 0 && delta_phi_count == 0) {
        return;
    }
    const std::uint64_t tangent_dof_count = problem.tangent_dof_count;
    result.rhs_delta_m_l2_norm =
        complex_split_norm2(rhs, tangent_dof_count, 0, delta_m_count);
    result.rhs_delta_phi_l2_norm =
        complex_split_norm2(rhs, tangent_dof_count, delta_m_count, delta_phi_count);
    result.residual_delta_m_l2_norm =
        complex_split_norm2(residual, tangent_dof_count, 0, delta_m_count);
    result.residual_delta_phi_l2_norm =
        complex_split_norm2(residual, tangent_dof_count, delta_m_count, delta_phi_count);
    result.response_delta_m_l2_norm =
        complex_split_norm2(x, tangent_dof_count, 0, delta_m_count);
    result.response_delta_phi_l2_norm =
        complex_split_norm2(x, tangent_dof_count, delta_m_count, delta_phi_count);
    result.relative_residual_delta_m_l2_norm =
        result.rhs_delta_m_l2_norm > 0.0
            ? result.residual_delta_m_l2_norm / result.rhs_delta_m_l2_norm
            : 0.0;
    result.relative_residual_delta_phi_l2_norm =
        result.rhs_delta_phi_l2_norm > 0.0
            ? result.residual_delta_phi_l2_norm / result.rhs_delta_phi_l2_norm
            : 0.0;
    result.coupled_block_norms_available = true;
    const char *status =
        problem.coupled_residual_partition_status != nullptr &&
        problem.coupled_residual_partition_status[0] != '\0'
            ? problem.coupled_residual_partition_status
            : "configured";
    std::strncpy(result.coupled_residual_partition_status, status, 63);
    result.coupled_residual_partition_status[63] = '\0';
}

FrequencyDomainStatus project_block_vector(
    const ProductionCpuDrivenResponseProblem &problem,
    const double *input,
    std::vector<double> &workspace,
    double *output,
    char error_message[128]) noexcept
{
    if (problem.project_block == nullptr) {
        if (output != input) {
            std::memcpy(
                output,
                input,
                static_cast<std::size_t>(problem.tangent_dof_count * 2 * sizeof(double)));
        }
        return FrequencyDomainStatus::ok;
    }
    const std::uint64_t block_count = problem.tangent_dof_count * 2;
    workspace.resize(static_cast<std::size_t>(block_count));
    const FrequencyDomainStatus status = problem.project_block(
        problem.project_block_user_data,
        input,
        workspace.data(),
        problem.tangent_dof_count,
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!all_finite(workspace.data(), block_count)) {
        copy_error(error_message, "production CPU frequency response block projector produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    std::memcpy(
        output,
        workspace.data(),
        static_cast<std::size_t>(block_count * sizeof(double)));
    return FrequencyDomainStatus::ok;
}

void apply_givens(double cs, double sn, double &a, double &b) noexcept
{
    const double tmp = cs * a + sn * b;
    b = -sn * a + cs * b;
    a = tmp;
}

void make_givens(double a, double b, double &cs, double &sn) noexcept
{
    const double r = std::hypot(a, b);
    if (r == 0.0) {
        cs = 1.0;
        sn = 0.0;
        return;
    }
    cs = a / r;
    sn = b / r;
}

void publish_progress(
    const ProductionCpuDrivenResponseProblem &problem,
    std::uint64_t frequency_index,
    std::uint64_t completed_frequency_count,
    std::uint64_t iteration_count,
    double frequency_hz,
    double residual_l2,
    double relative_residual_l2,
    bool converged) noexcept
{
    if (problem.progress_callback == nullptr) {
        return;
    }
    problem.progress_callback(
        problem.progress_user_data,
        ProductionCpuDrivenResponseProgress{
            frequency_index,
            completed_frequency_count,
            problem.frequency_count,
            iteration_count,
            frequency_hz,
            residual_l2,
            relative_residual_l2,
            converged,
        });
}

bool should_publish_progress(
    const ProductionCpuDrivenResponseProblem &problem,
    std::uint64_t iteration_count,
    bool converged) noexcept
{
    const std::uint64_t interval = std::max<std::uint64_t>(
        1,
        problem.progress_interval_iterations);
    return iteration_count == 0 ||
        converged ||
        iteration_count >= problem.max_iterations ||
        iteration_count % interval == 0;
}

void copy_preconditioner_name(
    char out[64],
    const ProductionCpuDrivenResponseProblem &problem) noexcept
{
    const char *name = "none";
    if (problem.apply_right_preconditioner != nullptr) {
        name =
            (problem.krylov_preconditioner_name != nullptr &&
             problem.krylov_preconditioner_name[0] != '\0') ?
            problem.krylov_preconditioner_name :
            "custom_right";
    }
    std::strncpy(out, name, 63);
    out[63] = '\0';
}

FrequencyDomainStatus apply_right_preconditioner(
    const ProductionCpuDrivenResponseProblem &problem,
    double omega,
    const double *input,
    std::vector<double> &workspace,
    double *output,
    char error_message[128]) noexcept
{
    const std::uint64_t block_count = problem.tangent_dof_count * 2;
    if (problem.apply_right_preconditioner == nullptr) {
        if (output != input) {
            std::memcpy(output, input, static_cast<std::size_t>(block_count * sizeof(double)));
        }
        return FrequencyDomainStatus::ok;
    }

    workspace.resize(static_cast<std::size_t>(block_count));
    const FrequencyDomainStatus status = problem.apply_right_preconditioner(
        problem.right_preconditioner_user_data,
        omega,
        input,
        workspace.data(),
        problem.tangent_dof_count,
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!all_finite(workspace.data(), block_count)) {
        copy_error(error_message, "production CPU frequency response right preconditioner produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    std::memcpy(output, workspace.data(), static_cast<std::size_t>(block_count * sizeof(double)));
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_block_operator(
    const ProductionCpuDrivenResponseProblem &problem,
    double omega,
    const double *in,
    double *out,
    std::vector<double> &stiffness_workspace,
    std::vector<double> &mass_workspace,
    std::vector<double> &projection_workspace,
    char error_message[128]) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    const double *operator_input = in;
    if (problem.project_block != nullptr) {
        projection_workspace.resize(static_cast<std::size_t>(n * 2));
        const FrequencyDomainStatus projection_status = project_block_vector(
            problem,
            in,
            projection_workspace,
            projection_workspace.data(),
            error_message);
        if (projection_status != FrequencyDomainStatus::ok) {
            return projection_status;
        }
        operator_input = projection_workspace.data();
    }
    const double *real_in = operator_input;
    const double *imag_in = operator_input + n;
    double *real_out = out;
    double *imag_out = out + n;

    FrequencyDomainStatus status = problem.apply_stiffness(
        problem.operator_user_data,
        real_in,
        stiffness_workspace.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!all_finite(stiffness_workspace.data(), n)) {
        copy_error(error_message, "production CPU frequency response stiffness operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    status = problem.apply_mass(
        problem.operator_user_data,
        imag_in,
        mass_workspace.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!all_finite(mass_workspace.data(), n)) {
        copy_error(error_message, "production CPU frequency response mass operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    for (std::uint64_t row = 0; row < n; ++row) {
        real_out[row] = stiffness_workspace[row] + omega * mass_workspace[row];
    }
    if (!all_finite(real_out, n)) {
        copy_error(error_message, "production CPU frequency response real block operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }

    status = problem.apply_stiffness(
        problem.operator_user_data,
        imag_in,
        stiffness_workspace.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!all_finite(stiffness_workspace.data(), n)) {
        copy_error(error_message, "production CPU frequency response stiffness operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    status = problem.apply_mass(
        problem.operator_user_data,
        real_in,
        mass_workspace.data(),
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!all_finite(mass_workspace.data(), n)) {
        copy_error(error_message, "production CPU frequency response mass operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    for (std::uint64_t row = 0; row < n; ++row) {
        imag_out[row] = stiffness_workspace[row] - omega * mass_workspace[row];
    }
    if (!all_finite(imag_out, n)) {
        copy_error(error_message, "production CPU frequency response imaginary block operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
    }
    if (problem.project_block != nullptr) {
        const FrequencyDomainStatus projection_status = project_block_vector(
            problem,
            out,
            projection_workspace,
            out,
            error_message);
        if (projection_status != FrequencyDomainStatus::ok) {
            return projection_status;
        }
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus compute_residual(
    const ProductionCpuDrivenResponseProblem &problem,
    double omega,
    const std::vector<double> &rhs,
    const std::vector<double> &x,
    std::vector<double> &residual,
    std::vector<double> &operator_output,
    std::vector<double> &stiffness_workspace,
    std::vector<double> &mass_workspace,
    std::vector<double> &projection_workspace,
    double &residual_l2,
    char error_message[128]) noexcept
{
    const std::uint64_t block_count = problem.tangent_dof_count * 2;
    if (all_zero(x.data(), block_count)) {
        for (std::uint64_t index = 0; index < block_count; ++index) {
            residual[index] = rhs[index];
        }
        residual_l2 = norm2(residual.data(), block_count);
        return FrequencyDomainStatus::ok;
    }
    const FrequencyDomainStatus status = apply_block_operator(
        problem,
        omega,
        x.data(),
        operator_output.data(),
        stiffness_workspace,
        mass_workspace,
        projection_workspace,
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    for (std::uint64_t index = 0; index < block_count; ++index) {
        residual[index] = rhs[index] - operator_output[index];
    }
    residual_l2 = norm2(residual.data(), block_count);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus solve_frequency_gmres(
    const ProductionCpuDrivenResponseProblem &problem,
    std::uint64_t frequency_index,
    double frequency_hz,
    const std::vector<double> &rhs,
    std::vector<double> &x,
    std::vector<double> &residual,
    std::vector<double> &operator_output,
    std::vector<double> &stiffness_workspace,
    std::vector<double> &mass_workspace,
    std::vector<double> &projection_workspace,
    double &rhs_l2_norm,
    double &initial_residual_l2_norm,
    double &initial_relative_residual_l2_norm,
    double &residual_l2,
    double &relative_residual_l2,
    double &minimum_relative_residual_l2,
    std::uint64_t &minimum_tracked_relative_residual_iteration,
    double &last_tracked_relative_residual_l2,
    double &last_recomputed_relative_residual_l2,
    std::uint64_t &iteration_count,
    std::vector<double> &relative_residual_history,
    char error_message[128]) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    const std::uint64_t block_count = n * 2;
    const std::uint64_t restart = std::max<std::uint64_t>(
        1,
        std::min(problem.restart_iterations, problem.max_iterations));
    const double omega = problem.angular_frequency_sign * kTwoPi * frequency_hz;
    const double rhs_l2 = norm2(rhs.data(), block_count);
    rhs_l2_norm = rhs_l2;
    initial_residual_l2_norm = 0.0;
    initial_relative_residual_l2_norm = 0.0;
    minimum_relative_residual_l2 = 0.0;
    minimum_tracked_relative_residual_iteration = 0;
    last_tracked_relative_residual_l2 = 0.0;
    last_recomputed_relative_residual_l2 = 0.0;
    if (!(rhs_l2 > 0.0) || !std::isfinite(rhs_l2)) {
        copy_error(error_message, "production CPU frequency response requires a finite non-zero drive");
        return FrequencyDomainStatus::validation_error;
    }

    iteration_count = 0;
    FrequencyDomainStatus status = compute_residual(
        problem,
        omega,
        rhs,
        x,
        residual,
        operator_output,
        stiffness_workspace,
        mass_workspace,
        projection_workspace,
        residual_l2,
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    initial_residual_l2_norm = residual_l2;
    relative_residual_l2 = residual_l2 / rhs_l2;
    initial_relative_residual_l2_norm = relative_residual_l2;
    minimum_relative_residual_l2 = relative_residual_l2;
    last_tracked_relative_residual_l2 = relative_residual_l2;
    last_recomputed_relative_residual_l2 = relative_residual_l2;
    append_residual_history(relative_residual_history, relative_residual_l2);
    publish_progress(
        problem,
        frequency_index,
        frequency_index,
        iteration_count,
        frequency_hz,
        residual_l2,
        relative_residual_l2,
        relative_residual_l2 <= problem.relative_tolerance);
    if (relative_residual_l2 <= problem.relative_tolerance) {
        return FrequencyDomainStatus::ok;
    }

    std::vector<double> basis((restart + 1) * block_count, 0.0);
    std::vector<double> preconditioned_basis(restart * block_count, 0.0);
    std::vector<double> h((restart + 1) * restart, 0.0);
    std::vector<double> cs(restart, 0.0);
    std::vector<double> sn(restart, 0.0);
    std::vector<double> g(restart + 1, 0.0);
    std::vector<double> y(restart, 0.0);
    std::vector<double> w(block_count, 0.0);
    std::vector<double> preconditioner_workspace(block_count, 0.0);

    while (iteration_count < problem.max_iterations) {
        if (problem.cancel_requested != nullptr &&
            problem.cancel_requested(problem.cancel_user_data)) {
            copy_error(error_message, "production CPU frequency response was interrupted");
            return FrequencyDomainStatus::interrupted;
        }

        const double beta = residual_l2;
        for (std::uint64_t row = 0; row < block_count; ++row) {
            basis[row] = residual[row] / beta;
        }
        std::fill(h.begin(), h.end(), 0.0);
        std::fill(cs.begin(), cs.end(), 0.0);
        std::fill(sn.begin(), sn.end(), 0.0);
        std::fill(g.begin(), g.end(), 0.0);
        g[0] = beta;

        std::uint64_t used_columns = 0;
        bool converged = false;
        for (std::uint64_t column = 0;
             column < restart && iteration_count < problem.max_iterations;
             ++column) {
            const double *operator_input = basis.data() + column * block_count;
            if (problem.apply_right_preconditioner != nullptr) {
                status = apply_right_preconditioner(
                    problem,
                    omega,
                    basis.data() + column * block_count,
                    preconditioner_workspace,
                    preconditioned_basis.data() + column * block_count,
                    error_message);
                if (status != FrequencyDomainStatus::ok) {
                    return status;
                }
                operator_input = preconditioned_basis.data() + column * block_count;
            }
            status = apply_block_operator(
                problem,
                omega,
                operator_input,
                w.data(),
                stiffness_workspace,
                mass_workspace,
                projection_workspace,
                error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
            for (std::uint64_t row = 0; row <= column; ++row) {
                h[row * restart + column] =
                    dot(w, basis.data() + row * block_count, block_count);
                for (std::uint64_t index = 0; index < block_count; ++index) {
                    w[index] -= h[row * restart + column] *
                        basis[row * block_count + index];
                }
            }
            h[(column + 1) * restart + column] = norm2(w.data(), block_count);
            if (h[(column + 1) * restart + column] > 0.0) {
                for (std::uint64_t index = 0; index < block_count; ++index) {
                    basis[(column + 1) * block_count + index] =
                        w[index] / h[(column + 1) * restart + column];
                }
            }

            for (std::uint64_t row = 0; row < column; ++row) {
                apply_givens(
                    cs[row],
                    sn[row],
                    h[row * restart + column],
                    h[(row + 1) * restart + column]);
            }
            make_givens(
                h[column * restart + column],
                h[(column + 1) * restart + column],
                cs[column],
                sn[column]);
            apply_givens(
                cs[column],
                sn[column],
                h[column * restart + column],
                h[(column + 1) * restart + column]);
            apply_givens(cs[column], sn[column], g[column], g[column + 1]);

            ++iteration_count;
            used_columns = column + 1;
            residual_l2 = std::abs(g[column + 1]);
            relative_residual_l2 = residual_l2 / rhs_l2;
            last_tracked_relative_residual_l2 = relative_residual_l2;
            append_residual_history(relative_residual_history, relative_residual_l2);
            if (relative_residual_l2 < minimum_relative_residual_l2) {
                minimum_relative_residual_l2 = relative_residual_l2;
                minimum_tracked_relative_residual_iteration = iteration_count;
            }
            const bool tracked_converged =
                relative_residual_l2 <= problem.relative_tolerance;
            if (should_publish_progress(problem, iteration_count, tracked_converged)) {
                publish_progress(
                    problem,
                    frequency_index,
                    frequency_index,
                    iteration_count,
                    frequency_hz,
                    residual_l2,
                    relative_residual_l2,
                    tracked_converged);
            }
            if (tracked_converged) {
                converged = true;
                break;
            }
        }

        std::fill(y.begin(), y.end(), 0.0);
        for (std::uint64_t i = used_columns; i > 0; --i) {
            const std::uint64_t row = i - 1;
            double sum = g[row];
            for (std::uint64_t column = row + 1; column < used_columns; ++column) {
                sum -= h[row * restart + column] * y[column];
            }
            const double diagonal = h[row * restart + row];
            if (!(std::abs(diagonal) > 1.0e-30) || !std::isfinite(diagonal)) {
                copy_error(error_message, "production CPU GMRES encountered a singular Krylov basis");
                return FrequencyDomainStatus::solve_error;
            }
            y[row] = sum / diagonal;
        }

        for (std::uint64_t column = 0; column < used_columns; ++column) {
            const double *solution_basis =
                problem.apply_right_preconditioner != nullptr ?
                preconditioned_basis.data() + column * block_count :
                basis.data() + column * block_count;
            for (std::uint64_t index = 0; index < block_count; ++index) {
                x[index] += y[column] * solution_basis[index];
            }
        }
        if (problem.project_block != nullptr) {
            status = project_block_vector(
                problem,
                x.data(),
                w,
                x.data(),
                error_message);
            if (status != FrequencyDomainStatus::ok) {
                return status;
            }
        }

        status = compute_residual(
            problem,
            omega,
            rhs,
            x,
            residual,
            operator_output,
            stiffness_workspace,
            mass_workspace,
            projection_workspace,
            residual_l2,
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        relative_residual_l2 = residual_l2 / rhs_l2;
        last_recomputed_relative_residual_l2 = relative_residual_l2;
        append_residual_history(relative_residual_history, relative_residual_l2);
        if (relative_residual_l2 < minimum_relative_residual_l2) {
            minimum_relative_residual_l2 = relative_residual_l2;
            minimum_tracked_relative_residual_iteration = iteration_count;
        }
        const bool recomputed_converged =
            relative_residual_l2 <= problem.relative_tolerance;
        if (should_publish_progress(problem, iteration_count, recomputed_converged)) {
            publish_progress(
                problem,
                frequency_index,
                frequency_index,
                iteration_count,
                frequency_hz,
                residual_l2,
                relative_residual_l2,
                recomputed_converged);
        }
        if (recomputed_converged) {
            return FrequencyDomainStatus::ok;
        }
    }

    copy_error(error_message, "production CPU GMRES frequency response did not converge");
    return FrequencyDomainStatus::solve_error;
}

} // namespace

FrequencyDomainStatus solve_production_cpu_driven_response(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = ProductionCpuDrivenResponseResult{};
    const std::uint64_t n = problem.tangent_dof_count;
    if (n == 0 ||
        problem.frequencies_hz == nullptr ||
        problem.frequency_count == 0 ||
        problem.drive_real == nullptr ||
        problem.apply_stiffness == nullptr ||
        problem.apply_mass == nullptr) {
        copy_error(out_result->error_message, "production CPU frequency response requires operators, frequencies, and drive");
        return FrequencyDomainStatus::validation_error;
    }
    if (!(problem.relative_tolerance > 0.0) ||
        !std::isfinite(problem.relative_tolerance) ||
        problem.max_iterations == 0 ||
        problem.restart_iterations == 0) {
        copy_error(out_result->error_message, "production CPU frequency response has invalid Krylov solver settings");
        return FrequencyDomainStatus::validation_error;
    }
    out_result->solver_relative_tolerance = problem.relative_tolerance;
    out_result->right_preconditioner_applied = problem.apply_right_preconditioner != nullptr;
    copy_preconditioner_name(out_result->krylov_preconditioner, problem);
    out_result->restart_iterations_for_frequency = std::max<std::uint64_t>(
        1,
        std::min(problem.restart_iterations, problem.max_iterations));
    out_result->progress_interval_iterations = std::max<std::uint64_t>(
        1,
        problem.progress_interval_iterations);
    if (!(std::abs(problem.angular_frequency_sign) == 1.0) ||
        !std::isfinite(problem.angular_frequency_sign)) {
        copy_error(out_result->error_message, "production CPU frequency response has invalid phasor convention sign");
        return FrequencyDomainStatus::validation_error;
    }
    std::uint64_t response_value_count = 0;
    std::uint64_t block_count = 0;
    if (!checked_mul_u64(n, problem.frequency_count, response_value_count) ||
        !checked_mul_u64(n, 2, block_count)) {
        copy_error(out_result->error_message, "production CPU frequency response problem size overflows");
        return FrequencyDomainStatus::validation_error;
    }
    if ((problem.out_response_real != nullptr || problem.out_response_imag != nullptr) &&
        (problem.out_response_real == nullptr ||
            problem.out_response_imag == nullptr ||
            problem.response_capacity < response_value_count)) {
        copy_error(out_result->error_message, "production CPU frequency response has invalid response output buffers");
        return FrequencyDomainStatus::validation_error;
    }
    if ((problem.out_residual_l2_norm != nullptr || problem.out_relative_residual_l2_norm != nullptr) &&
        (problem.out_residual_l2_norm == nullptr ||
            problem.out_relative_residual_l2_norm == nullptr ||
            problem.residual_capacity < problem.frequency_count)) {
        copy_error(out_result->error_message, "production CPU frequency response has invalid residual output buffers");
        return FrequencyDomainStatus::validation_error;
    }

    std::vector<double> rhs(block_count, 0.0);
    std::vector<double> x(block_count, 0.0);
    std::vector<double> residual(block_count, 0.0);
    std::vector<double> operator_output(block_count, 0.0);
    std::vector<double> stiffness_workspace(n, 0.0);
    std::vector<double> mass_workspace(n, 0.0);
    std::vector<double> projection_workspace(block_count, 0.0);
    for (std::uint64_t row = 0; row < n; ++row) {
        const double drive_real = problem.drive_real[row];
        const double drive_imag = problem.drive_imag != nullptr ? problem.drive_imag[row] : 0.0;
        if (!std::isfinite(drive_real) || !std::isfinite(drive_imag)) {
            copy_error(out_result->error_message, "production CPU frequency response has non-finite drive");
            return FrequencyDomainStatus::validation_error;
        }
        rhs[row] = drive_real;
        rhs[row + n] = drive_imag;
    }
    if (problem.project_block != nullptr) {
        const FrequencyDomainStatus projection_status = project_block_vector(
            problem,
            rhs.data(),
            projection_workspace,
            rhs.data(),
            out_result->error_message);
        if (projection_status != FrequencyDomainStatus::ok) {
            return projection_status;
        }
    }

    out_result->response_dof_count = n;
    for (std::uint64_t frequency_index = 0;
         frequency_index < problem.frequency_count;
         ++frequency_index) {
        const double frequency_hz = problem.frequencies_hz[frequency_index];
        if (!(frequency_hz > 0.0) || !std::isfinite(frequency_hz)) {
            copy_error(out_result->error_message, "production CPU frequency response has invalid frequency");
            return FrequencyDomainStatus::validation_error;
        }
        if (problem.cancel_requested != nullptr &&
            problem.cancel_requested(problem.cancel_user_data)) {
            copy_error(out_result->error_message, "production CPU frequency response was interrupted");
            return FrequencyDomainStatus::interrupted;
        }

        double residual_l2 = 0.0;
        double relative_residual_l2 = 0.0;
        double rhs_l2 = 0.0;
        double initial_residual_l2 = 0.0;
        double initial_relative_residual_l2 = 0.0;
        double minimum_relative_residual_l2 = 0.0;
        std::uint64_t minimum_tracked_relative_residual_iteration = 0;
        double last_tracked_relative_residual_l2 = 0.0;
        double last_recomputed_relative_residual_l2 = 0.0;
        std::uint64_t iteration_count = 0;
        std::vector<double> relative_residual_history;
        const FrequencyDomainStatus status = solve_frequency_gmres(
            problem,
            frequency_index,
            frequency_hz,
            rhs,
            x,
            residual,
            operator_output,
            stiffness_workspace,
            mass_workspace,
            projection_workspace,
            rhs_l2,
            initial_residual_l2,
            initial_relative_residual_l2,
            residual_l2,
            relative_residual_l2,
            minimum_relative_residual_l2,
            minimum_tracked_relative_residual_iteration,
            last_tracked_relative_residual_l2,
            last_recomputed_relative_residual_l2,
            iteration_count,
            relative_residual_history,
            out_result->error_message);
        if (status != FrequencyDomainStatus::ok) {
            record_block_norms(rhs, residual, x, n, *out_result);
            record_coupled_block_norms(problem, rhs, residual, x, *out_result);
            copy_residual_history(relative_residual_history, *out_result);
            out_result->total_iteration_count += iteration_count;
            out_result->max_iterations_for_frequency = std::max(
                out_result->max_iterations_for_frequency,
                iteration_count);
            out_result->residual_l2_norm = std::max(out_result->residual_l2_norm, residual_l2);
            out_result->relative_residual_l2_norm = std::max(
                out_result->relative_residual_l2_norm,
                relative_residual_l2);
            out_result->rhs_l2_norm = std::max(out_result->rhs_l2_norm, rhs_l2);
            out_result->initial_residual_l2_norm = std::max(
                out_result->initial_residual_l2_norm,
                initial_residual_l2);
            out_result->initial_relative_residual_l2_norm = std::max(
                out_result->initial_relative_residual_l2_norm,
                initial_relative_residual_l2);
            if (out_result->minimum_tracked_relative_residual_l2_norm == 0.0 ||
                minimum_relative_residual_l2 < out_result->minimum_tracked_relative_residual_l2_norm) {
                out_result->minimum_tracked_relative_residual_l2_norm =
                    minimum_relative_residual_l2;
                out_result->minimum_tracked_relative_residual_iteration =
                    minimum_tracked_relative_residual_iteration;
            }
            out_result->residual_growth_factor =
                initial_relative_residual_l2 > 0.0 ?
                relative_residual_l2 / initial_relative_residual_l2 :
                0.0;
            out_result->last_tracked_relative_residual_l2_norm =
                last_tracked_relative_residual_l2;
            out_result->last_recomputed_relative_residual_l2_norm =
                last_recomputed_relative_residual_l2;
            out_result->max_frequency_hz = std::max(out_result->max_frequency_hz, frequency_hz);
            if (problem.out_residual_l2_norm != nullptr) {
                problem.out_residual_l2_norm[frequency_index] = residual_l2;
                problem.out_relative_residual_l2_norm[frequency_index] = relative_residual_l2;
            }
            return status;
        }

        if (problem.out_response_real != nullptr) {
            for (std::uint64_t dof = 0; dof < n; ++dof) {
                const std::uint64_t response_index = frequency_index * n + dof;
                problem.out_response_real[response_index] = x[dof];
                problem.out_response_imag[response_index] = x[dof + n];
            }
        }
        if (problem.out_residual_l2_norm != nullptr) {
            problem.out_residual_l2_norm[frequency_index] = residual_l2;
            problem.out_relative_residual_l2_norm[frequency_index] = relative_residual_l2;
        }
        for (std::uint64_t dof = 0; dof < n; ++dof) {
            out_result->max_abs_response = std::max(
                out_result->max_abs_response,
                std::hypot(x[dof], x[dof + n]));
        }
        out_result->total_iteration_count += iteration_count;
        record_block_norms(rhs, residual, x, n, *out_result);
        record_coupled_block_norms(problem, rhs, residual, x, *out_result);
        copy_residual_history(relative_residual_history, *out_result);
        out_result->max_iterations_for_frequency = std::max(
            out_result->max_iterations_for_frequency,
            iteration_count);
        out_result->residual_l2_norm = std::max(out_result->residual_l2_norm, residual_l2);
        out_result->relative_residual_l2_norm = std::max(
            out_result->relative_residual_l2_norm,
            relative_residual_l2);
        out_result->rhs_l2_norm = std::max(out_result->rhs_l2_norm, rhs_l2);
        out_result->initial_residual_l2_norm = std::max(
            out_result->initial_residual_l2_norm,
            initial_residual_l2);
        out_result->initial_relative_residual_l2_norm = std::max(
            out_result->initial_relative_residual_l2_norm,
            initial_relative_residual_l2);
        if (out_result->minimum_tracked_relative_residual_l2_norm == 0.0 ||
            minimum_relative_residual_l2 < out_result->minimum_tracked_relative_residual_l2_norm) {
            out_result->minimum_tracked_relative_residual_l2_norm =
                minimum_relative_residual_l2;
            out_result->minimum_tracked_relative_residual_iteration =
                minimum_tracked_relative_residual_iteration;
        }
        out_result->residual_growth_factor =
            initial_relative_residual_l2 > 0.0 ?
            std::max(
                out_result->residual_growth_factor,
                relative_residual_l2 / initial_relative_residual_l2) :
            out_result->residual_growth_factor;
        out_result->last_tracked_relative_residual_l2_norm =
            last_tracked_relative_residual_l2;
        out_result->last_recomputed_relative_residual_l2_norm =
            last_recomputed_relative_residual_l2;
        out_result->max_frequency_hz = std::max(out_result->max_frequency_hz, frequency_hz);
        ++out_result->completed_frequency_count;
        publish_progress(
            problem,
            frequency_index,
            out_result->completed_frequency_count,
            iteration_count,
            frequency_hz,
            residual_l2,
            relative_residual_l2,
            true);
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
