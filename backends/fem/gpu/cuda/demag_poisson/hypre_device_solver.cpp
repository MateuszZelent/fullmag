/*
 * GPU CUDA Poisson demag Hypre device solver source contract.
 *
 * This source owns strict GPU Poisson demag Hypre device-policy setup,
 * BoomerAMG/Jacobi/identity preconditioner selection, CG/GMRES construction,
 * and iteration/residual extraction. It does not own P1 CSR operator assembly,
 * lifecycle publication, RK-stage orchestration, local CUDA kernels, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"

#include "context.hpp"
#include "core/demag_linear_solve_validation.hpp"
#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

#include <climits>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <string>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
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

void configure_hypre_device_vendor_kernels()
{
#if defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP)
    if (HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetSpTransUseVendor(1) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetSpMVUseVendor(1) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetSpGemmUseVendor(1) != 0) {
        HYPRE_ClearAllErrors();
    }
#endif
}

bool configure_demag_poisson_hypre_preconditioner(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
    if (workspace.A_par == nullptr) {
        error = "GPU Poisson demag Hypre preconditioner requires an initialized operator";
        return false;
    }
    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(*workspace.A_par);
        configure_demag_amg(*amg, ctx);
        workspace.preconditioner = std::move(amg);
        return true;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        workspace.preconditioner = std::make_unique<mfem::HypreDiagScale>(*workspace.A_par);
        return true;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        workspace.preconditioner = std::move(identity);
        return true;
    }
    default:
        error = "Unsupported native FEM GPU demag preconditioner enum";
        return false;
    }
}

bool configure_demag_poisson_hypre_solver(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
    if (workspace.A_par == nullptr || workspace.preconditioner == nullptr) {
        error = "GPU Poisson demag Hypre solver requires initialized operator and preconditioner";
        return false;
    }
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto pcg = std::make_unique<mfem::HyprePCG>(fullmag_serial_comm());
        pcg->iterative_mode = true;
        pcg->SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            pcg->SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        pcg->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        pcg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        pcg->SetOperator(*workspace.A_par);
        pcg->SetPreconditioner(*workspace.preconditioner);
        workspace.solver = std::move(pcg);
        return true;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
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
        gmres->SetOperator(*workspace.A_par);
        gmres->SetPreconditioner(*workspace.preconditioner);
        workspace.solver = std::move(gmres);
        return true;
    }
    default:
        error = "Unsupported native FEM GPU demag linear solver enum";
        return false;
    }
}
#endif

} // namespace

bool initialize_demag_poisson_hypre_device_solver(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    mfem::Hypre::Init();
    mfem::Hypre::InitDevice();
    configure_hypre_device_vendor_kernels();

    auto *A_bc = static_cast<mfem::SparseMatrix *>(
        demag_periodic_poisson_reduction_requested(ctx)
            ? ctx.poisson_demag.periodic_matrix
            : ctx.poisson_demag.poisson_bc_op);
    if (A_bc == nullptr) {
        error = demag_periodic_poisson_reduction_requested(ctx)
            ? "GPU periodic Poisson demag requires an initialized periodic reduced operator"
            : "GPU Poisson demag requires an initialized Poisson boundary-conditioned operator";
        return false;
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    workspace.row_starts[0] = 0;
    workspace.row_starts[1] = glob_size;
    workspace.A_par = std::make_unique<mfem::HypreParMatrix>(
        fullmag_serial_comm(),
        glob_size,
        workspace.row_starts,
        A_bc);
    workspace.A_par->HypreRead();

    if (!configure_demag_poisson_hypre_preconditioner(ctx, workspace, error)) {
        return false;
    }

    if (!configure_demag_poisson_hypre_solver(ctx, workspace, error)) {
        return false;
    }

    workspace.b_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        glob_size,
        ctx.gpu_state.device.demag_poisson.poisson_rhs,
        workspace.row_starts,
        true);
    workspace.x_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        glob_size,
        ctx.gpu_state.device.demag_poisson.poisson_solution,
        workspace.row_starts,
        true);
    workspace.residual = std::make_unique<mfem::Vector>(static_cast<int>(glob_size));
    workspace.residual->UseDevice(true);
    return true;
#else
    (void)ctx;
    (void)workspace;
    error = "strict FEM GPU demag requires MFEM MPI and hypre device solver support";
    return false;
#endif
}

bool reset_demag_poisson_hypre_device_solver_for_fresh_rhs(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (workspace.A_par == nullptr) {
        error = "GPU Poisson demag fresh-RHS reset requires an initialized operator";
        return false;
    }
    workspace.solver.reset();
    workspace.preconditioner.reset();
    if (!configure_demag_poisson_hypre_preconditioner(ctx, workspace, error)) {
        return false;
    }
    return configure_demag_poisson_hypre_solver(ctx, workspace, error);
#else
    (void)ctx;
    (void)workspace;
    error = "strict FEM GPU demag requires MFEM MPI and hypre device solver support";
    return false;
#endif
}

bool set_demag_poisson_hypre_solver_iterative_mode(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    bool iterative_mode,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (workspace.solver == nullptr) {
        error = "GPU Poisson demag Hypre solver is not initialized";
        return false;
    }
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *solver = static_cast<mfem::HyprePCG *>(workspace.solver.get());
        if (iterative_mode) {
            solver->iterative_mode = true;
        } else {
            solver->SetZeroInitialIterate();
        }
        return true;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *solver = static_cast<mfem::HypreGMRES *>(workspace.solver.get());
        if (iterative_mode) {
            solver->iterative_mode = true;
        } else {
            solver->SetZeroInitialIterate();
        }
        return true;
    }
    default:
        error = "Unsupported native FEM GPU demag linear solver enum";
        return false;
    }
#else
    (void)ctx;
    (void)workspace;
    (void)iterative_mode;
    error = "strict FEM GPU demag requires MFEM MPI and hypre device solver support";
    return false;
#endif
}

void read_demag_poisson_hypre_solver_stats(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual,
    bool &solver_reported_converged)
{
    iterations = 0;
    residual = 0.0;
    solver_reported_converged = false;
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    mfem::real_t raw_residual = 0.0;
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(workspace.solver.get());
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(raw_residual);
        HYPRE_Int converged = 0;
        HYPRE_PCGGetConverged(static_cast<HYPRE_Solver>(*pcg), &converged);
        solver_reported_converged = converged != 0;
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(workspace.solver.get());
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(raw_residual);
        HYPRE_Int converged = 0;
        HYPRE_GMRESGetConverged(static_cast<HYPRE_Solver>(*gmres), &converged);
        solver_reported_converged = converged != 0;
        break;
    }
    default:
        break;
    }
    residual = static_cast<double>(raw_residual);
#else
    (void)ctx;
    (void)workspace;
#endif
}

bool validate_demag_poisson_hypre_device_solve(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    bool solver_reported_converged = false;
    read_demag_poisson_hypre_solver_stats(
        ctx, workspace, iterations, residual, solver_reported_converged);

    bool residual_independently_certified = false;
    double absolute_residual = 0.0;
    const double rhs_norm = workspace.b_par == nullptr ? 0.0 : workspace.b_par->Norml2();
    if (!solver_reported_converged &&
        workspace.A_par != nullptr &&
        workspace.x_par != nullptr &&
        workspace.b_par != nullptr &&
        workspace.residual != nullptr) {
        workspace.A_par->Mult(*workspace.x_par, *workspace.residual);
        workspace.residual->Add(-1.0, *workspace.b_par);
        absolute_residual = workspace.residual->Norml2();
        residual = rhs_norm > 0.0 ? absolute_residual / rhs_norm : absolute_residual;
        residual_independently_certified = std::isfinite(absolute_residual);
    }

    DemagLinearSolveResult result;
    result.solver_kind = ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES
        ? "gpu_poisson_hypre/gmres"
        : "gpu_poisson_hypre/cg";
    result.solver_reported_converged = solver_reported_converged;
    result.residual_independently_certified = residual_independently_certified;
    result.iterations = iterations;
    result.relative_residual = residual;
    result.has_absolute_residual =
        ctx.demag.solver.has_absolute_tolerance != 0 && workspace.b_par != nullptr;
    result.absolute_residual = result.has_absolute_residual
        ? (residual_independently_certified ? absolute_residual : residual * rhs_norm)
        : 0.0;
    result.relative_tolerance = ctx.demag.solver.relative_tolerance;
    result.has_absolute_tolerance = ctx.demag.solver.has_absolute_tolerance != 0;
    result.absolute_tolerance = ctx.demag.solver.absolute_tolerance;
    result.max_iterations = ctx.demag.solver.max_iterations;
    return validate_demag_linear_solve_result(result, error);
#else
    (void)ctx;
    (void)workspace;
    iterations = 0;
    residual = 0.0;
    error = "strict FEM GPU demag convergence validation requires MFEM MPI and hypre";
    return false;
#endif
}

} // namespace fullmag::fem
