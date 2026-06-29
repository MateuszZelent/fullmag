/*
 * frequency_domain_contract.cpp - native FEM frequency-domain contract tests.
 */

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/anisotropy_operator.hpp"
#include "frequency_domain/driven_response_solver.hpp"
#include "frequency_domain/equilibrium_state.hpp"
#include "frequency_domain/excitation.hpp"
#include "frequency_domain/operator_contract.hpp"
#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "frequency_domain/zeeman_operator.hpp"
#include "fullmag_fem.h"
#include "cpu/frequency_domain/mfem_exchange_operator.hpp"
#include "cpu/frequency_domain/mfem_dmi_operator.hpp"
#include "cpu/frequency_domain/mfem_driven_response_validation.hpp"
#include "cpu/frequency_domain/mfem_linearized_operator.hpp"
#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "cpu/frequency_domain/mfem_zeeman_operator.hpp"
#include "cpu/frequency_domain/production_cpu_driven_response.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <type_traits>
#include <utility>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

bool contains(const char *haystack, const char *needle)
{
    return std::strstr(haystack, needle) != nullptr;
}

std::string read_text_file(const char *path)
{
    std::ifstream input(path);
    check(input.good(), "expected text file is readable");
    return std::string(
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>());
}

bool file_exists(const char *path)
{
    FILE *input = std::fopen(path, "r");
    if (input == nullptr) {
        return false;
    }
    std::fclose(input);
    return true;
}

bool extract_m_complex_values(
    const std::string &json,
    double *values,
    std::size_t value_count)
{
    const std::size_t start = json.find("\"m_complex\":[");
    if (start == std::string::npos) {
        return false;
    }
    const char *cursor = json.c_str() + start;
    std::size_t count = 0;
    while (*cursor != '\0' && count < value_count) {
        char *end = nullptr;
        const double value = std::strtod(cursor, &end);
        if (end != cursor) {
            values[count++] = value;
            cursor = end;
        } else {
            ++cursor;
        }
    }
    return count == value_count;
}

bool nearly_equal(double lhs, double rhs, double tolerance)
{
    return std::fabs(lhs - rhs) <= tolerance;
}

std::uint64_t extract_json_u64(const char *json, const char *key)
{
    const char *position = std::strstr(json, key);
    check(position != nullptr, "expected JSON key is present");
    position = std::strchr(position, ':');
    check(position != nullptr, "expected JSON key has value separator");
    char *end = nullptr;
    const unsigned long long value = std::strtoull(position + 1, &end, 10);
    check(end != position + 1, "expected JSON unsigned integer value");
    return static_cast<std::uint64_t>(value);
}

double extract_json_double(const char *json, const char *key)
{
    const char *position = std::strstr(json, key);
    check(position != nullptr, "expected JSON key is present");
    position = std::strchr(position, ':');
    check(position != nullptr, "expected JSON key has value separator");
    char *end = nullptr;
    const double value = std::strtod(position + 1, &end);
    check(end != position + 1, "expected JSON floating-point value");
    return value;
}

long file_size_bytes(const char *path)
{
    FILE *input = std::fopen(path, "rb");
    check(input != nullptr, "expected binary file is readable");
    check(std::fseek(input, 0, SEEK_END) == 0, "expected binary file is seekable");
    const long size = std::ftell(input);
    std::fclose(input);
    return size;
}

struct CancelAfterFirstPoll {
    int poll_count = 0;
};

struct DiagonalProductionOperator {
    const double *stiffness = nullptr;
    const double *mass = nullptr;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t stiffness_call_count = 0;
    std::uint64_t mass_call_count = 0;
};

struct DemagTangentCallbackOperator {
    const double *matrix = nullptr;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t call_count = 0;
};

struct FirstKrylovApplyOnlyOperator {
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t stiffness_call_count = 0;
    std::uint64_t mass_call_count = 0;
};

struct ProductionProgressRecorder {
    std::uint64_t event_count = 0;
    std::uint64_t last_frequency_index = 0;
    std::uint64_t last_completed_frequency_count = 0;
    std::uint64_t last_total_frequency_count = 0;
    std::uint64_t last_iteration_count = 0;
    double last_frequency_hz = 0.0;
    double last_relative_residual_l2_norm = 0.0;
    bool saw_converged = false;
};

struct CancelAfterCompletedProductionPoint {
    bool cancel_requested = false;
};

struct CAbiProgressRecorder {
    std::uint64_t event_count = 0;
    std::uint64_t last_frequency_index = 0;
    std::uint64_t last_completed_frequency_count = 0;
    std::uint64_t last_total_frequency_count = 0;
    std::uint64_t last_iteration_count = 0;
    double last_frequency_hz = 0.0;
    double last_relative_residual_l2_norm = 0.0;
    bool saw_converged = false;
};

struct CAbiCancelAfterCompletedPoint {
    bool cancel_requested = false;
};

struct ScopedEnvVar {
    const char *name = nullptr;
    bool had_old_value = false;
    std::string old_value;

    ScopedEnvVar(const char *env_name, const char *value)
        : name(env_name)
    {
        const char *old = std::getenv(name);
        if (old != nullptr) {
            had_old_value = true;
            old_value = old;
        }
        setenv(name, value, 1);
    }

    ~ScopedEnvVar()
    {
        if (had_old_value) {
            setenv(name, old_value.c_str(), 1);
        } else {
            unsetenv(name);
        }
    }
};

fd::FrequencyDomainStatus apply_diagonal_stiffness(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<DiagonalProductionOperator *>(user_data);
    if (op == nullptr || op->stiffness == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing diagonal stiffness operator buffers");
        return fd::FrequencyDomainStatus::validation_error;
    }
    ++op->stiffness_call_count;
    for (std::uint64_t index = 0; index < op->tangent_dof_count; ++index) {
        out[index] = op->stiffness[index] * in[index];
    }
    return fd::FrequencyDomainStatus::ok;
}

fd::FrequencyDomainStatus apply_diagonal_mass(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<DiagonalProductionOperator *>(user_data);
    if (op == nullptr || op->mass == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing diagonal mass operator buffers");
        return fd::FrequencyDomainStatus::validation_error;
    }
    ++op->mass_call_count;
    for (std::uint64_t index = 0; index < op->tangent_dof_count; ++index) {
        out[index] = op->mass[index] * in[index];
    }
    return fd::FrequencyDomainStatus::ok;
}

fd::FrequencyDomainStatus apply_first_krylov_stiffness_then_zero(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<FirstKrylovApplyOnlyOperator *>(user_data);
    if (op == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing first-Krylov stiffness operator buffers");
        return fd::FrequencyDomainStatus::validation_error;
    }
    ++op->stiffness_call_count;
    for (std::uint64_t index = 0; index < op->tangent_dof_count; ++index) {
        out[index] = op->stiffness_call_count <= 2 ? in[index] : 0.0;
    }
    return fd::FrequencyDomainStatus::ok;
}

fd::FrequencyDomainStatus apply_zero_mass(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<FirstKrylovApplyOnlyOperator *>(user_data);
    if (op == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing zero mass operator buffers");
        return fd::FrequencyDomainStatus::validation_error;
    }
    ++op->mass_call_count;
    for (std::uint64_t index = 0; index < op->tangent_dof_count; ++index) {
        out[index] = 0.0;
    }
    return fd::FrequencyDomainStatus::ok;
}

fd::FrequencyDomainStatus apply_demag_tangent_callback(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<DemagTangentCallbackOperator *>(user_data);
    if (op == nullptr || op->matrix == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing demag tangent callback buffers");
        return fd::FrequencyDomainStatus::validation_error;
    }
    ++op->call_count;
    for (std::uint64_t row = 0; row < op->tangent_dof_count; ++row) {
        double value = 0.0;
        for (std::uint64_t column = 0; column < op->tangent_dof_count; ++column) {
            value += op->matrix[row * op->tangent_dof_count + column] * in[column];
        }
        out[row] = value;
    }
    return fd::FrequencyDomainStatus::ok;
}

bool cancel_after_first_poll(void *user_data)
{
    auto *state = static_cast<CancelAfterFirstPoll *>(user_data);
    ++state->poll_count;
    return state->poll_count > 2;
}

bool cancel_immediately(void *)
{
    return true;
}

bool cancel_after_completed_production_point(void *user_data)
{
    auto *state = static_cast<CancelAfterCompletedProductionPoint *>(user_data);
    return state != nullptr && state->cancel_requested;
}

fullmag_fem_frequency_domain_status c_abi_apply_diagonal_stiffness(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<DiagonalProductionOperator *>(user_data);
    if (op == nullptr || op->stiffness == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing C ABI diagonal stiffness operator buffers");
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
    }
    ++op->stiffness_call_count;
    for (std::uint64_t index = 0; index < op->tangent_dof_count; ++index) {
        out[index] = op->stiffness[index] * in[index];
    }
    return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
}

fullmag_fem_frequency_domain_status c_abi_apply_diagonal_mass(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<DiagonalProductionOperator *>(user_data);
    if (op == nullptr || op->mass == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing C ABI diagonal mass operator buffers");
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
    }
    ++op->mass_call_count;
    for (std::uint64_t index = 0; index < op->tangent_dof_count; ++index) {
        out[index] = op->mass[index] * in[index];
    }
    return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
}

fullmag_fem_frequency_domain_status c_abi_apply_demag_tangent(
    void *user_data,
    const double *in,
    double *out,
    char error_message[128])
{
    auto *op = static_cast<DemagTangentCallbackOperator *>(user_data);
    if (op == nullptr || op->matrix == nullptr || in == nullptr || out == nullptr) {
        std::snprintf(error_message, 128, "missing C ABI demag tangent callback buffers");
        return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR;
    }
    ++op->call_count;
    for (std::uint64_t row = 0; row < op->tangent_dof_count; ++row) {
        double value = 0.0;
        for (std::uint64_t column = 0; column < op->tangent_dof_count; ++column) {
            value += op->matrix[row * op->tangent_dof_count + column] * in[column];
        }
        out[row] = value;
    }
    return FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
}

void record_production_progress(
    void *user_data,
    const fd::ProductionCpuDrivenResponseProgress &progress)
{
    auto *recorder = static_cast<ProductionProgressRecorder *>(user_data);
    ++recorder->event_count;
    recorder->last_frequency_index = progress.frequency_index;
    recorder->last_completed_frequency_count = progress.completed_frequency_count;
    recorder->last_total_frequency_count = progress.total_frequency_count;
    recorder->last_iteration_count = progress.iteration_count;
    recorder->last_frequency_hz = progress.frequency_hz;
    recorder->last_relative_residual_l2_norm = progress.relative_residual_l2_norm;
    recorder->saw_converged = recorder->saw_converged || progress.converged;
}

void request_cancel_after_completed_production_point(
    void *user_data,
    const fd::ProductionCpuDrivenResponseProgress &progress)
{
    auto *state = static_cast<CancelAfterCompletedProductionPoint *>(user_data);
    if (state != nullptr && progress.completed_frequency_count >= 1) {
        state->cancel_requested = true;
    }
}

int c_abi_cancel_immediately(void *)
{
    return 1;
}

void c_abi_record_progress(
    void *user_data,
    const fullmag_fem_frequency_domain_progress *progress)
{
    auto *recorder = static_cast<CAbiProgressRecorder *>(user_data);
    check(progress != nullptr, "C ABI progress callback receives progress");
    ++recorder->event_count;
    recorder->last_frequency_index = progress->frequency_index;
    recorder->last_completed_frequency_count = progress->completed_frequency_count;
    recorder->last_total_frequency_count = progress->total_frequency_count;
    recorder->last_iteration_count = progress->iteration_count;
    recorder->last_frequency_hz = progress->frequency_hz;
    recorder->last_relative_residual_l2_norm = progress->relative_residual_l2_norm;
    recorder->saw_converged = recorder->saw_converged || progress->converged != 0;
}

int c_abi_cancel_after_completed_point(void *user_data)
{
    auto *state = static_cast<CAbiCancelAfterCompletedPoint *>(user_data);
    return state != nullptr && state->cancel_requested ? 1 : 0;
}

void c_abi_request_cancel_after_completed_point(
    void *user_data,
    const fullmag_fem_frequency_domain_progress *progress)
{
    auto *state = static_cast<CAbiCancelAfterCompletedPoint *>(user_data);
    if (state != nullptr &&
        progress != nullptr &&
        progress->completed_frequency_count >= 1) {
        state->cancel_requested = true;
    }
}

void fill_bulk_dmi_tetra_element(fd::MfemDmiElementTangentData &element, double d, double volume);

void enum_strings_are_stable()
{
    check(
        std::strcmp(fd::status_to_string(fd::FrequencyDomainStatus::ok), "ok") == 0,
        "ok status string is stable");
    check(
        std::strcmp(
            fd::status_to_string(fd::FrequencyDomainStatus::unavailable),
            "unavailable") == 0,
        "unavailable status string is stable");
    check(
        std::strcmp(
            fd::study_kind_to_string(fd::FrequencyDomainStudyKind::driven_frequency_response),
            "frequency_response") == 0,
        "driven response study kind string is stable");
    check(
        std::strcmp(
            fd::study_kind_to_string(fd::FrequencyDomainStudyKind::modal_dynamic_matrix),
            "eigenmodes") == 0,
        "modal study kind string is stable");
    check(
        static_cast<int>(FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T) == 0,
        "C ABI exp(+i omega t) phase convention discriminant is stable");
    check(
        static_cast<int>(FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T) == 1,
        "C ABI exp(-i omega t) phase convention discriminant is stable");
}

void availability_probe_is_noexcept()
{
    using Request = fd::FrequencyDomainAvailabilityRequest;
    static_assert(
        noexcept(fd::frequency_domain_availability(std::declval<const Request &>())),
        "frequency-domain availability probe must not throw across native boundaries");
    static_assert(
        noexcept(fd::initial_sweep_progress(0)),
        "frequency-domain progress initialization must not throw across native boundaries");
    static_assert(
        std::is_trivially_copyable_v<fd::FrequencyDomainAvailabilityResult>,
        "frequency-domain availability result must remain plain data");
    static_assert(
        std::is_trivially_copyable_v<fd::FrequencyDomainSweepProgress>,
        "frequency-domain sweep progress must remain plain data");
}

void initial_sweep_progress_reports_not_started_contract()
{
    const fd::FrequencyDomainSweepProgress progress = fd::initial_sweep_progress(37);

    check(progress.total_frequency_points == 37, "progress keeps total frequency count");
    check(progress.completed_frequency_points == 0, "progress starts with no completed points");
    check(
        progress.written_frequency_point_artifacts == 0,
        "progress starts with no written frequency-point artifacts");
    check(progress.current_frequency_hz == 0.0, "progress starts without active frequency");
    check(!progress.partial_artifacts_available, "initial progress has no partial artifacts");
    check(
        contains(progress.progress_json, "frequency_domain_sweep_progress.v1"),
        "progress JSON reports schema");
}

void interrupted_sweep_progress_preserves_partial_artifacts()
{
    const fd::FrequencyDomainSweepProgress progress =
        fd::interrupted_sweep_progress(9, 4, 4, 2.5e9, "frequency_domain/manifest.v1.json");

    check(progress.total_frequency_points == 9, "interrupted progress keeps total count");
    check(progress.completed_frequency_points == 4, "interrupted progress keeps completed count");
    check(
        progress.written_frequency_point_artifacts == 4,
        "interrupted progress keeps durable artifact count");
    check(progress.current_frequency_hz == 2.5e9, "interrupted progress keeps current frequency");
    check(progress.partial_artifacts_available, "interrupted progress exposes partial artifacts");
    check(
        contains(progress.latest_artifact_manifest_path, "manifest"),
        "interrupted progress keeps latest manifest path");
    check(contains(progress.progress_json, "interrupted"), "progress JSON reports interruption");
}

void interrupted_sweep_progress_reports_no_partial_artifacts_before_first_point()
{
    const fd::FrequencyDomainSweepProgress progress =
        fd::interrupted_sweep_progress(9, 0, 0, 0.0, "frequency_domain/manifest.v1.json");

    check(progress.total_frequency_points == 9, "pre-first interrupt keeps total count");
    check(progress.completed_frequency_points == 0, "pre-first interrupt has no completed points");
    check(
        progress.written_frequency_point_artifacts == 0,
        "pre-first interrupt has no durable point artifacts");
    check(!progress.partial_artifacts_available, "pre-first interrupt has no partial artifacts");
    check(contains(progress.progress_json, "interrupted"), "progress JSON reports interruption");
    check(
        contains(progress.progress_json, "\"partial_artifacts_available\":false"),
        "progress JSON reports no partial artifacts");
}

void cancelling_sweep_progress_preserves_cancel_request_state()
{
    const fd::FrequencyDomainSweepProgress progress =
        fd::cancelling_sweep_progress(9, 4, 4, 2.5e9, "frequency_domain/manifest.v1.json");

    check(progress.total_frequency_points == 9, "cancelling progress keeps total count");
    check(progress.completed_frequency_points == 4, "cancelling progress keeps completed count");
    check(
        progress.written_frequency_point_artifacts == 4,
        "cancelling progress keeps durable artifact count");
    check(progress.current_frequency_hz == 2.5e9, "cancelling progress keeps current frequency");
    check(progress.partial_artifacts_available, "cancelling progress exposes partial artifacts");
    check(
        contains(progress.latest_artifact_manifest_path, "manifest"),
        "cancelling progress keeps latest manifest path");
    check(
        contains(progress.progress_json, "cancel_requested"),
        "progress JSON reports cancel request before interruption");
}

void cancelling_sweep_progress_reports_no_partial_artifacts_before_first_point()
{
    const fd::FrequencyDomainSweepProgress progress =
        fd::cancelling_sweep_progress(9, 0, 0, 0.0, "frequency_domain/manifest.v1.json");

    check(progress.total_frequency_points == 9, "pre-first cancel keeps total count");
    check(progress.completed_frequency_points == 0, "pre-first cancel has no completed points");
    check(
        progress.written_frequency_point_artifacts == 0,
        "pre-first cancel has no durable point artifacts");
    check(!progress.partial_artifacts_available, "pre-first cancel has no partial artifacts");
    check(
        contains(progress.progress_json, "cancel_requested"),
        "progress JSON reports cancel request");
    check(
        contains(progress.progress_json, "\"partial_artifacts_available\":false"),
        "cancel JSON reports no partial artifacts");
}

void completed_sweep_progress_preserves_completed_artifacts()
{
    const fd::FrequencyDomainSweepProgress progress =
        fd::completed_sweep_progress(9, 9, 9, 8.5e9, "response/artifact_manifest.json");

    check(progress.total_frequency_points == 9, "completed progress keeps total count");
    check(progress.completed_frequency_points == 9, "completed progress keeps completed count");
    check(
        progress.written_frequency_point_artifacts == 9,
        "completed progress keeps durable artifact count");
    check(progress.current_frequency_hz == 8.5e9, "completed progress keeps final frequency");
    check(progress.partial_artifacts_available, "completed progress exposes written artifacts");
    check(
        contains(progress.latest_artifact_manifest_path, "artifact_manifest"),
        "completed progress keeps manifest path");
    check(contains(progress.progress_json, "completed"), "progress JSON reports completion");
}

void driven_response_cpu_slice_is_available()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(result.status == fd::FrequencyDomainStatus::ok, "driven CPU status is available");
    check(!fd::status_is_error(result.status), "available driven CPU status is not an error");
    check(result.driven_response_available, "driven response CPU slice is marked available");
    check(!result.modal_solver_available, "modal solver is not marked available");
    check(
        result.static_periodic_response_available,
        "static-periodic response CPU slice is marked available");
    check(result.error_message[0] == '\0', "available driven response has no error reason");
    check(
        contains(result.diagnostics_json, "frequency_domain_availability.v1"),
        "diagnostics schema is reported");
    check(
        contains(result.diagnostics_json, "\"driven_response_available\":true"),
        "diagnostics mark driven response available");
    check(
        contains(result.diagnostics_json, "gamma_free_or_static_periodic_magnetic_response"),
        "diagnostics identify the limited CPU response scope");
}

void static_periodic_driven_response_is_explicitly_available()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;
    request.requires_static_periodic_boundary = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(
        result.status == fd::FrequencyDomainStatus::ok,
        "static-periodic driven response status is available");
    check(result.driven_response_available, "static-periodic response keeps driven response available");
    check(
        result.static_periodic_response_available,
        "static-periodic response capability is marked available");
    check(
        contains(result.diagnostics_json, "\"static_periodic_response_available\":true"),
        "diagnostics mark static-periodic response available");
}

void driven_response_solver_accepts_fmr_env_aliases_source_contract()
{
    const std::string source =
        read_text_file("backends/fem/src/frequency_domain/driven_response_solver.cpp");

    check(
        contains(source.c_str(), "env_positive_double_alias"),
        "driven response solver keeps double env alias helper");
    check(
        contains(source.c_str(), "env_positive_u64_alias"),
        "driven response solver keeps u64 env alias helper");
    check(
        contains(source.c_str(), "FULLMAG_FMR_RESPONSE_RTOL"),
        "driven response solver accepts FMR rtol alias");
    check(
        contains(source.c_str(), "FULLMAG_FMR_RESPONSE_MAX_ITERATIONS"),
        "driven response solver accepts FMR max-iterations alias");
    check(
        contains(source.c_str(), "FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS"),
        "driven response solver accepts FMR restart-iterations alias");
}

void driven_response_floquet_boundary_is_explicitly_unavailable()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;
    request.requires_floquet_boundary = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(
        result.status == fd::FrequencyDomainStatus::unavailable,
        "Floquet driven response status is unavailable");
    check(!result.driven_response_available, "Floquet response is not marked available");
    check(!result.floquet_response_available, "Floquet response capability remains false");
    check(contains(result.error_message, "Floquet"), "unavailable reason names Floquet");
}

void driven_response_floquet_k_metadata_is_explicitly_unavailable()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(
        result.status == fd::FrequencyDomainStatus::unavailable,
        "Floquet k-vector metadata status is unavailable");
    check(!result.floquet_response_available, "Floquet response capability remains false");
    check(contains(result.error_message, "Floquet/Bloch"), "unavailable reason names Floquet/Bloch");
    check(contains(result.error_message, "nonzero-k"), "unavailable reason names nonzero-k");
}

void driven_response_gamma_floquet_k_metadata_keeps_response_available()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 0.0;
    request.floquet_k_vector_rad_per_m[1] = 0.0;
    request.floquet_k_vector_rad_per_m[2] = 0.0;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(
        result.status == fd::FrequencyDomainStatus::ok,
        "gamma-Floquet k metadata keeps driven response available");
    check(result.driven_response_available, "gamma-Floquet keeps driven response capability");
    check(
        !contains(result.error_message, "nonzero-k"),
        "gamma-Floquet availability does not claim nonzero-k");
}

void modal_solver_is_explicitly_unavailable()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::modal_dynamic_matrix;
    request.requires_modal_solver = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(result.status == fd::FrequencyDomainStatus::unavailable, "modal status is unavailable");
    check(!result.modal_solver_available, "modal solver is not marked available");
    check(contains(result.error_message, "modal"), "modal unavailable reason names solver");
}

void floquet_dynamic_demag_k_is_blocked()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::modal_dynamic_matrix;
    request.requires_floquet_boundary = true;
    request.requires_nonzero_k_dynamic_demag = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(
        result.status == fd::FrequencyDomainStatus::unavailable,
        "nonzero-k dynamic demag status is unavailable");
    check(!result.dynamic_demag_k_available, "dynamic demag-k is not marked available");
    check(contains(result.error_message, "nonzero-k"), "unavailable reason names nonzero-k");
    check(contains(result.error_message, "dynamic demag"), "unavailable reason names demag-k");
}

void strict_gpu_lane_reports_no_demag_capability_when_cuda_runtime_is_available()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;
    request.requires_gpu = true;
    request.strict_device = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

#if FULLMAG_HAS_CUDA_RUNTIME
    check(result.status == fd::FrequencyDomainStatus::ok, "strict GPU no-demag response is available");
    check(result.driven_response_available, "strict GPU marks driven response available");
    check(result.gpu_available, "strict GPU lane is marked available");
    check(
        contains(result.diagnostics_json, "\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\""),
        "strict GPU availability diagnostics report GPU lane");
    check(
        !result.static_periodic_response_available,
        "strict GPU availability does not advertise static-periodic projection");
#else
    check(result.status == fd::FrequencyDomainStatus::unavailable, "strict GPU is unavailable without CUDA runtime");
    check(!result.gpu_available, "GPU lane is not marked available");
    check(contains(result.error_message, "GPU"), "unavailable reason names GPU lane");
#endif
}

void strict_gpu_static_periodic_response_is_available_when_cuda_runtime_is_available()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;
    request.requires_gpu = true;
    request.strict_device = true;
    request.requires_static_periodic_boundary = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

#if FULLMAG_HAS_CUDA_RUNTIME
    check(
        result.status == fd::FrequencyDomainStatus::ok,
        "strict GPU static-periodic response is available with CUDA runtime");
    check(result.gpu_available, "strict GPU static-periodic marks GPU available");
    check(
        result.static_periodic_response_available,
        "strict GPU static-periodic capability is advertised");
    check(
        contains(result.diagnostics_json, "\"static_periodic_response_available\":true"),
        "strict GPU static-periodic diagnostics advertise static-periodic support");
    check(
        contains(result.diagnostics_json, "\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\""),
        "strict GPU static-periodic diagnostics report GPU frequency-domain lane");
#else
    check(
        result.status == fd::FrequencyDomainStatus::unavailable,
        "strict GPU static-periodic response is unavailable without CUDA runtime");
    check(!result.static_periodic_response_available, "GPU static-periodic capability remains false");
    check(contains(result.error_message, "static-periodic"), "GPU static-periodic reason names projection");
#endif
}

void c_abi_reports_frequency_domain_availability()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE;
    request.requires_driven_solver = 1;

    fullmag_fem_frequency_domain_availability_info info{};
    const int status =
        fullmag_fem_get_frequency_domain_availability_info(&request, &info);

    check(status == FULLMAG_FEM_OK, "C ABI frequency-domain availability query succeeds");
    check(
        info.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI reports available status");
    check(
        std::strcmp(info.status_name, "ok") == 0,
        "C ABI reports status string");
    check(
        std::strcmp(info.study_kind_name, "frequency_response") == 0,
        "C ABI reports study kind string");
    check(
        info.driven_response_available == 1,
        "C ABI marks driven response CPU slice available");
    check(
        info.static_periodic_response_available == 1,
        "C ABI marks static-periodic response CPU slice available");
    check(info.reason[0] == '\0', "C ABI reports no reason for available driven response");
    check(
        contains(info.diagnostics_json, "frequency_domain_availability.v1"),
        "C ABI diagnostics JSON reports schema");
    check(
        contains(info.diagnostics_json, "\"driven_response_available\":true"),
        "C ABI diagnostics mark driven response available");
    check(
        contains(info.diagnostics_json, "\"static_periodic_response_available\":true"),
        "C ABI diagnostics mark static-periodic response available");
}

void c_abi_reports_floquet_k_metadata_as_unavailable()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE;
    request.requires_driven_solver = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T;

    fullmag_fem_frequency_domain_availability_info info{};
    const int status =
        fullmag_fem_get_frequency_domain_availability_info(&request, &info);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet availability query succeeds");
    check(
        info.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI Floquet metadata reports unavailable status");
    check(info.floquet_response_available == 0, "C ABI Floquet response capability remains false");
    check(contains(info.reason, "Floquet/Bloch"), "C ABI Floquet unavailable reason names Floquet/Bloch");
    check(contains(info.reason, "nonzero-k"), "C ABI Floquet unavailable reason names nonzero-k");
}

void c_abi_reports_gamma_floquet_k_metadata_as_available_static_periodic()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE;
    request.requires_driven_solver = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 0.0;
    request.floquet_k_vector_rad_per_m[1] = 0.0;
    request.floquet_k_vector_rad_per_m[2] = 0.0;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T;

    fullmag_fem_frequency_domain_availability_info info{};
    const int status =
        fullmag_fem_get_frequency_domain_availability_info(&request, &info);

    check(status == FULLMAG_FEM_OK, "C ABI gamma-Floquet availability query succeeds");
    check(
        info.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI gamma-Floquet metadata reports ok status");
    check(info.driven_response_available == 1, "C ABI gamma-Floquet keeps driven response available");
    check(
        contains(info.diagnostics_json, "\"static_periodic_response_available\":true"),
        "C ABI gamma-Floquet diagnostics mark static-periodic response available");
    check(!contains(info.reason, "nonzero-k"), "C ABI gamma-Floquet reason does not name nonzero-k");
}

void c_abi_reports_strict_gpu_no_demag_availability()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE;
    request.requires_driven_solver = 1;
    request.requires_gpu = 1;
    request.strict_device = 1;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T;

    fullmag_fem_frequency_domain_availability_info info{};
    const int status =
        fullmag_fem_get_frequency_domain_availability_info(&request, &info);

    check(status == FULLMAG_FEM_OK, "C ABI strict GPU availability query succeeds");
#if FULLMAG_HAS_CUDA_RUNTIME
    check(
        info.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI strict GPU no-demag response reports ok");
    check(info.driven_response_available == 1, "C ABI strict GPU marks driven response available");
    check(info.gpu_available == 1, "C ABI strict GPU marks GPU available");
    check(
        contains(info.diagnostics_json, "\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\""),
        "C ABI strict GPU diagnostics report GPU lane");
#else
    check(
        info.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI strict GPU response is unavailable without CUDA runtime");
    check(info.gpu_available == 0, "C ABI strict GPU remains unavailable without CUDA runtime");
#endif
}

void c_abi_frequency_domain_availability_rejects_unknown_study_kind()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = static_cast<fullmag_fem_frequency_domain_study_kind>(99);
    request.requires_driven_solver = 1;

    fullmag_fem_frequency_domain_availability_info info{};
    const int status =
        fullmag_fem_get_frequency_domain_availability_info(&request, &info);

    check(
        status == FULLMAG_FEM_ERR_INVALID,
        "C ABI availability rejects unknown study kind");
}

void c_abi_frequency_domain_availability_rejects_unknown_phase_convention()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE;
    request.requires_driven_solver = 1;
    request.phase_convention =
        static_cast<fullmag_fem_frequency_domain_phase_convention>(99);

    fullmag_fem_frequency_domain_availability_info info{};
    const int status =
        fullmag_fem_get_frequency_domain_availability_info(&request, &info);

    check(
        status == FULLMAG_FEM_ERR_INVALID,
        "C ABI availability rejects unknown phase convention");
}

void c_abi_rejects_null_arguments()
{
    fullmag_fem_frequency_domain_availability_request request{};
    request.study_kind = FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_EIGENMODES;

    fullmag_fem_frequency_domain_availability_info info{};
    check(
        fullmag_fem_get_frequency_domain_availability_info(nullptr, &info) ==
            FULLMAG_FEM_ERR_INVALID,
        "C ABI rejects null frequency-domain request");
    check(
        fullmag_fem_get_frequency_domain_availability_info(&request, nullptr) ==
            FULLMAG_FEM_ERR_INVALID,
        "C ABI rejects null frequency-domain output");
    check(
        fullmag_fem_frequency_domain_initial_sweep_progress(1, nullptr) ==
            FULLMAG_FEM_ERR_INVALID,
        "C ABI rejects null initial progress output");
    check(
        fullmag_fem_frequency_domain_interrupted_sweep_progress(
            3,
            1,
            1,
            1.0e9,
            "frequency_domain/manifest.v1.json",
            nullptr) == FULLMAG_FEM_ERR_INVALID,
        "C ABI rejects null interrupted progress output");
    check(
        fullmag_fem_frequency_domain_cancelling_sweep_progress(
            3,
            1,
            1,
            1.0e9,
            "frequency_domain/manifest.v1.json",
            nullptr) == FULLMAG_FEM_ERR_INVALID,
        "C ABI rejects null cancelling progress output");
    check(
        fullmag_fem_frequency_domain_completed_sweep_progress(
            3,
            3,
            3,
            1.0e9,
            "response/artifact_manifest.json",
            nullptr) == FULLMAG_FEM_ERR_INVALID,
        "C ABI rejects null completed progress output");
}

void c_abi_reports_frequency_domain_progress()
{
    fullmag_fem_frequency_domain_sweep_progress initial{};
    check(
        fullmag_fem_frequency_domain_initial_sweep_progress(11, &initial) ==
            FULLMAG_FEM_OK,
        "C ABI initial progress query succeeds");
    check(initial.total_frequency_points == 11, "C ABI initial progress keeps total");
    check(initial.completed_frequency_points == 0, "C ABI initial progress starts empty");
    check(initial.partial_artifacts_available == 0, "C ABI initial progress has no partials");
    check(
        contains(initial.progress_json, "not_started"),
        "C ABI initial progress JSON reports not started");

    fullmag_fem_frequency_domain_sweep_progress interrupted{};
    check(
        fullmag_fem_frequency_domain_interrupted_sweep_progress(
            11,
            3,
            3,
            4.2e9,
            "frequency_domain/manifest.v1.json",
            &interrupted) == FULLMAG_FEM_OK,
        "C ABI interrupted progress query succeeds");
    check(interrupted.total_frequency_points == 11, "C ABI interrupted progress keeps total");
    check(
        interrupted.completed_frequency_points == 3,
        "C ABI interrupted progress keeps completed count");
    check(
        interrupted.written_frequency_point_artifacts == 3,
        "C ABI interrupted progress keeps written artifact count");
    check(
        interrupted.partial_artifacts_available == 1,
        "C ABI interrupted progress exposes partial artifacts");
    check(
        contains(interrupted.latest_artifact_manifest_path, "manifest"),
        "C ABI interrupted progress keeps manifest path");
    check(
        contains(interrupted.progress_json, "interrupted"),
        "C ABI interrupted progress JSON reports interrupted");

    fullmag_fem_frequency_domain_sweep_progress pre_first_interrupted{};
    check(
        fullmag_fem_frequency_domain_interrupted_sweep_progress(
            11,
            0,
            0,
            0.0,
            "frequency_domain/manifest.v1.json",
            &pre_first_interrupted) == FULLMAG_FEM_OK,
        "C ABI pre-first interrupted progress query succeeds");
    check(
        pre_first_interrupted.partial_artifacts_available == 0,
        "C ABI pre-first interrupted progress exposes no partial artifacts");
    check(
        contains(pre_first_interrupted.progress_json, "\"partial_artifacts_available\":false"),
        "C ABI pre-first interrupted progress JSON reports no partials");

    fullmag_fem_frequency_domain_sweep_progress cancelling{};
    check(
        fullmag_fem_frequency_domain_cancelling_sweep_progress(
            11,
            3,
            3,
            4.2e9,
            "frequency_domain/manifest.v1.json",
            &cancelling) == FULLMAG_FEM_OK,
        "C ABI cancelling progress query succeeds");
    check(cancelling.total_frequency_points == 11, "C ABI cancelling progress keeps total");
    check(
        cancelling.completed_frequency_points == 3,
        "C ABI cancelling progress keeps completed count");
    check(
        cancelling.written_frequency_point_artifacts == 3,
        "C ABI cancelling progress keeps written artifact count");
    check(
        cancelling.partial_artifacts_available == 1,
        "C ABI cancelling progress exposes partial artifacts");
    check(
        contains(cancelling.latest_artifact_manifest_path, "manifest"),
        "C ABI cancelling progress keeps manifest path");
    check(
        contains(cancelling.progress_json, "cancel_requested"),
        "C ABI cancelling progress JSON reports cancel request");

    fullmag_fem_frequency_domain_sweep_progress pre_first_cancelling{};
    check(
        fullmag_fem_frequency_domain_cancelling_sweep_progress(
            11,
            0,
            0,
            0.0,
            "frequency_domain/manifest.v1.json",
            &pre_first_cancelling) == FULLMAG_FEM_OK,
        "C ABI pre-first cancelling progress query succeeds");
    check(
        pre_first_cancelling.partial_artifacts_available == 0,
        "C ABI pre-first cancelling progress exposes no partial artifacts");
    check(
        contains(pre_first_cancelling.progress_json, "\"partial_artifacts_available\":false"),
        "C ABI pre-first cancelling progress JSON reports no partials");

    fullmag_fem_frequency_domain_sweep_progress completed{};
    check(
        fullmag_fem_frequency_domain_completed_sweep_progress(
            11,
            11,
            11,
            5.5e9,
            "response/artifact_manifest.json",
            &completed) == FULLMAG_FEM_OK,
        "C ABI completed progress query succeeds");
    check(completed.total_frequency_points == 11, "C ABI completed progress keeps total");
    check(
        completed.completed_frequency_points == 11,
        "C ABI completed progress keeps completed count");
    check(
        completed.written_frequency_point_artifacts == 11,
        "C ABI completed progress keeps written artifact count");
    check(
        completed.partial_artifacts_available == 1,
        "C ABI completed progress exposes artifacts");
    check(
        contains(completed.latest_artifact_manifest_path, "artifact_manifest"),
        "C ABI completed progress keeps manifest path");
    check(
        contains(completed.progress_json, "completed"),
        "C ABI completed progress JSON reports completed");
}

void tangent_frame_builds_orthonormal_basis_and_projects_vectors()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::build_tangent_frame(equilibrium, 2, nodes, &diagnostics);
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);

    check(status == fd::FrequencyDomainStatus::ok, "tangent frame build succeeds");
    check(shape.node_count == 2, "tangent workspace keeps node count");
    check(shape.full_dof_count == 6, "tangent workspace reports full-space DOFs");
    check(shape.tangent_dof_count == 4, "tangent workspace reports tangent-space DOFs");
    check(diagnostics.node_count == 2, "tangent diagnostics keep node count");
    check(diagnostics.max_norm_error < 1.0e-12, "equilibrium vectors are unit length");
    for (const fd::TangentFrameNode &node : nodes) {
        check(std::abs(fd::dot3(node.m, node.e1)) < 1.0e-12, "e1 is tangent to m");
        check(std::abs(fd::dot3(node.m, node.e2)) < 1.0e-12, "e2 is tangent to m");
        check(std::abs(fd::dot3(node.e1, node.e2)) < 1.0e-12, "tangent basis is orthogonal");
        check(std::abs(fd::dot3(node.e1, node.e1) - 1.0) < 1.0e-12, "e1 is unit length");
        check(std::abs(fd::dot3(node.e2, node.e2) - 1.0) < 1.0e-12, "e2 is unit length");
    }

    const double full_delta[] = {
        2.0, -3.0, 9.0,
        4.0, 5.0, 6.0,
    };
    double tangent_delta[4]{};
    double lifted_delta[6]{};

    fd::project_full_to_tangent(nodes, full_delta, 2, tangent_delta);
    const fd::TangentProjectionDiagnostics projection_diagnostics =
        fd::diagnose_tangent_projection(nodes, full_delta, 2);
    fd::lift_tangent_to_full(nodes, tangent_delta, 2, lifted_delta);

    check(
        projection_diagnostics.node_count == 2,
        "projection diagnostics keep node count");
    check(
        projection_diagnostics.max_normal_component_abs == 9.0,
        "projection diagnostics report removed normal component");
    check(
        projection_diagnostics.max_roundtrip_error < 1.0e-12,
        "projection diagnostics report exact tangent roundtrip");
    for (std::uint64_t node_index = 0; node_index < 2; ++node_index) {
        const double *m = nodes[node_index].m;
        const double *lifted = lifted_delta + node_index * 3;
        check(std::abs(fd::dot3(m, lifted)) < 1.0e-12, "lifted perturbation stays tangent");
    }
    check(
        std::abs(lifted_delta[0] - 2.0) < 1.0e-12 &&
            std::abs(lifted_delta[1] + 3.0) < 1.0e-12 &&
            std::abs(lifted_delta[2]) < 1.0e-12,
        "projection removes normal component for z equilibrium");
    check(
        std::abs(lifted_delta[3]) < 1.0e-12 &&
            std::abs(lifted_delta[4] - 5.0) < 1.0e-12 &&
            std::abs(lifted_delta[5] - 6.0) < 1.0e-12,
        "projection removes normal component for x equilibrium");
}

void tangent_frame_rejects_non_unit_equilibrium()
{
    const double equilibrium[] = {0.0, 0.0, 0.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::build_tangent_frame(equilibrium, 1, &node, &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "tangent frame rejects zero equilibrium");
    check(diagnostics.max_norm_error > 0.9, "diagnostics report norm error");
    check(contains(diagnostics.error_message, "unit"), "diagnostics explain unit-vector rejection");
}

void tangent_operator_applies_local_blocks_and_reports_diagnostics()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);
    const fd::TangentOperatorLocalBlock terms[] = {
        {
            fd::FrequencyDomainOperatorTermKind::zeeman,
            2.0,
            0.5,
            -0.5,
            2.0,
        },
        {
            fd::FrequencyDomainOperatorTermKind::local_anisotropy,
            1.0,
            0.0,
            0.0,
            -1.0,
        },
    };
    const double tangent_in[] = {
        1.0, 2.0,
        -3.0, 4.0,
    };
    double tangent_out[4]{};
    fd::TangentOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_local_operator(
        terms,
        2,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "tangent operator application succeeds");
    check(diagnostics.node_count == 2, "operator diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "operator diagnostics keep tangent DOFs");
    check(diagnostics.applied_term_count == 2, "operator diagnostics keep term count");
    check(diagnostics.max_abs_output == 7.0, "operator diagnostics report max output");
    check(std::abs(tangent_out[0] - 4.0) < 1.0e-12, "operator output[0] matches local block");
    check(std::abs(tangent_out[1] - 1.5) < 1.0e-12, "operator output[1] matches local block");
    check(std::abs(tangent_out[2] + 7.0) < 1.0e-12, "operator output[2] matches local block");
    check(std::abs(tangent_out[3] - 5.5) < 1.0e-12, "operator output[3] matches local block");
}

void tangent_operator_rejects_unsupported_terms()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(1);
    const fd::TangentOperatorLocalBlock term{
        fd::FrequencyDomainOperatorTermKind::demag_nonlocal,
        1.0,
        0.0,
        0.0,
        1.0,
    };
    const double tangent_in[] = {1.0, 0.0};
    double tangent_out[2]{};
    fd::TangentOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_local_operator(
        &term,
        1,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::operator_error,
        "local tangent operator rejects unsupported nonlocal demag term");
    check(diagnostics.unsupported_term_count == 1, "diagnostics count unsupported terms");
    check(contains(diagnostics.error_message, "unsupported"), "diagnostics explain rejection");
}

void tangent_operator_rejects_nonfinite_local_block_coefficients()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(1);
    const fd::TangentOperatorLocalBlock term{
        fd::FrequencyDomainOperatorTermKind::zeeman,
        std::numeric_limits<double>::infinity(),
        0.0,
        0.0,
        1.0,
    };
    const double tangent_in[] = {1.0, 0.0};
    double tangent_out[2]{};
    fd::TangentOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_local_operator(
        &term,
        1,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "local tangent operator rejects non-finite block coefficients");
    check(
        contains(diagnostics.error_message, "finite"),
        "local tangent operator explains finite block coefficient requirement");
    check(tangent_out[0] == 0.0 && tangent_out[1] == 0.0, "local non-finite block leaves output untouched");
}

void zeeman_tangent_block_uses_parallel_field_and_reports_transverse_residual()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "Zeeman test frame build succeeds");

    const double h0[] = {0.0, 0.0, 3.0};
    const double h1[] = {-2.0, 4.0, 0.0};
    fd::TangentOperatorLocalBlock blocks[2]{};
    fd::ZeemanTangentOperatorDiagnostics diagnostics{};

    check(
        fd::build_zeeman_tangent_blocks(nodes, h0, 1, blocks, &diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "Zeeman tangent block for z equilibrium succeeds");
    check(blocks[0].kind == fd::FrequencyDomainOperatorTermKind::zeeman, "Zeeman block kind");
    check(std::abs(blocks[0].a00 + 3.0) < 1.0e-12, "Zeeman z block a00");
    check(std::abs(blocks[0].a11 + 3.0) < 1.0e-12, "Zeeman z block a11");
    check(std::abs(blocks[0].a01) < 1.0e-12, "Zeeman z block a01");
    check(std::abs(blocks[0].a10) < 1.0e-12, "Zeeman z block a10");
    check(diagnostics.node_count == 1, "Zeeman diagnostics node count");
    check(diagnostics.max_transverse_field_abs < 1.0e-12, "parallel field has no transverse residual");

    check(
        fd::build_zeeman_tangent_blocks(nodes + 1, h1, 1, blocks + 1, &diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "Zeeman tangent block for x equilibrium succeeds");
    check(std::abs(blocks[1].a00 - 2.0) < 1.0e-12, "Zeeman x block a00");
    check(std::abs(blocks[1].a11 - 2.0) < 1.0e-12, "Zeeman x block a11");
    check(
        std::abs(diagnostics.max_transverse_field_abs - 4.0) < 1.0e-12,
        "Zeeman diagnostics report transverse field residual");

    const double tangent_in[] = {2.0, -1.0, 3.0, 4.0};
    double tangent_out[4]{};
    fd::TangentOperatorDiagnostics operator_diagnostics{};
    check(
        fd::apply_tangent_nodewise_operator(
            blocks,
            tangent_in,
            fd::tangent_workspace_shape(2),
            tangent_out,
            &operator_diagnostics) == fd::FrequencyDomainStatus::ok,
        "Zeeman blocks apply through tangent local operator");
    check(std::abs(tangent_out[0] + 6.0) < 1.0e-12, "Zeeman output node0 e1");
    check(std::abs(tangent_out[1] - 3.0) < 1.0e-12, "Zeeman output node0 e2");
    check(std::abs(tangent_out[2] - 6.0) < 1.0e-12, "Zeeman output node1 e1");
    check(std::abs(tangent_out[3] - 8.0) < 1.0e-12, "Zeeman output node1 e2");
}

void zeeman_tangent_block_rejects_nonfinite_external_field()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "Zeeman non-finite field test frame build succeeds");

    const double h_ext_a_per_m[] = {0.0, 0.0, std::numeric_limits<double>::infinity()};
    fd::TangentOperatorLocalBlock block{};
    fd::ZeemanTangentOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::build_zeeman_tangent_blocks(&node, h_ext_a_per_m, 1, &block, &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "Zeeman tangent block rejects non-finite external field");
    check(contains(diagnostics.error_message, "finite"), "Zeeman non-finite field rejection explains finite field requirement");
}

void uniaxial_anisotropy_tangent_blocks_project_axis_into_tangent_space()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "uniaxial anisotropy test frame succeeds");

    const double axis[] = {1.0, 1.0, 0.0};
    fd::TangentOperatorLocalBlock block{};
    fd::UniaxialAnisotropyTangentOperatorDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status = fd::build_uniaxial_anisotropy_tangent_blocks(
        &node,
        axis,
        4.0,
        1,
        &block,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "uniaxial anisotropy tangent block succeeds");
    check(
        block.kind == fd::FrequencyDomainOperatorTermKind::local_anisotropy,
        "uniaxial anisotropy block kind");
    check(std::abs(block.a00 - 2.0) < 1.0e-12, "uniaxial anisotropy block a00");
    check(std::abs(block.a01 - 2.0) < 1.0e-12, "uniaxial anisotropy block a01");
    check(std::abs(block.a10 - 2.0) < 1.0e-12, "uniaxial anisotropy block a10");
    check(std::abs(block.a11 - 2.0) < 1.0e-12, "uniaxial anisotropy block a11");
    check(
        std::abs(diagnostics.max_abs_block_coeff - 2.0) < 1.0e-12,
        "uniaxial anisotropy diagnostics report max coeff");
}

void exchange_edge_operator_applies_tangent_graph_laplacian()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        2.0,
    };
    const double tangent_in[] = {
        1.0, 2.0,
        -3.0, 4.0,
    };
    double tangent_out[4]{};
    fd::TangentEdgeOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::apply_tangent_edge_operator(&edge, 1, tangent_in, shape, tangent_out, &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "exchange edge operator succeeds");
    check(diagnostics.node_count == 2, "exchange diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "exchange diagnostics keep tangent DOFs");
    check(diagnostics.edge_count == 1, "exchange diagnostics keep edge count");
    check(diagnostics.invalid_edge_count == 0, "exchange diagnostics report no invalid edges");
    check(diagnostics.max_abs_output == 8.0, "exchange diagnostics report max output");
    check(std::abs(tangent_out[0] - 8.0) < 1.0e-12, "exchange output node0 e1");
    check(std::abs(tangent_out[1] + 4.0) < 1.0e-12, "exchange output node0 e2");
    check(std::abs(tangent_out[2] + 8.0) < 1.0e-12, "exchange output node1 e1");
    check(std::abs(tangent_out[3] - 4.0) < 1.0e-12, "exchange output node1 e2");
}

void exchange_edge_operator_rejects_out_of_range_nodes()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        2,
        1.0,
    };
    const double tangent_in[] = {1.0, 0.0, 0.0, 1.0};
    double tangent_out[4]{};
    fd::TangentEdgeOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::apply_tangent_edge_operator(&edge, 1, tangent_in, shape, tangent_out, &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "exchange edge rejects invalid node");
    check(diagnostics.invalid_edge_count == 1, "exchange diagnostics count invalid edge");
    check(contains(diagnostics.error_message, "node"), "exchange diagnostics explain invalid node");
}

void exchange_edge_operator_rejects_nonfinite_stiffness()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        std::numeric_limits<double>::infinity(),
    };
    const double tangent_in[] = {1.0, 0.0, 0.0, 1.0};
    double tangent_out[4]{};
    fd::TangentEdgeOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::apply_tangent_edge_operator(&edge, 1, tangent_in, shape, tangent_out, &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "exchange edge rejects non-finite stiffness");
    check(contains(diagnostics.error_message, "finite"), "exchange diagnostics explain finite stiffness requirement");
    check(tangent_out[0] == 0.0 && tangent_out[1] == 0.0, "exchange non-finite stiffness leaves first node output untouched");
    check(tangent_out[2] == 0.0 && tangent_out[3] == 0.0, "exchange non-finite stiffness leaves second node output untouched");
}

void tangent_operator_applies_combined_nodewise_and_edge_terms()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);
    const fd::TangentOperatorLocalBlock node_blocks[] = {
        {
            fd::FrequencyDomainOperatorTermKind::zeeman,
            3.0,
            0.0,
            0.0,
            3.0,
        },
        {
            fd::FrequencyDomainOperatorTermKind::zeeman,
            3.0,
            0.0,
            0.0,
            3.0,
        },
    };
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        2.0,
    };
    const double tangent_in[] = {
        1.0, 2.0,
        -3.0, 4.0,
    };
    double tangent_out[4]{};
    fd::TangentCombinedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_combined_operator(
        node_blocks,
        &edge,
        1,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "combined tangent operator succeeds");
    check(diagnostics.node_count == 2, "combined diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "combined diagnostics keep tangent DOFs");
    check(diagnostics.node_block_count == 2, "combined diagnostics keep node block count");
    check(diagnostics.edge_count == 1, "combined diagnostics keep edge count");
    check(diagnostics.max_abs_output == 17.0, "combined diagnostics report max output");
    check(std::abs(tangent_out[0] - 11.0) < 1.0e-12, "combined output node0 e1");
    check(std::abs(tangent_out[1] - 2.0) < 1.0e-12, "combined output node0 e2");
    check(std::abs(tangent_out[2] + 17.0) < 1.0e-12, "combined output node1 e1");
    check(std::abs(tangent_out[3] - 16.0) < 1.0e-12, "combined output node1 e2");
}

void tangent_operator_rejects_nonfinite_combined_edge_stiffness()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(2);
    const fd::TangentOperatorLocalBlock node_blocks[] = {
        {
            fd::FrequencyDomainOperatorTermKind::zeeman,
            1.0,
            0.0,
            0.0,
            1.0,
        },
        {
            fd::FrequencyDomainOperatorTermKind::zeeman,
            1.0,
            0.0,
            0.0,
            1.0,
        },
    };
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        std::numeric_limits<double>::infinity(),
    };
    const double tangent_in[] = {1.0, 2.0, 3.0, 4.0};
    double tangent_out[4]{};
    fd::TangentCombinedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_combined_operator(
        node_blocks,
        &edge,
        1,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "combined tangent operator rejects non-finite edge stiffness");
    check(
        contains(diagnostics.error_message, "finite"),
        "combined tangent operator explains finite edge stiffness requirement");
    check(
        tangent_out[0] == 0.0 && tangent_out[1] == 0.0 &&
            tangent_out[2] == 0.0 && tangent_out[3] == 0.0,
        "combined non-finite edge stiffness leaves output untouched");
}

void tangent_nodewise_operator_rejects_nonfinite_local_block_coefficients()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(1);
    const fd::TangentOperatorLocalBlock node_block{
        fd::FrequencyDomainOperatorTermKind::local_anisotropy,
        1.0,
        0.0,
        std::numeric_limits<double>::infinity(),
        1.0,
    };
    const double tangent_in[] = {1.0, 2.0};
    double tangent_out[2]{};
    fd::TangentOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_nodewise_operator(
        &node_block,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "nodewise tangent operator rejects non-finite block coefficients");
    check(
        contains(diagnostics.error_message, "finite"),
        "nodewise tangent operator explains finite block coefficient requirement");
    check(tangent_out[0] == 0.0 && tangent_out[1] == 0.0, "nodewise non-finite block leaves output untouched");
}

void tangent_combined_operator_rejects_nonfinite_local_block_coefficients()
{
    const fd::TangentWorkspaceShape shape = fd::tangent_workspace_shape(1);
    const fd::TangentOperatorLocalBlock node_block{
        fd::FrequencyDomainOperatorTermKind::zeeman,
        1.0,
        std::numeric_limits<double>::quiet_NaN(),
        0.0,
        1.0,
    };
    const double tangent_in[] = {1.0, 2.0};
    double tangent_out[2]{};
    fd::TangentCombinedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_combined_operator(
        &node_block,
        nullptr,
        0,
        tangent_in,
        shape,
        tangent_out,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "combined tangent operator rejects non-finite local block coefficients");
    check(
        contains(diagnostics.error_message, "finite"),
        "combined tangent operator explains finite local block coefficient requirement");
    check(tangent_out[0] == 0.0 && tangent_out[1] == 0.0, "combined non-finite local block leaves output untouched");
}

void tangent_precession_operator_rotates_effective_field_variation()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "precession test frame build succeeds");

    const double effective_field_tangent[] = {2.0, -3.0};
    double rhs_tangent[2]{};
    fd::TangentPrecessionDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_precession_operator(
        &node,
        effective_field_tangent,
        fd::tangent_workspace_shape(1),
        10.0,
        rhs_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "tangent precession operator succeeds");
    check(diagnostics.node_count == 1, "precession diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 2, "precession diagnostics keep tangent DOFs");
    check(diagnostics.gamma0 == 10.0, "precession diagnostics keep gamma0");
    check(diagnostics.max_abs_rhs == 30.0, "precession diagnostics report max RHS");
    check(std::abs(rhs_tangent[0] + 30.0) < 1.0e-12, "precession output e1");
    check(std::abs(rhs_tangent[1] + 20.0) < 1.0e-12, "precession output e2");
}

void tangent_damping_operator_rotates_perturbation_by_alpha()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "damping test frame build succeeds");

    const double tangent_delta[] = {2.0, -3.0};
    double damping_tangent[2]{};
    fd::TangentDampingDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_damping_operator(
        &node,
        tangent_delta,
        fd::tangent_workspace_shape(1),
        0.1,
        damping_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "tangent damping operator succeeds");
    check(diagnostics.node_count == 1, "damping diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 2, "damping diagnostics keep tangent DOFs");
    check(diagnostics.alpha == 0.1, "damping diagnostics keep alpha");
    check(std::abs(diagnostics.max_abs_output - 0.3) < 1.0e-12, "damping diagnostics report max output");
    check(std::abs(damping_tangent[0] - 0.3) < 1.0e-12, "damping output e1");
    check(std::abs(damping_tangent[1] - 0.2) < 1.0e-12, "damping output e2");
}

void tangent_frequency_mass_operator_combines_identity_and_damping_rotation()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "frequency mass test frame build succeeds");

    const double tangent_delta[] = {2.0, -3.0};
    double mass_tangent[2]{};
    fd::TangentFrequencyMassDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_frequency_mass_operator(
        &node,
        tangent_delta,
        fd::tangent_workspace_shape(1),
        0.1,
        nullptr,
        mass_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "tangent frequency mass operator succeeds");
    check(diagnostics.node_count == 1, "frequency mass diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 2, "frequency mass diagnostics keep tangent DOFs");
    check(diagnostics.alpha == 0.1, "frequency mass diagnostics keep alpha");
    check(std::abs(diagnostics.max_abs_output - 3.2) < 1.0e-12, "frequency mass diagnostics report max output");
    check(std::abs(mass_tangent[0] - 1.7) < 1.0e-12, "frequency mass output e1");
    check(std::abs(mass_tangent[1] + 3.2) < 1.0e-12, "frequency mass output e2");
}

void tangent_frequency_mass_operator_uses_nodewise_alpha()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "nodewise frequency mass test frame build succeeds");

    const double tangent_delta[] = {2.0, -3.0, 4.0, 5.0};
    const double alpha_per_node[] = {0.1, 0.3};
    double mass_tangent[4]{};
    fd::TangentFrequencyMassDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_frequency_mass_operator(
        nodes,
        tangent_delta,
        fd::tangent_workspace_shape(2),
        0.0,
        alpha_per_node,
        mass_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "nodewise tangent frequency mass operator succeeds");
    check(diagnostics.node_count == 2, "nodewise frequency mass diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "nodewise frequency mass diagnostics keep tangent DOFs");
    check(diagnostics.alpha == 0.0, "nodewise frequency mass diagnostics keep uniform alpha");
    check(std::abs(diagnostics.max_alpha - 0.3) < 1.0e-12, "nodewise frequency mass diagnostics report max alpha");
    check(std::abs(mass_tangent[0] - 1.7) < 1.0e-12, "nodewise frequency mass output node0 e1");
    check(std::abs(mass_tangent[1] + 3.2) < 1.0e-12, "nodewise frequency mass output node0 e2");
    check(std::abs(mass_tangent[2] - 5.5) < 1.0e-12, "nodewise frequency mass output node1 e1");
    check(std::abs(mass_tangent[3] - 3.8) < 1.0e-12, "nodewise frequency mass output node1 e2");
}

void operator_contract_validates_driven_and_modal_requests_separately()
{
    const fd::FrequencyDomainOperatorRequest operator_request{
        2,
        4,
        fd::FrequencyDomainBoundaryKind::open_boundary,
        fd::FrequencyDomainDemagKind::none,
        0.02,
        2.211e5,
        false,
        false,
        false,
    };
    fd::FrequencyDomainOperatorValidationDiagnostics diagnostics{};

    check(
        fd::validate_frequency_domain_operator_request(operator_request, &diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "operator request validation succeeds");
    check(diagnostics.node_count == 2, "operator diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "operator diagnostics keep tangent DOFs");
    check(diagnostics.alpha == 0.02, "operator diagnostics keep alpha");
    check(diagnostics.gamma0 == 2.211e5, "operator diagnostics keep gamma0");

    const double frequencies_hz[] = {1.0e9, 2.0e9};
    const fd::DrivenFrequencyResponseRequest driven_request{
        operator_request,
        frequencies_hz,
        2,
        fd::FrequencyDomainExcitationKind::uniform_field,
        true,
    };
    fd::FrequencyDomainSolveRequestDiagnostics solve_diagnostics{};
    check(
        fd::validate_driven_frequency_response_request(driven_request, &solve_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "driven frequency response request validation succeeds");
    check(
        solve_diagnostics.study_kind == fd::FrequencyDomainStudyKind::driven_frequency_response,
        "driven request keeps driven study kind");
    check(solve_diagnostics.frequency_count == 2, "driven diagnostics keep frequency count");

    const fd::ModalDynamicMatrixRequest modal_request{
        operator_request,
        8,
        2.5e9,
        false,
        true,
    };
    check(
        fd::validate_modal_dynamic_matrix_request(modal_request, &solve_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "modal dynamic matrix request validation succeeds");
    check(
        solve_diagnostics.study_kind == fd::FrequencyDomainStudyKind::modal_dynamic_matrix,
        "modal request keeps modal study kind");
    check(solve_diagnostics.mode_count == 8, "modal diagnostics keep mode count");
}

void operator_contract_rejects_invalid_frequency_sweep()
{
    const fd::FrequencyDomainOperatorRequest operator_request{
        1,
        2,
        fd::FrequencyDomainBoundaryKind::open_boundary,
        fd::FrequencyDomainDemagKind::none,
        0.0,
        2.211e5,
        false,
        false,
        false,
    };
    const double frequencies_hz[] = {1.0e9, -2.0e9};
    const fd::DrivenFrequencyResponseRequest driven_request{
        operator_request,
        frequencies_hz,
        2,
        fd::FrequencyDomainExcitationKind::uniform_field,
        true,
    };
    fd::FrequencyDomainSolveRequestDiagnostics diagnostics{};

    check(
        fd::validate_driven_frequency_response_request(driven_request, &diagnostics) ==
            fd::FrequencyDomainStatus::validation_error,
        "driven request rejects non-positive frequency");
    check(diagnostics.invalid_frequency_count == 1, "driven diagnostics count invalid frequencies");
    check(contains(diagnostics.error_message, "frequency"), "driven diagnostics explain frequency rejection");
}

void driven_response_solver_boundary_returns_structured_unavailable_result()
{
    const double frequencies_hz[] = {1.0e9, 2.0e9};
    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 3;
    request.solve_request.operator_request.tangent_dof_count = 6;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 2;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    static_assert(
        noexcept(fd::solve_driven_frequency_response(request, &result)),
        "driven response solver boundary must not throw");
    static_assert(
        noexcept(fd::release_driven_frequency_response_result(&result)),
        "driven response result cleanup must not throw");

    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::unavailable, "driven solve boundary reports unavailable");
    check(result.status == fd::FrequencyDomainStatus::unavailable, "driven solve result stores unavailable status");
    check(result.total_frequency_count == 2, "driven solve result preserves requested frequency count");
    check(result.completed_frequency_count == 0, "unavailable driven solve completes no frequencies");
    check(result.written_frequency_point_artifacts == 0, "unavailable driven solve writes no point artifacts");
    check(result.error_message != nullptr, "driven solve result has error message");
    check(contains(result.error_message, "driven"), "driven solve unavailable reason names solver");
    check(result.diagnostics_json != nullptr, "driven solve result has diagnostics JSON");
    check(
        contains(result.diagnostics_json, "frequency_domain_response_diagnostics.v1"),
        "driven solve diagnostics JSON reports schema");
    check(result.result_json != nullptr, "driven solve result has result JSON");
    check(
        contains(result.result_json, "frequency_domain_driven_response_result.v1"),
        "driven solve result JSON reports result schema");
    check(contains(result.result_json, "unavailable"), "driven solve result JSON reports status");
    check(result.artifact_manifest_path != nullptr, "driven solve result has manifest path pointer");
    check(
        std::strcmp(result.artifact_manifest_path, "") == 0,
        "unavailable driven solve does not report manifest path");

    fd::release_driven_frequency_response_result(&result);
    check(result.error_message == nullptr, "driven solve cleanup clears error message");
    check(result.diagnostics_json == nullptr, "driven solve cleanup clears diagnostics JSON");
    check(result.result_json == nullptr, "driven solve cleanup clears result JSON");
    check(result.artifact_manifest_path == nullptr, "driven solve cleanup clears manifest path");
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_writes_failure_artifacts_for_unavailable_run()
{
    const double frequencies_hz[] = {1.0e9, 2.0e9};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-unavailable-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 3;
    request.solve_request.operator_request.tangent_dof_count = 6;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 2;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::unavailable, "unavailable artifact run reports unavailable");
    check(result.completed_frequency_count == 0, "unavailable artifact run completes no frequencies");
    check(result.written_frequency_point_artifacts == 0, "unavailable artifact run writes no point artifacts");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "unavailable artifact run reports manifest path");
    check(
        contains(result.result_json, "frequency_domain/manifest.v1.json"),
        "unavailable artifact run reports manifest path in result JSON");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"schema_version\":\"frequency_domain_manifest.v1\""), "failure manifest schema is written");
    check(contains(manifest.c_str(), "\"stage_kind\":\"frequency_response\""), "failure manifest records response stage");
    check(contains(manifest.c_str(), "\"status\":\"unavailable\""), "failure manifest records unavailable status");
    check(contains(manifest.c_str(), "\"complete\":false"), "failure manifest records incomplete state");
    check(
        contains(manifest.c_str(), "\"frequency_count\":2"),
        "failure manifest records requested frequency count");
    check(contains(manifest.c_str(), "\"production_solver_available\":false"), "failure manifest records production solver unavailable");
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "failure manifest links response diagnostics artifact");
    check(
        contains(manifest.c_str(), "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\""),
        "failure manifest links solver diagnostics artifact");
    check(
        contains(manifest.c_str(), "\"response_progress_v1_path\":\"response/progress.v1.json\""),
        "failure manifest links response progress artifact");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_v1_path\":null"),
        "failure manifest records no cancel-request artifact link");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_resource_key\":null"),
        "failure manifest records no cancel-request resource link");
    check(
        contains(manifest.c_str(), "\"frequency_point_paths\":[]"),
        "failure manifest records no frequency point artifacts");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"schema_version\":\"frequency_domain_response_diagnostics.v1\""),
        "failure diagnostics schema is written");
    check(contains(diagnostics.c_str(), "\"status\":\"unavailable\""), "failure diagnostics reports unavailable status");
    check(contains(diagnostics.c_str(), "\"complete\":false"), "failure diagnostics records incomplete state");
    check(
        contains(diagnostics.c_str(), "\"solver_kind\":\"production_unavailable\""),
        "failure diagnostics records unavailable solver kind");
    check(
        contains(diagnostics.c_str(), "\"requested_frequency_count\":2"),
        "failure diagnostics records requested frequency count");
    check(
        contains(diagnostics.c_str(), "\"completed_frequency_point_count\":0"),
        "failure diagnostics records completed frequency point count");
    check(
        contains(diagnostics.c_str(), "native FEM driven frequency-response solver is not implemented"),
        "failure diagnostics records unavailable reason");

    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"schema_version\":\"frequency_domain_sweep_progress.v1\""),
        "failure progress schema is written");
    check(contains(progress.c_str(), "\"state\":\"unavailable\""), "failure progress records unavailable state");
    check(
        contains(progress.c_str(), "\"partial_artifacts_available\":false"),
        "failure progress reports no partial artifacts");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":2"),
        "failure progress records requested frequency count");

    char response_path[256]{};
    std::snprintf(
        response_path,
        sizeof(response_path),
        "%s/response/magnetic_response_sweep.v1.json",
        output_directory);
    FILE *response = std::fopen(response_path, "r");
    check(response == nullptr, "unavailable artifact run does not write fake response sweep");
    if (response != nullptr) {
        std::fclose(response);
    }

    fd::release_driven_frequency_response_result(&result);
}

void production_gpu_unavailable_artifact_reports_gpu_lane()
{
    const double frequencies_hz[] = {1.0e9};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-gpu-unavailable-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::unavailable, "GPU unavailable artifact run reports unavailable");
    check(contains(result.error_message, "production GPU"), "GPU unavailable artifact names GPU lane");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "GPU unavailable artifact run reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"requested_execution_lane\":\"production_gpu\""),
        "GPU unavailable manifest records requested lane");
    check(
        contains(manifest.c_str(), "\"lane_classification\":\"fem_gpu_production\""),
        "GPU unavailable manifest records GPU lane classification");
    check(
        contains(manifest.c_str(), "\"frequency_count\":1"),
        "GPU unavailable manifest records requested frequency count");
    check(
        !contains(manifest.c_str(), "\"lane_classification\":\"fem_cpu_production\""),
        "GPU unavailable manifest must not report CPU lane classification");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"requested_execution_lane\":\"production_gpu\""),
        "GPU unavailable diagnostics record requested lane");
    check(
        contains(diagnostics.c_str(), "\"validation_fallback_used\":false"),
        "GPU unavailable diagnostics record that validation fallback was not used");
    check(
        contains(diagnostics.c_str(), "\"requested_frequency_count\":1"),
        "GPU unavailable diagnostics record requested frequency count");
    check(
        !contains(diagnostics.c_str(), "\"validation_fallback_used\":true"),
        "GPU unavailable diagnostics must not report validation fallback");
    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(contains(progress.c_str(), "\"state\":\"unavailable\""), "GPU unavailable progress records unavailable state");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":1"),
        "GPU unavailable progress records requested frequency count");

    fd::release_driven_frequency_response_result(&result);
}

void production_gpu_static_periodic_no_demag_runs_mfem_response_problem()
{
    const double frequencies_hz[] = {1.0e9};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "GPU static-periodic no-demag test builds tangent frame");
    const double drive_real[] = {1.0, 0.0, 1.0, 0.0};
    const std::uint64_t periodic_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-gpu-static-periodic-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&periodic_pairs)));

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    request.magnetic_periodic_constraint_set_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.drive_real = drive_real;
    request.mfem_validation_problem.static_periodic_node_pairs = periodic_pairs;
    request.mfem_validation_problem.static_periodic_node_pair_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

#if FULLMAG_HAS_CUDA_RUNTIME
    check(
        status == fd::FrequencyDomainStatus::ok,
        "GPU static-periodic no-demag solve succeeds");
    check(result.completed_frequency_count == 1, "GPU static-periodic no-demag solve completes frequency");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_gpu\""),
        "GPU static-periodic result reports requested GPU lane");
    check(
        contains(result.result_json, "\"resolved_execution_lane\":\"production_gpu\""),
        "GPU static-periodic result reports resolved GPU lane");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "GPU static-periodic result reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"requested_execution_lane\":\"production_gpu\""),
        "GPU static-periodic manifest records requested GPU lane");
    check(
        contains(manifest.c_str(), "\"lane_classification\":\"fem_gpu_production\""),
        "GPU static-periodic manifest records GPU lane classification");
    check(
        contains(manifest.c_str(), "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\""),
        "GPU static-periodic manifest links periodic pairs artifact");
    check(
        contains(manifest.c_str(), "\"static_periodic_projection\":true"),
        "GPU static-periodic manifest records static-periodic projection");
    check(
        contains(manifest.c_str(), "\"validation_fallback_used\":false"),
        "GPU static-periodic manifest rejects validation fallback");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"requested_execution_lane\":\"production_gpu\""),
        "GPU static-periodic diagnostics records requested GPU lane");
    check(
        contains(diagnostics.c_str(), "\"resolved_execution_lane\":\"production_gpu\""),
        "GPU static-periodic diagnostics records resolved GPU lane");
    check(
        contains(diagnostics.c_str(), "\"static_periodic_projection\":true"),
        "GPU static-periodic diagnostics records static-periodic projection");
    check(
        contains(diagnostics.c_str(), "\"static_periodic_node_pair_count\":1"),
        "GPU static-periodic diagnostics records periodic node pair count");
    check(
        contains(diagnostics.c_str(), "\"validation_fallback_used\":false"),
        "GPU static-periodic diagnostics rejects validation fallback");

    char periodic_pairs_path[256]{};
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string periodic_pair_artifact = read_text_file(periodic_pairs_path);
    check(
        contains(periodic_pair_artifact.c_str(), "\"schema_version\":\"periodic_pairs.v1\""),
        "GPU static-periodic writes periodic pairs schema");
    check(
        contains(periodic_pair_artifact.c_str(), "\"validation_status\":\"ok\""),
        "GPU static-periodic periodic pairs artifact records ok status");
    check(
        contains(periodic_pair_artifact.c_str(), "\"source\":\"native_fem_frequency_domain_static_periodic\""),
        "GPU static-periodic periodic pairs artifact records native source");
    check(
        contains(periodic_pair_artifact.c_str(), "\"paired_node_count\":2"),
        "GPU static-periodic periodic pairs artifact records paired nodes");
#else
    check(status == fd::FrequencyDomainStatus::unavailable, "non-CUDA GPU static-periodic solve is unavailable");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "non-CUDA GPU static-periodic diagnostics reject validation fallback");
#endif

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_floquet_local_no_demag_runs_phase_constrained_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.5707963267948966;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "CPU Floquet local no-demag test builds tangent frames");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0, 0.0, 0.0};
    const double drive_imag[] = {0.0, 0.0, -1.0, 0.0};
    fd::FrequencyDomainFloquetPeriodicPair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = true;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = true;
    floquet_pair.phase_rad = phase_rad;

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-cpu-floquet-local-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&floquet_pair)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 1.5707963267948966e6;
    request.floquet_periodic_pairs = &floquet_pair;
    request.floquet_periodic_pair_count = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;
    request.mfem_validation_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "CPU Floquet local no-demag solve succeeds");
    check(result.completed_frequency_count == 1, "CPU Floquet local no-demag solve completes frequency");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_cpu\""),
        "CPU Floquet local result reports requested CPU lane");
    check(
        contains(result.diagnostics_json, "\"floquet_phase_projection\":true"),
        "CPU Floquet local diagnostics report phase projection");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "CPU Floquet local diagnostics reject validation fallback");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    double m_complex[8]{};
    check(
        extract_m_complex_values(point, m_complex, 8),
        "CPU Floquet local frequency point exposes tangent complex response");
    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double expected_dst_real = c * m_complex[0] - s * m_complex[1];
    const double expected_dst_imag = s * m_complex[0] + c * m_complex[1];
    check(
        nearly_equal(m_complex[4], expected_dst_real, 1.0e-7),
        "CPU Floquet local response real part satisfies phase relation");
    check(
        nearly_equal(m_complex[5], expected_dst_imag, 1.0e-7),
        "CPU Floquet local response imaginary part satisfies phase relation");
    fd::release_driven_frequency_response_result(&result);
}

void production_gpu_floquet_local_no_demag_runs_phase_constrained_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.5707963267948966;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "GPU Floquet local no-demag test builds tangent frames");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0, 0.0, 0.0};
    const double drive_imag[] = {0.0, 0.0, -1.0, 0.0};
    fd::FrequencyDomainFloquetPeriodicPair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = true;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = true;
    floquet_pair.phase_rad = phase_rad;

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-gpu-floquet-local-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&floquet_pair)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.operator_request.strict_gpu = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 1.5707963267948966e6;
    request.floquet_periodic_pairs = &floquet_pair;
    request.floquet_periodic_pair_count = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;
    request.mfem_validation_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

#if FULLMAG_HAS_CUDA_RUNTIME
    check(status == fd::FrequencyDomainStatus::ok, "GPU Floquet local no-demag solve succeeds");
    check(result.completed_frequency_count == 1, "GPU Floquet local no-demag solve completes frequency");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_gpu\""),
        "GPU Floquet local result reports requested GPU lane");
    check(
        contains(result.result_json, "\"resolved_execution_lane\":\"production_gpu\""),
        "GPU Floquet local result reports resolved GPU lane");
    check(
        contains(result.diagnostics_json, "\"floquet_phase_projection\":true"),
        "GPU Floquet local diagnostics report phase projection");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "GPU Floquet local diagnostics reject validation fallback");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    double m_complex[8]{};
    check(
        extract_m_complex_values(point, m_complex, 8),
        "GPU Floquet local frequency point exposes tangent complex response");
    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double expected_dst_real = c * m_complex[0] - s * m_complex[1];
    const double expected_dst_imag = s * m_complex[0] + c * m_complex[1];
    check(
        nearly_equal(m_complex[4], expected_dst_real, 1.0e-7),
        "GPU Floquet local response real part satisfies phase relation");
    check(
        nearly_equal(m_complex[5], expected_dst_imag, 1.0e-7),
        "GPU Floquet local response imaginary part satisfies phase relation");
#else
    check(status == fd::FrequencyDomainStatus::unavailable, "non-CUDA GPU Floquet local solve is unavailable");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "non-CUDA GPU Floquet local diagnostics reject validation fallback");
#endif
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_floquet_exchange_no_demag_runs_phase_constrained_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.5707963267948966;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "CPU Floquet exchange no-demag test builds tangent frames");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.exchange_enabled = true;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const fd::TangentOperatorEdgeBlock exchange_edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        0.25,
    };
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0, 0.0, 0.0};
    const double drive_imag[] = {0.0, 0.0, -1.0, 0.0};
    fd::FrequencyDomainFloquetPeriodicPair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = true;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = true;
    floquet_pair.phase_rad = phase_rad;

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-cpu-floquet-exchange-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&exchange_edge)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 1.5707963267948966e6;
    request.floquet_periodic_pairs = &floquet_pair;
    request.floquet_periodic_pair_count = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.exchange_edges = &exchange_edge;
    request.mfem_validation_problem.exchange_edge_count = 1;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;
    request.mfem_validation_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "CPU Floquet exchange no-demag solve succeeds");
    check(result.completed_frequency_count == 1, "CPU Floquet exchange no-demag solve completes frequency");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_cpu\""),
        "CPU Floquet exchange no-demag result reports requested CPU lane");
    check(
        contains(result.diagnostics_json, "\"floquet_phase_projection\":true"),
        "CPU Floquet exchange no-demag diagnostics report phase projection");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "CPU Floquet exchange no-demag diagnostics reject validation fallback");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    double m_complex[8]{};
    check(
        extract_m_complex_values(point, m_complex, 8),
        "CPU Floquet exchange no-demag frequency point exposes tangent complex response");
    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double expected_dst_real = c * m_complex[0] - s * m_complex[1];
    const double expected_dst_imag = s * m_complex[0] + c * m_complex[1];
    check(
        nearly_equal(m_complex[4], expected_dst_real, 1.0e-7),
        "CPU Floquet exchange no-demag response real part satisfies phase relation");
    check(
        nearly_equal(m_complex[5], expected_dst_imag, 1.0e-7),
        "CPU Floquet exchange no-demag response imaginary part satisfies phase relation");
    fd::release_driven_frequency_response_result(&result);
}

void production_gpu_floquet_exchange_no_demag_runs_phase_constrained_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.5707963267948966;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "GPU Floquet exchange no-demag test builds tangent frames");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.exchange_enabled = true;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const fd::TangentOperatorEdgeBlock exchange_edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        0.25,
    };
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0, 0.0, 0.0};
    const double drive_imag[] = {0.0, 0.0, -1.0, 0.0};
    fd::FrequencyDomainFloquetPeriodicPair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = true;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = true;
    floquet_pair.phase_rad = phase_rad;

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-gpu-floquet-exchange-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&exchange_edge)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.operator_request.strict_gpu = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 1.5707963267948966e6;
    request.floquet_periodic_pairs = &floquet_pair;
    request.floquet_periodic_pair_count = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.exchange_edges = &exchange_edge;
    request.mfem_validation_problem.exchange_edge_count = 1;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;
    request.mfem_validation_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

#if FULLMAG_HAS_CUDA_RUNTIME
    check(status == fd::FrequencyDomainStatus::ok, "GPU Floquet exchange no-demag solve succeeds");
    check(result.completed_frequency_count == 1, "GPU Floquet exchange no-demag solve completes frequency");
    check(
        contains(result.diagnostics_json, "\"operator_terms_included\":[\"exchange\",\"zeeman\"]"),
        "GPU Floquet exchange no-demag diagnostics report exchange and Zeeman terms");
    check(
        contains(result.diagnostics_json, "\"exchange_edge_count\":1"),
        "GPU Floquet exchange no-demag diagnostics report exchange edge count");
    check(
        contains(result.diagnostics_json, "\"floquet_phase_projection\":true"),
        "GPU Floquet exchange no-demag diagnostics report phase projection");
    check(
        contains(result.diagnostics_json, "\"floquet_real_imag_mixing\":true"),
        "GPU Floquet exchange no-demag diagnostics report real/imag phase mixing");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "GPU Floquet exchange no-demag diagnostics reject validation fallback");

    char manifest_path[256]{};
    std::snprintf(
        manifest_path,
        sizeof(manifest_path),
        "%s/frequency_domain/manifest.v1.json",
        output_directory);
    const std::string manifest = read_text_file(manifest_path);
    check(
        contains(manifest.c_str(), "\"spin_wave_bc\":{\"kind\":\"floquet\"}"),
        "GPU Floquet exchange no-demag manifest records Floquet spin-wave boundary");
    check(
        contains(manifest.c_str(), "\"periodic_or_floquet\":true"),
        "GPU Floquet exchange no-demag manifest records periodic_or_floquet");
    check(
        contains(manifest.c_str(), "\"floquet_phase_projection\":true"),
        "GPU Floquet exchange no-demag manifest records phase projection diagnostics");
    check(
        contains(manifest.c_str(), "\"floquet_real_imag_mixing\":true"),
        "GPU Floquet exchange no-demag manifest records real/imag phase mixing diagnostics");
    check(
        contains(manifest.c_str(), "\"floquet_periodic_pair_count\":1"),
        "GPU Floquet exchange no-demag manifest records Floquet pair count");
    check(
        contains(manifest.c_str(), "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\""),
        "GPU Floquet exchange no-demag manifest links Floquet periodic-pair artifact");
    check(
        contains(manifest.c_str(), "\"exchange_edge_count\":1"),
        "GPU Floquet exchange no-demag manifest records exchange edge count");
    check(
        contains(manifest.c_str(), "\"floquet_k_vector_rad_per_m\":[1570796.3267948965,0,0]"),
        "GPU Floquet exchange no-demag manifest records Floquet k vector");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"operator_terms_included\":[\"exchange\",\"zeeman\"]"),
        "GPU Floquet exchange no-demag solver diagnostics record exchange and Zeeman terms");
    check(
        contains(diagnostics.c_str(), "\"exchange_edge_count\":1"),
        "GPU Floquet exchange no-demag solver diagnostics record exchange edge count");

    char periodic_pairs_path[256]{};
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string periodic_pairs = read_text_file(periodic_pairs_path);
    check(
        contains(periodic_pairs.c_str(), "\"source\":\"native_fem_frequency_domain_floquet_phase_projection\""),
        "GPU Floquet exchange no-demag pair artifact records Floquet projection source");
    check(
        contains(periodic_pairs.c_str(), "\"phase_rad\":-1.5707963267948966"),
        "GPU Floquet exchange no-demag pair artifact records pair phase");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    double m_complex[8]{};
    check(
        extract_m_complex_values(point, m_complex, 8),
        "GPU Floquet exchange no-demag frequency point exposes tangent complex response");
    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double expected_dst_real = c * m_complex[0] - s * m_complex[1];
    const double expected_dst_imag = s * m_complex[0] + c * m_complex[1];
    check(
        nearly_equal(m_complex[4], expected_dst_real, 1.0e-7),
        "GPU Floquet exchange no-demag response real part satisfies phase relation");
    check(
        nearly_equal(m_complex[5], expected_dst_imag, 1.0e-7),
        "GPU Floquet exchange no-demag response imaginary part satisfies phase relation");
#else
    check(status == fd::FrequencyDomainStatus::unavailable, "non-CUDA GPU Floquet exchange no-demag solve is unavailable");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "non-CUDA GPU Floquet exchange no-demag diagnostics reject validation fallback");
#endif
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_respects_disabled_partial_failure_artifacts()
{
    const double frequencies_hz[] = {1.0e9, 2.0e9};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-no-partial-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 3;
    request.solve_request.operator_request.tangent_dof_count = 6;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 2;
    request.output_directory = output_directory;
    request.write_partial_artifacts = false;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::unavailable, "disabled partial artifact run still reports unavailable");
    check(result.completed_frequency_count == 0, "disabled partial artifact run completes no frequencies");
    check(result.written_frequency_point_artifacts == 0, "disabled partial artifact run writes no point artifacts");
    check(
        std::strcmp(result.artifact_manifest_path, "") == 0,
        "disabled partial artifact run reports no manifest path");
    check(
        contains(result.result_json, "\"artifact_manifest_path\":\"\""),
        "disabled partial artifact run result JSON reports no manifest path");

    char manifest_path[256]{};
    std::snprintf(
        manifest_path,
        sizeof(manifest_path),
        "%s/frequency_domain/manifest.v1.json",
        output_directory);
    check(!file_exists(manifest_path), "disabled partial artifact run does not write failure manifest");

    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_boundary_validates_request_before_unavailable_solve()
{
    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::validation_error, "driven solve validates frequency sweep");
    check(result.status == fd::FrequencyDomainStatus::validation_error, "driven solve result stores validation status");
    check(contains(result.error_message, "frequency"), "driven solve validation error names frequency");
    check(contains(result.diagnostics_json, "frequency_domain_response_diagnostics.v1"), "validation diagnostics has schema");
    check(contains(result.result_json, "frequency_domain_driven_response_result.v1"), "validation result has result schema");
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_runs_tiny_diagonal_validation_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.tiny_validation_problem.enabled = true;
    request.tiny_validation_problem.tangent_dof_count = 2;
    request.tiny_validation_problem.stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_problem.mass_diagonal = mass_diagonal;
    request.tiny_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "tiny driven response solve succeeds");
    check(result.status == fd::FrequencyDomainStatus::ok, "tiny driven response stores ok status");
    check(result.total_frequency_count == 1, "tiny driven response keeps total frequency count");
    check(result.completed_frequency_count == 1, "tiny driven response completes one frequency");
    check(result.written_frequency_point_artifacts == 0, "tiny driven response writes no artifacts yet");
    check(contains(result.result_json, "\"status\":\"ok\""), "tiny driven response result JSON reports ok");
    check(contains(result.result_json, "\"max_abs_response\""), "tiny driven response reports max response");
    check(contains(result.diagnostics_json, "\"tiny_validation_solver\":true"), "tiny diagnostics name validation solver");
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_runs_tiny_dense_validation_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_matrix_row_major[] = {
        2.0, 0.5,
        0.5, 3.0,
    };
    const double mass_matrix_row_major[] = {
        1.0, 0.25,
        0.25, 2.0,
    };
    const double drive_real[] = {1.0, 2.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.tiny_validation_problem.enabled = true;
    request.tiny_validation_problem.tangent_dof_count = 2;
    request.tiny_validation_problem.stiffness_matrix_row_major = stiffness_matrix_row_major;
    request.tiny_validation_problem.mass_matrix_row_major = mass_matrix_row_major;
    request.tiny_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "tiny dense driven response solve succeeds");
    check(result.completed_frequency_count == 1, "tiny dense driven response completes one frequency");
    check(
        contains(result.result_json, "\"max_abs_response\":0.504770868968531"),
        "tiny dense driven response reports coupled max response");
    check(contains(result.diagnostics_json, "\"dense_block_real_solver\":true"), "tiny dense diagnostics name dense solver");
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_preserves_tiny_dense_solve_error_status()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_diagonal[] = {0.0, 0.0};
    const double mass_diagonal[] = {0.0, 0.0};
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.tiny_validation_problem.enabled = true;
    request.tiny_validation_problem.tangent_dof_count = 2;
    request.tiny_validation_problem.stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_problem.mass_diagonal = mass_diagonal;
    request.tiny_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::solve_error, "tiny dense singular solve reports solve_error");
    check(result.status == fd::FrequencyDomainStatus::solve_error, "tiny dense singular result stores solve_error");
    check(contains(result.error_message, "singular"), "tiny dense singular solve explains singular matrix");
    check(contains(result.result_json, "\"status\":\"solve_error\""), "tiny dense singular result JSON preserves solve_error");
    check(
        contains(result.diagnostics_json, "\"schema_version\":\"frequency_domain_response_diagnostics.v1\""),
        "tiny dense singular diagnostics JSON uses diagnostics schema");
    check(contains(result.diagnostics_json, "\"status\":\"solve_error\""), "tiny dense singular diagnostics JSON preserves solve_error");
    check(!contains(result.result_json, "\"status\":\"artifact_error\""), "tiny dense singular result JSON must not become artifact_error");
    check(!contains(result.diagnostics_json, "\"status\":\"artifact_error\""), "tiny dense singular diagnostics JSON must not become artifact_error");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_matrix_free_solver_solves_diagonal_harmonic_response()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0, 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    double response_real[2]{};
    double response_imag[2]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                2,
                residual_l2,
                relative_residual_l2,
                1,
                nullptr,
                nullptr,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU matrix-free solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU matrix-free solve completes one frequency");
    check(result.total_iteration_count > 0, "production CPU matrix-free solve reports iterations");
    check(result.max_iterations_for_frequency <= 4, "diagonal production solve converges inside one restart");
    check(relative_residual_l2[0] < 1.0e-12, "production CPU matrix-free residual is small");
    check(result.relative_residual_l2_norm < 1.0e-12, "production CPU result reports small residual");
    check(std::abs(response_real[0] - 0.4) < 1.0e-12, "production CPU response real[0]");
    check(std::abs(response_imag[0] - 0.2) < 1.0e-12, "production CPU response imag[0]");
    check(std::abs(response_real[1] - 0.4) < 1.0e-12, "production CPU response real[1]");
    check(std::abs(response_imag[1] - 0.2) < 1.0e-12, "production CPU response imag[1]");
}

void production_cpu_matrix_free_solver_skips_zero_initial_residual_operator()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0};
    const double mass[] = {1.0};
    const double drive_real[] = {1.0};
    double response_real[1]{};
    double response_imag[1]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 1};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                1,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                1,
                residual_l2,
                relative_residual_l2,
                1,
                nullptr,
                nullptr,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU zero-residual shortcut solve succeeds");
    check(op.stiffness_call_count == 6, "initial zero residual skips one real/imag stiffness block apply");
    check(op.mass_call_count == 6, "initial zero residual skips one real/imag mass block apply");
    check(result.completed_frequency_count == 1, "zero-residual shortcut solve completes one frequency");
}

void production_cpu_matrix_free_solver_solves_complex_drive()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0, 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    const double drive_imag[] = {3.0, -1.0};
    double response_real[2]{};
    double response_imag[2]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                2,
                residual_l2,
                relative_residual_l2,
                1,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                drive_imag,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU complex-drive solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU complex-drive solve completes one frequency");
    check(relative_residual_l2[0] < 1.0e-12, "production CPU complex-drive residual is small");
    check(std::abs(response_real[0] + 0.2) < 1.0e-12, "production CPU complex-drive response real[0]");
    check(std::abs(response_imag[0] - 1.4) < 1.0e-12, "production CPU complex-drive response imag[0]");
    check(std::abs(response_real[1] - 0.5) < 1.0e-12, "production CPU complex-drive response real[1]");
    check(std::abs(response_imag[1]) < 1.0e-12, "production CPU complex-drive response imag[1]");
}

void production_cpu_matrix_free_solver_preserves_nonconvergence_diagnostics()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0, 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    double response_real[2]{};
    double response_imag[2]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-14,
                1,
                1,
                response_real,
                response_imag,
                2,
                residual_l2,
                relative_residual_l2,
                1,
                nullptr,
                nullptr,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::solve_error, "production CPU limited GMRES reports solve_error");
    check(result.completed_frequency_count == 0, "production CPU limited GMRES completes no frequencies");
    check(result.total_iteration_count == 1, "production CPU limited GMRES preserves attempted iteration count");
    check(result.max_iterations_for_frequency == 1, "production CPU limited GMRES preserves max iterations for failed frequency");
    check(result.restart_iterations_for_frequency == 1, "production CPU limited GMRES preserves restart iterations for failed frequency");
    check(std::abs(result.solver_relative_tolerance - 1.0e-14) < 1.0e-20, "production CPU limited GMRES preserves requested tolerance");
    check(result.rhs_l2_norm > 0.0, "production CPU limited GMRES preserves RHS norm");
    check(result.initial_residual_l2_norm > 0.0, "production CPU limited GMRES preserves initial residual norm");
    check(
        result.initial_relative_residual_l2_norm > 0.0,
        "production CPU limited GMRES preserves initial relative residual");
    check(result.residual_l2_norm > 0.0, "production CPU limited GMRES preserves final residual norm");
    check(result.relative_residual_l2_norm > 0.0, "production CPU limited GMRES preserves final relative residual");
    check(
        result.minimum_tracked_relative_residual_l2_norm > 0.0,
        "production CPU limited GMRES preserves minimum relative residual");
    check(
        result.last_tracked_relative_residual_l2_norm > 0.0,
        "production CPU limited GMRES preserves last tracked residual");
    check(
        result.last_recomputed_relative_residual_l2_norm > 0.0,
        "production CPU limited GMRES preserves last recomputed residual");
    check(
        result.residual_growth_factor > 0.0,
        "production CPU limited GMRES preserves residual growth factor");
}

void production_cpu_matrix_free_solver_requires_recomputed_residual_for_convergence()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double drive_real[] = {1.0};
    double response_real[1]{};
    double response_imag[1]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    FirstKrylovApplyOnlyOperator op{1};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                1,
                frequencies_hz,
                1,
                drive_real,
                apply_first_krylov_stiffness_then_zero,
                apply_zero_mass,
                &op,
                1.0e-6,
                1,
                1,
                response_real,
                response_imag,
                1,
                residual_l2,
                relative_residual_l2,
                1,
                nullptr,
                nullptr,
            },
            &result);

    check(
        status == fd::FrequencyDomainStatus::solve_error,
        "production CPU GMRES rejects false Arnoldi convergence when recomputed residual is large");
    check(result.completed_frequency_count == 0, "false Arnoldi convergence completes no frequencies");
    check(result.total_iteration_count == 1, "false Arnoldi convergence preserves attempted iteration count");
    check(
        result.minimum_tracked_relative_residual_l2_norm < 1.0e-12,
        "false Arnoldi convergence records small tracked Krylov residual");
    check(
        result.last_tracked_relative_residual_l2_norm < 1.0e-12,
        "false Arnoldi convergence records final tracked Krylov residual");
    check(
        result.last_recomputed_relative_residual_l2_norm > 0.5,
        "false Arnoldi convergence records final recomputed residual separately");
    check(
        result.relative_residual_l2_norm > 0.5,
        "false Arnoldi convergence reports large recomputed residual");
    check(
        relative_residual_l2[0] > 0.5,
        "false Arnoldi convergence stores large recomputed residual in output buffer");
}

void production_cpu_lane_writes_failure_artifacts_for_nonconverged_gmres()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU GMRES failure artifact frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 2.0, 3.0, 4.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-production-cpu-gmres-failure-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&nodes)));

    ScopedEnvVar response_rtol("FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL", "1e-14");
    ScopedEnvVar response_max_iterations(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS",
        "1");
    ScopedEnvVar response_restart_iterations(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS",
        "1");

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::solve_error, "limited production CPU GMRES reports solve_error");
    check(result.completed_frequency_count == 0, "limited production CPU GMRES completes no points");
    check(result.written_frequency_point_artifacts == 0, "limited production CPU GMRES writes no point artifacts");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "limited production CPU GMRES failure reports manifest path");
    check(
        contains(result.result_json, "\"partial_artifacts_available\":true"),
        "limited production CPU GMRES failure result reports partial artifacts");
    check(
        contains(result.diagnostics_json, "\"total_iteration_count\":1"),
        "limited production CPU GMRES failure diagnostics reports iteration count");
    check(
        contains(result.diagnostics_json, "\"restart_iterations_for_frequency\":1"),
        "limited production CPU GMRES failure diagnostics reports restart count");
    check(
        contains(result.diagnostics_json, "\"solver_relative_tolerance\":1e-14"),
        "limited production CPU GMRES failure diagnostics reports requested tolerance");
    check(
        contains(result.diagnostics_json, "\"rhs_l2_norm\":"),
        "limited production CPU GMRES failure diagnostics reports RHS norm");
    check(
        contains(result.diagnostics_json, "\"initial_residual_l2_norm\":"),
        "limited production CPU GMRES failure diagnostics reports initial residual");
    check(
        contains(result.diagnostics_json, "\"initial_relative_residual_l2_norm\":"),
        "limited production CPU GMRES failure diagnostics reports initial relative residual");
    check(
        contains(result.diagnostics_json, "\"minimum_tracked_relative_residual_l2_norm\":"),
        "limited production CPU GMRES failure diagnostics reports minimum relative residual");
    check(
        contains(result.diagnostics_json, "\"minimum_tracked_relative_residual_iteration\":"),
        "limited production CPU GMRES failure diagnostics reports minimum residual iteration");
    check(
        contains(result.diagnostics_json, "\"last_tracked_relative_residual_l2_norm\":"),
        "limited production CPU GMRES failure diagnostics reports last tracked residual");
    check(
        contains(result.diagnostics_json, "\"last_recomputed_relative_residual_l2_norm\":"),
        "limited production CPU GMRES failure diagnostics reports last recomputed residual");
    check(
        contains(result.diagnostics_json, "\"residual_growth_factor\":"),
        "limited production CPU GMRES failure diagnostics reports residual growth");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"status\":\"solve_error\""), "GMRES failure manifest records solve_error");
    check(contains(manifest.c_str(), "\"complete\":false"), "GMRES failure manifest records incomplete state");
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "GMRES failure manifest links response diagnostics");
    check(
        contains(manifest.c_str(), "\"response_progress_v1_path\":\"response/progress.v1.json\""),
        "GMRES failure manifest links response progress");
    check(
        contains(manifest.c_str(), "\"frequency_point_paths\":[]"),
        "GMRES failure manifest does not claim completed frequency points");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(contains(diagnostics.c_str(), "\"status\":\"solve_error\""), "GMRES failure diagnostics artifact records solve_error");
    check(
        contains(diagnostics.c_str(), "\"completed_frequency_point_count\":0"),
        "GMRES failure diagnostics artifact records zero completed points");
    check(
        contains(diagnostics.c_str(), "\"restart_iterations_for_frequency\":1"),
        "GMRES failure diagnostics artifact records restart iterations");
    check(
        contains(diagnostics.c_str(), "\"solver_relative_tolerance\":1e-14"),
        "GMRES failure diagnostics artifact records requested tolerance");
    check(
        contains(diagnostics.c_str(), "\"rhs_l2_norm\":"),
        "GMRES failure diagnostics artifact records RHS norm");
    check(
        contains(diagnostics.c_str(), "\"initial_residual_l2_norm\":"),
        "GMRES failure diagnostics artifact records initial residual");
    check(
        contains(diagnostics.c_str(), "\"initial_relative_residual_l2_norm\":"),
        "GMRES failure diagnostics artifact records initial relative residual");
    check(
        contains(diagnostics.c_str(), "\"minimum_tracked_relative_residual_l2_norm\":"),
        "GMRES failure diagnostics artifact records minimum relative residual");
    check(
        contains(diagnostics.c_str(), "\"minimum_tracked_relative_residual_iteration\":"),
        "GMRES failure diagnostics artifact records minimum residual iteration");
    check(
        contains(diagnostics.c_str(), "\"last_tracked_relative_residual_l2_norm\":"),
        "GMRES failure diagnostics artifact records last tracked residual");
    check(
        contains(diagnostics.c_str(), "\"last_recomputed_relative_residual_l2_norm\":"),
        "GMRES failure diagnostics artifact records last recomputed residual");
    check(
        contains(diagnostics.c_str(), "\"residual_growth_factor\":"),
        "GMRES failure diagnostics artifact records residual growth");

    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(contains(progress.c_str(), "\"status\":\"solve_error\""), "GMRES failure progress records solve_error");
    check(contains(progress.c_str(), "\"state\":\"solve_error\""), "GMRES failure progress state records solve_error");
    check(
        contains(progress.c_str(), "\"partial_artifacts_available\":true"),
        "GMRES failure progress exposes partial artifacts");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    check(!file_exists(point_path), "GMRES failure does not write incomplete frequency point");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_matrix_free_solver_respects_temporal_phase_convention_sign()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0};
    const double mass[] = {1.0};
    const double drive_real[] = {1.0};
    double response_real[1]{};
    double response_imag[1]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 1};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                1,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                1,
                residual_l2,
                relative_residual_l2,
                1,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                -1.0,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU phase-convention solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU phase-convention solve completes one frequency");
    check(relative_residual_l2[0] < 1.0e-12, "production CPU phase-convention residual is small");
    check(std::abs(response_real[0] - 0.4) < 1.0e-12, "production CPU exp(-i omega t) response real");
    check(std::abs(response_imag[0] + 0.2) < 1.0e-12, "production CPU exp(-i omega t) response imag sign");
}

void production_cpu_matrix_free_solver_rejects_invalid_phase_convention_sign()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0};
    const double mass[] = {1.0};
    const double drive_real[] = {1.0};
    double response_real[1]{};
    double response_imag[1]{};
    DiagonalProductionOperator op{stiffness, mass, 1};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                1,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                1,
                nullptr,
                nullptr,
                0,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                0.0,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::validation_error, "production CPU rejects invalid phase sign");
    check(contains(result.error_message, "phasor convention sign"), "production CPU invalid phase sign explains error");
}

void production_cpu_matrix_free_solver_reports_progress()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz, one_over_two_pi_hz * 2.0};
    const double stiffness[] = {2.0, 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    double response_real[4]{};
    double response_imag[4]{};
    double residual_l2[2]{};
    double relative_residual_l2[2]{};
    DiagonalProductionOperator op{stiffness, mass, 2};
    ProductionProgressRecorder recorder{};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                2,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                4,
                residual_l2,
                relative_residual_l2,
                2,
                nullptr,
                nullptr,
                record_production_progress,
                &recorder,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU matrix-free progress solve succeeds");
    check(result.completed_frequency_count == 2, "production CPU progress solve completes two frequencies");
    check(recorder.event_count >= 2, "production CPU progress emits events");
    check(recorder.last_frequency_index == 1, "production CPU progress reports last frequency index");
    check(recorder.last_completed_frequency_count == 2, "production CPU progress reports completed count");
    check(recorder.last_total_frequency_count == 2, "production CPU progress reports total count");
    check(recorder.last_iteration_count > 0, "production CPU progress reports Krylov iteration");
    check(std::abs(recorder.last_frequency_hz - frequencies_hz[1]) < 1.0e-12, "production CPU progress reports frequency");
    check(recorder.last_relative_residual_l2_norm < 1.0e-12, "production CPU progress reports final residual");
    check(recorder.saw_converged, "production CPU progress reports convergence");
}

void production_cpu_matrix_free_solver_reuses_previous_frequency_solution_as_warm_start()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double single_frequency_hz[] = {one_over_two_pi_hz};
    const double repeated_frequencies_hz[] = {one_over_two_pi_hz, one_over_two_pi_hz};
    const double stiffness[] = {2.0, 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    double single_response_real[2]{};
    double single_response_imag[2]{};
    double single_residual_l2[1]{};
    double single_relative_residual_l2[1]{};
    DiagonalProductionOperator single_op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult single_result{};
    const fd::FrequencyDomainStatus single_status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                single_frequency_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &single_op,
                1.0e-12,
                16,
                4,
                single_response_real,
                single_response_imag,
                2,
                single_residual_l2,
                single_relative_residual_l2,
                1,
            },
            &single_result);

    double repeated_response_real[4]{};
    double repeated_response_imag[4]{};
    double repeated_residual_l2[2]{};
    double repeated_relative_residual_l2[2]{};
    DiagonalProductionOperator repeated_op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult repeated_result{};
    const fd::FrequencyDomainStatus repeated_status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                repeated_frequencies_hz,
                2,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &repeated_op,
                1.0e-12,
                16,
                4,
                repeated_response_real,
                repeated_response_imag,
                4,
                repeated_residual_l2,
                repeated_relative_residual_l2,
                2,
            },
            &repeated_result);

    check(single_status == fd::FrequencyDomainStatus::ok, "single-frequency warm-start baseline succeeds");
    check(repeated_status == fd::FrequencyDomainStatus::ok, "repeated-frequency warm-start solve succeeds");
    check(single_result.total_iteration_count > 0, "single-frequency baseline performs Krylov work");
    check(
        repeated_result.total_iteration_count == single_result.total_iteration_count,
        "repeated identical frequency should reuse previous solution without extra Krylov iterations");
    check(repeated_relative_residual_l2[1] < 1.0e-12, "warm-started repeated frequency residual is small");
    check(
        std::abs(repeated_response_real[2] - repeated_response_real[0]) < 1.0e-12 &&
            std::abs(repeated_response_imag[2] - repeated_response_imag[0]) < 1.0e-12,
        "warm-started repeated frequency response matches first point");
}

void production_cpu_matrix_free_solver_honors_pre_start_cancel_without_operator_work()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0, 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    double response_real[2]{};
    double response_imag[2]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                2,
                residual_l2,
                relative_residual_l2,
                1,
                cancel_immediately,
                nullptr,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::interrupted, "production CPU pre-start cancel reports interrupted");
    check(result.completed_frequency_count == 0, "production CPU pre-start cancel completes no frequencies");
    check(op.stiffness_call_count == 0, "production CPU pre-start cancel performs no stiffness work");
    check(op.mass_call_count == 0, "production CPU pre-start cancel performs no mass work");
    check(response_real[0] == 0.0 && response_real[1] == 0.0, "production CPU pre-start cancel leaves real response untouched");
    check(response_imag[0] == 0.0 && response_imag[1] == 0.0, "production CPU pre-start cancel leaves imaginary response untouched");
    check(result.error_message[0] != '\0', "production CPU pre-start cancel reports an interruption reason");
}

void production_cpu_matrix_free_solver_honors_mid_frequency_cancel_without_completion()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {2.0, 5.0};
    const double mass[] = {1.0, 3.0};
    const double drive_real[] = {1.0, 1.0};
    double response_real[2]{};
    double response_imag[2]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 2};
    CancelAfterFirstPoll cancel_state{};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-16,
                8,
                1,
                response_real,
                response_imag,
                2,
                residual_l2,
                relative_residual_l2,
                1,
                cancel_after_first_poll,
                &cancel_state,
            },
            &result);

    check(status == fd::FrequencyDomainStatus::interrupted, "production CPU mid-frequency cancel reports interrupted");
    check(result.completed_frequency_count == 0, "production CPU mid-frequency cancel completes no frequency");
    check(op.stiffness_call_count > 0, "production CPU mid-frequency cancel occurs after stiffness work starts");
    check(op.mass_call_count > 0, "production CPU mid-frequency cancel occurs after mass work starts");
    check(response_real[0] == 0.0 && response_real[1] == 0.0, "production CPU mid-frequency cancel leaves real response unpublished");
    check(response_imag[0] == 0.0 && response_imag[1] == 0.0, "production CPU mid-frequency cancel leaves imaginary response unpublished");
    check(result.error_message[0] != '\0', "production CPU mid-frequency cancel reports an interruption reason");
}

void production_cpu_matrix_free_solver_rejects_overflowing_problem_size()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz, one_over_two_pi_hz * 2.0};
    const double drive_real[] = {1.0};
    const double stiffness[] = {2.0};
    const double mass[] = {1.0};
    DiagonalProductionOperator op{stiffness, mass, 1};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                std::numeric_limits<std::uint64_t>::max(),
                frequencies_hz,
                2,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
            },
            &result);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "production CPU rejects overflowing problem size");
    check(
        contains(result.error_message, "overflows"),
        "production CPU overflow rejection explains problem size overflow");
    check(result.completed_frequency_count == 0, "overflowing production CPU solve completes no frequencies");
    check(op.stiffness_call_count == 0, "overflowing production CPU solve performs no stiffness work");
    check(op.mass_call_count == 0, "overflowing production CPU solve performs no mass work");
}

void production_cpu_matrix_free_solver_rejects_nonfinite_operator_output()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness[] = {std::numeric_limits<double>::infinity(), 4.0};
    const double mass[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};
    double response_real[2]{};
    double response_imag[2]{};
    double residual_l2[1]{};
    double relative_residual_l2[1]{};
    DiagonalProductionOperator op{stiffness, mass, 2};

    fd::ProductionCpuDrivenResponseResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_production_cpu_driven_response(
            fd::ProductionCpuDrivenResponseProblem{
                2,
                frequencies_hz,
                1,
                drive_real,
                apply_diagonal_stiffness,
                apply_diagonal_mass,
                &op,
                1.0e-12,
                16,
                4,
                response_real,
                response_imag,
                2,
                residual_l2,
                relative_residual_l2,
                1,
            },
            &result);

    check(
        status == fd::FrequencyDomainStatus::operator_error,
        "production CPU rejects non-finite matrix-free operator output");
    check(result.completed_frequency_count == 0, "non-finite operator output completes no frequencies");
    check(contains(result.error_message, "non-finite"), "non-finite operator output explains failure");
    check(response_real[0] == 0.0 && response_real[1] == 0.0, "non-finite operator output leaves real response unpublished");
    check(response_imag[0] == 0.0 && response_imag[1] == 0.0, "non-finite operator output leaves imaginary response unpublished");
}

void production_cpu_lane_does_not_fallback_to_tiny_validation_solver()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.tiny_validation_problem.enabled = true;
    request.tiny_validation_problem.tangent_dof_count = 2;
    request.tiny_validation_problem.stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_problem.mass_diagonal = mass_diagonal;
    request.tiny_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::unavailable,
        "production CPU lane without MFEM operator payload reports unavailable");
    check(result.completed_frequency_count == 0, "production CPU lane does not solve validation frequencies");
    check(contains(result.error_message, "production CPU"), "production CPU lane names missing operator payload");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_cpu\""),
        "production CPU diagnostics report lane");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":0"),
        "production CPU unavailable diagnostics report completed frequency point count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production CPU lane rejects validation fallback");
    check(
        !contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "production CPU lane does not run tiny validation solver");
    fd::release_driven_frequency_response_result(&result);

    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    fd::DrivenFrequencyResponseSolveResult gpu_result{};
    const fd::FrequencyDomainStatus gpu_status =
        fd::solve_driven_frequency_response(request, &gpu_result);

    check(
        gpu_status == fd::FrequencyDomainStatus::unavailable,
        "production GPU lane reports unavailable until a GPU frequency-domain solver exists");
    check(gpu_result.completed_frequency_count == 0, "production GPU lane does not solve validation frequencies");
    check(contains(gpu_result.error_message, "production GPU"), "production GPU lane names missing solver");
    check(
        contains(gpu_result.diagnostics_json, "\"requested_execution_lane\":\"production_gpu\""),
        "production GPU diagnostics report lane");
    check(
        contains(gpu_result.diagnostics_json, "\"completed_frequency_point_count\":0"),
        "production GPU unavailable diagnostics report completed frequency point count");
    check(
        contains(gpu_result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production GPU lane rejects validation fallback");
    check(
        !contains(gpu_result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "production GPU lane does not run tiny validation solver");
    fd::release_driven_frequency_response_result(&gpu_result);
}

void production_cpu_periodic_airbox_dynamic_demag_is_explicitly_unavailable()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::unavailable,
        "production CPU periodic-airbox dynamic demag reports unavailable until coupled block exists");
    check(
        contains(result.error_message, "periodic-airbox dynamic demag"),
        "periodic-airbox dynamic demag unavailable reason is explicit");
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "diagnostics report requested magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "diagnostics report resolved magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"magnetic_periodic_constraint_set_count\":1"),
        "diagnostics report magnetic periodic constraint count");
    check(
        contains(result.diagnostics_json, "\"magnetostatic_periodic_constraint_set_count\":1"),
        "diagnostics report magnetostatic periodic constraint count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "periodic-airbox demag request does not fall back to validation");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_writes_bc_artifacts()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-unavailable-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::unavailable,
        "periodic-airbox dynamic demag artifact run reports unavailable");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "periodic-airbox unavailable artifact run reports manifest path");
    check(
        contains(result.result_json, "frequency_domain/manifest.v1.json"),
        "periodic-airbox unavailable result JSON reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "periodic-airbox manifest links response diagnostics");
    check(
        contains(manifest.c_str(), "\"frequency_point_paths\":[\"response/frequency_points/frequency_0000.json\"]"),
        "periodic-airbox unavailable manifest links frequency point metadata");
    check(
        contains(manifest.c_str(), "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\""),
        "periodic-airbox unavailable manifest links periodic pairs artifact");
    check(
        contains(manifest.c_str(), "\"requested_spin_wave_bc\":\"periodic\""),
        "periodic-airbox unavailable manifest records requested spin-wave BC");
    check(
        contains(manifest.c_str(), "\"resolved_spin_wave_bc\":\"periodic\""),
        "periodic-airbox unavailable manifest records resolved spin-wave BC");
    check(
        contains(manifest.c_str(), "\"delta_m_tangent_dof_count\":2"),
        "periodic-airbox unavailable manifest records delta_m tangent DOFs");
    check(
        contains(manifest.c_str(), "\"delta_phi_dof_count\":1"),
        "periodic-airbox unavailable manifest records delta_phi DOFs");
    check(
        contains(manifest.c_str(), "\"coupled_complex_dof_count\":3"),
        "periodic-airbox unavailable manifest records coupled complex DOFs");
    check(
        contains(manifest.c_str(), "\"requested_magnetic_bc\":\"periodic\""),
        "periodic-airbox manifest records requested magnetic periodic BC");
    check(
        contains(manifest.c_str(), "\"resolved_magnetic_bc\":\"periodic\""),
        "periodic-airbox manifest records resolved magnetic periodic BC");
    check(
        contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox manifest records requested magnetostatic BC");
    check(
        contains(manifest.c_str(), "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox manifest records resolved magnetostatic BC");
    check(
        contains(manifest.c_str(), "\"periodic_airbox_coupled_block_solver\":false"),
        "periodic-airbox unavailable manifest records coupled-block solver is inactive");
    check(
        contains(manifest.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "periodic-airbox unavailable manifest does not claim MFEM coupled-block assembly");
    check(
        contains(manifest.c_str(), "\"dynamic_demag_operator_source\":\"unassembled_mfem_periodic_airbox_coupled_block\""),
        "periodic-airbox unavailable manifest records missing MFEM coupled-block source");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"requested_magnetic_bc\":\"periodic\""),
        "periodic-airbox diagnostics record requested magnetic periodic BC");
    check(
        contains(diagnostics.c_str(), "\"resolved_magnetic_bc\":\"periodic\""),
        "periodic-airbox diagnostics record resolved magnetic periodic BC");
    check(
        contains(diagnostics.c_str(), "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox diagnostics record requested magnetostatic BC");
    check(
        contains(diagnostics.c_str(), "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox diagnostics record resolved magnetostatic BC");
    check(
        contains(diagnostics.c_str(), "\"magnetic_periodic_constraint_set_count\":1"),
        "periodic-airbox diagnostics record magnetic periodic constraint count");
    check(
        contains(diagnostics.c_str(), "\"magnetostatic_periodic_constraint_set_count\":1"),
        "periodic-airbox diagnostics record magnetostatic periodic constraint count");
    check(
        contains(diagnostics.c_str(), "\"validation_fallback_used\":false"),
        "periodic-airbox diagnostics record no validation fallback");
    check(
        contains(diagnostics.c_str(), "\"periodic_airbox_coupled_block_solver\":false"),
        "periodic-airbox unavailable diagnostics record coupled-block solver is inactive");
    check(
        contains(diagnostics.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "periodic-airbox unavailable diagnostics do not claim MFEM coupled-block assembly");
    check(
        contains(diagnostics.c_str(), "\"dynamic_demag_operator_source\":\"unassembled_mfem_periodic_airbox_coupled_block\""),
        "periodic-airbox unavailable diagnostics record missing MFEM coupled-block source");

    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"written_frequency_point_artifacts\":1"),
        "periodic-airbox unavailable progress reports written frequency point metadata");
    check(
        contains(progress.c_str(), "\"partial_artifacts_available\":true"),
        "periodic-airbox unavailable progress reports partial artifacts");

    char periodic_pairs_path[256]{};
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string periodic_pairs = read_text_file(periodic_pairs_path);
    check(
        contains(periodic_pairs.c_str(), "\"pair_family\":\"magnetostatic_delta_phi\""),
        "periodic-airbox unavailable periodic-pair metadata records the delta_phi pair family");
    check(
        contains(periodic_pairs.c_str(), "\"unknown_family\":\"delta_phi\""),
        "periodic-airbox unavailable periodic-pair metadata records the delta_phi unknown family");
    check(
        contains(periodic_pairs.c_str(), "\"pair_id\":\"magnetostatic-delta-phi-0000\""),
        "periodic-airbox unavailable periodic-pair metadata records the magnetostatic pair id");
    check(
        contains(periodic_pairs.c_str(), "\"source_marker\":\"delta_phi_node:0\""),
        "periodic-airbox unavailable periodic-pair metadata records the delta_phi source marker");
    check(
        contains(periodic_pairs.c_str(), "\"destination_marker\":\"delta_phi_node:1\""),
        "periodic-airbox unavailable periodic-pair metadata records the delta_phi destination marker");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"status\":\"unavailable\""),
        "periodic-airbox frequency point metadata records unavailable status");
    check(
        contains(frequency_point.c_str(), "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox frequency point metadata records requested magnetostatic BC");
    check(
        contains(frequency_point.c_str(), "\"delta_m_tangent_dof_count\":2"),
        "periodic-airbox frequency point metadata records delta_m tangent DOFs");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_dof_count\":1"),
        "periodic-airbox frequency point metadata records delta_phi DOFs");
    check(
        contains(frequency_point.c_str(), "\"demag_contribution\":{\"status\":\"unavailable\""),
        "periodic-airbox frequency point metadata records unavailable demag contribution");
    check(
        contains(frequency_point.c_str(), "\"unsupported_reason\":\"periodic_airbox_dynamic_demag_coupled_block_unimplemented\""),
        "periodic-airbox frequency point metadata records coupled-block unavailable reason");
    check(
        contains(frequency_point.c_str(), "\"operator_source\":\"unassembled_mfem_periodic_airbox_coupled_block\""),
        "periodic-airbox unavailable frequency point records missing MFEM coupled-block source");
    check(
        contains(frequency_point.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "periodic-airbox unavailable frequency point does not claim MFEM coupled-block assembly");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_solves_explicit_coupled_block()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-coupled-block-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::ok,
        "production CPU periodic-airbox dynamic demag solves an explicit coupled block");
    check(result.completed_frequency_count == 1, "explicit coupled block solves the requested frequency");
    check(
        contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "explicit coupled block diagnostics report the coupled solver");
    check(
        contains(result.diagnostics_json, "\"dynamic_demag_operator_source\":\"explicit_coupled_block_payload\""),
        "explicit coupled block diagnostics identify the supplied operator source");
    check(
        contains(result.diagnostics_json, "\"mfem_coupled_block_assembly\":false"),
        "explicit coupled block diagnostics do not claim MFEM assembly");
    check(
        contains(result.diagnostics_json, "\"delta_m_tangent_dof_count\":2"),
        "explicit coupled block diagnostics record delta_m tangent DOFs");
    check(
        contains(result.diagnostics_json, "\"delta_phi_dof_count\":1"),
        "explicit coupled block diagnostics record delta_phi DOFs");
    check(
        contains(result.diagnostics_json, "\"phi_nullspace_detected\":false"),
        "explicit coupled block diagnostics do not report a phi nullspace when phi block is pinned");
    check(
        contains(result.diagnostics_json, "\"phi_gauge_policy\":\"not_required\""),
        "explicit coupled block diagnostics report gauge is not required for pinned phi block");
    check(
        contains(result.diagnostics_json, "\"phi_gauge_constraint_applied\":false"),
        "explicit coupled block diagnostics do not apply gauge for pinned phi block");
    check(
        contains(result.result_json, "\"status\":\"ok\""),
        "explicit coupled block result JSON reports ok");
    check(
        contains(result.result_json, "\"max_abs_response\""),
        "explicit coupled block result JSON reports response amplitude");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "explicit coupled block reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"status\":\"ok\""),
        "explicit coupled block manifest records ok status");
    check(
        contains(manifest.c_str(), "\"periodic_airbox_coupled_block_solver\":true"),
        "explicit coupled block manifest records solver provenance");
    check(
        contains(manifest.c_str(), "\"dynamic_demag_operator_source\":\"explicit_coupled_block_payload\""),
        "explicit coupled block manifest identifies the supplied operator source");
    check(
        contains(manifest.c_str(), "\"dynamic_demag_k_available\":false"),
        "explicit coupled block manifest does not promote dynamic demag-k availability before MFEM assembly");
    check(
        contains(manifest.c_str(), "\"phi_gauge_policy\":\"not_required\""),
        "explicit coupled block manifest records that gauge is not required");
    check(
        contains(manifest.c_str(), "\"frequency_point_paths\":[\"response/frequency_points/frequency_0000.json\"]"),
        "explicit coupled block manifest links solved frequency point metadata");
    check(
        contains(manifest.c_str(), "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\""),
        "explicit coupled block manifest links periodic-pair metadata");

    char periodic_pairs_path[256]{};
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string periodic_pairs = read_text_file(periodic_pairs_path);
    check(
        contains(periodic_pairs.c_str(), "\"source\":\"native_fem_frequency_domain_coupled_block\""),
        "explicit coupled block writes periodic-pair metadata with native coupled-block source");
    check(
        contains(periodic_pairs.c_str(), "\"magnetostatic_periodic_node_pair_count\":1"),
        "explicit coupled block periodic-pair metadata records magnetostatic node pairs");
    check(
        contains(periodic_pairs.c_str(), "\"pair_family\":\"magnetostatic_delta_phi\""),
        "explicit coupled block periodic-pair metadata records the delta_phi pair family");
    check(
        contains(periodic_pairs.c_str(), "\"unknown_family\":\"delta_phi\""),
        "explicit coupled block periodic-pair metadata records the delta_phi unknown family");
    check(
        contains(periodic_pairs.c_str(), "\"pair_id\":\"magnetostatic-delta-phi-0000\""),
        "explicit coupled block periodic-pair metadata records the magnetostatic pair id");
    check(
        contains(periodic_pairs.c_str(), "\"source_marker\":\"delta_phi_node:0\""),
        "explicit coupled block periodic-pair metadata records the delta_phi source marker");
    check(
        contains(periodic_pairs.c_str(), "\"destination_marker\":\"delta_phi_node:1\""),
        "explicit coupled block periodic-pair metadata records the delta_phi destination marker");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"status\":\"ok\""),
        "explicit coupled block frequency point records ok status");
    check(
        contains(frequency_point.c_str(), "\"demag_contribution\":{\"status\":\"solved\""),
        "explicit coupled block frequency point records solved demag contribution");
    check(
        contains(frequency_point.c_str(), "\"operator_source\":\"explicit_coupled_block_payload\""),
        "explicit coupled block frequency point identifies the supplied operator source");
    check(
        contains(frequency_point.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "explicit coupled block frequency point does not claim MFEM assembly");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_complex\""),
        "explicit coupled block frequency point records delta_phi complex response");
    check(
        contains(frequency_point.c_str(), "\"phi_gauge_policy\":\"not_required\""),
        "explicit coupled block frequency point records gauge is not required");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_requires_constraint_sets_before_coupled_block()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-missing-constraints-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};

    auto make_request = [&]() {
        fd::DrivenFrequencyResponseSolveRequest request{};
        request.solve_request.operator_request.node_count = 1;
        request.solve_request.operator_request.tangent_dof_count = 2;
        request.solve_request.operator_request.alpha = 0.01;
        request.solve_request.operator_request.gamma0 = 2.211e5;
        request.solve_request.frequencies_hz = frequencies_hz;
        request.solve_request.frequency_count = 1;
        request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
        request.requires_periodic_airbox_dynamic_demag = true;
        request.periodic_airbox_delta_m_tangent_dof_count = 2;
        request.periodic_airbox_delta_phi_dof_count = 1;
        request.periodic_airbox_coupled_block_problem.enabled = true;
        request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
        request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 1;
        request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
        request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
        request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
        request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
        return request;
    };

    {
        fd::DrivenFrequencyResponseSolveRequest request = make_request();
        request.magnetic_periodic_constraint_set_count = 0;
        request.magnetostatic_periodic_constraint_set_count = 1;

        fd::DrivenFrequencyResponseSolveResult result{};
        const fd::FrequencyDomainStatus status =
            fd::solve_driven_frequency_response(request, &result);

        check(
            status == fd::FrequencyDomainStatus::validation_error,
            "periodic-airbox coupled block rejects missing magnetic periodic constraint set");
        check(
            contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_missing_periodic_constraint_sets\""),
            "missing magnetic constraint-set rejection is machine-readable");
        check(
            !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
            "missing magnetic constraint-set rejection does not enter coupled block solver");
        fd::release_driven_frequency_response_result(&result);
    }

    {
        fd::DrivenFrequencyResponseSolveRequest request = make_request();
        request.magnetic_periodic_constraint_set_count = 1;
        request.magnetostatic_periodic_constraint_set_count = 0;
        request.output_directory = output_directory;
        request.write_partial_artifacts = true;

        fd::DrivenFrequencyResponseSolveResult result{};
        const fd::FrequencyDomainStatus status =
            fd::solve_driven_frequency_response(request, &result);

        check(
            status == fd::FrequencyDomainStatus::validation_error,
            "periodic-airbox coupled block rejects missing magnetostatic periodic constraint set");
        check(
            contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_missing_periodic_constraint_sets\""),
            "missing magnetostatic constraint-set rejection is machine-readable");
        check(
            !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
            "missing magnetostatic constraint-set rejection does not enter coupled block solver");
        check(
            contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
            "missing magnetostatic constraint-set rejection reports a manifest path");

        const std::string manifest = read_text_file(result.artifact_manifest_path);
        check(
            contains(manifest.c_str(), "\"status\":\"validation_error\""),
            "missing magnetostatic constraint-set manifest records validation error");
        check(
            contains(manifest.c_str(), "\"validation_error\":\"periodic_airbox_missing_periodic_constraint_sets\""),
            "missing magnetostatic constraint-set manifest records machine-readable validation error");
        check(
            contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
            "missing magnetostatic constraint-set manifest records requested magnetostatic BC");

        char diagnostics_path[256]{};
        std::snprintf(
            diagnostics_path,
            sizeof(diagnostics_path),
            "%s/response/diagnostics/solver.v1.json",
            output_directory);
        const std::string diagnostics = read_text_file(diagnostics_path);
        check(
            contains(diagnostics.c_str(), "\"status\":\"validation_error\""),
            "missing magnetostatic constraint-set solver diagnostics records validation error");
        check(
            contains(diagnostics.c_str(), "\"validation_error\":\"periodic_airbox_missing_periodic_constraint_sets\""),
            "missing magnetostatic constraint-set solver diagnostics records machine-readable validation error");
        fd::release_driven_frequency_response_result(&result);
    }
}

void production_cpu_periodic_airbox_dynamic_demag_requires_delta_phi_dofs()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-missing-phi-dofs-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0,
        0.0, 3.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0,
        0.0, 1.5,
    };
    const double drive_real[] = {1.0, 0.5};
    const double drive_imag[] = {0.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 0;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 0;
    request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "periodic-airbox dynamic demag rejects missing delta_phi DOFs");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_missing_delta_phi_dofs\""),
        "missing delta_phi DOF rejection is machine-readable");
    check(
        !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "missing delta_phi DOF rejection does not enter coupled block solver");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "missing delta_phi DOF rejection reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"validation_error\":\"periodic_airbox_missing_delta_phi_dofs\""),
        "missing delta_phi DOF manifest records machine-readable validation error");
    check(
        contains(manifest.c_str(), "\"delta_phi_dof_count\":0"),
        "missing delta_phi DOF manifest records zero phi DOFs");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_rejects_coupled_block_layout_mismatch()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-layout-mismatch-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.0, 0.0,
        0.0, 3.0, 0.0, 0.0,
        0.0, 0.0, 4.0, 0.0,
        0.0, 0.0, 0.0, 5.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "periodic-airbox dynamic demag rejects mismatched coupled-block layout");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_coupled_block_layout_mismatch\""),
        "coupled-block layout mismatch rejection is machine-readable");
    check(
        !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "coupled-block layout mismatch rejection does not enter coupled block solver");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "coupled-block layout mismatch rejection reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"validation_error\":\"periodic_airbox_coupled_block_layout_mismatch\""),
        "coupled-block layout mismatch manifest records machine-readable validation error");
    check(
        contains(manifest.c_str(), "\"delta_phi_dof_count\":1"),
        "coupled-block layout mismatch manifest records requested phi DOFs");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_rejects_delta_m_tangent_dof_mismatch()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-delta-m-dof-mismatch-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "periodic-airbox dynamic demag rejects delta_m tangent DOF mismatch");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_delta_m_tangent_dof_mismatch\""),
        "delta_m tangent DOF mismatch rejection is machine-readable");
    check(
        !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "delta_m tangent DOF mismatch rejection does not enter coupled block solver");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "delta_m tangent DOF mismatch rejection reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"validation_error\":\"periodic_airbox_delta_m_tangent_dof_mismatch\""),
        "delta_m tangent DOF mismatch manifest records machine-readable validation error");
    check(
        contains(manifest.c_str(), "\"delta_m_tangent_dof_count\":2"),
        "delta_m tangent DOF mismatch manifest records requested delta_m DOFs");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_solves_matrix_free_coupled_block_provider()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-matrix-free-coupled-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_diagonal[] = {2.0, 3.0, 4.0};
    const double mass_diagonal[] = {1.0, 1.5, 0.0};
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};
    DiagonalProductionOperator coupled_operator{
        stiffness_diagonal,
        mass_diagonal,
        3,
        0,
        0,
    };

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_problem.apply_stiffness = apply_diagonal_stiffness;
    request.periodic_airbox_coupled_block_problem.apply_mass = apply_diagonal_mass;
    request.periodic_airbox_coupled_block_problem.operator_user_data = &coupled_operator;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::ok,
        "production CPU periodic-airbox matrix-free coupled block provider solves");
    check(result.completed_frequency_count == 1, "matrix-free coupled block completes frequency");
    check(coupled_operator.stiffness_call_count > 0, "matrix-free coupled block calls stiffness provider");
    check(coupled_operator.mass_call_count > 0, "matrix-free coupled block calls mass provider");
    check(
        contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "matrix-free coupled block diagnostics reports coupled solver");
    check(
        contains(result.diagnostics_json, "\"dynamic_demag_operator_source\":\"matrix_free_coupled_block_provider\""),
        "matrix-free coupled block diagnostics reports provider operator source");
    check(
        contains(result.diagnostics_json, "\"phi_gauge_policy\":\"matrix_free_provider_responsibility\""),
        "matrix-free coupled block diagnostics delegates phi gauge policy to the provider");
    check(
        contains(result.diagnostics_json, "\"phi_gauge_constraint_applied\":false"),
        "matrix-free coupled block diagnostics does not apply an implicit gauge row");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"dynamic_demag_operator_source\":\"matrix_free_coupled_block_provider\""),
        "matrix-free coupled block manifest records provider operator source");
    check(
        contains(manifest.c_str(), "\"phi_gauge_policy\":\"matrix_free_provider_responsibility\""),
        "matrix-free coupled block manifest delegates phi gauge policy to the provider");
    check(
        contains(manifest.c_str(), "\"dynamic_demag_k_available\":false"),
        "matrix-free coupled block manifest does not promote dynamic demag-k availability before MFEM assembly");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"operator_source\":\"matrix_free_coupled_block_provider\""),
        "matrix-free coupled block frequency point records provider operator source");
    check(
        contains(frequency_point.c_str(), "\"phi_gauge_policy\":\"matrix_free_provider_responsibility\""),
        "matrix-free coupled block frequency point delegates phi gauge policy to the provider");
    check(
        contains(frequency_point.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "matrix-free coupled block frequency point does not claim MFEM assembly");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_complex\""),
        "matrix-free coupled block frequency point records delta_phi response");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_solves_mfem_demag_tangent_provider()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU periodic-airbox demag tangent provider frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.demag_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    const double demag_tangent_matrix[] = {
        0.5, 0.0,
        0.0, 0.25,
    };
    DemagTangentCallbackOperator demag_operator{
        demag_tangent_matrix,
        2,
        0,
    };
    const double drive_real[] = {1.0, 0.0};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-demag-tangent-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.apply_demag_tangent = apply_demag_tangent_callback;
    request.mfem_validation_problem.demag_tangent_user_data = &demag_operator;
    request.mfem_validation_problem.drive_real = drive_real;
    request.output_directory = output_directory;
    request.operator_diagnostics_json =
        "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\","
        "\"domain_mesh_mode\":\"generated_frozen_magnetic_submesh\"}";

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::ok,
        "production CPU periodic-airbox demag tangent provider solve succeeds");
    check(
        result.completed_frequency_count == 1,
        "production CPU periodic-airbox demag tangent provider completes frequency");
    check(
        demag_operator.call_count > 0,
        "production CPU periodic-airbox demag tangent provider is invoked");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "periodic-airbox demag tangent provider rejects validation fallback");
    const std::uint64_t iteration_count = extract_json_u64(
        result.diagnostics_json,
        "\"total_iteration_count\"");
    check(iteration_count > 0, "periodic-airbox demag tangent provider reports Krylov iterations");
    check(
        demag_operator.call_count == 4 + 2 * (iteration_count + 2),
        "periodic-airbox demag tangent provider is invoked for the linearity self-check, stiffness applications, and final h_demag artifact export");
    check(
        contains(result.diagnostics_json, "\"demag_tangent_operator_source\":\"matrix_free_demag_tangent_provider\""),
        "periodic-airbox demag tangent provider diagnostics report provider source");
    check(
        contains(result.diagnostics_json, "\"demag_tangent_linearity_check\":true"),
        "periodic-airbox demag tangent provider diagnostics report linearity check");
    check(
        extract_json_double(
            result.diagnostics_json,
            "\"demag_tangent_additivity_max_abs_error\"") < 1.0e-12,
        "periodic-airbox demag tangent provider additivity check is small");
    check(
        extract_json_double(
            result.diagnostics_json,
            "\"demag_tangent_homogeneity_max_abs_error\"") < 1.0e-12,
        "periodic-airbox demag tangent provider homogeneity check is small");
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox demag tangent provider diagnostics report requested magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":false"),
        "periodic-airbox demag tangent provider diagnostics do not claim coupled-block assembly");
    check(
        !contains(result.diagnostics_json, "periodic_airbox_dynamic_demag_coupled_block_unimplemented"),
        "periodic-airbox demag tangent provider does not report coupled-block unavailable");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "periodic-airbox demag tangent provider reports manifest path");
    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"spin_wave_bc\":{\"kind\":\"periodic\"}"),
        "periodic-airbox demag tangent provider manifest records public periodic spin-wave BC");
    check(
        !contains(manifest.c_str(), "\"spin_wave_bc\":{\"kind\":\"static_periodic\"}"),
        "periodic-airbox demag tangent provider manifest does not expose internal static-periodic reduction as spin-wave BC");
    check(
        contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox demag tangent provider manifest records requested magnetostatic BC");
    check(
        contains(manifest.c_str(), "\"demag_tangent_operator_source\":\"matrix_free_demag_tangent_provider\""),
        "periodic-airbox demag tangent provider manifest records provider source");
    check(
        contains(manifest.c_str(), "\"demag_tangent_linearity_check\":true"),
        "periodic-airbox demag tangent provider manifest records linearity check");
    check(
        contains(manifest.c_str(), "\"domain_mesh_mode\":\"generated_frozen_magnetic_submesh\""),
        "periodic-airbox demag tangent provider manifest records frozen magnetic submesh workflow");
    char solver_diagnostics_path[256]{};
    std::snprintf(
        solver_diagnostics_path,
        sizeof(solver_diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string solver_diagnostics = read_text_file(solver_diagnostics_path);
    check(
        !contains(solver_diagnostics.c_str(), ",,"),
        "periodic-airbox demag tangent provider solver diagnostics avoid duplicate JSON separators");
    check(
        contains(
            solver_diagnostics.c_str(),
            "\"magnetostatic_periodic_node_pair_count\":1,\"krylov_solver\""),
        "periodic-airbox demag tangent provider solver diagnostics separate periodic-airbox fields from Krylov fields");
    check(
        contains(solver_diagnostics.c_str(), "\"demag_tangent_additivity_max_abs_error\":"),
        "periodic-airbox demag tangent provider solver diagnostics records additivity error");
    check(
        contains(
            solver_diagnostics.c_str(),
            "\"domain_mesh_mode\":\"generated_frozen_magnetic_submesh\""),
        "periodic-airbox demag tangent provider solver diagnostics records frozen magnetic submesh workflow");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    check(
        contains(point.c_str(), "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "periodic-airbox demag tangent provider point records requested magnetostatic BC");
    check(
        contains(point.c_str(), "\"demag_contribution\":{\"status\":\"solved\""),
        "periodic-airbox demag tangent provider point records solved demag contribution");
    check(
        contains(point.c_str(), "\"delta_phi_complex\":null"),
        "periodic-airbox demag tangent provider point does not fake delta_phi phasor payload");
    check(
        contains(point.c_str(), "\"h_demag_complex\":["),
        "periodic-airbox demag tangent provider point records demag-field phasor payload");
    check(
        contains(point.c_str(), "\"h_demag_complex\":[["),
        "periodic-airbox demag tangent provider point records h_demag_complex as [re, im] pairs");
    check(
        !contains(point.c_str(), "\"h_demag_complex\":[{\"real\""),
        "periodic-airbox demag tangent provider point does not record h_demag_complex as real/imag objects");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_writes_solve_error_artifacts()
{
    ScopedEnvVar rtol_guard("FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL", "1e-14");
    ScopedEnvVar max_iterations_guard("FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS", "1");
    ScopedEnvVar restart_guard("FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS", "1");

    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU periodic-airbox solve-error frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.demag_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    const double demag_tangent_matrix[] = {
        0.5, 0.1, 0.0, 0.0,
        0.1, 0.25, 0.0, 0.0,
        0.0, 0.0, 0.75, 0.2,
        0.0, 0.0, 0.2, 0.4,
    };
    DemagTangentCallbackOperator demag_operator{
        demag_tangent_matrix,
        4,
        0,
    };
    const double drive_real[] = {1.0, 2.0, 3.0, 4.0};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-demag-tangent-solve-error-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 2;
    request.solve_request.operator_request.tangent_dof_count = 4;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.apply_demag_tangent = apply_demag_tangent_callback;
    request.mfem_validation_problem.demag_tangent_user_data = &demag_operator;
    request.mfem_validation_problem.drive_real = drive_real;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::solve_error,
        "production CPU periodic-airbox demag tangent provider limited GMRES reports solve_error");
    check(result.completed_frequency_count == 0, "solve-error run completes no frequencies");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "solve-error run reports manifest path");
    check(
        contains(result.result_json, "frequency_domain/manifest.v1.json"),
        "solve-error result JSON reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"status\":\"solve_error\""), "solve-error manifest records status");
    check(contains(manifest.c_str(), "\"complete\":false"), "solve-error manifest records incomplete state");
    check(
        contains(manifest.c_str(), "\"demag_tangent_operator_source\":\"matrix_free_demag_tangent_provider\""),
        "solve-error manifest records demag tangent provider source");
    check(
        contains(manifest.c_str(), "\"total_iteration_count\":1"),
        "solve-error manifest preserves iteration count");
    check(
        contains(manifest.c_str(), "\"max_iterations_for_frequency\":1"),
        "solve-error manifest preserves max-iteration limit");

    char diagnostics_path[256]{};
    char progress_path[256]{};
    char periodic_pairs_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(diagnostics.c_str(), "\"status\":\"solve_error\""),
        "solve-error diagnostics records status");
    check(
        contains(diagnostics.c_str(), "\"total_iteration_count\":1"),
        "solve-error diagnostics preserves iteration count");
    check(
        contains(diagnostics.c_str(), "\"max_iterations_for_frequency\":1"),
        "solve-error diagnostics preserves max-iteration limit");
    check(
        contains(diagnostics.c_str(), "\"relative_residual_l2_norm\":"),
        "solve-error diagnostics preserves final relative residual");
    check(
        contains(diagnostics.c_str(), "\"initial_relative_residual_l2_norm\":"),
        "solve-error diagnostics preserves initial relative residual");
    check(
        contains(diagnostics.c_str(), "\"minimum_tracked_relative_residual_l2_norm\":"),
        "solve-error diagnostics preserves minimum relative residual");
    check(
        contains(diagnostics.c_str(), "\"minimum_tracked_relative_residual_iteration\":"),
        "solve-error diagnostics preserves minimum residual iteration");
    check(
        contains(diagnostics.c_str(), "\"last_tracked_relative_residual_l2_norm\":"),
        "solve-error diagnostics preserves last tracked residual");
    check(
        contains(diagnostics.c_str(), "\"last_recomputed_relative_residual_l2_norm\":"),
        "solve-error diagnostics preserves last recomputed residual");
    check(
        contains(diagnostics.c_str(), "\"residual_growth_factor\":"),
        "solve-error diagnostics preserves residual growth factor");
    check(
        contains(progress.c_str(), "\"status\":\"solve_error\""),
        "solve-error progress records status");
    check(
        contains(progress.c_str(), "\"state\":\"solve_error\""),
        "solve-error progress records solve_error state");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":0"),
        "solve-error progress records zero completed points");
    check(
        file_exists(periodic_pairs_path),
        "solve-error run still writes periodic-pair metadata");

    fd::release_driven_frequency_response_result(&result);
}

void production_gpu_periodic_airbox_dynamic_demag_rejects_explicit_coupled_block()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-gpu-unsupported-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::unavailable,
        "production GPU periodic-airbox dynamic demag rejects explicit CPU coupled block payload");
    check(result.completed_frequency_count == 0, "GPU periodic-airbox rejection solves no frequencies");
    check(
        contains(result.error_message, "production GPU"),
        "GPU periodic-airbox rejection names the GPU lane");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_gpu\""),
        "GPU periodic-airbox diagnostics preserve requested GPU lane");
    check(
        contains(result.diagnostics_json, "\"unsupported_reason\":\"periodic_airbox_dynamic_demag_gpu_unsupported\""),
        "GPU periodic-airbox diagnostics report periodic-airbox demag GPU unsupported reason");
    check(
        !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "GPU periodic-airbox rejection does not run the CPU explicit coupled block solver");

    char manifest_path[256]{};
    char diagnostics_path[256]{};
    std::snprintf(
        manifest_path,
        sizeof(manifest_path),
        "%s/frequency_domain/manifest.v1.json",
        output_directory);
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string manifest = read_text_file(manifest_path);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(manifest.c_str(), "\"requested_execution_lane\":\"production_gpu\""),
        "GPU periodic-airbox manifest preserves requested GPU lane");
    check(
        contains(manifest.c_str(), "\"resolved_execution_lane\":\"unavailable\""),
        "GPU periodic-airbox manifest records unavailable resolved lane");
    check(
        contains(diagnostics.c_str(), "\"resolved_execution_lane\":\"unavailable\""),
        "GPU periodic-airbox artifact diagnostics record unavailable resolved lane");
    check(
        contains(diagnostics.c_str(), "\"validation_fallback_used\":false"),
        "GPU periodic-airbox artifact diagnostics record no validation fallback");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"unsupported_reason\":\"periodic_airbox_dynamic_demag_gpu_unsupported\""),
        "GPU periodic-airbox frequency point records GPU unsupported reason");
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_runs_assembled_mfem_validation_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "boundary assembled MFEM validation frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "boundary assembled MFEM validation solve succeeds");
    check(result.completed_frequency_count == 1, "boundary assembled MFEM validation completes frequency");
    check(
        contains(result.result_json, "\"max_abs_response\":0.666666666666666"),
        "boundary assembled MFEM validation result JSON reports operator response");
    check(
        contains(result.diagnostics_json, "\"assembled_mfem_operator_solver\":true"),
        "boundary assembled MFEM validation diagnostics reports assembled operator solver");
    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_runs_assembled_mfem_dmi_validation_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "assembled MFEM DMI validation frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    fd::MfemDmiElementTangentData dmi_element{};
    fill_bulk_dmi_tetra_element(dmi_element, d, volume);
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    const double drive_real[] = {1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 4;
    request.solve_request.operator_request.tangent_dof_count = 8;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.dmi_elements = &dmi_element;
    request.mfem_validation_problem.dmi_element_count = 1;
    request.mfem_validation_problem.dmi_lumped_mass = lumped_mass_per_node;
    request.mfem_validation_problem.dmi_uniform_ms = ms;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "assembled MFEM DMI validation solve succeeds");
    check(result.completed_frequency_count == 1, "assembled MFEM DMI validation completes frequency");
    check(
        contains(result.diagnostics_json, "\"assembled_mfem_operator_solver\":true"),
        "assembled MFEM DMI validation diagnostics reports assembled solver");
    check(
        contains(result.result_json, "\"max_abs_response\""),
        "assembled MFEM DMI validation result reports response");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_periodic_airbox_dynamic_demag_applies_mean_zero_gauge_for_phi_nullspace()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const std::uint64_t magnetostatic_periodic_node_pairs[] = {0, 1};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-periodic-airbox-gauge-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.1, -0.1,
        0.0, 3.0, 0.2, -0.2,
        0.1, 0.2, 1.0, -1.0,
        -0.1, -0.2, -1.0, 1.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.0, 0.0, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 2.211e5;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.requires_periodic_airbox_dynamic_demag = true;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs =
        magnetostatic_periodic_node_pairs;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_problem.enabled = true;
    request.periodic_airbox_coupled_block_problem.delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.delta_phi_dof_count = 2;
    request.periodic_airbox_coupled_block_problem.stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_problem.mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_problem.drive_real = drive_real;
    request.periodic_airbox_coupled_block_problem.drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(
        status == fd::FrequencyDomainStatus::ok,
        "production CPU periodic-airbox explicit coupled block applies mean-zero gauge for phi nullspace");
    check(
        contains(result.diagnostics_json, "\"phi_nullspace_detected\":true"),
        "periodic-airbox gauge diagnostics report detected phi nullspace");
    check(
        contains(result.diagnostics_json, "\"phi_gauge_policy\":\"mean_zero\""),
        "periodic-airbox gauge diagnostics report mean-zero policy");
    check(
        contains(result.diagnostics_json, "\"phi_gauge_constraint_applied\":true"),
        "periodic-airbox gauge diagnostics report applied mean-zero constraint");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"phi_gauge_policy\":\"mean_zero\""),
        "periodic-airbox gauge manifest records mean-zero policy");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"phi_gauge_policy\":\"mean_zero\""),
        "periodic-airbox gauge frequency point records mean-zero policy");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_complex\""),
        "periodic-airbox gauge frequency point records solved delta_phi response");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_runs_mfem_matrix_free_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU MFEM frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU MFEM matrix-free solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU MFEM matrix-free solve completes frequency");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_cpu\""),
        "production CPU MFEM result reports lane");
    check(
        contains(result.result_json, "\"max_abs_response\":0.666666666666666"),
        "production CPU MFEM result reports operator response");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "production CPU MFEM diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"krylov_solver\":\"gmres\""),
        "production CPU MFEM diagnostics report GMRES");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":1"),
        "production CPU MFEM diagnostics report completed frequency point count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production CPU MFEM diagnostics reject validation fallback");
    check(
        contains(result.diagnostics_json, "\"assembled_mfem_operator_solver\":false"),
        "production CPU MFEM diagnostics reject dense assembly path");
    fd::release_driven_frequency_response_result(&result);
}

void production_gpu_lane_runs_mfem_no_demag_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production GPU MFEM frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.operator_request.strict_gpu = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_gpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

#if FULLMAG_HAS_CUDA_RUNTIME
    check(status == fd::FrequencyDomainStatus::ok, "production GPU MFEM no-demag solve succeeds");
    check(result.completed_frequency_count == 1, "production GPU MFEM no-demag solve completes frequency");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_gpu\""),
        "production GPU MFEM result reports requested lane");
    check(
        contains(result.result_json, "\"resolved_execution_lane\":\"production_gpu\""),
        "production GPU MFEM result reports resolved lane");
    check(
        contains(result.result_json, "\"max_abs_response\":0.666666666666666"),
        "production GPU MFEM result reports operator response");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production GPU MFEM diagnostics reject validation fallback");
    check(
        contains(result.diagnostics_json, "\"dense_block_real_solver\":false"),
        "production GPU MFEM diagnostics reject dense validation solver");
    check(
        contains(result.diagnostics_json, "\"resolved_execution_lane\":\"production_gpu\""),
        "production GPU MFEM diagnostics report resolved GPU lane");
    check(
        contains(result.diagnostics_json, "\"operator_terms_included\":[\"zeeman\"]"),
        "production GPU MFEM diagnostics report included operator terms");
#else
    check(status == fd::FrequencyDomainStatus::unavailable, "non-CUDA production GPU solve is unavailable");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "non-CUDA production GPU diagnostics reject validation fallback");
#endif
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_runs_mfem_matrix_free_explicit_demag_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU explicit demag MFEM frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.demag_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double demag_tangent_matrix[] = {
        0.5, 0.0,
        0.0, 0.25,
    };
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.demag_tangent_matrix_row_major = demag_tangent_matrix;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU MFEM explicit demag matrix-free solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU MFEM explicit demag solve completes frequency");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "production CPU MFEM explicit demag diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production CPU MFEM explicit demag diagnostics reject validation fallback");
    check(
        contains(result.result_json, "\"status\":\"ok\""),
        "production CPU MFEM explicit demag result reports ok");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_runs_mfem_matrix_free_demag_callback_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU demag callback MFEM frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.demag_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double demag_tangent_matrix[] = {
        0.5, 0.0,
        0.0, 0.25,
    };
    DemagTangentCallbackOperator demag_operator{
        demag_tangent_matrix,
        2,
        0,
    };
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.apply_demag_tangent = apply_demag_tangent_callback;
    request.mfem_validation_problem.demag_tangent_user_data = &demag_operator;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU MFEM demag callback solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU MFEM demag callback completes frequency");
    const std::uint64_t iteration_count = extract_json_u64(
        result.diagnostics_json,
        "\"total_iteration_count\"");
    check(iteration_count > 0, "production CPU MFEM demag callback reports Krylov iterations");
    check(
        demag_operator.call_count == 4 + 2 * (iteration_count + 1),
        "production CPU MFEM demag callback is invoked for the linearity self-check and stiffness applications");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "production CPU MFEM demag callback diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production CPU MFEM demag callback diagnostics reject validation fallback");
    check(
        contains(result.result_json, "\"status\":\"ok\""),
        "production CPU MFEM demag callback result reports ok");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_rejects_nonfinite_zeeman_field_before_matrix_free_solve()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU non-finite Zeeman field frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, std::numeric_limits<double>::infinity()};
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::validation_error, "production CPU MFEM non-finite Zeeman field reports validation_error");
    check(result.completed_frequency_count == 0, "production CPU MFEM non-finite Zeeman field completes no frequencies");
    check(contains(result.error_message, "finite"), "production CPU MFEM non-finite Zeeman field explains finite field requirement");
    check(
        contains(result.result_json, "\"status\":\"validation_error\""),
        "production CPU MFEM non-finite Zeeman field result JSON reports status");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_cpu\""),
        "production CPU MFEM non-finite Zeeman field result JSON reports lane");
    check(
        contains(result.diagnostics_json, "\"status\":\"validation_error\""),
        "production CPU MFEM non-finite Zeeman field diagnostics reports status");
    check(
        contains(result.diagnostics_json, "\"production_solver_available\":true"),
        "production CPU MFEM non-finite Zeeman field diagnostics keeps solver availability");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "production CPU MFEM non-finite Zeeman field diagnostics keeps matrix-free solver provenance");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production CPU MFEM non-finite Zeeman field diagnostics rejects validation fallback");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":0"),
        "production CPU MFEM non-finite Zeeman field diagnostics reports completed count");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_runs_mfem_matrix_free_dmi_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU MFEM DMI frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    fd::MfemDmiElementTangentData dmi_element{};
    fill_bulk_dmi_tetra_element(dmi_element, d, volume);
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    const double drive_real[] = {1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 4;
    request.solve_request.operator_request.tangent_dof_count = 8;
    request.solve_request.operator_request.alpha = 0.01;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.dmi_elements = &dmi_element;
    request.mfem_validation_problem.dmi_element_count = 1;
    request.mfem_validation_problem.dmi_lumped_mass = lumped_mass_per_node;
    request.mfem_validation_problem.dmi_uniform_ms = ms;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU MFEM DMI matrix-free solve succeeds");
    check(result.completed_frequency_count == 1, "production CPU MFEM DMI matrix-free solve completes frequency");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "production CPU MFEM DMI diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "production CPU MFEM DMI diagnostics reject validation fallback");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_cpu\""),
        "production CPU MFEM DMI result reports lane");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_accepts_more_than_sixteen_frequency_points()
{
    double frequencies_hz[17]{};
    for (std::uint64_t index = 0; index < 17; ++index) {
        frequencies_hz[index] = 0.1 + static_cast<double>(index) * 0.01;
    }
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU multi-frequency frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 17;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU multi-frequency solve succeeds");
    check(result.completed_frequency_count == 17, "production CPU completes more than sixteen frequencies");
    check(
        contains(result.result_json, "\"completed_frequency_count\":17"),
        "production CPU multi-frequency result reports all points");
    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_writes_matrix_free_response_artifacts()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU artifact frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-production-cpu-artifact-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&node)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "production CPU artifact solve succeeds");
    check(result.written_frequency_point_artifacts == 1, "production CPU artifact solve records durable point");
    check(contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"), "production CPU reports manifest path");
    check(contains(result.result_json, "\"artifact_manifest_path\":\"/tmp/"), "production CPU result reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"revision\":\"production-cpu-matrix-free-v1\""),
        "production CPU manifest reports production revision");
    check(
        contains(manifest.c_str(), "\"reference_or_production\":\"production\""),
        "production CPU manifest reports production classification");
    check(
        contains(manifest.c_str(), "\"solver_model\":\"matrix_free_gmres\""),
        "production CPU manifest reports GMRES model");
    check(
        contains(manifest.c_str(), "\"production_native_solver_available\":true"),
        "production CPU manifest reports native production availability");
    check(
        contains(manifest.c_str(), "\"validation_artifact\":false"),
        "production CPU manifest is not marked validation artifact");

    char sweep_v2_path[256]{};
    char sweep_v1_path[256]{};
    char payload_path[256]{};
    std::snprintf(
        sweep_v1_path,
        sizeof(sweep_v1_path),
        "%s/response/magnetic_response_sweep.v1.json",
        output_directory);
    std::snprintf(
        sweep_v2_path,
        sizeof(sweep_v2_path),
        "%s/response/magnetic_response_sweep.v2.json",
        output_directory);
    std::snprintf(
        payload_path,
        sizeof(payload_path),
        "%s/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
        output_directory);
    const std::string sweep_v1 = read_text_file(sweep_v1_path);
    check(
        contains(sweep_v1.c_str(), "\"solver_model\":\"matrix_free_gmres\""),
        "production CPU v1 response sweep reports GMRES solver model");
    check(
        contains(sweep_v1.c_str(), "\"lane_classification\":\"fem_cpu_production\""),
        "production CPU v1 response sweep reports production lane");
    check(
        contains(sweep_v1.c_str(), "\"matrix_layout\":\"matrix_free_block_real\""),
        "production CPU v1 response sweep reports matrix-free layout");
    check(
        contains(sweep_v1.c_str(), "\"residual_source\":\"matrix_free_gmres\""),
        "production CPU v1 response sweep reports matrix-free residual source");
    check(
        contains(sweep_v1.c_str(), "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":0"),
        "production CPU v1 response sweep reports field excitation phase provenance");
    check(
        contains(sweep_v1.c_str(), "\"sweep_reuse\":{\"operator_template_reused\":true"),
        "production CPU v1 response sweep reports sweep reuse provenance");
    const std::string sweep_v2 = read_text_file(sweep_v2_path);
    check(
        contains(sweep_v2.c_str(), "\"response_field_payload_path\":\"response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0\""),
        "production CPU sweep links Zarr spatial field payload");
    check(
        contains(sweep_v2.c_str(), "\"response_tangent_field_payload_path\":\"response/field_payloads.zarr/frequency_0000/vector_tangent_complex/0.0.0\""),
        "production CPU sweep keeps Zarr tangent field payload link");
    check(file_exists(payload_path), "production CPU writes field payload");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    check(
        contains(point.c_str(), "\"field_payload_path\":\"response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0\""),
        "production CPU point metadata links Zarr spatial payload");
    check(
        contains(point.c_str(), "\"tangent_field_payload_path\":\"response/field_payloads.zarr/frequency_0000/vector_tangent_complex/0.0.0\""),
        "production CPU point metadata links Zarr tangent payload");
    check(
        contains(point.c_str(), "\"storage_format\":\"zarr\""),
        "production CPU point metadata records Zarr storage format");
    check(
        contains(point.c_str(), "\"compatibility_binary_payload_path\":\"response/field_payloads/frequency_0000/vector_xyz.bin\""),
        "production CPU point metadata keeps compatibility binary payload link");
    check(
        contains(point.c_str(), "\"value_kind\":\"complex_spatial_vector\""),
        "production CPU point metadata records spatial value kind");
    check(
        contains(point.c_str(), "\"component_basis\":\"global_xyz\""),
        "production CPU point metadata records spatial basis");
    check(
        contains(point.c_str(), "\"component_count\":3"),
        "production CPU point metadata records xyz component count");
    check(
        contains(point.c_str(), "\"binary_layout\":\"complex_f64_pairs_little_endian\""),
        "production CPU point metadata records complex binary layout");
    check(
        contains(point.c_str(), "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"]"),
        "production CPU point metadata records all complex field views");
    check(
        contains(point.c_str(), "\"default_view\":\"phase_rotated_real\""),
        "production CPU point metadata records animated phase view as default");
    check(
        contains(point.c_str(), "\"default_phase_rad\":0.0"),
        "production CPU point metadata records default phase angle");
    check(
        contains(point.c_str(), "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":0"),
        "production CPU point metadata records drive phasor provenance");
    check(
        contains(point.c_str(), "\"sweep_reuse\":{\"operator_template_reused\":true"),
        "production CPU point metadata records sweep reuse provenance");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_writes_large_matrix_free_field_payload()
{
    constexpr std::uint64_t node_count = 9;
    constexpr std::uint64_t tangent_dof_count = node_count * 2;
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    double equilibrium[node_count * 3]{};
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        equilibrium[node_index * 3 + 2] = 1.0;
    }
    fd::TangentFrameNode nodes[node_count]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, node_count, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "large production CPU artifact frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = node_count;
    descriptor.full_dof_count = node_count * 3;
    descriptor.tangent_dof_count = tangent_dof_count;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = node_count;
    layout.full_dof_count = node_count * 3;
    layout.tangent_dof_count = tangent_dof_count;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    double drive_real[tangent_dof_count]{};
    for (std::uint64_t dof = 0; dof < tangent_dof_count; ++dof) {
        drive_real[dof] = dof % 2 == 0 ? 1.0 : 0.25;
    }

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-production-cpu-large-artifact-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&nodes)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = node_count;
    request.solve_request.operator_request.tangent_dof_count = tangent_dof_count;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = true;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = nodes;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    if (status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(
            stderr,
            "large production CPU artifact solve status=%s error=%s diagnostics=%s\n",
            fd::status_to_string(status),
            result.error_message != nullptr ? result.error_message : "",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "");
    }
    check(status == fd::FrequencyDomainStatus::ok, "large production CPU artifact solve succeeds");
    check(result.written_frequency_point_artifacts == 1, "large production CPU artifact solve records durable point");

    char payload_path[256]{};
    std::snprintf(
        payload_path,
        sizeof(payload_path),
        "%s/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
        output_directory);
    check(file_exists(payload_path), "large production CPU writes spatial field payload");
    check(
        file_size_bytes(payload_path) == static_cast<long>(node_count * 3 * 2 * sizeof(double)),
        "large production CPU field payload keeps all complex xyz components");

    char tangent_payload_path[256]{};
    std::snprintf(
        tangent_payload_path,
        sizeof(tangent_payload_path),
        "%s/response/field_payloads.zarr/frequency_0000/vector_tangent_complex/0.0.0",
        output_directory);
    check(file_exists(tangent_payload_path), "large production CPU keeps tangent field payload");
    check(
        file_size_bytes(tangent_payload_path) == static_cast<long>(tangent_dof_count * 2 * sizeof(double)),
        "large production CPU tangent payload keeps all complex tangent components");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_writes_multi_point_matrix_free_response_artifacts()
{
    constexpr std::uint64_t frequency_count = 24;
    double frequencies_hz[frequency_count]{};
    for (std::uint64_t index = 0; index < frequency_count; ++index) {
        frequencies_hz[index] = 0.1 + static_cast<double>(index) * 0.01;
    }
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "multi-point production CPU artifact frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-production-cpu-multipoint-artifact-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&node)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = frequency_count;
    request.solve_request.write_response_fields = false;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    if (status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(
            stderr,
            "multi-point production CPU artifact solve status=%s error=%s diagnostics=%s\n",
            fd::status_to_string(status),
            result.error_message != nullptr ? result.error_message : "",
            result.diagnostics_json != nullptr ? result.diagnostics_json : "");
    }
    check(status == fd::FrequencyDomainStatus::ok, "multi-point production CPU artifact solve succeeds");
    check(result.written_frequency_point_artifacts == frequency_count, "multi-point production CPU writes all point artifacts");

    char sweep_v2_path[256]{};
    std::snprintf(
        sweep_v2_path,
        sizeof(sweep_v2_path),
        "%s/response/magnetic_response_sweep.v2.json",
        output_directory);
    const std::string sweep_v2 = read_text_file(sweep_v2_path);
    check(
        contains(sweep_v2.c_str(), "\"completed_frequency_point_count\":24"),
        "multi-point production CPU sweep v2 records completed point count");
    check(
        contains(sweep_v2.c_str(), "response/frequency_points/frequency_0023.json"),
        "multi-point production CPU sweep v2 links final point artifact");

    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_writes_minimal_assembled_validation_artifacts()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double half_over_two_pi_hz = 0.07957747154594767;
    const double frequencies_hz[] = {one_over_two_pi_hz, half_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "artifact assembled MFEM validation frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-artifact-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&node)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 2;
    request.solve_request.write_response_fields = true;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "assembled validation artifact solve succeeds");
    check(result.written_frequency_point_artifacts == 2, "assembled validation artifact solve records durable points");
    check(contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"), "assembled validation reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"schema_version\":\"frequency_domain_manifest.v1\""), "manifest schema is written");
    check(contains(manifest.c_str(), "\"stage_kind\":\"frequency_response\""), "manifest records response stage");
    check(contains(manifest.c_str(), "response/magnetic_response_sweep.v1.json"), "manifest links response sweep");
    check(contains(manifest.c_str(), "\"point_count\":2"), "manifest records response point count");
    check(contains(manifest.c_str(), "\"completed_frequency_point_count\":2"), "manifest records completed frequency point count");
    check(
        contains(manifest.c_str(), "\"response_sweep_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep\""),
        "manifest records response sweep resource key");
    check(contains(manifest.c_str(), "\"resolved_execution\""), "manifest records resolved execution block");
    check(contains(manifest.c_str(), "\"solver_kind\":\"assembled_validation_dense_block_real\""), "manifest records validation solver kind");
    check(contains(manifest.c_str(), "\"validation_solver_available\":true"), "manifest records validation solver capability");
    check(contains(manifest.c_str(), "\"production_solver_available\":false"), "manifest records production solver unavailable");
    check(contains(manifest.c_str(), "\"requested_execution\""), "manifest records requested execution");
    check(contains(manifest.c_str(), "\"solve_equation\":\"(i omega B - L) q = f\""), "manifest records solve equation");
    check(contains(manifest.c_str(), "\"response_sweep_v2_path\":\"response/magnetic_response_sweep.v2.json\""), "manifest links response sweep v2");
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "manifest links response diagnostics v1");
    check(
        contains(manifest.c_str(), "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\""),
        "manifest links solver diagnostics");
    check(contains(manifest.c_str(), "\"frequency_point_paths\""), "manifest links frequency-point metadata");
    check(contains(manifest.c_str(), "response/frequency_points/frequency_0001.json"), "manifest links second frequency-point metadata");
    check(contains(manifest.c_str(), "\"response_field_resources\""), "manifest links response field payload resources");
    check(
        contains(manifest.c_str(), "\"field_resource_id\":\"analysis:frequency-response:frequency-0001\""),
        "manifest response field resources include data-plane field id");
    check(
        contains(manifest.c_str(), "\"payload_path\":\"response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0\""),
        "manifest response field resources include payload path");
    check(contains(manifest.c_str(), "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"), "manifest links second Zarr spatial field payload resource");

    char sweep_path[256]{};
    std::snprintf(
        sweep_path,
        sizeof(sweep_path),
        "%s/response/magnetic_response_sweep.v1.json",
        output_directory);
    const std::string sweep = read_text_file(sweep_path);
    check(contains(sweep.c_str(), "\"schema_version\":\"magnetic_response_sweep.v1\""), "response sweep schema is written");
    check(contains(sweep.c_str(), "\"point_count\":2"), "response sweep records point count");
    check(contains(sweep.c_str(), "\"frequency_hz\":0.15915494309189535"), "response sweep records first frequency point");
    check(contains(sweep.c_str(), "\"frequency_hz\":0.079577471545947"), "response sweep records second frequency point");
    check(contains(sweep.c_str(), "\"response_amplitude\":0.666666666666666"), "response sweep records amplitude");
    check(contains(sweep.c_str(), "\"response_phase\":3.141592653589793"), "response sweep records phase of max component");
    check(contains(sweep.c_str(), "\"phase_rad\":3.141592653589793"), "response sweep records scalar chart phase");
    check(contains(sweep.c_str(), "\"m_complex\":[[0,-0.333333333333333"), "response sweep records first complex tangent component");
    check(contains(sweep.c_str(), "[-0.666666666666666"), "response sweep records second complex tangent component");
    check(contains(sweep.c_str(), "\"component_response_amplitude\":[0.333333333333333"), "response sweep records component amplitudes");
    check(contains(sweep.c_str(), "\"component_response_phase\":[-1.570796326794896"), "response sweep records first component phase");
    check(contains(sweep.c_str(), "\"residual_source\":\"dense_block_real\""), "response sweep records residual source");
    check(
        contains(sweep.c_str(), "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":0"),
        "response sweep records field excitation phase provenance");
    check(
        contains(sweep.c_str(), "\"sweep_reuse\":{\"operator_template_reused\":true"),
        "response sweep records sweep reuse provenance");
    check(
        contains(sweep.c_str(), "\"kind\":\"previous_frequency_response\""),
        "response sweep records previous-frequency warm-start provenance");
    check(!contains(sweep.c_str(), "\"residual_l2_norm\":0.0"), "response sweep does not hardcode zero residual");
    check(
        contains(sweep.c_str(), "\"susceptibility_tensor\":[["),
        "response sweep records non-empty drive-projected susceptibility");
    check(
        !contains(sweep.c_str(), "\"susceptibility_tensor\":[]"),
        "response sweep does not emit an empty susceptibility placeholder");
    check(
        contains(sweep.c_str(), "\"susceptibility_tensor_provenance\":{\"kind\":\"drive_projected_scalar\""),
        "response sweep records susceptibility provenance");
    check(
        contains(sweep.c_str(), "\"absorbed_power_density_provenance\":{\"kind\":\"drive_projected_absorption_proxy\""),
        "response sweep records absorbed power provenance");
    check(
        contains(sweep.c_str(), "\"tangent_leakage\":{\"status\":\"evaluated\""),
        "response sweep records evaluated tangent leakage");
    check(
        !contains(sweep.c_str(), "\"tangent_leakage\":{\"status\":\"not_evaluated\""),
        "response sweep does not emit unevaluated tangent leakage placeholder");

    char sweep_v2_path[256]{};
    std::snprintf(
        sweep_v2_path,
        sizeof(sweep_v2_path),
        "%s/response/magnetic_response_sweep.v2.json",
        output_directory);
    const std::string sweep_v2 = read_text_file(sweep_v2_path);
    check(contains(sweep_v2.c_str(), "\"schema_version\":\"magnetic_response_sweep.v2\""), "response sweep v2 schema is written");
    check(contains(sweep_v2.c_str(), "\"solve_kind\":\"direct_harmonic_response\""), "response sweep v2 records solve kind");
    check(contains(sweep_v2.c_str(), "\"complete\":true"), "response sweep v2 records completion");
    check(
        contains(sweep_v2.c_str(), "\"completed_frequency_point_count\":2"),
        "response sweep v2 records completed point count");
    check(contains(sweep_v2.c_str(), "\"frequency_index\":1"), "response sweep v2 records per-point frequency index");
    check(
        contains(sweep_v2.c_str(), "\"frequency_point_artifact_path\":\"response/frequency_points/frequency_0001.json\""),
        "response sweep v2 records per-point metadata path");
    check(
        contains(sweep_v2.c_str(), "\"response_field_payload_path\":\"response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0\""),
        "response sweep v2 records per-point Zarr spatial field payload path");
    check(contains(sweep_v2.c_str(), "response/frequency_points/frequency_0001.json"), "response sweep v2 links second point");
    check(contains(sweep_v2.c_str(), "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"), "response sweep v2 links second Zarr spatial payload");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"schema_version\":\"frequency_domain_response_diagnostics.v1\""),
        "response diagnostics records schema");
    check(contains(diagnostics.c_str(), "\"status\":\"ready\""), "response diagnostics records ready status");
    check(contains(diagnostics.c_str(), "\"complete\":true"), "response diagnostics records completion");
    check(
        contains(diagnostics.c_str(), "\"assembled_mfem_operator_solver\":true"),
        "response diagnostics records assembled validation solver");
    check(
        contains(diagnostics.c_str(), "\"dense_block_real_solver\":true"),
        "response diagnostics records dense validation solver");
    check(
        contains(diagnostics.c_str(), "\"matrix_free_solver\":false"),
        "response diagnostics records matrix-free solver disabled for validation lane");
    check(
        contains(diagnostics.c_str(), "\"krylov_solver\":\"none\""),
        "response diagnostics records no Krylov solver for validation lane");
    check(
        contains(diagnostics.c_str(), "\"completed_frequency_point_count\":2"),
        "response diagnostics records completed point count");
    check(
        contains(diagnostics.c_str(), "\"relative_residual_l2_norm\""),
        "response diagnostics records relative residual");

    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"schema_version\":\"frequency_domain_sweep_progress.v1\""),
        "response progress records schema");
    check(contains(progress.c_str(), "\"status\":\"ready\""), "response progress records ready status");
    check(contains(progress.c_str(), "\"complete\":true"), "response progress records completion");
    check(contains(progress.c_str(), "\"state\":\"completed\""), "response progress records completed state");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":2"),
        "response progress records total points");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":2"),
        "response progress records completed points");
    check(
        contains(progress.c_str(), "\"written_frequency_point_artifacts\":2"),
        "response progress records written points");
    check(
        contains(progress.c_str(), "\"partial_artifacts_available\":true"),
        "response progress records available completed artifacts");
    check(
        contains(progress.c_str(), "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\""),
        "response progress records latest manifest path");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    check(
        contains(point.c_str(), "\"schema_version\":\"frequency_response_point.v1\""),
        "frequency point metadata schema is written");
    check(contains(point.c_str(), "\"frequency_index\":0"), "frequency point metadata records index");
    check(
        contains(point.c_str(), "\"field_payload_path\":\"response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0\""),
        "frequency point metadata links Zarr spatial field payload");
    check(
        contains(point.c_str(), "\"angular_frequency_rad_per_s\":1"),
        "frequency point metadata records angular frequency");
    check(
        contains(point.c_str(), "\"m_complex\":[[0,-0.333333333333333"),
        "frequency point metadata records complex tangent response");
    check(
        contains(point.c_str(), "\"response_amplitude\":0.666666666666666"),
        "frequency point metadata records scalar response amplitude");
    check(
        contains(point.c_str(), "\"response_phase\":3.141592653589793"),
        "frequency point metadata records scalar response phase");
    check(
        contains(point.c_str(), "\"component_response_amplitude\":[0.333333333333333"),
        "frequency point metadata records component response amplitudes");
    check(
        contains(point.c_str(), "\"component_response_phase\":[-1.570796326794896"),
        "frequency point metadata records component response phases");
    check(
        contains(point.c_str(), "\"tangent_field_payload_path\":\"response/field_payloads.zarr/frequency_0000/vector_tangent_complex/0.0.0\""),
        "frequency point metadata links Zarr tangent field payload");
    check(
        contains(point.c_str(), "\"binary_layout\":\"complex_f64_pairs_little_endian\""),
        "frequency point metadata records binary layout");
    check(
        contains(point.c_str(), "\"value_kind\":\"complex_spatial_vector\""),
        "frequency point metadata records spatial value kind");
    check(
        contains(point.c_str(), "\"component_basis\":\"global_xyz\""),
        "frequency point metadata records global xyz basis");
    check(
        contains(point.c_str(), "\"component_count\":3"),
        "frequency point metadata records xyz component count");
    check(
        contains(point.c_str(), "\"components\":[\"x\",\"y\",\"z\"]"),
        "frequency point metadata records xyz component labels");
    check(
        contains(point.c_str(), "\"complex_pair_count\":3"),
        "frequency point metadata records complex pair count");
    check(
        contains(point.c_str(), "\"payload_value_count\":6"),
        "frequency point metadata records payload scalar count");
    check(
        contains(point.c_str(), "\"default_view\":\"phase_rotated_real\""),
        "frequency point metadata records default vector view");
    check(
        contains(point.c_str(), "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"]"),
        "frequency point metadata records all supported complex field views");
    check(
        contains(point.c_str(), "\"default_phase_rad\":0.0"),
        "frequency point metadata records default phase angle for animated overlays");
    check(
        contains(point.c_str(), "\"susceptibility_tensor\":[["),
        "frequency point metadata records non-empty susceptibility summary");
    check(
        contains(point.c_str(), "\"susceptibility_tensor_provenance\":{\"kind\":\"drive_projected_scalar\""),
        "frequency point metadata records susceptibility provenance");
    check(
        contains(point.c_str(), "\"absorbed_power_density_provenance\":{\"kind\":\"drive_projected_absorption_proxy\""),
        "frequency point metadata records absorbed power provenance");
    check(
        contains(point.c_str(), "\"residual_l2_norm\":"),
        "frequency point metadata records residual norm");
    check(
        contains(point.c_str(), "\"relative_residual_l2_norm\":"),
        "frequency point metadata records relative residual norm");
    check(
        contains(point.c_str(), "\"residual_source\":\"dense_block_real\""),
        "frequency point metadata records residual source");
    check(
        contains(point.c_str(), "\"tangent_leakage\":{\"status\":\"evaluated\""),
        "frequency point metadata records evaluated tangent leakage");
    check(
        contains(point.c_str(), "\"excitation_provenance\":{\"kind\":\"field\",\"phase_rad\":0"),
        "frequency point metadata records drive phasor provenance");
    check(
        contains(point.c_str(), "\"sweep_reuse\":{\"operator_template_reused\":true"),
        "frequency point metadata records sweep reuse provenance");

    char payload_path[256]{};
    std::snprintf(
        payload_path,
        sizeof(payload_path),
        "%s/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
        output_directory);
    std::ifstream payload(payload_path, std::ios::binary | std::ios::ate);
    check(payload.good(), "response spatial field payload is readable");
    check(payload.tellg() > 0, "response spatial field payload is non-empty");

    char point_1_path[256]{};
    std::snprintf(
        point_1_path,
        sizeof(point_1_path),
        "%s/response/frequency_points/frequency_0001.json",
        output_directory);
    const std::string point_1 = read_text_file(point_1_path);
    check(contains(point_1.c_str(), "\"frequency_index\":1"), "second frequency point metadata records index");
    check(
        contains(point_1.c_str(), "\"field_payload_path\":\"response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0\""),
        "second frequency point metadata links Zarr spatial field payload");
    check(
        contains(point_1.c_str(), "\"available_views\":[\"complex\",\"real\",\"imag\",\"abs\",\"amplitude\",\"phase\",\"phase_rotated_real\"]"),
        "second frequency point metadata records all supported complex field views");
    check(
        contains(point_1.c_str(), "\"default_view\":\"phase_rotated_real\""),
        "second frequency point metadata records animated phase view as default");

    char payload_1_path[256]{};
    std::snprintf(
        payload_1_path,
        sizeof(payload_1_path),
        "%s/response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0",
        output_directory);
    std::ifstream payload_1(payload_1_path, std::ios::binary | std::ios::ate);
    check(payload_1.good(), "second response spatial field payload is readable");
    check(payload_1.tellg() == payload.tellg(), "second response spatial field payload has consistent binary size");

    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_respects_disabled_response_field_payloads()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "no-field artifact assembled MFEM validation frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-no-fields-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&node)));

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 1;
    request.solve_request.write_response_fields = false;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::ok, "disabled response field solve succeeds");
    check(result.written_frequency_point_artifacts == 1, "disabled response field solve still writes point metadata");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"response_field_resources\":[]"),
        "disabled response field manifest has empty field resource list");
    check(
        !contains(manifest.c_str(), "response/field_payloads/frequency_0000/vector.bin"),
        "disabled response field manifest does not link field payload");

    char sweep_v2_path[256]{};
    std::snprintf(
        sweep_v2_path,
        sizeof(sweep_v2_path),
        "%s/response/magnetic_response_sweep.v2.json",
        output_directory);
    const std::string sweep_v2 = read_text_file(sweep_v2_path);
    check(
        contains(sweep_v2.c_str(), "\"response_field_payload_path\":null"),
        "disabled response field sweep v2 records null per-point payload path");
    check(
        !contains(sweep_v2.c_str(), "response/field_payloads/frequency_0000/vector.bin"),
        "disabled response field sweep v2 does not link field payload");

    char point_path[256]{};
    std::snprintf(
        point_path,
        sizeof(point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string point = read_text_file(point_path);
    check(contains(point.c_str(), "\"field_payload_path\":null"), "disabled response field point records null payload");
    check(
        !contains(point.c_str(), "response/field_payloads/frequency_0000/vector.bin"),
        "disabled response field point does not link field payload");

    char payload_path[256]{};
    std::snprintf(
        payload_path,
        sizeof(payload_path),
        "%s/response/field_payloads/frequency_0000/vector.bin",
        output_directory);
    check(!file_exists(payload_path), "disabled response field solve does not write field payload");

    fd::release_driven_frequency_response_result(&result);
}

void production_cpu_lane_interruption_preserves_partial_artifacts()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz, one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "production CPU interrupted artifact frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-production-cpu-interrupted-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&node)));
    CancelAfterCompletedProductionPoint cancel_state{};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 2;
    request.solve_request.write_response_fields = true;
    request.execution_lane = fd::DrivenFrequencyResponseExecutionLane::production_cpu;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.cancel_requested = cancel_after_completed_production_point;
    request.cancel_user_data = &cancel_state;
    request.progress_callback = request_cancel_after_completed_production_point;
    request.progress_user_data = &cancel_state;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::interrupted, "cancelled production CPU sweep reports interrupted");
    check(result.completed_frequency_count == 1, "cancelled production CPU sweep preserves one completed point");
    check(result.written_frequency_point_artifacts == 1, "cancelled production CPU sweep records one durable point");
    check(contains(result.result_json, "\"status\":\"interrupted\""), "cancelled production CPU result JSON reports interrupted");
    check(contains(result.result_json, "frequency_domain/manifest.v1.json"), "cancelled production CPU result JSON reports manifest");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_cpu\""),
        "cancelled production CPU diagnostics report lane");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "cancelled production CPU diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":1"),
        "cancelled production CPU diagnostics report completed frequency point count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "cancelled production CPU diagnostics reject validation fallback");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"status\":\"interrupted\""), "production CPU interrupted manifest records interrupted status");
    check(contains(manifest.c_str(), "\"complete\":false"), "production CPU interrupted manifest marks partial result incomplete");
    check(contains(manifest.c_str(), "\"completed_frequency_point_count\":1"), "production CPU interrupted manifest records completed point count");
    check(contains(manifest.c_str(), "\"written_frequency_point_artifacts\":1"), "production CPU interrupted manifest records written count");
    check(contains(manifest.c_str(), "response/frequency_points/frequency_0000.json"), "production CPU interrupted manifest links completed point");
    check(!contains(manifest.c_str(), "response/frequency_points/frequency_0001.json"), "production CPU interrupted manifest does not link incomplete point");
    check(contains(manifest.c_str(), "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0"), "production CPU interrupted manifest links completed Zarr spatial payload");
    check(!contains(manifest.c_str(), "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"), "production CPU interrupted manifest does not link incomplete Zarr spatial payload");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_v1_path\":\"response/cancel_requested.v1.json\""),
        "production CPU interrupted manifest links cancel-request artifact");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1\""),
        "production CPU interrupted manifest links cancel-request resource");

    char progress_path[256]{};
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"schema_version\":\"frequency_domain_sweep_progress.v1\""),
        "production CPU interrupted progress artifact records schema");
    check(contains(progress.c_str(), "\"status\":\"interrupted\""), "production CPU interrupted progress records interrupted status");
    check(contains(progress.c_str(), "\"state\":\"interrupted\""), "production CPU interrupted progress artifact reports interrupted state");
    check(contains(progress.c_str(), "\"partial_artifacts_available\":true"), "production CPU interrupted progress exposes partial artifacts");
    check(contains(progress.c_str(), "\"complete\":false"), "production CPU interrupted progress records incomplete state");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":2"),
        "production CPU interrupted progress records total points");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":1"),
        "production CPU interrupted progress records completed point count");
    check(
        contains(progress.c_str(), "\"written_frequency_point_artifacts\":1"),
        "production CPU interrupted progress records durable point count");
    check(
        contains(progress.c_str(), "\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\""),
        "production CPU interrupted progress records latest manifest path");

    fd::release_driven_frequency_response_result(&result);
}

void driven_response_solver_interruption_preserves_partial_validation_artifacts()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double half_over_two_pi_hz = 0.07957747154594767;
    const double frequencies_hz[] = {one_over_two_pi_hz, half_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "interrupted assembled MFEM validation frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-interrupted-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&node)));
    CancelAfterFirstPoll cancel_state{};

    fd::DrivenFrequencyResponseSolveRequest request{};
    request.solve_request.operator_request.node_count = 1;
    request.solve_request.operator_request.tangent_dof_count = 2;
    request.solve_request.operator_request.alpha = 0.0;
    request.solve_request.operator_request.gamma0 = 1.0;
    request.solve_request.operator_request.include_zeeman = true;
    request.solve_request.frequencies_hz = frequencies_hz;
    request.solve_request.frequency_count = 2;
    request.solve_request.write_response_fields = true;
    request.output_directory = output_directory;
    request.write_partial_artifacts = true;
    request.cancel_requested = cancel_after_first_poll;
    request.cancel_user_data = &cancel_state;
    request.mfem_validation_problem.enabled = true;
    request.mfem_validation_problem.descriptor = descriptor;
    request.mfem_validation_problem.layout = layout;
    request.mfem_validation_problem.nodes = &node;
    request.mfem_validation_problem.h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_validation_problem.drive_real = drive_real;

    fd::DrivenFrequencyResponseSolveResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_driven_frequency_response(request, &result);

    check(status == fd::FrequencyDomainStatus::interrupted, "cancelled validation sweep reports interrupted");
    check(result.completed_frequency_count == 1, "cancelled validation sweep preserves one completed point");
    check(result.written_frequency_point_artifacts == 1, "cancelled validation sweep records one durable point");
    check(contains(result.result_json, "\"status\":\"interrupted\""), "cancelled validation result JSON reports interrupted");
    check(contains(result.result_json, "frequency_domain/manifest.v1.json"), "cancelled validation result JSON reports manifest");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"status\":\"interrupted\""), "interrupted manifest records interrupted status");
    check(contains(manifest.c_str(), "\"complete\":false"), "interrupted manifest marks partial result incomplete");
    check(contains(manifest.c_str(), "\"completed_frequency_point_count\":1"), "interrupted manifest records completed point count");
    check(contains(manifest.c_str(), "\"written_frequency_point_artifacts\":1"), "interrupted manifest records written count");
    check(contains(manifest.c_str(), "response/frequency_points/frequency_0000.json"), "interrupted manifest links completed point");
    check(!contains(manifest.c_str(), "response/frequency_points/frequency_0001.json"), "interrupted manifest does not link incomplete point");
    check(contains(manifest.c_str(), "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0"), "interrupted manifest links completed Zarr spatial payload");
    check(!contains(manifest.c_str(), "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"), "interrupted manifest does not link incomplete Zarr spatial payload");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_v1_path\":\"response/cancel_requested.v1.json\""),
        "interrupted manifest links cancel-request artifact");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1\""),
        "interrupted manifest links cancel-request resource");
    check(
        contains(manifest.c_str(), "\"response_progress_v1_path\":\"response/progress.v1.json\""),
        "interrupted manifest links progress artifact");

    char progress_path[256]{};
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"schema_version\":\"frequency_domain_sweep_progress.v1\""),
        "interrupted progress artifact records schema");
    check(contains(progress.c_str(), "\"status\":\"interrupted\""), "interrupted progress records interrupted status");
    check(contains(progress.c_str(), "\"state\":\"interrupted\""), "interrupted progress artifact reports interrupted state");
    check(contains(progress.c_str(), "\"partial_artifacts_available\":true"), "interrupted progress exposes partial artifacts");
    check(contains(progress.c_str(), "\"complete\":false"), "interrupted progress records incomplete state");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":2"),
        "interrupted progress records total points");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":1"),
        "interrupted progress records completed point count");
    check(
        contains(progress.c_str(), "\"written_frequency_point_artifacts\":1"),
        "interrupted progress records durable point count");

    char completed_point_path[256]{};
    std::snprintf(
        completed_point_path,
        sizeof(completed_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string completed_point = read_text_file(completed_point_path);
    check(contains(completed_point.c_str(), "\"frequency_index\":0"), "interrupted completed point metadata is written");

    char incomplete_point_path[256]{};
    std::snprintf(
        incomplete_point_path,
        sizeof(incomplete_point_path),
        "%s/response/frequency_points/frequency_0001.json",
        output_directory);
    FILE *incomplete_point = std::fopen(incomplete_point_path, "r");
    check(incomplete_point == nullptr, "interrupted run does not write incomplete point metadata");
    if (incomplete_point != nullptr) {
        std::fclose(incomplete_point);
    }

    fd::release_driven_frequency_response_result(&result);
}

void c_abi_driven_response_solve_reports_structured_unavailable_result()
{
    const double frequencies_hz[] = {3.0e9};
    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI driven solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI driven solve result reports unavailable");
    check(result.total_frequency_count == 1, "C ABI driven solve keeps frequency count");
    check(result.completed_frequency_count == 0, "C ABI driven solve completes no frequencies");
    check(result.error_message != nullptr, "C ABI driven solve returns error message");
    check(contains(result.error_message, "driven"), "C ABI driven solve reason names solver");
    check(
        contains(result.diagnostics_json, "frequency_domain_response_diagnostics.v1"),
        "C ABI driven solve diagnostics JSON reports schema");
    check(
        contains(result.diagnostics_json, "\"complete\":false"),
        "C ABI driven solve diagnostics JSON reports incomplete status");
    check(contains(result.result_json, "unavailable"), "C ABI driven solve result JSON reports status");
    check(std::strcmp(result.artifact_manifest_path, "") == 0, "C ABI driven solve reports no manifest");

    fullmag_fem_frequency_domain_solve_result_release(&result);
    check(result.error_message == nullptr, "C ABI driven solve cleanup clears error message");
    check(result.diagnostics_json == nullptr, "C ABI driven solve cleanup clears diagnostics JSON");
    check(result.result_json == nullptr, "C ABI driven solve cleanup clears result JSON");
    check(result.artifact_manifest_path == nullptr, "C ABI driven solve cleanup clears manifest path");
    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_floquet_metadata()
{
    const double frequencies_hz[] = {3.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = -1.0;

    const auto unique_tick = std::chrono::steady_clock::now()
                                 .time_since_epoch()
                                 .count();
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-floquet-nonzero-k-%llu-%llu",
        static_cast<unsigned long long>(
            reinterpret_cast<std::uintptr_t>(&floquet_pair)),
        static_cast<unsigned long long>(unique_tick));

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI Floquet solve result reports unavailable");
    check(result.completed_frequency_count == 0, "C ABI Floquet solve completes no frequencies");
    check(result.error_message != nullptr, "C ABI Floquet solve returns error message");
    check(contains(result.error_message, "Floquet/Bloch"), "C ABI Floquet solve reason names Floquet/Bloch");
    check(contains(result.error_message, "nonzero-k"), "C ABI Floquet solve reason names nonzero-k");
    check(
        contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI Floquet solve diagnostics records structured nonzero-k reason");
    check(
        contains(result.result_json, "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI Floquet solve result records structured nonzero-k reason");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI Floquet unsupported solve reports manifest path");
    check(
        contains(result.result_json, "frequency_domain/manifest.v1.json"),
        "C ABI Floquet unsupported solve result JSON reports manifest");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"schema_version\":\"frequency_domain_manifest.v1\""),
        "C ABI Floquet unsupported manifest records schema");
    check(
        contains(manifest.c_str(), "\"status\":\"unavailable\""),
        "C ABI Floquet unsupported manifest records unavailable status");
    check(
        contains(manifest.c_str(), "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI Floquet unsupported manifest records structured reason");
    check(
        contains(manifest.c_str(), "\"response_progress_v1_path\":\"response/progress.v1.json\""),
        "C ABI Floquet unsupported manifest links progress");
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "C ABI Floquet unsupported manifest links diagnostics");
    check(
        !contains(manifest.c_str(), "response/magnetic_response_sweep.v1.json"),
        "C ABI Floquet unsupported manifest does not claim sweep artifact");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI Floquet unsupported diagnostics record structured reason");
    check(
        contains(diagnostics.c_str(), "\"validation_fallback_used\":false"),
        "C ABI Floquet unsupported diagnostics reject validation fallback");

    char progress_path[256]{};
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"schema_version\":\"frequency_domain_sweep_progress.v1\""),
        "C ABI Floquet unsupported progress records schema");
    check(
        contains(progress.c_str(), "\"status\":\"unavailable\""),
        "C ABI Floquet unsupported progress records unavailable status");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":1"),
        "C ABI Floquet unsupported progress records total point count");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":0"),
        "C ABI Floquet unsupported progress records zero completed points");

    char sweep_path[256]{};
    std::snprintf(
        sweep_path,
        sizeof(sweep_path),
        "%s/response/magnetic_response_sweep.v1.json",
        output_directory);
    check(
        !file_exists(sweep_path),
        "C ABI Floquet unsupported path does not write a response sweep");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_reports_floquet_airbox_unsupported_with_artifacts()
{
    const double frequencies_hz[] = {1.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.translation_m[1] = 0.0;
    floquet_pair.translation_m[2] = 0.0;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = -1.0;
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{0, 1};

    const auto unique_tick = std::chrono::steady_clock::now()
                                 .time_since_epoch()
                                 .count();
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-floquet-airbox-%llu-%llu",
        static_cast<unsigned long long>(
            reinterpret_cast<std::uintptr_t>(&floquet_pair)),
        static_cast<unsigned long long>(unique_tick));

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.requires_floquet_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI Floquet-airbox solve result reports unavailable");
    check(result.completed_frequency_count == 0, "C ABI Floquet-airbox solve completes no frequencies");
    check(
        contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_k_unimplemented\""),
        "C ABI Floquet-airbox diagnostics records demag-k unsupported reason");
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox diagnostics preserve requested magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"resolved_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox diagnostics preserve resolved magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"dynamic_demag_k_available\":false"),
        "C ABI Floquet-airbox diagnostics record missing demag-k operator");
    check(
        contains(result.diagnostics_json, "\"magnetostatic_periodic_constraint_set_count\":1"),
        "C ABI Floquet-airbox diagnostics preserve delta_phi constraint-set count");
    check(
        contains(result.diagnostics_json, "\"delta_m_tangent_dof_count\":4"),
        "C ABI Floquet-airbox diagnostics preserve delta_m tangent DOF count");
    check(
        contains(result.diagnostics_json, "\"delta_phi_dof_count\":2"),
        "C ABI Floquet-airbox diagnostics preserve delta_phi DOF count");
    check(
        contains(result.diagnostics_json, "\"magnetostatic_periodic_node_pair_count\":1"),
        "C ABI Floquet-airbox diagnostics preserve delta_phi periodic node-pair count");
    check(
        contains(result.diagnostics_json, "\"delta_phi_flux_validation_status\":\"not_evaluated\""),
        "C ABI Floquet-airbox diagnostics are explicit about skipped delta_phi flux validation");
    check(
        contains(result.diagnostics_json, "\"floquet_k_vector_rad_per_m\":[1000000"),
        "C ABI Floquet-airbox diagnostics preserve k-vector");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI Floquet-airbox diagnostics reject validation fallback");
    check(
        contains(result.diagnostics_json, "\"resolved_execution_lane\":\"unavailable\""),
        "C ABI Floquet-airbox diagnostics record unavailable resolved lane");
    check(
        contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":false"),
        "C ABI Floquet-airbox diagnostics record inactive coupled-block solver");
    check(
        contains(result.diagnostics_json, "\"mfem_coupled_block_assembly\":false"),
        "C ABI Floquet-airbox diagnostics record missing MFEM coupled-block assembly");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI Floquet-airbox unsupported solve reports manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_k_unimplemented\""),
        "C ABI Floquet-airbox manifest records structured reason");
    check(
        contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox manifest records requested magnetostatic BC");
    check(
        contains(manifest.c_str(), "\"resolved_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox manifest records resolved magnetostatic BC");
    check(
        contains(manifest.c_str(), "\"magnetostatic_periodic_constraint_set_count\":1"),
        "C ABI Floquet-airbox manifest records delta_phi constraint-set count");
    check(
        contains(manifest.c_str(), "\"delta_m_tangent_dof_count\":4"),
        "C ABI Floquet-airbox manifest records delta_m tangent DOF count");
    check(
        contains(manifest.c_str(), "\"delta_phi_dof_count\":2"),
        "C ABI Floquet-airbox manifest records delta_phi DOF count");
    check(
        contains(manifest.c_str(), "\"magnetostatic_periodic_node_pair_count\":1"),
        "C ABI Floquet-airbox manifest records delta_phi periodic node-pair count");
    check(
        contains(manifest.c_str(), "\"periodic_pairs_v1_path\":\"mesh/periodic_pairs.v1.json\""),
        "C ABI Floquet-airbox manifest links delta_phi periodic pair artifact");
    check(
        contains(manifest.c_str(), "\"delta_phi_flux_validation_status\":\"not_evaluated\""),
        "C ABI Floquet-airbox manifest records unevaluated flux validation");
    check(
        contains(manifest.c_str(), "\"floquet_k_vector_rad_per_m\":[1000000"),
        "C ABI Floquet-airbox manifest records k-vector");
    check(
        contains(manifest.c_str(), "\"spin_wave_bc\":{\"kind\":\"floquet\"}"),
        "C ABI Floquet-airbox manifest records Floquet spin-wave BC object");
    check(
        contains(manifest.c_str(), "\"periodic_or_floquet\":true"),
        "C ABI Floquet-airbox manifest records periodic/Floquet physics");
    check(
        contains(manifest.c_str(), "\"periodic_airbox_coupled_block_solver\":false"),
        "C ABI Floquet-airbox manifest diagnostics record inactive coupled-block solver");
    check(
        contains(manifest.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "C ABI Floquet-airbox manifest diagnostics record missing MFEM coupled-block assembly");
    check(
        contains(manifest.c_str(), "\"diagnostics\":{\"requested_frequency_count\":1,\"requested_execution_lane\":\"validation\",\"resolved_execution_lane\":\"unavailable\""),
        "C ABI Floquet-airbox manifest diagnostics record execution provenance");
    check(
        contains(manifest.c_str(), "\"floquet_k_vector_rad_per_m\":[1000000"),
        "C ABI Floquet-airbox manifest diagnostics record k-vector");

    char diagnostics_path[256]{};
    char progress_path[256]{};
    char periodic_pairs_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    const std::string progress = read_text_file(progress_path);
    const std::string periodic_pairs = read_text_file(periodic_pairs_path);
    check(
        contains(diagnostics.c_str(), "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_k_unimplemented\""),
        "C ABI Floquet-airbox artifact diagnostics record structured reason");
    check(
        contains(diagnostics.c_str(), "\"delta_phi_flux_validation_status\":\"not_evaluated\""),
        "C ABI Floquet-airbox artifact diagnostics record unevaluated flux validation");
    check(
        contains(diagnostics.c_str(), "\"resolved_execution_lane\":\"unavailable\""),
        "C ABI Floquet-airbox artifact diagnostics record unavailable resolved lane");
    check(
        contains(diagnostics.c_str(), "\"periodic_airbox_coupled_block_solver\":false"),
        "C ABI Floquet-airbox artifact diagnostics record inactive coupled-block solver");
    check(
        contains(diagnostics.c_str(), "\"mfem_coupled_block_assembly\":false"),
        "C ABI Floquet-airbox artifact diagnostics record missing MFEM coupled-block assembly");
    check(
        contains(progress.c_str(), "\"status\":\"unavailable\""),
        "C ABI Floquet-airbox progress records unavailable status");
    check(
        contains(periodic_pairs.c_str(), "\"source\":\"native_fem_frequency_domain_floquet_airbox_unavailable\""),
        "C ABI Floquet-airbox periodic-pair artifact records Floquet-airbox source");
    check(
        contains(periodic_pairs.c_str(), "\"pair_family\":\"magnetostatic_delta_phi\""),
        "C ABI Floquet-airbox periodic-pair artifact records delta_phi pair family");
    check(
        contains(periodic_pairs.c_str(), "\"unknown_family\":\"delta_phi\""),
        "C ABI Floquet-airbox periodic-pair artifact records delta_phi unknown family");
    check(
        contains(periodic_pairs.c_str(), "\"phase_convention\":\"exp_minus_i_k_dot_delta_r\""),
        "C ABI Floquet-airbox periodic-pair artifact records Bloch phase convention");
    check(
        contains(periodic_pairs.c_str(), "\"floquet_k_vector_rad_per_m\":[1000000"),
        "C ABI Floquet-airbox periodic-pair artifact records k-vector");
    check(
        contains(periodic_pairs.c_str(), "\"phase_metadata_status\":\"available\""),
        "C ABI Floquet-airbox periodic-pair artifact records available phase metadata");
    check(
        contains(periodic_pairs.c_str(), "\"phase_rad\":-1"),
        "C ABI Floquet-airbox periodic-pair artifact records delta_phi phase");
    check(
        contains(periodic_pairs.c_str(), "\"expected_phase_rad\":-1"),
        "C ABI Floquet-airbox periodic-pair artifact records expected delta_phi phase");
    check(
        contains(periodic_pairs.c_str(), "\"phase_residual_rad\":0"),
        "C ABI Floquet-airbox periodic-pair artifact records delta_phi phase residual");
    check(
        contains(periodic_pairs.c_str(), "\"translation_m\":["),
        "C ABI Floquet-airbox periodic-pair artifact records delta_phi translation");
    check(
        contains(periodic_pairs.c_str(), "\"delta_phi_flux_validation_status\":\"not_evaluated\""),
        "C ABI Floquet-airbox periodic-pair artifact records unevaluated flux validation");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_floquet_airbox_missing_delta_phi_pairs()
{
    const double frequencies_hz[] = {1.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.translation_m[1] = 0.0;
    floquet_pair.translation_m[2] = 0.0;
    floquet_pair.phase_rad = -1.0;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.requires_floquet_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = nullptr;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox missing delta_phi pair call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI Floquet-airbox missing delta_phi pairs is validation error");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"floquet_airbox_missing_delta_phi_periodic_node_pairs\""),
        "C ABI Floquet-airbox missing delta_phi pair diagnostics name validation error");
    check(
        contains(result.error_message, "Floquet-airbox delta_phi periodic node pairs"),
        "C ABI Floquet-airbox missing delta_phi pair error names delta_phi pairs");
    check(
        !contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_k_unimplemented\""),
        "C ABI Floquet-airbox missing delta_phi pairs rejects before unsupported operator path");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_invalid_floquet_airbox_delta_phi_pairs()
{
    const double frequencies_hz[] = {1.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.translation_m[1] = 0.0;
    floquet_pair.translation_m[2] = 0.0;
    floquet_pair.phase_rad = -1.0;
    const fullmag_fem_frequency_domain_periodic_node_pair out_of_range_pair{0, 2};
    const fullmag_fem_frequency_domain_periodic_node_pair self_pair{1, 1};

    auto base_request = [&]() {
        fullmag_fem_frequency_domain_driven_response_request request{};
        request.node_count = 2;
        request.tangent_dof_count = 4;
        request.alpha = 0.02;
        request.gamma0 = 2.211e5;
        request.frequencies_hz = frequencies_hz;
        request.frequency_count = 1;
        request.has_floquet_k_vector = 1;
        request.floquet_k_vector_rad_per_m[0] = 1.0e6;
        request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
        request.mfem_floquet_periodic_pairs = &floquet_pair;
        request.mfem_floquet_periodic_pair_count = 1;
        request.requires_floquet_airbox_dynamic_demag = 1;
        request.magnetic_periodic_constraint_set_count = 1;
        request.magnetostatic_periodic_constraint_set_count = 1;
        request.periodic_airbox_delta_phi_dof_count = 2;
        request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
        return request;
    };

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.periodic_airbox_magnetostatic_periodic_node_pairs = &out_of_range_pair;

        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

        check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox out-of-range delta_phi pair call succeeds");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI Floquet-airbox out-of-range delta_phi pair is validation error");
        check(
            contains(result.diagnostics_json, "\"validation_error\":\"floquet_airbox_delta_phi_periodic_node_pair_out_of_range\""),
            "C ABI Floquet-airbox out-of-range delta_phi pair diagnostics name validation error");
        check(
            contains(result.error_message, "delta_phi periodic node pair is outside delta_phi DOFs"),
            "C ABI Floquet-airbox out-of-range delta_phi pair error names delta_phi DOFs");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.periodic_airbox_magnetostatic_periodic_node_pairs = &self_pair;

        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

        check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox self delta_phi pair call succeeds");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI Floquet-airbox self delta_phi pair is validation error");
        check(
            contains(result.diagnostics_json, "\"validation_error\":\"floquet_airbox_degenerate_delta_phi_periodic_node_pair\""),
            "C ABI Floquet-airbox self delta_phi pair diagnostics name validation error");
        check(
            contains(result.error_message, "distinct Floquet-airbox delta_phi nodes"),
            "C ABI Floquet-airbox self delta_phi pair error names distinct delta_phi nodes");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }
}

void c_abi_driven_response_solve_rejects_floquet_airbox_delta_phi_pair_without_phase_metadata()
{
    const double frequencies_hz[] = {1.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.translation_m[1] = 0.0;
    floquet_pair.translation_m[2] = 0.0;
    floquet_pair.has_phase = 0;
    floquet_pair.phase_rad = -1.0;
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{0, 1};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.requires_floquet_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox delta_phi missing phase metadata call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI Floquet-airbox delta_phi missing phase metadata is validation error");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"floquet_airbox_delta_phi_pair_missing_phase_metadata\""),
        "C ABI Floquet-airbox delta_phi missing phase metadata diagnostics name validation error");
    check(
        contains(result.error_message, "Floquet-airbox delta_phi pair requires matching Floquet phase metadata"),
        "C ABI Floquet-airbox delta_phi missing phase metadata error names phase metadata");
    check(
        !contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_k_unimplemented\""),
        "C ABI Floquet-airbox delta_phi missing phase metadata rejects before unsupported operator path");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_inconsistent_floquet_phase_metadata()
{
    const double frequencies_hz[] = {3.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = 0.25;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI inconsistent Floquet phase call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI inconsistent Floquet phase reports validation error");
    check(result.completed_frequency_count == 0, "C ABI inconsistent Floquet phase completes no frequencies");
    check(result.error_message != nullptr, "C ABI inconsistent Floquet phase returns error message");
    check(
        contains(result.error_message, "Floquet phase"),
        "C ABI inconsistent Floquet phase reason names phase");
    check(
        contains(result.error_message, "k dot translation"),
        "C ABI inconsistent Floquet phase reason names k dot translation");
    check(
        !contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI inconsistent Floquet phase fails before unsupported solve path");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_inconsistent_floquet_phase_loop()
{
    const double frequencies_hz[] = {3.0e9};
    const double equilibrium_m[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double drive_real[] = {
        0.0, 0.0,
        0.0, 0.0,
        0.0, 0.0,
    };
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pairs[3]{};
    floquet_pairs[0].pair_id = "x_a";
    floquet_pairs[0].node_a = 0;
    floquet_pairs[0].node_b = 1;
    floquet_pairs[0].has_translation = 1;
    floquet_pairs[0].translation_m[0] = 1.0e-6;
    floquet_pairs[0].has_phase = 1;
    floquet_pairs[0].phase_rad = -1.0;

    floquet_pairs[1].pair_id = "x_b";
    floquet_pairs[1].node_a = 1;
    floquet_pairs[1].node_b = 2;
    floquet_pairs[1].has_translation = 1;
    floquet_pairs[1].translation_m[0] = 2.0e-6;
    floquet_pairs[1].has_phase = 1;
    floquet_pairs[1].phase_rad = -2.0;

    floquet_pairs[2].pair_id = "x_direct";
    floquet_pairs[2].node_a = 0;
    floquet_pairs[2].node_b = 2;
    floquet_pairs[2].has_translation = 1;
    floquet_pairs[2].translation_m[0] = 4.0e-6;
    floquet_pairs[2].has_phase = 1;
    floquet_pairs[2].phase_rad = -4.0;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 3;
    request.tangent_dof_count = 6;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane =
        FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = floquet_pairs;
    request.mfem_floquet_periodic_pair_count = 3;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet phase-loop mismatch call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI Floquet phase-loop mismatch is validation error");
    check(result.completed_frequency_count == 0, "C ABI Floquet phase-loop mismatch completes no frequencies");
    check(result.error_message != nullptr, "C ABI Floquet phase-loop mismatch returns error message");
    check(
        contains(result.error_message, "Floquet phase loop"),
        "C ABI Floquet phase-loop mismatch reports phase-loop error");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"floquet_phase_loop_mismatch\""),
        "C ABI Floquet phase-loop mismatch diagnostics record structured reason");
    check(
        !contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI Floquet phase-loop mismatch fails before unsupported solve path");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_nonperiodic_floquet_drive_before_unsupported_path()
{
    const double frequencies_hz[] = {3.0e9};
    const double equilibrium_m[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double drive_real[] = {
        1.0, 0.25,
        0.0, 0.0,
    };
    const double drive_imag[] = {
        0.5, -0.25,
        0.0, 0.0,
    };
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = -1.0;

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-floquet-drive-validation-%llu",
        static_cast<unsigned long long>(
            reinterpret_cast<std::uintptr_t>(&floquet_pair)));

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane =
        FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_drive_real = drive_real;
    request.mfem_drive_imag = drive_imag;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI nonperiodic Floquet drive call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI nonperiodic Floquet drive is validation error");
    check(result.completed_frequency_count == 0, "C ABI nonperiodic Floquet drive completes no frequencies");
    check(result.error_message != nullptr, "C ABI nonperiodic Floquet drive returns error message");
    check(
        contains(result.error_message, "Floquet-periodic tangent drive"),
        "C ABI nonperiodic Floquet drive reports drive phase error");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"floquet_drive_phase_mismatch\""),
        "C ABI nonperiodic Floquet drive diagnostics record structured phase mismatch");
    check(
        !contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI nonperiodic Floquet drive fails before unsupported solve path");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI nonperiodic Floquet drive validation reports manifest path");
    check(
        contains(result.result_json, "frequency_domain/manifest.v1.json"),
        "C ABI nonperiodic Floquet drive validation result JSON reports manifest");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"schema_version\":\"frequency_domain_manifest.v1\""),
        "C ABI nonperiodic Floquet drive validation manifest records schema");
    check(
        contains(manifest.c_str(), "\"status\":\"validation_error\""),
        "C ABI nonperiodic Floquet drive validation manifest records validation error");
    check(
        contains(manifest.c_str(), "\"validation_error\":\"floquet_drive_phase_mismatch\""),
        "C ABI nonperiodic Floquet drive validation manifest records structured reason");
    check(
        contains(manifest.c_str(), "\"response_progress_v1_path\":\"response/progress.v1.json\""),
        "C ABI nonperiodic Floquet drive validation manifest links progress");
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "C ABI nonperiodic Floquet drive validation manifest links diagnostics");
    check(
        !contains(manifest.c_str(), "response/magnetic_response_sweep.v1.json"),
        "C ABI nonperiodic Floquet drive validation manifest does not claim sweep artifact");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"validation_error\":\"floquet_drive_phase_mismatch\""),
        "C ABI nonperiodic Floquet drive validation diagnostics records structured reason");
    check(
        !contains(diagnostics.c_str(), "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI nonperiodic Floquet drive validation diagnostics does not claim unsupported nonzero-k solve");

    char progress_path[256]{};
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    const std::string progress = read_text_file(progress_path);
    check(
        contains(progress.c_str(), "\"schema_version\":\"frequency_domain_sweep_progress.v1\""),
        "C ABI nonperiodic Floquet drive validation progress records schema");
    check(
        contains(progress.c_str(), "\"status\":\"validation_error\""),
        "C ABI nonperiodic Floquet drive validation progress records validation error");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":1"),
        "C ABI nonperiodic Floquet drive validation progress records total point count");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":0"),
        "C ABI nonperiodic Floquet drive validation progress records zero completed points");

    char sweep_path[256]{};
    std::snprintf(
        sweep_path,
        sizeof(sweep_path),
        "%s/response/magnetic_response_sweep.v1.json",
        output_directory);
    check(
        !file_exists(sweep_path),
        "C ABI nonperiodic Floquet drive validation does not write a response sweep");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_floquet_tangent_frame_mismatch_before_unsupported_path()
{
    const double frequencies_hz[] = {3.0e9};
    const double equilibrium_m[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    const double phase_rad = -1.0;
    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double drive_real[] = {
        1.0, 0.25,
        c * 1.0, c * 0.25,
    };
    const double drive_imag[] = {
        0.0, 0.0,
        s * 1.0, s * 0.25,
    };
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = phase_rad;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane =
        FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_drive_real = drive_real;
    request.mfem_drive_imag = drive_imag;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet frame mismatch call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI Floquet frame mismatch is validation error");
    check(result.completed_frequency_count == 0, "C ABI Floquet frame mismatch completes no frequencies");
    check(result.error_message != nullptr, "C ABI Floquet frame mismatch returns error message");
    check(
        contains(result.error_message, "Floquet tangent frames"),
        "C ABI Floquet frame mismatch reports tangent-frame error");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"floquet_tangent_frame_mismatch\""),
        "C ABI Floquet frame mismatch diagnostics record structured frame mismatch");
    check(
        !contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_bloch_nonzero_k\""),
        "C ABI Floquet frame mismatch fails before unsupported solve path");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_treats_gamma_floquet_metadata_as_zero_phase_periodic()
{
    const double frequencies_hz[] = {3.0e9};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = 0.0;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 0.0;
    request.floquet_k_vector_rad_per_m[1] = 0.0;
    request.floquet_k_vector_rad_per_m[2] = 0.0;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI gamma-Floquet solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI gamma-Floquet result falls through to ordinary unavailable response");
    check(result.completed_frequency_count == 0, "C ABI gamma-Floquet completes no frequencies");
    check(result.error_message != nullptr, "C ABI gamma-Floquet returns error message");
    check(contains(result.error_message, "driven"), "C ABI gamma-Floquet ordinary unavailable reason names driven solver");
    check(
        !contains(result.error_message, "nonzero-k"),
        "C ABI gamma-Floquet ordinary unavailable reason does not claim nonzero-k");
    check(
        contains(result.diagnostics_json, "frequency_domain_response_diagnostics.v1"),
        "C ABI gamma-Floquet diagnostics JSON reports schema");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_unknown_execution_lane()
{
    const double frequencies_hz[] = {3.0e9};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane =
        static_cast<fullmag_fem_frequency_domain_execution_lane>(99);
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_mass_diagonal = mass_diagonal;
    request.tiny_validation_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI unknown execution lane returns owned result");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI unknown execution lane reports validation error");
    check(result.total_frequency_count == 1, "C ABI unknown execution lane keeps total count");
    check(result.completed_frequency_count == 0, "C ABI unknown execution lane solves no frequencies");
    check(
        contains(result.error_message, "execution lane"),
        "C ABI unknown execution lane error names execution lane");
    check(
        contains(result.diagnostics_json, "\"status\":\"validation_error\""),
        "C ABI unknown execution lane diagnostics report validation status");
    check(
        contains(result.diagnostics_json, "\"schema_version\":\"frequency_domain_response_diagnostics.v1\""),
        "C ABI unknown execution lane diagnostics report schema version");
    check(
        contains(result.result_json, "\"schema_version\":\"frequency_domain_driven_response_result.v1\""),
        "C ABI unknown execution lane result reports schema version");
    check(
        !contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "C ABI unknown execution lane does not fall back to tiny validation");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_rejects_unknown_phase_convention()
{
    const double frequencies_hz[] = {3.0e9};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.phase_convention =
        static_cast<fullmag_fem_frequency_domain_phase_convention>(99);
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_mass_diagonal = mass_diagonal;
    request.tiny_validation_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI unknown phase convention returns owned result");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI unknown phase convention reports validation error");
    check(result.total_frequency_count == 1, "C ABI unknown phase convention keeps total count");
    check(result.completed_frequency_count == 0, "C ABI unknown phase convention solves no frequencies");
    check(
        contains(result.error_message, "phase convention"),
        "C ABI unknown phase convention error names phase convention");
    check(
        contains(result.diagnostics_json, "\"status\":\"validation_error\""),
        "C ABI unknown phase convention diagnostics report validation status");
    check(
        contains(result.diagnostics_json, "\"schema_version\":\"frequency_domain_response_diagnostics.v1\""),
        "C ABI unknown phase convention diagnostics report schema version");
    check(
        contains(result.result_json, "\"schema_version\":\"frequency_domain_driven_response_result.v1\""),
        "C ABI unknown phase convention result reports schema version");
    check(
        !contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "C ABI unknown phase convention does not fall back to tiny validation");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_runs_tiny_validation_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_mass_diagonal = mass_diagonal;
    request.tiny_validation_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI tiny validation solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI tiny validation solve reports ok");
    check(result.total_frequency_count == 1, "C ABI tiny validation keeps frequency count");
    check(result.completed_frequency_count == 1, "C ABI tiny validation completes frequency");
    check(
        contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "C ABI tiny validation diagnostics reports validation solver");
    check(contains(result.result_json, "\"status\":\"ok\""), "C ABI tiny validation result reports ok");
    check(
        contains(result.result_json, "\"max_abs_response\""),
        "C ABI tiny validation result reports response magnitude");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_runs_complex_tiny_validation_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 0.0};
    const double drive_imag[] = {3.0, 0.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_mass_diagonal = mass_diagonal;
    request.tiny_validation_drive_real = drive_real;
    request.tiny_validation_drive_imag = drive_imag;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI complex tiny validation boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI complex tiny validation reports ok");
    check(result.completed_frequency_count == 1, "C ABI complex tiny validation completes frequency");
    check(
        contains(result.result_json, "\"max_abs_response\":1.41421356237309"),
        "C ABI complex tiny validation result uses imaginary drive");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_manifest_preserves_temporal_phase_convention()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium_m[] = {0.0, 0.0, 1.0};
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-cabi-phase-convention-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;
    request.phase_convention = FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T;
    request.mfem_operator_enabled = 1;
    request.mfem_include_zeeman = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI phase convention artifact solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI phase convention artifact solve reports ok");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI phase convention artifact solve reports manifest path");
    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"phase_convention\":\"exp_minus_i_omega_t\""),
        "C ABI manifest preserves requested temporal phase convention");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_runs_mfem_matrix_free_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium_m[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0, 1.0, 0.0};
    const fullmag_fem_frequency_domain_exchange_edge exchange_edge{
        0,
        1,
        2.0,
    };
    const fullmag_fem_frequency_domain_periodic_node_pair periodic_pair{
        0,
        1,
    };
    CAbiProgressRecorder progress_recorder{};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-cabi-static-periodic-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&periodic_pair)));

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.0;
    request.gamma0 = 1.0;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_include_zeeman = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_h_ext_a_per_m = h_ext_a_per_m;
    const double anisotropy_axis[] = {1.0, 0.0, 0.0};
    request.mfem_uniaxial_anisotropy_axis = anisotropy_axis;
    request.mfem_uniaxial_anisotropy_field_a_per_m = 1.0;
    request.mfem_drive_real = drive_real;
    request.mfem_exchange_edges = &exchange_edge;
    request.mfem_exchange_edge_count = 1;
    request.mfem_static_periodic_node_pairs = &periodic_pair;
    request.mfem_static_periodic_node_pair_count = 1;
    request.progress_callback = c_abi_record_progress;
    request.progress_user_data = &progress_recorder;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI production CPU MFEM solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI production CPU MFEM solve reports ok");
    check(result.completed_frequency_count == 1, "C ABI production CPU MFEM solve completes frequency");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_cpu\""),
        "C ABI production CPU MFEM diagnostics report lane");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "C ABI production CPU MFEM diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":1"),
        "C ABI production CPU MFEM diagnostics report completed frequency point count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production CPU MFEM diagnostics reject validation fallback");
    check(
        contains(result.diagnostics_json, "\"static_periodic_projection\":true"),
        "C ABI production CPU MFEM diagnostics report static-periodic projection");
    check(
        contains(result.diagnostics_json, "\"static_periodic_node_pair_count\":1"),
        "C ABI production CPU MFEM diagnostics report static-periodic pair count");
    check(
        contains(result.diagnostics_json, "\"static_periodic_frame_max_mismatch\":0"),
        "C ABI production CPU MFEM diagnostics report static-periodic frame mismatch");
    check(
        contains(result.diagnostics_json, "\"static_periodic_drive_max_mismatch\":0"),
        "C ABI production CPU MFEM diagnostics report static-periodic drive mismatch");
    check(progress_recorder.event_count > 0, "C ABI production CPU progress emits events");
    check(progress_recorder.last_frequency_index == 0, "C ABI production CPU progress reports frequency index");
    check(progress_recorder.last_completed_frequency_count == 1, "C ABI production CPU progress reports completed count");
    check(progress_recorder.last_total_frequency_count == 1, "C ABI production CPU progress reports total count");
    check(progress_recorder.last_iteration_count > 0, "C ABI production CPU progress reports iterations");
    check(
        std::abs(progress_recorder.last_frequency_hz - one_over_two_pi_hz) < 1.0e-12,
        "C ABI production CPU progress reports frequency");
    check(
        progress_recorder.last_relative_residual_l2_norm < 1.0e-10,
        "C ABI production CPU progress reports final residual");
    check(progress_recorder.saw_converged, "C ABI production CPU progress reports convergence");
    check(
        !contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "C ABI production CPU MFEM solve does not run tiny validation solver");
    check(contains(result.result_json, "\"status\":\"ok\""), "C ABI production CPU MFEM result reports ok");
    check(
        contains(result.result_json, "\"max_abs_response\""),
        "C ABI production CPU MFEM result reports response magnitude");
    char periodic_pairs_path[256]{};
    std::snprintf(
        periodic_pairs_path,
        sizeof(periodic_pairs_path),
        "%s/mesh/periodic_pairs.v1.json",
        output_directory);
    const std::string periodic_pairs = read_text_file(periodic_pairs_path);
    check(
        contains(periodic_pairs.c_str(), "\"schema_version\":\"periodic_pairs.v1\""),
        "C ABI static-periodic artifact records periodic_pairs schema");
    check(
        contains(periodic_pairs.c_str(), "\"validation_status\":\"ok\""),
        "C ABI static-periodic artifact records validation status");
    check(
        contains(periodic_pairs.c_str(), "\"paired_node_count\":2"),
        "C ABI static-periodic artifact records paired node count");
    check(
        contains(periodic_pairs.c_str(), "\"unpaired_source_count\":0"),
        "C ABI static-periodic artifact records no unpaired source nodes");
    check(
        contains(periodic_pairs.c_str(), "\"unpaired_destination_count\":0"),
        "C ABI static-periodic artifact records no unpaired destination nodes");
    check(
        contains(periodic_pairs.c_str(), "\"source_marker\":\"node:0\""),
        "C ABI static-periodic artifact records source marker");
    check(
        contains(periodic_pairs.c_str(), "\"destination_marker\":\"node:1\""),
        "C ABI static-periodic artifact records destination marker");
    check(
        contains(periodic_pairs.c_str(), "\"residual_diagnostics\""),
        "C ABI static-periodic artifact records residual diagnostics");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_gamma_floquet_production_cpu_matches_static_periodic_response()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium_m[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0, 1.0, 0.0};
    const fullmag_fem_frequency_domain_exchange_edge exchange_edge{
        0,
        1,
        2.0,
    };
    const fullmag_fem_frequency_domain_periodic_node_pair periodic_pair{
        0,
        1,
    };
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = 0.0;

    const auto unique_tick = std::chrono::steady_clock::now()
                                 .time_since_epoch()
                                 .count();
    char static_output_directory[192]{};
    char floquet_output_directory[192]{};
    std::snprintf(
        static_output_directory,
        sizeof(static_output_directory),
        "/tmp/fullmag-frequency-domain-cabi-gamma-static-%llu",
        static_cast<unsigned long long>(unique_tick));
    std::snprintf(
        floquet_output_directory,
        sizeof(floquet_output_directory),
        "/tmp/fullmag-frequency-domain-cabi-gamma-floquet-%llu",
        static_cast<unsigned long long>(unique_tick));

    fullmag_fem_frequency_domain_driven_response_request static_request{};
    static_request.node_count = 2;
    static_request.tangent_dof_count = 4;
    static_request.alpha = 0.0;
    static_request.gamma0 = 1.0;
    static_request.requested_execution_lane =
        FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    static_request.frequencies_hz = frequencies_hz;
    static_request.frequency_count = 1;
    static_request.mfem_operator_enabled = 1;
    static_request.mfem_include_zeeman = 1;
    static_request.mfem_equilibrium_m = equilibrium_m;
    static_request.mfem_h_ext_a_per_m = h_ext_a_per_m;
    static_request.mfem_drive_real = drive_real;
    static_request.mfem_exchange_edges = &exchange_edge;
    static_request.mfem_exchange_edge_count = 1;
    static_request.mfem_static_periodic_node_pairs = &periodic_pair;
    static_request.mfem_static_periodic_node_pair_count = 1;
    static_request.output_directory = static_output_directory;
    static_request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_driven_response_request floquet_request = static_request;
    floquet_request.mfem_static_periodic_node_pairs = nullptr;
    floquet_request.mfem_static_periodic_node_pair_count = 0;
    floquet_request.has_floquet_k_vector = 1;
    floquet_request.floquet_k_vector_rad_per_m[0] = 0.0;
    floquet_request.floquet_k_vector_rad_per_m[1] = 0.0;
    floquet_request.floquet_k_vector_rad_per_m[2] = 0.0;
    floquet_request.mfem_floquet_periodic_pairs = &floquet_pair;
    floquet_request.mfem_floquet_periodic_pair_count = 1;
    floquet_request.output_directory = floquet_output_directory;

    fullmag_fem_frequency_domain_solve_result static_result{};
    fullmag_fem_frequency_domain_solve_result floquet_result{};
    const int static_status =
        fullmag_fem_frequency_domain_solve_driven_response(&static_request, &static_result);
    const int floquet_status =
        fullmag_fem_frequency_domain_solve_driven_response(&floquet_request, &floquet_result);

    check(static_status == FULLMAG_FEM_OK, "C ABI static-periodic gamma comparison call succeeds");
    check(floquet_status == FULLMAG_FEM_OK, "C ABI gamma-Floquet comparison call succeeds");
    check(
        static_result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI static-periodic gamma comparison solve reports ok");
    check(
        floquet_result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI gamma-Floquet comparison solve reports ok");
    check(
        contains(static_result.diagnostics_json, "\"static_periodic_projection\":true"),
        "C ABI static-periodic comparison diagnostics report static-periodic projection");
    check(
        contains(floquet_result.diagnostics_json, "\"static_periodic_projection\":true"),
        "C ABI gamma-Floquet comparison diagnostics canonicalize to static-periodic projection");
    check(
        contains(floquet_result.diagnostics_json, "\"floquet_phase_projection\":false"),
        "C ABI gamma-Floquet comparison diagnostics do not use nonzero-k Floquet projection");

    char static_point_path[256]{};
    char floquet_point_path[256]{};
    std::snprintf(
        static_point_path,
        sizeof(static_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        static_output_directory);
    std::snprintf(
        floquet_point_path,
        sizeof(floquet_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        floquet_output_directory);
    const std::string static_point = read_text_file(static_point_path);
    const std::string floquet_point = read_text_file(floquet_point_path);
    double static_m_complex[8]{};
    double floquet_m_complex[8]{};
    check(
        extract_m_complex_values(static_point, static_m_complex, 8),
        "C ABI static-periodic comparison extracts m_complex");
    check(
        extract_m_complex_values(floquet_point, floquet_m_complex, 8),
        "C ABI gamma-Floquet comparison extracts m_complex");
    for (std::size_t index = 0; index < 8; ++index) {
        check(
            nearly_equal(static_m_complex[index], floquet_m_complex[index], 1.0e-12),
            "C ABI gamma-Floquet response matches static-periodic response");
    }

    fullmag_fem_frequency_domain_solve_result_release(&static_result);
    fullmag_fem_frequency_domain_solve_result_release(&floquet_result);
}

void c_abi_production_cpu_lane_runs_mfem_matrix_free_explicit_demag_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium_m[] = {0.0, 0.0, 1.0};
    const double drive_real[] = {1.0, 0.0};
    const double demag_tangent_matrix[] = {
        0.5, 0.0,
        0.0, 0.25,
    };

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.0;
    request.gamma0 = 1.0;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_drive_real = drive_real;
    request.mfem_demag_tangent_matrix_row_major = demag_tangent_matrix;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI production CPU MFEM explicit demag solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI production CPU MFEM explicit demag solve reports ok");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "C ABI production CPU MFEM explicit demag diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production CPU MFEM explicit demag diagnostics reject validation fallback");
    check(
        contains(result.result_json, "\"status\":\"ok\""),
        "C ABI production CPU MFEM explicit demag result reports ok");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_runs_mfem_matrix_free_demag_provider_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium_m[] = {0.0, 0.0, 1.0};
    const double drive_real[] = {1.0, 0.0};
    const double demag_tangent_matrix[] = {
        0.5, 0.0,
        0.0, 0.25,
    };
    DemagTangentCallbackOperator demag_operator{
        demag_tangent_matrix,
        2,
        0,
    };

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.0;
    request.gamma0 = 1.0;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_drive_real = drive_real;
    request.mfem_apply_demag_tangent = c_abi_apply_demag_tangent;
    request.mfem_demag_tangent_user_data = &demag_operator;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI production CPU MFEM demag provider solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI production CPU MFEM demag provider solve reports ok");
    check(demag_operator.call_count > 0, "C ABI production CPU MFEM demag provider is invoked");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "C ABI production CPU MFEM demag provider diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production CPU MFEM demag provider diagnostics reject validation fallback");
    check(
        contains(result.diagnostics_json, "\"demag_tangent_operator_source\":\"matrix_free_demag_tangent_provider\""),
        "C ABI production CPU MFEM demag provider diagnostics record provider provenance");
    check(
        contains(result.result_json, "\"demag_tangent_operator_source\":\"matrix_free_demag_tangent_provider\""),
        "C ABI production CPU MFEM demag provider result records provider provenance");
    check(
        contains(result.result_json, "\"status\":\"ok\""),
        "C ABI production CPU MFEM demag provider result reports ok");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_rejects_invalid_static_periodic_requests()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium_z[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double mismatched_equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    const double periodic_drive[] = {1.0, 0.0, 1.0, 0.0};
    const double nonperiodic_drive[] = {1.0, 0.0, 0.0, 0.0};
    const fullmag_fem_frequency_domain_periodic_node_pair periodic_pair{
        0,
        1,
    };
    const fullmag_fem_frequency_domain_periodic_node_pair self_pair{
        0,
        0,
    };
    const fullmag_fem_frequency_domain_periodic_node_pair out_of_range_pair{
        0,
        3,
    };

    auto base_request = [&]() {
        fullmag_fem_frequency_domain_driven_response_request request{};
        request.node_count = 2;
        request.tangent_dof_count = 4;
        request.alpha = 0.0;
        request.gamma0 = 1.0;
        request.requested_execution_lane =
            FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
        request.frequencies_hz = frequencies_hz;
        request.frequency_count = 1;
        request.mfem_operator_enabled = 1;
        request.mfem_equilibrium_m = equilibrium_z;
        request.mfem_drive_real = periodic_drive;
        request.mfem_static_periodic_node_pair_count = 1;
        return request;
    };

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.mfem_static_periodic_node_pairs = nullptr;
        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);
        check(status == FULLMAG_FEM_OK, "C ABI null static-periodic pair request returns owned result");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI null static-periodic pair request is validation error");
        check(
            contains(result.error_message, "node pair buffer"),
            "C ABI null static-periodic pair request reports pair buffer error");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.mfem_static_periodic_node_pairs = &self_pair;
        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);
        check(status == FULLMAG_FEM_OK, "C ABI static-periodic self-pair request returns owned result");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI static-periodic self-pair request is validation error");
        check(
            contains(result.error_message, "invalid node pair"),
            "C ABI static-periodic self-pair request reports invalid pair error");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.mfem_static_periodic_node_pairs = &out_of_range_pair;
        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);
        check(status == FULLMAG_FEM_OK, "C ABI static-periodic out-of-range pair request returns owned result");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI static-periodic out-of-range pair request is validation error");
        check(
            contains(result.error_message, "invalid node pair"),
            "C ABI static-periodic out-of-range pair request reports invalid pair error");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.mfem_static_periodic_node_pairs = &periodic_pair;
        request.mfem_equilibrium_m = mismatched_equilibrium;
        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);
        check(status == FULLMAG_FEM_OK, "C ABI mismatched static-periodic frame request returns owned result");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI mismatched static-periodic frame request is validation error");
        check(
            contains(result.error_message, "tangent frames"),
            "C ABI mismatched static-periodic frame request reports tangent-frame error");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }

    {
        fullmag_fem_frequency_domain_driven_response_request request = base_request();
        request.mfem_static_periodic_node_pairs = &periodic_pair;
        request.mfem_drive_real = nonperiodic_drive;
        fullmag_fem_frequency_domain_solve_result result{};
        const int status =
            fullmag_fem_frequency_domain_solve_driven_response(&request, &result);
        check(status == FULLMAG_FEM_OK, "C ABI nonperiodic drive request returns owned result");
        check(
            result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
            "C ABI nonperiodic static-periodic drive request is validation error");
        check(
            contains(result.error_message, "periodic tangent drive"),
            "C ABI nonperiodic static-periodic drive request reports drive error");
        fullmag_fem_frequency_domain_solve_result_release(&result);
    }
}

void c_abi_production_cpu_lane_rejects_invalid_equilibrium_before_solve()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double nonunit_equilibrium_m[] = {0.0, 0.0, 2.0};
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.0;
    request.gamma0 = 1.0;
    request.requested_execution_lane =
        FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_include_zeeman = 1;
    request.mfem_equilibrium_m = nonunit_equilibrium_m;
    request.mfem_h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI invalid equilibrium request returns owned result");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI invalid equilibrium request is validation error");
    check(
        contains(result.error_message, "equilibrium magnetization"),
        "C ABI invalid equilibrium request names equilibrium magnetization");
    check(
        contains(result.error_message, "unit vectors"),
        "C ABI invalid equilibrium request preserves tangent-frame reason");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_interruption_preserves_partial_artifacts()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz, one_over_two_pi_hz};
    const double equilibrium_m[] = {
        0.0, 0.0, 1.0,
    };
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};

    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-cabi-production-cpu-interrupted-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    CAbiCancelAfterCompletedPoint cancel_state{};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.0;
    request.gamma0 = 1.0;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 2;
    request.output_directory = output_directory;
    request.write_response_fields = 1;
    request.write_partial_artifacts = 1;
    request.cancel_requested = c_abi_cancel_after_completed_point;
    request.cancel_user_data = &cancel_state;
    request.progress_callback = c_abi_request_cancel_after_completed_point;
    request.progress_user_data = &cancel_state;
    request.mfem_operator_enabled = 1;
    request.mfem_include_zeeman = 1;
    request.mfem_equilibrium_m = equilibrium_m;
    request.mfem_h_ext_a_per_m = h_ext_a_per_m;
    request.mfem_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI production CPU interrupted boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED,
        "C ABI production CPU interrupted solve reports interrupted");
    check(result.completed_frequency_count == 1, "C ABI production CPU interrupted solve preserves one completed point");
    check(result.written_frequency_point_artifacts == 1, "C ABI production CPU interrupted solve records one durable point");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_cpu\""),
        "C ABI production CPU interrupted diagnostics report lane");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "C ABI production CPU interrupted diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":1"),
        "C ABI production CPU interrupted diagnostics report completed frequency point count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production CPU interrupted diagnostics reject validation fallback");
    check(
        contains(result.result_json, "\"status\":\"interrupted\""),
        "C ABI production CPU interrupted result reports status");
    check(
        contains(result.result_json, "\"partial_artifacts_available\":true"),
        "C ABI production CPU interrupted result reports partial artifacts");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"status\":\"interrupted\""), "C ABI production CPU interrupted manifest records status");
    check(contains(manifest.c_str(), "\"complete\":false"), "C ABI production CPU interrupted manifest records incomplete state");
    check(contains(manifest.c_str(), "\"completed_frequency_point_count\":1"), "C ABI production CPU interrupted manifest records completed point count");
    check(contains(manifest.c_str(), "response/frequency_points/frequency_0000.json"), "C ABI production CPU interrupted manifest links completed point");
    check(!contains(manifest.c_str(), "response/frequency_points/frequency_0001.json"), "C ABI production CPU interrupted manifest omits incomplete point");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_v1_path\":\"response/cancel_requested.v1.json\""),
        "C ABI production CPU interrupted manifest links cancel-request artifact");
    check(
        contains(manifest.c_str(), "\"response_cancel_requested_resource_key\":\"/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1\""),
        "C ABI production CPU interrupted manifest links cancel-request resource");

    char progress_path[256]{};
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    const std::string progress = read_text_file(progress_path);
    check(contains(progress.c_str(), "\"state\":\"interrupted\""), "C ABI production CPU interrupted progress records state");
    check(contains(progress.c_str(), "\"partial_artifacts_available\":true"), "C ABI production CPU interrupted progress records partial artifacts");

    char sweep_v2_path[256]{};
    std::snprintf(
        sweep_v2_path,
        sizeof(sweep_v2_path),
        "%s/response/magnetic_response_sweep.v2.json",
        output_directory);
    const std::string sweep_v2 = read_text_file(sweep_v2_path);
    check(contains(sweep_v2.c_str(), "\"completed_frequency_point_count\":1"), "C ABI production CPU interrupted v2 sweep records one completed point");
    check(contains(sweep_v2.c_str(), "response/frequency_points/frequency_0000.json"), "C ABI production CPU interrupted v2 sweep links completed point");
    check(!contains(sweep_v2.c_str(), "response/frequency_points/frequency_0001.json"), "C ABI production CPU interrupted v2 sweep omits incomplete point");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_does_not_fallback_to_tiny_validation_solver()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_diagonal[] = {2.0, 4.0};
    const double mass_diagonal[] = {1.0, 2.0};
    const double drive_real[] = {1.0, 2.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.tiny_validation_stiffness_diagonal = stiffness_diagonal;
    request.tiny_validation_mass_diagonal = mass_diagonal;
    request.tiny_validation_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI production CPU solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI production CPU lane without MFEM operator payload reports unavailable");
    check(result.completed_frequency_count == 0, "C ABI production CPU lane does not solve validation frequency");
    check(
        contains(result.error_message, "production CPU"),
        "C ABI production CPU lane names missing operator payload");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_cpu\""),
        "C ABI production CPU diagnostics report lane");
    check(
        contains(result.diagnostics_json, "\"completed_frequency_point_count\":0"),
        "C ABI production CPU unavailable diagnostics report completed frequency point count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production CPU lane rejects validation fallback");
    check(
        !contains(result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "C ABI production CPU lane does not run tiny validation solver");

    fullmag_fem_frequency_domain_solve_result_release(&result);

    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU;
    fullmag_fem_frequency_domain_solve_result gpu_result{};
    const int gpu_status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &gpu_result);

    check(gpu_status == FULLMAG_FEM_OK, "C ABI production GPU solve boundary call succeeds");
    check(
        gpu_result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI production GPU lane reports unavailable");
    check(gpu_result.completed_frequency_count == 0, "C ABI production GPU lane does not solve validation frequency");
    check(
        contains(gpu_result.error_message, "production GPU"),
        "C ABI production GPU lane names missing solver");
    check(
        contains(gpu_result.diagnostics_json, "\"requested_execution_lane\":\"production_gpu\""),
        "C ABI production GPU diagnostics report lane");
    check(
        contains(gpu_result.diagnostics_json, "\"completed_frequency_point_count\":0"),
        "C ABI production GPU unavailable diagnostics report completed frequency point count");
    check(
        contains(gpu_result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production GPU lane rejects validation fallback");
    check(
        !contains(gpu_result.diagnostics_json, "\"tiny_validation_solver\":true"),
        "C ABI production GPU lane does not run tiny validation solver");

    fullmag_fem_frequency_domain_solve_result_release(&gpu_result);
}

void c_abi_periodic_airbox_dynamic_demag_request_is_explicitly_unavailable()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.requires_periodic_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI periodic-airbox demag boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI periodic-airbox demag reports unavailable until coupled block exists");
    check(
        contains(result.error_message, "periodic-airbox dynamic demag"),
        "C ABI periodic-airbox demag unavailable reason is explicit");
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "C ABI diagnostics report requested magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"resolved_magnetostatic_bc\":\"periodic_airbox_k0\""),
        "C ABI diagnostics report resolved magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"magnetic_periodic_constraint_set_count\":1"),
        "C ABI diagnostics report magnetic periodic constraint count");
    check(
        contains(result.diagnostics_json, "\"magnetostatic_periodic_constraint_set_count\":1"),
        "C ABI diagnostics report magnetostatic periodic constraint count");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI periodic-airbox demag request does not fall back to validation");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_periodic_airbox_dynamic_demag_requires_magnetostatic_periodic_node_pairs()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.requires_periodic_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = nullptr;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 2;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_drive_real = drive_real;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI periodic-airbox missing magnetostatic pairs call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI periodic-airbox missing magnetostatic node pairs is a validation error");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_missing_magnetostatic_periodic_node_pairs\""),
        "C ABI diagnostics name missing magnetostatic periodic node pairs");
    check(
        contains(result.error_message, "magnetostatic delta_phi periodic node pairs"),
        "C ABI missing magnetostatic pairs error is explicit");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_periodic_airbox_dynamic_demag_rejects_degenerate_magnetostatic_periodic_pair()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        0,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-periodic-airbox-degenerate-pair-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.requires_periodic_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI periodic-airbox degenerate pair call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI periodic-airbox rejects degenerate magnetostatic periodic pair");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_degenerate_magnetostatic_periodic_node_pair\""),
        "C ABI diagnostics name degenerate magnetostatic periodic pair");
    check(
        contains(result.error_message, "distinct magnetostatic delta_phi nodes"),
        "C ABI degenerate magnetostatic pair error is explicit");
    check(
        !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "C ABI degenerate magnetostatic pair rejection does not enter coupled block solver");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI degenerate magnetostatic pair rejection reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"validation_error\":\"periodic_airbox_degenerate_magnetostatic_periodic_node_pair\""),
        "C ABI degenerate magnetostatic pair manifest records machine-readable validation error");
    check(
        contains(manifest.c_str(), "\"magnetostatic_periodic_node_pair_count\":1"),
        "C ABI degenerate magnetostatic pair manifest preserves pair count");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_periodic_airbox_dynamic_demag_rejects_ambiguous_coupled_block_operator_provider()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-periodic-airbox-ambiguous-provider-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double stiffness_diagonal[] = {2.0, 3.0, 4.0};
    const double mass_diagonal[] = {1.0, 1.5, 0.0};
    const double drive_real[] = {1.0, 0.5, 0.0};
    DiagonalProductionOperator coupled_operator{
        stiffness_diagonal,
        mass_diagonal,
        3,
        0,
        0,
    };

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.requires_periodic_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_apply_stiffness = c_abi_apply_diagonal_stiffness;
    request.periodic_airbox_coupled_block_apply_mass = c_abi_apply_diagonal_mass;
    request.periodic_airbox_coupled_block_operator_user_data = &coupled_operator;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI ambiguous coupled-block provider call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI rejects ambiguous coupled-block operator provider");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"periodic_airbox_ambiguous_coupled_block_operator_provider\""),
        "C ABI diagnostics name ambiguous coupled-block operator provider");
    check(
        contains(result.error_message, "exactly one periodic-airbox coupled-block operator provider"),
        "C ABI ambiguous provider error is explicit");
    check(
        !contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "C ABI ambiguous provider rejection does not enter coupled block solver");
    check(
        coupled_operator.stiffness_call_count == 0 && coupled_operator.mass_call_count == 0,
        "C ABI ambiguous provider rejection does not invoke matrix-free callbacks");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI ambiguous provider rejection reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"validation_error\":\"periodic_airbox_ambiguous_coupled_block_operator_provider\""),
        "C ABI ambiguous provider manifest records machine-readable validation error");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_periodic_airbox_dynamic_demag_solves_explicit_coupled_block()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-periodic-airbox-coupled-block-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.25,
        0.0, 3.0, -0.5,
        0.25, -0.5, 4.0,
    };
    const double mass_matrix[] = {
        1.0, 0.0, 0.0,
        0.0, 1.5, 0.0,
        0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.requires_periodic_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.periodic_airbox_coupled_block_drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI explicit coupled block boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI periodic-airbox explicit coupled block reports ok");
    check(result.completed_frequency_count == 1, "C ABI explicit coupled block solves one point");
    check(
        contains(result.diagnostics_json, "\"periodic_airbox_coupled_block_solver\":true"),
        "C ABI explicit coupled block diagnostics record solver provenance");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI explicit coupled block reports manifest path");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"demag_contribution\":{\"status\":\"solved\""),
        "C ABI explicit coupled block writes solved demag contribution");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_complex\""),
        "C ABI explicit coupled block writes delta_phi response");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_floquet_airbox_dynamic_demag_solves_explicit_coupled_block_and_validates_delta_phi_phase()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.0;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = phase_rad;
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-floquet-airbox-coupled-block-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 3.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 2.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 3.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    };
    const double mass_matrix[] = {
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0, 0.0, 1.0, c};
    const double drive_imag[] = {0.0, 0.0, 0.0, 0.0, 0.0, s};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.requires_floquet_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 2;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.periodic_airbox_coupled_block_drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox explicit coupled block boundary call succeeds");
    char ok_status_message[384]{};
    std::snprintf(
        ok_status_message,
        sizeof(ok_status_message),
        "C ABI Floquet-airbox explicit coupled block reports ok (status=%d, error=%s)",
        result.status,
        result.error_message == nullptr ? "" : result.error_message);
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        ok_status_message);
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox coupled block diagnostics preserve requested magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"delta_phi_phase_validation_status\":\"ok\""),
        "C ABI Floquet-airbox coupled block diagnostics validate delta_phi phase");

    char manifest_path[256]{};
    char frequency_point_path[256]{};
    std::snprintf(
        manifest_path,
        sizeof(manifest_path),
        "%s/frequency_domain/manifest.v1.json",
        output_directory);
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string manifest = read_text_file(manifest_path);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox coupled block manifest records Floquet-airbox BC");
    check(
        contains(manifest.c_str(), "\"dynamic_demag_operator_source\":\"explicit_floquet_airbox_coupled_block_payload\""),
        "C ABI Floquet-airbox coupled block manifest records explicit Floquet-airbox operator source");
    check(
        contains(frequency_point.c_str(), "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox coupled block frequency point records Floquet-airbox BC");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_phase_validation_status\":\"ok\""),
        "C ABI Floquet-airbox coupled block frequency point records delta_phi phase validation");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_complex\""),
        "C ABI Floquet-airbox coupled block writes delta_phi complex response");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_floquet_airbox_dynamic_demag_rejects_explicit_coupled_block_delta_phi_phase_mismatch()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.0;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = phase_rad;
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-floquet-airbox-phase-mismatch-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 3.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 2.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 3.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    };
    const double mass_matrix[] = {
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0, 0.0, 1.0, c + 0.25};
    const double drive_imag[] = {0.0, 0.0, 0.0, 0.0, 0.0, s};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.requires_floquet_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 2;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.periodic_airbox_coupled_block_drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox phase-mismatch coupled block call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI Floquet-airbox rejects solved delta_phi phase mismatch");
    check(
        contains(result.diagnostics_json, "\"validation_error\":\"floquet_airbox_delta_phi_phase_mismatch\""),
        "C ABI Floquet-airbox phase mismatch diagnostics name validation error");
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox phase mismatch diagnostics preserve requested magnetostatic BC");
    check(
        contains(result.diagnostics_json, "\"delta_phi_phase_validation_status\":\"mismatch\""),
        "C ABI Floquet-airbox phase mismatch diagnostics record phase validation status");
    check(
        contains(result.diagnostics_json, "\"delta_phi_phase_max_residual\":"),
        "C ABI Floquet-airbox phase mismatch diagnostics record phase residual");
    check(
        contains(result.error_message, "violates Bloch phase constraints"),
        "C ABI Floquet-airbox phase mismatch error names Bloch phase constraint");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI Floquet-airbox phase mismatch reports a manifest path");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(
        contains(manifest.c_str(), "\"validation_error\":\"floquet_airbox_delta_phi_phase_mismatch\""),
        "C ABI Floquet-airbox phase mismatch manifest records validation error");
    check(
        contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox phase mismatch manifest preserves requested magnetostatic BC");
    check(
        contains(manifest.c_str(), "\"delta_phi_phase_validation_status\":\"mismatch\""),
        "C ABI Floquet-airbox phase mismatch manifest records phase validation status");
    check(
        contains(manifest.c_str(), "\"delta_phi_phase_max_residual\":"),
        "C ABI Floquet-airbox phase mismatch manifest records phase residual");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_floquet_airbox_dynamic_demag_gpu_rejects_explicit_coupled_block_without_cpu_fallback()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double phase_rad = -1.0;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    fullmag_fem_frequency_domain_floquet_periodic_pair floquet_pair{};
    floquet_pair.pair_id = "x_faces";
    floquet_pair.node_a = 0;
    floquet_pair.node_b = 1;
    floquet_pair.has_translation = 1;
    floquet_pair.translation_m[0] = 1.0e-6;
    floquet_pair.has_phase = 1;
    floquet_pair.phase_rad = phase_rad;
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-floquet-airbox-gpu-coupled-block-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    const double c = std::cos(phase_rad);
    const double s = std::sin(phase_rad);
    const double stiffness_matrix[] = {
        2.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 3.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 2.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 3.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    };
    const double mass_matrix[] = {
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    };
    const double drive_real[] = {1.0, 0.5, 0.0, 0.0, 1.0, c};
    const double drive_imag[] = {0.0, 0.0, 0.0, 0.0, 0.0, s};

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.has_floquet_k_vector = 1;
    request.floquet_k_vector_rad_per_m[0] = 1.0e6;
    request.mfem_floquet_periodic_pairs = &floquet_pair;
    request.mfem_floquet_periodic_pair_count = 1;
    request.requires_floquet_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_delta_phi_dof_count = 2;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 4;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 2;
    request.periodic_airbox_coupled_block_stiffness_matrix_row_major = stiffness_matrix;
    request.periodic_airbox_coupled_block_mass_matrix_row_major = mass_matrix;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.periodic_airbox_coupled_block_drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI Floquet-airbox GPU coupled-block rejection call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI Floquet-airbox GPU rejects supplied CPU coupled block as unavailable");
    check(
        contains(result.error_message, "production GPU"),
        "C ABI Floquet-airbox GPU rejection names production GPU lane");
    check(
        contains(result.diagnostics_json, "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_gpu_unsupported\""),
        "C ABI Floquet-airbox GPU diagnostics record GPU-specific unsupported reason");
    check(
        contains(result.diagnostics_json, "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox GPU diagnostics preserve requested magnetostatic BC");
    check(
        !contains(result.diagnostics_json, "explicit_floquet_airbox_coupled_block_payload"),
        "C ABI Floquet-airbox GPU diagnostics do not claim CPU explicit-block solver source");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string manifest = read_text_file(result.artifact_manifest_path);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(manifest.c_str(), "\"unsupported_reason\":\"floquet_airbox_dynamic_demag_gpu_unsupported\""),
        "C ABI Floquet-airbox GPU manifest records GPU-specific unsupported reason");
    check(
        contains(manifest.c_str(), "\"requested_magnetostatic_bc\":\"floquet_airbox\""),
        "C ABI Floquet-airbox GPU manifest preserves requested magnetostatic BC");
    check(
        contains(diagnostics.c_str(), "\"requested_execution_lane\":\"production_gpu\""),
        "C ABI Floquet-airbox GPU artifact diagnostics preserve requested GPU lane");
    check(
        contains(diagnostics.c_str(), "\"validation_fallback_used\":false"),
        "C ABI Floquet-airbox GPU artifact diagnostics record no validation fallback");
    check(
        !contains(manifest.c_str(), "explicit_floquet_airbox_coupled_block_payload"),
        "C ABI Floquet-airbox GPU manifest does not claim CPU explicit-block solver source");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_periodic_airbox_dynamic_demag_solves_matrix_free_coupled_block_provider()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const fullmag_fem_frequency_domain_periodic_node_pair magnetostatic_pair{
        0,
        1,
    };
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-periodic-airbox-matrix-free-coupled-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));
    const double stiffness_diagonal[] = {2.0, 3.0, 4.0};
    const double mass_diagonal[] = {1.0, 1.5, 0.0};
    const double drive_real[] = {1.0, 0.5, 0.0};
    const double drive_imag[] = {0.0, 0.0, 0.0};
    DiagonalProductionOperator coupled_operator{
        stiffness_diagonal,
        mass_diagonal,
        3,
        0,
        0,
    };

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.alpha = 0.01;
    request.gamma0 = 2.211e5;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.requires_periodic_airbox_dynamic_demag = 1;
    request.magnetic_periodic_constraint_set_count = 1;
    request.magnetostatic_periodic_constraint_set_count = 1;
    request.periodic_airbox_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_delta_phi_dof_count = 1;
    request.periodic_airbox_magnetostatic_periodic_node_pairs = &magnetostatic_pair;
    request.periodic_airbox_magnetostatic_periodic_node_pair_count = 1;
    request.periodic_airbox_coupled_block_enabled = 1;
    request.periodic_airbox_coupled_block_delta_m_tangent_dof_count = 2;
    request.periodic_airbox_coupled_block_delta_phi_dof_count = 1;
    request.periodic_airbox_coupled_block_apply_stiffness = c_abi_apply_diagonal_stiffness;
    request.periodic_airbox_coupled_block_apply_mass = c_abi_apply_diagonal_mass;
    request.periodic_airbox_coupled_block_operator_user_data = &coupled_operator;
    request.periodic_airbox_coupled_block_drive_real = drive_real;
    request.periodic_airbox_coupled_block_drive_imag = drive_imag;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI matrix-free coupled block boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI periodic-airbox matrix-free coupled block reports ok");
    check(result.completed_frequency_count == 1, "C ABI matrix-free coupled block solves one point");
    check(coupled_operator.stiffness_call_count > 0, "C ABI matrix-free coupled block calls stiffness provider");
    check(coupled_operator.mass_call_count > 0, "C ABI matrix-free coupled block calls mass provider");
    check(
        contains(result.diagnostics_json, "\"dynamic_demag_operator_source\":\"matrix_free_coupled_block_provider\""),
        "C ABI matrix-free coupled block diagnostics report provider operator source");

    char frequency_point_path[256]{};
    std::snprintf(
        frequency_point_path,
        sizeof(frequency_point_path),
        "%s/response/frequency_points/frequency_0000.json",
        output_directory);
    const std::string frequency_point = read_text_file(frequency_point_path);
    check(
        contains(frequency_point.c_str(), "\"operator_source\":\"matrix_free_coupled_block_provider\""),
        "C ABI matrix-free coupled block frequency point records provider source");
    check(
        contains(frequency_point.c_str(), "\"delta_phi_complex\""),
        "C ABI matrix-free coupled block writes delta_phi response");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_runs_mfem_dmi_matrix_free_response_problem()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double drive_real[] = {1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0};
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    fullmag_fem_frequency_domain_dmi_element dmi_element{};
    dmi_element.kind = FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK;
    dmi_element.node_indices[0] = 0;
    dmi_element.node_indices[1] = 1;
    dmi_element.node_indices[2] = 2;
    dmi_element.node_indices[3] = 3;
    dmi_element.shape[0] = 0.25;
    dmi_element.shape[1] = 0.25;
    dmi_element.shape[2] = 0.25;
    dmi_element.shape[3] = 0.25;
    const double grad_shape[] = {
        -1.0, -1.0, -1.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    for (int index = 0; index < 12; ++index) {
        dmi_element.grad_shape[index] = grad_shape[index];
    }
    dmi_element.weight = volume;
    dmi_element.d = d;
    dmi_element.normal[2] = 1.0;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 4;
    request.tangent_dof_count = 8;
    request.alpha = 0.01;
    request.gamma0 = 1.0;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium;
    request.mfem_drive_real = drive_real;
    request.mfem_dmi_elements = &dmi_element;
    request.mfem_dmi_element_count = 1;
    request.mfem_dmi_lumped_mass = lumped_mass_per_node;
    request.mfem_dmi_uniform_ms = ms;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI production CPU DMI solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
        "C ABI production CPU DMI lane solves through MFEM payload");
    check(result.completed_frequency_count == 1, "C ABI production CPU DMI lane completes frequency");
    check(
        contains(result.diagnostics_json, "\"matrix_free_solver\":true"),
        "C ABI production CPU DMI diagnostics report matrix-free solver");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI production CPU DMI diagnostics reject validation fallback");
    check(
        contains(result.result_json, "\"requested_execution_lane\":\"production_cpu\""),
        "C ABI production CPU DMI result reports lane");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_production_cpu_lane_rejects_unknown_dmi_kind()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    const double drive_real[] = {1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0};
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    fullmag_fem_frequency_domain_dmi_element dmi_element{};
    dmi_element.kind = static_cast<fullmag_fem_frequency_domain_dmi_kind>(99);
    dmi_element.node_indices[0] = 0;
    dmi_element.node_indices[1] = 1;
    dmi_element.node_indices[2] = 2;
    dmi_element.node_indices[3] = 3;
    dmi_element.shape[0] = 0.25;
    dmi_element.shape[1] = 0.25;
    dmi_element.shape[2] = 0.25;
    dmi_element.shape[3] = 0.25;
    const double grad_shape[] = {
        -1.0, -1.0, -1.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    for (int index = 0; index < 12; ++index) {
        dmi_element.grad_shape[index] = grad_shape[index];
    }
    dmi_element.weight = volume;
    dmi_element.d = d;
    dmi_element.normal[2] = 1.0;

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 4;
    request.tangent_dof_count = 8;
    request.alpha = 0.01;
    request.gamma0 = 1.0;
    request.requested_execution_lane = FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.mfem_operator_enabled = 1;
    request.mfem_equilibrium_m = equilibrium;
    request.mfem_drive_real = drive_real;
    request.mfem_dmi_elements = &dmi_element;
    request.mfem_dmi_element_count = 1;
    request.mfem_dmi_lumped_mass = lumped_mass_per_node;
    request.mfem_dmi_uniform_ms = ms;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI unknown DMI kind solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR,
        "C ABI unknown DMI kind reports validation error");
    check(result.completed_frequency_count == 0, "C ABI unknown DMI kind completes no frequency");
    check(contains(result.error_message, "kind"), "C ABI unknown DMI kind error names kind");
    check(
        contains(result.diagnostics_json, "\"requested_execution_lane\":\"production_cpu\""),
        "C ABI unknown DMI kind diagnostics keep production CPU lane");
    check(
        contains(result.diagnostics_json, "\"validation_fallback_used\":false"),
        "C ABI unknown DMI kind rejects validation fallback");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_reports_unavailable_failure_artifacts()
{
    const double frequencies_hz[] = {3.0e9};
    char output_directory[192]{};
    std::snprintf(
        output_directory,
        sizeof(output_directory),
        "/tmp/fullmag-frequency-domain-c-abi-unavailable-%llu",
        static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&frequencies_hz)));

    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.output_directory = output_directory;
    request.write_partial_artifacts = 1;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI unavailable artifact solve boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI unavailable artifact solve reports unavailable");
    check(result.completed_frequency_count == 0, "C ABI unavailable artifact solve completes no frequencies");
    check(
        result.written_frequency_point_artifacts == 0,
        "C ABI unavailable artifact solve writes no point artifacts");
    check(
        contains(result.artifact_manifest_path, "frequency_domain/manifest.v1.json"),
        "C ABI unavailable artifact solve reports manifest path");
    check(
        contains(result.result_json, "frequency_domain/manifest.v1.json"),
        "C ABI unavailable artifact solve reports manifest path in result JSON");

    const std::string manifest = read_text_file(result.artifact_manifest_path);
    check(contains(manifest.c_str(), "\"status\":\"unavailable\""), "C ABI failure manifest records unavailable");
    check(
        contains(manifest.c_str(), "\"frequency_count\":1"),
        "C ABI failure manifest records requested frequency count");
    check(
        contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics/solver.v1.json\""),
        "C ABI failure manifest links diagnostics");
    check(
        contains(manifest.c_str(), "\"solver_diagnostics_path\":\"response/diagnostics/solver.v1.json\""),
        "C ABI failure manifest links solver diagnostics");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics/solver.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"solver_kind\":\"production_unavailable\""),
        "C ABI failure diagnostics records unavailable solver kind");
    check(
        contains(diagnostics.c_str(), "\"requested_frequency_count\":1"),
        "C ABI failure diagnostics records requested frequency count");
    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(contains(progress.c_str(), "\"state\":\"unavailable\""), "C ABI failure progress records unavailable state");
    check(
        contains(progress.c_str(), "\"total_frequency_points\":1"),
        "C ABI failure progress records requested frequency count");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void c_abi_driven_response_solve_interrupts_before_start()
{
    const double frequencies_hz[] = {3.0e9};
    fullmag_fem_frequency_domain_driven_response_request request{};
    request.node_count = 2;
    request.tangent_dof_count = 4;
    request.alpha = 0.02;
    request.gamma0 = 2.211e5;
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.cancel_requested = c_abi_cancel_immediately;

    fullmag_fem_frequency_domain_solve_result result{};
    const int status =
        fullmag_fem_frequency_domain_solve_driven_response(&request, &result);

    check(status == FULLMAG_FEM_OK, "C ABI pre-start cancel boundary call succeeds");
    check(
        result.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED,
        "C ABI pre-start cancel reports interrupted");
    check(result.completed_frequency_count == 0, "C ABI pre-start cancel completes no frequencies");
    check(
        result.written_frequency_point_artifacts == 0,
        "C ABI pre-start cancel writes no point artifacts");
    check(contains(result.result_json, "\"status\":\"interrupted\""), "C ABI pre-start cancel result JSON reports interrupted");
    check(
        contains(result.result_json, "\"partial_artifacts_available\":false"),
        "C ABI pre-start cancel result JSON reports no partial artifacts");

    fullmag_fem_frequency_domain_solve_result_release(&result);
}

void mfem_operator_context_descriptor_accepts_consistent_tetra_mesh()
{
    const double nodes_xyz[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const std::uint32_t elements[] = {0, 1, 2, 3};
    const std::uint32_t element_material_ids[] = {7};
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode tangent_nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, tangent_nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM operator context test tangent frame succeeds");

    fd::FrequencyDomainOperatorRequest operator_request{};
    operator_request.node_count = 4;
    operator_request.tangent_dof_count = 8;
    operator_request.boundary_kind = fd::FrequencyDomainBoundaryKind::open_boundary;
    operator_request.demag_kind = fd::FrequencyDomainDemagKind::none;
    operator_request.alpha = 0.01;
    operator_request.gamma0 = 2.211e5;
    operator_request.include_exchange = true;
    operator_request.include_zeeman = true;

    fd::MfemOperatorContextRequest request{};
    request.node_count = 4;
    request.element_count = 1;
    request.element_node_count = 4;
    request.material_region_count = 1;
    request.nodes_xyz = nodes_xyz;
    request.elements = elements;
    request.element_material_ids = element_material_ids;
    request.tangent_nodes = tangent_nodes;
    request.operator_request = operator_request;
    request.has_mfem_mesh = true;

    fd::MfemOperatorContextDescriptor descriptor{};
    fd::MfemOperatorContextDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status =
        fd::build_mfem_operator_context_descriptor(request, &descriptor, &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM operator context descriptor succeeds");
    check(descriptor.node_count == 4, "MFEM descriptor keeps node count");
    check(descriptor.element_count == 1, "MFEM descriptor keeps element count");
    check(descriptor.full_dof_count == 12, "MFEM descriptor reports full vector DOFs");
    check(descriptor.tangent_dof_count == 8, "MFEM descriptor reports tangent DOFs");
    check(descriptor.material_region_count == 1, "MFEM descriptor reports material regions");
    check(descriptor.exchange_enabled, "MFEM descriptor records exchange flag");
    check(descriptor.zeeman_enabled, "MFEM descriptor records zeeman flag");
    check(!descriptor.demag_enabled, "MFEM descriptor records demag disabled");
    check(diagnostics.node_count == 4, "MFEM diagnostics keep node count");
    check(diagnostics.element_count == 1, "MFEM diagnostics keep element count");
    check(diagnostics.tangent_dof_count == 8, "MFEM diagnostics keep tangent DOFs");
    check(diagnostics.mfem_mesh_available, "MFEM diagnostics record mesh availability");
}

void mfem_operator_context_descriptor_rejects_inconsistent_tangent_dofs()
{
    const double nodes_xyz[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const std::uint32_t elements[] = {0, 1, 2, 3};
    fd::TangentFrameNode tangent_nodes[4]{};
    fd::FrequencyDomainOperatorRequest operator_request{};
    operator_request.node_count = 4;
    operator_request.tangent_dof_count = 7;
    operator_request.alpha = 0.01;
    operator_request.gamma0 = 2.211e5;

    fd::MfemOperatorContextRequest request{};
    request.node_count = 4;
    request.element_count = 1;
    request.element_node_count = 4;
    request.material_region_count = 1;
    request.nodes_xyz = nodes_xyz;
    request.elements = elements;
    request.tangent_nodes = tangent_nodes;
    request.operator_request = operator_request;
    request.has_mfem_mesh = true;

    fd::MfemOperatorContextDescriptor descriptor{};
    fd::MfemOperatorContextDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status =
        fd::build_mfem_operator_context_descriptor(request, &descriptor, &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "MFEM operator context rejects inconsistent tangent DOFs");
    check(contains(diagnostics.error_message, "tangent"), "MFEM context error names tangent DOFs");
}

void mfem_tangent_space_layout_uses_two_dofs_per_node()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.material_region_count = 1;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status =
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM tangent space layout succeeds");
    check(layout.node_count == 4, "MFEM tangent layout keeps node count");
    check(layout.full_dof_count == 12, "MFEM tangent layout keeps full DOFs");
    check(layout.tangent_dof_count == 8, "MFEM tangent layout keeps tangent DOFs");
    check(layout.full_components_per_node == 3, "MFEM tangent layout records full components");
    check(layout.tangent_components_per_node == 2, "MFEM tangent layout records tangent components");
    check(layout.tangent_stride == 2, "MFEM tangent layout uses compact tangent stride");
    check(layout.e1_component_offset == 0, "MFEM tangent layout e1 offset");
    check(layout.e2_component_offset == 1, "MFEM tangent layout e2 offset");
    check(diagnostics.node_count == 4, "MFEM tangent diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 8, "MFEM tangent diagnostics keep tangent DOFs");
}

void mfem_tangent_space_layout_rejects_inconsistent_full_dofs()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.full_dof_count = 11;
    descriptor.tangent_dof_count = 8;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status =
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "MFEM tangent layout rejects inconsistent full DOFs");
    check(contains(diagnostics.error_message, "full"), "MFEM tangent layout error names full DOFs");
}

void mfem_exchange_operator_applies_edge_graph_in_tangent_layout()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.element_count = 1;
    descriptor.element_node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.material_region_count = 1;
    descriptor.exchange_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM exchange test tangent layout succeeds");

    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        2.0,
    };
    const double tangent_in[] = {1.0, 2.0, -3.0, 4.0};
    double tangent_out[4]{};
    fd::MfemExchangeOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_exchange_operator(
        descriptor,
        layout,
        &edge,
        1,
        tangent_in,
        tangent_out,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM exchange operator adapter succeeds");
    check(diagnostics.node_count == 2, "MFEM exchange diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "MFEM exchange diagnostics keep tangent DOFs");
    check(diagnostics.edge_count == 1, "MFEM exchange diagnostics keep edge count");
    check(diagnostics.max_abs_output == 8.0, "MFEM exchange diagnostics report max output");
    check(std::abs(tangent_out[0] - 8.0) < 1.0e-12, "MFEM exchange output node0 e1");
    check(std::abs(tangent_out[1] + 4.0) < 1.0e-12, "MFEM exchange output node0 e2");
    check(std::abs(tangent_out[2] + 8.0) < 1.0e-12, "MFEM exchange output node1 e1");
    check(std::abs(tangent_out[3] - 4.0) < 1.0e-12, "MFEM exchange output node1 e2");
}

void mfem_exchange_operator_rejects_disabled_exchange_descriptor()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.exchange_enabled = false;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        1.0,
    };
    const double tangent_in[] = {1.0, 0.0, 0.0, 1.0};
    double tangent_out[4]{};
    fd::MfemExchangeOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_exchange_operator(
        descriptor,
        layout,
        &edge,
        1,
        tangent_in,
        tangent_out,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::unavailable, "MFEM exchange operator rejects disabled descriptor");
    check(contains(diagnostics.error_message, "exchange"), "MFEM exchange disabled error names exchange");
}

void mfem_zeeman_operator_applies_parallel_field_blocks_in_tangent_layout()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM Zeeman test tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.element_count = 1;
    descriptor.element_node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.material_region_count = 1;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM Zeeman test tangent layout succeeds");

    const double h_ext_a_per_m[] = {-2.0, 0.0, 3.0};
    fd::TangentOperatorLocalBlock workspace_blocks[2]{};
    const double tangent_in[] = {2.0, -1.0, 3.0, 4.0};
    double tangent_out[4]{};
    fd::MfemZeemanOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_zeeman_operator(
        descriptor,
        layout,
        nodes,
        h_ext_a_per_m,
        workspace_blocks,
        tangent_in,
        tangent_out,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM Zeeman operator adapter succeeds");
    check(diagnostics.node_count == 2, "MFEM Zeeman diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "MFEM Zeeman diagnostics keep tangent DOFs");
    check(std::abs(diagnostics.max_parallel_field_abs - 3.0) < 1.0e-12, "MFEM Zeeman diagnostics max parallel");
    check(std::abs(diagnostics.max_abs_output + 0.0 - 8.0) < 1.0e-12, "MFEM Zeeman diagnostics max output");
    check(std::abs(tangent_out[0] + 6.0) < 1.0e-12, "MFEM Zeeman output node0 e1");
    check(std::abs(tangent_out[1] - 3.0) < 1.0e-12, "MFEM Zeeman output node0 e2");
    check(std::abs(tangent_out[2] - 6.0) < 1.0e-12, "MFEM Zeeman output node1 e1");
    check(std::abs(tangent_out[3] - 8.0) < 1.0e-12, "MFEM Zeeman output node1 e2");
}

void mfem_zeeman_operator_rejects_disabled_zeeman_descriptor()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = false;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    fd::TangentFrameNode node{};
    const double h_ext_a_per_m[] = {0.0, 0.0, 1.0};
    fd::TangentOperatorLocalBlock workspace_block{};
    const double tangent_in[] = {1.0, 0.0};
    double tangent_out[2]{};
    fd::MfemZeemanOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_zeeman_operator(
        descriptor,
        layout,
        &node,
        h_ext_a_per_m,
        &workspace_block,
        tangent_in,
        tangent_out,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::unavailable, "MFEM Zeeman operator rejects disabled descriptor");
    check(contains(diagnostics.error_message, "Zeeman"), "MFEM Zeeman disabled error names Zeeman");
}

void compute_tangent_gradients_for_tetra(
    const double tangent[8],
    const double grad_shape[4][3],
    double out_q[3],
    double out_grad[3][3])
{
    for (int comp = 0; comp < 3; ++comp) {
        out_q[comp] = 0.0;
        for (int dir = 0; dir < 3; ++dir) {
            out_grad[comp][dir] = 0.0;
        }
    }
    for (int node = 0; node < 4; ++node) {
        const double value[3] = {
            tangent[node * 2],
            tangent[node * 2 + 1],
            0.0,
        };
        for (int comp = 0; comp < 3; ++comp) {
            out_q[comp] += 0.25 * value[comp];
            for (int dir = 0; dir < 3; ++dir) {
                out_grad[comp][dir] += value[comp] * grad_shape[node][dir];
            }
        }
    }
}

double bulk_dmi_weak_action_for_tangent_tetra(
    const double delta_tangent[8],
    const double test_tangent[8],
    const double grad_shape[4][3],
    double d,
    double volume)
{
    double delta_q[3]{};
    double test_q[3]{};
    double grad_delta[3][3]{};
    double grad_test[3][3]{};
    compute_tangent_gradients_for_tetra(delta_tangent, grad_shape, delta_q, grad_delta);
    compute_tangent_gradients_for_tetra(test_tangent, grad_shape, test_q, grad_test);

    const double curl_delta[3] = {
        grad_delta[2][1] - grad_delta[1][2],
        grad_delta[0][2] - grad_delta[2][0],
        grad_delta[1][0] - grad_delta[0][1],
    };
    const double curl_test[3] = {
        grad_test[2][1] - grad_test[1][2],
        grad_test[0][2] - grad_test[2][0],
        grad_test[1][0] - grad_test[0][1],
    };
    return d * volume * (
        test_q[0] * curl_delta[0] +
        test_q[1] * curl_delta[1] +
        test_q[2] * curl_delta[2] +
        delta_q[0] * curl_test[0] +
        delta_q[1] * curl_test[1] +
        delta_q[2] * curl_test[2]);
}

double interfacial_dmi_weak_action_for_tangent_tetra(
    const double delta_tangent[8],
    const double test_tangent[8],
    const double grad_shape[4][3],
    const double normal[3],
    double d,
    double volume)
{
    double delta_q[3]{};
    double test_q[3]{};
    double grad_delta[3][3]{};
    double grad_test[3][3]{};
    compute_tangent_gradients_for_tetra(delta_tangent, grad_shape, delta_q, grad_delta);
    compute_tangent_gradients_for_tetra(test_tangent, grad_shape, test_q, grad_test);

    const double div_delta = grad_delta[0][0] + grad_delta[1][1] + grad_delta[2][2];
    const double delta_dot_n =
        delta_q[0] * normal[0] + delta_q[1] * normal[1] + delta_q[2] * normal[2];
    double value_action = 0.0;
    double gradient_action = 0.0;
    for (int comp = 0; comp < 3; ++comp) {
        const double grad_delta_dot_n =
            normal[0] * grad_delta[0][comp] +
            normal[1] * grad_delta[1][comp] +
            normal[2] * grad_delta[2][comp];
        const double dw_dm = d * (normal[comp] * div_delta - grad_delta_dot_n);
        value_action += dw_dm * test_q[comp];
        for (int dir = 0; dir < 3; ++dir) {
            const double delta = comp == dir ? 1.0 : 0.0;
            const double dw_dg = d * (delta_dot_n * delta - normal[comp] * delta_q[dir]);
            gradient_action += dw_dg * grad_test[comp][dir];
        }
    }
    return volume * (value_action + gradient_action);
}

double tangent_dmi_virtual_action(
    const double h_tangent[8],
    const double test_tangent[8],
    double lumped_mass,
    double ms)
{
    constexpr double mu0 = 4.0e-7 * 3.14159265358979323846;
    double action = 0.0;
    for (int node = 0; node < 4; ++node) {
        action -= mu0 * ms * lumped_mass *
            (h_tangent[node * 2] * test_tangent[node * 2] +
             h_tangent[node * 2 + 1] * test_tangent[node * 2 + 1]);
    }
    return action;
}

void check_relative_close(double actual, double expected, double tolerance, const char *msg)
{
    const double denom = std::fmax(std::fmax(std::abs(actual), std::abs(expected)), 1.0e-30);
    check(std::abs(actual - expected) / denom <= tolerance, msg);
}

void fill_bulk_dmi_tetra_element(fd::MfemDmiElementTangentData &element, double d, double volume)
{
    const double grad_shape[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    element = fd::MfemDmiElementTangentData{};
    element.kind = fd::MfemDmiInteractionKind::bulk;
    element.node_indices[0] = 0;
    element.node_indices[1] = 1;
    element.node_indices[2] = 2;
    element.node_indices[3] = 3;
    element.weight = volume;
    element.d = d;
    for (int node = 0; node < 4; ++node) {
        element.shape[node] = 0.25;
        for (int dir = 0; dir < 3; ++dir) {
            element.grad_shape[node][dir] = grad_shape[node][dir];
        }
    }
}

void mfem_dmi_operator_applies_preassembled_tangent_blocks()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    fd::TangentOperatorLocalBlock dmi_block{
        fd::FrequencyDomainOperatorTermKind::dmi,
        2.0,
        -1.0,
        3.0,
        4.0,
    };
    const double tangent_in[] = {5.0, 7.0};
    double dmi_tangent[2]{};
    fd::MfemDmiOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_dmi_operator(
        descriptor,
        layout,
        &dmi_block,
        tangent_in,
        dmi_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM DMI operator accepts DMI tangent block");
    check(diagnostics.node_count == 1, "MFEM DMI diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 2, "MFEM DMI diagnostics keep tangent DOFs");
    check(std::abs(dmi_tangent[0] - 3.0) < 1.0e-12, "MFEM DMI output e1");
    check(std::abs(dmi_tangent[1] - 43.0) < 1.0e-12, "MFEM DMI output e2");
    check(std::abs(diagnostics.max_abs_output - 43.0) < 1.0e-12, "MFEM DMI diagnostics max output");
}

void mfem_dmi_operator_rejects_non_dmi_blocks()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    fd::TangentOperatorLocalBlock not_dmi_block{
        fd::FrequencyDomainOperatorTermKind::zeeman,
        1.0,
        0.0,
        0.0,
        1.0,
    };
    const double tangent_in[] = {1.0, 2.0};
    double dmi_tangent[2]{};
    fd::MfemDmiOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_dmi_operator(
        descriptor,
        layout,
        &not_dmi_block,
        tangent_in,
        dmi_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "MFEM DMI operator rejects non-DMI block");
    check(contains(diagnostics.error_message, "DMI tangent blocks"), "MFEM DMI block error names DMI blocks");
}

void mfem_dmi_element_tangent_operator_matches_bulk_weak_action()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM bulk DMI tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double grad_shape[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    fd::MfemDmiElementTangentData element{};
    element.kind = fd::MfemDmiInteractionKind::bulk;
    element.node_indices[0] = 0;
    element.node_indices[1] = 1;
    element.node_indices[2] = 2;
    element.node_indices[3] = 3;
    element.weight = volume;
    element.d = d;
    for (int node = 0; node < 4; ++node) {
        element.shape[node] = 0.25;
        for (int dir = 0; dir < 3; ++dir) {
            element.grad_shape[node][dir] = grad_shape[node][dir];
        }
    }

    const double tangent_in[] = {0.03, 0.04, -0.08, 0.01, 0.06, -0.07, -0.01, 0.05};
    const double test_tangent[] = {0.10, -0.03, -0.04, 0.08, 0.05, 0.02, -0.02, -0.06};
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    double workspace_delta_xyz[12]{};
    double workspace_residual_xyz[12]{};
    double workspace_field_xyz[12]{};
    double out_tangent[8]{};
    fd::MfemDmiOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_dmi_element_tangent_operator(
        descriptor,
        layout,
        nodes,
        &element,
        1,
        lumped_mass_per_node,
        nullptr,
        ms,
        tangent_in,
        workspace_delta_xyz,
        workspace_residual_xyz,
        workspace_field_xyz,
        out_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM bulk DMI element tangent operator succeeds");
    check(diagnostics.element_count == 1, "MFEM bulk DMI diagnostics keep element count");
    check(diagnostics.max_abs_output > 0.0, "MFEM bulk DMI diagnostics report nonzero tangent output");
    const double actual = tangent_dmi_virtual_action(out_tangent, test_tangent, lumped_mass, ms);
    const double expected =
        bulk_dmi_weak_action_for_tangent_tetra(tangent_in, test_tangent, grad_shape, d, volume);
    check_relative_close(actual, expected, 1.0e-12, "MFEM bulk DMI tangent action matches weak residual");
}

void mfem_dmi_element_tangent_operator_rejects_nonfinite_geometry()
{
    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM DMI non-finite geometry frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    fd::MfemDmiElementTangentData element{};
    fill_bulk_dmi_tetra_element(element, d, volume);
    element.grad_shape[0][0] = std::numeric_limits<double>::infinity();
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    const double tangent_in[] = {1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0};
    double delta_xyz[12]{};
    double residual_xyz[12]{};
    double field_xyz[12]{};
    double dmi_tangent[8]{};
    fd::MfemDmiOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_dmi_element_tangent_operator(
        descriptor,
        layout,
        nodes,
        &element,
        1,
        lumped_mass_per_node,
        nullptr,
        ms,
        tangent_in,
        delta_xyz,
        residual_xyz,
        field_xyz,
        dmi_tangent,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "MFEM DMI element tangent operator rejects non-finite geometry");
    check(
        contains(diagnostics.error_message, "finite"),
        "MFEM DMI non-finite geometry rejection explains finite geometry requirement");
    check(diagnostics.max_abs_output == 0.0, "MFEM DMI non-finite geometry publishes no output diagnostic");
    for (double value : dmi_tangent) {
        check(value == 0.0, "MFEM DMI non-finite geometry leaves tangent output untouched");
    }
}

void mfem_dmi_element_tangent_operator_rejects_unknown_kind()
{
    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM DMI unknown kind frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    fd::MfemDmiElementTangentData element{};
    fill_bulk_dmi_tetra_element(element, d, volume);
    element.kind = static_cast<fd::MfemDmiInteractionKind>(99);
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    const double tangent_in[] = {1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0};
    double delta_xyz[12]{};
    double residual_xyz[12]{};
    double field_xyz[12]{};
    double dmi_tangent[8]{};
    fd::MfemDmiOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_dmi_element_tangent_operator(
        descriptor,
        layout,
        nodes,
        &element,
        1,
        lumped_mass_per_node,
        nullptr,
        ms,
        tangent_in,
        delta_xyz,
        residual_xyz,
        field_xyz,
        dmi_tangent,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "MFEM DMI element tangent operator rejects unknown interaction kind");
    check(
        contains(diagnostics.error_message, "kind"),
        "MFEM DMI unknown interaction kind rejection names kind");
    for (double value : dmi_tangent) {
        check(value == 0.0, "MFEM DMI unknown kind leaves tangent output untouched");
    }
}

void mfem_dmi_element_tangent_operator_matches_interfacial_weak_action()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM interfacial DMI tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 3.0e-3;
    const double grad_shape[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    const double normal[3] = {0.0, 0.0, 1.0};
    fd::MfemDmiElementTangentData element{};
    element.kind = fd::MfemDmiInteractionKind::interfacial;
    element.node_indices[0] = 0;
    element.node_indices[1] = 1;
    element.node_indices[2] = 2;
    element.node_indices[3] = 3;
    element.weight = volume;
    element.d = d;
    for (int node = 0; node < 4; ++node) {
        element.shape[node] = 0.25;
        for (int dir = 0; dir < 3; ++dir) {
            element.grad_shape[node][dir] = grad_shape[node][dir];
        }
    }
    for (int dir = 0; dir < 3; ++dir) {
        element.normal[dir] = normal[dir];
    }

    const double tangent_in[] = {0.03, 0.04, -0.08, 0.01, 0.06, -0.07, -0.01, 0.05};
    const double test_tangent[] = {0.10, -0.03, -0.04, 0.08, 0.05, 0.02, -0.02, -0.06};
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    double workspace_delta_xyz[12]{};
    double workspace_residual_xyz[12]{};
    double workspace_field_xyz[12]{};
    double out_tangent[8]{};
    fd::MfemDmiOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_dmi_element_tangent_operator(
        descriptor,
        layout,
        nodes,
        &element,
        1,
        lumped_mass_per_node,
        nullptr,
        ms,
        tangent_in,
        workspace_delta_xyz,
        workspace_residual_xyz,
        workspace_field_xyz,
        out_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM interfacial DMI element tangent operator succeeds");
    check(diagnostics.max_abs_full_field > 0.0, "MFEM interfacial DMI diagnostics report nonzero field");
    const double actual = tangent_dmi_virtual_action(out_tangent, test_tangent, lumped_mass, ms);
    const double expected = interfacial_dmi_weak_action_for_tangent_tetra(
        tangent_in,
        test_tangent,
        grad_shape,
        normal,
        d,
        volume);
    check_relative_close(actual, expected, 1.0e-12, "MFEM interfacial DMI tangent action matches weak residual");
}

void mfem_linearized_operator_combines_exchange_zeeman_precession_and_mass()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized operator test tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.element_count = 1;
    descriptor.element_node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.material_region_count = 1;
    descriptor.exchange_enabled = true;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized operator test tangent layout succeeds");

    const fd::TangentOperatorEdgeBlock exchange_edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        2.0,
    };
    const double h_ext_a_per_m[] = {0.0, 0.0, 3.0};
    const double tangent_in[] = {1.0, 2.0, -3.0, 4.0};
    fd::TangentOperatorLocalBlock zeeman_blocks[2]{};
    fd::TangentOperatorLocalBlock anisotropy_blocks[2]{};
    double exchange_workspace[4]{};
    double zeeman_workspace[4]{};
    double anisotropy_workspace[4]{};
    double effective_field_workspace[4]{};
    fd::MfemLinearizedOperatorWorkspace workspace{
        zeeman_blocks,
        anisotropy_blocks,
        exchange_workspace,
        zeeman_workspace,
        anisotropy_workspace,
        effective_field_workspace,
    };
    double stiffness_rhs[4]{};
    double mass_rhs[4]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        nodes,
        &exchange_edge,
        1,
        h_ext_a_per_m,
        nullptr,
        0.0,
        nullptr,
        10.0,
        0.1,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM linearized CPU operator succeeds");
    check(diagnostics.node_count == 2, "MFEM linearized diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "MFEM linearized diagnostics keep tangent DOFs");
    check(diagnostics.exchange_edge_count == 1, "MFEM linearized diagnostics keep exchange edge count");
    check(std::abs(diagnostics.max_abs_effective_field - 10.0) < 1.0e-12, "MFEM linearized diagnostics effective field max");
    check(std::abs(diagnostics.max_abs_stiffness_rhs - 100.0) < 1.0e-12, "MFEM linearized diagnostics stiffness max");
    check(std::abs(diagnostics.max_abs_mass_rhs - 4.3) < 1.0e-12, "MFEM linearized diagnostics mass max");
    check(std::abs(effective_field_workspace[0] - 5.0) < 1.0e-12, "MFEM linearized effective node0 e1");
    check(std::abs(effective_field_workspace[1] + 10.0) < 1.0e-12, "MFEM linearized effective node0 e2");
    check(std::abs(effective_field_workspace[2] - 1.0) < 1.0e-12, "MFEM linearized effective node1 e1");
    check(std::abs(effective_field_workspace[3] + 8.0) < 1.0e-12, "MFEM linearized effective node1 e2");
    check(std::abs(stiffness_rhs[0] + 100.0) < 1.0e-12, "MFEM linearized stiffness node0 e1");
    check(std::abs(stiffness_rhs[1] + 50.0) < 1.0e-12, "MFEM linearized stiffness node0 e2");
    check(std::abs(stiffness_rhs[2] + 80.0) < 1.0e-12, "MFEM linearized stiffness node1 e1");
    check(std::abs(stiffness_rhs[3] + 10.0) < 1.0e-12, "MFEM linearized stiffness node1 e2");
    check(std::abs(mass_rhs[0] - 1.2) < 1.0e-12, "MFEM linearized mass node0 e1");
    check(std::abs(mass_rhs[1] - 1.9) < 1.0e-12, "MFEM linearized mass node0 e2");
    check(std::abs(mass_rhs[2] + 2.6) < 1.0e-12, "MFEM linearized mass node1 e1");
    check(std::abs(mass_rhs[3] - 4.3) < 1.0e-12, "MFEM linearized mass node1 e2");
}

void mfem_linearized_operator_adds_preassembled_dmi_field()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM DMI linearized frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    fd::TangentOperatorLocalBlock dmi_block{
        fd::FrequencyDomainOperatorTermKind::dmi,
        2.0,
        -1.0,
        3.0,
        4.0,
    };
    const double tangent_in[] = {5.0, 7.0};
    double dmi_workspace[2]{};
    double effective_field_workspace[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.effective_field_tangent = effective_field_workspace;
    workspace.dmi_blocks = &dmi_block;
    workspace.dmi_tangent = dmi_workspace;
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        nullptr,
        nullptr,
        0.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM DMI linearized operator succeeds");
    check(std::abs(diagnostics.max_abs_dmi_field - 43.0) < 1.0e-12, "MFEM DMI linearized diagnostics");
    check(std::abs(effective_field_workspace[0] - 3.0) < 1.0e-12, "MFEM DMI effective e1");
    check(std::abs(effective_field_workspace[1] - 43.0) < 1.0e-12, "MFEM DMI effective e2");
    check(std::abs(stiffness_rhs[0] - 43.0) < 1.0e-12, "MFEM DMI stiffness e1");
    check(std::abs(stiffness_rhs[1] + 3.0) < 1.0e-12, "MFEM DMI stiffness e2");
    check(std::abs(mass_rhs[0] - 5.0) < 1.0e-12, "MFEM DMI mass e1");
    check(std::abs(mass_rhs[1] - 7.0) < 1.0e-12, "MFEM DMI mass e2");
}

void mfem_linearized_operator_adds_element_dmi_field()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[4]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 4, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized element DMI tangent frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.element_count = 1;
    descriptor.element_node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.dmi_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 4;
    layout.full_dof_count = 12;
    layout.tangent_dof_count = 8;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    constexpr double volume = 1.0 / 6.0;
    constexpr double lumped_mass = volume * 0.25;
    constexpr double ms = 800000.0;
    constexpr double d = 2.0e-3;
    const double grad_shape[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    fd::MfemDmiElementTangentData element{};
    element.kind = fd::MfemDmiInteractionKind::bulk;
    element.node_indices[0] = 0;
    element.node_indices[1] = 1;
    element.node_indices[2] = 2;
    element.node_indices[3] = 3;
    element.weight = volume;
    element.d = d;
    for (int node = 0; node < 4; ++node) {
        element.shape[node] = 0.25;
        for (int dir = 0; dir < 3; ++dir) {
            element.grad_shape[node][dir] = grad_shape[node][dir];
        }
    }

    const double tangent_in[] = {0.03, 0.04, -0.08, 0.01, 0.06, -0.07, -0.01, 0.05};
    const double test_tangent[] = {0.10, -0.03, -0.04, 0.08, 0.05, 0.02, -0.02, -0.06};
    const double lumped_mass_per_node[] = {lumped_mass, lumped_mass, lumped_mass, lumped_mass};
    double dmi_workspace[8]{};
    double dmi_delta_xyz[12]{};
    double dmi_residual_xyz[12]{};
    double dmi_field_xyz[12]{};
    double effective_field_workspace[8]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.effective_field_tangent = effective_field_workspace;
    workspace.dmi_tangent = dmi_workspace;
    workspace.dmi_elements = &element;
    workspace.dmi_element_count = 1;
    workspace.dmi_lumped_mass = lumped_mass_per_node;
    workspace.dmi_uniform_ms = ms;
    workspace.dmi_delta_xyz = dmi_delta_xyz;
    workspace.dmi_residual_xyz = dmi_residual_xyz;
    workspace.dmi_field_xyz = dmi_field_xyz;
    double stiffness_rhs[8]{};
    double mass_rhs[8]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        nodes,
        nullptr,
        0,
        nullptr,
        nullptr,
        0.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM linearized element DMI operator succeeds");
    check(diagnostics.max_abs_dmi_field > 0.0, "MFEM linearized element DMI diagnostics");
    const double actual = tangent_dmi_virtual_action(effective_field_workspace, test_tangent, lumped_mass, ms);
    const double expected =
        bulk_dmi_weak_action_for_tangent_tetra(tangent_in, test_tangent, grad_shape, d, volume);
    check_relative_close(actual, expected, 1.0e-12, "MFEM linearized element DMI action matches weak residual");
}

void mfem_linearized_operator_adds_uniaxial_anisotropy_field()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM uniaxial anisotropy linearized frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.uniaxial_anisotropy_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double anisotropy_axis[] = {1.0, 0.0, 0.0};
    const double tangent_in[] = {3.0, 5.0};
    fd::TangentOperatorLocalBlock zeeman_block{};
    fd::TangentOperatorLocalBlock anisotropy_block{};
    double zeeman_workspace[2]{};
    double anisotropy_workspace[2]{};
    double effective_field_workspace[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.zeeman_blocks = &zeeman_block;
    workspace.uniaxial_anisotropy_blocks = &anisotropy_block;
    workspace.zeeman_tangent = zeeman_workspace;
    workspace.uniaxial_anisotropy_tangent = anisotropy_workspace;
    workspace.effective_field_tangent = effective_field_workspace;
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        h_ext_a_per_m,
        anisotropy_axis,
        4.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM uniaxial anisotropy linearized operator succeeds");
    check(
        std::abs(diagnostics.max_abs_uniaxial_anisotropy_field - 12.0) < 1.0e-12,
        "MFEM uniaxial anisotropy diagnostics report anisotropy field");
    check(std::abs(effective_field_workspace[0] - 6.0) < 1.0e-12, "MFEM uniaxial anisotropy effective e1");
    check(std::abs(effective_field_workspace[1] + 10.0) < 1.0e-12, "MFEM uniaxial anisotropy effective e2");
    check(std::abs(stiffness_rhs[0] + 10.0) < 1.0e-12, "MFEM uniaxial anisotropy stiffness e1");
    check(std::abs(stiffness_rhs[1] + 6.0) < 1.0e-12, "MFEM uniaxial anisotropy stiffness e2");
}

void mfem_linearized_operator_uses_nodewise_alpha_mass()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM nodewise alpha frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 2;
    layout.full_dof_count = 6;
    layout.tangent_dof_count = 4;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double tangent_in[] = {2.0, -3.0, 4.0, 5.0};
    const double alpha_per_node[] = {0.1, 0.3};
    fd::TangentOperatorLocalBlock zeeman_blocks[2]{};
    double zeeman_workspace[4]{};
    double effective_field_workspace[4]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.zeeman_blocks = zeeman_blocks;
    workspace.zeeman_tangent = zeeman_workspace;
    workspace.effective_field_tangent = effective_field_workspace;
    double stiffness_rhs[4]{};
    double mass_rhs[4]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        nodes,
        nullptr,
        0,
        h_ext_a_per_m,
        nullptr,
        0.0,
        alpha_per_node,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM nodewise alpha operator succeeds");
    check(std::abs(diagnostics.max_abs_mass_rhs - 5.5) < 1.0e-12, "MFEM nodewise alpha mass diagnostic");
    check(std::abs(mass_rhs[0] - 1.7) < 1.0e-12, "MFEM nodewise alpha mass node0 e1");
    check(std::abs(mass_rhs[1] + 3.2) < 1.0e-12, "MFEM nodewise alpha mass node0 e2");
    check(std::abs(mass_rhs[2] - 5.5) < 1.0e-12, "MFEM nodewise alpha mass node1 e1");
    check(std::abs(mass_rhs[3] - 3.8) < 1.0e-12, "MFEM nodewise alpha mass node1 e2");
}

void mfem_linearized_operator_adds_explicit_demag_field()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM explicit demag linearized frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.demag_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    const double tangent_in[] = {2.0, 3.0};
    const double demag_tangent[] = {7.0, -11.0};
    double effective_field_workspace[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.effective_field_tangent = effective_field_workspace;
    workspace.demag_tangent = demag_tangent;
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        nullptr,
        nullptr,
        0.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM linearized operator accepts explicit demag field");
    check(std::abs(diagnostics.max_abs_demag_field - 11.0) < 1.0e-12, "MFEM explicit demag diagnostics");
    check(std::abs(effective_field_workspace[0] - 7.0) < 1.0e-12, "MFEM explicit demag effective e1");
    check(std::abs(effective_field_workspace[1] + 11.0) < 1.0e-12, "MFEM explicit demag effective e2");
    check(std::abs(stiffness_rhs[0] + 11.0) < 1.0e-12, "MFEM explicit demag stiffness e1");
    check(std::abs(stiffness_rhs[1] + 7.0) < 1.0e-12, "MFEM explicit demag stiffness e2");
    check(std::abs(mass_rhs[0] - 2.0) < 1.0e-12, "MFEM explicit demag mass e1");
    check(std::abs(mass_rhs[1] - 3.0) < 1.0e-12, "MFEM explicit demag mass e2");
}

void mfem_linearized_operator_rejects_unassembled_demag()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM demag linearized frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.demag_enabled = true;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;

    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double tangent_in[] = {3.0, 5.0};
    fd::TangentOperatorLocalBlock zeeman_block{};
    double zeeman_workspace[2]{};
    double effective_field_workspace[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.zeeman_blocks = &zeeman_block;
    workspace.zeeman_tangent = zeeman_workspace;
    workspace.effective_field_tangent = effective_field_workspace;
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        h_ext_a_per_m,
        nullptr,
        0.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::unavailable,
        "MFEM linearized operator rejects demag until assembly exists");
    check(
        contains(diagnostics.error_message, "demag"),
        "MFEM linearized demag rejection names demag");
    check(
        contains(diagnostics.error_message, "assembly"),
        "MFEM linearized demag rejection names missing assembly");
}

void mfem_linearized_operator_rejects_missing_workspace()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    const fd::TangentFrameNode node{};
    const double h_ext_a_per_m[] = {0.0, 0.0, 1.0};
    const double tangent_in[] = {1.0, 0.0};
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        h_ext_a_per_m,
        nullptr,
        0.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "MFEM linearized operator rejects missing workspace");
    check(contains(diagnostics.error_message, "workspace"), "MFEM linearized missing workspace error names workspace");
}

void mfem_linearized_operator_rejects_missing_exchange_workspace()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized missing exchange workspace frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 2;
    descriptor.element_count = 1;
    descriptor.element_node_count = 2;
    descriptor.full_dof_count = 6;
    descriptor.tangent_dof_count = 4;
    descriptor.material_region_count = 1;
    descriptor.exchange_enabled = true;
    descriptor.mfem_mesh_available = true;

    fd::MfemTangentSpaceLayout layout{};
    fd::MfemTangentSpaceDiagnostics layout_diagnostics{};
    check(
        fd::build_mfem_tangent_space_layout(descriptor, &layout, &layout_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized missing exchange workspace layout succeeds");

    const fd::TangentOperatorEdgeBlock exchange_edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        1.0,
    };
    const double tangent_in[] = {1.0, 0.0, -1.0, 0.0};
    double effective_field_workspace[4]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.effective_field_tangent = effective_field_workspace;
    double stiffness_rhs[4]{};
    double mass_rhs[4]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        nodes,
        &exchange_edge,
        1,
        nullptr,
        nullptr,
        0.0,
        nullptr,
        1.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "MFEM linearized rejects missing exchange workspace");
    check(contains(diagnostics.error_message, "exchange workspace"), "MFEM linearized missing exchange workspace names exchange");
}

void mfem_linearized_operator_rejects_invalid_gamma()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized invalid gamma frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double tangent_in[] = {1.0, 0.0};
    fd::TangentOperatorLocalBlock zeeman_block{};
    double zeeman_workspace[2]{};
    double effective_field_workspace[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.zeeman_blocks = &zeeman_block;
    workspace.zeeman_tangent = zeeman_workspace;
    workspace.effective_field_tangent = effective_field_workspace;
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        h_ext_a_per_m,
        nullptr,
        0.0,
        nullptr,
        0.0,
        0.0,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "MFEM linearized rejects invalid gamma");
    check(contains(diagnostics.error_message, "gamma0"), "MFEM linearized invalid gamma error names gamma0");
}

void mfem_linearized_operator_rejects_invalid_alpha()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM linearized invalid alpha frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double tangent_in[] = {1.0, 0.0};
    fd::TangentOperatorLocalBlock zeeman_block{};
    double zeeman_workspace[2]{};
    double effective_field_workspace[2]{};
    fd::MfemLinearizedOperatorWorkspace workspace{};
    workspace.zeeman_blocks = &zeeman_block;
    workspace.zeeman_tangent = zeeman_workspace;
    workspace.effective_field_tangent = effective_field_workspace;
    double stiffness_rhs[2]{};
    double mass_rhs[2]{};
    fd::MfemLinearizedOperatorDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_mfem_linearized_cpu_operator(
        descriptor,
        layout,
        &node,
        nullptr,
        0,
        h_ext_a_per_m,
        nullptr,
        0.0,
        nullptr,
        1.0,
        -0.1,
        workspace,
        tangent_in,
        stiffness_rhs,
        mass_rhs,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "MFEM linearized rejects invalid alpha");
    check(contains(diagnostics.error_message, "alpha"), "MFEM linearized invalid alpha error names alpha");
}

void mfem_driven_response_validation_assembles_linearized_operator_columns()
{
    constexpr double one_over_two_pi_hz = 0.15915494309189535;
    const double frequencies_hz[] = {one_over_two_pi_hz};
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "MFEM driven response validation frame succeeds");

    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 1;
    descriptor.full_dof_count = 3;
    descriptor.tangent_dof_count = 2;
    descriptor.zeeman_enabled = true;
    descriptor.mfem_mesh_available = true;
    fd::MfemTangentSpaceLayout layout{};
    layout.node_count = 1;
    layout.full_dof_count = 3;
    layout.tangent_dof_count = 2;
    layout.tangent_components_per_node = 2;
    layout.tangent_stride = 2;
    const double h_ext_a_per_m[] = {0.0, 0.0, 2.0};
    const double drive_real[] = {1.0, 0.0};
    fd::MfemDrivenResponseValidationProblem problem{};
    problem.descriptor = descriptor;
    problem.layout = layout;
    problem.nodes = &node;
    problem.h_ext_a_per_m = h_ext_a_per_m;
    problem.gamma0 = 1.0;
    problem.alpha = 0.0;
    problem.frequencies_hz = frequencies_hz;
    problem.frequency_count = 1;
    problem.drive_real = drive_real;
    fd::MfemDrivenResponseValidationResult result{};

    const fd::FrequencyDomainStatus status =
        fd::solve_mfem_driven_response_validation_problem(problem, &result);

    check(status == fd::FrequencyDomainStatus::ok, "MFEM driven response validation solve succeeds");
    check(result.completed_frequency_count == 1, "MFEM driven response validation completes one frequency");
    check(std::abs(result.max_abs_response - (2.0 / 3.0)) < 1.0e-12, "MFEM driven response validation max response");
    check(std::abs(result.max_abs_stiffness_matrix - 2.0) < 1.0e-12, "MFEM driven response validation stiffness diagnostic");
    check(std::abs(result.max_abs_mass_matrix - 1.0) < 1.0e-12, "MFEM driven response validation mass diagnostic");
}

void equilibrium_state_reports_stationary_residuals()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    const double static_field[] = {
        0.0, 0.0, 5.0,
        3.0, 0.0, 0.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::EquilibriumStateDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::build_equilibrium_state(equilibrium, static_field, 2, 1.0e-9, nodes, &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "stationary equilibrium state succeeds");
    check(diagnostics.node_count == 2, "equilibrium diagnostics keep node count");
    check(diagnostics.max_norm_error < 1.0e-12, "equilibrium diagnostics report unit vectors");
    check(diagnostics.max_m_cross_h_abs < 1.0e-12, "stationary equilibrium has zero max torque");
    check(diagnostics.rms_m_cross_h_abs < 1.0e-12, "stationary equilibrium has zero RMS torque");
    check(std::abs(nodes[0].m[2] - 1.0) < 1.0e-12, "equilibrium state writes tangent node");
}

void equilibrium_state_rejects_large_static_torque()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    const double static_field[] = {2.0, 0.0, 0.0};
    fd::TangentFrameNode node{};
    fd::EquilibriumStateDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::build_equilibrium_state(equilibrium, static_field, 1, 1.0, &node, &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "nonstationary equilibrium is rejected");
    check(std::abs(diagnostics.max_m_cross_h_abs - 2.0) < 1.0e-12, "torque diagnostic reports max m cross H");
    check(std::abs(diagnostics.rms_m_cross_h_abs - 2.0) < 1.0e-12, "torque diagnostic reports RMS m cross H");
    check(contains(diagnostics.error_message, "equilibrium"), "torque rejection explains equilibrium");
}

void excitation_projects_uniform_field_into_tangent_space()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "excitation test frame build succeeds");

    const double uniform_drive_a_per_m[] = {1.0, 2.0, 3.0};
    double tangent_drive[4]{};
    fd::TangentExcitationDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::build_uniform_field_tangent_excitation(
        nodes,
        2,
        uniform_drive_a_per_m,
        tangent_drive,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "uniform field excitation projection succeeds");
    check(diagnostics.node_count == 2, "excitation diagnostics keep node count");
    check(diagnostics.tangent_dof_count == 4, "excitation diagnostics keep tangent DOFs");
    check(std::abs(diagnostics.max_abs_tangent_drive - 3.0) < 1.0e-12, "excitation diagnostics report max tangent drive");
    check(std::abs(tangent_drive[0] - 1.0) < 1.0e-12, "excitation node0 e1");
    check(std::abs(tangent_drive[1] - 2.0) < 1.0e-12, "excitation node0 e2");
    check(std::abs(tangent_drive[2] - 2.0) < 1.0e-12, "excitation node1 e1");
    check(std::abs(tangent_drive[3] - 3.0) < 1.0e-12, "excitation node1 e2");
}

void excitation_rejects_zero_tangent_drive()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "zero excitation test frame build succeeds");

    const double uniform_drive_a_per_m[] = {0.0, 0.0, 5.0};
    double tangent_drive[2]{};
    fd::TangentExcitationDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::build_uniform_field_tangent_excitation(
        &node,
        1,
        uniform_drive_a_per_m,
        tangent_drive,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::validation_error, "zero tangent excitation is rejected");
    check(diagnostics.max_abs_tangent_drive < 1.0e-12, "zero tangent excitation diagnostic");
    check(contains(diagnostics.error_message, "excitation"), "zero tangent excitation explains rejection");
}

} // namespace

int main()
{
    enum_strings_are_stable();
    availability_probe_is_noexcept();
    initial_sweep_progress_reports_not_started_contract();
    interrupted_sweep_progress_preserves_partial_artifacts();
    interrupted_sweep_progress_reports_no_partial_artifacts_before_first_point();
    cancelling_sweep_progress_preserves_cancel_request_state();
    cancelling_sweep_progress_reports_no_partial_artifacts_before_first_point();
    completed_sweep_progress_preserves_completed_artifacts();
    driven_response_cpu_slice_is_available();
    static_periodic_driven_response_is_explicitly_available();
    driven_response_solver_accepts_fmr_env_aliases_source_contract();
    driven_response_floquet_boundary_is_explicitly_unavailable();
    driven_response_floquet_k_metadata_is_explicitly_unavailable();
    driven_response_gamma_floquet_k_metadata_keeps_response_available();
    modal_solver_is_explicitly_unavailable();
    floquet_dynamic_demag_k_is_blocked();
    strict_gpu_lane_reports_no_demag_capability_when_cuda_runtime_is_available();
    strict_gpu_static_periodic_response_is_available_when_cuda_runtime_is_available();
    c_abi_reports_frequency_domain_availability();
    c_abi_reports_floquet_k_metadata_as_unavailable();
    c_abi_reports_gamma_floquet_k_metadata_as_available_static_periodic();
    c_abi_reports_strict_gpu_no_demag_availability();
    c_abi_frequency_domain_availability_rejects_unknown_study_kind();
    c_abi_frequency_domain_availability_rejects_unknown_phase_convention();
    c_abi_rejects_null_arguments();
    c_abi_reports_frequency_domain_progress();
    c_abi_periodic_airbox_dynamic_demag_solves_matrix_free_coupled_block_provider();
    tangent_frame_builds_orthonormal_basis_and_projects_vectors();
    tangent_frame_rejects_non_unit_equilibrium();
    tangent_operator_applies_local_blocks_and_reports_diagnostics();
    tangent_operator_rejects_unsupported_terms();
    tangent_operator_rejects_nonfinite_local_block_coefficients();
    zeeman_tangent_block_uses_parallel_field_and_reports_transverse_residual();
    zeeman_tangent_block_rejects_nonfinite_external_field();
    uniaxial_anisotropy_tangent_blocks_project_axis_into_tangent_space();
    exchange_edge_operator_applies_tangent_graph_laplacian();
    exchange_edge_operator_rejects_out_of_range_nodes();
    exchange_edge_operator_rejects_nonfinite_stiffness();
    tangent_operator_applies_combined_nodewise_and_edge_terms();
    tangent_operator_rejects_nonfinite_combined_edge_stiffness();
    tangent_nodewise_operator_rejects_nonfinite_local_block_coefficients();
    tangent_combined_operator_rejects_nonfinite_local_block_coefficients();
    tangent_precession_operator_rotates_effective_field_variation();
    tangent_damping_operator_rotates_perturbation_by_alpha();
    tangent_frequency_mass_operator_combines_identity_and_damping_rotation();
    tangent_frequency_mass_operator_uses_nodewise_alpha();
    operator_contract_validates_driven_and_modal_requests_separately();
    operator_contract_rejects_invalid_frequency_sweep();
    driven_response_solver_boundary_returns_structured_unavailable_result();
    driven_response_solver_writes_failure_artifacts_for_unavailable_run();
    production_gpu_unavailable_artifact_reports_gpu_lane();
    production_gpu_static_periodic_no_demag_runs_mfem_response_problem();
    production_cpu_floquet_local_no_demag_runs_phase_constrained_response_problem();
    production_gpu_floquet_local_no_demag_runs_phase_constrained_response_problem();
    production_cpu_floquet_exchange_no_demag_runs_phase_constrained_response_problem();
    production_gpu_floquet_exchange_no_demag_runs_phase_constrained_response_problem();
    driven_response_solver_respects_disabled_partial_failure_artifacts();
    driven_response_solver_boundary_validates_request_before_unavailable_solve();
    driven_response_solver_runs_tiny_diagonal_validation_problem();
    driven_response_solver_runs_tiny_dense_validation_problem();
    driven_response_solver_preserves_tiny_dense_solve_error_status();
    production_cpu_matrix_free_solver_solves_diagonal_harmonic_response();
    production_cpu_matrix_free_solver_skips_zero_initial_residual_operator();
    production_cpu_matrix_free_solver_solves_complex_drive();
    production_cpu_matrix_free_solver_preserves_nonconvergence_diagnostics();
    production_cpu_matrix_free_solver_requires_recomputed_residual_for_convergence();
    production_cpu_lane_writes_failure_artifacts_for_nonconverged_gmres();
    production_cpu_matrix_free_solver_respects_temporal_phase_convention_sign();
    production_cpu_matrix_free_solver_rejects_invalid_phase_convention_sign();
    production_cpu_matrix_free_solver_reports_progress();
    production_cpu_matrix_free_solver_reuses_previous_frequency_solution_as_warm_start();
    production_cpu_matrix_free_solver_honors_pre_start_cancel_without_operator_work();
    production_cpu_matrix_free_solver_honors_mid_frequency_cancel_without_completion();
    production_cpu_matrix_free_solver_rejects_overflowing_problem_size();
    production_cpu_matrix_free_solver_rejects_nonfinite_operator_output();
    production_cpu_lane_does_not_fallback_to_tiny_validation_solver();
    production_cpu_periodic_airbox_dynamic_demag_is_explicitly_unavailable();
    production_cpu_periodic_airbox_dynamic_demag_writes_bc_artifacts();
    production_cpu_periodic_airbox_dynamic_demag_solves_explicit_coupled_block();
    production_cpu_periodic_airbox_dynamic_demag_requires_constraint_sets_before_coupled_block();
    production_cpu_periodic_airbox_dynamic_demag_requires_delta_phi_dofs();
    production_cpu_periodic_airbox_dynamic_demag_rejects_coupled_block_layout_mismatch();
    production_cpu_periodic_airbox_dynamic_demag_rejects_delta_m_tangent_dof_mismatch();
    production_cpu_periodic_airbox_dynamic_demag_solves_matrix_free_coupled_block_provider();
    production_cpu_periodic_airbox_dynamic_demag_solves_mfem_demag_tangent_provider();
    production_cpu_periodic_airbox_dynamic_demag_writes_solve_error_artifacts();
    production_gpu_periodic_airbox_dynamic_demag_rejects_explicit_coupled_block();
    production_cpu_periodic_airbox_dynamic_demag_applies_mean_zero_gauge_for_phi_nullspace();
    driven_response_solver_runs_assembled_mfem_validation_problem();
    driven_response_solver_runs_assembled_mfem_dmi_validation_problem();
    production_cpu_lane_runs_mfem_matrix_free_response_problem();
    production_gpu_lane_runs_mfem_no_demag_response_problem();
    production_cpu_lane_runs_mfem_matrix_free_explicit_demag_response_problem();
    production_cpu_lane_runs_mfem_matrix_free_demag_callback_response_problem();
    production_cpu_lane_rejects_nonfinite_zeeman_field_before_matrix_free_solve();
    production_cpu_lane_runs_mfem_matrix_free_dmi_response_problem();
    production_cpu_lane_accepts_more_than_sixteen_frequency_points();
    production_cpu_lane_writes_matrix_free_response_artifacts();
    production_cpu_lane_writes_large_matrix_free_field_payload();
    production_cpu_lane_writes_multi_point_matrix_free_response_artifacts();
    production_cpu_lane_interruption_preserves_partial_artifacts();
    driven_response_solver_writes_minimal_assembled_validation_artifacts();
    driven_response_solver_respects_disabled_response_field_payloads();
    driven_response_solver_interruption_preserves_partial_validation_artifacts();
    c_abi_driven_response_solve_reports_structured_unavailable_result();
    c_abi_driven_response_solve_rejects_floquet_metadata();
    c_abi_driven_response_solve_reports_floquet_airbox_unsupported_with_artifacts();
    c_abi_driven_response_solve_rejects_floquet_airbox_missing_delta_phi_pairs();
    c_abi_driven_response_solve_rejects_invalid_floquet_airbox_delta_phi_pairs();
    c_abi_driven_response_solve_rejects_floquet_airbox_delta_phi_pair_without_phase_metadata();
    c_abi_driven_response_solve_rejects_inconsistent_floquet_phase_metadata();
    c_abi_driven_response_solve_rejects_inconsistent_floquet_phase_loop();
    c_abi_driven_response_solve_rejects_nonperiodic_floquet_drive_before_unsupported_path();
    c_abi_driven_response_solve_rejects_floquet_tangent_frame_mismatch_before_unsupported_path();
    c_abi_driven_response_solve_treats_gamma_floquet_metadata_as_zero_phase_periodic();
    c_abi_driven_response_solve_rejects_unknown_execution_lane();
    c_abi_driven_response_solve_rejects_unknown_phase_convention();
    c_abi_driven_response_solve_runs_tiny_validation_problem();
    c_abi_driven_response_solve_runs_complex_tiny_validation_problem();
    c_abi_driven_response_manifest_preserves_temporal_phase_convention();
    c_abi_production_cpu_lane_runs_mfem_matrix_free_response_problem();
    c_abi_gamma_floquet_production_cpu_matches_static_periodic_response();
    c_abi_production_cpu_lane_runs_mfem_matrix_free_explicit_demag_response_problem();
    c_abi_production_cpu_lane_runs_mfem_matrix_free_demag_provider_response_problem();
    c_abi_production_cpu_lane_rejects_invalid_static_periodic_requests();
    c_abi_production_cpu_lane_rejects_invalid_equilibrium_before_solve();
    c_abi_production_cpu_lane_interruption_preserves_partial_artifacts();
    c_abi_production_cpu_lane_does_not_fallback_to_tiny_validation_solver();
    c_abi_periodic_airbox_dynamic_demag_request_is_explicitly_unavailable();
    c_abi_periodic_airbox_dynamic_demag_requires_magnetostatic_periodic_node_pairs();
    c_abi_periodic_airbox_dynamic_demag_rejects_degenerate_magnetostatic_periodic_pair();
    c_abi_periodic_airbox_dynamic_demag_rejects_ambiguous_coupled_block_operator_provider();
    c_abi_periodic_airbox_dynamic_demag_solves_explicit_coupled_block();
    c_abi_floquet_airbox_dynamic_demag_solves_explicit_coupled_block_and_validates_delta_phi_phase();
    c_abi_floquet_airbox_dynamic_demag_rejects_explicit_coupled_block_delta_phi_phase_mismatch();
    c_abi_floquet_airbox_dynamic_demag_gpu_rejects_explicit_coupled_block_without_cpu_fallback();
    c_abi_production_cpu_lane_runs_mfem_dmi_matrix_free_response_problem();
    c_abi_production_cpu_lane_rejects_unknown_dmi_kind();
    c_abi_driven_response_solve_reports_unavailable_failure_artifacts();
    c_abi_driven_response_solve_interrupts_before_start();
    mfem_operator_context_descriptor_accepts_consistent_tetra_mesh();
    mfem_operator_context_descriptor_rejects_inconsistent_tangent_dofs();
    mfem_tangent_space_layout_uses_two_dofs_per_node();
    mfem_tangent_space_layout_rejects_inconsistent_full_dofs();
    mfem_exchange_operator_applies_edge_graph_in_tangent_layout();
    mfem_exchange_operator_rejects_disabled_exchange_descriptor();
    mfem_zeeman_operator_applies_parallel_field_blocks_in_tangent_layout();
    mfem_zeeman_operator_rejects_disabled_zeeman_descriptor();
    mfem_dmi_operator_applies_preassembled_tangent_blocks();
    mfem_dmi_operator_rejects_non_dmi_blocks();
    mfem_dmi_element_tangent_operator_matches_bulk_weak_action();
    mfem_dmi_element_tangent_operator_rejects_nonfinite_geometry();
    mfem_dmi_element_tangent_operator_rejects_unknown_kind();
    mfem_dmi_element_tangent_operator_matches_interfacial_weak_action();
    mfem_linearized_operator_combines_exchange_zeeman_precession_and_mass();
    mfem_linearized_operator_adds_preassembled_dmi_field();
    mfem_linearized_operator_adds_element_dmi_field();
    mfem_linearized_operator_adds_uniaxial_anisotropy_field();
    mfem_linearized_operator_uses_nodewise_alpha_mass();
    mfem_linearized_operator_adds_explicit_demag_field();
    mfem_linearized_operator_rejects_unassembled_demag();
    mfem_linearized_operator_rejects_missing_workspace();
    mfem_linearized_operator_rejects_missing_exchange_workspace();
    mfem_linearized_operator_rejects_invalid_gamma();
    mfem_linearized_operator_rejects_invalid_alpha();
    mfem_driven_response_validation_assembles_linearized_operator_columns();
    equilibrium_state_reports_stationary_residuals();
    equilibrium_state_rejects_large_static_torque();
    excitation_projects_uniform_field_into_tangent_space();
    excitation_rejects_zero_tangent_drive();
    return 0;
}
