#include "cpu/mfem/relaxation/relaxation_math.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

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
        for (int node = 0; node < nodes; ++node) {
            component_in[node] =
                field_xyz[static_cast<size_t>(node) * 3u + static_cast<size_t>(component)];
        }
        op.Mult(component_in, component_out);
        for (int node = 0; node < nodes; ++node) {
            operator_field_xyz[static_cast<size_t>(node) * 3u +
                static_cast<size_t>(component)] = component_out[node];
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
        add_sparse_matrix_row(*op, mass, row, 1.0);
        add_sparse_matrix_row(*op, exchange, row, exchange_weight);
    }
    op->Finalize();
    return op;
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
        const double mdoth = dot3(m_xyz, h_eff_xyz, base);
        for (size_t component = 0; component < 3u; ++component) {
            const size_t idx = base + component;
            const double projected = h_eff_xyz[idx] - mdoth * m_xyz[idx];
            gradient_xyz[idx] = -projected;
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
        const double mdotv = dot3(m_xyz, vector_xyz, base);
        for (size_t component = 0; component < 3u; ++component) {
            const size_t idx = base + component;
            projected[idx] = vector_xyz[idx] - mdotv * m_xyz[idx];
        }
    }
    return projected;
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
    double exchange_weight,
    std::vector<double> &preconditioned_gradient_xyz,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
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
    const double weight = std::clamp(
        exchange_weight,
        kDirectMinimizerPreconditionerFloor,
        kDirectMinimizerPreconditionerCeiling);
    std::unique_ptr<mfem::SparseMatrix> op =
        assemble_exchange_mass_preconditioner(
            mass_form->SpMat(),
            exchange_form->SpMat(),
            weight);

    preconditioned_gradient_xyz.assign(gradient_xyz.size(), 0.0);
    mfem::Vector rhs(static_cast<int>(nodes));
    mfem::Vector solution;
    for (int component = 0; component < 3; ++component) {
        for (size_t node = 0; node < nodes; ++node) {
            rhs[static_cast<int>(node)] =
                mass_gradient[node * 3u + static_cast<size_t>(component)];
        }
        if (!solve_scalar_spd_system(ctx, *op, rhs, solution, error)) {
            return false;
        }
        for (size_t node = 0; node < nodes; ++node) {
            preconditioned_gradient_xyz[node * 3u + static_cast<size_t>(component)] =
                solution[static_cast<int>(node)];
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
    (void)exchange_weight;
    (void)preconditioned_gradient_xyz;
    error = "direct FEM relaxation preconditioner requires FULLMAG_USE_MFEM_STACK=ON";
    return false;
#endif
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
    if (m_xyz.size() != direction_xyz.size() || m_xyz.size() % 3u != 0u) {
        return std::vector<double>(
            m_xyz.size(),
            std::numeric_limits<double>::quiet_NaN());
    }
    std::vector<double> trial = m_xyz;
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
            trial[base + 0] = invalid;
            trial[base + 1] = invalid;
            trial[base + 2] = invalid;
            continue;
        }
        const double inv = 1.0 / norm;
        trial[base + 0] = x * inv;
        trial[base + 1] = y * inv;
        trial[base + 2] = z * inv;
    }
    return trial;
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
    if (!all_finite(m_xyz)) {
        error = prefix + " contains non-finite values";
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    const int upload_status = context_upload_magnetization_f64(
        ctx,
        m_xyz.data(),
        static_cast<uint64_t>(m_xyz.size()),
        error);
    if (upload_status != FULLMAG_FEM_OK) {
        return upload_status;
    }
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

void finish_accepted_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &trial_stats,
    fullmag_fem_step_stats &out_stats,
    double accepted_step_size)
{
    ctx.relaxation.accepted_steps += 1;
    ctx.state.step_count += 1;
    ctx.state.current_time = 0.0;

    out_stats = trial_stats;
    out_stats.step = ctx.state.step_count;
    out_stats.time_seconds = 0.0;
    out_stats.dt_seconds = accepted_step_size;
    out_stats.max_rhs_amplitude = 0.0;
    update_stage_completion_from_stats(ctx, out_stats);
}

void publish_accepted_gradient_completion(
    Context &ctx,
    double accepted_gradient_norm_sq)
{
    if (std::isfinite(accepted_gradient_norm_sq) &&
        accepted_gradient_norm_sq <= kGradientFloor) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
            "tangent_gradient_norm_sq",
            accepted_gradient_norm_sq,
            kGradientFloor);
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
        kGradientFloor);
}

} // namespace fullmag::fem::relaxation
