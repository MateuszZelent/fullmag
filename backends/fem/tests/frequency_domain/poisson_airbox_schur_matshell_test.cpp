/*
 * poisson_airbox_schur_matshell_test.cpp - PA-E3 CPU Schur MatShell
 * Poisson-airbox k=0 modal eigensolve certification tests.
 */

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "cpu/frequency_domain/poisson_airbox_schur_matshell.hpp"
#include "cpu/frequency_domain/modal_krylov_tuning.hpp"
#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"
#include "frequency_domain/planner/frequency_solve_planner.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool contains(const char *haystack, const char *needle)
{
    return haystack != nullptr && std::strstr(haystack, needle) != nullptr;
}

struct ProgressCapture {
    char json[2048]{};
    std::uint32_t count = 0;
};

void capture_progress_json(void *user_data, const char *progress_json)
{
    auto *capture = static_cast<ProgressCapture *>(user_data);
    if (capture == nullptr || progress_json == nullptr) {
        return;
    }
    std::snprintf(capture->json, sizeof(capture->json), "%s", progress_json);
    ++capture->count;
}

void skip_json_whitespace(const char **cursor)
{
    while (**cursor == ' ' || **cursor == '\t' || **cursor == '\r' || **cursor == '\n') {
        ++(*cursor);
    }
}

bool parse_json_string(const char **cursor)
{
    if (**cursor != '"') {
        return false;
    }
    ++(*cursor);
    while (**cursor != '\0') {
        const unsigned char character = static_cast<unsigned char>(**cursor);
        ++(*cursor);
        if (character == '"') {
            return true;
        }
        if (character < 0x20u) {
            return false;
        }
        if (character == '\\') {
            const char escaped = **cursor;
            if (escaped == '\0') {
                return false;
            }
            ++(*cursor);
            if (escaped == 'u') {
                for (int digit = 0; digit < 4; ++digit) {
                    const char hex = **cursor;
                    if (!((hex >= '0' && hex <= '9') ||
                          (hex >= 'a' && hex <= 'f') ||
                          (hex >= 'A' && hex <= 'F'))) {
                        return false;
                    }
                    ++(*cursor);
                }
            } else if (escaped != '"' && escaped != '\\' && escaped != '/' &&
                       escaped != 'b' && escaped != 'f' && escaped != 'n' &&
                       escaped != 'r' && escaped != 't') {
                return false;
            }
        }
    }
    return false;
}

bool parse_json_number(const char **cursor)
{
    const char *start = *cursor;
    if (**cursor == '-') {
        ++(*cursor);
    }
    if (**cursor == '0') {
        ++(*cursor);
        if (**cursor >= '0' && **cursor <= '9') {
            return false;
        }
    } else {
        if (**cursor < '1' || **cursor > '9') {
            return false;
        }
        while (**cursor >= '0' && **cursor <= '9') {
            ++(*cursor);
        }
    }
    if (**cursor == '.') {
        ++(*cursor);
        if (**cursor < '0' || **cursor > '9') {
            return false;
        }
        while (**cursor >= '0' && **cursor <= '9') {
            ++(*cursor);
        }
    }
    if (**cursor == 'e' || **cursor == 'E') {
        ++(*cursor);
        if (**cursor == '+' || **cursor == '-') {
            ++(*cursor);
        }
        if (**cursor < '0' || **cursor > '9') {
            return false;
        }
        while (**cursor >= '0' && **cursor <= '9') {
            ++(*cursor);
        }
    }
    return *cursor != start;
}

bool parse_json_scalar(const char **cursor)
{
    if (**cursor == '"') {
        return parse_json_string(cursor);
    }
    if (std::strncmp(*cursor, "null", 4) == 0) {
        *cursor += 4;
        return true;
    }
    if (std::strncmp(*cursor, "true", 4) == 0) {
        *cursor += 4;
        return true;
    }
    if (std::strncmp(*cursor, "false", 5) == 0) {
        *cursor += 5;
        return true;
    }
    return parse_json_number(cursor);
}

bool is_valid_flat_progress_json(const char *json)
{
    if (json == nullptr) {
        return false;
    }
    const char *cursor = json;
    skip_json_whitespace(&cursor);
    if (*cursor++ != '{') {
        return false;
    }
    skip_json_whitespace(&cursor);
    if (*cursor == '}') {
        ++cursor;
        skip_json_whitespace(&cursor);
        return *cursor == '\0';
    }
    for (;;) {
        if (!parse_json_string(&cursor)) {
            return false;
        }
        skip_json_whitespace(&cursor);
        if (*cursor++ != ':') {
            return false;
        }
        skip_json_whitespace(&cursor);
        if (!parse_json_scalar(&cursor)) {
            return false;
        }
        skip_json_whitespace(&cursor);
        if (*cursor == '}') {
            ++cursor;
            skip_json_whitespace(&cursor);
            return *cursor == '\0';
        }
        if (*cursor++ != ',') {
            return false;
        }
        skip_json_whitespace(&cursor);
    }
}

bool json_field_is_null(const char *json, const char *field)
{
    char key[96]{};
    std::snprintf(key, sizeof(key), "\"%s\":null", field);
    return contains(json, key);
}

bool json_field_is_finite_nonnegative_number(
    const char *json,
    const char *field,
    double *out_value)
{
    char key[96]{};
    std::snprintf(key, sizeof(key), "\"%s\":", field);
    const char *value = json != nullptr ? std::strstr(json, key) : nullptr;
    if (value == nullptr) {
        return false;
    }
    value += std::strlen(key);
    char *end = nullptr;
    const double parsed = std::strtod(value, &end);
    if (end == value || !std::isfinite(parsed) || parsed < 0.0) {
        return false;
    }
    if (out_value != nullptr) {
        *out_value = parsed;
    }
    return true;
}

struct CsrOwned {
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    fd::CsrMatrixView view() const
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

CsrOwned dense_to_csr(
    std::uint64_t rows,
    std::uint64_t columns,
    const double *row_major_values)
{
    CsrOwned csr{};
    csr.rows = rows;
    csr.columns = columns;
    csr.row_offsets.reserve(static_cast<std::size_t>(rows + 1));
    csr.row_offsets.push_back(0);
    for (std::uint64_t row = 0; row < rows; ++row) {
        for (std::uint64_t column = 0; column < columns; ++column) {
            const double value =
                row_major_values[static_cast<std::size_t>(row * columns + column)];
            if (value != 0.0) {
                csr.column_indices.push_back(static_cast<std::uint32_t>(column));
                csr.values.push_back(value);
            }
        }
        csr.row_offsets.push_back(static_cast<std::uint32_t>(csr.values.size()));
    }
    return csr;
}

struct TinySparseFixture {
    double a_qq[4] = {};
    double a_qphi[4] = {};
    double a_phiq[4] = {};
    double a_phiphi[4] = {};
    double b_qq[4] = {};
    double weights[2] = {0.5, 0.5};
    CsrOwned A_qq{};
    CsrOwned A_qphi{};
    CsrOwned A_phiq{};
    CsrOwned A_phiphi{};
    CsrOwned B_qq{};
    fd::DensePoissonAirboxEigenOracleResult dense_result{};
};

TinySparseFixture make_tiny_full_coupled_fixture()
{
    TinySparseFixture fixture{};
    const double omega0 = kTwoPi * 2.0e9;
    const double a_qq[4] = {0.0, -omega0, omega0, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    std::memcpy(fixture.a_qq, a_qq, sizeof(a_qq));
    std::memcpy(fixture.a_qphi, a_qphi, sizeof(a_qphi));
    std::memcpy(fixture.a_phiq, a_phiq, sizeof(a_phiq));
    std::memcpy(fixture.a_phiphi, a_phiphi, sizeof(a_phiphi));
    std::memcpy(fixture.b_qq, b_qq, sizeof(b_qq));

    fixture.A_qq = dense_to_csr(2, 2, fixture.a_qq);
    fixture.A_qphi = dense_to_csr(2, 2, fixture.a_qphi);
    fixture.A_phiq = dense_to_csr(2, 2, fixture.a_phiq);
    fixture.A_phiphi = dense_to_csr(2, 2, fixture.a_phiphi);
    fixture.B_qq = dense_to_csr(2, 2, fixture.b_qq);
    return fixture;
}

fd::DensePoissonAirboxEigenOracleProblem dense_problem_from_fixture(
    const TinySparseFixture &fixture)
{
    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fd::DenseRealMatrixView{fixture.a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{fixture.a_qphi, 2, 2};
    problem.A_phiq = fd::DenseRealMatrixView{fixture.a_phiq, 2, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{fixture.a_phiphi, 2, 2};
    problem.B_qq = fd::DenseRealMatrixView{fixture.b_qq, 2, 2};
    problem.phi_mean_weights = fixture.weights;
    problem.phi_mean_weights_count = 2;
    return problem;
}

fd::PoissonAirboxEigenBlockProblem sparse_problem_from_fixture(
    const TinySparseFixture &fixture)
{
    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = fixture.A_qq.view();
    problem.A_qphi = fixture.A_qphi.view();
    problem.A_phiq = fixture.A_phiq.view();
    problem.A_phiphi = fixture.A_phiphi.view();
    problem.B_qq = fixture.B_qq.view();
    problem.phi_mean_weights = fixture.weights;
    problem.phi_mean_weights_count = 2;
    problem.outer_boundary_kind = "pure_neumann";
    problem.robin_beta = 0.0;
    problem.gauge_policy = "mean_zero_augmented";
    problem.gauge_reason = "pure_neumann_nullspace";
    problem.assembly_kind = "synthetic_algebraic_oracle";
    problem.target_frequency_hz = 2.0e9;
    problem.expected_reference_frequency_hz = fixture.dense_result.frequency_hz;
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    return problem;
}

void ModalKspProgressUsesLinearResidualSemanticsAndValidJson()
{
    ProgressCapture capture{};
    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.progress_callback = capture_progress_json;
    problem.progress_user_data = &capture;
    problem.max_outer_iterations = 12;
    problem.max_linear_iterations = 64;
    problem.residual_tolerance = 1.0e-10;
    problem.progress_window_phase = "base";
    problem.progress_current_subwindow = 2;
    problem.progress_total_subwindows = 4;
    problem.progress_subwindow_elapsed_seconds = 1.25;
    problem.progress_window_elapsed_seconds = 2.5;

    const fd::PoissonAirboxModalLinearProgress poisson_progress{
        fd::PoissonAirboxModalLinearSolverRole::poisson,
        "preonly",
        3,
        0.125};
    fd::poisson_airbox_modal_emit_progress(
        problem,
        "solving_shift_invert",
        "production_cpu",
        8,
        2,
        1,
        99,
        std::numeric_limits<double>::quiet_NaN(),
        nullptr,
        &poisson_progress);

    check(capture.count == 1, "KSP progress must call the registered JSON callback");
    check(is_valid_flat_progress_json(capture.json), "KSP progress must be valid JSON");
    check(contains(capture.json, "\"residual_source\":\"ksp_norm\""),
        "KSP progress must identify the raw residual source");
    check(json_field_is_null(capture.json, "current_residual_relative_l2"),
        "KSP norm must not be labeled as relative outer residual");
    check(json_field_is_null(capture.json, "outer_iteration"),
        "KSP iteration must not be labeled as an EPS iteration");
    check(contains(capture.json, "\"linear_solver_role\":\"poisson\""),
        "Poisson KSP progress must expose its solver role");
    check(contains(capture.json, "\"linear_ksp_type\":\"preonly\""),
        "available KSP type must be emitted");
    check(contains(capture.json, "\"linear_iteration\":3"),
        "typed KSP iteration must override the legacy iteration argument");
    double linear_norm = -1.0;
    check(json_field_is_finite_nonnegative_number(
              capture.json, "linear_residual_norm", &linear_norm) &&
              linear_norm == 0.125,
        "finite non-negative KSP norm must be preserved");

    capture = ProgressCapture{};
    fd::PoissonAirboxModalLinearProgress missing_type_bad_norm{};
    missing_type_bad_norm.role =
        fd::PoissonAirboxModalLinearSolverRole::shift_invert;
    fd::poisson_airbox_modal_emit_progress(
        problem,
        "solving_shift_invert",
        "production_cpu",
        0,
        0,
        0,
        0,
        0.0,
        nullptr,
        &missing_type_bad_norm);
    check(is_valid_flat_progress_json(capture.json),
        "missing KSP type and non-finite norm must still produce valid JSON");
    check(json_field_is_null(capture.json, "linear_ksp_type"),
        "unavailable KSP type must be JSON null");
    check(json_field_is_null(capture.json, "linear_residual_norm"),
        "non-finite KSP norm must be JSON null");
    check(contains(capture.json, "\"linear_solver_role\":\"shift_invert\""),
        "shift-invert KSP progress must expose its solver role");

    capture = ProgressCapture{};
    const fd::PoissonAirboxModalLinearProgress unknown_progress{};
    fd::poisson_airbox_modal_emit_progress(
        problem,
        "solving_shift_invert",
        "production_cpu",
        0,
        0,
        0,
        0,
        0.0,
        nullptr,
        &unknown_progress);
    check(is_valid_flat_progress_json(capture.json),
        "default linear-progress payload must produce valid JSON");
    check(json_field_is_null(capture.json, "linear_solver_role") &&
              json_field_is_null(capture.json, "linear_ksp_type") &&
              json_field_is_null(capture.json, "linear_residual_norm"),
        "unknown role and unmeasured type/norm defaults must remain JSON null");

    capture = ProgressCapture{};
    const fd::PoissonAirboxModalLinearProgress negative_norm{
        fd::PoissonAirboxModalLinearSolverRole::poisson,
        "preonly",
        2,
        -0.5};
    fd::poisson_airbox_modal_emit_progress(
        problem,
        "solving_shift_invert",
        "production_cpu",
        0,
        0,
        0,
        0,
        0.0,
        nullptr,
        &negative_norm);
    check(is_valid_flat_progress_json(capture.json),
        "negative KSP norm must not make the progress event invalid JSON");
    check(json_field_is_null(capture.json, "linear_residual_norm"),
        "negative KSP norm must be JSON null");

    capture = ProgressCapture{};
    problem.progress_subwindow_elapsed_seconds =
        std::numeric_limits<double>::infinity();
    problem.progress_window_elapsed_seconds =
        -std::numeric_limits<double>::infinity();
    problem.residual_tolerance = std::numeric_limits<double>::quiet_NaN();
    fd::poisson_airbox_modal_emit_progress(
        problem,
        "frequency_window_subwindow_complete",
        "production_cpu",
        1,
        2,
        1,
        7,
        std::numeric_limits<double>::infinity());
    check(is_valid_flat_progress_json(capture.json),
        "generic window progress with non-finite values must remain valid JSON");
    check(json_field_is_null(capture.json, "current_residual_relative_l2") &&
              json_field_is_null(capture.json, "target_residual_relative_l2") &&
              json_field_is_null(capture.json, "subwindow_elapsed_seconds") &&
              json_field_is_null(capture.json, "window_elapsed_seconds"),
        "non-finite generic telemetry values must be JSON null, not zero or invalid tokens");
}

void SubwindowTerminationFormatterPreservesMeasuredNullableEpsFields()
{
    const int reason_codes[] = {-1, -2, 0};
    const std::uint32_t outer_iterations[] = {0u, 23u};
    for (const int reason_code : reason_codes) {
        for (const std::uint32_t iteration_count : outer_iterations) {
            fd::PoissonAirboxModalEigenResult result{};
            result.eps_reason_available = true;
            result.slepc_converged_reason_code = reason_code;
            result.outer_iterations = iteration_count;
            char fields[128]{};
            check(fd::format_poisson_airbox_subwindow_termination_json(
                      result, fields, sizeof(fields)),
                "available EPS termination must format into the bounded buffer");
            char json[192]{};
            std::snprintf(json, sizeof(json), "{%s}", fields);
            check(is_valid_flat_progress_json(json),
                "available EPS termination fields must form valid JSON");
            check(contains(json, "\"eps_reason_available\":true"),
                "queried EPS termination must report availability");
            char expected_reason[64]{};
            std::snprintf(
                expected_reason,
                sizeof(expected_reason),
                "\"slepc_converged_reason_code\":%d",
                reason_code);
            check(contains(json, expected_reason),
                "signed EPS reason, including known zero, must be preserved");
            char expected_iterations[48]{};
            std::snprintf(
                expected_iterations,
                sizeof(expected_iterations),
                "\"outer_iterations\":%u",
                iteration_count);
            check(contains(json, expected_iterations),
                "known EPS iteration count, including zero, must be preserved");
        }
    }

    fd::PoissonAirboxModalEigenResult unknown{};
    char fields[128]{};
    check(fd::format_poisson_airbox_subwindow_termination_json(
              unknown, fields, sizeof(fields)),
        "unknown EPS termination must remain serializable");
    char json[192]{};
    std::snprintf(json, sizeof(json), "{%s}", fields);
    check(is_valid_flat_progress_json(json) &&
              contains(json, "\"eps_reason_available\":false") &&
              json_field_is_null(json, "slepc_converged_reason_code") &&
              json_field_is_null(json, "outer_iterations"),
        "unknown EPS termination must be false/null rather than synthetic zero");

    fd::PoissonAirboxModalEigenResult hard_error{};
    hard_error.eps_reason_available = true;
    hard_error.eps_solve_error_code_available = true;
    hard_error.eps_solve_error_code = 17;
    hard_error.slepc_process_quarantined = true;
    hard_error.eps_lifetime_unsafe = true;
    check(fd::format_poisson_airbox_subwindow_termination_json(
              hard_error, fields, sizeof(fields)),
        "hard EPS error guard must remain serializable");
    std::snprintf(json, sizeof(json), "{%s}", fields);
    check(is_valid_flat_progress_json(json) &&
              contains(json, "\"eps_reason_available\":false") &&
              json_field_is_null(json, "slepc_converged_reason_code") &&
              json_field_is_null(json, "outer_iterations"),
        "hard EPS error must not expose a termination snapshot");

    fd::PoissonAirboxModalEigenResult zero_error_code_available{};
    zero_error_code_available.eps_reason_available = true;
    zero_error_code_available.eps_solve_error_code_available = true;
    zero_error_code_available.eps_solve_error_code = 0;
    zero_error_code_available.slepc_converged_reason_code = -1;
    zero_error_code_available.outer_iterations = 2000u;
    check(fd::format_poisson_airbox_subwindow_termination_json(
              zero_error_code_available, fields, sizeof(fields)),
        "available zero EPS error code must not suppress a valid reason snapshot");
    std::snprintf(json, sizeof(json), "{%s}", fields);
    check(is_valid_flat_progress_json(json) &&
              contains(json, "\"eps_reason_available\":true") &&
              contains(json, "\"slepc_converged_reason_code\":-1") &&
              contains(json, "\"outer_iterations\":2000"),
        "zero-valued available error code must preserve EPS reason and iterations");

    fd::PoissonAirboxModalEigenResult invalid_context{};
    invalid_context.eps_reason_available = true;
    invalid_context.operator_context_invalidated = true;
    invalid_context.slepc_converged_reason_code = -2;
    invalid_context.outer_iterations = 23u;
    check(fd::format_poisson_airbox_subwindow_termination_json(
              invalid_context, fields, sizeof(fields)),
        "invalid-context guard must remain serializable");
    std::snprintf(json, sizeof(json), "{%s}", fields);
    check(is_valid_flat_progress_json(json) &&
              contains(json, "\"eps_reason_available\":false") &&
              json_field_is_null(json, "slepc_converged_reason_code") &&
              json_field_is_null(json, "outer_iterations"),
        "invalid context must not be presented as a usable EPS snapshot");

    fd::PoissonAirboxModalEigenResult cancelled{};
    cancelled.eps_reason_available = true;
    cancelled.eps_cancellation_observed = true;
    cancelled.slepc_converged_reason_code = -1;
    cancelled.outer_iterations = 0u;
    check(fd::format_poisson_airbox_subwindow_termination_json(
              cancelled, fields, sizeof(fields)),
        "cancelled solve with successful EPS queries must remain serializable");
    std::snprintf(json, sizeof(json), "{%s}", fields);
    check(is_valid_flat_progress_json(json) &&
              contains(json, "\"eps_reason_available\":true") &&
              contains(json, "\"slepc_converged_reason_code\":-1") &&
              contains(json, "\"outer_iterations\":0"),
        "cancellation must preserve successfully queried EPS termination");
}

void EpsDimensionsFormatterPreservesSignedQueriesAndBoundsBuffers()
{
    char json[192]{};
    check(fd::format_poisson_airbox_eps_dimensions_json(
              true, 4, 8, 16, json, sizeof(json)),
        "positive EPS dimensions must fit the formatter buffer");
    check(std::strcmp(
              json,
              "\"eps_dimensions\":{\"query_succeeded\":true,"
              "\"nev\":4,\"ncv\":8,\"mpd\":16}") == 0,
        "successful EPS dimensions must serialize all queried values");

    check(fd::format_poisson_airbox_eps_dimensions_json(
              true, 0, -1, -2, json, sizeof(json)),
        "zero and negative EPS dimension sentinels must remain serializable");
    check(std::strcmp(
              json,
              "\"eps_dimensions\":{\"query_succeeded\":true,"
              "\"nev\":0,\"ncv\":-1,\"mpd\":-2}") == 0,
        "successful EPS query must preserve zero and signed sentinel values");

    check(fd::format_poisson_airbox_eps_dimensions_json(
              false,
              std::numeric_limits<std::int64_t>::max(),
              std::numeric_limits<std::int64_t>::min(),
              123,
              json,
              sizeof(json)),
        "failed EPS dimension query must remain serializable");
    check(std::strcmp(
              json,
              "\"eps_dimensions\":{\"query_succeeded\":false,"
              "\"nev\":null,\"ncv\":null,\"mpd\":null}") == 0,
        "failed EPS query must ignore raw outputs and report null dimensions");

    check(fd::format_poisson_airbox_eps_dimensions_json(
              true,
              std::numeric_limits<std::int64_t>::min(),
              std::numeric_limits<std::int64_t>::max(),
              std::numeric_limits<std::int64_t>::min(),
              json,
              sizeof(json)),
        "signed 64-bit EPS dimensions must fit the formatter buffer");
    check(std::strcmp(
              json,
              "\"eps_dimensions\":{\"query_succeeded\":true,"
              "\"nev\":-9223372036854775808,"
              "\"ncv\":9223372036854775807,"
              "\"mpd\":-9223372036854775808}") == 0,
        "signed 64-bit EPS dimension boundaries must serialize exactly");

    char tiny_buffer[8] = "partial";
    check(!fd::format_poisson_airbox_eps_dimensions_json(
              true, 4, 8, 16, tiny_buffer, sizeof(tiny_buffer)) &&
              tiny_buffer[0] == '\0',
        "truncated EPS dimensions must fail and clear the destination");
    check(!fd::format_poisson_airbox_eps_dimensions_json(
              true, 4, 8, 16, nullptr, sizeof(json)),
        "null EPS dimension destination must be rejected");
    char zero_size_buffer[] = "keep";
    check(!fd::format_poisson_airbox_eps_dimensions_json(
              true, 4, 8, 16, zero_size_buffer, 0u) &&
              zero_size_buffer[0] == 'k',
        "zero-size EPS dimension destination must be rejected without writing");
}

void CertifiesSchurMatShellAgainstFullCoupledSparseReference()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fd::DensePoissonAirboxEigenOracleProblem dense_problem =
        dense_problem_from_fixture(fixture);
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(
            dense_problem,
            &fixture.dense_result) == fd::FrequencyDomainStatus::ok,
        fixture.dense_result.error_message);

    fd::PoissonAirboxEigenBlockProblem sparse_problem =
        sparse_problem_from_fixture(fixture);
    fd::PoissonAirboxSchurMatShellCertificationResult result{};
    check(
        fd::certify_poisson_airbox_schur_matshell_cpu(
            sparse_problem,
            &result) == fd::FrequencyDomainStatus::ok,
        result.error_message);

    check(result.created_petsc_matshell, "PA-E3 must create and use a PETSc MatShell");
    check(result.reused_mean_zero_poisson_setup, "PA-E3 must reuse the mean-zero Poisson setup");
    check(result.schur_certified, "PA-E3 Schur MatShell must certify");
    check(
        result.schur_apply_relative_error <= 1.0e-10,
        "PA-E3 MatShell apply must match explicit Schur on sampled vectors");
    check(
        result.full_sparse_reference_relative_frequency_error <= 1.0e-10,
        "PA-E3 Schur eigenfrequency must match PA-E2 full-coupled sparse reference");
    check(
        result.full_residual_reconstruction_relative_error <= 1.0e-10,
        "PA-E3 Schur eigenvector must reconstruct the full descriptor residual");
    check(
        contains(result.diagnostics_json, "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_matshell_slepc\""),
        "PA-E3 diagnostics must name the Schur MatShell adapter");
    check(
        contains(result.diagnostics_json, "\"certificate_key\""),
        "PA-E3 diagnostics must emit a Schur certificate key");
}

void PlannerRequiresExplicitCertifiedSchurSelection()
{
    fd::FrequencySolvePlannerInput implicit_input{};
    implicit_input.tiny_problem = false;
    implicit_input.periodic_airbox_k0 = true;
    implicit_input.periodic_mesh_symmetry_certified = true;
    implicit_input.schur_certified = true;
    implicit_input.schur_reduced_explicitly_requested = false;

    const fd::FrequencySolvePlan implicit_plan =
        fd::plan_frequency_response(implicit_input);
    check(
        implicit_plan.lane != fd::FrequencyExecutionLane::schur_reduced,
        "certified Schur must not be auto-selected without an explicit Schur request");
    check(
        !implicit_plan.use_schur_reduction,
        "implicit certified Schur plan must not enable Schur reduction");

    fd::FrequencySolvePlannerInput explicit_input = implicit_input;
    explicit_input.schur_reduced_explicitly_requested = true;

    const fd::FrequencySolvePlan explicit_plan =
        fd::plan_frequency_response(explicit_input);
    check(
        explicit_plan.lane == fd::FrequencyExecutionLane::schur_reduced,
        "explicit certified Schur request must select schur_reduced");
    check(
        explicit_plan.use_schur_reduction,
        "explicit certified Schur request must record Schur reduction");
}

void RejectsInvalidGaugeWeightsBeforeSchurCertification()
{
    TinySparseFixture fixture = make_tiny_full_coupled_fixture();
    fixture.weights[0] = -0.5;
    fixture.weights[1] = 1.5;
    fd::PoissonAirboxEigenBlockProblem sparse_problem =
        sparse_problem_from_fixture(fixture);
    fd::PoissonAirboxSchurMatShellCertificationResult result{};

    check(
        fd::certify_poisson_airbox_schur_matshell_cpu(
            sparse_problem,
            &result) == fd::FrequencyDomainStatus::validation_error,
        "PA-E3 must reject invalid gauge weights before Schur certification");
    check(
        contains(result.diagnostics_json, "poisson_airbox_schur_requires_mean_zero_gauge"),
        "PA-E3 invalid gauge-weight rejection must use a Schur-specific reason");
    check(
        contains(result.error_message, "positive normalized"),
        "PA-E3 invalid gauge-weight rejection must report positive normalized weights");
}

fd::ModalKrylovTuning default_modal_krylov_tuning()
{
    return fd::ModalKrylovTuning{2.5e-9, 3.5e-10, 22, "fgmres"};
}

fd::ModalKrylovTuningValues empty_modal_krylov_tuning_values()
{
    return fd::ModalKrylovTuningValues{nullptr, nullptr, nullptr, nullptr};
}

void check_modal_krylov_tuning(
    const fd::ModalKrylovTuning &actual,
    const fd::ModalKrylovTuning &expected,
    const char *message)
{
    check(
        actual.eps_prefilter_abs == expected.eps_prefilter_abs &&
            actual.shifted_ksp_rtol == expected.shifted_ksp_rtol &&
            actual.gmres_restart == expected.gmres_restart &&
            actual.shifted_ksp_type != nullptr &&
            expected.shifted_ksp_type != nullptr &&
            std::strcmp(actual.shifted_ksp_type, expected.shifted_ksp_type) == 0,
        message);
}

void ModalKrylovTuningPreservesDefaultsAndK0IgnoresAliases()
{
    fd::ModalKrylovTuning defaults = default_modal_krylov_tuning();
    char default_type[] = "fgmres";
    defaults.shifted_ksp_type = default_type;
    const fd::ModalKrylovTuningValues empty = empty_modal_krylov_tuning_values();
    fd::ModalKrylovTuning resolved{};

    check(
        fd::resolve_modal_krylov_tuning_values(
            defaults,
            empty,
            empty,
            false,
            &resolved),
        "empty modal tuning overrides must preserve defaults");
    check_modal_krylov_tuning(
        resolved,
        default_modal_krylov_tuning(),
        "empty modal tuning overrides changed defaults");
    check(
        resolved.shifted_ksp_type != default_type,
        "resolved KSP type must use stable storage, not the caller token");

    const fd::ModalKrylovTuningValues invalid_legacy{
        "unsupported", "", "9", "cg"};
    check(
        fd::resolve_modal_krylov_tuning_values(
            defaults,
            empty,
            invalid_legacy,
            false,
            &resolved),
        "K0 must ignore legacy Floquet aliases");
    check_modal_krylov_tuning(
        resolved,
        default_modal_krylov_tuning(),
        "ignored K0 aliases changed defaults");
}

void ModalKrylovTuningAcceptsLegacyAliasesOnlyWhenEnabled()
{
    const fd::ModalKrylovTuning defaults = default_modal_krylov_tuning();
    const fd::ModalKrylovTuningValues common = empty_modal_krylov_tuning_values();
    const fd::ModalKrylovTuningValues legacy{
        "1e-8", "1e-9", "10", "fgmres"};
    const fd::ModalKrylovTuning expected{1.0e-8, 1.0e-9, 10, "fgmres"};
    fd::ModalKrylovTuning resolved{};

    check(
        fd::resolve_modal_krylov_tuning_values(
            defaults,
            common,
            legacy,
            true,
            &resolved),
        "legacy Floquet-only values must be accepted when enabled");
    check_modal_krylov_tuning(
        resolved,
        expected,
        "legacy Floquet values did not override defaults");
}

void ModalKrylovTuningAcceptsCommonOverridesAndMatchingAliases()
{
    const fd::ModalKrylovTuning defaults = default_modal_krylov_tuning();
    char common_type[] = "gmres";
    const fd::ModalKrylovTuningValues common{
        "1e-6", "1e-7", "30", common_type};
    const fd::ModalKrylovTuning expected{1.0e-6, 1.0e-7, 30, "gmres"};
    fd::ModalKrylovTuning resolved{};

    check(
        fd::resolve_modal_krylov_tuning_values(
            defaults,
            common,
            empty_modal_krylov_tuning_values(),
            false,
            &resolved),
        "common values must override K0 defaults");
    check_modal_krylov_tuning(
        resolved,
        expected,
        "common values did not override K0 defaults");
    check(
        resolved.shifted_ksp_type != common_type,
        "resolved KSP type must not point into the input token");

    check(
        fd::resolve_modal_krylov_tuning_values(
            defaults,
            common,
            common,
            true,
            &resolved),
        "matching common and legacy tokens must be accepted");
    check_modal_krylov_tuning(
        resolved,
        expected,
        "matching common and legacy tokens changed the tuning");
}

void ModalKrylovTuningRejectsConflictingAliases()
{
    const fd::ModalKrylovTuning defaults = default_modal_krylov_tuning();
    const fd::ModalKrylovTuningValues common{
        "1e-6", nullptr, nullptr, nullptr};
    const fd::ModalKrylovTuningValues legacy{
        "1e-7", nullptr, nullptr, nullptr};
    const fd::ModalKrylovTuning sentinel{1.0e-8, 1.0e-9, 16, "gmres"};
    fd::ModalKrylovTuning resolved = sentinel;

    check(
        !fd::resolve_modal_krylov_tuning_values(
            defaults,
            common,
            legacy,
            true,
            &resolved),
        "conflicting primary and legacy tokens must fail");
    check_modal_krylov_tuning(
        resolved,
        sentinel,
        "a failed tuning resolution must not partially update output");
}

void ModalKrylovTuningRejectsMalformedValuesAndInvalidDefaults()
{
    const fd::ModalKrylovTuning defaults = default_modal_krylov_tuning();
    const fd::ModalKrylovTuningValues empty = empty_modal_krylov_tuning_values();
    const fd::ModalKrylovTuningValues malformed[] = {
        {"", nullptr, nullptr, nullptr},
        {"1e-5", nullptr, nullptr, nullptr},
        {nullptr, "1e-09", nullptr, nullptr},
        {nullptr, nullptr, "14", nullptr},
        {nullptr, nullptr, nullptr, "GMRES"},
    };
    fd::ModalKrylovTuning resolved{};

    for (const fd::ModalKrylovTuningValues &values : malformed) {
        check(
            !fd::resolve_modal_krylov_tuning_values(
                defaults,
                values,
                empty,
                false,
                &resolved),
            "empty or unsupported common tuning token must fail");
    }
    const fd::ModalKrylovTuningValues empty_legacy{
        "", nullptr, nullptr, nullptr};
    check(
        !fd::resolve_modal_krylov_tuning_values(
            defaults,
            empty,
            empty_legacy,
            true,
            &resolved),
        "empty enabled legacy tuning token must fail");
    check(
        !fd::resolve_modal_krylov_tuning_values(
            defaults,
            empty,
            empty,
            false,
            nullptr),
        "null tuning output must fail");

    fd::ModalKrylovTuning invalid_defaults = defaults;
    invalid_defaults.eps_prefilter_abs = 0.0;
    check(
        !fd::resolve_modal_krylov_tuning_values(
            invalid_defaults,
            empty,
            empty,
            false,
            &resolved),
        "non-positive default EPS tolerance must fail");

    invalid_defaults = defaults;
    invalid_defaults.shifted_ksp_rtol =
        std::numeric_limits<double>::infinity();
    check(
        !fd::resolve_modal_krylov_tuning_values(
            invalid_defaults,
            empty,
            empty,
            false,
            &resolved),
        "non-finite default KSP tolerance must fail");

    invalid_defaults = defaults;
    invalid_defaults.gmres_restart = 0;
    check(
        !fd::resolve_modal_krylov_tuning_values(
            invalid_defaults,
            empty,
            empty,
            false,
            &resolved),
        "non-positive default GMRES restart must fail");

    invalid_defaults = defaults;
    invalid_defaults.shifted_ksp_type = "cg";
    check(
        !fd::resolve_modal_krylov_tuning_values(
            invalid_defaults,
            empty,
            empty,
            false,
            &resolved),
        "unsupported default KSP type must fail");
}

} // namespace

int main()
{
    ModalKrylovTuningPreservesDefaultsAndK0IgnoresAliases();
    ModalKrylovTuningAcceptsLegacyAliasesOnlyWhenEnabled();
    ModalKrylovTuningAcceptsCommonOverridesAndMatchingAliases();
    ModalKrylovTuningRejectsConflictingAliases();
    ModalKrylovTuningRejectsMalformedValuesAndInvalidDefaults();
    ModalKspProgressUsesLinearResidualSemanticsAndValidJson();
    SubwindowTerminationFormatterPreservesMeasuredNullableEpsFields();
    EpsDimensionsFormatterPreservesSignedQueriesAndBoundsBuffers();
    CertifiesSchurMatShellAgainstFullCoupledSparseReference();
    PlannerRequiresExplicitCertifiedSchurSelection();
    RejectsInvalidGaugeWeightsBeforeSchurCertification();
    return 0;
}
