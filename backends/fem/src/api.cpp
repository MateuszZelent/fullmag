/*
 * FEM C ABI facade source contract.
 *
 * This source owns the exported fullmag_fem_* ABI entrypoints, handle/global
 * error propagation, high-level backend lifetime calls, step/observe/state C
 * wrappers, and ABI-level unavailable-path errors. It does not own Context construction internals, MFEM runtime lifecycle, interaction physics, integrator stages, or transfer-audit policy.
 */

#include "fullmag_fem.h"

#include "backend_handle.hpp"
#include "context.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/runtime/availability.hpp"
#include "cpu/mfem/runtime/backend_lifecycle.hpp"
#include "cpu/mfem/runtime/backend_step.hpp"
#include "cpu/mfem/runtime/eigen_dense.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdio>
#include <cstring>
#include <string>

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
    if (!fullmag::fem::initialize_backend_runtime(handle->context, *plan, error)) {
        fullmag_fem_set_global_error(error);
        fullmag_fem_set_handle_error(handle, error);
        delete handle;
        return nullptr;
    }

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

    handle->last_error.clear();
    const int status =
        fullmag::fem::run_backend_step(
            handle->context,
            dt_seconds,
            *out_stats,
            handle->last_error);
    if (status != FULLMAG_FEM_OK && !handle->last_error.empty()) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
    }
    return status;
}

int fullmag_fem_backend_relax_step(
    fullmag_fem_backend *handle,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats *out_stats
) {
    if (handle == nullptr || out_stats == nullptr) {
        fullmag_fem_set_handle_error(
            handle,
            "fullmag_fem_backend_relax_step requires non-null handle and out_stats");
        return FULLMAG_FEM_ERR_INVALID;
    }

    handle->last_error.clear();
    const int status =
        fullmag::fem::run_backend_relaxation_step(
            handle->context,
            algorithm,
            *out_stats,
            handle->last_error);
    if (status != FULLMAG_FEM_OK && !handle->last_error.empty()) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
    }
    return status;
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
    fullmag::fem::set_interrupt_poll(handle->context, poll_fn, user_data);
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
    *out_audit = fullmag::fem::transfer_audit_snapshot(handle->context);
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
    *out_info = fullmag::fem::gpu_state_info(handle->context);
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
    const auto plan = fullmag::fem::gpu_rk_plan_device_resident(handle->context, reason);
    *out_info = {};
    out_info->exchange_only_enabled = plan.enabled ? 1 : 0;
    out_info->stage_count = plan.stage_count;
    out_info->uses_cuda_kernels = plan.uses_cuda_kernels ? 1 : 0;
    out_info->allows_exchange_host_sync = plan.allows_exchange_host_sync ? 1 : 0;
    out_info->stage_exchange_device_resident =
        plan.stage_exchange_device_resident ? 1 : 0;
    out_info->uses_gpu_poisson = plan.uses_gpu_poisson ? 1 : 0;
    std::snprintf(
        out_info->exchange_operator_mode,
        sizeof(out_info->exchange_operator_mode),
        "%s",
        plan.exchange_operator_mode != nullptr ? plan.exchange_operator_mode : "unsupported");
    std::snprintf(
        out_info->demag_operator_mode,
        sizeof(out_info->demag_operator_mode),
        "%s",
        plan.demag_operator_mode != nullptr ? plan.demag_operator_mode : "none");
    std::snprintf(
        out_info->hypre_execution_policy,
        sizeof(out_info->hypre_execution_policy),
        "%s",
        plan.hypre_execution_policy != nullptr ? plan.hypre_execution_policy : "none");
    std::snprintf(
        out_info->demag_residency,
        sizeof(out_info->demag_residency),
        "%s",
        plan.demag_residency != nullptr ? plan.demag_residency : "none");
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
        fullmag::fem::destroy_backend_runtime(handle->context);
    }
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
    if (!fullmag::fem::upload_magnetoelastic_strain(
            handle->context,
            strain_voigt,
            len,
            uniform != 0,
            handle->last_error)) {
        fullmag_fem_set_handle_error(handle, handle->last_error);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    return FULLMAG_FEM_OK;
}

int fullmag_fem_eigen_dense(fullmag_fem_eigen_dense_desc *desc) {
    return fullmag::fem::solve_dense_generalized_eigenproblem(desc);
}

} // extern "C"
