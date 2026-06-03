/*
 * Native FEM tangent-plane implicit relaxation.
 *
 * Owns one CPU/MFEM tangent-plane step. The step solves a global tangent-space
 * mass-plus-exchange linear system, retracts the result back to |m| = 1, and
 * accepts it through the same native Armijo energy gate as the other FEM
 * minimizers. Non-exchange effective-field terms enter the tangent residual
 * explicitly through the current native H_eff snapshot.
 */

#include "cpu/mfem/relaxation/tangent_plane_implicit.hpp"

#include "context.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

#if defined(MFEM_USE_MPI) && defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace fullmag::fem {

namespace {

void update_implicit_step_size(
    FemRelaxationRuntimeState &state,
    double accepted_step,
    uint32_t backtracks)
{
    if (backtracks == 0u) {
        state.step_size =
            std::clamp(accepted_step * 1.2, relaxation::kMinStepSize, relaxation::kMaxStepSize);
    } else {
        state.step_size =
            std::clamp(accepted_step, relaxation::kMinStepSize, relaxation::kMaxStepSize);
    }
    state.use_bb1 = true;
    state.reset_consecutive = 0;
    state.nonlinear_cg_direction.clear();
}

#if FULLMAG_HAS_MFEM_STACK

inline constexpr double kLinearSolveRelativeTolerance = 1.0e-8;
inline constexpr double kLinearSolveAbsoluteTolerance = 1.0e-24;
inline constexpr int kLinearSolveMaximumIterations = 20000;

struct TangentFrame {
    std::array<double, 3> e1{0.0, 0.0, 0.0};
    std::array<double, 3> e2{0.0, 0.0, 0.0};
    bool active = false;
};

bool magnetic_node(
    const Context &ctx,
    size_t node)
{
    return ctx.mesh.magnetic_node_mask.empty() ||
        ctx.mesh.magnetic_node_mask[node] != 0u;
}

std::array<double, 3> cross(
    const std::array<double, 3> &a,
    const std::array<double, 3> &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm(
    const std::array<double, 3> &value)
{
    return std::sqrt(
        value[0] * value[0] +
        value[1] * value[1] +
        value[2] * value[2]);
}

std::array<double, 3> normalized(
    const std::array<double, 3> &value)
{
    const double length = norm(value);
    if (length <= 0.0) {
        return {1.0, 0.0, 0.0};
    }
    const double inv = 1.0 / length;
    return {value[0] * inv, value[1] * inv, value[2] * inv};
}

double dot_node(
    const std::array<double, 3> &basis,
    const std::vector<double> &field,
    size_t node)
{
    const size_t base = node * 3u;
    return basis[0] * field[base + 0u] +
        basis[1] * field[base + 1u] +
        basis[2] * field[base + 2u];
}

std::vector<TangentFrame> build_tangent_frames(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    const size_t nodes = m_xyz.size() / 3u;
    std::vector<TangentFrame> frames(nodes);
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        const std::array<double, 3> m = normalized({
            m_xyz[base + 0u],
            m_xyz[base + 1u],
            m_xyz[base + 2u],
        });
        const std::array<double, 3> reference =
            std::abs(m[2]) < 0.9 ? std::array<double, 3>{0.0, 0.0, 1.0}
                                 : std::array<double, 3>{1.0, 0.0, 0.0};
        TangentFrame frame{};
        frame.e1 = normalized(cross(reference, m));
        frame.e2 = normalized(cross(m, frame.e1));
        frame.active = true;
        frames[node] = frame;
    }
    return frames;
}

bool all_finite(const std::vector<double> &values)
{
    return std::all_of(
        values.begin(),
        values.end(),
        [](double value) { return std::isfinite(value); });
}

bool apply_mass_to_field(
    mfem::SparseMatrix &mass,
    const std::vector<double> &field_xyz,
    std::vector<double> &mass_field_xyz)
{
    const int nodes = static_cast<int>(field_xyz.size() / 3u);
    mfem::Vector component_in(nodes);
    mfem::Vector component_out(nodes);
    mass_field_xyz.assign(field_xyz.size(), 0.0);
    for (int component = 0; component < 3; ++component) {
        for (int node = 0; node < nodes; ++node) {
            component_in[node] =
                field_xyz[static_cast<size_t>(node) * 3u + static_cast<size_t>(component)];
        }
        mass.Mult(component_in, component_out);
        for (int node = 0; node < nodes; ++node) {
            mass_field_xyz[static_cast<size_t>(node) * 3u +
                static_cast<size_t>(component)] = component_out[node];
        }
    }
    return all_finite(mass_field_xyz);
}

void expand_tangent_solution_to_field(
    const std::vector<TangentFrame> &frames,
    const mfem::Vector &q,
    std::vector<double> &field_xyz)
{
    field_xyz.assign(frames.size() * 3u, 0.0);
    for (size_t node = 0; node < frames.size(); ++node) {
        const TangentFrame &frame = frames[node];
        if (!frame.active) {
            continue;
        }
        const size_t base = node * 3u;
        const int q_base = static_cast<int>(node * 2u);
        for (size_t component = 0; component < 3u; ++component) {
            field_xyz[base + component] =
                q[q_base + 0] * frame.e1[component] +
                q[q_base + 1] * frame.e2[component];
        }
    }
}

double tangent_basis_dot(
    const TangentFrame &row_frame,
    size_t row_component,
    const TangentFrame &col_frame,
    size_t col_component)
{
    const std::array<double, 3> &row_basis =
        row_component == 0u ? row_frame.e1 : row_frame.e2;
    const std::array<double, 3> &col_basis =
        col_component == 0u ? col_frame.e1 : col_frame.e2;
    return row_basis[0] * col_basis[0] +
        row_basis[1] * col_basis[1] +
        row_basis[2] * col_basis[2];
}

std::unique_ptr<mfem::SparseMatrix> assemble_tangent_plane_operator(
    const std::vector<TangentFrame> &frames,
    mfem::SparseMatrix &mass,
    mfem::SparseMatrix &exchange,
    double implicit_weight)
{
    const int nodes = static_cast<int>(frames.size());
    auto op = std::make_unique<mfem::SparseMatrix>(nodes * 2, nodes * 2);
    mfem::Array<int> cols;
    mfem::Vector vals;
    auto add_scalar_row =
        [&](int i, mfem::SparseMatrix &scalar_op, double scale) {
            scalar_op.GetRow(i, cols, vals);
            const TangentFrame &row_frame = frames[static_cast<size_t>(i)];
            for (int k = 0; k < cols.Size(); ++k) {
                const int j = cols[k];
                const TangentFrame &col_frame = frames[static_cast<size_t>(j)];
                if (!col_frame.active) {
                    continue;
                }
                const double scalar_value = scale * vals[k];
                if (scalar_value == 0.0) {
                    continue;
                }
                for (size_t row_component = 0; row_component < 2u; ++row_component) {
                    for (size_t col_component = 0; col_component < 2u; ++col_component) {
                        const double value =
                            scalar_value *
                            tangent_basis_dot(row_frame, row_component, col_frame, col_component);
                        if (value != 0.0) {
                            op->Add(
                                2 * i + static_cast<int>(row_component),
                                2 * j + static_cast<int>(col_component),
                                value);
                        }
                    }
                }
            }
        };
    for (int i = 0; i < nodes; ++i) {
        const TangentFrame &row_frame = frames[static_cast<size_t>(i)];
        if (!row_frame.active) {
            op->Add(2 * i + 0, 2 * i + 0, 1.0);
            op->Add(2 * i + 1, 2 * i + 1, 1.0);
            continue;
        }
        add_scalar_row(i, mass, 1.0);
        add_scalar_row(i, exchange, implicit_weight);
    }
    op->Finalize();
    return op;
}

bool solve_tangent_plane_mfem_cg_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    mfem::GSSmoother preconditioner(op);
    mfem::CGSolver solver;
    solver.SetRelTol(kLinearSolveRelativeTolerance);
    solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
    solver.SetMaxIter(kLinearSolveMaximumIterations);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetPreconditioner(preconditioner);
    solver.SetOperator(op);
    solution.SetSize(rhs.Size());
    solution = 0.0;
    solver.Mult(rhs, solution);
    if (!std::isfinite(solution.Norml2())) {
        error = "tangent-plane implicit MFEM CG solve produced non-finite values";
        return false;
    }
    return true;
}

#ifdef MFEM_USE_MPI
bool forced_hypre_tangent_plane_solver()
{
    const char *solver = std::getenv("FULLMAG_FEM_TPI_LINEAR_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "hypre") == 0 || std::strcmp(solver, "HYPRE") == 0);
}

bool forced_serial_tangent_plane_solver()
{
    const char *solver = std::getenv("FULLMAG_FEM_TPI_LINEAR_SOLVER");
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

bool should_use_hypre_tangent_plane_solver()
{
    if (forced_hypre_tangent_plane_solver()) {
        return true;
    }
    if (forced_serial_tangent_plane_solver()) {
        return false;
    }
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (initialized) {
        return true;
    }
    return openmpi_singleton_can_create_socket();
}

bool solve_tangent_plane_hypre_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
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
    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(A_par);
        amg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        preconditioner = std::make_unique<mfem::HypreDiagScale>(A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(A_par);
        preconditioner = std::move(identity);
        break;
    }
    default:
        error = "tangent-plane implicit requested an unsupported preconditioner";
        return false;
    }

    mfem::HyprePCG solver(fullmag_serial_comm());
    solver.iterative_mode = false;
    solver.SetTol(kLinearSolveRelativeTolerance);
    solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
    solver.SetMaxIter(kLinearSolveMaximumIterations);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetOperator(A_par);
    solver.SetPreconditioner(*preconditioner);
    solver.Mult(b_par, x_par);

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    solver.GetNumIterations(iterations);
    solver.GetFinalResidualNorm(final_residual);
    if (!std::isfinite(static_cast<double>(final_residual))) {
        error = "tangent-plane implicit Hypre solve produced a non-finite residual";
        return false;
    }
    const double residual_limit = std::max(
        kLinearSolveAbsoluteTolerance,
        kLinearSolveRelativeTolerance * std::max(1.0, rhs.Norml2()));
    if (static_cast<double>(final_residual) > residual_limit && iterations >= kLinearSolveMaximumIterations) {
        error = "tangent-plane implicit Hypre solve did not converge";
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

bool solve_tangent_plane_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
#ifdef MFEM_USE_MPI
    if (should_use_hypre_tangent_plane_solver()) {
        return solve_tangent_plane_hypre_system(ctx, op, rhs, solution, error);
    }
#endif
    return solve_tangent_plane_mfem_cg_system(ctx, op, rhs, solution, error);
}

bool solve_tangent_plane_linear_system(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &gradient,
    double implicit_weight,
    std::vector<double> &direction,
    std::string &error)
{
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.mass_form);
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    if (mass_form == nullptr || exchange_form == nullptr) {
        error = "tangent-plane implicit relaxation requires MFEM mass and exchange forms";
        return false;
    }
    const size_t nodes = m_xyz.size() / 3u;
    if (mass_form->FESpace() == nullptr ||
        mass_form->FESpace()->GetNDofs() != static_cast<int>(nodes)) {
        error = "tangent-plane implicit mass form size does not match magnetization nodes";
        return false;
    }
    if (exchange_form->FESpace() == nullptr ||
        exchange_form->FESpace()->GetNDofs() != static_cast<int>(nodes)) {
        error = "tangent-plane implicit exchange form size does not match magnetization nodes";
        return false;
    }

    const std::vector<TangentFrame> frames = build_tangent_frames(ctx, m_xyz);
    std::vector<double> mass_gradient;
    if (!apply_mass_to_field(mass_form->SpMat(), gradient, mass_gradient)) {
        error = "tangent-plane implicit mass-gradient RHS produced non-finite values";
        return false;
    }

    std::vector<double> rhs(nodes * 2u, 0.0);
    for (size_t node = 0; node < nodes; ++node) {
        const TangentFrame &frame = frames[node];
        if (!frame.active) {
            continue;
        }
        const size_t q_base = node * 2u;
        rhs[q_base + 0u] = -dot_node(frame.e1, mass_gradient, node);
        rhs[q_base + 1u] = -dot_node(frame.e2, mass_gradient, node);
    }
    if (!all_finite(rhs)) {
        error = "tangent-plane implicit RHS contains non-finite values";
        return false;
    }

    std::unique_ptr<mfem::SparseMatrix> tangent_operator =
        assemble_tangent_plane_operator(
            frames,
            mass_form->SpMat(),
            exchange_form->SpMat(),
            implicit_weight);
    mfem::Vector rhs_vector(static_cast<int>(rhs.size()));
    for (int i = 0; i < rhs_vector.Size(); ++i) {
        rhs_vector[i] = rhs[static_cast<size_t>(i)];
    }
    mfem::Vector solution;
    if (!solve_tangent_plane_sparse_system(
            ctx,
            *tangent_operator,
            rhs_vector,
            solution,
            error)) {
        return false;
    }
    expand_tangent_solution_to_field(frames, solution, direction);
    direction = relaxation::project_tangent(ctx, m_xyz, direction);
    return all_finite(direction);
}

#endif

} // namespace

int run_tangent_plane_implicit_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int lane_status =
        relaxation::ensure_cpu_mfem_relaxation_lane(ctx, "tangent-plane implicit", error);
    if (lane_status != FULLMAG_FEM_OK) {
        return lane_status;
    }

    fullmag_fem_step_stats current_stats{};
    if (!context_snapshot_stats_mfem(ctx, current_stats, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (ctx.effective_field.h_xyz.size() != ctx.state.m_xyz.size()) {
        error = "tangent-plane implicit relaxation requires a current native H_eff field";
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    const std::vector<double> previous_m = ctx.state.m_xyz;
    std::vector<double> gradient;
    relaxation::tangent_gradient_from_field(
        ctx,
        previous_m,
        ctx.effective_field.h_xyz,
        gradient);
    const double g_norm_sq = relaxation::metric_gradient_norm_sq(ctx, gradient);
    if (g_norm_sq <= relaxation::kGradientFloor) {
        out_stats = current_stats;
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_OK;
    }

    double trial_step = std::clamp(
        ctx.relaxation.step_size,
        relaxation::kMinStepSize,
        relaxation::kMaxStepSize);
    fullmag_fem_step_stats trial_stats{};
    std::vector<double> trial_m;
    uint32_t backtracks = 0u;
    int status = FULLMAG_FEM_OK;
    double direction_dot_gradient = 0.0;
    while (true) {
        std::vector<double> direction;
        if (!solve_tangent_plane_linear_system(
                ctx,
                previous_m,
                gradient,
                trial_step,
                direction,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        direction_dot_gradient =
            relaxation::metric_dot_fields(ctx, direction, gradient);
        if (direction_dot_gradient >= 0.0) {
            error = "tangent-plane implicit relaxation produced a non-descent tangent direction";
            return FULLMAG_FEM_ERR_INTERNAL;
        }

        trial_m = relaxation::retracted_step(ctx, previous_m, direction, trial_step);
        status = relaxation::upload_and_snapshot(ctx, trial_m, trial_stats, error);
        if (status != FULLMAG_FEM_OK) {
            const std::string trial_error = error;
            std::string restore_error;
            (void)context_upload_magnetization_f64(
                ctx,
                previous_m.data(),
                static_cast<uint64_t>(previous_m.size()),
                restore_error);
            error = trial_error;
            return status;
        }
        const bool armijo =
            trial_stats.total_energy_joules <=
            current_stats.total_energy_joules +
                relaxation::kArmijoCoefficient * trial_step * direction_dot_gradient;
        if (armijo || backtracks >= relaxation::kTangentPlaneImplicitMaxBacktracks) {
            break;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }

    update_implicit_step_size(ctx.relaxation, trial_step, backtracks);
    relaxation::finish_accepted_relaxation_step(
        ctx,
        trial_stats,
        out_stats,
        trial_step);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)out_stats;
    error = "tangent-plane implicit relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
