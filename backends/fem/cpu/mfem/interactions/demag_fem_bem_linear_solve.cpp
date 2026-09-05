/*
 * FEM/BEM demag linear-solve source contract.
 *
 * This source owns sparse Hypre/MPI solve policy for FEM/BEM scalar systems,
 * cached Hypre operator/preconditioner/solver reuse, and CG/GMRES dispatch. It does not assemble boundary operators, prepare RHS, transfer boundary values, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"

#include "context.hpp"
#include "core/demag_linear_solve_validation.hpp"
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
    mfem::Vector candidate(rhs.Size());
    if (solution.Size() == rhs.Size()) {
        candidate = solution;
    } else {
        candidate = 0.0;
    }

    const int max_iterations = std::max(1, static_cast<int>(ctx.demag.solver.max_iterations));
    const double rel_tol =
        ctx.demag.solver.relative_tolerance > 0.0 ? ctx.demag.solver.relative_tolerance : 1.0e-8;
    const double abs_tol =
        ctx.demag.solver.has_absolute_tolerance && ctx.demag.solver.absolute_tolerance > 0.0
            ? ctx.demag.solver.absolute_tolerance
            : 0.0;

    bool solver_reported_converged = false;
    const char *solver_kind = "fem_bem_serial/unknown";
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
        solver.Mult(rhs, candidate);
        iterations = solver.GetNumIterations();
        solver_reported_converged = solver.GetConverged();
        solver_kind = "fem_bem_serial/gmres";
    } else {
        mfem::GSSmoother preconditioner(op);
        mfem::CGSolver solver;
        solver.SetRelTol(rel_tol);
        solver.SetAbsTol(abs_tol);
        solver.SetMaxIter(max_iterations);
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetPreconditioner(preconditioner);
        solver.SetOperator(op);
        solver.Mult(rhs, candidate);
        iterations = solver.GetNumIterations();
        solver_reported_converged = solver.GetConverged();
        solver_kind = "fem_bem_serial/cg";
    }

    mfem::Vector check(rhs.Size());
    op.Mult(candidate, check);
    check -= rhs;
    const double absolute_residual = check.Norml2();
    const double rhs_norm = rhs.Norml2();
    const double relative_residual = rhs_norm > 0.0
        ? absolute_residual / rhs_norm
        : absolute_residual;
    residual = relative_residual;
    if (!std::isfinite(candidate.Norml2())) {
        DemagLinearSolveResult nonfinite_result;
        nonfinite_result.solver_kind = solver_kind;
        nonfinite_result.norm_kind = DemagResidualNormKind::L2;
        nonfinite_result.certification_kind =
            DemagResidualCertificationKind::Unavailable;
        nonfinite_result.solver_reported_converged = false;
        nonfinite_result.iterations = iterations;
        nonfinite_result.relative_residual = relative_residual;
        nonfinite_result.has_absolute_residual = true;
        nonfinite_result.absolute_residual = absolute_residual;
        nonfinite_result.relative_tolerance = rel_tol;
        nonfinite_result.has_absolute_tolerance = abs_tol > 0.0;
        nonfinite_result.absolute_tolerance = abs_tol;
        nonfinite_result.max_iterations = static_cast<uint32_t>(max_iterations);
        validate_demag_linear_solve_result(nonfinite_result, error);
        return false;
    }

    DemagLinearSolveResult result;
    result.solver_kind = solver_kind;
    result.norm_kind = DemagResidualNormKind::L2;
    result.solver_reported_converged = solver_reported_converged;
    result.residual_independently_certified = std::isfinite(absolute_residual);
    result.certification_kind = result.residual_independently_certified
        ? DemagResidualCertificationKind::TrueResidual
        : (solver_reported_converged
               ? DemagResidualCertificationKind::ReportedRecursive
               : DemagResidualCertificationKind::Unavailable);
    result.iterations = iterations;
    result.relative_residual = relative_residual;
    result.has_absolute_residual = true;
    result.absolute_residual = absolute_residual;
    result.relative_tolerance = rel_tol;
    result.has_absolute_tolerance = abs_tol > 0.0;
    result.absolute_tolerance = abs_tol;
    result.max_iterations = static_cast<uint32_t>(max_iterations);
    if (!validate_demag_linear_solve_result(result, error)) {
        return false;
    }
    solution = candidate;
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
        // Clear only at the setup boundary; preserve errors raised by this setup.
        HYPRE_ClearAllErrors();
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
            const HYPRE_Int two_norm_status = HYPRE_PCGSetTwoNorm(
                static_cast<HYPRE_Solver>(*pcg), 1);
            if (two_norm_status != 0) {
                error = "CPU FEM/BEM demag Hypre PCG failed to select L2 residual norm (status " +
                    std::to_string(two_norm_status) + ")";
                destroy_fem_bem_hypre_cache(cache);
                return false;
            }
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
    bool solver_reported_converged = false;
    const char *solver_kind = "fem_bem_hypre/unknown";
    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        auto *gmres = static_cast<mfem::HypreGMRES *>(cache->solver.get());
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(final_residual);
        HYPRE_Int converged = 0;
        HYPRE_GMRESGetConverged(static_cast<HYPRE_Solver>(*gmres), &converged);
        solver_reported_converged = converged != 0;
        solver_kind = "fem_bem_hypre/gmres";
    } else {
        auto *pcg = static_cast<mfem::HyprePCG *>(cache->solver.get());
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(final_residual);
        HYPRE_Int converged = 0;
        HYPRE_PCGGetConverged(static_cast<HYPRE_Solver>(*pcg), &converged);
        solver_reported_converged = converged != 0;
        solver_kind = "fem_bem_hypre/cg";
    }

    // Validate a host candidate before publishing it to the caller.
    const double *solved_host = audited_host_read(*cache->x_par);
    mfem::Vector candidate(rhs.Size());
    double *candidate_host = audited_host_write(candidate);
    for (int i = 0; i < rhs.Size(); ++i) {
        candidate_host[i] = solved_host[i];
    }
    mfem::Vector check(rhs.Size());
    op.Mult(candidate, check);
    check -= rhs;
    const double absolute_residual = check.Norml2();
    const double rhs_norm = rhs.Norml2();
    const double relative_residual = rhs_norm > 0.0
        ? absolute_residual / rhs_norm
        : absolute_residual;
    residual = relative_residual;

    DemagLinearSolveResult result;
    result.solver_kind = solver_kind;
    result.norm_kind = DemagResidualNormKind::L2;
    result.solver_reported_converged = solver_reported_converged;
    result.residual_independently_certified = std::isfinite(absolute_residual);
    result.certification_kind = result.residual_independently_certified
        ? DemagResidualCertificationKind::TrueResidual
        : (solver_reported_converged
               ? DemagResidualCertificationKind::ReportedRecursive
               : DemagResidualCertificationKind::Unavailable);
    result.iterations = iterations;
    result.relative_residual = relative_residual;
    result.has_absolute_residual = true;
    result.absolute_residual = absolute_residual;
    result.relative_tolerance = ctx.demag.solver.relative_tolerance;
    result.has_absolute_tolerance =
        ctx.demag.solver.has_absolute_tolerance != 0 &&
        ctx.demag.solver.absolute_tolerance > 0.0;
    result.absolute_tolerance = ctx.demag.solver.absolute_tolerance;
    result.max_iterations = ctx.demag.solver.max_iterations;
    if (!validate_demag_linear_solve_result(result, error)) {
        *cache->x_par = 0.0;
        return false;
    }
    solution = candidate;
    return true;
#else
    (void)cache;
    return solve_demag_fem_bem_serial_system(
        ctx, op, rhs, solution, iterations, residual, error);
#endif
}
#endif

} // namespace fullmag::fem
