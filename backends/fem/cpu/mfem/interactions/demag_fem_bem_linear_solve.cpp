/*
 * FEM/BEM demag linear-solve source contract.
 *
 * This source owns sparse Hypre/MPI solve policy for FEM/BEM scalar systems,
 * cached Hypre operator/preconditioner/solver reuse, and CG/GMRES dispatch. It does not assemble boundary operators, prepare RHS, transfer boundary values, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
#ifdef MFEM_USE_MPI
struct FemBemHypreCache {
    std::unique_ptr<mfem::HypreParMatrix> A_par;
    std::unique_ptr<mfem::HypreSolver> preconditioner;
    std::unique_ptr<mfem::HypreSolver> solver;
    std::unique_ptr<mfem::HypreParVector> b_par;
    std::unique_ptr<mfem::HypreParVector> x_par;
    bool setup_done = false;
};

bool fem_bem_forced_hypre_solver()
{
    const char *solver = std::getenv("FULLMAG_FEM_FEM_BEM_LINEAR_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "hypre") == 0 || std::strcmp(solver, "HYPRE") == 0);
}

bool fem_bem_forced_serial_solver()
{
    const char *solver = std::getenv("FULLMAG_FEM_FEM_BEM_LINEAR_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "mfem_serial") == 0 ||
         std::strcmp(solver, "serial") == 0 ||
         std::strcmp(solver, "MFEM_SERIAL") == 0 ||
         std::strcmp(solver, "SERIAL") == 0);
}

bool should_use_hypre_fem_bem_solver()
{
    if (fem_bem_forced_hypre_solver()) {
        return true;
    }
    if (fem_bem_forced_serial_solver()) {
        return false;
    }
    int initialized = 0;
    MPI_Initialized(&initialized);
    return initialized != 0;
}
#endif

bool solve_demag_fem_bem_serial_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    int &iterations,
    double &residual,
    std::string &error)
{
    if (solution.Size() != rhs.Size()) {
        solution.SetSize(rhs.Size());
        solution = 0.0;
    }

    const int max_iterations = std::max(1, static_cast<int>(ctx.demag.solver.max_iterations));
    const double rel_tol =
        ctx.demag.solver.relative_tolerance > 0.0 ? ctx.demag.solver.relative_tolerance : 1.0e-8;
    const double abs_tol =
        ctx.demag.solver.has_absolute_tolerance && ctx.demag.solver.absolute_tolerance > 0.0
            ? ctx.demag.solver.absolute_tolerance
            : 1.0e-24;

    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        mfem::DSmoother preconditioner(op);
        mfem::GMRESSolver solver;
        solver.SetRelTol(rel_tol);
        solver.SetAbsTol(abs_tol);
        solver.SetMaxIter(max_iterations);
        solver.SetKDim(50);
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetPreconditioner(preconditioner);
        solver.SetOperator(op);
        solver.Mult(rhs, solution);
    } else {
        mfem::GSSmoother preconditioner(op);
        mfem::CGSolver solver;
        solver.SetRelTol(rel_tol);
        solver.SetAbsTol(abs_tol);
        solver.SetMaxIter(max_iterations);
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetPreconditioner(preconditioner);
        solver.SetOperator(op);
        solver.Mult(rhs, solution);
    }

    mfem::Vector check(rhs.Size());
    op.Mult(solution, check);
    check -= rhs;
    residual = check.Norml2();
    iterations = 0;
    if (!std::isfinite(residual) || !std::isfinite(solution.Norml2())) {
        error = "FEM/BEM demag serial sparse solve produced non-finite values";
        return false;
    }
    const double residual_limit =
        std::max(abs_tol, rel_tol * std::max(1.0, rhs.Norml2()));
    if (residual > residual_limit) {
        error = "FEM/BEM demag serial sparse solve did not converge";
        return false;
    }
    return true;
}

void destroy_fem_bem_hypre_cache(FemBemHypreCache *&cache)
{
#ifdef MFEM_USE_MPI
    if (cache != nullptr) {
        // Destroy solver before preconditioner before operator.
        cache->solver.reset();
        cache->preconditioner.reset();
        cache->x_par.reset();
        cache->b_par.reset();
        cache->A_par.reset();
    }
    delete cache;
    cache = nullptr;
#else
    (void)cache;
#endif
}

bool solve_demag_fem_bem_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    int &iterations,
    double &residual,
    FemBemHypreCache *&cache,
    std::string &error)
{
    iterations = 0;
    residual = 0.0;
#ifdef MFEM_USE_MPI
    if (!should_use_hypre_fem_bem_solver()) {
        return solve_demag_fem_bem_serial_system(
            ctx, op, rhs, solution, iterations, residual, error);
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(op.NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};

    // First call: build and cache the Hypre operator, preconditioner, and solver.
    if (cache == nullptr) {
        cache = new FemBemHypreCache();
    }
    if (!cache->setup_done) {
        cache->A_par = std::make_unique<mfem::HypreParMatrix>(
            fullmag_serial_comm(), glob_size, row_starts, &op);
        cache->b_par = std::make_unique<mfem::HypreParVector>(
            fullmag_serial_comm(), glob_size, row_starts);
        cache->x_par = std::make_unique<mfem::HypreParVector>(
            fullmag_serial_comm(), glob_size, row_starts);

        switch (ctx.demag.solver.preconditioner) {
        case FULLMAG_FEM_PRECONDITIONER_AMG: {
            auto amg = std::make_unique<mfem::HypreBoomerAMG>(*cache->A_par);
            amg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
            cache->preconditioner = std::move(amg);
            break;
        }
        case FULLMAG_FEM_PRECONDITIONER_JACOBI:
            cache->preconditioner =
                std::make_unique<mfem::HypreDiagScale>(*cache->A_par);
            break;
        case FULLMAG_FEM_PRECONDITIONER_NONE: {
            auto identity = std::make_unique<mfem::HypreIdentity>();
            identity->SetOperator(*cache->A_par);
            cache->preconditioner = std::move(identity);
            break;
        }
        default:
            error = "FEM/BEM demag requested an unsupported preconditioner";
            return false;
        }

        if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
            auto gmres = std::make_unique<mfem::HypreGMRES>(fullmag_serial_comm());
            gmres->iterative_mode = true;
            gmres->SetTol(ctx.demag.solver.relative_tolerance);
            if (ctx.demag.solver.has_absolute_tolerance &&
                ctx.demag.solver.absolute_tolerance > 0.0) {
                gmres->SetAbsTol(ctx.demag.solver.absolute_tolerance);
            }
            gmres->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
            gmres->SetKDim(50);
            gmres->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
            gmres->SetOperator(*cache->A_par);
            gmres->SetPreconditioner(*cache->preconditioner);
            cache->solver = std::move(gmres);
        } else {
            auto pcg = std::make_unique<mfem::HyprePCG>(fullmag_serial_comm());
            pcg->iterative_mode = true;
            pcg->SetTol(ctx.demag.solver.relative_tolerance);
            if (ctx.demag.solver.has_absolute_tolerance &&
                ctx.demag.solver.absolute_tolerance > 0.0) {
                pcg->SetAbsTol(ctx.demag.solver.absolute_tolerance);
            }
            pcg->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
            pcg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
            pcg->SetOperator(*cache->A_par);
            pcg->SetPreconditioner(*cache->preconditioner);
            cache->solver = std::move(pcg);
        }
        cache->setup_done = true;
    }

    // Copy RHS and initial guess into cached Hypre vectors.
    const double *rhs_host = audited_host_read(rhs);
    const double *initial_solution_host = audited_host_read(solution);
    double *b_host = audited_host_write(*cache->b_par);
    double *x_host = audited_host_write(*cache->x_par);
    for (int i = 0; i < rhs.Size(); ++i) {
        b_host[i] = rhs_host[i];
        x_host[i] = initial_solution_host[i];
    }

    // Solve with cached setup.
    cache->solver->Mult(*cache->b_par, *cache->x_par);
    mfem::real_t final_residual = 0.0;
    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        auto *gmres = static_cast<mfem::HypreGMRES *>(cache->solver.get());
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(final_residual);
    } else {
        auto *pcg = static_cast<mfem::HyprePCG *>(cache->solver.get());
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(final_residual);
    }
    residual = static_cast<double>(final_residual);

    // Copy solution back.
    const double *solved_host = audited_host_read(*cache->x_par);
    solution.SetSize(rhs.Size());
    double *solution_host = audited_host_write(solution);
    for (int i = 0; i < rhs.Size(); ++i) {
        solution_host[i] = solved_host[i];
    }
    return true;
#else
    (void)cache;
    return solve_demag_fem_bem_serial_system(
        ctx, op, rhs, solution, iterations, residual, error);
#endif
}
#endif

} // namespace fullmag::fem
