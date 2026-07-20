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
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"

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
    bool reset_initial_solution,
    std::string &reason)
{
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
    if (gpu.mesh_metrics.lumped_mass == nullptr || gpu.materials.ms == nullptr) {
        reason = "strict FEM GPU demag energy requires uploaded Ms and lumped mass buffers";
        return false;
    }

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
        stream);
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

    if (reset_initial_solution) {
        if (!cuda_ok(cudaMemsetAsync(
                gpu.demag_poisson.poisson_solution,
                0,
                static_cast<size_t>(gpu.lifecycle.node_count) * sizeof(double),
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
    if (!hypre_wait_for_fullmag(workspace->stream_interop, stream, reason)) {
        return false;
    }
    ctx.poisson_demag.event_wait_count =
        workspace->stream_interop.event_wait_count;
    ctx.poisson_demag.event_wait_count_current_step += 1;
    const auto solve_start = FemSteadyClock::now();
    workspace->solver->Mult(*workspace->b_par, *workspace->x_par);
    if (!fullmag_wait_for_hypre(workspace->stream_interop, stream, reason)) {
        return false;
    }
    ctx.poisson_demag.event_wait_count =
        workspace->stream_interop.event_wait_count;
    ctx.poisson_demag.event_wait_count_current_step += 1;
    ctx.poisson_demag.global_sync_count =
        workspace->stream_interop.global_sync_count;
    const uint64_t solver_apply_wall_time_ns = elapsed_ns(solve_start);
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
                static_cast<size_t>(gpu.lifecycle.node_count) * sizeof(double),
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
    fullmag_cuda_zero_indexed_values(
        gpu.demag_poisson.poisson_solution,
        workspace->d_ess_tdofs,
        static_cast<int>(workspace->ess_tdofs.size()),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_x.d_row_offsets,
        workspace->recovery_x.d_col_indices,
        workspace->recovery_x.d_values,
        gpu.demag_poisson.poisson_solution,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.fields.h_demag.x,
        static_cast<int>(workspace->recovery_x.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_y.d_row_offsets,
        workspace->recovery_y.d_col_indices,
        workspace->recovery_y.d_values,
        gpu.demag_poisson.poisson_solution,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.fields.h_demag.y,
        static_cast<int>(workspace->recovery_y.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_z.d_row_offsets,
        workspace->recovery_z.d_col_indices,
        workspace->recovery_z.d_values,
        gpu.demag_poisson.poisson_solution,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.fields.h_demag.z,
        static_cast<int>(workspace->recovery_z.rows),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag recovery CSR", reason)) {
        return false;
    }
    const int n = static_cast<int>(gpu.lifecycle.node_count);
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

    const int blocks = (n + 255) / 256;
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
        gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.reductions.scalar_workspace,
        n,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        std::max(1, blocks),
        gpu.reductions.scalar_result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy reduction", reason)) {
        return false;
    }
    if (!energy_timer.finish(reason)) {
        return false;
    }
    ctx.poisson_demag.solves_current_step += 1;
    return true;
#else
    (void)ctx;
    (void)m;
    (void)raw_stream;
    reason = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

} // namespace

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    std::string &reason)
{
    return compute_device_demag_for_device_stage_impl(
        ctx,
        m,
        raw_stream,
        false,
        reason);
}

bool compute_device_demag_for_device_stage_fresh(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    std::string &reason)
{
    return compute_device_demag_for_device_stage_impl(
        ctx,
        m,
        raw_stream,
        true,
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
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_x.d_row_offsets,
        workspace->recovery_x.d_col_indices,
        workspace->recovery_x.d_values,
        gpu.demag_poisson.poisson_solution,
        nullptr,
        visual.x,
        static_cast<int>(workspace->recovery_x.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_y.d_row_offsets,
        workspace->recovery_y.d_col_indices,
        workspace->recovery_y.d_values,
        gpu.demag_poisson.poisson_solution,
        nullptr,
        visual.y,
        static_cast<int>(workspace->recovery_y.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_z.d_row_offsets,
        workspace->recovery_z.d_col_indices,
        workspace->recovery_z.d_values,
        gpu.demag_poisson.poisson_solution,
        nullptr,
        visual.z,
        static_cast<int>(workspace->recovery_z.rows),
        stream);
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
    fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        std::max(1, (rows + kDemagCudaBlockSize - 1) / kDemagCudaBlockSize),
        result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
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
    fullmag_cuda_device_sum(
        gpu.reductions.scalar_workspace,
        blocks,
        delta_result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    fullmag_cuda_device_sum(
        gpu.rk.k[1].x,
        blocks,
        absolute_result,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
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
