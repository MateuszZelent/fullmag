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
#include "fem_common.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/hypre_device_policy.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
bool hypre_vector_norm_l2(
    mfem::HypreParVector &vector,
    double &norm,
    const char *operation,
    std::string &error)
{
    HYPRE_Real norm_squared = 0.0;
    HYPRE_ClearAllErrors();
    const HYPRE_Int status = HYPRE_ParVectorInnerProd(
        vector, vector, &norm_squared);
    if (status != 0) {
        error = std::string(operation) + " failed with HYPRE status " +
            std::to_string(status);
        return false;
    }
    if (!std::isfinite(norm_squared) || norm_squared < 0.0) {
        error = std::string(operation) + " returned an invalid squared norm";
        return false;
    }
    norm = std::sqrt(norm_squared);
    return true;
}

bool hypre_vector_axpy(
    double alpha,
    mfem::HypreParVector &x,
    mfem::HypreParVector &y,
    const char *operation,
    std::string &error)
{
    HYPRE_ClearAllErrors();
    const HYPRE_Int status = HYPRE_ParVectorAxpy(alpha, x, y);
    if (status == 0) {
        return true;
    }
    error = std::string(operation) + " failed with HYPRE status " +
        std::to_string(status);
    return false;
}

void configure_demag_amg(mfem::HypreBoomerAMG &amg, const Context &ctx)
{
    const auto &policy = ctx.demag.amg_policy;
    amg.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    amg.SetRelaxType(policy.relax_type);
    amg.SetCoarsening(policy.coarsening);
    amg.SetInterpolation(policy.interpolation);
    amg.SetAggressiveCoarsening(policy.aggressive_coarsening);
    if (policy.strength_threshold_is_set) amg.SetStrengthThresh(policy.strength_threshold);
    if (policy.max_levels_is_set) amg.SetMaxLevels(policy.max_levels);
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
    ensure_mpi_initialized();
    mfem::Hypre::Init();
    mfem::Hypre::InitDevice();
    const HypreDevicePolicySnapshot hypre_policy =
        configure_hypre_cuda_device_policy();
    if (!hypre_cuda_device_policy_is_available(hypre_policy)) {
        error = hypre_policy.failure_reason.empty()
            ? kHypreCudaDevicePolicyUnavailable
            : hypre_policy.failure_reason;
        return false;
    }

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
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    if (ctx.gpu_state.device.demag_poisson.scalar_dof_count !=
        static_cast<uint64_t>(glob_size)) {
        error = "GPU Poisson scalar buffer size does not match the Hypre operator";
        return false;
    }
    workspace.row_starts[0] = 0;
    workspace.row_starts[1] = glob_size;
    workspace.A_par = std::make_unique<mfem::HypreParMatrix>(
        fullmag_serial_comm(),
        glob_size,
        workspace.row_starts,
        A_bc);
    workspace.A_par->HypreRead();

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
    workspace.residual = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(), glob_size, workspace.row_starts);
    if (!configure_demag_poisson_hypre_preconditioner(ctx, workspace, error) ||
        !configure_demag_poisson_hypre_solver(ctx, workspace, error)) {
        return false;
    }
    const auto setup_start = FemSteadyClock::now();
    workspace.solver->Setup(*workspace.b_par, *workspace.x_par);
    ctx.poisson_demag.last_setup_wall_time_ns = elapsed_ns(setup_start);
    workspace.solver_setup_count += 1;
    ctx.poisson_demag.setup_count = workspace.solver_setup_count;
    ctx.poisson_demag.setup_count_current_step += 1;
    workspace.solver_setup_complete = true;
    return true;
#else
    (void)ctx;
    (void)workspace;
    error = "strict FEM GPU demag requires MFEM MPI and hypre device solver support";
    return false;
#endif
}

bool prepare_demag_poisson_hypre_device_solver_apply(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    bool fresh_zero,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (workspace.A_par == nullptr || workspace.solver == nullptr ||
        workspace.preconditioner == nullptr || !workspace.solver_setup_complete) {
        error = "GPU Poisson demag apply requires a completed persistent Hypre setup";
        return false;
    }
    if (fresh_zero) {
        workspace.fresh_zero_guess_count += 1;
    } else {
        workspace.warm_start_count += 1;
    }
    return set_demag_poisson_hypre_solver_iterative_mode(
        ctx, workspace, !fresh_zero, error);
#else
    (void)ctx;
    (void)workspace;
    (void)fresh_zero;
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
        solver->SetTol(ctx.demag.solver.relative_tolerance);
        solver->SetAbsTol(std::max(0.0, ctx.demag.solver.absolute_tolerance));
        solver->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        if (iterative_mode) {
            solver->iterative_mode = true;
        } else {
            solver->SetZeroInitialIterate();
        }
        return true;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *solver = static_cast<mfem::HypreGMRES *>(workspace.solver.get());
        solver->SetTol(ctx.demag.solver.relative_tolerance);
        solver->SetAbsTol(std::max(0.0, ctx.demag.solver.absolute_tolerance));
        solver->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
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
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    bool solver_reported_converged = false;
    read_demag_poisson_hypre_solver_stats(
        ctx, workspace, iterations, residual, solver_reported_converged);

    bool force_independent_validation = false;
    if (!read_force_independent_residual_validation(
            force_independent_validation, error)) {
        return false;
    }
    const auto validation_needs = resolve_hypre_residual_validation_needs(
        solver_reported_converged,
        ctx.demag.solver.has_absolute_tolerance != 0,
        force_independent_validation);
    bool residual_independently_certified = false;
    double absolute_residual = 0.0;
    double rhs_norm = 0.0;
    if (validation_needs.rhs_norm && workspace.b_par != nullptr) {
        if (!hypre_vector_norm_l2(
                *workspace.b_par,
                rhs_norm,
                "strict FEM GPU Poisson demag RHS norm",
                error)) {
            return false;
        }
        GpuPerformanceCounterDelta performance_delta{};
        performance_delta.demag_rhs_norm_evaluations = 1;
        performance_delta.demag_rhs_norm_sum = rhs_norm;
        gpu_performance_note(ctx.gpu_state.performance_counters, performance_delta);
    }
    if (validation_needs.independent_residual &&
        workspace.A_par != nullptr &&
        workspace.x_par != nullptr &&
        workspace.b_par != nullptr &&
        workspace.residual != nullptr) {
        workspace.A_par->Mult(*workspace.x_par, *workspace.residual);
        if (!hypre_vector_axpy(
                -1.0,
                *workspace.b_par,
                *workspace.residual,
                "strict FEM GPU Poisson demag residual AXPY",
                error) ||
            !hypre_vector_norm_l2(
                *workspace.residual,
                absolute_residual,
                "strict FEM GPU Poisson demag residual norm",
                error)) {
            return false;
        }
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
    if (!validate_demag_linear_solve_result(result, error)) {
        return false;
    }
    if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            FEM_GPU_OPERATOR_DEMAG_SOLVE | FEM_GPU_OPERATOR_PRECONDITIONER);
    }
    return true;
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
