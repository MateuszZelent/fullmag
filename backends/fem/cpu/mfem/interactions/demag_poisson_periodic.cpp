/*
 * Poisson demag periodic-reduction source contract.
 *
 * This source owns periodic Poisson reduction, reduced solve, and lift helpers
 * for the static periodic class space. It does not assemble RHS, recover fields, compute energy, or manage non-periodic Hypre state.
 */

#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <string>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

bool demag_periodic_poisson_reduction_requested(const Context &ctx)
{
    if (!ctx.demag.enabled ||
        ctx.mesh.periodic_node_pairs.empty() ||
        ctx.mesh.periodic_reduced_node_count == 0 ||
        ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(ctx.mesh.n_nodes) ||
        ctx.mesh.periodic_representative_nodes.size() !=
            static_cast<size_t>(ctx.mesh.periodic_reduced_node_count)) {
        return false;
    }
    return std::all_of(
        ctx.mesh.periodic_reduced_node.begin(),
        ctx.mesh.periodic_reduced_node.end(),
        [&ctx](uint32_t reduced) {
            return reduced < ctx.mesh.periodic_reduced_node_count;
        });
}

#if FULLMAG_HAS_MFEM_STACK
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

namespace {

mfem::SparseMatrix *reduce_sparse_matrix_by_periodic_classes(
    const mfem::SparseMatrix &A,
    const Context &ctx)
{
    const int nred = static_cast<int>(ctx.mesh.periodic_reduced_node_count);
    auto *R = new mfem::SparseMatrix(nred, nred);

    mfem::Array<int> cols;
    mfem::Vector vals;
    for (int i = 0; i < A.Height(); ++i) {
        const int ri = static_cast<int>(
            ctx.mesh.periodic_reduced_node[static_cast<size_t>(i)]);
        A.GetRow(i, cols, vals);
        for (int k = 0; k < cols.Size(); ++k) {
            const int rj = static_cast<int>(
                ctx.mesh.periodic_reduced_node[static_cast<size_t>(cols[k])]);
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
    reduced.SetSize(static_cast<int>(ctx.mesh.periodic_reduced_node_count));
    reduced = 0.0;
    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const uint32_t r = ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
        reduced[static_cast<int>(r)] += full[static_cast<int>(node)];
    }
}

void lift_vector_by_periodic_classes(
    const Context &ctx,
    const mfem::Vector &reduced,
    mfem::Vector &full)
{
    full.SetSize(static_cast<int>(ctx.mesh.n_nodes));
    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const uint32_t r = ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
        full[static_cast<int>(node)] = reduced[static_cast<int>(r)];
    }
}

} // namespace

bool initialize_demag_periodic_poisson_reduction(
    Context &ctx,
    std::string &error)
{
    if (!demag_periodic_poisson_reduction_requested(ctx) ||
        ctx.mesh.periodic_reduced_node_count == 0) {
        return true;
    }

    auto *A_full = static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.poisson_bc_op);
    if (A_full == nullptr) {
        error = "Poisson BC operator is null when building periodic reduced system";
        return false;
    }

    try {
        ctx.poisson_demag.periodic_matrix =
            reduce_sparse_matrix_by_periodic_classes(*A_full, ctx);
        ctx.poisson_demag.periodic_rhs =
            new mfem::Vector(static_cast<int>(ctx.mesh.periodic_reduced_node_count));
        auto *periodic_solution =
            new mfem::Vector(static_cast<int>(ctx.mesh.periodic_reduced_node_count));
        *periodic_solution = 0.0;
        ctx.poisson_demag.periodic_solution = periodic_solution;
        ctx.poisson_demag.periodic_workspace =
            new PeriodicPoissonReducedWorkspace(
                *static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.periodic_matrix));
        ctx.poisson_demag.periodic_reduced_ready = true;
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
    delete static_cast<PeriodicPoissonReducedWorkspace *>(ctx.poisson_demag.periodic_workspace);
    ctx.poisson_demag.periodic_workspace = nullptr;
    delete static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.periodic_matrix);
    ctx.poisson_demag.periodic_matrix = nullptr;
    delete static_cast<mfem::Vector *>(ctx.poisson_demag.periodic_rhs);
    ctx.poisson_demag.periodic_rhs = nullptr;
    delete static_cast<mfem::Vector *>(ctx.poisson_demag.periodic_solution);
    ctx.poisson_demag.periodic_solution = nullptr;
    ctx.poisson_demag.periodic_reduced_ready = false;
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
    auto *rhs_p = static_cast<mfem::Vector *>(ctx.poisson_demag.periodic_rhs);
    auto *x_p = static_cast<mfem::Vector *>(ctx.poisson_demag.periodic_solution);
    auto *periodic_workspace =
        static_cast<PeriodicPoissonReducedWorkspace *>(ctx.poisson_demag.periodic_workspace);
    if (ctx.poisson_demag.periodic_matrix == nullptr ||
        rhs_p == nullptr ||
        x_p == nullptr ||
        periodic_workspace == nullptr) {
        error = "Periodic Poisson reduced system is not properly initialised";
        return false;
    }

    const auto solve_wall_start = FemSteadyClock::now();
    reduce_vector_by_periodic_classes(ctx, rhs, *rhs_p);

    const double rel_tol = ctx.demag.solver.relative_tolerance > 0.0
                               ? ctx.demag.solver.relative_tolerance
                               : 1e-10;
    const int max_iter = ctx.demag.solver.max_iterations > 0
                             ? static_cast<int>(ctx.demag.solver.max_iterations)
                             : 1000;
    periodic_workspace->configure(rel_tol, max_iter);
    ctx.poisson_demag.last_setup_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_setup_reused = true;
    *x_p = 0.0;
    const auto solver_apply_wall_start = FemSteadyClock::now();
    periodic_workspace->solver.Mult(*rhs_p, *x_p);
    ctx.poisson_demag.last_solver_apply_wall_time_ns =
        elapsed_ns(solver_apply_wall_start);
    ctx.poisson_demag.last_iterations =
        periodic_workspace->solver.GetNumIterations();
    ctx.poisson_demag.last_residual =
        static_cast<double>(periodic_workspace->solver.GetFinalNorm());

    mfem::Vector &lifted_solution = periodic_workspace->full_solution;
    lift_vector_by_periodic_classes(ctx, *x_p, lifted_solution);
    solve_wall_time_ns = elapsed_ns(solve_wall_start);
    full_solution = &lifted_solution;
    return true;
}
#endif

} // namespace fullmag::fem
