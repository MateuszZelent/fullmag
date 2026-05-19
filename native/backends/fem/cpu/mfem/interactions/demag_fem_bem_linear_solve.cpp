/*
 * FEM/BEM demag linear-solve source contract.
 *
 * This source owns sparse Hypre/MPI solve policy for FEM/BEM scalar systems,
 * local MPI initialization, and CG/GMRES dispatch. It does not assemble boundary operators, prepare RHS, transfer boundary values, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"

#include "context.hpp"

#include <memory>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {
namespace {

#if FULLMAG_HAS_MFEM_STACK
#ifdef MFEM_USE_MPI
void ensure_local_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (initialized == 0) {
        int argc = 0;
        char **argv = nullptr;
        MPI_Init(&argc, &argv);
    }
}
#endif
#endif

} // namespace

#if FULLMAG_HAS_MFEM_STACK
bool solve_demag_fem_bem_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    int &iterations,
    double &residual,
    std::string &error)
{
    iterations = 0;
    residual = 0.0;
#ifdef MFEM_USE_MPI
    ensure_local_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(op.NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};
    auto A_par = std::make_unique<mfem::HypreParMatrix>(MPI_COMM_WORLD, glob_size, row_starts, &op);
    mfem::HypreParVector b_par(MPI_COMM_WORLD, glob_size, row_starts);
    mfem::HypreParVector x_par(MPI_COMM_WORLD, glob_size, row_starts);
    double *b_host = b_par.HostWrite();
    double *x_host = x_par.HostWrite();
    for (int i = 0; i < rhs.Size(); ++i) {
        b_host[i] = rhs(i);
        x_host[i] = solution(i);
    }

    std::unique_ptr<mfem::HypreSolver> preconditioner;
    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(*A_par);
        amg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        preconditioner = std::make_unique<mfem::HypreDiagScale>(*A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(*A_par);
        preconditioner = std::move(identity);
        break;
    }
    default:
        error = "FEM/BEM demag requested an unsupported preconditioner";
        return false;
    }

    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        mfem::HypreGMRES solver(MPI_COMM_WORLD);
        solver.iterative_mode = true;
        solver.SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            solver.SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        solver.SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        solver.SetKDim(50);
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetOperator(*A_par);
        solver.SetPreconditioner(*preconditioner);
        solver.Mult(b_par, x_par);
        mfem::real_t final_residual = 0.0;
        solver.GetNumIterations(iterations);
        solver.GetFinalResidualNorm(final_residual);
        residual = static_cast<double>(final_residual);
    } else {
        mfem::HyprePCG solver(MPI_COMM_WORLD);
        solver.iterative_mode = true;
        solver.SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            solver.SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        solver.SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetOperator(*A_par);
        solver.SetPreconditioner(*preconditioner);
        solver.Mult(b_par, x_par);
        mfem::real_t final_residual = 0.0;
        solver.GetNumIterations(iterations);
        solver.GetFinalResidualNorm(final_residual);
        residual = static_cast<double>(final_residual);
    }

    const double *solved_host = x_par.HostRead();
    solution.SetSize(rhs.Size());
    for (int i = 0; i < rhs.Size(); ++i) {
        solution(i) = solved_host[i];
    }
    return true;
#else
    (void)ctx;
    (void)op;
    (void)rhs;
    (void)solution;
    error =
        "FEM/BEM demag requires an MPI/Hypre-enabled MFEM runtime in this initial dense-reference implementation";
    return false;
#endif
}
#endif

} // namespace fullmag::fem
