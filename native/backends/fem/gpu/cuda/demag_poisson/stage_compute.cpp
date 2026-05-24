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
#include "gpu/cuda/demag_poisson/operators.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
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
#endif

} // namespace

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
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
    if (gpu.poisson_rhs == nullptr || gpu.poisson_solution == nullptr ||
        gpu.h_demag.x == nullptr || gpu.h_demag.y == nullptr || gpu.h_demag.z == nullptr) {
        reason = "strict FEM GPU demag requires device-resident Poisson and H_demag buffers";
        return false;
    }
    if (gpu.mesh_metrics.lumped_mass == nullptr || gpu.ms == nullptr) {
        reason = "strict FEM GPU demag energy requires uploaded Ms and lumped mass buffers";
        return false;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    fullmag_cuda_demag_rhs_csr(
        workspace->rhs.d_row_offsets,
        workspace->rhs.d_col_indices,
        workspace->rhs.d_values_x,
        workspace->rhs.d_values_y,
        workspace->rhs.d_values_z,
        m.x,
        m.y,
        m.z,
        gpu.poisson_rhs,
        static_cast<int>(workspace->rhs.rows),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag RHS CSR", reason)) {
        return false;
    }
    fullmag_cuda_zero_indexed_values(
        gpu.poisson_rhs,
        workspace->d_ess_tdofs,
        static_cast<int>(workspace->ess_tdofs.size()),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag essential RHS zero", reason)) {
        return false;
    }

    if (workspace->compute_ready_event != nullptr) {
        if (!cuda_ok(cudaEventRecord(workspace->compute_ready_event, stream),
                "cudaEventRecord GPU demag RHS ready", reason) ||
            !cuda_ok(cudaStreamWaitEvent(nullptr, workspace->compute_ready_event, 0),
                "cudaStreamWaitEvent GPU demag default stream wait RHS", reason)) {
            return false;
        }
    }

    workspace->b_par->HypreReadWrite();
    workspace->x_par->HypreReadWrite();
    const auto solve_start = FemSteadyClock::now();
    workspace->solver->Mult(*workspace->b_par, *workspace->x_par);
    const uint64_t solver_apply_wall_time_ns = elapsed_ns(solve_start);
    ctx.poisson_demag.last_solver_apply_wall_time_ns = solver_apply_wall_time_ns;
    ctx.poisson_demag.step_solver_apply_wall_time_ns += solver_apply_wall_time_ns;

    int iterations = 0;
    double residual = 0.0;
    read_demag_poisson_hypre_solver_stats(ctx, *workspace, iterations, residual);
    ctx.poisson_demag.last_iterations = iterations;
    ctx.poisson_demag.last_residual = residual;
    ctx.poisson_demag.last_setup_wall_time_ns = 0;
    ctx.poisson_demag.last_solver_setup_reused = true;

    if (workspace->hypre_done_event != nullptr) {
        if (!cuda_ok(cudaEventRecord(workspace->hypre_done_event, nullptr),
                "cudaEventRecord GPU demag hypre done", reason) ||
            !cuda_ok(cudaStreamWaitEvent(stream, workspace->hypre_done_event, 0),
                "cudaStreamWaitEvent GPU demag compute stream wait solve", reason)) {
            return false;
        }
    }
    fullmag_cuda_zero_indexed_values(
        gpu.poisson_solution,
        workspace->d_ess_tdofs,
        static_cast<int>(workspace->ess_tdofs.size()),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_x.d_row_offsets,
        workspace->recovery_x.d_col_indices,
        workspace->recovery_x.d_values,
        gpu.poisson_solution,
        gpu.magnetic_node_mask,
        gpu.h_demag.x,
        static_cast<int>(workspace->recovery_x.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_y.d_row_offsets,
        workspace->recovery_y.d_col_indices,
        workspace->recovery_y.d_values,
        gpu.poisson_solution,
        gpu.magnetic_node_mask,
        gpu.h_demag.y,
        static_cast<int>(workspace->recovery_y.rows),
        stream);
    fullmag_cuda_demag_recovery_csr(
        workspace->recovery_z.d_row_offsets,
        workspace->recovery_z.d_col_indices,
        workspace->recovery_z.d_values,
        gpu.poisson_solution,
        gpu.magnetic_node_mask,
        gpu.h_demag.z,
        static_cast<int>(workspace->recovery_z.rows),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag recovery CSR", reason)) {
        return false;
    }

    const int n = static_cast<int>(gpu.node_count);
    const int blocks = (n + 255) / 256;
    fullmag_cuda_demag_energy_blocks(
        m.x,
        m.y,
        m.z,
        gpu.h_demag.x,
        gpu.h_demag.y,
        gpu.h_demag.z,
        gpu.ms,
        gpu.mesh_metrics.lumped_mass,
        gpu.magnetic_node_mask,
        gpu.scalar_reduce_workspace,
        n,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        std::max(1, blocks),
        gpu.scalar_reduce_result,
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson demag energy reduction", reason)) {
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
        gpu.poisson_solution == nullptr ||
        gpu.scalar_reduce_workspace == nullptr ||
        gpu.scalar_reduce_temp_storage == nullptr ||
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
        gpu.poisson_solution,
        0.5 * kMu0 * ctx.poisson_demag.robin_effective_beta,
        gpu.scalar_reduce_workspace,
        rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch GPU Poisson-Robin demag boundary energy blocks", reason)) {
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_sum(
        gpu.scalar_reduce_workspace,
        std::max(1, (rows + kDemagCudaBlockSize - 1) / kDemagCudaBlockSize),
        result,
        gpu.scalar_reduce_temp_storage,
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

} // namespace fullmag::fem
