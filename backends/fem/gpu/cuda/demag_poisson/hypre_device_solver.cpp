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
#include "fem_memory_trace.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/hypre_device_policy.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem.hpp"
#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/demag_poisson/hypre_residual_certification.hpp"
#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#include <HYPRE_parcsr_ls.h>
#if FULLMAG_HAS_CUDA_RUNTIME
#include <HYPRE_parcsr_mv.h>
#endif
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <utility>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
bool read_hypre_demag_amg_coarse_relax_type(
    HYPRE_Solver amgraw,
    HYPRE_Int &relax_type,
    std::string &error)
{
    relax_type = -1;
    const HYPRE_Int prior_status = HYPRE_GetError();
    if ((prior_status & ~HYPRE_ERROR_CONV) != 0) {
        error = "HYPRE_BoomerAMGGetCycleRelaxType found pre-existing HYPRE status " +
            std::to_string(static_cast<int>(prior_status));
        return false;
    }
    HYPRE_Int observed_relax_type = -1;
    const HYPRE_Int status =
        HYPRE_BoomerAMGGetCycleRelaxType(amgraw, &observed_relax_type, 3);
    const HYPRE_Int current_status = HYPRE_GetError();
    const HYPRE_Int new_status = current_status & ~prior_status;
    const HYPRE_Int unexpected_status = status & ~(prior_status & HYPRE_ERROR_CONV);
    if (unexpected_status != 0 || new_status != 0) {
        error = "HYPRE_BoomerAMGGetCycleRelaxType failed for GPU Poisson demag coarse cycle: status=" +
            std::to_string(static_cast<int>(status)) +
            " current=" + std::to_string(static_cast<int>(current_status)) +
            " new=" + std::to_string(static_cast<int>(new_status));
        return false;
    }
    relax_type = observed_relax_type;
    return true;
}

bool validate_demag_amg_coarse_relax_type(HYPRE_Solver amgraw, std::string &error)
{
    HYPRE_Int relax_type = -1;
    if (!read_hypre_demag_amg_coarse_relax_type(amgraw, relax_type, error)) {
        return false;
    }
    if (relax_type != 18) {
        error =
            "GPU Poisson demag AMG coarse cycle must use relax type 18; "
            "HYPRE reports " +
            std::to_string(static_cast<int>(relax_type));
        return false;
    }
    return true;
}

bool configure_demag_amg(
    mfem::HypreBoomerAMG &amg,
    const Context &ctx,
    std::string &error)
{
    const auto &policy = ctx.demag.amg_policy;
    amg.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    amg.SetRelaxType(policy.relax_type);
    const HYPRE_Solver amgraw = amg;
    const HYPRE_Int cycle_relax_status =
        HYPRE_BoomerAMGSetCycleRelaxType(amgraw, 18, 3);
    if (cycle_relax_status != 0) {
        error =
            "HYPRE_BoomerAMGSetCycleRelaxType failed for GPU Poisson demag "
            "coarse cycle with status " +
            std::to_string(static_cast<int>(cycle_relax_status));
        return false;
    }
    if (!validate_demag_amg_coarse_relax_type(amgraw, error)) {
        return false;
    }
    amg.SetCoarsening(policy.coarsening);
    amg.SetInterpolation(policy.interpolation);
    amg.SetAggressiveCoarsening(policy.aggressive_coarsening);
    if (policy.strength_threshold_is_set) amg.SetStrengthThresh(policy.strength_threshold);
    if (policy.max_levels_is_set) amg.SetMaxLevels(policy.max_levels);
    return true;
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
        if (!configure_demag_amg(*amg, ctx, error)) {
            return false;
        }
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
    const double solver_tol =
        certification_solver_tolerance(ctx.demag.solver.relative_tolerance);
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto pcg = std::make_unique<mfem::HyprePCG>(fullmag_serial_comm());
        pcg->iterative_mode = true;
        pcg->SetTol(solver_tol);
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
        gmres->SetTol(solver_tol);
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

bool read_device_demag_amg_coarse_relax_type(
    const Context &ctx,
    std::int32_t &relax_type,
    std::string &error)
{
    relax_type = -1;
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.gpu_state.device.lifecycle.allocated) {
        return true;
    }
    if (ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM) {
        return gpu_demag_fem_bem_amg_coarse_relax_type(ctx, relax_type, error);
    }
    if (ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON ||
        ctx.demag.solver.preconditioner != FULLMAG_FEM_PRECONDITIONER_AMG ||
        !ctx.poisson_demag.gpu_workspace_ready) {
        return true;
    }
    const GpuDemagPoissonWorkspace *workspace = workspace_ptr(ctx);
    if (workspace != nullptr && workspace->direct_solver != nullptr) {
        return true;  // No AMG under the cuDSS override: report no observation.
    }
    if (workspace == nullptr || !workspace->ready || workspace->preconditioner == nullptr) {
        error = "GPU Poisson demag AMG context is marked initialized but has no "
            "ready Hypre preconditioner";
        return false;
    }
    const auto *amg = dynamic_cast<const mfem::HypreBoomerAMG *>(
        workspace->preconditioner.get());
    if (amg == nullptr) {
        error = "GPU Poisson demag AMG context is marked ready with a non-AMG "
            "Hypre preconditioner";
        return false;
    }
    HYPRE_Int observed_relax_type = -1;
    if (!read_hypre_demag_amg_coarse_relax_type(
            static_cast<HYPRE_Solver>(*amg), observed_relax_type, error)) {
        return false;
    }
    relax_type = static_cast<std::int32_t>(observed_relax_type);
#else
    (void)ctx;
    (void)error;
#endif
    return true;
}

bool initialize_demag_poisson_hypre_device_solver(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
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
    ensure_mpi_initialized();
    fem_memory_trace_phase("hypre:mpi_ready");
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
    fem_memory_trace_phase("hypre:parcsr_ready");

    // Three-state GPU demag strategy resolution (auto / cg_amg / cudss),
    // covering both open and PBC-reduced SPD Poisson operators (docs/physics/0997).
    const auto cudss_setup_start = FemSteadyClock::now();
    workspace.direct_solver.reset();
    workspace.direct_solver_stats = GpuDemagCudssDirectStats{};
    ctx.poisson_demag.gpu_cudss_resolution = GpuDemagCudssResolution{};
    if (!try_initialize_demag_cudss_direct(
            ctx.poisson_demag.gpu_solver_strategy,
            *A_bc,
            workspace.direct_solver,
            workspace.direct_solver_stats,
            ctx.poisson_demag.gpu_cudss_resolution,
            error)) {
        return false;
    }
    if (workspace.direct_solver != nullptr) {
        const auto &stats = workspace.direct_solver_stats;
        workspace.device_bytes += stats.device_bytes;
        ctx.poisson_demag.last_setup_wall_time_ns = elapsed_ns(cudss_setup_start);
        std::fprintf(
            stderr,
            "fullmag: FEM GPU Poisson demag uses the cuDSS direct solve "
            "(strategy=%u, periodic=%d): rows=%lld lower_nnz=%lld "
            "factor_nnz=%lld estimated_device_peak_bytes=%lld device_budget_bytes=%llu "
            "device_bytes=%llu analysis_ms=%.1f factorization_ms=%.1f\n",
            static_cast<unsigned>(ctx.poisson_demag.gpu_cudss_resolution.effective_strategy),
            demag_periodic_poisson_reduction_requested(ctx) ? 1 : 0,
            static_cast<long long>(stats.rows), static_cast<long long>(stats.lower_nnz),
            static_cast<long long>(stats.factor_nnz),
            static_cast<long long>(stats.estimated_device_peak_bytes),
            static_cast<unsigned long long>(stats.budget.budget_bytes),
            static_cast<unsigned long long>(stats.device_bytes), stats.analysis_ms,
            stats.factorization_ms);
        workspace.solver_setup_count += 1;
        ctx.poisson_demag.setup_count = workspace.solver_setup_count;
        ctx.poisson_demag.setup_count_current_step += 1;
        workspace.solver_setup_complete = true;
        return true;
    }
    if (!configure_demag_poisson_hypre_preconditioner(ctx, workspace, error) ||
        !configure_demag_poisson_hypre_solver(ctx, workspace, error)) {
        return false;
    }
    const auto setup_start = FemSteadyClock::now();
    workspace.solver->Setup(*workspace.b_par, *workspace.x_par);
    fem_memory_trace_phase("hypre:krylov_setup_done");
    if (ctx.demag.solver.preconditioner == FULLMAG_FEM_PRECONDITIONER_AMG &&
        !validate_demag_amg_coarse_relax_type(
            static_cast<HYPRE_Solver>(*workspace.preconditioner), error)) {
        return false;
    }
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
    if (workspace.direct_solver != nullptr) {
        // A direct solve has no initial iterate; keep the warm/fresh counters.
        if (workspace.A_par == nullptr || !workspace.solver_setup_complete) {
            error = "GPU Poisson demag apply requires a completed cuDSS factorization";
            return false;
        }
        if (fresh_zero) {
            workspace.fresh_zero_guess_count += 1;
        } else {
            workspace.warm_start_count += 1;
        }
        return true;
    }
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
    if (workspace.direct_solver != nullptr) {
        return true;  // No Krylov iterate to configure under the cuDSS override.
    }
    if (workspace.solver == nullptr) {
        error = "GPU Poisson demag Hypre solver is not initialized";
        return false;
    }
    const double solver_tol =
        certification_solver_tolerance(ctx.demag.solver.relative_tolerance);
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *solver = static_cast<mfem::HyprePCG *>(workspace.solver.get());
        solver->SetTol(solver_tol);
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
        solver->SetTol(solver_tol);
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
    if (workspace.direct_solver != nullptr) {
        // One factor application; the caller certifies the residual independently.
        iterations = 1;
        solver_reported_converged = true;
        return;
    }
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

    // HYPRE CG can report a preconditioned residual. Certify the actual
    // candidate independently, including solver-reported successes.
    constexpr bool force_independent_validation = true;
    const auto validation_needs = resolve_hypre_residual_validation_needs(
        solver_reported_converged,
        ctx.demag.solver.has_absolute_tolerance != 0,
        force_independent_validation);
    bool residual_independently_certified = false;
    double absolute_residual = 0.0;
    double rhs_norm = 0.0;
    if (validation_needs.rhs_norm) {
#if FULLMAG_HAS_CUDA_RUNTIME
        const auto &interop = workspace.stream_interop;
        if (!interop.ready || interop.hypre_stream == nullptr ||
            workspace.b_par == nullptr || workspace.residual == nullptr ||
            workspace.b_par->Size() <= 0 ||
            workspace.b_par->Size() != workspace.residual->Size() ||
            (validation_needs.independent_residual &&
             (workspace.A_par == nullptr || workspace.x_par == nullptr))) {
            error = "GPU Poisson demag residual validation requires initialized device vectors and HYPRE stream";
            return false;
        }
        GpuDemagResidualCertInput cert_input{};
        cert_input.label = "GPU Poisson demag";
        cert_input.A_par = workspace.A_par.get();
        cert_input.b_par = workspace.b_par.get();
        cert_input.x_par = workspace.x_par.get();
        cert_input.residual = workspace.residual.get();
        cert_input.scratch = &workspace.validation_scratch;
        cert_input.compute_independent_residual = validation_needs.independent_residual;
        cert_input.rows = workspace.b_par->Size();
        cert_input.stream = interop.hypre_stream;

        GpuDemagResidualCertOutput cert_output{};
        const bool certified =
            certify_gpu_hypre_demag_residual(cert_input, cert_output, error);
        if (cert_output.control_fence_count > 0) {
            record_device_control_scalar_to_host(
                ctx.transfer_audit.audit, cert_output.control_d2h_bytes);
            GpuPerformanceCounterDelta readback_delta{};
            readback_delta.control_fences = cert_output.control_fence_count;
            readback_delta.control_d2h_bytes = cert_output.control_d2h_bytes;
            gpu_performance_note(ctx.gpu_state.performance_counters, readback_delta);
            if (std::isfinite(cert_output.rhs_norm)) {
                GpuPerformanceCounterDelta performance_delta{};
                performance_delta.demag_rhs_norm_evaluations = 1;
                performance_delta.demag_rhs_norm_sum = cert_output.rhs_norm;
                gpu_performance_note(ctx.gpu_state.performance_counters, performance_delta);
            }
        }
        if (!certified) {
            return false;
        }
        rhs_norm = cert_output.rhs_norm;
        if (!std::isfinite(rhs_norm)) {
            error = "GPU Poisson demag RHS norm is nonfinite";
            return false;
        }
        if (cert_output.computed_independent_residual) {
            absolute_residual = cert_output.absolute_residual;
            if (!std::isfinite(absolute_residual)) {
                error = "GPU Poisson demag residual norm is nonfinite";
                return false;
            }
            residual = rhs_norm > 0.0 ? absolute_residual / rhs_norm : absolute_residual;
            residual_independently_certified = true;
        }
#else
        error = "GPU Poisson demag residual validation requires CUDA stream interop";
        return false;
#endif
    }

    const bool direct = workspace.direct_solver != nullptr;
    DemagLinearSolveResult result;
    result.solver_kind = direct
        ? "gpu_poisson_cudss/direct"
        : ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES
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
        // Record the realization that ran; the planner requires the same bit
        // (gpu_rk_required_operator_mask, docs/physics/0997).
        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            FEM_GPU_OPERATOR_DEMAG_SOLVE |
                (direct ? FEM_GPU_OPERATOR_DIRECT_SOLVE : FEM_GPU_OPERATOR_PRECONDITIONER));
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
