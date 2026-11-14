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
#include "gpu/cuda/transfer/transfer_audit.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"
#include "gpu/cuda/demag_poisson/pcg_device_scalar_kernels.hpp"

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
#include <memory>
#include <limits>
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

double certification_solver_tolerance(double requested)
{
    return requested > 0.0 ? requested * 0.1 : requested;
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

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
struct GpuDemagDevicePcgWorkspace {
    std::unique_ptr<mfem::HypreParVector> p, q, z, gated;
    DemagPcgState *state = nullptr, *host_state = nullptr;
    double *partials = nullptr;
    void *temporary = nullptr;
    size_t temporary_bytes = 0;
    uint64_t allocated_bytes = 0, enqueued_iterations = 0, batch_readbacks = 0;
    bool fresh_zero = true, report_valid = false;
    cudaStream_t stream = nullptr;
    ~GpuDemagDevicePcgWorkspace() {
        if (stream) (void)cudaStreamSynchronize(stream);
        if (temporary) cudaFree(temporary);
        if (partials) cudaFree(partials);
        if (state) cudaFree(state);
        if (host_state) cudaFreeHost(host_state);
    }
};

namespace {
bool prepare_device_pcg_workspace(GpuDemagPoissonWorkspace &workspace, std::string &error) {
    auto pcg = std::make_shared<GpuDemagDevicePcgWorkspace>();
    const int rows = workspace.b_par->Size();
    if (rows <= 0) { error = "GPU Poisson device PCG requires positive local rows"; return false; }
    auto vector = [&]() {
        auto result = std::make_unique<mfem::HypreParVector>(
            fullmag_serial_comm(), static_cast<HYPRE_BigInt>(rows), workspace.row_starts);
        result->HypreWrite();
        (void)result->GetMemory().Write(mfem::GetHypreMemoryClass(), rows);
        return result;
    };
    pcg->p = vector(); pcg->q = vector(); pcg->z = vector(); pcg->gated = vector();
    auto allocate = [&](cudaError_t status) {
        if (status == cudaSuccess) return true;
        error = std::string("GPU Poisson PCG allocation failed: ") + cudaGetErrorString(status);
        return false;
    };
    if (!allocate(cudaMalloc(reinterpret_cast<void**>(&pcg->state), sizeof(DemagPcgState))) ||
        !allocate(cudaHostAlloc(reinterpret_cast<void**>(&pcg->host_state), sizeof(DemagPcgState), cudaHostAllocDefault)) ||
        !allocate(cudaMalloc(reinterpret_cast<void**>(&pcg->partials), static_cast<size_t>((rows+255)/256)*sizeof(double)))) return false;
    if (!allocate(demag_pcg_dot(nullptr,nullptr,rows,pcg->partials,nullptr,pcg->temporary_bytes,
                                &pcg->state->rho,nullptr,nullptr)) ||
        !allocate(cudaMalloc(&pcg->temporary,pcg->temporary_bytes))) return false;
    pcg->allocated_bytes = 4ull * static_cast<uint64_t>(rows)*sizeof(double) +
        static_cast<uint64_t>((rows+255)/256)*sizeof(double) + sizeof(DemagPcgState) + pcg->temporary_bytes;
    workspace.device_bytes += pcg->allocated_bytes;
    workspace.device_pcg = std::move(pcg);
    return true;
}
}
#endif

void destroy_demag_poisson_device_pcg(GpuDemagPoissonWorkspace &workspace) {
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    workspace.device_pcg.reset();
#else
    (void)workspace;
#endif
}

bool apply_demag_poisson_device_pcg(Context &ctx, GpuDemagPoissonWorkspace &workspace, std::string &error) {
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    const bool hot_loop_at_start=ctx.transfer_audit.audit.hot_loop_depth>0;
    ctx.gpu_pcg_control.record_solve_attempt(hot_loop_at_start);
    workspace.last_enqueued_iterations = 0;
    workspace.last_amg_apply_calls = 0;
    auto &pcg = *workspace.device_pcg;
    pcg.stream = workspace.stream_interop.hypre_stream;
    pcg.report_valid = false; pcg.enqueued_iterations = 0; pcg.batch_readbacks = 0;
    const uint32_t status_batch_stride = ctx.gpu_pcg_control.resolved_status_batch_stride();
    if (!gpu_pcg_control_status_batch_stride_valid(status_batch_stride)) {
        error="GPU Poisson device PCG has an invalid status batch stride";
        return false;
    }
    if (!workspace.stream_interop.ready || !pcg.stream) { error="GPU Poisson PCG requires HYPRE stream interop"; return false; }
    const int n = workspace.b_par->Size();
    const double requested_rt=ctx.demag.solver.relative_tolerance;
    const double effective_at=ctx.demag.solver.has_absolute_tolerance
        ? ctx.demag.solver.absolute_tolerance : 0.0;
    // Validate before any enqueue/readback: a zero-sized batch must never
    // expose uninitialized pinned host_state. Match the final certificate's
    // positive iteration/relative-tolerance and finite residual domains.
    if (n <= 0 || ctx.demag.solver.max_iterations == 0 ||
        !std::isfinite(requested_rt) || requested_rt <= 0.0 ||
        !std::isfinite(effective_at) || effective_at < 0.0) {
        error="GPU Poisson device PCG requires positive rows/iteration limit, finite positive rtol and finite nonnegative atol";
        return false;
    }
    const auto memory_class = mfem::GetHypreMemoryClass();
    workspace.b_par->HypreRead(); workspace.x_par->HypreReadWrite(); workspace.residual->HypreWrite();
    const double *b = workspace.b_par->GetMemory().Read(memory_class,n);
    double *x = workspace.x_par->GetMemory().ReadWrite(memory_class,n);
    double *r = workspace.residual->GetMemory().Write(memory_class,n);
    pcg.p->HypreWrite(); pcg.q->HypreWrite(); pcg.z->HypreWrite(); pcg.gated->HypreWrite();
    double *p = pcg.p->GetMemory().Write(memory_class,n), *q = pcg.q->GetMemory().Write(memory_class,n);
    double *z = pcg.z->GetMemory().Write(memory_class,n), *w = pcg.gated->GetMemory().Write(memory_class,n);
    const auto fail = [&](std::string message) {
        // A rejected partial potential must never seed a later warm solve.
        const auto drained = cudaStreamSynchronize(pcg.stream);
        const auto cleared = cudaMemsetAsync(x,0,static_cast<size_t>(n)*sizeof(double),pcg.stream);
        workspace.x_par->HypreWrite();
        const auto clear_drained = cudaStreamSynchronize(pcg.stream);
        pcg.report_valid=false;
        error=std::move(message);
        if (drained != cudaSuccess) error += std::string("; drain failed: ")+cudaGetErrorString(drained);
        if (cleared != cudaSuccess || clear_drained != cudaSuccess)
            error += "; rejected candidate could not be cleared on the failed CUDA stream";
        return false;
    };
    const auto cuda_check = [&](cudaError_t status) {
        return status == cudaSuccess || fail(std::string("GPU Poisson device PCG failed: ")+cudaGetErrorString(status));
    };
    const auto hypre_check = [&](const char *name,auto &&operation) {
        const HYPRE_Int prior=HYPRE_GetError();
        if (prior & ~HYPRE_ERROR_CONV) return fail("GPU Poisson PCG found prior HYPRE error");
        const HYPRE_Int status=operation();
        const HYPRE_Int after=HYPRE_GetError();
        if ((status & ~(prior & HYPRE_ERROR_CONV)) || (after & ~prior))
            return fail(std::string("GPU Poisson PCG ")+name+" failed: status="+std::to_string(status)+" current="+std::to_string(after));
        return true;
    };
    auto *amg=dynamic_cast<mfem::HypreBoomerAMG*>(workspace.preconditioner.get());
    if (!amg) return fail("GPU Poisson device PCG requires retained AMG");
    const HYPRE_Solver amg_handle=*amg;
    const auto apply_c = [&](const double *input) {
        // The fixed linear preconditioner always starts from zero. Its norms
        // are disabled; only the outer GPU recurrence controls convergence.
        pcg.gated->HypreWrite(); pcg.z->HypreWrite();
        if (!cuda_check(demag_pcg_gate(input,w,n,pcg.state,pcg.stream)) ||
            !cuda_check(cudaMemsetAsync(z,0,static_cast<size_t>(n)*sizeof(double),pcg.stream))) return false;
        return hypre_check("HYPRE_BoomerAMGSolve",[&]() {
            ctx.gpu_pcg_control.record_amg_apply(hot_loop_at_start);
            ++workspace.last_amg_apply_calls;
            return HYPRE_BoomerAMGSolve(amg_handle,*workspace.A_par,*pcg.gated,*pcg.z);
        });
    };
    const auto dot = [&](const double *a,const double *v,double *out) {
        return cuda_check(demag_pcg_dot(a,v,n,pcg.partials,pcg.temporary,pcg.temporary_bytes,out,pcg.state,pcg.stream));
    };
    record_device_pcg_solve_started(ctx.transfer_audit.audit,sizeof(DemagPcgState));
    GpuPerformanceCounterDelta started{};
    started.device_pcg_solves=1;
    gpu_performance_note(ctx.gpu_state.performance_counters,started);
    uint32_t reported_iterations=0;
    if (!cuda_check(demag_pcg_initialize(pcg.state,b,x,p,q,n,pcg.fresh_zero,
        certification_solver_tolerance(requested_rt),
        effective_at,
        ctx.demag.solver.max_iterations,pcg.stream)) ||
        !apply_c(b) || !dot(b,z,&pcg.state->denominator) ||
        !cuda_check(demag_pcg_finish_denominator(pcg.state,pcg.stream))) return false;
    if (pcg.fresh_zero) {
        // For a zero initial guess, r=b and z=C(b) is already available. Reuse
        // b^T C(b) as rho instead of another SpMV, AMG application, and dot.
        if (!cuda_check(demag_pcg_initial_residual(b,q,x,r,n,pcg.state,pcg.stream)) ||
            !cuda_check(cudaMemcpyAsync(&pcg.state->rho,&pcg.state->denominator,
                sizeof(double),cudaMemcpyDeviceToDevice,pcg.stream))) return false;
        GpuPerformanceCounterDelta device_scalar_copy{};
        device_scalar_copy.device_to_device_bytes=sizeof(double);
        gpu_performance_note(ctx.gpu_state.performance_counters,device_scalar_copy);
        if (!cuda_check(demag_pcg_finish_rho(pcg.state,true,pcg.stream)) ||
            !cuda_check(demag_pcg_direction(z,p,n,pcg.state,true,pcg.stream))) return false;
    } else {
        if (!hypre_check("HYPRE_ParCSRMatrixMatvec",[&]() { return HYPRE_ParCSRMatrixMatvec(1.0,*workspace.A_par,*workspace.x_par,0.0,*pcg.q); }) ||
            !cuda_check(demag_pcg_initial_residual(b,q,x,r,n,pcg.state,pcg.stream)) ||
            !apply_c(r) || !dot(r,z,&pcg.state->rho) ||
            !cuda_check(demag_pcg_finish_rho(pcg.state,true,pcg.stream)) ||
            !cuda_check(demag_pcg_direction(z,p,n,pcg.state,true,pcg.stream))) return false;
    }
    for (uint32_t queued=0; queued<ctx.demag.solver.max_iterations;) {
        // Reserve up to two pre-loop AMG calls for an already-terminal state;
        // the first batch of five keeps post-latch calls at seven without a
        // separate terminal-status D2H readback.
        const uint32_t batch=demag_pcg_next_batch_iterations(
            queued,ctx.demag.solver.max_iterations,status_batch_stride);
        if (batch==0u) return fail("GPU Poisson device PCG refused an empty or invalid status batch");
        for (uint32_t index=0; index<batch; ++index) {
            pcg.p->HypreRead(); pcg.q->HypreWrite();
            if (!hypre_check("HYPRE_ParCSRMatrixMatvec",[&]() {
                    ctx.gpu_pcg_control.record_enqueued_iteration(hot_loop_at_start);
                    ++workspace.last_enqueued_iterations;
                    return HYPRE_ParCSRMatrixMatvec(1.0,*workspace.A_par,*pcg.p,0.0,*pcg.q);
                }) ||
                !dot(p,q,&pcg.state->curvature) || !cuda_check(demag_pcg_alpha(pcg.state,pcg.stream)) ||
                !cuda_check(demag_pcg_update(x,r,p,q,n,pcg.state,pcg.stream)) ||
                !apply_c(r) || !dot(r,z,&pcg.state->rho) ||
                !cuda_check(demag_pcg_finish_rho(pcg.state,false,pcg.stream)) ||
                !cuda_check(demag_pcg_direction(z,p,n,pcg.state,false,pcg.stream))) return false;
        }
        queued+=batch; pcg.enqueued_iterations=queued;
        if ((ctx.transfer_audit.audit.hot_loop_depth>0)!=hot_loop_at_start)
            return fail("GPU Poisson PCG audit scope changed during one solve");
        if (!cuda_check(cudaMemcpyAsync(pcg.host_state,pcg.state,sizeof(DemagPcgState),cudaMemcpyDeviceToHost,pcg.stream)) ||
            !cuda_check(cudaStreamSynchronize(pcg.stream))) return false;
        ++pcg.batch_readbacks;
        record_device_pcg_status_to_host(ctx.transfer_audit.audit,sizeof(DemagPcgState),
            pcg.host_state->iterations-reported_iterations);
        GpuPerformanceCounterDelta counters{};
        counters.control_fences=1;
        counters.control_d2h_bytes=sizeof(DemagPcgState);
        counters.device_pcg_status_readbacks=1;
        counters.device_pcg_control_d2h_bytes=sizeof(DemagPcgState);
        counters.device_pcg_active_iterations=pcg.host_state->iterations-reported_iterations;
        reported_iterations=pcg.host_state->iterations;
        gpu_performance_note(ctx.gpu_state.performance_counters,counters);
        if (pcg.host_state->status!=DemagPcgStatus::Running) break;
    }
    pcg.report_valid=true;
    if (pcg.host_state->status==DemagPcgStatus::Nonfinite || pcg.host_state->status==DemagPcgStatus::Breakdown)
        return fail("GPU Poisson device PCG numerical breakdown; no fallback");
    return true;
#else
    workspace.last_enqueued_iterations = 0;
    workspace.last_amg_apply_calls = 0;
    (void)ctx; (void)workspace; error="GPU Poisson device PCG requires CUDA/MFEM/HYPRE"; return false;
#endif
}

bool apply_demag_poisson_hypre_device_solver(Context &ctx,GpuDemagPoissonWorkspace &workspace,std::string &error) {
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (workspace.device_pcg) return apply_demag_poisson_device_pcg(ctx,workspace,error);
    workspace.solver->Mult(*workspace.b_par,*workspace.x_par);
    return true;
#else
    (void)ctx; (void)workspace; error="GPU Poisson solver requires MFEM/HYPRE"; return false;
#endif
}

fullmag_fem_poisson_device_pcg_counters_v1 demag_poisson_device_pcg_counters(const Context &ctx,uint32_t scope) {
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto counters=scope==FULLMAG_FEM_POISSON_PCG_SCOPE_HOT_LOOP
        ? ctx.transfer_audit.audit.device_pcg_hot_loop
        : gpu_performance_device_pcg_snapshot(ctx.gpu_state.performance_counters,sizeof(DemagPcgState));
    if (scope==FULLMAG_FEM_POISSON_PCG_SCOPE_HOT_LOOP) counters.status_record_bytes=sizeof(DemagPcgState);
    if (counters.solves || demag_poisson_resolved_linear_engine(ctx)==3) return counters;
#else
    (void)ctx; (void)scope;
#endif
    return {};
}

uint32_t demag_poisson_resolved_linear_engine(const Context &ctx) {
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    const auto *workspace=workspace_ptr(ctx);
    if (!workspace || !workspace->ready || !workspace->solver_setup_complete) return 0;
    if (workspace->device_pcg) return 3;
    if (dynamic_cast<const mfem::HyprePCG*>(workspace->solver.get())) return 1;
    if (dynamic_cast<const mfem::HypreGMRES*>(workspace->solver.get())) return 2;
#else
    (void)ctx;
#endif
    return 0;
}

bool demag_poisson_device_scalar_pcg_amg_ready(const Context &ctx) {
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.gpu_state.device.lifecycle.allocated ||
        ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON ||
        ctx.demag.solver.solver != FULLMAG_FEM_LINEAR_SOLVER_CG ||
        ctx.demag.solver.preconditioner != FULLMAG_FEM_PRECONDITIONER_AMG ||
        !ctx.poisson_demag.gpu_workspace_ready) return false;
    const auto *workspace=workspace_ptr(ctx);
    return workspace != nullptr && workspace->ready && workspace->solver_setup_complete &&
        workspace->A_par != nullptr && workspace->preconditioner != nullptr &&
        workspace->solver != nullptr &&
        workspace->device_pcg != nullptr &&
        demag_poisson_resolved_linear_engine(ctx)==
            FULLMAG_FEM_POISSON_ENGINE_DEVICE_SCALAR_PCG_AMG &&
        dynamic_cast<const mfem::HypreBoomerAMG*>(workspace->preconditioner.get()) != nullptr;
#else
    (void)ctx;
    return false;
#endif
}

bool read_device_demag_amg_coarse_relax_type(
    const Context &ctx,
    std::int32_t &relax_type,
    std::string &error)
{
    relax_type = -1;
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.gpu_state.device.lifecycle.allocated ||
        ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON ||
        ctx.demag.solver.preconditioner != FULLMAG_FEM_PRECONDITIONER_AMG ||
        !ctx.poisson_demag.gpu_workspace_ready) {
        return true;
    }
    const GpuDemagPoissonWorkspace *workspace = workspace_ptr(ctx);
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
    if (ctx.demag.solver.preconditioner == FULLMAG_FEM_PRECONDITIONER_AMG &&
        !validate_demag_amg_coarse_relax_type(
            static_cast<HYPRE_Solver>(*workspace.preconditioner), error)) {
        return false;
    }
    ctx.poisson_demag.last_setup_wall_time_ns = elapsed_ns(setup_start);
    workspace.solver_setup_count += 1;
    ctx.poisson_demag.setup_count = workspace.solver_setup_count;
    ctx.poisson_demag.setup_count_current_step += 1;
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_CG &&
        ctx.demag.solver.preconditioner == FULLMAG_FEM_PRECONDITIONER_AMG &&
        ctx.demag.amg_policy.relax_type == 18 &&
        ctx.demag.solver.print_level == 0) {
        int communicator_relation = MPI_UNEQUAL;
        if (MPI_Comm_compare(fullmag_serial_comm(),MPI_COMM_SELF,&communicator_relation) != MPI_SUCCESS ||
            communicator_relation != MPI_IDENT ||
            !validate_demag_amg_coarse_relax_type(
                static_cast<HYPRE_Solver>(*workspace.preconditioner),error)) {
            if (error.empty()) error="GPU Poisson device PCG requires MPI_COMM_SELF and AMG relax/coarse type 18";
            return false;
        }
        // Preconditioner setup has already completed through the retained PCG
        // setup callback. Disable apply-time AMG norms without rebuilding it.
        auto *amg = static_cast<mfem::HypreBoomerAMG*>(workspace.preconditioner.get());
        const HYPRE_Solver handle = *amg;
        if (HYPRE_BoomerAMGSetPrintLevel(handle,0) || HYPRE_BoomerAMGSetLogging(handle,0) ||
            HYPRE_BoomerAMGSetTol(handle,0.0) || HYPRE_BoomerAMGSetMaxIter(handle,1)) {
            error="GPU Poisson device PCG fixed AMG configuration failed"; return false;
        }
        if (!prepare_device_pcg_workspace(workspace,error)) return false;
    }
#endif
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
#if FULLMAG_HAS_CUDA_RUNTIME
    if (workspace.device_pcg) workspace.device_pcg->fresh_zero = fresh_zero;
#endif
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
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (workspace.device_pcg) {
        const auto &pcg=*workspace.device_pcg;
        if (!pcg.report_valid) { residual=std::numeric_limits<double>::infinity(); return; }
        iterations=static_cast<int>(pcg.host_state->iterations);
        residual=pcg.host_state->relative_residual;
        solver_reported_converged=pcg.host_state->status==DemagPcgStatus::Converged;
        return;
    }
#endif
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
        const cudaStream_t stream = interop.hypre_stream;
        const auto reject_queued_work = [&](std::string message) {
            // The stage may clear the candidate on the Fullmag stream after
            // failure. A rejected matvec can still have queued HYPRE work.
            // This existing rejection drain is separate from certificate
            // readback telemetry; the paired success path has one 16-byte read.
            const auto status = cudaStreamSynchronize(stream);
            error = std::move(message);
            if (status != cudaSuccess) {
                error += std::string("; synchronize HYPRE validation stream failed: ") +
                         cudaGetErrorString(status);
            }
            return false;
        };

        const int rows = workspace.b_par->Size();
        const auto memory_class = mfem::GetHypreMemoryClass();
        workspace.b_par->HypreRead();
        const double *rhs_data = workspace.b_par->GetMemory().Read(memory_class, rows);
        // The owned residual vector is private to validation. For rows >= 2
        // its first two entries become outputs only after all A*x-b/norm reads.
        workspace.residual->HypreWrite();
        double *scratch = workspace.residual->GetMemory().Write(memory_class, rows);
        const auto note_validation_readback = [&](size_t bytes) {
            record_device_control_scalar_to_host(ctx.transfer_audit.audit, bytes);
            GpuPerformanceCounterDelta readback_delta{};
            readback_delta.control_fences = 1;
            readback_delta.control_d2h_bytes = bytes;
            readback_delta.mandatory_controls.poisson_certificate_readbacks=1;
            readback_delta.mandatory_controls.poisson_certificate_bytes=bytes;
            note_hot_loop_mandatory_controls(ctx.transfer_audit.audit,readback_delta.mandatory_controls);
            gpu_performance_note(ctx.gpu_state.performance_counters, readback_delta);
        };
        const auto finite_norm = [&](double norm, const char *name) {
            if (!std::isfinite(norm)) {
                error = std::string("GPU Poisson demag ") + name + " norm is nonfinite";
                return false;
            }
            return true;
        };
        const auto note_rhs_norm = [&]() {
            GpuPerformanceCounterDelta performance_delta{};
            performance_delta.demag_rhs_norm_evaluations = 1;
            performance_delta.demag_rhs_norm_sum = rhs_norm;
            gpu_performance_note(ctx.gpu_state.performance_counters, performance_delta);
        };
        const auto read_validation_norm = [&](const double *values, const char *name,
                                              double &norm) {
            const auto status = fullmag_cuda_demag_validation_norm(
                values, rows, scratch, norm, stream);
            if (status != cudaSuccess) {
                return reject_queued_work(std::string("GPU Poisson demag ") + name +
                                          " norm failed: " + cudaGetErrorString(status));
            }
            note_validation_readback(sizeof(norm));
            return finite_norm(norm, name);
        };
        const bool paired_norms = validation_needs.independent_residual && rows >= 2;
        if (!paired_norms) {
            if (!read_validation_norm(rhs_data, "RHS", rhs_norm)) return false;
            note_rhs_norm();
        }

        if (validation_needs.independent_residual) {
            const HYPRE_Int prior_status = HYPRE_GetError();
            if ((prior_status & ~HYPRE_ERROR_CONV) != 0) {
                error = "GPU Poisson demag residual validation found HYPRE status " +
                        std::to_string(prior_status);
                return false;
            }
            const HYPRE_Int matvec_status =
                workspace.A_par->Mult(*workspace.x_par, *workspace.residual);
            if (matvec_status != 0) {
                return reject_queued_work("GPU Poisson demag residual matvec failed: HYPRE status " +
                                          std::to_string(matvec_status));
            }
            const HYPRE_Int axpy_status = HYPRE_ParVectorAxpy(
                -1.0, *workspace.b_par, *workspace.residual);
            // AXPY returns the sticky HYPRE status, including an earlier
            // nonconvergence bit. Certification must still detect new errors.
            if ((axpy_status & ~(prior_status & HYPRE_ERROR_CONV)) != 0) {
                return reject_queued_work("GPU Poisson demag residual AXPY failed: HYPRE status " +
                                          std::to_string(axpy_status));
            }
            if (paired_norms) {
                double norms[2]{};
                const auto status = fullmag_cuda_demag_validation_norm_pair(
                    rhs_data, scratch, rows, scratch, norms, stream);
                if (status != cudaSuccess) {
                    return reject_queued_work(std::string("GPU Poisson demag paired norms failed: ") +
                                              cudaGetErrorString(status));
                }
                note_validation_readback(sizeof(norms));
                rhs_norm = norms[0];
                absolute_residual = norms[1];
                // RHS remains the first diagnosis even when NaN propagates
                // from it through A*x-b into the residual as well.
                if (!finite_norm(rhs_norm, "RHS")) return false;
                note_rhs_norm();
                if (!finite_norm(absolute_residual, "residual")) return false;
            } else if (!read_validation_norm(scratch, "residual", absolute_residual)) {
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

    DemagLinearSolveResult result;
    result.solver_kind = ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES
        ? "gpu_poisson_hypre/gmres"
        : "gpu_poisson_hypre/cg";
#if FULLMAG_HAS_CUDA_RUNTIME
    if (workspace.device_pcg) result.solver_kind="gpu_poisson_hypre/device_scalar_pcg_amg";
#endif
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
