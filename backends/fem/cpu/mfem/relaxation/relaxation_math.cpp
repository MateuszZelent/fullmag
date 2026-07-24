#include "cpu/mfem/relaxation/relaxation_math.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "fem_common.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "src/relaxation_numerics.hpp"
#include "src/relaxation_operator_units.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace fullmag::fem::relaxation {

namespace {

inline constexpr double kPreconditionerSolveRelativeTolerance = 1.0e-8;
inline constexpr double kPreconditionerSolveAbsoluteTolerance = 1.0e-24;
inline constexpr int kPreconditionerSolveMaximumIterations = 20000;
inline constexpr double kMagnetizationUnitNormTolerance = 1.0e-8;

double dot3(
    const std::vector<double> &a,
    const std::vector<double> &b,
    size_t base)
{
    return a[base + 0] * b[base + 0] +
        a[base + 1] * b[base + 1] +
        a[base + 2] * b[base + 2];
}

double invalid_metric_value()
{
    return std::numeric_limits<double>::quiet_NaN();
}

bool magnetic_node(const Context &ctx, size_t node)
{
    return ctx.mesh.magnetic_node_mask.empty() ||
        ctx.mesh.magnetic_node_mask[node] != 0u;
}

#if FULLMAG_HAS_MFEM_STACK

bool all_finite(const std::vector<double> &values)
{
    return std::all_of(
        values.begin(),
        values.end(),
        [](double value) { return std::isfinite(value); });
}

int set_relaxation_magnetization_state(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::string &prefix,
    std::string &error)
{
    std::vector<double> uploaded_m(m_xyz.begin(), m_xyz.end());
    project_static_periodic_aos(ctx, uploaded_m);
    if (!normalize_active_magnetization_aos(ctx, uploaded_m, error)) {
        error = prefix + ": " + error;
        return FULLMAG_FEM_ERR_INVALID;
    }
    ctx.state.m_xyz = std::move(uploaded_m);
    ctx.relaxation.cached_current_stats_valid = false;
    ctx.stepper.workspace.fsal_valid = false;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.adaptive_dt.has_prev_error_norm = false;
    ctx.demag.cache_valid = false;
    ctx.demag.last_refresh_time = -1.0;
    ctx.thermal_brown.sigma = 0.0;
    std::fill(ctx.thermal_brown.h_xyz.begin(), ctx.thermal_brown.h_xyz.end(), 0.0);
    ctx.thermal_brown.last_refresh_time = -1.0;
    ctx.thermal_brown.last_refresh_dt = -1.0;
    return FULLMAG_FEM_OK;
}

bool apply_sparse_operator_to_field(
    mfem::SparseMatrix &op,
    const std::vector<double> &field_xyz,
    std::vector<double> &operator_field_xyz)
{
    const int nodes = static_cast<int>(field_xyz.size() / 3u);
    mfem::Vector component_in(nodes);
    mfem::Vector component_out(nodes);
    operator_field_xyz.assign(field_xyz.size(), 0.0);
    for (int component = 0; component < 3; ++component) {
        double *in_data = audited_host_write(component_in);
        for (int node = 0; node < nodes; ++node) {
            in_data[node] =
                field_xyz[static_cast<size_t>(node) * 3u + static_cast<size_t>(component)];
        }
        op.Mult(component_in, component_out);
        const double *out_data = audited_host_read(component_out);
        for (int node = 0; node < nodes; ++node) {
            operator_field_xyz[static_cast<size_t>(node) * 3u +
                static_cast<size_t>(component)] = out_data[node];
        }
    }
    return all_finite(operator_field_xyz);
}

void add_sparse_matrix_row(
    mfem::SparseMatrix &target,
    mfem::SparseMatrix &source,
    int row,
    double scale)
{
    mfem::Array<int> cols;
    mfem::Vector vals;
    source.GetRow(row, cols, vals);
    for (int entry = 0; entry < cols.Size(); ++entry) {
        const double value = scale * vals[entry];
        if (value != 0.0) {
            target.Add(row, cols[entry], value);
        }
    }
}

std::unique_ptr<mfem::SparseMatrix> assemble_exchange_mass_preconditioner(
    mfem::SparseMatrix &mass,
    mfem::SparseMatrix &exchange,
    double exchange_weight)
{
    auto op = std::make_unique<mfem::SparseMatrix>(mass.Height(), mass.Width());
    for (int row = 0; row < mass.Height(); ++row) {
        mfem::Array<int> cols;
        mfem::Vector vals;
        mass.GetRow(row, cols, vals);
        if (cols.Size() == 0) {
            op->Add(row, row, 1.0);
        } else {
            add_sparse_matrix_row(*op, mass, row, 1.0);
            add_sparse_matrix_row(*op, exchange, row, exchange_weight);
        }
    }
    op->Finalize();
    return op;
}

mfem::SparseMatrix &cached_exchange_mass_preconditioner(
    Context &ctx,
    mfem::SparseMatrix &mass,
    mfem::SparseMatrix &exchange,
    double exchange_weight,
    uint32_t *cache_hits,
    uint32_t *cache_misses)
{
    auto &cache = ctx.relaxation;
    const bool reusable =
        cache.exchange_mass_preconditioner != nullptr &&
        cache.exchange_mass_preconditioner_mass == &mass &&
        cache.exchange_mass_preconditioner_exchange == &exchange &&
        cache.exchange_mass_preconditioner_weight == exchange_weight &&
        cache.exchange_mass_preconditioner_height == mass.Height() &&
        cache.exchange_mass_preconditioner_width == mass.Width();
    if (reusable) {
        if (cache_hits != nullptr) {
            *cache_hits += 1u;
        }
        return *cache.exchange_mass_preconditioner;
    }

    if (cache_misses != nullptr) {
        *cache_misses += 1u;
    }
    destroy_exchange_mass_preconditioner_cache(ctx);
    cache.exchange_mass_preconditioner =
        assemble_exchange_mass_preconditioner_for_step(
            mass, exchange, exchange_weight).release();
    cache.exchange_mass_preconditioner_mass = &mass;
    cache.exchange_mass_preconditioner_exchange = &exchange;
    cache.exchange_mass_preconditioner_weight = exchange_weight;
    cache.exchange_mass_preconditioner_height = mass.Height();
    cache.exchange_mass_preconditioner_width = mass.Width();
    return *cache.exchange_mass_preconditioner;
}

bool solve_scalar_mfem_cg_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    mfem::GSSmoother preconditioner(op);
    mfem::CGSolver solver;
    solver.SetRelTol(kPreconditionerSolveRelativeTolerance);
    solver.SetAbsTol(kPreconditionerSolveAbsoluteTolerance);
    solver.SetMaxIter(kPreconditionerSolveMaximumIterations);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetPreconditioner(preconditioner);
    solver.SetOperator(op);
    solution.SetSize(rhs.Size());
    solution = 0.0;
    solver.Mult(rhs, solution);
    if (!std::isfinite(solution.Norml2())) {
        error = "direct FEM relaxation MFEM preconditioner solve produced non-finite values";
        return false;
    }
    const double initial_residual = static_cast<double>(solver.GetInitialNorm());
    const double final_residual = static_cast<double>(solver.GetFinalNorm());
    if (!std::isfinite(initial_residual) || !std::isfinite(final_residual)) {
        error = "direct FEM relaxation MFEM preconditioner solve produced non-finite residual diagnostics";
        return false;
    }
    const double residual_limit = std::max(
        kPreconditionerSolveAbsoluteTolerance,
        kPreconditionerSolveRelativeTolerance * std::max(1.0, initial_residual));
    if (!solver.GetConverged() || final_residual > residual_limit) {
        error =
            "direct FEM relaxation MFEM preconditioner solve did not converge: iterations=" +
            std::to_string(solver.GetNumIterations()) +
            " final_residual=" + std::to_string(final_residual) +
            " limit=" + std::to_string(residual_limit);
        return false;
    }
    return true;
}

#ifdef MFEM_USE_MPI

bool validate_hypre_relative_residual(
    double final_relative_residual,
    double rhs_norm,
    int iterations,
    const char *label,
    std::string &error)
{
    if (!std::isfinite(final_relative_residual)) {
        error = std::string(label) + " produced a non-finite relative residual";
        return false;
    }
    if (final_relative_residual < 0.0) {
        error = std::string(label) + " produced a negative relative residual";
        return false;
    }
    const double final_absolute_residual =
        final_relative_residual * std::max(rhs_norm, 0.0);
    if (final_relative_residual <= kPreconditionerSolveRelativeTolerance ||
        final_absolute_residual <= kPreconditionerSolveAbsoluteTolerance) {
        return true;
    }
    error = std::string(label) + " did not converge: iterations=" +
        std::to_string(iterations) +
        " final_relative_residual=" +
        std::to_string(final_relative_residual) +
        " final_absolute_residual=" +
        std::to_string(final_absolute_residual) +
        " relative_limit=" +
        std::to_string(kPreconditionerSolveRelativeTolerance) +
        " absolute_limit=" +
        std::to_string(kPreconditionerSolveAbsoluteTolerance);
    return false;
}

bool forced_hypre_direct_minimizer_preconditioner()
{
    const char *solver = std::getenv("FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "hypre") == 0 || std::strcmp(solver, "HYPRE") == 0);
}

bool forced_serial_direct_minimizer_preconditioner()
{
    const char *solver = std::getenv("FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "mfem_serial") == 0 ||
         std::strcmp(solver, "serial") == 0 ||
         std::strcmp(solver, "MFEM_SERIAL") == 0 ||
         std::strcmp(solver, "SERIAL") == 0);
}

bool openmpi_singleton_can_create_socket()
{
#if defined(__unix__)
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        ::close(fd);
        return true;
    }
    return false;
#else
    return true;
#endif
}

bool should_use_hypre_direct_minimizer_preconditioner()
{
    if (forced_hypre_direct_minimizer_preconditioner()) {
        return true;
    }
    if (forced_serial_direct_minimizer_preconditioner()) {
        return false;
    }
    return false;
}

bool solve_scalar_hypre_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    if (!openmpi_singleton_can_create_socket()) {
        error =
            "direct FEM relaxation Hypre preconditioner requires OpenMPI singleton socket support";
        return false;
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(op.NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};
    mfem::HypreParMatrix A_par(fullmag_serial_comm(), glob_size, row_starts, &op);
    mfem::HypreParVector b_par(fullmag_serial_comm(), glob_size, row_starts);
    mfem::HypreParVector x_par(fullmag_serial_comm(), glob_size, row_starts);
    const double *rhs_host = audited_host_read(rhs);
    double *b_host = audited_host_write(b_par);
    double *x_host = audited_host_write(x_par);
    for (int i = 0; i < rhs.Size(); ++i) {
        b_host[i] = rhs_host[i];
        x_host[i] = 0.0;
    }

    std::unique_ptr<mfem::HypreSolver> preconditioner;
    const char *preconditioner_env =
        std::getenv("FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER");
    const bool use_jacobi = preconditioner_env != nullptr &&
        (std::strcmp(preconditioner_env, "jacobi") == 0 ||
         std::strcmp(preconditioner_env, "JACOBI") == 0);
    const bool use_none = preconditioner_env != nullptr &&
        (std::strcmp(preconditioner_env, "none") == 0 ||
         std::strcmp(preconditioner_env, "NONE") == 0);
    if (use_jacobi) {
        preconditioner = std::make_unique<mfem::HypreDiagScale>(A_par);
    } else if (use_none) {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(A_par);
        preconditioner = std::move(identity);
    } else {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(A_par);
        amg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        preconditioner = std::move(amg);
    }

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    mfem::HyprePCG solver(fullmag_serial_comm());
    solver.iterative_mode = false;
    solver.SetTol(kPreconditionerSolveRelativeTolerance);
    solver.SetAbsTol(kPreconditionerSolveAbsoluteTolerance);
    solver.SetMaxIter(kPreconditionerSolveMaximumIterations);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetOperator(A_par);
    solver.SetPreconditioner(*preconditioner);
    solver.Mult(b_par, x_par);
    solver.GetNumIterations(iterations);
    solver.GetFinalResidualNorm(final_residual);
    if (!validate_hypre_relative_residual(
            static_cast<double>(final_residual),
            rhs.Norml2(),
            iterations,
            "direct FEM relaxation Hypre preconditioner solve",
            error)) {
        return false;
    }

    solution.SetSize(rhs.Size());
    const double *solved_host = audited_host_read(x_par);
    double *solution_host = audited_host_write(solution);
    for (int i = 0; i < rhs.Size(); ++i) {
        solution_host[i] = solved_host[i];
    }
    return true;
}

#endif

bool solve_scalar_spd_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
#ifdef MFEM_USE_MPI
    if (should_use_hypre_direct_minimizer_preconditioner()) {
        return solve_scalar_hypre_system(ctx, op, rhs, solution, error);
    }
#endif
    return solve_scalar_mfem_cg_system(ctx, op, rhs, solution, error);
}

#endif

} // namespace

#if FULLMAG_HAS_MFEM_STACK
std::unique_ptr<mfem::SparseMatrix> assemble_exchange_mass_preconditioner_for_step(
    mfem::SparseMatrix &mass_ms,
    mfem::SparseMatrix &exchange_stiffness_a,
    double step_m_per_a)
{
    return assemble_exchange_mass_preconditioner(
        mass_ms,
        exchange_stiffness_a,
        exchange_hessian_scale_from_step_m_per_a(step_m_per_a));
}
#endif

double dot_fields(
    const std::vector<double> &a,
    const std::vector<double> &b)
{
    if (a.size() != b.size()) {
        return invalid_metric_value();
    }
    double value = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        value += a[i] * b[i];
    }
    return value;
}

double gradient_norm_sq(const std::vector<double> &gradient)
{
    return dot_fields(gradient, gradient);
}

double metric_dot_fields(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b)
{
    if (a.size() != b.size() || a.size() % 3u != 0u) {
        return invalid_metric_value();
    }
    const size_t nodes = a.size() / 3u;
    if (ctx.integration_weights.mfem_lumped_mass.size() != nodes) {
        return invalid_metric_value();
    }
    if (!ctx.mesh.magnetic_node_mask.empty() &&
        ctx.mesh.magnetic_node_mask.size() != nodes) {
        return invalid_metric_value();
    }

    double value = 0.0;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const double mass = ctx.integration_weights.mfem_lumped_mass[node];
        if (!std::isfinite(mass) || mass <= 0.0) {
            return invalid_metric_value();
        }
        const size_t base = node * 3u;
        value += mass * dot3(a, b, base);
    }
    return value;
}

double metric_gradient_norm_sq(
    const Context &ctx,
    const std::vector<double> &gradient)
{
    return metric_dot_fields(ctx, gradient, gradient);
}

EnergyWeightedDotResult energy_weighted_dot_fields_with_absolute_term_sum(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b)
{
    if (a.size() != b.size() || a.size() % 3u != 0u) {
        return {invalid_metric_value(), invalid_metric_value()};
    }
    const size_t nodes = a.size() / 3u;
    if (ctx.integration_weights.mfem_lumped_mass.size() != nodes ||
        (!ctx.mesh.magnetic_node_mask.empty() &&
         ctx.mesh.magnetic_node_mask.size() != nodes)) {
        return {invalid_metric_value(), invalid_metric_value()};
    }

    EnergyWeightedDotResult result;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const double mass = ctx.integration_weights.mfem_lumped_mass[node];
        const double ms = scalar_field_value(
            ctx.material_fields.Ms_field,
            node,
            ctx.material_fields.material.saturation_magnetisation);
        if (!std::isfinite(mass) || mass <= 0.0 || !std::isfinite(ms) || ms <= 0.0) {
            return {invalid_metric_value(), invalid_metric_value()};
        }
        const size_t base = node * 3u;
        const double energy_weight = kMu0 * ms * mass;
        result.value += energy_weight * dot3(a, b, base);
        for (size_t component = 0; component < 3u; ++component) {
            result.absolute_term_sum +=
                std::abs(energy_weight * a[base + component] * b[base + component]);
        }
    }
    return result;
}

double energy_weighted_dot_fields(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b)
{
    return energy_weighted_dot_fields_with_absolute_term_sum(ctx, a, b).value;
}

EnergyWeightedDotResult representable_chord_energy_linear_increment(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz,
    const std::vector<double> &current_h_eff_xyz)
{
    if (current_m_xyz.size() != trial_m_xyz.size() ||
        current_m_xyz.size() != current_h_eff_xyz.size() ||
        current_m_xyz.size() % 3u != 0u) {
        return {invalid_metric_value(), invalid_metric_value()};
    }
    std::vector<double> chord(current_m_xyz.size(), 0.0);
    std::vector<double> ambient_energy_gradient(current_m_xyz.size(), 0.0);
    for (size_t index = 0; index < current_m_xyz.size(); ++index) {
        chord[index] = trial_m_xyz[index] - current_m_xyz[index];
        ambient_energy_gradient[index] = -current_h_eff_xyz[index];
    }
    return energy_weighted_dot_fields_with_absolute_term_sum(
        ctx, ambient_energy_gradient, chord);
}

namespace {

bool project_node_tangent(
    const std::vector<double> &m_xyz,
    const std::vector<double> &vector_xyz,
    size_t base,
    double projected[3])
{
    const double norm_sq = dot3(m_xyz, m_xyz, base);
    if (!std::isfinite(norm_sq) || norm_sq <= 0.0) {
        return false;
    }
    const double scale = dot3(m_xyz, vector_xyz, base) / norm_sq;
    for (size_t component = 0; component < 3u; ++component) {
        projected[component] =
            vector_xyz[base + component] - scale * m_xyz[base + component];
    }
    const double residual =
        m_xyz[base + 0u] * projected[0] +
        m_xyz[base + 1u] * projected[1] +
        m_xyz[base + 2u] * projected[2];
    const double correction = residual / norm_sq;
    for (size_t component = 0; component < 3u; ++component) {
        projected[component] -= correction * m_xyz[base + component];
    }
    return std::isfinite(projected[0]) &&
        std::isfinite(projected[1]) &&
        std::isfinite(projected[2]);
}

} // namespace

void tangent_gradient_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_eff_xyz,
    std::vector<double> &gradient_xyz)
{
    if (m_xyz.size() != h_eff_xyz.size() || m_xyz.size() % 3u != 0u ||
        (!ctx.mesh.magnetic_node_mask.empty() &&
         ctx.mesh.magnetic_node_mask.size() != m_xyz.size() / 3u)) {
        gradient_xyz.assign(
            m_xyz.size(),
            std::numeric_limits<double>::quiet_NaN());
        return;
    }
    gradient_xyz.assign(m_xyz.size(), 0.0);
    const size_t nodes = m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        double projected[3] = {};
        if (!project_node_tangent(
                m_xyz, h_eff_xyz, base, projected)) {
            const double invalid = std::numeric_limits<double>::quiet_NaN();
            gradient_xyz[base + 0u] = invalid;
            gradient_xyz[base + 1u] = invalid;
            gradient_xyz[base + 2u] = invalid;
            continue;
        }
        for (size_t component = 0; component < 3u; ++component) {
            const size_t idx = base + component;
            gradient_xyz[idx] = -projected[component];
        }
    }
}

std::vector<double> project_tangent(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &vector_xyz)
{
    if (m_xyz.size() != vector_xyz.size() || m_xyz.size() % 3u != 0u ||
        (!ctx.mesh.magnetic_node_mask.empty() &&
         ctx.mesh.magnetic_node_mask.size() != m_xyz.size() / 3u)) {
        return std::vector<double>(
            m_xyz.size(),
            std::numeric_limits<double>::quiet_NaN());
    }
    std::vector<double> projected(m_xyz.size(), 0.0);
    const size_t nodes = m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        double node_projected[3] = {};
        if (!project_node_tangent(
                m_xyz, vector_xyz, base, node_projected)) {
            const double invalid = std::numeric_limits<double>::quiet_NaN();
            projected[base + 0u] = invalid;
            projected[base + 1u] = invalid;
            projected[base + 2u] = invalid;
            continue;
        }
        for (size_t component = 0; component < 3u; ++component) {
            const size_t idx = base + component;
            projected[idx] = node_projected[component];
        }
    }
    return projected;
}

bool transported_bb_secant(
    const Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &accepted_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &accepted_gradient,
    std::vector<double> &transported_step,
    std::vector<double> &transported_gradient_difference)
{
    const size_t size = accepted_m.size();
    if (size == 0u || size % 3u != 0u || previous_m.size() != size ||
        previous_gradient.size() != size || accepted_gradient.size() != size) {
        transported_step.clear();
        transported_gradient_difference.clear();
        return false;
    }

    std::vector<double> ambient_step(size, 0.0);
    for (size_t i = 0; i < size; ++i) {
        ambient_step[i] = accepted_m[i] - previous_m[i];
    }
    transported_step = project_tangent(ctx, accepted_m, ambient_step);
    const std::vector<double> transported_previous_gradient =
        project_tangent(ctx, accepted_m, previous_gradient);
    transported_gradient_difference.assign(size, 0.0);
    for (size_t i = 0; i < size; ++i) {
        transported_gradient_difference[i] =
            accepted_gradient[i] - transported_previous_gradient[i];
    }

    const auto finite = [](const std::vector<double> &field) {
        return std::all_of(
            field.begin(),
            field.end(),
            [](double value) { return std::isfinite(value); });
    };
    return finite(transported_step) &&
        finite(transported_gradient_difference);
}

std::vector<double> negative_field(const std::vector<double> &field_xyz)
{
    std::vector<double> result(field_xyz.size(), 0.0);
    for (size_t i = 0; i < field_xyz.size(); ++i) {
        result[i] = -field_xyz[i];
    }
    return result;
}

bool exchange_mass_preconditioned_gradient(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &gradient_xyz,
    double step_m_per_a,
    std::vector<double> &preconditioned_gradient_xyz,
    std::string &error,
    uint64_t *preconditioner_wall_time_ns,
    uint32_t *preconditioner_cache_hits,
    uint32_t *preconditioner_cache_misses)
{
#if FULLMAG_HAS_MFEM_STACK
    ScopedPhaseTimer preconditioner_timer(preconditioner_wall_time_ns);
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.mass_form);
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    if (mass_form == nullptr || exchange_form == nullptr) {
        error = "direct FEM relaxation preconditioner requires MFEM mass and exchange forms";
        return false;
    }
    const size_t nodes = m_xyz.size() / 3u;
    if (mass_form->FESpace() == nullptr ||
        mass_form->FESpace()->GetNDofs() != static_cast<int>(nodes)) {
        error = "direct FEM relaxation preconditioner mass form size does not match magnetization nodes";
        return false;
    }
    if (exchange_form->FESpace() == nullptr ||
        exchange_form->FESpace()->GetNDofs() != static_cast<int>(nodes)) {
        error = "direct FEM relaxation preconditioner exchange form size does not match magnetization nodes";
        return false;
    }

    std::vector<double> mass_gradient;
    if (!apply_sparse_operator_to_field(mass_form->SpMat(), gradient_xyz, mass_gradient)) {
        error = "direct FEM relaxation preconditioner mass-gradient RHS produced non-finite values";
        return false;
    }
    const double bounded_step_m_per_a = std::clamp(
        step_m_per_a,
        kDirectMinimizerPreconditionerMinimumStepMPerA,
        kDirectMinimizerPreconditionerMaximumStepMPerA);
    mfem::SparseMatrix &op = cached_exchange_mass_preconditioner(
        ctx,
        mass_form->SpMat(),
        exchange_form->SpMat(),
        bounded_step_m_per_a,
        preconditioner_cache_hits,
        preconditioner_cache_misses);

    preconditioned_gradient_xyz.assign(gradient_xyz.size(), 0.0);
    mfem::Vector rhs(static_cast<int>(nodes));
    mfem::Vector solution;
    for (int component = 0; component < 3; ++component) {
        double *rhs_data = audited_host_write(rhs);
        for (size_t node = 0; node < nodes; ++node) {
            rhs_data[node] =
                mass_gradient[node * 3u + static_cast<size_t>(component)];
        }
        if (!solve_scalar_spd_system(ctx, op, rhs, solution, error)) {
            return false;
        }
        const double *sol_data = audited_host_read(solution);
        for (size_t node = 0; node < nodes; ++node) {
            preconditioned_gradient_xyz[node * 3u + static_cast<size_t>(component)] =
                sol_data[node];
        }
    }
    preconditioned_gradient_xyz =
        project_tangent(ctx, m_xyz, preconditioned_gradient_xyz);
    if (!all_finite(preconditioned_gradient_xyz)) {
        error = "direct FEM relaxation preconditioned gradient contains non-finite values";
        return false;
    }
    return true;
#else
    (void)ctx;
    (void)m_xyz;
    (void)gradient_xyz;
    (void)step_m_per_a;
    (void)preconditioned_gradient_xyz;
    (void)preconditioner_wall_time_ns;
    (void)preconditioner_cache_hits;
    (void)preconditioner_cache_misses;
    error = "direct FEM relaxation preconditioner requires FULLMAG_USE_MFEM_STACK=ON";
    return false;
#endif
}

void destroy_exchange_mass_preconditioner_cache(Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    delete ctx.relaxation.exchange_mass_preconditioner;
#endif
    ctx.relaxation.exchange_mass_preconditioner = nullptr;
    ctx.relaxation.exchange_mass_preconditioner_mass = nullptr;
    ctx.relaxation.exchange_mass_preconditioner_exchange = nullptr;
    ctx.relaxation.exchange_mass_preconditioner_weight = 0.0;
    ctx.relaxation.exchange_mass_preconditioner_height = 0;
    ctx.relaxation.exchange_mass_preconditioner_width = 0;
}

bool validate_relaxation_state_fields(
    const Context &ctx,
    const char *algorithm_name,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const size_t nodes = static_cast<size_t>(ctx.mesh.n_nodes);
    const size_t expected_len = nodes * 3u;
    const std::string prefix = std::string(algorithm_name) + " relaxation";
    if (nodes == 0u) {
        error = prefix + " requires a non-empty FEM mesh";
        return false;
    }
    if (ctx.state.m_xyz.size() != expected_len) {
        error = prefix + " magnetization size mismatch: expected " +
            std::to_string(expected_len) + " values but got " +
            std::to_string(ctx.state.m_xyz.size());
        return false;
    }
    if (ctx.effective_field.h_xyz.size() != expected_len) {
        error = prefix + " requires a current native H_eff field with " +
            std::to_string(expected_len) + " values but got " +
            std::to_string(ctx.effective_field.h_xyz.size());
        return false;
    }
    if (!ctx.mesh.magnetic_node_mask.empty() &&
        ctx.mesh.magnetic_node_mask.size() != nodes) {
        error = prefix + " magnetic-node mask size mismatch: expected " +
            std::to_string(nodes) + " entries but got " +
            std::to_string(ctx.mesh.magnetic_node_mask.size());
        return false;
    }
    if (ctx.integration_weights.mfem_lumped_mass.size() != nodes) {
        error = prefix +
            " requires a FEM lumped-mass metric with one weight per mesh node";
        return false;
    }
    if (!all_finite(ctx.state.m_xyz)) {
        error = prefix + " magnetization contains non-finite values";
        return false;
    }
    if (!all_finite(ctx.effective_field.h_xyz)) {
        error = prefix + " H_eff contains non-finite values";
        return false;
    }

    bool has_active_node = false;
    for (size_t node = 0; node < nodes; ++node) {
        const double mass = ctx.integration_weights.mfem_lumped_mass[node];
        if (!std::isfinite(mass) || mass < 0.0) {
            error = prefix + " FEM lumped-mass metric contains invalid values";
            return false;
        }
        if (magnetic_node(ctx, node)) {
            has_active_node = true;
            const size_t base = node * 3u;
            const double norm_sq =
                dot3(ctx.state.m_xyz, ctx.state.m_xyz, base);
            if (!std::isfinite(norm_sq) ||
                std::abs(norm_sq - 1.0) > kMagnetizationUnitNormTolerance) {
                error = prefix +
                    " active magnetization is not unit length at node " +
                    std::to_string(node) + ": norm_sq=" +
                    std::to_string(norm_sq);
                return false;
            }
            if (mass <= 0.0) {
                error = prefix +
                    " FEM lumped-mass metric has a non-positive active-node weight";
                return false;
            }
        }
    }
    if (!has_active_node) {
        error = prefix + " requires at least one active magnetic node";
        return false;
    }
    return true;
#else
    (void)ctx;
    error = std::string(algorithm_name) +
        " relaxation field validation requires FULLMAG_USE_MFEM_STACK=ON";
    return false;
#endif
}

bool validate_relaxation_step_energy(
    const fullmag_fem_step_stats &stats,
    const char *algorithm_name,
    const char *snapshot_name,
    std::string &error)
{
    if (!std::isfinite(stats.total_energy_joules)) {
        error = std::string(algorithm_name) + " relaxation " +
            snapshot_name + " snapshot produced non-finite total energy";
        return false;
    }
    return true;
}

bool validate_tangent_gradient_norm_sq(
    double gradient_norm_sq,
    const char *algorithm_name,
    std::string &error)
{
    if (!std::isfinite(gradient_norm_sq) || gradient_norm_sq < 0.0) {
        error = std::string(algorithm_name) +
            " relaxation produced a non-finite or negative tangent-gradient norm";
        return false;
    }
    return true;
}

bool validate_tangent_gradient_field(
    const Context &ctx,
    const std::vector<double> &gradient_xyz,
    const char *algorithm_name,
    const char *gradient_name,
    double &gradient_norm_sq,
    std::string &error)
{
    const size_t expected_len = ctx.state.m_xyz.size();
    if (gradient_xyz.size() != expected_len) {
        error = std::string(algorithm_name) + " relaxation " +
            gradient_name + " tangent gradient size mismatch: expected " +
            std::to_string(expected_len) + " values but got " +
            std::to_string(gradient_xyz.size());
        return false;
    }
    if (!std::all_of(
            gradient_xyz.begin(),
            gradient_xyz.end(),
            [](double value) { return std::isfinite(value); })) {
        error = std::string(algorithm_name) + " relaxation " +
            gradient_name + " tangent gradient contains non-finite values";
        return false;
    }
    gradient_norm_sq = metric_gradient_norm_sq(ctx, gradient_xyz);
    if (!std::isfinite(gradient_norm_sq) || gradient_norm_sq < 0.0) {
        error = std::string(algorithm_name) + " relaxation " +
            gradient_name +
            " tangent gradient produced a non-finite or negative metric norm";
        return false;
    }
    return true;
}

double sanitized_relaxation_step_size(double step_size)
{
    if (!std::isfinite(step_size) || step_size <= 0.0) {
        return kDefaultStepSize;
    }
    return std::clamp(step_size, kMinStepSize, kMaxStepSize);
}

std::vector<double> retracted_step(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &direction_xyz,
    double step_size)
{
    std::vector<double> trial;
    retracted_step_into(ctx, m_xyz, direction_xyz, step_size, trial);
    return trial;
}

void retracted_step_into(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &direction_xyz,
    double step_size,
    std::vector<double> &trial_xyz)
{
    if (m_xyz.size() != direction_xyz.size() || m_xyz.size() % 3u != 0u) {
        trial_xyz.assign(
            m_xyz.size(),
            std::numeric_limits<double>::quiet_NaN());
        return;
    }
    trial_xyz.resize(m_xyz.size());
    std::copy(m_xyz.begin(), m_xyz.end(), trial_xyz.begin());
    const size_t nodes = m_xyz.size() / 3u;
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        const double x = m_xyz[base + 0] + step_size * direction_xyz[base + 0];
        const double y = m_xyz[base + 1] + step_size * direction_xyz[base + 1];
        const double z = m_xyz[base + 2] + step_size * direction_xyz[base + 2];
        const double norm = std::sqrt(x * x + y * y + z * z);
        if (!std::isfinite(norm) || norm <= 0.0) {
            const double invalid = std::numeric_limits<double>::quiet_NaN();
            trial_xyz[base + 0] = invalid;
            trial_xyz[base + 1] = invalid;
            trial_xyz[base + 2] = invalid;
            continue;
        }
        const double inv = 1.0 / norm;
        trial_xyz[base + 0] = x * inv;
        trial_xyz[base + 1] = y * inv;
        trial_xyz[base + 2] = z * inv;
    }
}

int ensure_cpu_mfem_relaxation_lane(
    Context &ctx,
    const char *algorithm_name,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    error.clear();
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (ctx.gpu_state.device.lifecycle.allocated) {
        error = std::string("native FEM ") + algorithm_name +
            " relaxation is implemented for the CPU/MFEM lane; "
            "its GPU/libCEED device-resident solver is under development";
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    error = std::string(algorithm_name) +
        " relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int upload_and_snapshot(
    Context &ctx,
    const std::vector<double> &m_xyz,
    fullmag_fem_step_stats &stats,
    const char *algorithm_name,
    const char *snapshot_name,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const std::string prefix = std::string(algorithm_name) + " relaxation " +
        snapshot_name + " magnetization";
    if (m_xyz.size() != ctx.state.m_xyz.size()) {
        error = prefix + " size mismatch: expected " +
            std::to_string(ctx.state.m_xyz.size()) + " values but got " +
            std::to_string(m_xyz.size());
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    uint64_t state_upload_wall_time_ns = 0;
    {
        ScopedPhaseTimer timer(&state_upload_wall_time_ns);
        if (!all_finite(m_xyz)) {
            error = prefix + " contains non-finite values";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const int upload_status = set_relaxation_magnetization_state(
            ctx,
            m_xyz,
            prefix,
            error);
        if (upload_status != FULLMAG_FEM_OK) {
            return upload_status;
        }
    }
    stats.relaxation_state_upload_wall_time_ns += state_upload_wall_time_ns;
    reset_demag_poisson_hypre_initial_guess(ctx);
    if (!context_snapshot_stats_mfem(ctx, stats, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (!validate_relaxation_state_fields(ctx, algorithm_name, error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!validate_relaxation_step_energy(
            stats,
            algorithm_name,
            snapshot_name,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)m_xyz;
    (void)stats;
    (void)algorithm_name;
    (void)snapshot_name;
    error = "native FEM relaxation snapshot requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int fresh_line_search_snapshot(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    const char *algorithm_name,
    const char *snapshot_name,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    reset_demag_poisson_hypre_initial_guess(ctx);
    if (!context_snapshot_stats_mfem(ctx, stats, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (!validate_relaxation_state_fields(ctx, algorithm_name, error) ||
        !validate_relaxation_step_energy(
            stats,
            algorithm_name,
            snapshot_name,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)stats;
    (void)algorithm_name;
    (void)snapshot_name;
    error = "native FEM relaxation snapshot requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

bool take_cached_current_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats)
{
#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.relaxation.cached_current_stats_valid ||
        ctx.relaxation.cached_current_stats_step != ctx.state.step_count ||
        ctx.relaxation.cached_current_stats_time != ctx.state.current_time) {
        return false;
    }
    stats = ctx.relaxation.cached_current_stats;
    return true;
#else
    (void)ctx;
    (void)stats;
    return false;
#endif
}

namespace {

int restore_validated_relaxation_state(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    std::string &restore_error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int restore_status = context_upload_magnetization_f64(
        ctx,
        previous_m_xyz.data(),
        static_cast<uint64_t>(previous_m_xyz.size()),
        restore_error);
    if (restore_status != FULLMAG_FEM_OK) {
        return restore_status;
    }
    if (!validate_relaxation_state_fields(ctx, algorithm_name, restore_error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)previous_m_xyz;
    restore_error = std::string(algorithm_name) +
        " relaxation state restore requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace

int restore_after_failed_line_search(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    uint32_t backtracks,
    const std::string &diagnostics,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    std::string restore_error;
    const int restore_status = restore_validated_relaxation_state(
        ctx,
        previous_m_xyz,
        algorithm_name,
        restore_error);
    if (restore_status != FULLMAG_FEM_OK) {
        error = std::string(algorithm_name) +
            " relaxation failed to restore state after exhausted Armijo line search: " +
            restore_error;
        return restore_status;
    }
    error = std::string(algorithm_name) +
        " relaxation failed Armijo line search after " +
        std::to_string(backtracks) +
        " backtracks; previous state restored";
    if (!diagnostics.empty()) {
        error += "; " + diagnostics;
    }
    return FULLMAG_FEM_ERR_INTERNAL;
#else
    (void)ctx;
    (void)previous_m_xyz;
    (void)backtracks;
    (void)diagnostics;
    error = std::string(algorithm_name) +
        " relaxation line-search restore requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int restore_after_rejected_trial(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    uint32_t backtracks,
    double rejected_step_size,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    std::string restore_error;
    const int restore_status = restore_validated_relaxation_state(
        ctx,
        previous_m_xyz,
        algorithm_name,
        restore_error);
    if (restore_status != FULLMAG_FEM_OK) {
        error = std::string(algorithm_name) +
            " relaxation failed to restore previous state after rejected Armijo trial at backtrack " +
            std::to_string(backtracks) + " with step_size=" +
            std::to_string(rejected_step_size) + ": " + restore_error;
        return restore_status;
    }
    error.clear();
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)previous_m_xyz;
    (void)backtracks;
    (void)rejected_step_size;
    error = std::string(algorithm_name) +
        " relaxation rejected-trial restore requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int restore_previous_relaxation_state(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    const char *failure_context,
    int original_status,
    const std::string &original_error,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    std::string restore_error;
    const int restore_status = restore_validated_relaxation_state(
        ctx,
        previous_m_xyz,
        algorithm_name,
        restore_error);
    if (restore_status != FULLMAG_FEM_OK) {
        error = std::string(algorithm_name) +
            " relaxation failed to restore previous state after " +
            failure_context + ": " + restore_error +
            "; original error: " + original_error;
        return restore_status;
    }
    error = original_error + "; previous state restored";
    return original_status;
#else
    (void)ctx;
    (void)previous_m_xyz;
    (void)failure_context;
    (void)original_status;
    error = std::string(algorithm_name) +
        " relaxation state restore requires FULLMAG_USE_MFEM_STACK=ON; original error: " +
        original_error;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

void accumulate_relaxation_profile_sample(
    fullmag_fem_step_stats &accumulated_stats,
    const fullmag_fem_step_stats &sample_stats)
{
    accumulated_stats.wall_time_ns += sample_stats.wall_time_ns;
    accumulated_stats.exchange_wall_time_ns += sample_stats.exchange_wall_time_ns;
    accumulated_stats.demag_wall_time_ns += sample_stats.demag_wall_time_ns;
    accumulated_stats.demag_assemble_wall_time_ns += sample_stats.demag_assemble_wall_time_ns;
    accumulated_stats.demag_solve_wall_time_ns += sample_stats.demag_solve_wall_time_ns;
    accumulated_stats.demag_solver_setup_wall_time_ns +=
        sample_stats.demag_solver_setup_wall_time_ns;
    accumulated_stats.demag_solver_apply_wall_time_ns +=
        sample_stats.demag_solver_apply_wall_time_ns;
    accumulated_stats.demag_recover_wall_time_ns += sample_stats.demag_recover_wall_time_ns;
    accumulated_stats.demag_energy_wall_time_ns += sample_stats.demag_energy_wall_time_ns;
    accumulated_stats.rhs_wall_time_ns += sample_stats.rhs_wall_time_ns;
    accumulated_stats.extra_energy_wall_time_ns += sample_stats.extra_energy_wall_time_ns;
    accumulated_stats.snapshot_wall_time_ns += sample_stats.snapshot_wall_time_ns;
    accumulated_stats.relaxation_preconditioner_wall_time_ns +=
        sample_stats.relaxation_preconditioner_wall_time_ns;
    accumulated_stats.relaxation_state_copy_wall_time_ns +=
        sample_stats.relaxation_state_copy_wall_time_ns;
    accumulated_stats.relaxation_state_upload_wall_time_ns +=
        sample_stats.relaxation_state_upload_wall_time_ns;
    accumulated_stats.relaxation_retraction_wall_time_ns +=
        sample_stats.relaxation_retraction_wall_time_ns;
    accumulated_stats.relaxation_gradient_wall_time_ns +=
        sample_stats.relaxation_gradient_wall_time_ns;
    accumulated_stats.relaxation_metric_wall_time_ns +=
        sample_stats.relaxation_metric_wall_time_ns;
    accumulated_stats.relaxation_line_search_wall_time_ns +=
        sample_stats.relaxation_line_search_wall_time_ns;
    accumulated_stats.relaxation_update_wall_time_ns +=
        sample_stats.relaxation_update_wall_time_ns;
    accumulated_stats.relaxation_preconditioner_cache_hits +=
        sample_stats.relaxation_preconditioner_cache_hits;
    accumulated_stats.relaxation_preconditioner_cache_misses +=
        sample_stats.relaxation_preconditioner_cache_misses;
    accumulated_stats.demag_solve_count += sample_stats.demag_solve_count;
    accumulated_stats.rhs_evaluations += sample_stats.rhs_evaluations;
    accumulated_stats.rejected_attempts += sample_stats.rejected_attempts;
}

void finish_accepted_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &trial_stats,
    const fullmag_fem_step_stats &accumulated_stats,
    fullmag_fem_step_stats &out_stats,
    double accepted_step_size)
{
    (void)accepted_step_size;
    ctx.relaxation.accepted_steps += 1;
    ctx.state.step_count += 1;
    ctx.state.current_time = 0.0;

    out_stats = trial_stats;
    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = 0.0;
    out_stats.max_rhs_amplitude = 0.0;
    out_stats.wall_time_ns = accumulated_stats.wall_time_ns;
    out_stats.exchange_wall_time_ns = accumulated_stats.exchange_wall_time_ns;
    out_stats.demag_wall_time_ns = accumulated_stats.demag_wall_time_ns;
    out_stats.demag_assemble_wall_time_ns = accumulated_stats.demag_assemble_wall_time_ns;
    out_stats.demag_solve_wall_time_ns = accumulated_stats.demag_solve_wall_time_ns;
    out_stats.demag_solver_setup_wall_time_ns =
        accumulated_stats.demag_solver_setup_wall_time_ns;
    out_stats.demag_solver_apply_wall_time_ns =
        accumulated_stats.demag_solver_apply_wall_time_ns;
    out_stats.demag_solver_setup_reused =
        accumulated_stats.demag_solver_setup_wall_time_ns == 0 &&
        accumulated_stats.demag_solve_count > 0;
    out_stats.demag_recover_wall_time_ns = accumulated_stats.demag_recover_wall_time_ns;
    out_stats.demag_energy_wall_time_ns = accumulated_stats.demag_energy_wall_time_ns;
    out_stats.rhs_wall_time_ns = accumulated_stats.rhs_wall_time_ns;
    out_stats.extra_energy_wall_time_ns = accumulated_stats.extra_energy_wall_time_ns;
    out_stats.snapshot_wall_time_ns = accumulated_stats.snapshot_wall_time_ns;
    out_stats.relaxation_preconditioner_wall_time_ns =
        accumulated_stats.relaxation_preconditioner_wall_time_ns;
    out_stats.relaxation_state_copy_wall_time_ns =
        accumulated_stats.relaxation_state_copy_wall_time_ns;
    out_stats.relaxation_state_upload_wall_time_ns =
        accumulated_stats.relaxation_state_upload_wall_time_ns;
    out_stats.relaxation_retraction_wall_time_ns =
        accumulated_stats.relaxation_retraction_wall_time_ns;
    out_stats.relaxation_gradient_wall_time_ns =
        accumulated_stats.relaxation_gradient_wall_time_ns;
    out_stats.relaxation_metric_wall_time_ns =
        accumulated_stats.relaxation_metric_wall_time_ns;
    out_stats.relaxation_line_search_wall_time_ns =
        accumulated_stats.relaxation_line_search_wall_time_ns;
    out_stats.relaxation_update_wall_time_ns =
        accumulated_stats.relaxation_update_wall_time_ns;
    out_stats.relaxation_preconditioner_cache_hits =
        accumulated_stats.relaxation_preconditioner_cache_hits;
    out_stats.relaxation_preconditioner_cache_misses =
        accumulated_stats.relaxation_preconditioner_cache_misses;
    out_stats.demag_solve_count = accumulated_stats.demag_solve_count;
    out_stats.rhs_evaluations = accumulated_stats.rhs_evaluations;
    out_stats.rejected_attempts = accumulated_stats.rejected_attempts;

    ctx.relaxation.cached_current_stats = trial_stats;
    ctx.relaxation.cached_current_stats.step = ctx.state.step_count;
    ctx.relaxation.cached_current_stats.time_seconds = ctx.state.current_time;
    ctx.relaxation.cached_current_stats.dt_seconds = 0.0;
    ctx.relaxation.cached_current_stats.wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.exchange_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_assemble_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_solve_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_solver_setup_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_solver_apply_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_solver_setup_reused = 0;
    ctx.relaxation.cached_current_stats.demag_recover_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.demag_energy_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.rhs_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.extra_energy_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.snapshot_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_preconditioner_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_state_copy_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_state_upload_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_retraction_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_gradient_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_metric_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_line_search_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_update_wall_time_ns = 0;
    ctx.relaxation.cached_current_stats.relaxation_preconditioner_cache_hits = 0;
    ctx.relaxation.cached_current_stats.relaxation_preconditioner_cache_misses = 0;
    ctx.relaxation.cached_current_stats.demag_solve_count = 0;
    ctx.relaxation.cached_current_stats.demag_linear_iterations = 0;
    ctx.relaxation.cached_current_stats.demag_linear_residual = 0.0;
    ctx.relaxation.cached_current_stats.rhs_evaluations = 0;
    ctx.relaxation.cached_current_stats.rejected_attempts = 0;
    ctx.relaxation.cached_current_stats.fsal_reused = 0;
    ctx.relaxation.cached_current_stats_valid = true;
    ctx.relaxation.cached_current_stats_step = ctx.state.step_count;
    ctx.relaxation.cached_current_stats_time = ctx.state.current_time;
    update_stage_completion_from_stats(ctx, out_stats);
}

void publish_accepted_gradient_completion(
    Context &ctx,
    double accepted_gradient_norm_sq)
{
    if (std::isfinite(accepted_gradient_norm_sq) &&
        accepted_gradient_norm_sq == 0.0) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
            "tangent_gradient_norm_sq",
            accepted_gradient_norm_sq,
            0.0);
    }
}

void finish_degenerate_gradient_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &current_stats,
    fullmag_fem_step_stats &out_stats,
    double gradient_norm_sq)
{
    out_stats = current_stats;
    out_stats.dt_seconds = 0.0;
    out_stats.max_rhs_amplitude = 0.0;
    set_stage_completion(
        ctx,
        FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
        "tangent_gradient_norm_sq",
        gradient_norm_sq,
        0.0);
}

} // namespace fullmag::fem::relaxation
