#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "frequency_domain/modal_gpu_krylov.hpp"

#include <slepceps.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

struct CsrOwned {
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    fd::CsrMatrixView view() const noexcept
    {
        return fd::CsrMatrixView{
            rows,
            columns,
            row_offsets.data(),
            static_cast<std::uint64_t>(row_offsets.size()),
            column_indices.data(),
            static_cast<std::uint64_t>(column_indices.size()),
            values.data(),
            static_cast<std::uint64_t>(values.size())};
    }
};

CsrOwned dense_to_csr(std::uint64_t rows, std::uint64_t columns, const double *values)
{
    CsrOwned csr{};
    csr.rows = rows;
    csr.columns = columns;
    csr.row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < rows; ++row) {
        for (std::uint64_t column = 0; column < columns; ++column) {
            const double value = values[row * columns + column];
            if (value != 0.0) {
                csr.column_indices.push_back(static_cast<std::uint32_t>(column));
                csr.values.push_back(value);
            }
        }
        csr.row_offsets.push_back(static_cast<std::uint32_t>(csr.values.size()));
    }
    return csr;
}

bool contains(const char *text, const char *needle)
{
    return text != nullptr && needle != nullptr && std::strstr(text, needle) != nullptr;
}

double json_number_after(const char *json, const char *field)
{
    const char *position = json != nullptr ? std::strstr(json, field) : nullptr;
    check(position != nullptr, "expected numeric JSON field is missing");
    return std::strtod(position + std::strlen(field), nullptr);
}

std::uint64_t json_u64_after(const char *json, const char *field)
{
    const char *position = json != nullptr ? std::strstr(json, field) : nullptr;
    check(position != nullptr, "expected unsigned JSON field is missing");
    return static_cast<std::uint64_t>(
        std::strtoull(position + std::strlen(field), nullptr, 10));
}

void insert_explicit_zero(CsrOwned *matrix, std::uint64_t row, std::uint32_t column)
{
    check(matrix != nullptr && row < matrix->rows && column < matrix->columns,
          "explicit-zero insertion requires a valid CSR position");
    const std::size_t insert_at = matrix->row_offsets[static_cast<std::size_t>(row + 1u)];
    matrix->column_indices.insert(matrix->column_indices.begin() + insert_at, column);
    matrix->values.insert(matrix->values.begin() + insert_at, 0.0);
    for (std::size_t offset = static_cast<std::size_t>(row + 1u);
         offset < matrix->row_offsets.size(); ++offset) {
        ++matrix->row_offsets[offset];
    }
}

struct WindowSpectrumFixture {
    std::uint64_t q_count = 0;
    CsrOwned a_qq{};
    CsrOwned a_qphi{};
    CsrOwned a_phiq{};
    CsrOwned a_phiphi{};
    CsrOwned b_qq{};

    fd::PoissonAirboxEigenBlockProblem problem(
        double frequency_min_hz,
        double frequency_max_hz,
        std::uint32_t requested_mode_count) const
    {
        fd::PoissonAirboxEigenBlockProblem value{};
        value.q_dof_count = q_count;
        value.phi_dof_count = 1u;
        value.A_qq = a_qq.view();
        value.A_qphi = a_qphi.view();
        value.A_phiq = a_phiq.view();
        value.A_phiphi = a_phiphi.view();
        value.B_qq = b_qq.view();
        value.outer_boundary_kind = "poisson_robin";
        value.robin_beta = 1.0;
        value.gauge_policy = "none";
        value.gauge_reason = "coercive_outer_boundary";
        value.assembly_kind = "synthetic_algebraic_oracle";
        value.production_shared_domain = false;
        value.validation_only_adapter = true;
        value.solver_adapter = "k0_poisson_airbox_gpu_petsc_slepc";
        value.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
        value.magnetic_pair_count = 1u;
        value.airbox_pair_count = 1u;
        value.target_kind = "frequency_window";
        value.frequency_min_hz = frequency_min_hz;
        value.frequency_max_hz = frequency_max_hz;
        value.target_frequency_hz = 0.5 * (frequency_min_hz + frequency_max_hz);
        value.residual_tolerance = 1.0e-8;
        value.requested_mode_count = requested_mode_count;
        value.max_outer_iterations = 128u;
        value.max_linear_iterations = 512u;
        return value;
    }
};

WindowSpectrumFixture make_window_spectrum_fixture(
    const std::vector<double> &physical_frequencies_hz)
{
    constexpr double two_pi = 6.283185307179586476925286766559;
    constexpr double pencil_scale = 1.0e-18;
    WindowSpectrumFixture fixture{};
    fixture.q_count = 2u * physical_frequencies_hz.size();
    const std::size_t q_count = static_cast<std::size_t>(fixture.q_count);
    std::vector<double> a_qq(q_count * q_count, 0.0);
    std::vector<double> b_qq(q_count * q_count, 0.0);
    for (std::size_t mode = 0; mode < physical_frequencies_hz.size(); ++mode) {
        const std::size_t first = 2u * mode;
        const std::size_t second = first + 1u;
        const double omega = two_pi * physical_frequencies_hz[mode];
        a_qq[first * q_count + second] = -pencil_scale * omega;
        a_qq[second * q_count + first] = pencil_scale * omega;
        b_qq[first * q_count + first] = pencil_scale;
        b_qq[second * q_count + second] = pencil_scale;
    }
    std::vector<double> a_qphi(q_count, 0.0);
    std::vector<double> a_phiq(q_count, 0.0);
    // Couple only the first guard branch to phi so the in-window degeneracy
    // remains exact while every solve still exercises the Poisson feedback.
    a_qphi.front() = -pencil_scale * 1.5e8;
    a_phiq[1u] = pencil_scale;
    const double a_phiphi[1] = {pencil_scale};
    fixture.a_qq = dense_to_csr(fixture.q_count, fixture.q_count, a_qq.data());
    fixture.a_qphi = dense_to_csr(fixture.q_count, 1u, a_qphi.data());
    fixture.a_phiq = dense_to_csr(1u, fixture.q_count, a_phiq.data());
    fixture.a_phiphi = dense_to_csr(1u, 1u, a_phiphi);
    fixture.b_qq = dense_to_csr(fixture.q_count, fixture.q_count, b_qq.data());
    return fixture;
}

struct WindowProgressControl {
    CsrOwned *a_qq = nullptr;
    std::uint32_t original_first_row_offset = 0u;
    bool cancel_after_base = false;
    bool cancel = false;
    bool inject_refinement_failure = false;
    bool row_offsets_corrupted = false;
};

int window_cancel_requested(void *user_data)
{
    const auto *control = static_cast<const WindowProgressControl *>(user_data);
    return control != nullptr && control->cancel ? 1 : 0;
}

void window_progress(void *user_data, const char *progress_json)
{
    auto *control = static_cast<WindowProgressControl *>(user_data);
    if (control == nullptr || progress_json == nullptr) {
        return;
    }
    if (control->cancel_after_base &&
        contains(progress_json, "\"solver_phase\":\"frequency_window_base_complete\"")) {
        control->cancel = true;
    }
    const bool refinement_subwindow = contains(
        progress_json,
        "\"solver_phase\":\"frequency_window_refinement_subwindow\"");
    if (control->inject_refinement_failure && refinement_subwindow &&
        contains(progress_json, "\"outer_iteration\":0")) {
        control->a_qq->row_offsets[0] = 1u;
        control->row_offsets_corrupted = true;
    } else if (control->row_offsets_corrupted && refinement_subwindow) {
        control->a_qq->row_offsets[0] = control->original_first_row_offset;
        control->row_offsets_corrupted = false;
    }
}

void check_two_pass_schedule(const fd::PoissonAirboxModalEigenResult &result)
{
    check(result.window_subwindow_count == 50u,
          "GPU window certificate must plan 16 base and 34 refinement subwindows");
    check(contains(result.window_certificate_json,
                   "\"base_schedule\":{\"state\":\"completed\",\"planned_subwindow_count\":16"),
          "GPU window certificate must publish the completed base schedule");
    check(contains(result.window_certificate_json,
                   "\"refinement_schedule\":{\"state\":\"completed\",\"planned_subwindow_count\":34"),
          "GPU window certificate must publish the completed refinement schedule");
    const double requested_nev = json_number_after(
        result.window_certificate_json,
        "\"requested_nev\":");
    const double refined_nev = json_number_after(
        result.window_certificate_json,
        "\"refined_nev\":");
    check(requested_nev > 0.0 && refined_nev > requested_nev,
          "GPU refinement must execute a numerically larger nev");
}

void FrequencyWindowPublishesCompleteGpuCertificate()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 2.0e9, 3.0e9});
    const fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        0.5e9,
        2.5e9,
        2u);
    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result);
    if (status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(stderr, "GPU window diagnostics: %s\n", result.diagnostics_json);
    }
    check(
        status == fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.window_complete,
          "separated GPU modes must publish a certified complete window");
    check_two_pass_schedule(result);
    check(contains(result.window_certificate_json,
                   "\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\""),
          "GPU window must publish the canonical certificate schema");
    check(contains(result.window_certificate_json,
                   "\"method\":\"shift_nev_refinement_subspace_v1\""),
          "GPU window must publish the canonical refinement method");
    check(contains(result.window_certificate_json, "\"cluster_ranks\":[1,1]"),
          "separated GPU modes must publish two rank-one clusters");
    check(json_number_after(result.window_certificate_json, "\"lower\":") > 0.0 &&
              json_number_after(result.window_certificate_json, "\"upper\":") > 0.0,
          "GPU window certificate must publish positive coverage margins");
    check(json_number_after(result.window_certificate_json,
                            "\"min_subspace_overlap\":") >= 1.0 - 1.0e-6,
          "GPU window certificate must prove stable invariant subspaces");
    check(contains(result.window_certificate_json,
                   "\"perturbation_result\":\"stable\""),
          "GPU window certificate must publish a stable perturbation result");
    check(!contains(result.window_certificate_json, "\"truncated\":true") &&
              !contains(result.executed_subwindows_json, "diagnostics_truncated"),
          "certified GPU window must contain complete certificate and schedule JSON");
    check(contains(result.diagnostics_json, "\"fallback_used\":false"),
          "GPU frequency window must never use a CPU fallback");
}

void FrequencyWindowCertifiesDegenerateGpuSubspace()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.5e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        1.0e9,
        2.0e9,
        2u);
    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result);
    check(status == fd::FrequencyDomainStatus::ok, result.error_message);
    check(result.window_complete && result.accepted_mode_count == 2u,
          "GPU must preserve and certify the full rank-two degenerate cluster");
    check_two_pass_schedule(result);
    check(contains(result.window_certificate_json, "\"requested_nev\":8") &&
              contains(result.window_certificate_json, "\"refined_nev\":14"),
          "GPU degenerate window must preserve an even J-closed Ritz request");
    check(contains(result.window_certificate_json, "\"cluster_ranks\":[2]"),
          "GPU degeneracy certificate must publish rank two");
    check(json_number_after(result.window_certificate_json,
                            "\"min_subspace_overlap\":") >= 1.0 - 1.0e-6,
          "GPU degeneracy certificate must compare invariant subspaces");
}

void FrequencyWindowRejectsSplitGpuCluster()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.5e9, 1.5e9, 3.0e9});
    const fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        1.0e9,
        2.0e9,
        1u);
    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::solve_error,
        "GPU window must fail closed when requested count splits a degenerate cluster");
    if (std::strcmp(result.stop_reason,
                    "frequency_window_refinement_disagreement") != 0) {
        std::fprintf(
            stderr,
            "GPU split-cluster unexpected stop reason: %s certificate=%s schedule=%s\n",
            result.stop_reason,
            result.window_certificate_json,
            result.executed_subwindows_json);
    }
    check(!result.window_complete &&
              std::strcmp(result.stop_reason,
                          "frequency_window_refinement_disagreement") == 0,
          "GPU split cluster must publish the exact refinement-disagreement reason");
    check_two_pass_schedule(result);
    check(contains(result.window_certificate_json, "\"cluster_ranks\":[2]"),
          "GPU split-cluster failure must preserve the observed rank");
    check(contains(result.window_certificate_json,
                   "\"perturbation_result\":\"requested_count_splits_cluster\""),
          "GPU split-cluster failure must identify the physical cause");
    check(json_number_after(result.window_certificate_json, "\"lower\":") > 0.0 &&
              json_number_after(result.window_certificate_json, "\"upper\":") > 0.0,
          "GPU split-cluster failure must retain positive coverage margins");
}

void FrequencyWindowFailsClosedForGpuSubwindowFailure()
{
    WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 2.0e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(0.5e9, 2.5e9, 2u);
    WindowProgressControl control{};
    control.a_qq = &fixture.a_qq;
    control.original_first_row_offset = fixture.a_qq.row_offsets.front();
    control.inject_refinement_failure = true;
    problem.progress_user_data = &control;
    problem.progress_callback = &window_progress;
    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::solve_error,
        "one failed GPU refinement subwindow must fail the whole window");
    if (control.row_offsets_corrupted) {
        fixture.a_qq.row_offsets[0] = control.original_first_row_offset;
    }
    check(result.window_failed_subwindow && !result.window_complete,
          "failed GPU subwindow must set the structural fail-closed flags");
    check(result.window_failed_subwindow_count == 1u,
          "deterministic GPU failure fixture must account for exactly one failed subwindow");
    check(std::strcmp(result.stop_reason, "frequency_window_subwindow_failed") == 0,
          "failed GPU subwindow must publish the canonical stop reason");
    check(contains(result.window_certificate_json,
                   "\"refinement_schedule\":{\"state\":\"failed\",\"planned_subwindow_count\":34,\"completed_subwindow_count\":33,\"failed_subwindow_count\":1"),
          "failed GPU subwindow certificate must preserve exact pass accounting");
}

void FrequencyWindowCancelsBetweenGpuPasses()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 2.0e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(0.5e9, 2.5e9, 2u);
    WindowProgressControl control{};
    control.cancel_after_base = true;
    problem.cancel_user_data = &control;
    problem.cancel_requested = &window_cancel_requested;
    problem.progress_user_data = &control;
    problem.progress_callback = &window_progress;
    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::interrupted,
        "GPU cancellation between passes must return interrupted");
    check(result.window_cancelled && !result.window_failed_subwindow &&
              !result.window_complete,
          "GPU between-pass cancellation must preserve exact structural flags");
    check(std::strcmp(result.stop_reason, "cancel_requested") == 0,
          "GPU between-pass cancellation must preserve exact stop reason");
    check(result.window_completed_subwindow_count == 16u &&
              result.window_failed_subwindow_count == 0u,
          "GPU between-pass cancellation must stop after the complete base schedule");
    check(!contains(result.executed_subwindows_json, "\"pass\":\"refinement\""),
          "GPU between-pass cancellation must execute no refinement shift");
    check(contains(result.window_certificate_json,
                   "\"base_schedule\":{\"state\":\"completed\",\"planned_subwindow_count\":16,\"completed_subwindow_count\":16"),
          "GPU cancellation certificate must preserve the completed base pass");
    check(contains(result.window_certificate_json,
                   "\"refinement_schedule\":{\"state\":\"cancelled\",\"planned_subwindow_count\":34,\"completed_subwindow_count\":0"),
          "GPU cancellation certificate must show an unexecuted cancelled refinement pass");
}

void FrequencyWindowFailsClosedWhenGpuScheduleTruncates()
{
    std::vector<double> frequencies{0.25e9};
    for (std::uint32_t index = 0; index < 15u; ++index) {
        frequencies.push_back((1.0 + 0.1 * static_cast<double>(index)) * 1.0e9);
    }
    frequencies.push_back(3.0e9);
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(frequencies);
    const fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        0.9e9,
        2.6e9,
        15u);
    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::solve_error,
        "truncated GPU window schedule must fail closed");
    check(!result.window_complete &&
              std::strcmp(result.stop_reason,
                          "frequency_window_certificate_truncated") == 0,
          "GPU schedule truncation must use the canonical certificate-truncated reason");
    check(contains(result.window_certificate_json, "\"truncated\":true") &&
              contains(result.window_certificate_json,
                       "\"method\":\"shift_nev_refinement_subspace_v1\""),
          "GPU truncation must preserve schema method and explicit truncation evidence");
}

void PersistentGpuTargetUpdateAcceptsDifferentSparsePatterns()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem first = fixture.problem(
        0.5e9,
        2.5e9,
        1u);
    first.target_kind = "nearest_frequency";
    first.target_frequency_hz = 1.45e9;
    first.residual_tolerance = 1.0e-3;

    fd::PoissonAirboxModalEigenResult cold{};
    const fd::FrequencyDomainStatus cold_status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(first, &cold);
    if (cold_status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(stderr, "GPU cold target diagnostics: %s\n", cold.diagnostics_json);
    }
    check(
        cold_status == fd::FrequencyDomainStatus::ok,
        cold.error_message);

    fd::PoissonAirboxEigenBlockProblem shifted = first;
    shifted.target_frequency_hz = 1.05e9;
    fd::PoissonAirboxModalEigenResult updated{};
    const fd::FrequencyDomainStatus updated_status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(shifted, &updated);
    if (updated_status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(stderr, "GPU target-update diagnostics: %s\n", updated.diagnostics_json);
    }
    check(
        updated_status == fd::FrequencyDomainStatus::ok,
        updated.error_message);
    check(contains(updated.diagnostics_json, "\"operator_context_reused\":true") &&
              contains(updated.diagnostics_json, "\"solver_context_reused\":false") &&
              contains(updated.diagnostics_json,
                       "\"invalidation_reason\":\"target_reconfigured\""),
          "target update must retain the operator but rebuild the sparse solver graph");
    check(json_u64_after(cold.diagnostics_json, "\"operator_context_generation\":") ==
              json_u64_after(updated.diagnostics_json, "\"operator_context_generation\":"),
          "target-only sparse update must preserve the operator generation");
    check(json_u64_after(updated.diagnostics_json, "\"solver_context_generation\":") >
              json_u64_after(cold.diagnostics_json, "\"solver_context_generation\":"),
          "target-only sparse update must advance the rebuilt solver generation");
}

int run_n3_w1_focused_tests()
{
    PersistentGpuTargetUpdateAcceptsDifferentSparsePatterns();
    FrequencyWindowPublishesCompleteGpuCertificate();
    FrequencyWindowCertifiesDegenerateGpuSubspace();
    FrequencyWindowRejectsSplitGpuCluster();
    FrequencyWindowFailsClosedForGpuSubwindowFailure();
    FrequencyWindowCancelsBetweenGpuPasses();
    FrequencyWindowFailsClosedWhenGpuScheduleTruncates();
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "focused GPU N3-W1 runtime finalization must succeed");
    return 0;
}

int run_gpu_split_cluster_focused_test()
{
    FrequencyWindowRejectsSplitGpuCluster();
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "focused GPU split-cluster runtime finalization must succeed");
    return 0;
}

int run_gpu_degenerate_cluster_focused_test()
{
    FrequencyWindowCertifiesDegenerateGpuSubspace();
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "focused GPU degenerate-cluster runtime finalization must succeed");
    return 0;
}

int run_gpu_ksp_destroy_abi_focused_test()
{
    check(setenv("PETSC_OPTIONS", "-malloc_debug", 1) == 0,
          "focused GPU KSP destroy ABI test must enable PETSc allocator checks");
    PersistentGpuTargetUpdateAcceptsDifferentSparsePatterns();
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "focused GPU KSP destroy ABI runtime finalization must succeed");
    return 0;
}

int run_gpu_teardown_lifecycle_focused_test()
{
    constexpr std::uint32_t kBaseTargetCount = 16u;
    constexpr std::uint32_t kRefinementPartitionCount = 32u;
    constexpr std::uint32_t kRefinementTargetCount =
        kRefinementPartitionCount + 2u;
    constexpr std::uint32_t kGpuTeardownTargetCount = 50u;
    constexpr double frequency_min_hz = 0.5e9;
    constexpr double frequency_max_hz = 2.5e9;
    constexpr double window_width_hz = frequency_max_hz - frequency_min_hz;

    if (setenv("PETSC_OPTIONS", "-malloc_debug", 1) != 0) {
        std::fprintf(
            stderr,
            "GPU teardown lifecycle setup failed before SLEPc initialization\n");
        return 2;
    }

    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 2.0e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(
        frequency_min_hz,
        frequency_max_hz,
        2u);
    problem.target_kind = "nearest_frequency";
    problem.frequency_min_hz = 0.0;
    problem.frequency_max_hz = 0.0;
    problem.residual_tolerance = 1.0e-8;

    std::uint32_t target_count = 0u;
    std::uint32_t accepted_solve_count = 0u;
    std::uint32_t residual_rejection_count = 0u;
    std::uint32_t unexpected_solve_count = 0u;
    for (std::uint32_t pass_index = 0u; pass_index < 2u; ++pass_index) {
        const std::uint32_t pass_target_count = pass_index == 0u
            ? kBaseTargetCount
            : kRefinementTargetCount;
        problem.requested_mode_count = pass_index == 0u ? 2u : 4u;
        for (std::uint32_t target_index = 0u;
             target_index < pass_target_count;
             ++target_index) {
            problem.target_frequency_hz = pass_index == 0u
                ? frequency_min_hz +
                    (static_cast<double>(target_index) + 0.5) *
                        window_width_hz /
                        static_cast<double>(kBaseTargetCount)
                : frequency_min_hz +
                    (static_cast<double>(target_index) - 0.5) *
                        window_width_hz /
                        static_cast<double>(kRefinementPartitionCount);
            fd::PoissonAirboxModalEigenResult result{};
            const fd::FrequencyDomainStatus status =
                fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
                    problem,
                    &result);
            ++target_count;

            if (status == fd::FrequencyDomainStatus::ok) {
                ++accepted_solve_count;
                continue;
            }
            const bool residual_rejected_after_completed_solve =
                status == fd::FrequencyDomainStatus::solve_error &&
                std::strcmp(
                    result.error_message,
                    "GPU K0 SLEPc found no certified positive-frequency mode") == 0 &&
                result.eps_reason_available &&
                result.eps_converged_reason > 0 &&
                result.converged_eigenpair_count > 0u &&
                result.action_residual_evaluated_count > 0u &&
                result.reconstructed_mode_count > 0u &&
                result.full_residual_accepted_count == 0u;
            if (residual_rejected_after_completed_solve) {
                if (residual_rejection_count == 0u) {
                    std::fprintf(
                        stderr,
                        "GPU teardown first residual rejection: action=%.17g full=%.17g "
                        "q=%.17g phi=%.17g\n",
                        result.slepc_reported_backward_error,
                        result.full_residual_reconstruction_relative_error,
                        result.magnetic_block_backward_error,
                        result.poisson_block_backward_error);
                }
                ++residual_rejection_count;
                continue;
            }

            ++unexpected_solve_count;
            std::fprintf(
                stderr,
                "GPU teardown lifecycle unexpected solve outcome at target %u: "
                "status=%d eps_reason=%d converged=%u reconstructed=%u accepted=%u "
                "message=%s\n",
                target_count,
                static_cast<int>(status),
                result.eps_converged_reason,
                result.converged_eigenpair_count,
                result.reconstructed_mode_count,
                result.full_residual_accepted_count,
                result.error_message);
        }
    }

    const fd::FrequencyDomainStatus finalizer_status =
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime();
    std::fprintf(
        stderr,
        "GPU teardown lifecycle summary: targets=%u accepted=%u "
        "residual_rejected=%u unexpected=%u finalizer_status=%d\n",
        target_count,
        accepted_solve_count,
        residual_rejection_count,
        unexpected_solve_count,
        static_cast<int>(finalizer_status));

    if (target_count != kGpuTeardownTargetCount) {
        return 3;
    }
    if (finalizer_status != fd::FrequencyDomainStatus::ok) {
        return 4;
    }
    return unexpected_solve_count == 0u ? 0 : 1;
}

fd::PoissonAirboxEigenBlockProblem nearest_problem(
    const WindowSpectrumFixture &fixture,
    double target_frequency_hz = 1.45e9)
{
    fd::PoissonAirboxEigenBlockProblem problem = fixture.problem(0.5e9, 2.5e9, 1u);
    problem.target_kind = "nearest_frequency";
    problem.target_frequency_hz = target_frequency_hz;
    problem.residual_tolerance = 1.0e-3;
    return problem;
}

fd::PoissonAirboxModalEigenResult solve_ok(
    const fd::PoissonAirboxEigenBlockProblem &problem,
    const char *message)
{
    fd::PoissonAirboxModalEigenResult result{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &result);
    if (status != fd::FrequencyDomainStatus::ok) {
        std::fprintf(stderr, "GPU modal diagnostics: %s\n", result.diagnostics_json);
    }
    check(
        status == fd::FrequencyDomainStatus::ok,
        result.error_message[0] != '\0' ? result.error_message : message);
    return result;
}

void BoundedValidationSolveDoesNotClaimShiftIterations()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    const fd::PoissonAirboxModalEigenResult result = solve_ok(
        nearest_problem(fixture),
        "bounded GPU validation solve must use a valid PETSc convergence context");
    check(result.shift_linear_iteration_count == 0u &&
              contains(result.diagnostics_json, "\"shift_pc_type\":\"none\"") &&
              contains(
                  result.diagnostics_json,
                  "\"spectral_transform\":\"bounded_full_spectrum_shift\""),
          "bounded full-spectrum validation must not claim production shift iterations");
}

void check_full_solver_reuse(const fd::PoissonAirboxModalEigenResult &result)
{
    check(contains(result.diagnostics_json, "\"operator_context_reused\":true"),
          "identical GPU solve must reuse the operator context");
    check(contains(result.diagnostics_json, "\"solver_context_reused\":true"),
          "identical GPU solve must reuse the solver context");
    check(contains(result.diagnostics_json,
                   "\"public_petsc_object_ids_reused\":true"),
          "identical GPU solve must publish reuse of the inspected PETSc object IDs");
    check(contains(result.diagnostics_json, "\"persistence_verified\":false") &&
              !result.persistent_context_verified,
          "public PETSc IDs alone must not claim internal allocation persistence");
    check(contains(result.diagnostics_json, "\"reuse_mask\":\"0x000003ff\""),
          "GPU reuse mask must cover shell, mass, PC, EPS, ST, KSP, BV, x and residual workspace");
}

void PersistentGpuSolverGraphIsReusedForIdenticalSignature()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    const fd::PoissonAirboxEigenBlockProblem problem = nearest_problem(fixture);
    const fd::PoissonAirboxModalEigenResult cold = solve_ok(
        problem, "cold GPU persistence solve must succeed");
    const fd::PoissonAirboxModalEigenResult reused = solve_ok(
        problem, "identical GPU persistence solve must succeed");

    check(contains(cold.diagnostics_json, "\"invalidation_reason\":\"cold_start\""),
          "first GPU persistence solve must publish cold_start");
    check(!contains(cold.diagnostics_json, "\"persistence_verified\":true"),
          "cold GPU solve must not claim verified reuse");
    check_full_solver_reuse(reused);
    check(contains(reused.diagnostics_json, "\"invalidation_reason\":\"none\""),
          "identical GPU persistence solve must publish no invalidation");
    check(json_u64_after(cold.diagnostics_json, "\"operator_context_generation\":") ==
              json_u64_after(reused.diagnostics_json, "\"operator_context_generation\":"),
          "identical solve must preserve the operator generation");
    check(json_u64_after(cold.diagnostics_json, "\"solver_context_generation\":") ==
              json_u64_after(reused.diagnostics_json, "\"solver_context_generation\":"),
          "identical solve must preserve the solver generation");
    check(json_u64_after(reused.diagnostics_json, "\"solve_control_generation\":") >
              json_u64_after(cold.diagnostics_json, "\"solve_control_generation\":"),
          "each solve must arm a new solve-control generation");
}

void PersistentGpuSolverInvalidatesCanonicalIdentityClasses()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = nearest_problem(fixture);
    problem.mesh_generation_identity = "mesh-generation-v1";
    problem.equilibrium_digest = "equilibrium-v1";
    problem.bias_field_sample_signature = "bias-samples-v1";
    problem.boundary_gauge_digest = "boundary-gauge-v1";
    problem.operator_input_digest = "operator-input-v1";
    fd::PoissonAirboxModalEigenResult previous = solve_ok(
        problem, "GPU invalidation baseline must succeed");

    const auto expect_rebuild = [&](const char *reason) {
        const fd::PoissonAirboxModalEigenResult current = solve_ok(
            problem, "GPU invalidation solve must succeed");
        check(contains(current.diagnostics_json, reason),
              "GPU invalidation must publish the exact identity reason");
        check(json_u64_after(current.diagnostics_json, "\"operator_context_generation\":") >
                  json_u64_after(previous.diagnostics_json, "\"operator_context_generation\":"),
              "operator identity invalidation must advance operator generation");
        check(json_u64_after(current.diagnostics_json, "\"solver_context_generation\":") >
                  json_u64_after(previous.diagnostics_json, "\"solver_context_generation\":"),
              "operator identity invalidation must advance solver generation");
        previous = current;
    };

    problem.mesh_generation_identity = "mesh-generation-v2";
    expect_rebuild("\"invalidation_reason\":\"mesh_generation_identity_changed\"");

    problem.equilibrium_digest = "equilibrium-v2";
    expect_rebuild("\"invalidation_reason\":\"equilibrium_identity_changed\"");

    problem.bias_field_sample_signature = "bias-samples-v2";
    expect_rebuild("\"invalidation_reason\":\"bias_identity_changed\"");

    problem.boundary_gauge_digest = "boundary-gauge-v2";
    expect_rebuild("\"invalidation_reason\":\"boundary_gauge_identity_changed\"");

    problem.operator_input_digest = "operator-input-v2";
    expect_rebuild("\"invalidation_reason\":\"operator_input_identity_changed\"");

}

void SyntheticContentFallbackDoesNotClaimCanonicalIdentity()
{
    WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = nearest_problem(fixture);
    (void)solve_ok(problem, "GPU synthetic content baseline must succeed");

    insert_explicit_zero(&fixture.a_qq, 0u, 0u);
    problem.A_qq = fixture.a_qq.view();
    const fd::PoissonAirboxModalEigenResult rebuilt = solve_ok(
        problem, "GPU synthetic content invalidation solve must succeed");
    check(contains(rebuilt.diagnostics_json,
                   "\"invalidation_reason\":\"validation_operator_content_changed\""),
          "synthetic content fallback must not claim an upstream identity class");
}

void ProductionGpuRequiresCompleteCanonicalIdentityBeforeAllocation()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem production = nearest_problem(fixture);
    production.validation_only_adapter = false;
    production.production_shared_domain = true;
    production.assembly_kind = "mfem_weak_form_shared_domain";
    production.mesh_generation_identity = "mesh-generation-v1";
    production.equilibrium_digest = "equilibrium-v1";
    production.bias_field_sample_signature = "bias-samples-v1";
    production.boundary_gauge_digest = "boundary-gauge-v1";
    production.operator_input_digest = "operator-input-v1";

    using IdentityMember = const char *
        fd::PoissonAirboxEigenBlockProblem::*;
    const IdentityMember identities[] = {
        &fd::PoissonAirboxEigenBlockProblem::mesh_generation_identity,
        &fd::PoissonAirboxEigenBlockProblem::equilibrium_digest,
        &fd::PoissonAirboxEigenBlockProblem::bias_field_sample_signature,
        &fd::PoissonAirboxEigenBlockProblem::boundary_gauge_digest,
        &fd::PoissonAirboxEigenBlockProblem::operator_input_digest,
    };
    for (const IdentityMember identity : identities) {
        fd::PoissonAirboxEigenBlockProblem incomplete = production;
        incomplete.*identity = nullptr;
        fd::PoissonAirboxModalEigenResult result{};
        check(
            fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
                incomplete, &result) == fd::FrequencyDomainStatus::validation_error,
            "production GPU solve must reject every incomplete canonical identity");
        check(contains(result.diagnostics_json,
                       "\"reason\":\"gpu_k0_canonical_identity_incomplete\"") &&
                  result.setup_h2d_transfer_count == 0u,
              "incomplete production identity must fail before GPU allocation or transfer");
    }

    fd::PoissonAirboxEigenBlockProblem mixed_scope = nearest_problem(fixture);
    mixed_scope.assembly_kind = "mfem_weak_form_shared_domain";
    fd::PoissonAirboxModalEigenResult mixed_result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            mixed_scope, &mixed_result) == fd::FrequencyDomainStatus::validation_error &&
            contains(mixed_result.diagnostics_json,
                     "\"reason\":\"gpu_k0_scope_mismatch\"") &&
            mixed_result.setup_h2d_transfer_count == 0u,
        "CSR identity fallback must reject a non-synthetic validation scope before allocation");
}

struct CallbackLifetimeControl {
    std::uint32_t cancel_poll_count = 0u;
    std::uint32_t progress_call_count = 0u;
    bool cancel = false;
};

int lifetime_cancel_requested(void *user_data)
{
    auto *control = static_cast<CallbackLifetimeControl *>(user_data);
    if (control == nullptr) {
        return 0;
    }
    ++control->cancel_poll_count;
    return control->cancel ? 1 : 0;
}

void lifetime_progress(void *user_data, const char *)
{
    auto *control = static_cast<CallbackLifetimeControl *>(user_data);
    if (control != nullptr) {
        ++control->progress_call_count;
    }
}

void EpsSolveErrorFailsClosedWithoutPersistenceClaim()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = nearest_problem(fixture);
    (void)solve_ok(problem, "GPU EPSSolve failure baseline must succeed");
    (void)solve_ok(problem, "GPU EPSSolve failure reuse baseline must succeed");

    CallbackLifetimeControl failed_callbacks{};
    problem.cancel_user_data = &failed_callbacks;
    problem.cancel_requested = &lifetime_cancel_requested;
    problem.progress_user_data = &failed_callbacks;
    problem.progress_callback = &lifetime_progress;

    check(setenv("FULLMAG_N3_W2_TEST_EPSSOLVE_ERROR", "1", 1) == 0,
          "EPSSolve failure hook must be set");
    fd::PoissonAirboxModalEigenResult failed{};
    const fd::FrequencyDomainStatus status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &failed);
    check(unsetenv("FULLMAG_N3_W2_TEST_EPSSOLVE_ERROR") == 0,
          "EPSSolve failure hook must be cleared");

    check(status == fd::FrequencyDomainStatus::solve_error,
          "EPSSolve error must fail the GPU modal request closed");
    check(!failed.persistent_context_verified,
          "EPSSolve error must clear the result persistence claim");
    check(contains(failed.diagnostics_json, "\"persistence_verified\":false") &&
              contains(failed.diagnostics_json,
                       "\"persistent_solver_context\":false") &&
              contains(failed.diagnostics_json, "\"eps_reason_available\":false"),
          "EPSSolve error diagnostics must contain no solver-ready or persistence claim");
    check(contains(failed.diagnostics_json,
                   "\"reason\":\"gpu_slepc_solve_failed\""),
          "EPSSolve error must publish the stable fail-closed reason");
    const std::uint32_t failed_cancel_polls = failed_callbacks.cancel_poll_count;
    const std::uint32_t failed_progress_calls = failed_callbacks.progress_call_count;
    const std::uint64_t failed_solve_control_generation = json_u64_after(
        failed.diagnostics_json, "\"solve_control_generation\":");
    const std::uint64_t failed_solver_generation = json_u64_after(
        failed.diagnostics_json, "\"solver_context_generation\":");

    CallbackLifetimeControl recovery_callbacks{};
    problem.cancel_user_data = &recovery_callbacks;
    problem.progress_user_data = &recovery_callbacks;
    const fd::PoissonAirboxModalEigenResult recovered = solve_ok(
        problem, "GPU solve after injected EPSSolve failure must recover");
    check(failed_callbacks.cancel_poll_count == failed_cancel_polls &&
              failed_callbacks.progress_call_count == failed_progress_calls,
          "recovery must never call callback user_data from the failed solve");
    check(recovery_callbacks.cancel_poll_count > 0u &&
              recovery_callbacks.progress_call_count == 0u,
          "bounded recovery must invoke only its newly armed cancellation callback");
    check(json_u64_after(recovered.diagnostics_json,
                         "\"solve_control_generation\":") >
              failed_solve_control_generation &&
              json_u64_after(recovered.diagnostics_json,
                             "\"solver_context_generation\":") >
                  failed_solver_generation,
          "recovery must create fresh solve-control and solver generations");
}

void PersistentGpuCallbacksNeverRetainPreviousSolveUserData()
{
    const WindowSpectrumFixture fixture = make_window_spectrum_fixture(
        {0.25e9, 1.0e9, 1.5e9, 3.0e9});
    fd::PoissonAirboxEigenBlockProblem problem = nearest_problem(fixture);
    CallbackLifetimeControl first{};
    problem.cancel_user_data = &first;
    problem.cancel_requested = &lifetime_cancel_requested;
    problem.progress_user_data = &first;
    problem.progress_callback = &lifetime_progress;
    (void)solve_ok(problem, "first callback lifetime solve must succeed");
    check(first.cancel_poll_count > 0u && first.progress_call_count == 0u,
          "bounded validation must poll cancellation without inventing Krylov progress");
    const std::uint32_t first_cancel_polls = first.cancel_poll_count;
    const std::uint32_t first_progress_calls = first.progress_call_count;

    CallbackLifetimeControl second{};
    problem.cancel_user_data = &second;
    problem.progress_user_data = &second;
    (void)solve_ok(problem, "second callback lifetime solve must succeed");
    check(first.cancel_poll_count == first_cancel_polls &&
              first.progress_call_count == first_progress_calls,
          "successful persistent reuse must not call callbacks from the previous solve");
    check(second.cancel_poll_count > 0u && second.progress_call_count == 0u,
          "second bounded solve must use only its newly armed cancellation callback");

    CallbackLifetimeControl cancelled{};
    cancelled.cancel = true;
    problem.cancel_user_data = &cancelled;
    problem.progress_user_data = &cancelled;
    fd::PoissonAirboxModalEigenResult interrupted{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &interrupted) ==
            fd::FrequencyDomainStatus::interrupted,
        "pre-solve cancellation must return interrupted");
    const std::uint32_t cancelled_polls = cancelled.cancel_poll_count;
    const std::uint32_t cancelled_progress = cancelled.progress_call_count;

    CallbackLifetimeControl after_cancel{};
    problem.cancel_user_data = &after_cancel;
    problem.progress_user_data = &after_cancel;
    (void)solve_ok(problem, "solve after cancellation must succeed");
    check(cancelled.cancel_poll_count == cancelled_polls &&
              cancelled.progress_call_count == cancelled_progress,
          "cancelled persistent solve must neutralize callbacks before returning");
    check(after_cancel.cancel_poll_count > 0u &&
              after_cancel.progress_call_count == 0u,
          "solve after cancellation must use the new bounded callback generation");
}

int run_n3_w2_focused_tests()
{
    PersistentGpuSolverGraphIsReusedForIdenticalSignature();
    BoundedValidationSolveDoesNotClaimShiftIterations();
    PersistentGpuSolverInvalidatesCanonicalIdentityClasses();
    SyntheticContentFallbackDoesNotClaimCanonicalIdentity();
    ProductionGpuRequiresCompleteCanonicalIdentityBeforeAllocation();
    PersistentGpuCallbacksNeverRetainPreviousSolveUserData();
    EpsSolveErrorFailsClosedWithoutPersistenceClaim();
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "focused GPU N3-W2 runtime finalization must succeed");
    return 0;
}

} // namespace

int main()
{
    if (std::getenv("FULLMAG_GPU_TEARDOWN_LIFECYCLE_FOCUSED") != nullptr) {
        return run_gpu_teardown_lifecycle_focused_test();
    }
    if (std::getenv("FULLMAG_GPU_KSP_DESTROY_ABI_FOCUSED") != nullptr) {
        return run_gpu_ksp_destroy_abi_focused_test();
    }
    if (std::getenv("FULLMAG_N3_W2_FOCUSED") != nullptr) {
        return run_n3_w2_focused_tests();
    }
    if (std::getenv("FULLMAG_N3_W1_FOCUSED") != nullptr) {
        return run_n3_w1_focused_tests();
    }
    if (std::getenv("FULLMAG_GPU_SPLIT_CLUSTER_FOCUSED") != nullptr) {
        return run_gpu_split_cluster_focused_test();
    }
    if (std::getenv("FULLMAG_GPU_DEGENERATE_CLUSTER_FOCUSED") != nullptr) {
        return run_gpu_degenerate_cluster_focused_test();
    }
    // The canonical just recipe executes this binary without a focused-test
    // environment variable, so the persistence contract remains part of its
    // default runtime gate as well.
    check(setenv("FULLMAG_N3_W2_FOCUSED", "embedded", 1) == 0,
          "embedded GPU N3-W2 test scope must be enabled");
    PersistentGpuSolverGraphIsReusedForIdenticalSignature();
    PersistentGpuSolverInvalidatesCanonicalIdentityClasses();
    PersistentGpuCallbacksNeverRetainPreviousSolveUserData();
    check(unsetenv("FULLMAG_N3_W2_FOCUSED") == 0,
          "embedded GPU N3-W2 test scope must be cleared");
    constexpr double two_pi = 6.283185307179586476925286766559;
    // Production weak-form matrices carry SI volume scaling.  A common
    // pencil scale must not change the physical eigenfrequency or prevent
    // the independent full-descriptor residual from being certified.
    constexpr double pencil_scale = 1.0e-18;
    const double a_qq_values[4] = {
        0.0, -pencil_scale * two_pi * 2.0e9,
        pencil_scale * two_pi * 2.0e9, 0.0};
    const double a_qphi_values[4] = {
        -pencil_scale * 1.5e8, pencil_scale * 1.5e8, 0.0, 0.0};
    const double a_phiq_values[4] = {
        0.0, -pencil_scale, 0.0, pencil_scale};
    // A coercive scalar block avoids a gauge nullspace in this runtime-owner
    // contract while retaining non-zero dynamic-demag coupling.
    const double a_phiphi_values[4] = {
        2.0 * pencil_scale, -pencil_scale, -pencil_scale, 2.0 * pencil_scale};
    const double b_qq_values[4] = {pencil_scale, 0.0, 0.0, pencil_scale};
    const CsrOwned a_qq = dense_to_csr(2, 2, a_qq_values);
    const CsrOwned a_qphi = dense_to_csr(2, 2, a_qphi_values);
    const CsrOwned a_phiq = dense_to_csr(2, 2, a_phiq_values);
    const CsrOwned a_phiphi = dense_to_csr(2, 2, a_phiphi_values);
    const CsrOwned b_qq = dense_to_csr(2, 2, b_qq_values);

    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = a_qq.view();
    problem.A_qphi = a_qphi.view();
    problem.A_phiq = a_phiq.view();
    problem.A_phiphi = a_phiphi.view();
    problem.B_qq = b_qq.view();
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    // This target exercises the bounded PETSc/CUDA adapter with algebraic
    // matrices.  It must never be reported as production shared-domain FEM.
    problem.assembly_kind = "synthetic_algebraic_oracle";
    problem.production_shared_domain = false;
    problem.validation_only_adapter = true;
    problem.solver_adapter = "k0_poisson_airbox_gpu_petsc_slepc";
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    problem.target_frequency_hz = 2.0e9;
    problem.requested_mode_count = 1;
    problem.residual_tolerance = 1.0e-8;
    problem.max_outer_iterations = 128;
    problem.max_linear_iterations = 256;

    // Validation must reject an empty mode request before probing CUDA/SLEPc;
    // a caller must never receive a solver-unavailable error for malformed
    // modal intent.
    problem.requested_mode_count = 0;
    fd::PoissonAirboxModalEigenResult invalid_count{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &invalid_count) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a zero requested mode count before allocation");
    check(
        std::strstr(invalid_count.diagnostics_json, "gpu_k0_requested_mode_count_invalid") !=
            nullptr,
        "GPU K0 zero-count diagnostics must expose the stable validation reason");

    problem.requested_mode_count = 1;
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 3.0e9;
    problem.frequency_max_hz = 3.0e9;
    fd::PoissonAirboxModalEigenResult invalid_window{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &invalid_window) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a degenerate frequency window before allocation");
    check(
        std::strstr(invalid_window.diagnostics_json, "gpu_k0_target_invalid") != nullptr,
        "GPU K0 invalid target diagnostics must expose the stable validation reason");

    problem.target_kind = "unsupported_target";
    problem.frequency_min_hz = 0.0;
    problem.frequency_max_hz = 0.0;
    fd::PoissonAirboxModalEigenResult invalid_target_kind{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            problem, &invalid_target_kind) == fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject an unknown target kind before allocation");
    check(
        std::strstr(invalid_target_kind.diagnostics_json, "gpu_k0_target_invalid") != nullptr,
        "GPU K0 unknown-target diagnostics must expose the stable validation reason");

    problem.target_kind = "nearest_frequency";
    problem.phasor_convention = "exp_minus_i_omega_t";
    fd::PoissonAirboxModalEigenResult invalid_phasor_convention{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            problem, &invalid_phasor_convention) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a noncanonical phasor convention before allocation");
    check(
        std::strstr(
            invalid_phasor_convention.diagnostics_json,
            "gpu_k0_convention_invalid") != nullptr,
        "GPU K0 phasor-convention diagnostics must expose the stable validation reason");

    problem.phasor_convention = "exp_plus_i_omega_t";
    problem.eigenvalue_convention = "lambda_real_positive_frequency";
    fd::PoissonAirboxModalEigenResult invalid_eigenvalue_convention{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            problem, &invalid_eigenvalue_convention) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a noncanonical eigenvalue convention before allocation");
    check(
        std::strstr(
            invalid_eigenvalue_convention.diagnostics_json,
            "gpu_k0_convention_invalid") != nullptr,
        "GPU K0 eigenvalue-convention diagnostics must expose the stable validation reason");

    problem.eigenvalue_convention = "lambda_imag_positive_frequency";

    fd::PoissonAirboxModalEigenResult gpu{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::ok,
        gpu.error_message);
    check(gpu.accepted_mode_count >= 1, "GPU solve must retain an accepted mode");
    check(gpu.q_dof_count == problem.q_dof_count && gpu.phi_dof_count == problem.phi_dof_count,
          "GPU result must publish the native magnetic and scalar DOF counts");
    check(gpu.augmented_dof_count == problem.q_dof_count + problem.phi_dof_count,
          "GPU result must publish the native augmented DOF count");
    check(gpu.full_residual_certified, "GPU solve must certify the full descriptor residual");
    // The persistent Schur context uploads A_qq, A_qphi, A_phiq, A_phiphi,
    // and the full-residual B_qq block once. The real-split mass is
    // materialized for this solve, so all six setup block transfers are
    // accounted for in the public telemetry.
    check(gpu.setup_h2d_transfer_count == 6,
          "GPU solve must count B_qq and the split mass setup transfers");
    check(
        std::strstr(gpu.diagnostics_json, "\"setup_h2d_transfer_count\":6") != nullptr,
        "GPU diagnostics must publish the B_qq setup transfer");
    check(gpu.final_d2h_transfer_count >= 4,
          "GPU solve must report the four final mode-vector device-to-host transfers");
    check(gpu.hot_loop_allocations == 0,
          "GPU modal action loop must not allocate after persistent setup");
    check(gpu.hot_loop_h2d_bytes == 0 && gpu.hot_loop_d2h_bytes == 0,
          "GPU modal action loop must not transfer vector bytes");
    check(
        std::strstr(gpu.diagnostics_json, "\"hot_loop_allocations\":0") != nullptr,
        "GPU diagnostics must publish zero hot-loop allocations");
    check(
        std::strstr(gpu.diagnostics_json, "\"hot_loop_h2d_bytes\":0") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"hot_loop_d2h_bytes\":0") != nullptr,
        "GPU diagnostics must publish zero hot-loop transfer bytes");
    check(
        std::strstr(gpu.diagnostics_json, "\"augmented_dof_count\":4") != nullptr,
        "GPU diagnostics must publish the native augmented DOF count");
    check(
        std::abs(gpu.frequency_hz - problem.target_frequency_hz) <=
            0.05 * problem.target_frequency_hz,
        "GPU frequency must remain on the targeted K0 branch");
    check(
        std::strstr(gpu.diagnostics_json, "\"spectral_pencil_kind\":\"real_frequency_rotated\"") != nullptr,
        "GPU diagnostics must identify the real-frequency-rotated pencil");
    check(
        std::strstr(gpu.diagnostics_json, "\"petsc_vector_type\":\"seqcuda\"") != nullptr,
        "GPU diagnostics must prove CUDA PETSc vectors");
    check(
        std::strstr(gpu.diagnostics_json, "\"slepc_basis_vector_type\":\"seqcuda\"") != nullptr,
        "GPU diagnostics must prove a CUDA-resident SLEPc basis");
    check(
        std::strstr(gpu.diagnostics_json, "\"poisson_pc_type\":\"ilu\"") != nullptr &&
            std::strstr(
                gpu.diagnostics_json,
                "\"poisson_solver\":\"preonly_cuda_ilu\"") != nullptr,
        "bounded GPU validation must report its exact CUDA Poisson solve");
    check(
        std::strstr(gpu.diagnostics_json, "\"per_iteration_full_vector_transfers\":0") != nullptr,
        "GPU diagnostics must reject per-iteration full-vector transfers");
    check(
        std::strstr(gpu.diagnostics_json, "\"device_residual_certification\":true") != nullptr,
        "GPU diagnostics must prove device-resident full residual certification");
    check(
        std::strstr(gpu.diagnostics_json, "\"residual_host_vector_reconstruction\":false") != nullptr,
        "GPU diagnostics must reject host residual reconstruction");
    check(
        std::strstr(gpu.diagnostics_json, "\"fallback_used\":false") != nullptr,
        "strict GPU solve must not use CPU fallback");
    check(
        std::strstr(gpu.diagnostics_json, "\"outer_boundary_kind\":\"poisson_robin\"") != nullptr,
        "GPU diagnostics must publish the resolved scalar outer boundary");
    check(
        std::strstr(gpu.diagnostics_json, "\"robin_beta\":1") != nullptr,
        "GPU diagnostics must publish the Robin coefficient");
    check(
        std::strstr(gpu.diagnostics_json, "\"gauge_policy\":\"none\"") != nullptr,
        "GPU diagnostics must publish the resolved gauge policy");
    check(
        std::strstr(gpu.diagnostics_json, "\"gauge_reason\":\"coercive_outer_boundary\"") != nullptr,
        "GPU diagnostics must publish the gauge decision reason");
    check(
        std::strstr(gpu.diagnostics_json, "\"magnetic_block_backward_error\":") != nullptr,
        "GPU diagnostics must publish the magnetic block residual");
    check(
        std::strstr(gpu.diagnostics_json, "\"poisson_block_backward_error\":") != nullptr,
        "GPU diagnostics must publish the Poisson block residual");
    check(
        std::strstr(gpu.diagnostics_json, "\"gauge_constraint_backward_error\":") != nullptr,
        "GPU diagnostics must publish the gauge block residual");
    check(
        std::strstr(gpu.diagnostics_json, "\"action_residual_evaluated_count\":") != nullptr,
        "GPU diagnostics must publish action residual evaluation count");
    check(
        std::strstr(gpu.diagnostics_json, "\"full_residual_accepted_count\":") != nullptr,
        "GPU diagnostics must publish full residual acceptance count");
    check(
        std::strstr(gpu.diagnostics_json, "\"block_residuals\":{") != nullptr,
        "GPU diagnostics must publish the block residual object");
    check(
        std::strstr(gpu.diagnostics_json, "\"boundary_gauge\":{") != nullptr,
        "GPU diagnostics must publish the boundary/gauge object");
    check(
        std::strstr(gpu.diagnostics_json, "\"certification\":{") != nullptr,
        "GPU diagnostics must publish the certification object");
    check(
        std::strstr(gpu.diagnostics_json, "\"production_shared_domain\":false") != nullptr,
        "bounded GPU algebraic adapter must not claim production shared-domain FEM");
    check(
        std::strstr(gpu.diagnostics_json, "\"execution_lane\":\"validation_gpu\"") != nullptr,
        "bounded GPU algebraic adapter must identify the validation execution lane");
    check(
        std::strstr(gpu.diagnostics_json, "\"production_implication\":false") != nullptr,
        "bounded GPU algebraic adapter must not publish production implication");
    check(
        std::strstr(gpu.diagnostics_json, "\"validation_only\":true") != nullptr,
        "bounded GPU algebraic adapter must identify validation-only provenance");
    check(
        std::strstr(gpu.diagnostics_json, "\"scalable_selected_spectrum\":false") != nullptr,
        "bounded materialized GPU adapter must not claim scalable selected spectrum");
    check(
        std::strstr(
            gpu.diagnostics_json,
            "\"gpu_device_resident_modal_eigensolver\":false") != nullptr &&
            std::strstr(
                gpu.diagnostics_json,
                "\"spectral_transform\":\"bounded_full_spectrum_shift\"") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"eigensolver\":\"slepc_lapack\"") != nullptr,
        "bounded validation adapter must not claim the production device Krylov solve");
    check(
        std::strstr(gpu.diagnostics_json, "\"true_residual_convergence\":true") != nullptr,
        "GPU SLEPc solve must use explicit true residual convergence");
    check(
        std::strstr(gpu.diagnostics_json, "\"eps_converged_reason\":") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"eps_reason_available\":true") != nullptr,
        "GPU diagnostics must publish the queried EPS convergence reason");
    check(
        std::strstr(gpu.diagnostics_json, "\"operator_apply_count\":") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"poisson_iteration_count\":") != nullptr,
        "GPU diagnostics must publish measured operator and Poisson iteration counters");
    check(
        std::strstr(
            gpu.diagnostics_json,
            "\"eigensolver_operator_kind\":\"materialized_schur_cuda\"") != nullptr,
        "bounded GPU qualification solve must use the materialized CUDA Schur operator");
    check(
        std::strcmp(
            gpu.shifted_preconditioner_kind,
            "materialized_shifted_schur_cuda") == 0,
        "bounded GPU qualification solve must report its materialized shifted preconditioner");
    check(
        std::strstr(gpu.diagnostics_json, "\"shift_pc_type\":\"none\"") != nullptr,
        "bounded full-spectrum validation must report its non-iterative shift path");

    constexpr std::uint64_t scaled_block_count = 12;
    constexpr std::uint64_t scaled_dof_count = 2 * scaled_block_count;
    std::vector<double> scaled_a_qq(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_a_qphi(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_a_phiq(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_a_phiphi(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_b_qq(scaled_dof_count * scaled_dof_count, 0.0);
    for (std::uint64_t block = 0; block < scaled_block_count; ++block) {
        const std::uint64_t first = 2 * block;
        const std::uint64_t second = first + 1;
        const double block_frequency_hz = 1.0e9 + 0.5e9 * static_cast<double>(block);
        const double block_omega = two_pi * block_frequency_hz;
        scaled_a_qq[first * scaled_dof_count + second] = -pencil_scale * block_omega;
        scaled_a_qq[second * scaled_dof_count + first] = pencil_scale * block_omega;
        scaled_a_qphi[first * scaled_dof_count + first] = -pencil_scale * 1.5e8;
        scaled_a_qphi[first * scaled_dof_count + second] = pencil_scale * 1.5e8;
        scaled_a_phiq[first * scaled_dof_count + second] = -pencil_scale;
        scaled_a_phiq[second * scaled_dof_count + second] = pencil_scale;
        scaled_a_phiphi[first * scaled_dof_count + first] = 2.0 * pencil_scale;
        scaled_a_phiphi[first * scaled_dof_count + second] = -pencil_scale;
        scaled_a_phiphi[second * scaled_dof_count + first] = -pencil_scale;
        scaled_a_phiphi[second * scaled_dof_count + second] = 2.0 * pencil_scale;
        scaled_b_qq[first * scaled_dof_count + first] = pencil_scale;
        scaled_b_qq[second * scaled_dof_count + second] = pencil_scale;
    }
    const CsrOwned block_a_qq = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_qq.data());
    const CsrOwned block_a_qphi = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_qphi.data());
    const CsrOwned block_a_phiq = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_phiq.data());
    const CsrOwned block_a_phiphi = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_phiphi.data());
    const CsrOwned block_b_qq = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_b_qq.data());
    fd::PoissonAirboxEigenBlockProblem scaled_problem = problem;
    scaled_problem.q_dof_count = scaled_dof_count;
    scaled_problem.phi_dof_count = scaled_dof_count;
    scaled_problem.A_qq = block_a_qq.view();
    scaled_problem.A_qphi = block_a_qphi.view();
    scaled_problem.A_phiq = block_a_phiq.view();
    scaled_problem.A_phiphi = block_a_phiphi.view();
    scaled_problem.B_qq = block_b_qq.view();
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(scaled_problem, &gpu) ==
            fd::FrequencyDomainStatus::ok,
        gpu.error_message);
    check(gpu.full_residual_certified,
          "SI-scaled GPU pencil must certify the full descriptor residual");
    check(
        std::abs(gpu.frequency_hz - scaled_problem.target_frequency_hz) <=
            0.05 * scaled_problem.target_frequency_hz,
        "SI-scaled GPU pencil must retain the targeted physical frequency");

    problem = scaled_problem;
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 1.0e9;
    problem.frequency_max_hz = 3.0e9;
    problem.requested_mode_count = 1;
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::ok,
        gpu.error_message);
    check(gpu.accepted_mode_count == 1,
          "GPU multi-shift window must collapse repeated physical branches");
    check(gpu.frequency_hz >= problem.frequency_min_hz &&
              gpu.frequency_hz <= problem.frequency_max_hz,
          "GPU multi-shift window must publish an in-window mode");
    check(std::strstr(gpu.executed_subwindows_json, "\"subwindow_index\":15") != nullptr,
          "GPU frequency-window solve must record every executed subwindow");

    // A complete window may not silently publish fewer modes than requested.
    problem.requested_mode_count = 6;
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::solve_error,
        "GPU frequency window must fail closed when requested coverage is incomplete");
    check(
        std::strstr(gpu.diagnostics_json, "\"complete\":false") != nullptr,
        "incomplete GPU frequency window must not be marked complete");
    check(
        std::strstr(
            gpu.diagnostics_json,
            "\"eps_stop_reason\":\"frequency_window_incomplete_mode_coverage\"") !=
            nullptr,
        "incomplete GPU frequency window must publish a stable stop reason");

    problem.frequency_min_hz = 10.0e9;
    problem.frequency_max_hz = 11.0e9;
    problem.target_frequency_hz = 10.5e9;
    gpu = {};
    const fd::FrequencyDomainStatus empty_status =
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu);
    check(
        empty_status == fd::FrequencyDomainStatus::solve_error,
        "an empty GPU frequency window must fail closed");
    check(gpu.status == fd::FrequencyDomainStatus::solve_error,
          "empty GPU window result must retain solve_error status");
    check(gpu.accepted_modes.empty() && gpu.accepted_mode_count == 0,
          "empty GPU window must not publish a candidate mode");
    check(!gpu.window_complete,
          "empty GPU window must not publish a complete spectrum");
    check(
        std::strstr(gpu.diagnostics_json, "\"status\":\"failed\",\"complete\":false") !=
            nullptr,
        "empty GPU window diagnostics must publish a failed incomplete result");
    check(gpu.converged_eigenpair_count > 0,
          "failed GPU window must retain converged subwindow counts");
    check(std::strstr(gpu.executed_subwindows_json, "\"subwindow_index\":15") != nullptr,
          "failed GPU window must retain every subwindow diagnostic");
    check(std::strstr(gpu.diagnostics_json, "\"executed_subwindows\":[") != nullptr,
          "failed GPU window diagnostics must expose executed subwindows");
    check(
        std::strstr(
            gpu.diagnostics_json,
            "frequency_window_incomplete_mode_coverage") != nullptr,
        "empty GPU window diagnostics must expose the stable failure reason");
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "owned GPU SLEPc runtime finalization must succeed");
}
