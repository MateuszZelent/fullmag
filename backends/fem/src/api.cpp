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
#include "frequency_domain/driven_response_solver.hpp"
#include "frequency_domain/frequency_domain_contract.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
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

fullmag_fem_frequency_domain_status to_abi_status(
    fullmag::fem::frequency_domain::FrequencyDomainStatus status)
{
    namespace fd = fullmag::fem::frequency_domain;
    switch (status) {
    case fd::FrequencyDomainStatus::ok:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
    case fd::FrequencyDomainStatus::unavailable:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE;
    case fd::FrequencyDomainStatus::validation_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
    case fd::FrequencyDomainStatus::operator_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    case fd::FrequencyDomainStatus::solve_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR;
    case fd::FrequencyDomainStatus::artifact_error:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR;
    case fd::FrequencyDomainStatus::interrupted:
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED;
    }
    return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
}

fullmag::fem::frequency_domain::FrequencyDomainStudyKind from_abi_study_kind(
    fullmag_fem_frequency_domain_study_kind study_kind)
{
    namespace fd = fullmag::fem::frequency_domain;
    switch (study_kind) {
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE:
        return fd::FrequencyDomainStudyKind::driven_frequency_response;
    case FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_EIGENMODES:
        return fd::FrequencyDomainStudyKind::modal_dynamic_matrix;
    }
    return fd::FrequencyDomainStudyKind::driven_frequency_response;
}

void copy_frequency_domain_progress(
    const fullmag::fem::frequency_domain::FrequencyDomainSweepProgress &native_progress,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
)
{
    *out_progress = {};
    out_progress->total_frequency_points = native_progress.total_frequency_points;
    out_progress->completed_frequency_points = native_progress.completed_frequency_points;
    out_progress->written_frequency_point_artifacts =
        native_progress.written_frequency_point_artifacts;
    out_progress->current_frequency_hz = native_progress.current_frequency_hz;
    out_progress->partial_artifacts_available =
        native_progress.partial_artifacts_available ? 1 : 0;
    std::snprintf(
        out_progress->latest_artifact_manifest_path,
        sizeof(out_progress->latest_artifact_manifest_path),
        "%s",
        native_progress.latest_artifact_manifest_path != nullptr
            ? native_progress.latest_artifact_manifest_path
            : "");
    std::snprintf(
        out_progress->progress_json,
        sizeof(out_progress->progress_json),
        "%s",
        native_progress.progress_json != nullptr ? native_progress.progress_json : "");
}

void copy_frequency_domain_solve_result(
    fullmag::fem::frequency_domain::DrivenFrequencyResponseSolveResult &native_result,
    fullmag_fem_frequency_domain_solve_result *out_result
)
{
    *out_result = {};
    out_result->status = to_abi_status(native_result.status);
    out_result->total_frequency_count = native_result.total_frequency_count;
    out_result->completed_frequency_count = native_result.completed_frequency_count;
    out_result->written_frequency_point_artifacts =
        native_result.written_frequency_point_artifacts;
    out_result->error_message = native_result.error_message;
    out_result->diagnostics_json = native_result.diagnostics_json;
    out_result->result_json = native_result.result_json;
    out_result->artifact_manifest_path = native_result.artifact_manifest_path;
    native_result.error_message = nullptr;
    native_result.diagnostics_json = nullptr;
    native_result.result_json = nullptr;
    native_result.artifact_manifest_path = nullptr;
}

bool frequency_domain_cancel_requested_from_c_abi(void *user_data) noexcept
{
    auto *request = static_cast<const fullmag_fem_frequency_domain_driven_response_request *>(user_data);
    return request != nullptr &&
        request->cancel_requested != nullptr &&
        request->cancel_requested(request->cancel_user_data) != 0;
}

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

int fullmag_fem_get_frequency_domain_availability_info(
    const fullmag_fem_frequency_domain_availability_request *request,
    fullmag_fem_frequency_domain_availability_info *out_info
) {
    if (request == nullptr || out_info == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_get_frequency_domain_availability_info requires non-null request and out_info");
        return FULLMAG_FEM_ERR_INVALID;
    }

    namespace fd = fullmag::fem::frequency_domain;
    fd::FrequencyDomainAvailabilityRequest native_request{};
    native_request.study_kind = from_abi_study_kind(request->study_kind);
    native_request.requires_driven_solver = request->requires_driven_solver != 0;
    native_request.requires_modal_solver = request->requires_modal_solver != 0;
    native_request.requires_floquet_boundary = request->requires_floquet_boundary != 0;
    native_request.requires_nonzero_k_dynamic_demag =
        request->requires_nonzero_k_dynamic_demag != 0;
    native_request.requires_gpu = request->requires_gpu != 0;
    native_request.strict_device = request->strict_device != 0;

    const fd::FrequencyDomainAvailabilityResult native_result =
        fd::frequency_domain_availability(native_request);

    *out_info = {};
    out_info->status = to_abi_status(native_result.status);
    out_info->driven_response_available =
        native_result.driven_response_available ? 1 : 0;
    out_info->modal_solver_available = native_result.modal_solver_available ? 1 : 0;
    out_info->floquet_modal_available = native_result.floquet_modal_available ? 1 : 0;
    out_info->floquet_response_available =
        native_result.floquet_response_available ? 1 : 0;
    out_info->dynamic_demag_k_available =
        native_result.dynamic_demag_k_available ? 1 : 0;
    out_info->gpu_available = native_result.gpu_available ? 1 : 0;
    std::snprintf(
        out_info->status_name,
        sizeof(out_info->status_name),
        "%s",
        fd::status_to_string(native_result.status));
    std::snprintf(
        out_info->study_kind_name,
        sizeof(out_info->study_kind_name),
        "%s",
        fd::study_kind_to_string(native_request.study_kind));
    std::snprintf(
        out_info->reason,
        sizeof(out_info->reason),
        "%s",
        native_result.error_message != nullptr ? native_result.error_message : "");
    std::snprintf(
        out_info->diagnostics_json,
        sizeof(out_info->diagnostics_json),
        "%s",
        native_result.diagnostics_json != nullptr ? native_result.diagnostics_json : "");
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_initial_sweep_progress(
    uint64_t total_frequency_points,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_initial_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::initial_sweep_progress(total_frequency_points);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_interrupted_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_interrupted_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::interrupted_sweep_progress(
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_cancelling_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_cancelling_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::cancelling_sweep_progress(
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_completed_sweep_progress(
    uint64_t total_frequency_points,
    uint64_t completed_frequency_points,
    uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path,
    fullmag_fem_frequency_domain_sweep_progress *out_progress
) {
    if (out_progress == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_completed_sweep_progress requires non-null out_progress");
        return FULLMAG_FEM_ERR_INVALID;
    }

    const auto native_progress =
        fullmag::fem::frequency_domain::completed_sweep_progress(
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path);
    copy_frequency_domain_progress(native_progress, out_progress);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_frequency_domain_solve_driven_response(
    const fullmag_fem_frequency_domain_driven_response_request *request,
    fullmag_fem_frequency_domain_solve_result *out_result
) {
    if (request == nullptr || out_result == nullptr) {
        fullmag_fem_set_global_error(
            "fullmag_fem_frequency_domain_solve_driven_response requires non-null request and out_result");
        return FULLMAG_FEM_ERR_INVALID;
    }

    namespace fd = fullmag::fem::frequency_domain;
    fd::DrivenFrequencyResponseSolveRequest native_request{};
    native_request.solve_request.operator_request.node_count = request->node_count;
    native_request.solve_request.operator_request.tangent_dof_count =
        request->tangent_dof_count;
    native_request.solve_request.operator_request.alpha = request->alpha;
    native_request.solve_request.operator_request.gamma0 = request->gamma0;
    native_request.solve_request.frequencies_hz = request->frequencies_hz;
    native_request.solve_request.frequency_count = request->frequency_count;
    native_request.solve_request.write_response_fields =
        request->write_response_fields != 0;
    native_request.output_directory = request->output_directory;
    native_request.write_partial_artifacts = request->write_partial_artifacts != 0;
    if (request->cancel_requested != nullptr) {
        native_request.cancel_requested = frequency_domain_cancel_requested_from_c_abi;
        native_request.cancel_user_data = const_cast<fullmag_fem_frequency_domain_driven_response_request *>(request);
    }
    native_request.tiny_validation_problem.enabled =
        request->tiny_validation_enabled != 0;
    native_request.tiny_validation_problem.tangent_dof_count =
        request->tiny_validation_tangent_dof_count;
    native_request.tiny_validation_problem.stiffness_matrix_row_major =
        request->tiny_validation_stiffness_matrix_row_major;
    native_request.tiny_validation_problem.mass_matrix_row_major =
        request->tiny_validation_mass_matrix_row_major;
    native_request.tiny_validation_problem.stiffness_diagonal =
        request->tiny_validation_stiffness_diagonal;
    native_request.tiny_validation_problem.mass_diagonal =
        request->tiny_validation_mass_diagonal;
    native_request.tiny_validation_problem.drive_real =
        request->tiny_validation_drive_real;

    fd::DrivenFrequencyResponseSolveResult native_result{};
    fd::solve_driven_frequency_response(native_request, &native_result);
    copy_frequency_domain_solve_result(native_result, out_result);
    fd::release_driven_frequency_response_result(&native_result);
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

void fullmag_fem_frequency_domain_solve_result_release(
    fullmag_fem_frequency_domain_solve_result *result
) {
    if (result == nullptr) {
        return;
    }
    delete[] result->error_message;
    delete[] result->diagnostics_json;
    delete[] result->result_json;
    delete[] result->artifact_manifest_path;
    *result = {};
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

int fullmag_fem_backend_set_step_profile(
    fullmag_fem_backend *handle,
    int enabled
) {
    if (handle == nullptr) {
        fullmag_fem_set_global_error("fullmag_fem_backend_set_step_profile received null handle");
        return FULLMAG_FEM_ERR_INVALID;
    }
    fullmag::fem::set_gpu_step_profile(handle->context, enabled != 0);
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
