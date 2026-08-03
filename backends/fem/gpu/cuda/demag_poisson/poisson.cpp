/*
 * GPU CUDA Poisson demag source contract.
 *
 * This source owns strict GPU Poisson demag lifecycle and status reporting.
 * Hypre solver setup lives in hypre_device_solver.cpp; stage compute lives in
 * stage_compute.cpp; P1 RHS/recovery CSR operator records and device
 * upload/destruction live in operators.cpp. It does not own public DSL semantics, MFEM context construction, RK stage orchestration, exchange, local interaction kernels, or C ABI entrypoints.
 */

#include "gpu/cuda/demag_poisson/poisson.hpp"

#include "context.hpp"
#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"
#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <cstdint>
#include <memory>
#include <string>

namespace fullmag::fem {

namespace {

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

bool gpu_demag_poisson_initialize(Context &ctx, std::string &error)
{
    if (!ctx.demag.enabled || ctx.poisson_demag.gpu_demag_mode != FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON) {
        return true;
    }
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    if (!ctx.gpu_state.device.lifecycle.allocated ||
        ctx.gpu_state.device.demag_poisson.poisson_rhs == nullptr ||
        ctx.gpu_state.device.demag_poisson.poisson_solution == nullptr ||
        ctx.gpu_state.device.fields.h_demag.x == nullptr) {
        error = "GPU Poisson demag requires allocated FemGpuState demag buffers";
        return false;
    }

    auto workspace = std::make_unique<GpuDemagPoissonWorkspace>();
    if (!build_p1_demag_operators(ctx, *workspace, error)) {
        return false;
    }
    auto *potential_fes = static_cast<mfem::FiniteElementSpace *>(
        ctx.poisson_demag.potential_fes);
    if (potential_fes == nullptr ||
        !gpu_state_resize_demag_poisson_scalars(
            ctx.gpu_state.device,
            workspace->rhs.rows,
            static_cast<uint64_t>(potential_fes->GetTrueVSize()),
            error)) {
        return false;
    }

    uint64_t device_bytes = 0;
    if (!upload_demag_poisson_operators(*workspace, device_bytes, error)) {
        return false;
    }
    workspace->device_bytes = device_bytes;

    if (!cuda_ok(cudaMemset(ctx.gpu_state.device.demag_poisson.poisson_rhs, 0,
                static_cast<size_t>(ctx.gpu_state.device.demag_poisson.scalar_dof_count) * sizeof(double)),
            "cudaMemset demag poisson_rhs", error) ||
        !cuda_ok(cudaMemset(ctx.gpu_state.device.demag_poisson.poisson_solution, 0,
                static_cast<size_t>(ctx.gpu_state.device.demag_poisson.scalar_dof_count) * sizeof(double)),
            "cudaMemset demag poisson_solution", error) ||
        !cuda_ok(cudaMemset(ctx.gpu_state.device.demag_poisson.poisson_solution_full, 0,
                static_cast<size_t>(ctx.gpu_state.device.demag_poisson.full_scalar_dof_count) * sizeof(double)),
            "cudaMemset demag poisson_solution_full", error)) {
        destroy_demag_poisson_operators(*workspace);
        return false;
    }

    if (!initialize_demag_poisson_hypre_device_solver(ctx, *workspace, error)) {
        destroy_demag_poisson_operators(*workspace);
        return false;
    }
    if (!initialize_hypre_stream_interop(workspace->stream_interop, error)) {
        destroy_demag_poisson_operators(*workspace);
        return false;
    }

    workspace->ready = true;
    ctx.poisson_demag.gpu_workspace = workspace.release();
    ctx.poisson_demag.gpu_workspace_ready = true;
    ctx.poisson_demag.gpu_workspace_device_bytes = device_bytes;
    ctx.gpu_state.device.lifecycle.device_bytes += device_bytes;
    return true;
#else
    (void)ctx;
    error = "strict FEM GPU demag requires MFEM MPI, hypre GPU, and CUDA runtime support";
    return false;
#endif
}

void gpu_demag_poisson_destroy(Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    auto *workspace = workspace_ptr(ctx);
    if (workspace == nullptr) {
        return;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    const uint64_t workspace_device_bytes = workspace->device_bytes;
    destroy_demag_poisson_operators(*workspace);
    if (workspace_device_bytes <= ctx.gpu_state.device.lifecycle.device_bytes) {
        ctx.gpu_state.device.lifecycle.device_bytes -= workspace_device_bytes;
    }
#endif
    delete workspace;
    ctx.poisson_demag.gpu_workspace = nullptr;
    ctx.poisson_demag.gpu_workspace_ready = false;
    ctx.poisson_demag.gpu_workspace_device_bytes = 0;
#else
    (void)ctx;
#endif
}

bool gpu_demag_poisson_ready(const Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    auto *workspace = workspace_ptr(ctx);
    return workspace != nullptr && workspace->ready;
#else
    (void)ctx;
    return false;
#endif
}

uint64_t gpu_demag_poisson_device_bytes(const Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    auto *workspace = workspace_ptr(ctx);
    return workspace != nullptr ? workspace->device_bytes : 0;
#else
    (void)ctx;
    return 0;
#endif
}

const char *gpu_demag_poisson_operator_mode(const Context &ctx)
{
    if (!ctx.demag.enabled) {
        return "none";
    }
    return gpu_demag_poisson_ready(ctx) ? "device_hypre_poisson" : "unsupported";
}

const char *gpu_demag_poisson_hypre_policy(const Context &ctx)
{
    if (!ctx.demag.enabled) {
        return "none";
    }
    return gpu_demag_poisson_ready(ctx) ? "device" : "unavailable";
}

} // namespace fullmag::fem
