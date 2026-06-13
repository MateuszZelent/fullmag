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

bool all_finite(const double *values, std::uint64_t count) noexcept
{
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index])) {
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

FrequencyDomainStatus apply_block_operator(
    const ProductionCpuDrivenResponseProblem &problem,
    double omega,
    const double *in,
    double *out,
    std::vector<double> &stiffness_workspace,
    std::vector<double> &mass_workspace,
    char error_message[128]) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    const double *real_in = in;
    const double *imag_in = in + n;
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
    double &residual_l2,
    char error_message[128]) noexcept
{
    const std::uint64_t block_count = problem.tangent_dof_count * 2;
    const FrequencyDomainStatus status = apply_block_operator(
        problem,
        omega,
        x.data(),
        operator_output.data(),
        stiffness_workspace,
        mass_workspace,
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
    double &residual_l2,
    double &relative_residual_l2,
    std::uint64_t &iteration_count,
    char error_message[128]) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    const std::uint64_t block_count = n * 2;
    const std::uint64_t restart = std::max<std::uint64_t>(
        1,
        std::min(problem.restart_iterations, problem.max_iterations));
    const double omega = problem.angular_frequency_sign * kTwoPi * frequency_hz;
    const double rhs_l2 = norm2(rhs.data(), block_count);
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
        residual_l2,
        error_message);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    relative_residual_l2 = residual_l2 / rhs_l2;
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
    std::vector<double> h((restart + 1) * restart, 0.0);
    std::vector<double> cs(restart, 0.0);
    std::vector<double> sn(restart, 0.0);
    std::vector<double> g(restart + 1, 0.0);
    std::vector<double> y(restart, 0.0);
    std::vector<double> w(block_count, 0.0);

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
            status = apply_block_operator(
                problem,
                omega,
                basis.data() + column * block_count,
                w.data(),
                stiffness_workspace,
                mass_workspace,
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
            for (std::uint64_t index = 0; index < block_count; ++index) {
                x[index] += y[column] * basis[column * block_count + index];
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
            residual_l2,
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        relative_residual_l2 = residual_l2 / rhs_l2;
        publish_progress(
            problem,
            frequency_index,
            frequency_index,
            iteration_count,
            frequency_hz,
            residual_l2,
            relative_residual_l2,
            converged || relative_residual_l2 <= problem.relative_tolerance);
        if (converged || relative_residual_l2 <= problem.relative_tolerance) {
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
        std::uint64_t iteration_count = 0;
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
            residual_l2,
            relative_residual_l2,
            iteration_count,
            out_result->error_message);
        if (status != FrequencyDomainStatus::ok) {
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
        out_result->max_iterations_for_frequency = std::max(
            out_result->max_iterations_for_frequency,
            iteration_count);
        out_result->residual_l2_norm = std::max(out_result->residual_l2_norm, residual_l2);
        out_result->relative_residual_l2_norm = std::max(
            out_result->relative_residual_l2_norm,
            relative_residual_l2);
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
