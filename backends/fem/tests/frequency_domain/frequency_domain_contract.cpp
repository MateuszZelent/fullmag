/*
 * frequency_domain_contract.cpp - native FEM frequency-domain contract tests.
 */

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/driven_response_solver.hpp"
#include "frequency_domain/equilibrium_state.hpp"
#include "frequency_domain/excitation.hpp"
#include "frequency_domain/operator_contract.hpp"
#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "frequency_domain/zeeman_operator.hpp"
#include "fullmag_fem.h"
#include "cpu/frequency_domain/mfem_exchange_operator.hpp"
#include "cpu/frequency_domain/mfem_driven_response_validation.hpp"
#include "cpu/frequency_domain/mfem_linearized_operator.hpp"
#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "cpu/frequency_domain/mfem_zeeman_operator.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
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

struct CancelAfterFirstPoll {
    int poll_count = 0;
};

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

int c_abi_cancel_immediately(void *)
{
    return 1;
}

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

void driven_response_is_explicitly_unavailable()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.study_kind = fd::FrequencyDomainStudyKind::driven_frequency_response;
    request.requires_driven_solver = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(result.status == fd::FrequencyDomainStatus::unavailable, "driven status is unavailable");
    check(fd::status_is_error(result.status), "unavailable driven status is an error");
    check(!result.driven_response_available, "driven response is not marked available");
    check(!result.modal_solver_available, "modal solver is not marked available");
    check(contains(result.error_message, "driven"), "driven unavailable reason names solver");
    check(
        contains(result.diagnostics_json, "frequency_domain_availability.v1"),
        "diagnostics schema is reported");
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

void strict_gpu_lane_is_blocked()
{
    fd::FrequencyDomainAvailabilityRequest request{};
    request.requires_gpu = true;
    request.strict_device = true;

    const fd::FrequencyDomainAvailabilityResult result =
        fd::frequency_domain_availability(request);

    check(result.status == fd::FrequencyDomainStatus::unavailable, "strict GPU is unavailable");
    check(!result.gpu_available, "GPU lane is not marked available");
    check(contains(result.error_message, "GPU"), "unavailable reason names GPU lane");
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
        info.status == FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE,
        "C ABI reports unavailable status");
    check(
        std::strcmp(info.status_name, "unavailable") == 0,
        "C ABI reports status string");
    check(
        std::strcmp(info.study_kind_name, "frequency_response") == 0,
        "C ABI reports study kind string");
    check(
        info.driven_response_available == 0,
        "C ABI does not mark driven response available");
    check(contains(info.reason, "driven"), "C ABI reason names driven solver");
    check(
        contains(info.diagnostics_json, "frequency_domain_availability.v1"),
        "C ABI diagnostics JSON reports schema");
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
    check(std::abs(blocks[0].a00 - 3.0) < 1.0e-12, "Zeeman z block a00");
    check(std::abs(blocks[0].a11 - 3.0) < 1.0e-12, "Zeeman z block a11");
    check(std::abs(blocks[0].a01) < 1.0e-12, "Zeeman z block a01");
    check(std::abs(blocks[0].a10) < 1.0e-12, "Zeeman z block a10");
    check(diagnostics.node_count == 1, "Zeeman diagnostics node count");
    check(diagnostics.max_transverse_field_abs < 1.0e-12, "parallel field has no transverse residual");

    check(
        fd::build_zeeman_tangent_blocks(nodes + 1, h1, 1, blocks + 1, &diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "Zeeman tangent block for x equilibrium succeeds");
    check(std::abs(blocks[1].a00 + 2.0) < 1.0e-12, "Zeeman x block a00");
    check(std::abs(blocks[1].a11 + 2.0) < 1.0e-12, "Zeeman x block a11");
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
    check(std::abs(tangent_out[0] - 6.0) < 1.0e-12, "Zeeman output node0 e1");
    check(std::abs(tangent_out[1] + 3.0) < 1.0e-12, "Zeeman output node0 e2");
    check(std::abs(tangent_out[2] + 6.0) < 1.0e-12, "Zeeman output node1 e1");
    check(std::abs(tangent_out[3] + 8.0) < 1.0e-12, "Zeeman output node1 e2");
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
    check(std::abs(rhs_tangent[0] - 30.0) < 1.0e-12, "precession output e1");
    check(std::abs(rhs_tangent[1] - 20.0) < 1.0e-12, "precession output e2");
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
        contains(result.diagnostics_json, "frequency_domain_driven_response_result.v1"),
        "driven solve diagnostics JSON reports schema");
    check(result.result_json != nullptr, "driven solve result has result JSON");
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
    check(contains(manifest.c_str(), "\"production_solver_available\":false"), "failure manifest records production solver unavailable");
    check(
        contains(manifest.c_str(), "\"failure_diagnostics_path\":\"frequency_domain/diagnostics.v1.json\""),
        "failure manifest links diagnostics artifact");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/frequency_domain/diagnostics.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"schema_version\":\"frequency_domain_diagnostics.v1\""),
        "failure diagnostics schema is written");
    check(contains(diagnostics.c_str(), "\"status\":\"unavailable\""), "failure diagnostics reports unavailable status");
    check(
        contains(diagnostics.c_str(), "\"solver_kind\":\"production_unavailable\""),
        "failure diagnostics records unavailable solver kind");
    check(
        contains(diagnostics.c_str(), "native FEM driven frequency-response solver is not implemented"),
        "failure diagnostics records unavailable reason");

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
    check(contains(result.diagnostics_json, "frequency_domain_driven_response_result.v1"), "validation diagnostics has schema");
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
    check(contains(manifest.c_str(), "\"completed_frequency_count\":2"), "manifest records completed frequency count");
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
    check(contains(manifest.c_str(), "\"response_diagnostics_v1_path\":\"response/diagnostics.v1.json\""), "manifest links response diagnostics");
    check(contains(manifest.c_str(), "\"frequency_point_paths\""), "manifest links frequency-point metadata");
    check(contains(manifest.c_str(), "response/frequency_points/frequency_0001.json"), "manifest links second frequency-point metadata");
    check(contains(manifest.c_str(), "\"response_field_resources\""), "manifest links response field payload resources");
    check(contains(manifest.c_str(), "response/field_payloads/frequency_0001/vector.bin"), "manifest links second field payload resource");

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
    check(contains(sweep.c_str(), "\"m_complex\":[[0,-0.333333333333333"), "response sweep records first complex tangent component");
    check(contains(sweep.c_str(), "[-0.666666666666666"), "response sweep records second complex tangent component");
    check(contains(sweep.c_str(), "\"component_response_amplitude\":[0.333333333333333"), "response sweep records component amplitudes");
    check(contains(sweep.c_str(), "\"component_response_phase\":[-1.570796326794896"), "response sweep records first component phase");
    check(contains(sweep.c_str(), "\"residual_source\":\"dense_block_real\""), "response sweep records residual source");
    check(!contains(sweep.c_str(), "\"residual_l2_norm\":0.0"), "response sweep does not hardcode zero residual");

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
    check(contains(sweep_v2.c_str(), "response/frequency_points/frequency_0001.json"), "response sweep v2 links second point");
    check(contains(sweep_v2.c_str(), "response/field_payloads/frequency_0001/vector.bin"), "response sweep v2 links second payload");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/response/diagnostics.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(contains(diagnostics.c_str(), "\"status\":\"ready\""), "response diagnostics records ready status");
    check(contains(diagnostics.c_str(), "\"complete\":true"), "response diagnostics records completion");

    char progress_path[256]{};
    std::snprintf(
        progress_path,
        sizeof(progress_path),
        "%s/response/progress.v1.json",
        output_directory);
    const std::string progress = read_text_file(progress_path);
    check(contains(progress.c_str(), "\"status\":\"ready\""), "response progress records ready status");
    check(contains(progress.c_str(), "\"complete\":true"), "response progress records completion");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":2"),
        "response progress records completed points");
    check(
        contains(progress.c_str(), "\"written_frequency_point_artifacts\":2"),
        "response progress records written points");

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
        contains(point.c_str(), "\"field_payload_path\":\"response/field_payloads/frequency_0000/vector.bin\""),
        "frequency point metadata links field payload");
    check(
        contains(point.c_str(), "\"binary_layout\":\"complex_f64_pairs_little_endian\""),
        "frequency point metadata records binary layout");

    char payload_path[256]{};
    std::snprintf(
        payload_path,
        sizeof(payload_path),
        "%s/response/field_payloads/frequency_0000/vector.bin",
        output_directory);
    std::ifstream payload(payload_path, std::ios::binary | std::ios::ate);
    check(payload.good(), "response field payload is readable");
    check(payload.tellg() > 0, "response field payload is non-empty");

    char point_1_path[256]{};
    std::snprintf(
        point_1_path,
        sizeof(point_1_path),
        "%s/response/frequency_points/frequency_0001.json",
        output_directory);
    const std::string point_1 = read_text_file(point_1_path);
    check(contains(point_1.c_str(), "\"frequency_index\":1"), "second frequency point metadata records index");
    check(
        contains(point_1.c_str(), "\"field_payload_path\":\"response/field_payloads/frequency_0001/vector.bin\""),
        "second frequency point metadata links field payload");

    char payload_1_path[256]{};
    std::snprintf(
        payload_1_path,
        sizeof(payload_1_path),
        "%s/response/field_payloads/frequency_0001/vector.bin",
        output_directory);
    std::ifstream payload_1(payload_1_path, std::ios::binary | std::ios::ate);
    check(payload_1.good(), "second response field payload is readable");
    check(payload_1.tellg() == payload.tellg(), "second response field payload has consistent binary size");

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
    check(contains(manifest.c_str(), "\"completed_frequency_count\":1"), "interrupted manifest records completed count");
    check(contains(manifest.c_str(), "\"written_frequency_point_artifacts\":1"), "interrupted manifest records written count");
    check(contains(manifest.c_str(), "response/frequency_points/frequency_0000.json"), "interrupted manifest links completed point");
    check(!contains(manifest.c_str(), "response/frequency_points/frequency_0001.json"), "interrupted manifest does not link incomplete point");
    check(contains(manifest.c_str(), "response/field_payloads/frequency_0000/vector.bin"), "interrupted manifest links completed payload");
    check(!contains(manifest.c_str(), "response/field_payloads/frequency_0001/vector.bin"), "interrupted manifest does not link incomplete payload");
    check(
        contains(manifest.c_str(), "\"response_progress_v1_path\":\"response/progress.v1.json\""),
        "interrupted manifest links progress artifact");

    char progress_path[256]{};
    std::snprintf(progress_path, sizeof(progress_path), "%s/response/progress.v1.json", output_directory);
    const std::string progress = read_text_file(progress_path);
    check(contains(progress.c_str(), "\"state\":\"interrupted\""), "interrupted progress artifact reports interrupted state");
    check(contains(progress.c_str(), "\"partial_artifacts_available\":true"), "interrupted progress exposes partial artifacts");
    check(contains(progress.c_str(), "\"complete\":false"), "interrupted progress records incomplete state");
    check(
        contains(progress.c_str(), "\"completed_frequency_points\":1"),
        "interrupted progress records completed point count");

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
        contains(result.diagnostics_json, "frequency_domain_driven_response_result.v1"),
        "C ABI driven solve diagnostics JSON reports schema");
    check(contains(result.result_json, "unavailable"), "C ABI driven solve result JSON reports status");
    check(std::strcmp(result.artifact_manifest_path, "") == 0, "C ABI driven solve reports no manifest");

    fullmag_fem_frequency_domain_solve_result_release(&result);
    check(result.error_message == nullptr, "C ABI driven solve cleanup clears error message");
    check(result.diagnostics_json == nullptr, "C ABI driven solve cleanup clears diagnostics JSON");
    check(result.result_json == nullptr, "C ABI driven solve cleanup clears result JSON");
    check(result.artifact_manifest_path == nullptr, "C ABI driven solve cleanup clears manifest path");
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
        contains(manifest.c_str(), "\"failure_diagnostics_path\":\"frequency_domain/diagnostics.v1.json\""),
        "C ABI failure manifest links diagnostics");

    char diagnostics_path[256]{};
    std::snprintf(
        diagnostics_path,
        sizeof(diagnostics_path),
        "%s/frequency_domain/diagnostics.v1.json",
        output_directory);
    const std::string diagnostics = read_text_file(diagnostics_path);
    check(
        contains(diagnostics.c_str(), "\"solver_kind\":\"production_unavailable\""),
        "C ABI failure diagnostics records unavailable solver kind");

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
    check(std::abs(tangent_out[0] - 6.0) < 1.0e-12, "MFEM Zeeman output node0 e1");
    check(std::abs(tangent_out[1] + 3.0) < 1.0e-12, "MFEM Zeeman output node0 e2");
    check(std::abs(tangent_out[2] + 6.0) < 1.0e-12, "MFEM Zeeman output node1 e1");
    check(std::abs(tangent_out[3] + 8.0) < 1.0e-12, "MFEM Zeeman output node1 e2");
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
    double exchange_workspace[4]{};
    double zeeman_workspace[4]{};
    double effective_field_workspace[4]{};
    fd::MfemLinearizedOperatorWorkspace workspace{
        zeeman_blocks,
        exchange_workspace,
        zeeman_workspace,
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
    check(std::abs(diagnostics.max_abs_effective_field - 17.0) < 1.0e-12, "MFEM linearized diagnostics effective field max");
    check(std::abs(diagnostics.max_abs_stiffness_rhs - 170.0) < 1.0e-12, "MFEM linearized diagnostics stiffness max");
    check(std::abs(diagnostics.max_abs_mass_rhs - 4.3) < 1.0e-12, "MFEM linearized diagnostics mass max");
    check(std::abs(effective_field_workspace[0] - 11.0) < 1.0e-12, "MFEM linearized effective node0 e1");
    check(std::abs(effective_field_workspace[1] - 2.0) < 1.0e-12, "MFEM linearized effective node0 e2");
    check(std::abs(effective_field_workspace[2] + 17.0) < 1.0e-12, "MFEM linearized effective node1 e1");
    check(std::abs(effective_field_workspace[3] - 16.0) < 1.0e-12, "MFEM linearized effective node1 e2");
    check(std::abs(stiffness_rhs[0] + 20.0) < 1.0e-12, "MFEM linearized stiffness node0 e1");
    check(std::abs(stiffness_rhs[1] - 110.0) < 1.0e-12, "MFEM linearized stiffness node0 e2");
    check(std::abs(stiffness_rhs[2] + 160.0) < 1.0e-12, "MFEM linearized stiffness node1 e1");
    check(std::abs(stiffness_rhs[3] + 170.0) < 1.0e-12, "MFEM linearized stiffness node1 e2");
    check(std::abs(mass_rhs[0] - 1.2) < 1.0e-12, "MFEM linearized mass node0 e1");
    check(std::abs(mass_rhs[1] - 1.9) < 1.0e-12, "MFEM linearized mass node0 e2");
    check(std::abs(mass_rhs[2] + 2.6) < 1.0e-12, "MFEM linearized mass node1 e1");
    check(std::abs(mass_rhs[3] - 4.3) < 1.0e-12, "MFEM linearized mass node1 e2");
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
    driven_response_is_explicitly_unavailable();
    modal_solver_is_explicitly_unavailable();
    floquet_dynamic_demag_k_is_blocked();
    strict_gpu_lane_is_blocked();
    c_abi_reports_frequency_domain_availability();
    c_abi_rejects_null_arguments();
    c_abi_reports_frequency_domain_progress();
    tangent_frame_builds_orthonormal_basis_and_projects_vectors();
    tangent_frame_rejects_non_unit_equilibrium();
    tangent_operator_applies_local_blocks_and_reports_diagnostics();
    tangent_operator_rejects_unsupported_terms();
    zeeman_tangent_block_uses_parallel_field_and_reports_transverse_residual();
    exchange_edge_operator_applies_tangent_graph_laplacian();
    exchange_edge_operator_rejects_out_of_range_nodes();
    tangent_operator_applies_combined_nodewise_and_edge_terms();
    tangent_precession_operator_rotates_effective_field_variation();
    tangent_damping_operator_rotates_perturbation_by_alpha();
    tangent_frequency_mass_operator_combines_identity_and_damping_rotation();
    operator_contract_validates_driven_and_modal_requests_separately();
    operator_contract_rejects_invalid_frequency_sweep();
    driven_response_solver_boundary_returns_structured_unavailable_result();
    driven_response_solver_writes_failure_artifacts_for_unavailable_run();
    driven_response_solver_respects_disabled_partial_failure_artifacts();
    driven_response_solver_boundary_validates_request_before_unavailable_solve();
    driven_response_solver_runs_tiny_diagonal_validation_problem();
    driven_response_solver_runs_tiny_dense_validation_problem();
    driven_response_solver_runs_assembled_mfem_validation_problem();
    driven_response_solver_writes_minimal_assembled_validation_artifacts();
    driven_response_solver_respects_disabled_response_field_payloads();
    driven_response_solver_interruption_preserves_partial_validation_artifacts();
    c_abi_driven_response_solve_reports_structured_unavailable_result();
    c_abi_driven_response_solve_runs_tiny_validation_problem();
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
    mfem_linearized_operator_combines_exchange_zeeman_precession_and_mass();
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
