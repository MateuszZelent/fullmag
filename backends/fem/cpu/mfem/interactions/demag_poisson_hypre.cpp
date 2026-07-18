/*
 * Poisson demag Hypre solve source contract.
 *
 * This source owns non-periodic Hypre vector workspace, warm-start state, solver
 * setup, and parallel solve for the scalar potential system. It does not assemble RHS, construct boundary operators, recover H_demag, compute energy, or format telemetry.
 */

#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"

#include "context.hpp"
#include "core/demag_linear_solve_validation.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "fem_common.hpp"

#include <climits>
#include <cstdlib>
#include <cstdint>
#include <string>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
#ifdef MFEM_USE_MPI
struct PoissonHypreWorkspace {
    PoissonHypreWorkspace(
        MPI_Comm comm,
        HYPRE_BigInt glob_size,
        HYPRE_BigInt *row_starts)
        : rhs_bc(static_cast<int>(glob_size))
        , b_par(comm, glob_size, row_starts)
        , x_par(comm, glob_size, row_starts)
    {}

    mfem::Vector rhs_bc;
    mfem::HypreParVector b_par;
    mfem::HypreParVector x_par;
    bool x_par_contains_solution = false;
};
#endif

namespace {

#ifdef MFEM_USE_MPI
int demag_amg_int_env(const char *name, int default_value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return default_value;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0 || parsed > INT_MAX) {
        return default_value;
    }
    return static_cast<int>(parsed);
}

bool demag_amg_optional_int_env(const char *name, int &value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0 || parsed > INT_MAX) {
        return false;
    }
    value = static_cast<int>(parsed);
    return true;
}

bool demag_amg_real_env(const char *name, mfem::real_t &value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    const double parsed = std::strtod(raw, &end);
    if (end == raw || *end != '\0' || parsed < 0.0) {
        return false;
    }
    value = static_cast<mfem::real_t>(parsed);
    return true;
}

void configure_demag_amg(mfem::HypreBoomerAMG &amg, const Context &ctx)
{
    amg.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    amg.SetRelaxType(demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE", 18));
    amg.SetCoarsening(demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_COARSENING", 8));
    amg.SetInterpolation(demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_INTERPOLATION", 6));
    amg.SetAggressiveCoarsening(
        demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING", 1));
    mfem::real_t strength_threshold = 0.0;
    if (demag_amg_real_env("FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD", strength_threshold)) {
        amg.SetStrengthThresh(strength_threshold);
    }
    int max_levels = 0;
    if (demag_amg_optional_int_env("FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS", max_levels)) {
        amg.SetMaxLevels(max_levels);
    }
}
#endif

void zero_poisson_essential_values(const Context &ctx, mfem::Vector &vec) {
    for (const int tdof : ctx.poisson_demag.ess_tdof_list) {
        vec(tdof) = 0.0;
    }
}



} // namespace

bool demag_poisson_hypre_has_warm_start(const Context &ctx)
{
#ifdef MFEM_USE_MPI
    auto *workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.poisson_demag.hypre_workspace);
    return workspace != nullptr && workspace->x_par_contains_solution;
#else
    (void)ctx;
    return false;
#endif
}

void reset_demag_poisson_hypre_initial_guess(Context &ctx)
{
#ifdef MFEM_USE_MPI
    auto *workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.poisson_demag.hypre_workspace);
    if (workspace != nullptr) {
        workspace->x_par = 0.0;
        workspace->x_par_contains_solution = true;
    }
    auto *potential =
        static_cast<mfem::GridFunction *>(ctx.poisson_demag.gf_potential);
    if (potential != nullptr) {
        *potential = 0.0;
    }
    auto *solution =
        static_cast<mfem::Vector *>(ctx.poisson_demag.solution_vec);
    if (solution != nullptr) {
        *solution = 0.0;
    }
#else
    (void)ctx;
#endif
}

void destroy_demag_poisson_hypre_workspace(Context &ctx)
{
#ifdef MFEM_USE_MPI
    delete static_cast<PoissonHypreWorkspace *>(ctx.poisson_demag.hypre_workspace);
    ctx.poisson_demag.hypre_workspace = nullptr;
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG:
        delete static_cast<mfem::HyprePCG *>(ctx.poisson_demag.cached_hypre_solver);
        break;
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES:
        delete static_cast<mfem::HypreGMRES *>(ctx.poisson_demag.cached_hypre_solver);
        break;
    default:
        break;
    }
    ctx.poisson_demag.cached_hypre_solver = nullptr;
    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG:
        delete static_cast<mfem::HypreBoomerAMG *>(ctx.poisson_demag.cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        delete static_cast<mfem::HypreDiagScale *>(ctx.poisson_demag.cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        delete static_cast<mfem::HypreIdentity *>(ctx.poisson_demag.cached_hypre_preconditioner);
        break;
    default:
        break;
    }
    ctx.poisson_demag.cached_hypre_preconditioner = nullptr;
    delete static_cast<mfem::HypreParMatrix *>(ctx.poisson_demag.cached_hypre_par);
    ctx.poisson_demag.cached_hypre_par = nullptr;
#else
    ctx.poisson_demag.hypre_workspace = nullptr;
    ctx.poisson_demag.cached_hypre_solver = nullptr;
    ctx.poisson_demag.cached_hypre_preconditioner = nullptr;
    ctx.poisson_demag.cached_hypre_par = nullptr;
#endif
    ctx.poisson_demag.solver_setup = false;
    ctx.poisson_demag.last_setup_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_apply_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_setup_reused = false;
}

bool solve_demag_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    const mfem::Vector &warm_start_solution,
    const mfem::Vector *&solved_solution,
    std::string &error)
{
    solved_solution = nullptr;
#ifdef MFEM_USE_MPI
    ctx.poisson_demag.last_setup_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_apply_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_setup_reused = ctx.poisson_demag.solver_setup;
    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.poisson_bc_op);
    if (A_bc == nullptr) {
        error = "Poisson BC-eliminated operator is null during Hypre solve";
        return false;
    }

    ensure_mpi_initialized();

    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};

    auto *poisson_hypre_workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.poisson_demag.hypre_workspace);
    if (poisson_hypre_workspace == nullptr) {
        poisson_hypre_workspace =
            new PoissonHypreWorkspace(fullmag_serial_comm(), glob_size, row_starts);
        ctx.poisson_demag.hypre_workspace = poisson_hypre_workspace;
    }

    mfem::Vector &rhs_bc = poisson_hypre_workspace->rhs_bc;
    rhs_bc.SetSize(rhs.Size());
    rhs_bc = rhs;
    zero_poisson_essential_values(ctx, rhs_bc);

    if (!ctx.poisson_demag.solver_setup) {
        const auto setup_wall_start = FemSteadyClock::now();
        auto *A_par = new mfem::HypreParMatrix(fullmag_serial_comm(), glob_size, row_starts, A_bc);
        ctx.poisson_demag.cached_hypre_par = A_par;

        mfem::HypreSolver *preconditioner = nullptr;
        switch (ctx.demag.solver.preconditioner) {
        case FULLMAG_FEM_PRECONDITIONER_AMG: {
            auto *amg = new mfem::HypreBoomerAMG(*A_par);
            configure_demag_amg(*amg, ctx);
            preconditioner = amg;
            break;
        }
        case FULLMAG_FEM_PRECONDITIONER_JACOBI:
            preconditioner = new mfem::HypreDiagScale(*A_par);
            break;
        case FULLMAG_FEM_PRECONDITIONER_NONE: {
            auto *identity = new mfem::HypreIdentity();
            preconditioner = identity;
            break;
        }
        default:
            error = "Unsupported native FEM demag preconditioner enum";
            delete A_par;
            ctx.poisson_demag.cached_hypre_par = nullptr;
            return false;
        }
        ctx.poisson_demag.cached_hypre_preconditioner = preconditioner;

        mfem::HypreSolver *solver = nullptr;
        switch (ctx.demag.solver.solver) {
        case FULLMAG_FEM_LINEAR_SOLVER_CG: {
            auto *pcg = new mfem::HyprePCG(fullmag_serial_comm());
            pcg->iterative_mode = true;
            pcg->SetTol(ctx.demag.solver.relative_tolerance);
            if (ctx.demag.solver.has_absolute_tolerance &&
                ctx.demag.solver.absolute_tolerance > 0.0) {
                pcg->SetAbsTol(ctx.demag.solver.absolute_tolerance);
            }
            pcg->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
            pcg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
            pcg->SetOperator(*A_par);
            pcg->SetPreconditioner(*preconditioner);
            solver = pcg;
            break;
        }
        case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
            auto *gmres = new mfem::HypreGMRES(fullmag_serial_comm());
            gmres->iterative_mode = true;
            gmres->SetTol(ctx.demag.solver.relative_tolerance);
            if (ctx.demag.solver.has_absolute_tolerance &&
                ctx.demag.solver.absolute_tolerance > 0.0) {
                gmres->SetAbsTol(ctx.demag.solver.absolute_tolerance);
            }
            gmres->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
            gmres->SetKDim(50);
            gmres->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
            gmres->SetOperator(*A_par);
            gmres->SetPreconditioner(*preconditioner);
            solver = gmres;
            break;
        }
        default:
            error = "Unsupported native FEM demag linear solver enum";
            switch (ctx.demag.solver.preconditioner) {
            case FULLMAG_FEM_PRECONDITIONER_AMG:
                delete static_cast<mfem::HypreBoomerAMG *>(ctx.poisson_demag.cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_JACOBI:
                delete static_cast<mfem::HypreDiagScale *>(ctx.poisson_demag.cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_NONE:
                delete static_cast<mfem::HypreIdentity *>(ctx.poisson_demag.cached_hypre_preconditioner);
                break;
            default:
                break;
            }
            ctx.poisson_demag.cached_hypre_preconditioner = nullptr;
            delete A_par;
            ctx.poisson_demag.cached_hypre_par = nullptr;
            return false;
        }
        ctx.poisson_demag.cached_hypre_solver = solver;

        ctx.poisson_demag.solver_setup = true;
        ctx.poisson_demag.last_setup_wall_time_ns = elapsed_ns(setup_wall_start);
    }

    auto *solver = static_cast<mfem::HypreSolver *>(ctx.poisson_demag.cached_hypre_solver);

    mfem::HypreParVector &b_par = poisson_hypre_workspace->b_par;
    mfem::HypreParVector &x_par = poisson_hypre_workspace->x_par;
    if (b_par.Size() != rhs_bc.Size() || x_par.Size() != warm_start_solution.Size()) {
        error = "Hypre vector size mismatch during Poisson solve";
        return false;
    }
    const double *rhs_host = audited_host_read(rhs_bc);
    double *b_host = audited_host_write(b_par);
    for (int i = 0; i < rhs_bc.Size(); ++i) {
        b_host[i] = rhs_host[i];
    }
    if (!poisson_hypre_workspace->x_par_contains_solution) {
        const double *sol_host = audited_host_read(warm_start_solution);
        double *x_host = audited_host_write(x_par);
        for (int i = 0; i < warm_start_solution.Size(); ++i) {
            x_host[i] = sol_host[i];
        }
    }

    const auto solver_apply_wall_start = FemSteadyClock::now();
    solver->Mult(b_par, x_par);
    ctx.poisson_demag.last_solver_apply_wall_time_ns = elapsed_ns(solver_apply_wall_start);

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    bool solver_reported_converged = false;
    const char *solver_kind = "cpu_poisson_hypre/unknown";
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(ctx.poisson_demag.cached_hypre_solver);
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(final_residual);
        HYPRE_Int converged = 0;
        HYPRE_PCGGetConverged(static_cast<HYPRE_Solver>(*pcg), &converged);
        solver_reported_converged = converged != 0;
        solver_kind = "cpu_poisson_hypre/cg";
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(ctx.poisson_demag.cached_hypre_solver);
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(final_residual);
        HYPRE_Int converged = 0;
        HYPRE_GMRESGetConverged(static_cast<HYPRE_Solver>(*gmres), &converged);
        solver_reported_converged = converged != 0;
        solver_kind = "cpu_poisson_hypre/gmres";
        break;
    }
    default:
        iterations = 0;
        final_residual = 0.0;
        break;
    }
    ctx.poisson_demag.last_iterations = iterations;
    ctx.poisson_demag.last_residual = static_cast<double>(final_residual);

    DemagLinearSolveResult result;
    result.solver_kind = solver_kind;
    result.solver_reported_converged = solver_reported_converged;
    result.iterations = iterations;
    result.relative_residual = static_cast<double>(final_residual);
    result.has_absolute_residual = ctx.demag.solver.has_absolute_tolerance != 0;
    result.absolute_residual = result.has_absolute_residual
        ? result.relative_residual * b_par.Norml2()
        : 0.0;
    result.relative_tolerance = ctx.demag.solver.relative_tolerance;
    result.has_absolute_tolerance = ctx.demag.solver.has_absolute_tolerance != 0;
    result.absolute_tolerance = ctx.demag.solver.absolute_tolerance;
    result.max_iterations = ctx.demag.solver.max_iterations;
    if (!validate_demag_linear_solve_result(result, error)) {
        x_par = 0.0;
        poisson_hypre_workspace->x_par_contains_solution = false;
        return false;
    }

    zero_poisson_essential_values(ctx, x_par);
    solved_solution = &x_par;
    poisson_hypre_workspace->x_par_contains_solution = true;

    return true;
#else
    (void)ctx;
    (void)rhs;
    (void)warm_start_solution;
    error =
        "Poisson demag requires an MPI/Hypre-enabled MFEM runtime; legacy CPU-native fallback solvers were removed";
    return false;
#endif
}
#endif

} // namespace fullmag::fem
