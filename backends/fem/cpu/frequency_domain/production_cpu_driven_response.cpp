#include "cpu/frequency_domain/production_cpu_driven_response.hpp"

#include "frequency_domain/checked_extent.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kTwoPi = 6.28318530717958647692;
constexpr double kResidualConsistencyRatioThreshold = 4.0;
constexpr std::uint64_t kGmresStagnationIterationGate = 256;
constexpr double kGmresStagnationRelativeResidualRatioThreshold = 0.9;
constexpr double kGmresStagnationRelativeResidualFloor = 1.0e-2;

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

void append_residual_history(
    std::vector<double> &history,
    double relative_residual) noexcept
{
    if (!std::isfinite(relative_residual)) {
        return;
    }
    if (!history.empty() && history.back() == relative_residual) {
        return;
    }
    if (history.size() >= kProductionCpuGmresResidualHistoryCapacity) {
        if (history.size() > 1) {
            std::move(
                history.begin() + 2,
                history.end(),
                history.begin() + 1);
            history.back() = relative_residual;
        }
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
    std::uint64_t block_count = 0;
    std::size_t block_bytes = 0;
    if (!checked_mul_u64(problem.tangent_dof_count, 2, block_count) ||
        checked_bytes_limited(
            block_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            block_bytes) != CheckedExtentStatus::ok) {
        copy_error(error_message, "production CPU frequency response block extent is invalid");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.project_block == nullptr) {
        if (output != input) {
            std::memcpy(output, input, block_bytes);
        }
        return FrequencyDomainStatus::ok;
    }
    std::size_t block_size = 0;
    if (!checked_to_size_t(block_count, block_size)) {
        copy_error(error_message, "production CPU frequency response block extent is not addressable");
        return FrequencyDomainStatus::validation_error;
    }
    workspace.resize(block_size);
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
    std::memcpy(output, workspace.data(), block_bytes);
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
    ProductionCpuDrivenResponseResult *result,
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
    if (result != nullptr) {
        ++result->progress_callback_count;
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

std::uint64_t effective_progress_interval_iterations(
    std::uint64_t requested) noexcept
{
    return requested > 0 ?
        requested :
        kProductionCpuDrivenResponseDefaultProgressIntervalIterations;
}

bool should_publish_progress(
    const ProductionCpuDrivenResponseProblem &problem,
    std::uint64_t iteration_count,
    bool converged) noexcept
{
    const std::uint64_t interval =
        effective_progress_interval_iterations(problem.progress_interval_iterations);
    return iteration_count == 0 ||
        converged ||
        iteration_count >= problem.max_iterations ||
        iteration_count % interval == 0;
}

bool gmres_converged(
    const ProductionCpuDrivenResponseProblem &problem,
    double residual_l2,
    double relative_residual_l2) noexcept
{
    return relative_residual_l2 <= problem.relative_tolerance ||
        (problem.absolute_tolerance > 0.0 &&
         residual_l2 <= problem.absolute_tolerance);
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
    ProductionCpuDrivenResponseResult *result,
    double omega,
    const double *input,
    std::vector<double> &workspace,
    double *output,
    char error_message[128]) noexcept
{
    std::uint64_t block_count = 0;
    std::size_t block_size = 0;
    std::size_t block_bytes = 0;
    if (!checked_mul_u64(problem.tangent_dof_count, 2, block_count) ||
        !checked_to_size_t(block_count, block_size) ||
        checked_bytes_limited(
            block_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            block_bytes) != CheckedExtentStatus::ok) {
        copy_error(error_message, "production CPU frequency response preconditioner extent is invalid");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.apply_right_preconditioner == nullptr) {
        if (output != input) {
            std::memcpy(output, input, block_bytes);
        }
        return FrequencyDomainStatus::ok;
    }

    workspace.resize(block_size);
    if (result != nullptr) {
        ++result->right_preconditioner_apply_count;
    }
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
    std::memcpy(output, workspace.data(), block_bytes);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_block_operator(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *result,
    double omega,
    const double *in,
    double *out,
    std::vector<double> &stiffness_workspace,
    std::vector<double> &mass_workspace,
    std::vector<double> &projection_workspace,
    char error_message[128]) noexcept
{
    const std::uint64_t n = problem.tangent_dof_count;
    std::uint64_t block_count = 0;
    std::size_t n_size = 0;
    std::size_t block_size = 0;
    std::size_t block_bytes = 0;
    if (!checked_mul_u64(n, 2, block_count) ||
        !checked_to_size_t(n, n_size) ||
        !checked_to_size_t(block_count, block_size) ||
        checked_bytes_limited(
            block_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            block_bytes) != CheckedExtentStatus::ok) {
        copy_error(error_message, "production CPU frequency response operator extent is invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const double *operator_input = in;
    if (problem.project_block != nullptr) {
        projection_workspace.resize(block_size);
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

    if (result != nullptr) {
        ++result->operator_apply_count;
    }
    FrequencyDomainStatus status = FrequencyDomainStatus::ok;
    if (problem.apply_complex_stiffness != nullptr ||
        problem.apply_complex_mass != nullptr) {
        if (problem.apply_complex_stiffness == nullptr ||
            problem.apply_complex_mass == nullptr) {
            copy_error(error_message, "production CPU frequency response complex operator requires both stiffness and mass callbacks");
            return FrequencyDomainStatus::validation_error;
        }
        std::vector<double> stiffness_imag(n_size);
        std::vector<double> mass_imag(n_size);
        if (result != nullptr) {
            ++result->complex_stiffness_apply_count;
        }
        status = problem.apply_complex_stiffness(
            problem.operator_user_data,
            real_in,
            imag_in,
            stiffness_workspace.data(),
            stiffness_imag.data(),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (!all_finite(stiffness_workspace.data(), n) ||
            !all_finite(stiffness_imag.data(), n)) {
            copy_error(error_message, "production CPU frequency response complex stiffness operator produced non-finite values");
            return FrequencyDomainStatus::operator_error;
        }
        if (result != nullptr) {
            ++result->complex_mass_apply_count;
        }
        status = problem.apply_complex_mass(
            problem.operator_user_data,
            real_in,
            imag_in,
            mass_workspace.data(),
            mass_imag.data(),
            error_message);
        if (status != FrequencyDomainStatus::ok) {
            return status;
        }
        if (!all_finite(mass_workspace.data(), n) ||
            !all_finite(mass_imag.data(), n)) {
            copy_error(error_message, "production CPU frequency response complex mass operator produced non-finite values");
            return FrequencyDomainStatus::operator_error;
        }
        for (std::uint64_t row = 0; row < n; ++row) {
            real_out[row] = stiffness_workspace[row] + omega * mass_imag[row];
            imag_out[row] = stiffness_imag[row] - omega * mass_workspace[row];
        }
    } else {
        if (result != nullptr) {
            ++result->stiffness_apply_count;
        }
        status = problem.apply_stiffness(
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
        if (result != nullptr) {
            ++result->mass_apply_count;
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

        if (result != nullptr) {
            ++result->stiffness_apply_count;
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
        if (result != nullptr) {
            ++result->mass_apply_count;
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
    }
    if (!all_finite(real_out, n)) {
        copy_error(error_message, "production CPU frequency response real block operator produced non-finite values");
        return FrequencyDomainStatus::operator_error;
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
    ProductionCpuDrivenResponseResult *result,
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
    std::uint64_t block_count = 0;
    if (!checked_mul_u64(problem.tangent_dof_count, 2, block_count)) {
        copy_error(error_message, "production CPU frequency response residual extent overflows");
        return FrequencyDomainStatus::validation_error;
    }
    if (all_zero(x.data(), block_count)) {
        for (std::uint64_t index = 0; index < block_count; ++index) {
            residual[index] = rhs[index];
        }
        residual_l2 = norm2(residual.data(), block_count);
        return FrequencyDomainStatus::ok;
    }
    const FrequencyDomainStatus status = apply_block_operator(
        problem,
        result,
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

FrequencyDomainStatus compute_right_preconditioner_probe(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *result,
    double omega,
    const std::vector<double> &rhs,
    std::vector<double> &preconditioner_workspace,
    std::vector<double> &preconditioned_rhs,
    std::vector<double> &operator_output,
    std::vector<double> &stiffness_workspace,
    std::vector<double> &mass_workspace,
    std::vector<double> &projection_workspace,
    double &probe_residual_l2,
    double &probe_relative_residual_l2,
    char error_message[128]) noexcept
{
    std::uint64_t block_count = 0;
    if (!checked_mul_u64(problem.tangent_dof_count, 2, block_count)) {
        copy_error(error_message, "production CPU frequency response probe extent overflows");
        return FrequencyDomainStatus::validation_error;
    }
    const double rhs_l2 = norm2(rhs.data(), block_count);
    if (!(rhs_l2 > 0.0) || !std::isfinite(rhs_l2)) {
        copy_error(error_message, "production CPU frequency response preconditioner probe requires finite RHS");
        return FrequencyDomainStatus::validation_error;
    }
    const FrequencyDomainStatus preconditioner_status = apply_right_preconditioner(
        problem,
        result,
        omega,
        rhs.data(),
        preconditioner_workspace,
        preconditioned_rhs.data(),
        error_message);
    if (preconditioner_status != FrequencyDomainStatus::ok) {
        return preconditioner_status;
    }
    const FrequencyDomainStatus operator_status = apply_block_operator(
        problem,
        result,
        omega,
        preconditioned_rhs.data(),
        operator_output.data(),
        stiffness_workspace,
        mass_workspace,
        projection_workspace,
        error_message);
    if (operator_status != FrequencyDomainStatus::ok) {
        return operator_status;
    }
    for (std::uint64_t index = 0; index < block_count; ++index) {
        operator_output[index] -= rhs[index];
    }
    probe_residual_l2 = norm2(operator_output.data(), block_count);
    probe_relative_residual_l2 = probe_residual_l2 / rhs_l2;
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus solve_frequency_gmres(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *result,
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
    const std::uint64_t restart = std::max<std::uint64_t>(
        1,
        std::min(problem.restart_iterations, problem.max_iterations));
    std::uint64_t block_count = 0;
    std::uint64_t restart_plus_one = 0;
    std::uint64_t basis_count = 0;
    std::uint64_t preconditioned_basis_count = 0;
    std::uint64_t hessenberg_count = 0;
    if (!checked_mul_u64(n, 2, block_count) ||
        !checked_add_u64(restart, 1, restart_plus_one) ||
        !checked_mul_u64(restart_plus_one, block_count, basis_count) ||
        !checked_mul_u64(restart, block_count, preconditioned_basis_count) ||
        !checked_mul_u64(restart_plus_one, restart, hessenberg_count)) {
        copy_error(error_message, "production CPU frequency response Krylov extent overflows");
        return FrequencyDomainStatus::validation_error;
    }
    if (restart > kMaxFrequencyDomainKrylovRestartDimension) {
        copy_error(error_message, "production CPU frequency response Krylov restart exceeds configured workspace limit");
        return FrequencyDomainStatus::validation_error;
    }
    std::size_t block_size = 0;
    std::size_t restart_size = 0;
    std::size_t restart_plus_one_size = 0;
    std::size_t basis_size = 0;
    std::size_t preconditioned_basis_size = 0;
    std::size_t hessenberg_size = 0;
    std::size_t basis_bytes = 0;
    std::size_t preconditioned_basis_bytes = 0;
    std::size_t hessenberg_bytes = 0;
    if (!checked_to_size_t(block_count, block_size) ||
        !checked_to_size_t(restart, restart_size) ||
        !checked_to_size_t(restart_plus_one, restart_plus_one_size) ||
        !checked_to_size_t(basis_count, basis_size) ||
        !checked_to_size_t(preconditioned_basis_count, preconditioned_basis_size) ||
        !checked_to_size_t(hessenberg_count, hessenberg_size) ||
        checked_bytes_limited(
            basis_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            basis_bytes) != CheckedExtentStatus::ok ||
        checked_bytes_limited(
            preconditioned_basis_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            preconditioned_basis_bytes) != CheckedExtentStatus::ok ||
        checked_bytes_limited(
            hessenberg_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            hessenberg_bytes) != CheckedExtentStatus::ok) {
        copy_error(error_message, "production CPU frequency response Krylov workspace exceeds configured limit");
        return FrequencyDomainStatus::validation_error;
    }
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
        result,
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
        result,
        frequency_index,
        frequency_index,
        iteration_count,
        frequency_hz,
        residual_l2,
        relative_residual_l2,
        gmres_converged(problem, residual_l2, relative_residual_l2));
    if (gmres_converged(problem, residual_l2, relative_residual_l2)) {
        return FrequencyDomainStatus::ok;
    }

    std::vector<double> basis(basis_size, 0.0);
    std::vector<double> preconditioned_basis(preconditioned_basis_size, 0.0);
    std::vector<double> h(hessenberg_size, 0.0);
    std::vector<double> cs(restart_size, 0.0);
    std::vector<double> sn(restart_size, 0.0);
    std::vector<double> g(restart_plus_one_size, 0.0);
    std::vector<double> y(restart_size, 0.0);
    std::vector<double> w(block_size, 0.0);
    std::vector<double> preconditioner_workspace(block_size, 0.0);

    while (iteration_count < problem.max_iterations) {
        if (problem.cancel_requested != nullptr &&
            problem.cancel_requested(problem.cancel_user_data)) {
            copy_error(error_message, "production CPU frequency response was interrupted");
            return FrequencyDomainStatus::interrupted;
        }
        if (result != nullptr) {
            ++result->gmres_restart_count;
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
                    result,
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
                result,
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
                if (result != nullptr) {
                    ++result->gmres_orthogonalization_count;
                }
                h[row * restart + column] =
                    dot(w, basis.data() + row * block_count, block_count);
                for (std::uint64_t index = 0; index < block_count; ++index) {
                    w[index] -= h[row * restart + column] *
                        basis[row * block_count + index];
                }
            }
            for (std::uint64_t row = 0; row <= column; ++row) {
                if (result != nullptr) {
                    ++result->gmres_orthogonalization_count;
                }
                const double correction =
                    dot(w, basis.data() + row * block_count, block_count);
                h[row * restart + column] += correction;
                for (std::uint64_t index = 0; index < block_count; ++index) {
                    w[index] -= correction * basis[row * block_count + index];
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
                gmres_converged(problem, residual_l2, relative_residual_l2);
            if (should_publish_progress(problem, iteration_count, false)) {
                publish_progress(
                    problem,
                    result,
                    frequency_index,
                    frequency_index,
                    iteration_count,
                    frequency_hz,
                    residual_l2,
                    relative_residual_l2,
                    false);
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
                copy_error(error_message, "production frequency-response GMRES encountered a singular Krylov basis");
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
            result,
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
        if (std::isfinite(relative_residual_l2) &&
            relative_residual_l2 > problem.relative_tolerance) {
            const double tracked_floor = std::max(
                std::max(last_tracked_relative_residual_l2, problem.relative_tolerance),
                1.0e-30);
            const double consistency_ratio = relative_residual_l2 / tracked_floor;
            if (std::isfinite(consistency_ratio) &&
                consistency_ratio > kResidualConsistencyRatioThreshold) {
                if (result != nullptr) {
                    result->residual_consistency_degraded = true;
                    result->residual_consistency_ratio =
                        std::max(
                            result->residual_consistency_ratio,
                            consistency_ratio);
                    if (problem.auto_disable_harmful_right_preconditioner &&
                        problem.apply_right_preconditioner != nullptr) {
                        result->right_preconditioner_residual_consistency_degraded = true;
                        result->right_preconditioner_residual_consistency_ratio =
                            std::max(
                                result->right_preconditioner_residual_consistency_ratio,
                                consistency_ratio);
                    }
                }
                if (problem.apply_right_preconditioner != nullptr) {
                    copy_error(
                        error_message,
                        "production frequency-response GMRES right preconditioner degraded true residual consistency");
                    return FrequencyDomainStatus::solve_error;
                }
            }
        }
        if (iteration_count >= kGmresStagnationIterationGate &&
            initial_relative_residual_l2_norm > 0.0 &&
            std::isfinite(initial_relative_residual_l2_norm) &&
            std::isfinite(relative_residual_l2)) {
            const double stagnation_ratio =
                relative_residual_l2 / initial_relative_residual_l2_norm;
            if (std::isfinite(stagnation_ratio) &&
                stagnation_ratio > kGmresStagnationRelativeResidualRatioThreshold &&
                relative_residual_l2 > kGmresStagnationRelativeResidualFloor) {
                if (result != nullptr) {
                    result->stagnation_detected = true;
                    result->stagnation_iteration = iteration_count;
                    result->stagnation_relative_residual_ratio = stagnation_ratio;
                }
                copy_error(
                    error_message,
                    "production frequency-response GMRES stagnated");
                return FrequencyDomainStatus::solve_error;
            }
        }
        const bool recomputed_converged =
            gmres_converged(problem, residual_l2, relative_residual_l2);
        if (should_publish_progress(problem, iteration_count, recomputed_converged)) {
            publish_progress(
                problem,
                result,
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

    copy_error(error_message, "production frequency-response GMRES did not converge");
    return FrequencyDomainStatus::solve_error;
}

struct RightPreconditionerPilotMeasurement {
    bool available = false;
    double residual_l2 = 0.0;
    double relative_residual_l2 = 0.0;
};

bool pilot_measurement_is_valid(
    const RightPreconditionerPilotMeasurement &measurement) noexcept
{
    return measurement.available &&
        std::isfinite(measurement.residual_l2) &&
        measurement.residual_l2 >= 0.0 &&
        std::isfinite(measurement.relative_residual_l2) &&
        measurement.relative_residual_l2 >= 0.0;
}

FrequencyDomainStatus run_right_preconditioner_pilot(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *result,
    std::uint64_t frequency_index,
    double frequency_hz,
    const std::vector<double> &rhs,
    std::uint64_t pilot_iterations,
    RightPreconditionerPilotMeasurement &measurement,
    char error_message[128]) noexcept
{
    measurement = RightPreconditionerPilotMeasurement{};
    if (pilot_iterations == 0) {
        return FrequencyDomainStatus::ok;
    }
    const std::uint64_t n = problem.tangent_dof_count;
    std::uint64_t block_count = 0;
    std::size_t n_size = 0;
    std::size_t block_size = 0;
    std::size_t block_bytes = 0;
    if (!checked_mul_u64(n, 2, block_count) ||
        !checked_to_size_t(n, n_size) ||
        !checked_to_size_t(block_count, block_size) ||
        checked_bytes_limited(
            block_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            block_bytes) != CheckedExtentStatus::ok) {
        copy_error(error_message, "production CPU frequency response pilot extent is invalid");
        return FrequencyDomainStatus::validation_error;
    }
    ProductionCpuDrivenResponseProblem pilot_problem = problem;
    pilot_problem.max_iterations = pilot_iterations;
    pilot_problem.restart_iterations = std::max<std::uint64_t>(
        1,
        std::min(problem.restart_iterations, pilot_iterations));
    pilot_problem.progress_callback = nullptr;
    pilot_problem.progress_user_data = nullptr;
    pilot_problem.out_response_real = nullptr;
    pilot_problem.out_response_imag = nullptr;
    pilot_problem.response_capacity = 0;
    pilot_problem.out_residual_l2_norm = nullptr;
    pilot_problem.out_relative_residual_l2_norm = nullptr;
    pilot_problem.residual_capacity = 0;

    std::vector<double> x(block_size, 0.0);
    std::vector<double> residual(block_size, 0.0);
    std::vector<double> operator_output(block_size, 0.0);
    std::vector<double> stiffness_workspace(n_size, 0.0);
    std::vector<double> mass_workspace(n_size, 0.0);
    std::vector<double> projection_workspace(block_size, 0.0);
    double rhs_l2_norm = 0.0;
    double initial_residual_l2_norm = 0.0;
    double initial_relative_residual_l2_norm = 0.0;
    double residual_l2 = 0.0;
    double relative_residual_l2 = 0.0;
    double minimum_relative_residual_l2 = 0.0;
    std::uint64_t minimum_tracked_relative_residual_iteration = 0;
    double last_tracked_relative_residual_l2 = 0.0;
    double last_recomputed_relative_residual_l2 = 0.0;
    std::uint64_t iteration_count = 0;
    std::vector<double> relative_residual_history;
    char pilot_error[128]{};
    const FrequencyDomainStatus status = solve_frequency_gmres(
        pilot_problem,
        result,
        frequency_index,
        frequency_hz,
        rhs,
        x,
        residual,
        operator_output,
        stiffness_workspace,
        mass_workspace,
        projection_workspace,
        rhs_l2_norm,
        initial_residual_l2_norm,
        initial_relative_residual_l2_norm,
        residual_l2,
        relative_residual_l2,
        minimum_relative_residual_l2,
        minimum_tracked_relative_residual_iteration,
        last_tracked_relative_residual_l2,
        last_recomputed_relative_residual_l2,
        iteration_count,
        relative_residual_history,
        pilot_error);
    if (status != FrequencyDomainStatus::ok &&
        status != FrequencyDomainStatus::solve_error) {
        copy_error(error_message, pilot_error);
        return status;
    }
    if (std::isfinite(residual_l2) &&
        residual_l2 >= 0.0 &&
        std::isfinite(relative_residual_l2) &&
        relative_residual_l2 >= 0.0) {
        measurement.available = true;
        measurement.residual_l2 = residual_l2;
        measurement.relative_residual_l2 = relative_residual_l2;
    }
    return FrequencyDomainStatus::ok;
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
    const bool has_real_operator =
        problem.apply_stiffness != nullptr &&
        problem.apply_mass != nullptr;
    const bool has_complex_operator =
        problem.apply_complex_stiffness != nullptr &&
        problem.apply_complex_mass != nullptr;
    if (n == 0 ||
        problem.frequencies_hz == nullptr ||
        problem.frequency_count == 0 ||
        problem.drive_real == nullptr ||
        (!has_real_operator && !has_complex_operator)) {
        copy_error(out_result->error_message, "production CPU frequency response requires operators, frequencies, and drive");
        return FrequencyDomainStatus::validation_error;
    }
    if ((problem.apply_stiffness != nullptr) != (problem.apply_mass != nullptr) ||
        (problem.apply_complex_stiffness != nullptr) !=
            (problem.apply_complex_mass != nullptr)) {
        copy_error(out_result->error_message, "production CPU frequency response has an incomplete operator callback pair");
        return FrequencyDomainStatus::validation_error;
    }
    if (!(problem.relative_tolerance > 0.0) ||
        !std::isfinite(problem.relative_tolerance) ||
        problem.absolute_tolerance < 0.0 ||
        !std::isfinite(problem.absolute_tolerance) ||
        problem.max_iterations == 0 ||
        problem.restart_iterations == 0) {
        copy_error(out_result->error_message, "production CPU frequency response has invalid Krylov solver settings");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.auto_disable_harmful_right_preconditioner &&
        (!(problem.right_preconditioner_probe_disable_relative_threshold > 0.0) ||
         !std::isfinite(problem.right_preconditioner_probe_disable_relative_threshold))) {
        copy_error(out_result->error_message, "production CPU frequency response has invalid right-preconditioner probe fallback threshold");
        return FrequencyDomainStatus::validation_error;
    }
    out_result->solver_relative_tolerance = problem.relative_tolerance;
    out_result->solver_absolute_tolerance = problem.absolute_tolerance;
    out_result->right_preconditioner_applied = problem.apply_right_preconditioner != nullptr;
    out_result->right_preconditioner_probe_disable_relative_threshold =
        problem.auto_disable_harmful_right_preconditioner ?
        problem.right_preconditioner_probe_disable_relative_threshold :
        0.0;
    copy_preconditioner_name(out_result->krylov_preconditioner, problem);
    out_result->max_iterations_for_frequency = problem.max_iterations;
    out_result->restart_iterations_for_frequency = std::max<std::uint64_t>(
        1,
        std::min(problem.restart_iterations, problem.max_iterations));
    if (out_result->restart_iterations_for_frequency >
        kMaxFrequencyDomainKrylovRestartDimension) {
        copy_error(out_result->error_message, "production CPU frequency response Krylov restart exceeds configured workspace limit");
        return FrequencyDomainStatus::validation_error;
    }
    out_result->progress_interval_iterations =
        effective_progress_interval_iterations(problem.progress_interval_iterations);
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
    std::size_t caller_array_bytes = 0;
    const CheckedExtentStatus drive_extent_status = checked_bytes_limited(
        n,
        sizeof(double),
        kMaxFrequencyDomainWorkspaceBytes,
        caller_array_bytes);
    const CheckedExtentStatus frequency_extent_status = checked_bytes_limited(
        problem.frequency_count,
        sizeof(double),
        kMaxFrequencyDomainWorkspaceBytes,
        caller_array_bytes);
    const bool has_response_outputs =
        problem.out_response_real != nullptr || problem.out_response_imag != nullptr;
    const CheckedExtentStatus response_extent_status = has_response_outputs
        ? checked_bytes_limited(
              response_value_count,
              sizeof(double),
              kMaxFrequencyDomainWorkspaceBytes,
              caller_array_bytes)
        : CheckedExtentStatus::ok;
    const bool has_residual_outputs =
        problem.out_residual_l2_norm != nullptr ||
        problem.out_relative_residual_l2_norm != nullptr;
    const CheckedExtentStatus residual_extent_status = has_residual_outputs
        ? checked_bytes_limited(
              problem.frequency_count,
              sizeof(double),
              kMaxFrequencyDomainWorkspaceBytes,
              caller_array_bytes)
        : CheckedExtentStatus::ok;
    if (drive_extent_status == CheckedExtentStatus::arithmetic_overflow ||
        frequency_extent_status == CheckedExtentStatus::arithmetic_overflow ||
        response_extent_status == CheckedExtentStatus::arithmetic_overflow ||
        residual_extent_status == CheckedExtentStatus::arithmetic_overflow) {
        copy_error(out_result->error_message, "production CPU frequency response caller-owned array byte extent overflows");
        return FrequencyDomainStatus::validation_error;
    }
    if (drive_extent_status != CheckedExtentStatus::ok ||
        frequency_extent_status != CheckedExtentStatus::ok ||
        response_extent_status != CheckedExtentStatus::ok ||
        residual_extent_status != CheckedExtentStatus::ok) {
        copy_error(out_result->error_message, "production CPU frequency response caller-owned array exceeds configured workspace limit");
        return FrequencyDomainStatus::validation_error;
    }
    std::size_t n_size = 0;
    std::size_t block_size = 0;
    std::size_t block_bytes = 0;
    if (!checked_to_size_t(n, n_size) ||
        !checked_to_size_t(block_count, block_size) ||
        checked_bytes_limited(
            block_count,
            sizeof(double),
            kMaxFrequencyDomainWorkspaceBytes,
            block_bytes) != CheckedExtentStatus::ok) {
        copy_error(out_result->error_message, "production CPU frequency response workspace exceeds configured limit");
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

    std::vector<double> rhs(block_size, 0.0);
    std::vector<double> x(block_size, 0.0);
    std::vector<double> residual(block_size, 0.0);
    std::vector<double> operator_output(block_size, 0.0);
    std::vector<double> stiffness_workspace(n_size, 0.0);
    std::vector<double> mass_workspace(n_size, 0.0);
    std::vector<double> projection_workspace(block_size, 0.0);
    std::vector<double> preconditioner_probe_workspace(block_size, 0.0);
    std::vector<double> preconditioned_rhs_probe(block_size, 0.0);
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
    ProductionCpuDrivenResponseProblem effective_problem = problem;
    effective_problem.progress_interval_iterations =
        out_result->progress_interval_iterations;
    for (std::uint64_t frequency_index = 0;
         frequency_index < problem.frequency_count;
         ++frequency_index) {
        std::uint64_t response_offset = 0;
        std::uint64_t response_end = 0;
        if (!checked_mul_u64(frequency_index, n, response_offset) ||
            !checked_offset_extent(
                response_offset,
                n,
                response_value_count,
                response_end)) {
            copy_error(out_result->error_message, "production CPU frequency response output extent is invalid");
            return FrequencyDomainStatus::validation_error;
        }
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
        if (frequency_index == 0 && problem.apply_right_preconditioner != nullptr) {
            const double omega =
                problem.angular_frequency_sign * kTwoPi * frequency_hz;
            double probe_residual_l2 = 0.0;
            double probe_relative_residual_l2 = 0.0;
            const FrequencyDomainStatus probe_status =
                compute_right_preconditioner_probe(
                    problem,
                    out_result,
                    omega,
                    rhs,
                    preconditioner_probe_workspace,
                    preconditioned_rhs_probe,
                    operator_output,
                    stiffness_workspace,
                    mass_workspace,
                    projection_workspace,
                    probe_residual_l2,
                    probe_relative_residual_l2,
                    out_result->error_message);
            if (probe_status != FrequencyDomainStatus::ok) {
                return probe_status;
            }
            out_result->right_preconditioner_probe_available = true;
            out_result->right_preconditioner_probe_residual_l2_norm =
                probe_residual_l2;
            out_result->right_preconditioner_probe_relative_residual_l2_norm =
                probe_relative_residual_l2;
            if (problem.auto_disable_harmful_right_preconditioner &&
                probe_relative_residual_l2 >
                    problem.right_preconditioner_probe_disable_relative_threshold) {
                bool selection_resolved_by_pilot = false;
                const std::uint64_t pilot_iterations = std::min(
                    problem.right_preconditioner_auto_pilot_iterations,
                    problem.max_iterations);
                if (pilot_iterations > 0) {
                    RightPreconditionerPilotMeasurement primary_pilot{};
                    RightPreconditionerPilotMeasurement fallback_pilot{};
                    RightPreconditionerPilotMeasurement unpreconditioned_pilot{};
                    FrequencyDomainStatus pilot_status =
                        run_right_preconditioner_pilot(
                            problem,
                            out_result,
                            frequency_index,
                            frequency_hz,
                            rhs,
                            pilot_iterations,
                            primary_pilot,
                            out_result->error_message);
                    if (pilot_status != FrequencyDomainStatus::ok) {
                        return pilot_status;
                    }
                    ProductionCpuDrivenResponseProblem fallback_problem = problem;
                    if (problem.fallback_apply_right_preconditioner != nullptr) {
                        fallback_problem.apply_right_preconditioner =
                            problem.fallback_apply_right_preconditioner;
                        fallback_problem.right_preconditioner_user_data =
                            problem.fallback_right_preconditioner_user_data;
                        fallback_problem.krylov_preconditioner_name =
                            problem.fallback_krylov_preconditioner_name;
                        pilot_status = run_right_preconditioner_pilot(
                            fallback_problem,
                            out_result,
                            frequency_index,
                            frequency_hz,
                            rhs,
                            pilot_iterations,
                            fallback_pilot,
                            out_result->error_message);
                        if (pilot_status != FrequencyDomainStatus::ok) {
                            return pilot_status;
                        }
                    }
                    ProductionCpuDrivenResponseProblem unpreconditioned_problem = problem;
                    unpreconditioned_problem.apply_right_preconditioner = nullptr;
                    unpreconditioned_problem.right_preconditioner_user_data = nullptr;
                    unpreconditioned_problem.krylov_preconditioner_name = nullptr;
                    unpreconditioned_problem.fallback_apply_right_preconditioner = nullptr;
                    unpreconditioned_problem.fallback_right_preconditioner_user_data = nullptr;
                    unpreconditioned_problem.fallback_krylov_preconditioner_name = nullptr;
                    pilot_status = run_right_preconditioner_pilot(
                        unpreconditioned_problem,
                        out_result,
                        frequency_index,
                        frequency_hz,
                        rhs,
                        pilot_iterations,
                        unpreconditioned_pilot,
                        out_result->error_message);
                    if (pilot_status != FrequencyDomainStatus::ok) {
                        return pilot_status;
                    }
                    out_result->right_preconditioner_pilot_available =
                        pilot_measurement_is_valid(primary_pilot) ||
                        pilot_measurement_is_valid(fallback_pilot) ||
                        pilot_measurement_is_valid(unpreconditioned_pilot);
                    out_result->right_preconditioner_pilot_iterations = pilot_iterations;
                    out_result->right_preconditioner_primary_pilot_residual_l2_norm =
                        primary_pilot.residual_l2;
                    out_result->right_preconditioner_primary_pilot_relative_residual_l2_norm =
                        primary_pilot.relative_residual_l2;
                    out_result->right_preconditioner_fallback_pilot_residual_l2_norm =
                        fallback_pilot.residual_l2;
                    out_result->right_preconditioner_fallback_pilot_relative_residual_l2_norm =
                        fallback_pilot.relative_residual_l2;
                    out_result->right_preconditioner_unpreconditioned_pilot_residual_l2_norm =
                        unpreconditioned_pilot.residual_l2;
                    out_result->right_preconditioner_unpreconditioned_pilot_relative_residual_l2_norm =
                        unpreconditioned_pilot.relative_residual_l2;
                    if (out_result->right_preconditioner_pilot_available) {
                        double best_relative =
                            std::numeric_limits<double>::infinity();
                        enum class PilotChoice {
                            none,
                            primary,
                            fallback,
                            unpreconditioned,
                        };
                        PilotChoice best_choice = PilotChoice::none;
                        if (pilot_measurement_is_valid(primary_pilot) &&
                            primary_pilot.relative_residual_l2 < best_relative) {
                            best_relative = primary_pilot.relative_residual_l2;
                            best_choice = PilotChoice::primary;
                        }
                        if (pilot_measurement_is_valid(fallback_pilot) &&
                            fallback_pilot.relative_residual_l2 < best_relative) {
                            best_relative = fallback_pilot.relative_residual_l2;
                            best_choice = PilotChoice::fallback;
                        }
                        if (pilot_measurement_is_valid(unpreconditioned_pilot) &&
                            unpreconditioned_pilot.relative_residual_l2 < best_relative) {
                            best_relative = unpreconditioned_pilot.relative_residual_l2;
                            best_choice = PilotChoice::unpreconditioned;
                        }
                        selection_resolved_by_pilot = best_choice != PilotChoice::none;
                        if (best_choice == PilotChoice::primary) {
                            effective_problem = problem;
                            out_result->right_preconditioner_applied = true;
                            out_result->right_preconditioner_auto_disabled = false;
                            std::strncpy(
                                out_result->right_preconditioner_auto_disable_reason,
                                "pilot_kept_primary_despite_probe",
                                sizeof(out_result->right_preconditioner_auto_disable_reason) - 1);
                        } else if (best_choice == PilotChoice::fallback) {
                            effective_problem.apply_right_preconditioner =
                                fallback_problem.apply_right_preconditioner;
                            effective_problem.right_preconditioner_user_data =
                                fallback_problem.right_preconditioner_user_data;
                            effective_problem.krylov_preconditioner_name =
                                fallback_problem.krylov_preconditioner_name;
                            out_result->right_preconditioner_applied = true;
                            out_result->right_preconditioner_auto_disabled = true;
                            std::strncpy(
                                out_result->right_preconditioner_auto_disable_reason,
                                "pilot_selected_fallback_after_probe",
                                sizeof(out_result->right_preconditioner_auto_disable_reason) - 1);
                        } else if (best_choice == PilotChoice::unpreconditioned) {
                            effective_problem.apply_right_preconditioner = nullptr;
                            effective_problem.right_preconditioner_user_data = nullptr;
                            effective_problem.krylov_preconditioner_name = nullptr;
                            out_result->right_preconditioner_applied = false;
                            out_result->right_preconditioner_auto_disabled = true;
                            std::strncpy(
                                out_result->right_preconditioner_auto_disable_reason,
                                "pilot_selected_unpreconditioned_after_probe",
                                sizeof(out_result->right_preconditioner_auto_disable_reason) - 1);
                        }
                        out_result->right_preconditioner_auto_disable_reason
                            [sizeof(out_result->right_preconditioner_auto_disable_reason) - 1] = '\0';
                        copy_preconditioner_name(
                            out_result->krylov_preconditioner,
                            effective_problem);
                    }
                }
                if (!selection_resolved_by_pilot) {
                    effective_problem.apply_right_preconditioner = nullptr;
                    effective_problem.right_preconditioner_user_data = nullptr;
                    effective_problem.krylov_preconditioner_name = nullptr;
                    if (problem.fallback_apply_right_preconditioner != nullptr) {
                        ProductionCpuDrivenResponseProblem fallback_problem = problem;
                        fallback_problem.apply_right_preconditioner =
                            problem.fallback_apply_right_preconditioner;
                        fallback_problem.right_preconditioner_user_data =
                            problem.fallback_right_preconditioner_user_data;
                        fallback_problem.krylov_preconditioner_name =
                            problem.fallback_krylov_preconditioner_name;
                        double fallback_probe_residual_l2 = 0.0;
                        double fallback_probe_relative_residual_l2 = 0.0;
                        const FrequencyDomainStatus fallback_probe_status =
                            compute_right_preconditioner_probe(
                                fallback_problem,
                                out_result,
                                omega,
                                rhs,
                                preconditioner_probe_workspace,
                                preconditioned_rhs_probe,
                                operator_output,
                                stiffness_workspace,
                                mass_workspace,
                                projection_workspace,
                                fallback_probe_residual_l2,
                                fallback_probe_relative_residual_l2,
                                out_result->error_message);
                        if (fallback_probe_status != FrequencyDomainStatus::ok) {
                            return fallback_probe_status;
                        }
                        out_result->right_preconditioner_fallback_probe_available = true;
                        out_result->right_preconditioner_fallback_probe_residual_l2_norm =
                            fallback_probe_residual_l2;
                        out_result->right_preconditioner_fallback_probe_relative_residual_l2_norm =
                            fallback_probe_relative_residual_l2;
                        if (fallback_probe_relative_residual_l2 <=
                            problem.right_preconditioner_probe_disable_relative_threshold) {
                            effective_problem.apply_right_preconditioner =
                                fallback_problem.apply_right_preconditioner;
                            effective_problem.right_preconditioner_user_data =
                                fallback_problem.right_preconditioner_user_data;
                            effective_problem.krylov_preconditioner_name =
                                fallback_problem.krylov_preconditioner_name;
                        }
                    }
                    out_result->right_preconditioner_applied =
                        effective_problem.apply_right_preconditioner != nullptr;
                    out_result->right_preconditioner_auto_disabled = true;
                    std::strncpy(
                        out_result->right_preconditioner_auto_disable_reason,
                        "probe_relative_residual_above_threshold",
                        sizeof(out_result->right_preconditioner_auto_disable_reason) - 1);
                    out_result
                        ->right_preconditioner_auto_disable_reason
                            [sizeof(out_result->right_preconditioner_auto_disable_reason) - 1] = '\0';
                    copy_preconditioner_name(
                        out_result->krylov_preconditioner,
                        effective_problem);
                }
            }
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
            effective_problem,
            out_result,
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
            if (status == FrequencyDomainStatus::solve_error &&
                problem.out_response_real != nullptr) {
                for (std::uint64_t dof = 0; dof < n; ++dof) {
                    const std::uint64_t response_index = response_offset + dof;
                    problem.out_response_real[response_index] = x[dof];
                    problem.out_response_imag[response_index] = x[dof + n];
                }
            }
            record_block_norms(rhs, residual, x, n, *out_result);
            record_coupled_block_norms(effective_problem, rhs, residual, x, *out_result);
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
                const std::uint64_t response_index = response_offset + dof;
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
            out_result,
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
