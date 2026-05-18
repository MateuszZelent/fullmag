/*
 * FEM C ABI facade source contract.
 *
 * This source owns the exported fullmag_fem_* ABI entrypoints, handle/global
 * error propagation, high-level backend lifetime calls, step/observe/state C
 * wrappers, and ABI-level unavailable-path errors. It does not own Context construction internals, MFEM runtime lifecycle, interaction physics, integrator stages, or transfer-audit policy.
 */

#include "fullmag_fem.h"

#include "context.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_explicit_step.hpp"
#include "cpu/mfem/runtime/availability.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "gpu_rk.hpp"
#include "gpu_state.hpp"
#include "transfer_audit.hpp"
#include "../cpu/mfem/interactions/magnetoelastic.hpp"

#include <cstdio>
#include <cstring>
#include <string>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

void fullmag_fem_set_global_error(const std::string &message);
void fullmag_fem_clear_global_error();
const char *fullmag_fem_get_global_error();
void fullmag_fem_set_handle_error(fullmag_fem_backend *handle, const std::string &message);

namespace {

constexpr const char *kUnavailableMessage =
    "fullmag_fem native backend was built without the MFEM stack; rebuild with FULLMAG_USE_MFEM_STACK=ON and an installed MFEM toolchain";

} // namespace

extern "C" {

int fullmag_fem_is_available(void) {
    const auto info = fullmag::fem::query_availability();
    return (info.native_fem_cpu_available != 0 || info.native_fem_gpu_available != 0) ? 1 : 0;
}

int fullmag_fem_get_availability_info(fullmag_fem_availability_info *out_info) {
    if (out_info == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_availability_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_info = fullmag::fem::query_availability();
    return FULLMAG_FEM_OK;
}

fullmag_fem_backend *fullmag_fem_backend_create(const fullmag_fem_plan_desc *plan) {
    if (plan == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_create received null plan");
        return nullptr;
    }

    auto *handle = new (std::nothrow) fullmag_fem_backend();
    if (handle == nullptr) {
        fullmag_fem_set_global_error("failed to allocate fullmag_fem_backend");
        return nullptr;
    }

    std::string error;
    if (!fullmag::fem::context_from_plan(handle->context, *plan, error)) {
        fullmag_fem_set_global_error(error);
        fullmag_fem_set_handle_error(handle, error);
        delete handle;
        return nullptr;
    }
    fullmag::fem::configure_transfer_audit_from_env(handle->context.transfer_audit);

    handle->last_error.clear();
    fullmag_fem_clear_global_error();
    return handle;
}

int fullmag_fem_backend_step(
    fullmag_fem_backend *handle,
    double dt_seconds,
    fullmag_fem_step_stats *out_stats
) {
    if (handle == nullptr || out_stats == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_step requires non-null handle and out_stats");
        return FULLMAG_FEM_ERR_INVALID;
    }

#if FULLMAG_HAS_MFEM_STACK
    handle->last_error.clear();
    bool ok = false;
    auto &ctx = handle->context;
    ctx.step_interrupted = false;
    ctx.transfer_audit.reset_step_violation();
    const auto &tab = fullmag::fem::tableau_for_integrator(ctx.integrator);
    {
        fullmag::fem::TransferAuditScope hot_loop(
            ctx.transfer_audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        ok = fullmag::fem::context_step_explicit_rk_mfem(
            ctx, tab, dt_seconds, *out_stats, handle->last_error);
    }
    if (ctx.transfer_audit.hot_loop_violation) {
        fullmag::fem::set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        fullmag_fem_set_handle_error(
            handle,
            ctx.transfer_audit.hot_loop_violation_message);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!ok) {
        fullmag::fem::set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (!fullmag::fem::gpu_rk_finalize_step_stats(ctx, *out_stats, handle->last_error)) {
        fullmag::fem::set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (ctx.step_interrupted) {
        if (!fullmag::fem::context_snapshot_stats_mfem(
                ctx, *out_stats, handle->last_error)) {
            fullmag::fem::set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            fullmag_fem_set_handle_error(handle, handle->last_error);
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        fullmag::fem::set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED,
            nullptr,
            0.0,
            0.0);
        out_stats->dt_seconds = 0.0;
        return FULLMAG_FEM_ERR_INTERRUPTED;
    }
    return FULLMAG_FEM_OK;
#else
    (void)dt_seconds;
    fullmag_fem_set_handle_error(handle, kUnavailableMessage);
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int fullmag_fem_backend_set_interrupt_poll(
    fullmag_fem_backend *handle,
    fullmag_fem_interrupt_poll_fn poll_fn,
    void *user_data
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_set_interrupt_poll received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->context.interrupt_poll = poll_fn;
    handle->context.interrupt_poll_user_data = user_data;
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_backend *handle,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_copy_field_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    if (observable == FULLMAG_FEM_OBSERVABLE_M &&
        !fullmag::fem::context_sync_gpu_magnetization_to_host(
            handle->context,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return fullmag::fem::context_copy_field_f64(
        handle->context,
        observable,
        out_xyz,
        out_len,
        handle->last_error);
}

int fullmag_fem_backend_upload_magnetization_f64(
    fullmag_fem_backend *handle,
    const double *m_xyz,
    uint64_t len
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_backend_upload_magnetization_f64 received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    return fullmag::fem::context_upload_magnetization_f64(
        handle->context,
        m_xyz,
        len,
        handle->last_error);
}

int fullmag_fem_backend_snapshot_stats(
    fullmag_fem_backend *handle,
    fullmag_fem_step_stats *out_stats
) {
    if (out_stats == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_snapshot_stats received null out_stats");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_snapshot_stats received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }

#if FULLMAG_HAS_MFEM_STACK
    handle->last_error.clear();
    if (!fullmag::fem::context_snapshot_stats_mfem(
            handle->context, *out_stats, handle->last_error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    return FULLMAG_FEM_OK;
#else
    fullmag_fem_set_handle_error(handle, kUnavailableMessage);
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int fullmag_fem_backend_stage_completion(
    fullmag_fem_backend *handle,
    fullmag_fem_stage_completion *out_completion
) {
    if (out_completion == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_stage_completion received null out_completion");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_stage_completion received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_completion = fullmag::fem::stage_completion_snapshot(handle->context);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_device_info(
    fullmag_fem_backend *handle,
    fullmag_fem_device_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_handle_error(handle, "fullmag_fem_backend_get_device_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_device_info received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    *out_info = fullmag::fem::device_info_snapshot(handle->context);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_transfer_audit(
    fullmag_fem_backend *handle,
    fullmag_fem_transfer_audit *out_audit
) {
    if (out_audit == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_get_transfer_audit received null out_audit");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_transfer_audit received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_audit = fullmag::fem::transfer_audit_snapshot(handle->context.transfer_audit);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_gpu_state_info(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_state_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_get_gpu_state_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_gpu_state_info received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    *out_info = fullmag::fem::gpu_state_info(handle->context.gpu_state);
    return FULLMAG_FEM_OK;
}

int fullmag_fem_backend_get_gpu_rk_plan_info(
    fullmag_fem_backend *handle,
    fullmag_fem_gpu_rk_plan_info *out_info
) {
    if (out_info == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_get_gpu_rk_plan_info received null out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_get_gpu_rk_plan_info received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    std::string reason;
    const auto plan = fullmag::fem::gpu_rk_plan_exchange_only(handle->context, reason);
    *out_info = {};
    out_info->exchange_only_enabled = plan.enabled ? 1 : 0;
    out_info->stage_count = plan.stage_count;
    out_info->uses_cuda_kernels = plan.uses_cuda_kernels ? 1 : 0;
    out_info->allows_exchange_host_sync = plan.allows_exchange_host_sync ? 1 : 0;
    out_info->stage_exchange_device_resident =
        plan.stage_exchange_device_resident ? 1 : 0;
    std::snprintf(
        out_info->exchange_operator_mode,
        sizeof(out_info->exchange_operator_mode),
        "%s",
        plan.exchange_operator_mode != nullptr ? plan.exchange_operator_mode : "unsupported");
    if (!reason.empty()) {
        std::snprintf(out_info->reason, sizeof(out_info->reason), "%s", reason.c_str());
    }
    return FULLMAG_FEM_OK;
}

const char *fullmag_fem_backend_last_error(fullmag_fem_backend *handle) {
    if (handle != nullptr) {
        return handle->last_error.empty() ? nullptr : handle->last_error.c_str();
    }
    return fullmag_fem_get_global_error();
}

void fullmag_fem_backend_destroy(fullmag_fem_backend *handle) {
    if (handle != nullptr) {
        fullmag::fem::gpu_state_destroy(handle->context.gpu_state);
    }
#if FULLMAG_HAS_MFEM_STACK
    if (handle != nullptr) {
        fullmag::fem::context_destroy_mfem(handle->context);
    }
#endif
    delete handle;
}

int fullmag_fem_backend_upload_strain(
    fullmag_fem_backend *handle,
    const double *strain_voigt,
    uint64_t len,
    int uniform
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_upload_strain received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (strain_voigt == nullptr || len == 0) {
        fullmag_fem_set_handle_error(handle, "strain data pointer is null or length is zero");
        return FULLMAG_FEM_ERR_INVALID;
    }
    handle->last_error.clear();
    auto &ctx = handle->context;
    ctx.mel_uniform_strain = uniform != 0;
    ctx.mel_strain_voigt.assign(strain_voigt, strain_voigt + static_cast<size_t>(len));
    if (ctx.gpu_state.allocated && !ctx.mel_uniform_strain) {
        std::string error;
        if (!fullmag::fem::gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state,
                ctx.mel_strain_voigt.data(),
                static_cast<uint64_t>(ctx.mel_strain_voigt.size()),
                ctx.transfer_audit,
                error)) {
            fullmag_fem_set_handle_error(handle, error);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }
    // Recompute H_mel with new strain
    if (ctx.enable_magnetoelastic) {
#if FULLMAG_HAS_MFEM_STACK
        fullmag::fem::compute_magnetoelastic_field(ctx, ctx.state.m_xyz);
#endif
    }
    return FULLMAG_FEM_OK;
}

// ── GPU Dense Generalized Eigenvalue Solver (Etap A4) ──────────────────────
//
// Solves K·x = λ·M·x on the GPU when cuSolver is available.
// Falls back to a clear UNAVAILABLE error otherwise.
//
// When FULLMAG_HAS_CUDA_RUNTIME is defined and cuSolver headers are present
// (detected via FULLMAG_HAS_CUSOLVER compile flag), we use:
//   cusolverDnDsygvd  — generalized symmetric-definite eigenproblem
//
// Without CUDA/cuSolver, returns FULLMAG_FEM_ERR_UNAVAILABLE.

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && defined(FULLMAG_HAS_CUSOLVER)
#include <cusolverDn.h>
#include <cuda_runtime.h>

static void eigen_dense_set_reason(fullmag_fem_eigen_dense_desc *desc, const char *msg) {
    if (desc->out_reason != nullptr && desc->reason_len > 0) {
        std::snprintf(desc->out_reason, static_cast<size_t>(desc->reason_len), "%s", msg);
    }
}

int fullmag_fem_eigen_dense(fullmag_fem_eigen_dense_desc *desc) {
    if (desc == nullptr) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    const uint32_t n  = desc->n;
    const uint32_t ne = desc->n_eigenvalues;
    if (n == 0 || ne == 0 || ne > n) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: invalid dimensions (n=0 or n_eigenvalues>n)");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (desc->k_lower_col_major == nullptr || desc->m_lower_col_major == nullptr ||
        desc->out_eigenvalues == nullptr || desc->out_eigenvectors == nullptr) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: null pointer in descriptor");
        return FULLMAG_FEM_ERR_INVALID;
    }

    cusolverDnHandle_t solver_handle = nullptr;
    cusolverStatus_t status = cusolverDnCreate(&solver_handle);
    if (status != CUSOLVER_STATUS_SUCCESS) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cusolverDnCreate failed");
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // Allocate device memory for full n×n matrices.
    // cusolverDnDsygvd operates on cublasFillMode_t CUBLAS_FILL_MODE_LOWER.
    // We copy the full n*n buffer even though only the lower triangle is used.
    const size_t mat_bytes = static_cast<size_t>(n) * static_cast<size_t>(n) * sizeof(double);
    double *d_K = nullptr, *d_M = nullptr, *d_W = nullptr;
    cudaError_t cerr;
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_K), mat_bytes);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc K failed");
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_M), mat_bytes);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc M failed");
        cudaFree(d_K);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_W), static_cast<size_t>(n) * sizeof(double));
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc W failed");
        cudaFree(d_K); cudaFree(d_M);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // Copy matrices host → device.
    cerr = cudaMemcpy(d_K, desc->k_lower_col_major, mat_bytes, cudaMemcpyHostToDevice);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy K host->device failed");
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    cerr = cudaMemcpy(d_M, desc->m_lower_col_major, mat_bytes, cudaMemcpyHostToDevice);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy M host->device failed");
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // Query workspace size.
    int lwork = 0;
    status = cusolverDnDsygvd_bufferSize(
        solver_handle,
        CUSOLVER_EIG_TYPE_1,       // K * x = lambda * M * x
        CUSOLVER_EIG_MODE_VECTOR,  // compute eigenvectors
        CUBLAS_FILL_MODE_LOWER,
        static_cast<int>(n),
        d_K,
        static_cast<int>(n),
        d_M,
        static_cast<int>(n),
        d_W,
        &lwork
    );
    if (status != CUSOLVER_STATUS_SUCCESS) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cusolverDnDsygvd_bufferSize failed");
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    double *d_work = nullptr;
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_work), static_cast<size_t>(lwork) * sizeof(double));
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc work failed");
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    int *d_info = nullptr;
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_info), sizeof(int));
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc info failed");
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W); cudaFree(d_work);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // Solve: on exit d_K contains n eigenvectors in columns, d_W contains eigenvalues.
    status = cusolverDnDsygvd(
        solver_handle,
        CUSOLVER_EIG_TYPE_1,
        CUSOLVER_EIG_MODE_VECTOR,
        CUBLAS_FILL_MODE_LOWER,
        static_cast<int>(n),
        d_K,
        static_cast<int>(n),
        d_M,
        static_cast<int>(n),
        d_W,
        d_work,
        lwork,
        d_info
    );

    int h_info = 0;
    cudaMemcpy(&h_info, d_info, sizeof(int), cudaMemcpyDeviceToHost);
    cudaFree(d_info); cudaFree(d_work);

    if (status != CUSOLVER_STATUS_SUCCESS || h_info != 0) {
        char buf[128];
        std::snprintf(buf, sizeof(buf),
            "fullmag_fem_eigen_dense: cusolverDnDsygvd failed (status=%d, info=%d)",
            static_cast<int>(status), h_info);
        eigen_dense_set_reason(desc, buf);
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // Copy first n_eigenvalues eigenvalues back.
    cerr = cudaMemcpy(
        desc->out_eigenvalues, d_W,
        static_cast<size_t>(ne) * sizeof(double), cudaMemcpyDeviceToHost);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy eigenvalues device->host failed");
        cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // Copy first n_eigenvalues eigenvectors (columns 0..ne-1 of d_K, each column = n doubles).
    // d_K is n×n column-major; first ne columns occupy n*ne doubles starting at d_K[0].
    cerr = cudaMemcpy(
        desc->out_eigenvectors, d_K,
        static_cast<size_t>(n) * static_cast<size_t>(ne) * sizeof(double),
        cudaMemcpyDeviceToHost);

    cudaFree(d_K); cudaFree(d_M); cudaFree(d_W);
    cusolverDnDestroy(solver_handle);

    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy eigenvectors device->host failed");
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    if (desc->out_reason != nullptr && desc->reason_len > 0) {
        std::snprintf(desc->out_reason, static_cast<size_t>(desc->reason_len),
            "fullmag_fem_eigen_dense: solved %u×%u in cuSolverDN (Dsygvd)", n, n);
    }
    return FULLMAG_FEM_OK;
}

#else // No CUDA + cuSolver

int fullmag_fem_eigen_dense(fullmag_fem_eigen_dense_desc *desc) {
    static const char *kMsg =
        "fullmag_fem_eigen_dense: GPU dense eigensolver unavailable — "
        "rebuild with CUDA runtime and cuSolver support "
        "(FULLMAG_HAS_CUDA_RUNTIME + FULLMAG_HAS_CUSOLVER)";
    if (desc != nullptr && desc->out_reason != nullptr && desc->reason_len > 0) {
        std::snprintf(desc->out_reason, static_cast<size_t>(desc->reason_len), "%s", kMsg);
    }
    return FULLMAG_FEM_ERR_UNAVAILABLE;
}

#endif // FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_CUSOLVER

} // extern "C"
