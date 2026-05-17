#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"

#include "context.hpp"
#include "transfer_audit.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
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

uint64_t vector_bytes(const mfem::Vector &vector) {
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

const double *audited_host_read(const mfem::Vector &vector) {
    record_mfem_host_read(vector_bytes(vector));
    return vector.HostRead();
}

double *audited_host_write(mfem::Vector &vector) {
    record_mfem_host_write(vector_bytes(vector));
    return vector.HostWrite();
}

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

void zero_poisson_essential_values(const Context &ctx, mfem::Vector &vec) {
    for (const int tdof : ctx.poisson_ess_tdof_list) {
        vec(tdof) = 0.0;
    }
}

#ifdef MFEM_USE_MPI
void ensure_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (!initialized) {
        int provided = 0;
        MPI_Init_thread(nullptr, nullptr, MPI_THREAD_FUNNELED, &provided);
    }
}
#endif

} // namespace

bool demag_poisson_hypre_has_warm_start(const Context &ctx)
{
#ifdef MFEM_USE_MPI
    auto *workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.mfem_poisson_hypre_workspace);
    return workspace != nullptr && workspace->x_par_contains_solution;
#else
    (void)ctx;
    return false;
#endif
}

void destroy_demag_poisson_hypre_workspace(Context &ctx)
{
#ifdef MFEM_USE_MPI
    delete static_cast<PoissonHypreWorkspace *>(ctx.mfem_poisson_hypre_workspace);
    ctx.mfem_poisson_hypre_workspace = nullptr;
    switch (ctx.demag_solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG:
        delete static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_solver);
        break;
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES:
        delete static_cast<mfem::HypreGMRES *>(ctx.mfem_cached_hypre_solver);
        break;
    default:
        break;
    }
    ctx.mfem_cached_hypre_solver = nullptr;
    switch (ctx.demag_solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG:
        delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        delete static_cast<mfem::HypreDiagScale *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        delete static_cast<mfem::HypreIdentity *>(ctx.mfem_cached_hypre_preconditioner);
        break;
    default:
        break;
    }
    ctx.mfem_cached_hypre_preconditioner = nullptr;
    delete static_cast<mfem::HypreParMatrix *>(ctx.mfem_cached_hypre_par);
    ctx.mfem_cached_hypre_par = nullptr;
#else
    ctx.mfem_poisson_hypre_workspace = nullptr;
    ctx.mfem_cached_hypre_solver = nullptr;
    ctx.mfem_cached_hypre_preconditioner = nullptr;
    ctx.mfem_cached_hypre_par = nullptr;
#endif
    ctx.poisson_solver_setup = false;
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_apply_wall_time_ns = 0;
    ctx.poisson_last_solver_setup_reused = false;
}

bool solve_demag_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
#ifdef MFEM_USE_MPI
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_apply_wall_time_ns = 0;
    ctx.poisson_last_solver_setup_reused = ctx.poisson_solver_setup;
    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_bc == nullptr) {
        error = "Poisson BC-eliminated operator is null during Hypre solve";
        return false;
    }

    ensure_mpi_initialized();

    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};

    auto *poisson_hypre_workspace =
        static_cast<PoissonHypreWorkspace *>(ctx.mfem_poisson_hypre_workspace);
    if (poisson_hypre_workspace == nullptr) {
        poisson_hypre_workspace =
            new PoissonHypreWorkspace(MPI_COMM_WORLD, glob_size, row_starts);
        ctx.mfem_poisson_hypre_workspace = poisson_hypre_workspace;
    }

    mfem::Vector &rhs_bc = poisson_hypre_workspace->rhs_bc;
    rhs_bc.SetSize(rhs.Size());
    rhs_bc = rhs;
    zero_poisson_essential_values(ctx, rhs_bc);

    if (!ctx.poisson_solver_setup) {
        const auto setup_wall_start = SteadyClock::now();
        auto *A_par = new mfem::HypreParMatrix(MPI_COMM_WORLD, glob_size, row_starts, A_bc);
        ctx.mfem_cached_hypre_par = A_par;

        mfem::HypreSolver *preconditioner = nullptr;
        switch (ctx.demag_solver.preconditioner) {
        case FULLMAG_FEM_PRECONDITIONER_AMG: {
            auto *amg = new mfem::HypreBoomerAMG(*A_par);
            amg->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
            amg->SetRelaxType(18);
            amg->SetCoarsening(8);
            amg->SetInterpolation(6);
            amg->SetAggressiveCoarsening(1);
            preconditioner = amg;
            break;
        }
        case FULLMAG_FEM_PRECONDITIONER_JACOBI:
            preconditioner = new mfem::HypreDiagScale(*A_par);
            break;
        case FULLMAG_FEM_PRECONDITIONER_NONE: {
            auto *identity = new mfem::HypreIdentity();
            identity->SetOperator(*A_par);
            preconditioner = identity;
            break;
        }
        default:
            error = "Unsupported native FEM demag preconditioner enum";
            delete A_par;
            ctx.mfem_cached_hypre_par = nullptr;
            return false;
        }
        ctx.mfem_cached_hypre_preconditioner = preconditioner;

        mfem::HypreSolver *solver = nullptr;
        switch (ctx.demag_solver.solver) {
        case FULLMAG_FEM_LINEAR_SOLVER_CG: {
            auto *pcg = new mfem::HyprePCG(MPI_COMM_WORLD);
            pcg->iterative_mode = true;
            pcg->SetTol(ctx.demag_solver.relative_tolerance);
            if (ctx.demag_solver.has_absolute_tolerance &&
                ctx.demag_solver.absolute_tolerance > 0.0) {
                pcg->SetAbsTol(ctx.demag_solver.absolute_tolerance);
            }
            pcg->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
            pcg->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
            pcg->SetOperator(*A_par);
            pcg->SetPreconditioner(*preconditioner);
            solver = pcg;
            break;
        }
        case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
            auto *gmres = new mfem::HypreGMRES(MPI_COMM_WORLD);
            gmres->iterative_mode = true;
            gmres->SetTol(ctx.demag_solver.relative_tolerance);
            if (ctx.demag_solver.has_absolute_tolerance &&
                ctx.demag_solver.absolute_tolerance > 0.0) {
                gmres->SetAbsTol(ctx.demag_solver.absolute_tolerance);
            }
            gmres->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
            gmres->SetKDim(50);
            gmres->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
            gmres->SetOperator(*A_par);
            gmres->SetPreconditioner(*preconditioner);
            solver = gmres;
            break;
        }
        default:
            error = "Unsupported native FEM demag linear solver enum";
            switch (ctx.demag_solver.preconditioner) {
            case FULLMAG_FEM_PRECONDITIONER_AMG:
                delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_JACOBI:
                delete static_cast<mfem::HypreDiagScale *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            case FULLMAG_FEM_PRECONDITIONER_NONE:
                delete static_cast<mfem::HypreIdentity *>(ctx.mfem_cached_hypre_preconditioner);
                break;
            default:
                break;
            }
            ctx.mfem_cached_hypre_preconditioner = nullptr;
            delete A_par;
            ctx.mfem_cached_hypre_par = nullptr;
            return false;
        }
        ctx.mfem_cached_hypre_solver = solver;

        ctx.poisson_solver_setup = true;
        ctx.poisson_last_setup_wall_time_ns = elapsed_ns(setup_wall_start);
    }

    auto *solver = static_cast<mfem::HypreSolver *>(ctx.mfem_cached_hypre_solver);

    mfem::HypreParVector &b_par = poisson_hypre_workspace->b_par;
    mfem::HypreParVector &x_par = poisson_hypre_workspace->x_par;
    if (b_par.Size() != rhs_bc.Size() || x_par.Size() != solution.Size()) {
        error = "Hypre vector size mismatch during Poisson solve";
        return false;
    }
    const double *rhs_host = audited_host_read(rhs_bc);
    double *b_host = audited_host_write(b_par);
    for (int i = 0; i < rhs_bc.Size(); ++i) {
        b_host[i] = rhs_host[i];
    }
    if (!poisson_hypre_workspace->x_par_contains_solution) {
        const double *sol_host = audited_host_read(solution);
        double *x_host = audited_host_write(x_par);
        for (int i = 0; i < solution.Size(); ++i) {
            x_host[i] = sol_host[i];
        }
    }

    const auto solver_apply_wall_start = SteadyClock::now();
    solver->Mult(b_par, x_par);
    ctx.poisson_last_solver_apply_wall_time_ns = elapsed_ns(solver_apply_wall_start);

    const double *x_solved = audited_host_read(x_par);
    double *solution_host = audited_host_write(solution);
    for (int i = 0; i < solution.Size(); ++i) {
        solution_host[i] = x_solved[i];
    }
    poisson_hypre_workspace->x_par_contains_solution = true;

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    switch (ctx.demag_solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_solver);
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(final_residual);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(ctx.mfem_cached_hypre_solver);
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(final_residual);
        break;
    }
    default:
        iterations = 0;
        final_residual = 0.0;
        break;
    }
    ctx.poisson_last_iterations = iterations;
    ctx.poisson_last_residual = static_cast<double>(final_residual);

    zero_poisson_essential_values(ctx, solution);
    return true;
#else
    (void)ctx;
    (void)rhs;
    (void)solution;
    error =
        "Poisson demag requires an MPI/Hypre-enabled MFEM runtime; legacy CPU-native fallback solvers were removed";
    return false;
#endif
}
#endif

} // namespace fullmag::fem
