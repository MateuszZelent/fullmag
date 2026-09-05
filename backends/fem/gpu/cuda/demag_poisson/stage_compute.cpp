/*
 * GPU CUDA Poisson demag stage compute source contract.
 *
 * This source owns strict GPU Poisson demag RHS/solve/recovery/energy
 * orchestration for one device-resident RK stage. Lifecycle, Hypre solver setup,
 * P1 CSR operator construction, RK orchestration, and C ABI entrypoints live in
 * sibling modules.
 */

#include "gpu/cuda/demag_poisson/stage_compute.hpp"

#include "context.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"
#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/nvtx_ranges.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include <cuda_runtime.h>
#endif

#include <algorithm>
#include <string>

namespace fullmag::fem {

bool validate_gpu_demag_evaluation_request(
    const GpuDemagApplyRequest &request,
    std::string &reason)
{
    switch (request.evaluation_mode) {
    case GpuDemagEvaluationMode::FieldOnly:
    case GpuDemagEvaluationMode::FieldAndRecoveredEnergy:
        break;
    default:
        reason = "unsupported GPU demag evaluation mode";
        return false;
    }
    switch (request.purpose) {
    case GpuDemagSolvePurpose::IntermediateRkStage:
    case GpuDemagSolvePurpose::EndpointRkStage:
    case GpuDemagSolvePurpose::RelaxationTrial:
    case GpuDemagSolvePurpose::RelaxationAcceptedState:
    case GpuDemagSolvePurpose::ObservableRefresh:
    case GpuDemagSolvePurpose::ValidationOracle:
    case GpuDemagSolvePurpose::FrequencyTangent:
        break;
    default:
        reason = "unsupported GPU demag evaluation purpose";
        return false;
    }
    if ((request.purpose == GpuDemagSolvePurpose::IntermediateRkStage ||
         request.purpose == GpuDemagSolvePurpose::EndpointRkStage) &&
        request.evaluation_mode != GpuDemagEvaluationMode::FieldOnly) {
        reason = "GPU RK stage demag requests must use FieldOnly mode";
        return false;
    }
    if (request.purpose == GpuDemagSolvePurpose::FrequencyTangent &&
        request.evaluation_mode != GpuDemagEvaluationMode::FieldOnly) {
        reason = "frequency-domain demag tangent requests must use FieldOnly mode";
        return false;
    }
    reason.clear();
    return true;
}

namespace {

constexpr int kDemagCudaBlockSize = 256;

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

struct GpuDemagPhaseTimer {
    GpuRkPhaseTimingRuntimeState::EventPair *event = nullptr;
    cudaStream_t stream = nullptr;
    const char *label = nullptr;
    bool active = false;

    bool start(
        bool enabled,
        std::vector<GpuRkPhaseTimingRuntimeState::EventPair> &events,
        size_t &used_count,
        uint64_t &overflow_count,
        cudaStream_t phase_stream,
        const char *phase_label,
        std::string &reason)
    {
        if (!enabled) {
            return true;
        }
        stream = phase_stream;
        label = phase_label;
        if (used_count >= events.size()) {
            overflow_count += 1;
            return true;
        }
        event = &events[used_count];
        used_count += 1;
        if (event->start_event == nullptr || event->stop_event == nullptr) {
            reason = std::string(label) + " was not prepared before GPU demag hot loop";
            event = nullptr;
            return false;
        }
        if (!cuda_ok(
                cudaEventRecord(static_cast<cudaEvent_t>(event->start_event), stream),
                label,
                reason)) {
            event = nullptr;
            return false;
        }
        active = true;
        return true;
    }

    bool finish(std::string &reason)
    {
        if (!active) {
            return true;
        }
        if (!cuda_ok(
                cudaEventRecord(static_cast<cudaEvent_t>(event->stop_event), stream),
                label,
                reason)) {
            active = false;
            event = nullptr;
            return false;
        }
        active = false;
        event = nullptr;
        return true;
    }
};
#endif

} // namespace

namespace {

bool compute_device_demag_for_device_stage_impl(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    const GpuDemagApplyRequest &request,
    std::string &reason)
{
    if (!validate_gpu_demag_evaluation_request(request, reason)) {
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.demag.enabled) {
        return true;
    }
    auto *workspace = workspace_ptr(ctx);
    auto &gpu = ctx.gpu_state.device;
    if (workspace == nullptr || !workspace->ready) {
        reason = "strict FEM GPU demag requires ready device_hypre_poisson workspace";
        return false;
    }
    if (gpu.demag_poisson.poisson_rhs == nullptr ||
        gpu.demag_poisson.poisson_solution == nullptr ||
        gpu.demag_poisson.poisson_solution_full == nullptr ||
        gpu.fields.h_demag.x == nullptr || gpu.fields.h_demag.y == nullptr || gpu.fields.h_demag.z == nullptr) {
        reason = "strict FEM GPU demag requires device-resident Poisson and H_demag buffers";
        return false;
    }
    if (request.evaluation_mode == GpuDemagEvaluationMode::FieldAndRecoveredEnergy &&
        (gpu.mesh_metrics.node_volumes == nullptr || gpu.materials.ms == nullptr)) {
        reason = "strict FEM GPU demag FieldAndRecoveredEnergy requires uploaded Ms and node-volume buffers";
        return false;
    }
    const bool reset_initial_solution = request.reset_initial_solution;

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    auto &timings = ctx.gpu_state.rk_phase_timings;
    GpuDemagPhaseTimer assemble_timer;
    if (!assemble_timer.start(
            timings.enabled,
            timings.demag_assemble_events,
            timings.demag_assemble_used,
            timings.demag_assemble_overflow_count,
            stream,
            "GPU Poisson demag assemble phase timing",
            reason)) {
        return false;
    }
    {
        FULLMAG_NVTX_RANGE("fem.demag.rhs");
        const auto rhs_variant = workspace->rhs_plan.selected_variant();
        fullmag_cuda_demag_rhs_csr(
            workspace->rhs.d_row_offsets,
            workspace->rhs.d_col_indices,
            workspace->rhs.d_values_x,
            workspace->rhs.d_values_y,
            workspace->rhs.d_values_z,
            m.x,
            m.y,
            m.z,
            gpu.demag_poisson.poisson_rhs,
            static_cast<int>(workspace->rhs.rows),
            stream,
            rhs_variant);
        gpu_execution_receipt_note_performance_phase(
            ctx.gpu_state.execution_receipt,
            FemGpuPerformancePhase::KernelLaunch,
            0,
            workspace->rhs_plan.selected_variant_id());
        if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag RHS CSR", reason)) {
            return false;
        }
        fullmag_cuda_zero_indexed_values(
            gpu.demag_poisson.poisson_rhs,
            workspace->d_ess_tdofs,
            static_cast<int>(workspace->ess_tdofs.size()),
            stream);
        if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag essential RHS zero", reason)) {
            return false;
        }
        if (!assemble_timer.finish(reason)) {
            return false;
        }
    }

    if (reset_initial_solution) {
        if (!cuda_ok(cudaMemsetAsync(
                gpu.demag_poisson.poisson_solution,
                0,
                static_cast<size_t>(gpu.demag_poisson.scalar_dof_count) * sizeof(double),
                stream),
                "cudaMemsetAsync GPU Poisson demag initial solution", reason)) {
            return false;
        }
    }
    // The CUDA RHS kernel writes directly to the raw device pointer wrapped by
    // HypreParVector. Mark hypre/device memory as current without copying stale
    // host data back over it.
    workspace->b_par->HypreWrite();
    if (reset_initial_solution) {
        workspace->x_par->HypreWrite();
    } else {
        workspace->x_par->HypreReadWrite();
    }
    if (!prepare_demag_poisson_hypre_device_solver_apply(
            ctx,
            *workspace,
            reset_initial_solution,
            reason)) {
        return false;
    }
    ctx.poisson_demag.fresh_zero_guess_count =
        workspace->fresh_zero_guess_count;
    if (reset_initial_solution) {
        ctx.poisson_demag.fresh_zero_guess_count_current_step += 1;
    }
    uint64_t solver_apply_wall_time_ns = 0;
    {
        FULLMAG_NVTX_RANGE("fem.demag.hypre.apply");
        const uint64_t event_wait_count_before =
            workspace->stream_interop.event_wait_count;
        const auto solver_apply_start = FemSteadyClock::now();
        {
            FULLMAG_NVTX_RANGE("fullmag.demag.wait_in_enqueue");
            if (!hypre_wait_for_fullmag(workspace->stream_interop, stream, reason)) {
                return false;
            }
        }
        if (timings.enabled) {
            ctx.poisson_demag.step_hypre_wait_in_enqueue_wall_time_ns +=
                workspace->stream_interop.last_wait_in_enqueue_wall_time_ns;
        }
        ctx.poisson_demag.event_wait_count =
            workspace->stream_interop.event_wait_count;
        ctx.poisson_demag.event_wait_count_current_step += 1;

        {
            FULLMAG_NVTX_RANGE("fullmag.demag.hypre_device");
            if (!begin_hypre_apply_device_timing(
                    workspace->stream_interop, reason)) {
                return false;
            }
            {
                FULLMAG_NVTX_RANGE("fullmag.demag.hypre_mult_host");
                const auto host_api_start = timings.enabled
                    ? FemSteadyClock::now()
                    : FemSteadyClock::time_point{};
                if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_CG) {
                    static_cast<mfem::HyprePCG *>(workspace->solver.get())->Mult(
                        *workspace->b_par, *workspace->x_par);
                } else if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
                    static_cast<mfem::HypreGMRES *>(workspace->solver.get())->Mult(
                        *workspace->b_par, *workspace->x_par);
                } else {
                    workspace->solver->Mult(*workspace->b_par, *workspace->x_par);
                }
                if (timings.enabled) {
                    ctx.poisson_demag.step_hypre_host_api_wall_time_ns +=
                        elapsed_ns(host_api_start);
                }
            }
            if (!end_hypre_apply_device_timing(
                    workspace->stream_interop, reason)) {
                return false;
            }
        }

        {
            FULLMAG_NVTX_RANGE("fullmag.demag.wait_out_enqueue");
            if (!fullmag_wait_for_hypre(workspace->stream_interop, stream, reason)) {
                return false;
            }
        }
        if (timings.enabled) {
            ctx.poisson_demag.step_hypre_wait_out_enqueue_wall_time_ns +=
                workspace->stream_interop.last_wait_out_enqueue_wall_time_ns;
        }
        ctx.poisson_demag.event_wait_count =
            workspace->stream_interop.event_wait_count;
        ctx.poisson_demag.event_wait_count_current_step += 1;
        if (timings.enabled) {
            ctx.poisson_demag.step_hypre_event_wait_count +=
                workspace->stream_interop.event_wait_count -
                event_wait_count_before;
        }
        ctx.poisson_demag.global_sync_count =
            workspace->stream_interop.global_sync_count;
        /* Legacy field: inclusive host orchestration window, not GPU elapsed. */
        solver_apply_wall_time_ns = elapsed_ns(solver_apply_start);
    }
    ctx.poisson_demag.last_solver_apply_wall_time_ns = solver_apply_wall_time_ns;
    ctx.poisson_demag.step_solver_apply_wall_time_ns += solver_apply_wall_time_ns;

    int iterations = 0;
    double residual = 0.0;
    const bool solve_converged = validate_demag_poisson_hypre_device_solve(
        ctx, *workspace, iterations, residual, reason);
    ctx.poisson_demag.last_iterations = iterations;
    ctx.poisson_demag.last_residual = residual;
    ctx.poisson_demag.last_setup_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_setup_reused =
        workspace->solver_setup_complete &&
        workspace->solver_setup_count == 1u;
    if (!solve_converged) {
        if (!cuda_ok(cudaMemsetAsync(
                gpu.demag_poisson.poisson_solution,
                0,
                static_cast<size_t>(gpu.demag_poisson.scalar_dof_count) * sizeof(double),
                stream),
                "cudaMemsetAsync rejected GPU Poisson demag candidate",
                reason)) {
            return false;
        }
        workspace->x_par->HypreWrite();
        return false;
    }

    GpuDemagPhaseTimer recover_timer;
    if (!recover_timer.start(
            timings.enabled,
            timings.demag_recover_events,
            timings.demag_recover_used,
            timings.demag_recover_overflow_count,
            stream,
            "GPU Poisson demag recover phase timing",
            reason)) {
        return false;
    }
    const int n = static_cast<int>(gpu.lifecycle.node_count);
    {
        FULLMAG_NVTX_RANGE("fem.demag.recovery");
        fullmag_cuda_zero_indexed_values(
            gpu.demag_poisson.poisson_solution,
            workspace->d_ess_tdofs,
            static_cast<int>(workspace->ess_tdofs.size()),
            stream);
        const auto rec_variant = workspace->recovery_plan.selected_variant();
        if (workspace->recovery_mode == GpuDemagRecoveryMode::SharedPatternFusedXyz) {
            fullmag_cuda_demag_recovery_xyz_csr(
                workspace->recovery_x.d_row_offsets,
                workspace->recovery_x.d_col_indices,
                workspace->recovery_x.d_values,
                workspace->recovery_y.d_values,
                workspace->recovery_z.d_values,
                gpu.demag_poisson.poisson_solution,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_demag.x,
                gpu.fields.h_demag.y,
                gpu.fields.h_demag.z,
                static_cast<int>(workspace->recovery_x.rows),
                stream,
                rec_variant);
        } else {
            // Keep the three-launch path for a pattern mismatch.  Never fuse
            // based on nnz alone: row offsets and sorted column indices must
            // match exactly, as established during operator setup.
            fullmag_cuda_demag_recovery_csr(
                workspace->recovery_x.d_row_offsets,
                workspace->recovery_x.d_col_indices,
                workspace->recovery_x.d_values,
                gpu.demag_poisson.poisson_solution,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_demag.x,
                static_cast<int>(workspace->recovery_x.rows),
                stream,
                rec_variant);
            fullmag_cuda_demag_recovery_csr(
                workspace->recovery_y.d_row_offsets,
                workspace->recovery_y.d_col_indices,
                workspace->recovery_y.d_values,
                gpu.demag_poisson.poisson_solution,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_demag.y,
                static_cast<int>(workspace->recovery_y.rows),
                stream,
                rec_variant);
            fullmag_cuda_demag_recovery_csr(
                workspace->recovery_z.d_row_offsets,
                workspace->recovery_z.d_col_indices,
                workspace->recovery_z.d_values,
                gpu.demag_poisson.poisson_solution,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_demag.z,
                static_cast<int>(workspace->recovery_z.rows),
                stream,
                rec_variant);
        }
        gpu_execution_receipt_note_performance_phase(
            ctx.gpu_state.execution_receipt,
            FemGpuPerformancePhase::KernelLaunch,
            0,
            workspace->recovery_plan.selected_variant_id());
        if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag recovery CSR", reason)) {
            return false;
        }
        if (gpu.mesh_regions.has_periodic_reduced_nodes) {
            fullmag_cuda_relax_project_static_periodic_field(
                gpu.fields.h_demag.x,
                gpu.fields.h_demag.y,
                gpu.fields.h_demag.z,
                gpu.mesh_regions.periodic_representative_nodes,
                n,
                stream);
            if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag periodic H_demag projection", reason)) {
                return false;
            }
        }
        if (!recover_timer.finish(reason)) {
            return false;
        }
    }

    const int blocks = (n + 255) / 256;
    if (request.evaluation_mode == GpuDemagEvaluationMode::FieldAndRecoveredEnergy) {
        if (gpu.reductions.scalar_result == nullptr) {
            reason = "GPU demag FieldAndRecoveredEnergy evaluation requires a scalar result buffer";
            return false;
        }
        GpuDemagPhaseTimer energy_timer;
        if (!energy_timer.start(
                timings.enabled,
                timings.demag_energy_events,
                timings.demag_energy_used,
                timings.demag_energy_overflow_count,
                stream,
                "GPU Poisson demag energy phase timing",
                reason)) {
            return false;
        }
        fullmag_cuda_demag_energy_blocks(
            m.x,
            m.y,
            m.z,
            gpu.fields.h_demag.x,
            gpu.fields.h_demag.y,
            gpu.fields.h_demag.z,
            gpu.materials.ms,
            gpu.mesh_metrics.node_volumes,
            gpu.mesh_regions.magnetic_node_mask,
            gpu.reductions.scalar_workspace,
            n,
            stream);
        if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy blocks", reason)) {
            return false;
        }
        size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        const cudaError_t reduce_rc = fullmag_cuda_device_sum(
            gpu.reductions.scalar_workspace,
            std::max(1, blocks),
            gpu.reductions.scalar_result,
            gpu.reductions.temp_storage,
            reduce_bytes,
            stream);
        if (!cuda_ok(reduce_rc, "launch GPU Poisson demag energy reduction", reason) ||
            !cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy reduction", reason)) {
            return false;
        }
        if (!energy_timer.finish(reason)) {
            return false;
        }
        GpuPerformanceCounterDelta performance_delta{};
        performance_delta.demag_stage_energy_evaluations = 1;
        gpu_performance_note(
            ctx.gpu_state.performance_counters,
            performance_delta);
    } else if (gpu.reductions.scalar_result != nullptr) {
        // FieldOnly is the normal RK stage mode.  Clear the published final
        // energy slot and the legacy stage-result slot so a direct control
        // readback cannot observe a value left by an earlier energy reduction.
        // The final energy owner writes its slot again after the accepted state
        // is finalized.
        if (!cuda_ok(
                cudaMemsetAsync(gpu.reductions.scalar_result, 0, sizeof(double), stream),
                "clear GPU demag FieldOnly stage energy result",
                reason)) {
            return false;
        }
        double *demag_energy_slot = gpu_rk_final_scalar_result(
            gpu, GpuFinalScalarSlot::DemagEnergy);
        if (!cuda_ok(
                cudaMemsetAsync(demag_energy_slot, 0, sizeof(double), stream),
                "clear GPU demag FieldOnly energy publication slot",
                reason)) {
            return false;
        }
    }
    if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            FEM_GPU_OPERATOR_DEMAG_RHS | FEM_GPU_OPERATOR_DEMAG_RECOVERY);
    }
    gpu.demag_poisson.last_evaluation_mode =
        static_cast<std::uint8_t>(request.evaluation_mode);
    gpu.demag_poisson.last_evaluation_purpose =
        static_cast<std::uint8_t>(request.purpose);
    if (request.evaluation_mode == GpuDemagEvaluationMode::FieldOnly) {
        gpu.demag_poisson.field_only_evaluation_count += 1;
    } else {
        gpu.demag_poisson.field_and_energy_evaluation_count += 1;
    }
    ctx.poisson_demag.solves_current_step += 1;
    return true;
#else
    (void)ctx;
    (void)m;
    (void)raw_stream;
    (void)request;
    reason = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

} // namespace

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    const GpuDemagApplyRequest &request,
    std::string &reason)
{
    return compute_device_demag_for_device_stage_impl(
        ctx,
        m,
        raw_stream,
        request,
        reason);
}

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    std::string &reason)
{
    // Preserve the historical direct-field behavior for callers that may
    // inspect the temporary scalar result.  RK uses the typed FieldOnly
    // overload below through rk_demag_dispatch.
    return compute_device_demag_for_device_stage(
        ctx,
        m,
        raw_stream,
        GpuDemagApplyRequest{
            false,
            GpuDemagEvaluationMode::FieldAndRecoveredEnergy,
            GpuDemagSolvePurpose::ObservableRefresh},
        reason);
}

bool compute_device_demag_for_device_stage_fresh(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    const GpuDemagApplyRequest &request,
    std::string &reason)
{
    auto fresh_request = request;
    // The named fresh entrypoint is a lifecycle guarantee.  Do not let a
    // caller accidentally turn it into a warm-start solve by omitting the
    // request bit.
    fresh_request.reset_initial_solution = true;
    return compute_device_demag_for_device_stage_impl(
        ctx,
        m,
        raw_stream,
        fresh_request,
        reason);
}

bool compute_device_demag_for_device_stage_fresh(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    std::string &reason)
{
    return compute_device_demag_for_device_stage_fresh(
        ctx,
        m,
        raw_stream,
        GpuDemagApplyRequest{
            true,
            GpuDemagEvaluationMode::FieldAndRecoveredEnergy,
            GpuDemagSolvePurpose::ObservableRefresh},
        reason);
}

bool recover_device_demag_full_domain_field_device(
    Context &ctx,
    void *raw_stream,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto *workspace = workspace_ptr(ctx);
    auto &gpu = ctx.gpu_state.device;
    auto &visual = gpu.demag_poisson.poisson_gradient;
    if (workspace == nullptr || !workspace->ready) {
        reason = "full-domain GPU demag observable requires a ready device Poisson workspace";
        return false;
    }
    if (gpu.demag_poisson.poisson_solution == nullptr ||
        visual.x == nullptr || visual.y == nullptr || visual.z == nullptr) {
        reason = "full-domain GPU demag observable requires the Poisson solution and gradient buffers";
        return false;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    if (workspace->visual_recovery_mode == GpuDemagRecoveryMode::SharedPatternFusedXyz) {
        fullmag_cuda_demag_recovery_xyz_csr(
            workspace->visual_recovery_x.d_row_offsets,
            workspace->visual_recovery_x.d_col_indices,
            workspace->visual_recovery_x.d_values,
            workspace->visual_recovery_y.d_values,
            workspace->visual_recovery_z.d_values,
            gpu.demag_poisson.poisson_solution,
            nullptr,
            visual.x,
            visual.y,
            visual.z,
            static_cast<int>(workspace->visual_recovery_x.rows),
            stream);
    } else {
        // The visual operator has its own pattern because it also covers air
        // nodes.  Keep its split fallback independent from physical recovery.
        /* Legacy visual-recovery argument layout remains: nullptr,
        visual.x */
        fullmag_cuda_demag_recovery_csr(
            workspace->visual_recovery_x.d_row_offsets,
            workspace->visual_recovery_x.d_col_indices,
            workspace->visual_recovery_x.d_values,
            gpu.demag_poisson.poisson_solution,
            nullptr,
            visual.x,
            static_cast<int>(workspace->visual_recovery_x.rows),
            stream);
        fullmag_cuda_demag_recovery_csr(
            workspace->visual_recovery_y.d_row_offsets,
            workspace->visual_recovery_y.d_col_indices,
            workspace->visual_recovery_y.d_values,
            gpu.demag_poisson.poisson_solution,
            nullptr,
            visual.y,
            static_cast<int>(workspace->visual_recovery_y.rows),
            stream);
        fullmag_cuda_demag_recovery_csr(
            workspace->visual_recovery_z.d_row_offsets,
            workspace->visual_recovery_z.d_col_indices,
            workspace->visual_recovery_z.d_values,
            gpu.demag_poisson.poisson_solution,
            nullptr,
            visual.z,
            static_cast<int>(workspace->visual_recovery_z.rows),
            stream);
    }
    if (!cuda_ok(cudaGetLastError(), "launch full-domain GPU demag observable recovery", reason)) {
        return false;
    }
    const int n = static_cast<int>(gpu.lifecycle.node_count);
    if (gpu.mesh_regions.has_periodic_reduced_nodes) {
        fullmag_cuda_relax_project_static_periodic_field(
            visual.x,
            visual.y,
            visual.z,
            gpu.mesh_regions.periodic_representative_nodes,
            n,
            stream);
        if (!cuda_ok(cudaGetLastError(), "launch full-domain GPU demag visual periodic projection", reason)) {
            return false;
        }
    }
    return true;
#else
    (void)ctx;
    (void)raw_stream;
        reason = "full-domain GPU demag observable requires CUDA, MFEM, and MPI support";
    return false;
#endif
}

bool recover_device_demag_visual_field(
    Context &ctx,
    void *raw_stream,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!recover_device_demag_full_domain_field_device(ctx, raw_stream, reason)) {
        return false;
    }
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    if (!cuda_ok(cudaStreamSynchronize(stream), "synchronize full-domain GPU demag visual recovery", reason)) {
        return false;
    }
    return gpu_state_download_component_aos(
        ctx.gpu_state.device,
        ctx.gpu_state.device.demag_poisson.poisson_gradient,
        ctx.demag.h_visual_xyz,
        ctx.transfer_audit.audit,
        "H_demag visual",
        reason);
#else
    (void)ctx;
    (void)raw_stream;
    reason = "full-domain GPU demag visualization requires CUDA, MFEM, and MPI support";
    return false;
#endif
}

bool reduce_device_demag_robin_boundary_energy(
    Context &ctx,
    double *result,
    void *raw_stream,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto *workspace = workspace_ptr(ctx);
    auto &gpu = ctx.gpu_state.device;
    if (workspace == nullptr ||
        workspace->robin_boundary_mass.rows == 0 ||
        workspace->robin_boundary_mass.d_row_offsets == nullptr ||
        workspace->robin_boundary_mass.d_col_indices == nullptr ||
        workspace->robin_boundary_mass.d_values == nullptr ||
        gpu.demag_poisson.poisson_solution == nullptr ||
        gpu.reductions.scalar_workspace == nullptr ||
        gpu.reductions.temp_storage == nullptr ||
        result == nullptr) {
        reason = "GPU Poisson-Robin demag energy requires device Robin boundary mass, potential, and reduction buffers";
        return false;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    const int rows = static_cast<int>(workspace->robin_boundary_mass.rows);
    fullmag_cuda_demag_robin_boundary_energy_blocks(
        workspace->robin_boundary_mass.d_row_offsets,
        workspace->robin_boundary_mass.d_col_indices,
        workspace->robin_boundary_mass.d_values,
        gpu.demag_poisson.poisson_solution,
        0.5 * kMu0 * ctx.poisson_demag.robin_effective_beta,
        gpu.reductions.scalar_workspace,
        rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson-Robin demag boundary energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t robin_rc = fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        std::max(1, (rows + kDemagCudaBlockSize - 1) / kDemagCudaBlockSize),
        result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(robin_rc, "launch GPU Poisson-Robin demag boundary energy reduction", reason)) {
        return false;
    }
    return cuda_ok(
        cudaGetLastError(),
        "launch GPU Poisson-Robin demag boundary energy reduction",
        reason);
#else
    (void)ctx;
    (void)result;
    (void)raw_stream;
    reason = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

bool reduce_device_demag_robin_boundary_difference(
    Context &ctx,
    double *delta_result,
    double *absolute_result,
    void *raw_stream,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto *workspace = workspace_ptr(ctx);
    auto &gpu = ctx.gpu_state.device;
    if (workspace == nullptr ||
        workspace->robin_boundary_mass.rows == 0 ||
        workspace->robin_boundary_mass.d_row_offsets == nullptr ||
        workspace->robin_boundary_mass.d_col_indices == nullptr ||
        workspace->robin_boundary_mass.d_values == nullptr ||
        gpu.demag_poisson.poisson_solution_full == nullptr ||
        gpu.demag_poisson.poisson_solution == nullptr ||
        gpu.reductions.scalar_workspace == nullptr ||
        gpu.rk.k[1].x == nullptr ||
        gpu.reductions.temp_storage == nullptr ||
        delta_result == nullptr || absolute_result == nullptr) {
        reason = "GPU Poisson-Robin demag difference requires endpoint potentials, boundary mass, and reduction buffers";
        return false;
    }
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    const int rows = static_cast<int>(workspace->robin_boundary_mass.rows);
    fullmag_cuda_demag_robin_boundary_difference_blocks(
        workspace->robin_boundary_mass.d_row_offsets,
        workspace->robin_boundary_mass.d_col_indices,
        workspace->robin_boundary_mass.d_values,
        gpu.demag_poisson.poisson_solution_full,
        gpu.demag_poisson.poisson_solution,
        kMu0 * ctx.poisson_demag.robin_effective_beta,
        gpu.reductions.scalar_workspace,
        gpu.rk.k[1].x,
        rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson-Robin demag boundary difference blocks", reason)) {
        return false;
    }
    const int blocks = std::max(1, (rows + kDemagCudaBlockSize - 1) / kDemagCudaBlockSize);
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    const cudaError_t delta_rc = fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        blocks,
        delta_result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(delta_rc, "launch GPU Poisson-Robin demag boundary delta reduction", reason)) {
        return false;
    }
    const cudaError_t abs_rc = fullmag_cuda_device_sum(
        gpu.rk.k[1].x,
        blocks,
        absolute_result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(abs_rc, "launch GPU Poisson-Robin demag boundary absolute reduction", reason)) {
        return false;
    }
    return cuda_ok(cudaGetLastError(), "launch GPU Poisson-Robin demag boundary difference reductions", reason);
#else
    (void)ctx;
    (void)delta_result;
    (void)absolute_result;
    (void)raw_stream;
    reason = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

} // namespace fullmag::fem
