#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"

#include "context.hpp"

#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

struct PeriodicPoissonReducedWorkspace {
    explicit PeriodicPoissonReducedWorkspace(mfem::SparseMatrix &op)
        : preconditioner(op)
    {
        solver.SetPreconditioner(preconditioner);
        solver.SetOperator(op);
        solver.SetPrintLevel(0);
    }

    void configure(double rel_tol, int max_iter) {
        solver.SetRelTol(rel_tol);
        solver.SetMaxIter(max_iter);
    }

    mfem::GSSmoother preconditioner;
    mfem::CGSolver solver;
    mfem::Vector full_solution;
};

mfem::SparseMatrix *reduce_sparse_matrix_by_periodic_classes(
    const mfem::SparseMatrix &A,
    const Context &ctx)
{
    const int nred = static_cast<int>(ctx.periodic_reduced_node_count);
    auto *R = new mfem::SparseMatrix(nred, nred);

    mfem::Array<int> cols;
    mfem::Vector vals;
    for (int i = 0; i < A.Height(); ++i) {
        const int ri = static_cast<int>(
            ctx.periodic_reduced_node[static_cast<size_t>(i)]);
        A.GetRow(i, cols, vals);
        for (int k = 0; k < cols.Size(); ++k) {
            const int rj = static_cast<int>(
                ctx.periodic_reduced_node[static_cast<size_t>(cols[k])]);
            R->Add(ri, rj, vals[k]);
        }
    }
    R->Finalize();
    return R;
}

void reduce_vector_by_periodic_classes(
    const Context &ctx,
    const mfem::Vector &full,
    mfem::Vector &reduced)
{
    reduced.SetSize(static_cast<int>(ctx.periodic_reduced_node_count));
    reduced = 0.0;
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t r = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        reduced[static_cast<int>(r)] += full[static_cast<int>(node)];
    }
}

void lift_vector_by_periodic_classes(
    const Context &ctx,
    const mfem::Vector &reduced,
    mfem::Vector &full)
{
    full.SetSize(static_cast<int>(ctx.n_nodes));
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t r = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        full[static_cast<int>(node)] = reduced[static_cast<int>(r)];
    }
}

} // namespace

bool initialize_demag_periodic_poisson_reduction(
    Context &ctx,
    std::string &error)
{
    if (!ctx.demag_periodic_enabled() || ctx.periodic_reduced_node_count == 0) {
        return true;
    }

    auto *A_full = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_full == nullptr) {
        error = "Poisson BC operator is null when building periodic reduced system";
        return false;
    }

    try {
        ctx.mfem_periodic_poisson_matrix =
            reduce_sparse_matrix_by_periodic_classes(*A_full, ctx);
        ctx.mfem_periodic_poisson_rhs =
            new mfem::Vector(static_cast<int>(ctx.periodic_reduced_node_count));
        auto *periodic_solution =
            new mfem::Vector(static_cast<int>(ctx.periodic_reduced_node_count));
        *periodic_solution = 0.0;
        ctx.mfem_periodic_poisson_solution = periodic_solution;
        ctx.mfem_periodic_poisson_workspace =
            new PeriodicPoissonReducedWorkspace(
                *static_cast<mfem::SparseMatrix *>(ctx.mfem_periodic_poisson_matrix));
        ctx.poisson_periodic_reduced_ready = true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Periodic Poisson reduced-system initialization failed: ") + ex.what();
    } catch (...) {
        error = "Periodic Poisson reduced-system initialization failed with an unknown error";
    }
    destroy_demag_periodic_poisson_reduction(ctx);
    return false;
}

void destroy_demag_periodic_poisson_reduction(Context &ctx)
{
    delete static_cast<PeriodicPoissonReducedWorkspace *>(ctx.mfem_periodic_poisson_workspace);
    ctx.mfem_periodic_poisson_workspace = nullptr;
    delete static_cast<mfem::SparseMatrix *>(ctx.mfem_periodic_poisson_matrix);
    ctx.mfem_periodic_poisson_matrix = nullptr;
    delete static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_rhs);
    ctx.mfem_periodic_poisson_rhs = nullptr;
    delete static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_solution);
    ctx.mfem_periodic_poisson_solution = nullptr;
    ctx.poisson_periodic_reduced_ready = false;
}

bool solve_demag_periodic_poisson_reduced(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector *&full_solution,
    uint64_t &solve_wall_time_ns,
    std::string &error)
{
    full_solution = nullptr;
    solve_wall_time_ns = 0;
    auto *rhs_p = static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_rhs);
    auto *x_p = static_cast<mfem::Vector *>(ctx.mfem_periodic_poisson_solution);
    auto *periodic_workspace =
        static_cast<PeriodicPoissonReducedWorkspace *>(ctx.mfem_periodic_poisson_workspace);
    if (ctx.mfem_periodic_poisson_matrix == nullptr ||
        rhs_p == nullptr ||
        x_p == nullptr ||
        periodic_workspace == nullptr) {
        error = "Periodic Poisson reduced system is not properly initialised";
        return false;
    }

    const auto solve_wall_start = SteadyClock::now();
    reduce_vector_by_periodic_classes(ctx, rhs, *rhs_p);

    const double rel_tol = ctx.demag_solver.relative_tolerance > 0.0
                               ? ctx.demag_solver.relative_tolerance
                               : 1e-10;
    const int max_iter = ctx.demag_solver.max_iterations > 0
                             ? static_cast<int>(ctx.demag_solver.max_iterations)
                             : 1000;
    periodic_workspace->configure(rel_tol, max_iter);
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_setup_reused = true;
    const auto solver_apply_wall_start = SteadyClock::now();
    periodic_workspace->solver.Mult(*rhs_p, *x_p);
    ctx.poisson_last_solver_apply_wall_time_ns =
        elapsed_ns(solver_apply_wall_start);
    ctx.poisson_last_iterations = 0;
    ctx.poisson_last_residual = 0.0;

    mfem::Vector &lifted_solution = periodic_workspace->full_solution;
    lift_vector_by_periodic_classes(ctx, *x_p, lifted_solution);
    solve_wall_time_ns = elapsed_ns(solve_wall_start);
    full_solution = &lifted_solution;
    return true;
}
#endif

} // namespace fullmag::fem
