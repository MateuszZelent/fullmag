#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepceps.h>
#endif

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

#if FULLMAG_FEM_WITH_SLEPC
struct CancelAfterPolls {
    int poll_count = 0;
    int cancel_on_poll = 3;
};

struct CancelOnceOnPoll {
    int poll_count = 0;
    int cancel_on_poll = 3;
    bool fired = false;
};

int cancel_after_polls(void *raw_context)
{
    if (raw_context == nullptr) {
        return 0;
    }
    auto *context = static_cast<CancelAfterPolls *>(raw_context);
    ++context->poll_count;
    return context->poll_count >= context->cancel_on_poll ? 1 : 0;
}

int cancel_once_on_poll(void *raw_context)
{
    if (raw_context == nullptr) {
        return 0;
    }
    auto *context = static_cast<CancelOnceOnPoll *>(raw_context);
    ++context->poll_count;
    if (!context->fired && context->poll_count == context->cancel_on_poll) {
        context->fired = true;
        return 1;
    }
    return 0;
}
#endif

void cleanup_and_cancellation_gates_fail_closed()
{
    check(fd::detail::floquet_eps_cleanup_allows_refill(true, false),
          "refill is allowed after complete teardown with no live EPS handle");
    check(!fd::detail::floquet_eps_cleanup_allows_refill(false, false),
          "a failed teardown cannot authorize another EPS attempt");
    check(!fd::detail::floquet_eps_cleanup_allows_refill(true, true),
          "a live EPS handle cannot be overwritten by another EPS attempt");
    check(!fd::detail::floquet_eps_cleanup_allows_refill(false, true),
          "a failed teardown with a live EPS handle is terminal");

    check(!fd::detail::floquet_cancellation_is_observed(false, false, false),
          "an unrequested cancellation remains clear");
    check(fd::detail::floquet_cancellation_is_observed(false, false, true),
          "a one-shot cancellation callback is observed when requested");
    check(fd::detail::floquet_cancellation_is_observed(true, false, false),
          "a one-shot post-solve cancellation remains sticky after the callback clears");
    check(fd::detail::floquet_cancellation_is_observed(false, true, false),
          "an EPS stopping-callback cancellation remains observed after solve");
}

int set_action_diagnostic_environment(const char *value)
{
#if defined(_WIN32)
    return _putenv_s("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC", value);
#else
    return setenv("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC", value, 1);
#endif
}

int clear_action_diagnostic_environment()
{
#if defined(_WIN32)
    return _putenv_s("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC", "");
#else
    return unsetenv("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC");
#endif
}

fd::ModalEigenRequest valid_request()
{
    static double k[3] = {1.0, 0.0, 0.0};
    static fd::FrequencyDomainFloquetPeriodicPair pair{};
    static const char diagnostics[] =
        "{\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    static double dynamic[4] = {0.25, 0.0, 0.0, 0.25};
    fd::ModalEigenRequest request{};
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.k_vector_rad_m = k;
    request.operator_request.k_vector_len = 3;
    request.operator_request.operator_diagnostics_json = diagnostics;
    request.operator_request.include_demag = 1;
    request.floquet_periodic_pairs = &pair;
    request.floquet_periodic_pair_count = 1;
    request.dynamic_demag_k_tangent_matrix_row_major = dynamic;
    request.dynamic_demag_k_tangent_matrix_value_count = 4;
    request.execution_target = fd::ModalExecutionTarget::production_cpu;
    return request;
}

fd::SLEPcTinyGyrotropicModalEigenRequest spectral_request()
{
    static double stiffness[4] = {2.0, 0.0, 0.0, 2.0};
    static double gyrotropic[4] = {0.0, -1.0, 1.0, 0.0};
    fd::SLEPcTinyGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = 2;
    request.stiffness_matrix_row_major = stiffness;
    request.gyrotropic_matrix_row_major = gyrotropic;
    request.requested_mode_count = 1;
    return request;
}

fd::SLEPcSparseGyrotropicModalEigenRequest sparse_spectral_request()
{
    static std::uint32_t row_offsets[3] = {0u, 2u, 4u};
    static std::uint32_t column_indices[4] = {0u, 1u, 0u, 1u};
    static double values[4] = {2.0, 0.0, 0.0, 2.0};
    static double gyrotropic_values[4] = {0.0, -1.0, 1.0, 0.0};
    fd::SLEPcSparseGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = 2;
    request.stiffness_csr = {2, 2, row_offsets, 3, column_indices, 4, values, 4};
    request.gyrotropic_csr = {
        2, 2, row_offsets, 3, column_indices, 4, gyrotropic_values, 4};
    request.requested_mode_count = 1;
    return request;
}

void accepts_finite_nonzero_k_cpu_contract()
{
    const fd::FloquetModalSolverAdmission admission =
        fd::admit_floquet_modal_request(valid_request(), spectral_request());
    check(admission.accepted, "valid Floquet modal request is admitted");
    check(admission.nonzero_k, "admission records a nonzero wavevector");
    check(admission.dynamic_demag_k, "admission records dynamic demag-k");
    check(std::strcmp(admission.reason, "accepted_floquet_cpu_slepc") == 0,
          "admission reason is stable");
    check(std::strcmp(fd::floquet_modal_solver_model(), "floquet_real_frequency_slepc") == 0,
          "Floquet solver model is stable");
}

void rejects_missing_dynamic_payload_and_gpu()
{
    fd::ModalEigenRequest request = valid_request();
    request.dynamic_demag_k_tangent_matrix_row_major = nullptr;
    request.dynamic_demag_k_tangent_matrix_value_count = 0;
    auto admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "demag Floquet request without k payload is rejected");
    check(std::strcmp(admission.reason, "floquet_modal_requires_dynamic_demag_k_payload") == 0,
          "missing dynamic demag reason is stable");

    request = valid_request();
    request.execution_target = fd::ModalExecutionTarget::production_gpu;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "CPU Floquet owner rejects forced GPU");
    check(std::strcmp(admission.reason, "floquet_modal_gpu_lane_not_owned_by_cpu_solver") == 0,
          "forced GPU rejection reason is stable");

    const auto result = fd::solve_floquet_modal_spectrum(request, spectral_request());
    check(std::strcmp(result.status, "validation_error") == 0,
          "rejected Floquet request never reaches the spectral adapter");
    check(std::strcmp(result.unsupported_reason,
                      "floquet_modal_gpu_lane_not_owned_by_cpu_solver") == 0,
          "solver propagates the admission reason");

    request = valid_request();
    request.dynamic_demag_k_tangent_matrix_value_count = 3;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "non-square dynamic demag payload is rejected");
    check(std::strcmp(
              admission.reason,
              "floquet_modal_requires_finite_square_dynamic_demag_k_payload") == 0,
          "dynamic demag shape rejection reason is stable");

    static double nan_dynamic[4] = {0.25, 0.0, 0.0, NAN};
    request = valid_request();
    request.dynamic_demag_k_tangent_matrix_row_major = nan_dynamic;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "non-finite dynamic demag payload is rejected");
}

void rejects_zero_k_and_missing_pairs()
{
    fd::ModalEigenRequest request = valid_request();
    static double zero_k[3] = {0.0, 0.0, 0.0};
    request.operator_request.k_vector_rad_m = zero_k;
    auto admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "zero-k request is not admitted by Floquet owner");
    check(std::strcmp(admission.reason, "floquet_modal_requires_finite_nonzero_three_vector") == 0,
          "zero-k rejection reason is stable");

    request = valid_request();
    request.floquet_periodic_pairs = nullptr;
    request.floquet_periodic_pair_count = 0;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "Floquet request without seam pairs is rejected");
    check(std::strcmp(admission.reason, "floquet_modal_requires_periodic_pair_payload") == 0,
          "missing seam-pair rejection reason is stable");
}

void accepts_raw_or_fixed_k_vectors()
{
    const auto set_fixed_vector = [](fd::ModalEigenRequest &request,
                                     double kx,
                                     double ky,
                                     double kz) {
        request.has_floquet_k_vector = true;
        request.floquet_k_vector_rad_per_m[0] = kx;
        request.floquet_k_vector_rad_per_m[1] = ky;
        request.floquet_k_vector_rad_per_m[2] = kz;
    };
    const auto check_both_admissions = [](
        fd::ModalEigenRequest request,
        bool expected,
        const char *expected_reason,
        const char *message) {
        const auto dense_admission =
            fd::admit_floquet_modal_request(request, spectral_request());
        check(dense_admission.accepted == expected &&
                  (expected || std::strcmp(dense_admission.reason, expected_reason) == 0),
              message);

        request.operator_request.include_demag = 0;
        const auto sparse_admission = fd::admit_floquet_modal_sparse_request(
            request, sparse_spectral_request());
        check(sparse_admission.accepted == expected &&
                  (expected || std::strcmp(sparse_admission.reason, expected_reason) == 0),
              message);
    };

    fd::ModalEigenRequest null_raw_with_length = valid_request();
    null_raw_with_length.operator_request.k_vector_rad_m = nullptr;
    null_raw_with_length.operator_request.k_vector_len = 3;
    set_fixed_vector(null_raw_with_length, 1.0, 0.0, 0.0);
    check_both_admissions(
        null_raw_with_length,
        true,
        nullptr,
        "a null raw pointer selects the valid fixed vector even with a positive raw length");

    const double ignored_raw = std::numeric_limits<double>::quiet_NaN();
    const int empty_raw_lengths[] = {0, -1};
    for (const int raw_length : empty_raw_lengths) {
        fd::ModalEigenRequest empty_raw_with_fixed = valid_request();
        empty_raw_with_fixed.operator_request.k_vector_rad_m = &ignored_raw;
        empty_raw_with_fixed.operator_request.k_vector_len = raw_length;
        set_fixed_vector(empty_raw_with_fixed, 2.0, 0.0, 0.0);
        check_both_admissions(
            empty_raw_with_fixed,
            true,
            nullptr,
            "a nonpositive raw length selects the fixed vector without reading raw storage");
    }

    fd::ModalEigenRequest raw_vector_wins = valid_request();
    set_fixed_vector(raw_vector_wins, 0.0, 0.0, 0.0);
    check_both_admissions(
        raw_vector_wins,
        true,
        nullptr,
        "a selected raw vector takes precedence over the unused fixed fallback");

    fd::ModalEigenRequest invalid_raw_with_fixed = valid_request();
    static double short_raw_vector[2] = {1.0, 0.0};
    invalid_raw_with_fixed.operator_request.k_vector_rad_m = short_raw_vector;
    invalid_raw_with_fixed.operator_request.k_vector_len = 2;
    set_fixed_vector(invalid_raw_with_fixed, 2.0, 0.0, 0.0);
    check_both_admissions(
        invalid_raw_with_fixed,
        false,
        "floquet_modal_k_vector_payload_mismatch",
        "a malformed selected raw vector cannot be masked by a valid fixed fallback");

    fd::ModalEigenRequest invalid_fixed_fallback = valid_request();
    invalid_fixed_fallback.operator_request.k_vector_rad_m = nullptr;
    invalid_fixed_fallback.operator_request.k_vector_len = 0;
    set_fixed_vector(
        invalid_fixed_fallback,
        std::numeric_limits<double>::quiet_NaN(),
        0.0,
        0.0);
    check_both_admissions(
        invalid_fixed_fallback,
        false,
        "floquet_modal_requires_finite_nonzero_three_vector",
        "a selected non-finite fixed fallback is still rejected");

    fd::ModalEigenRequest no_vector = valid_request();
    no_vector.operator_request.k_vector_rad_m = nullptr;
    no_vector.operator_request.k_vector_len = 0;
    check_both_admissions(
        no_vector,
        false,
        "floquet_modal_requires_finite_nonzero_three_vector",
        "a request with neither a raw vector nor a declared fixed fallback is rejected");
}

void rejects_invalid_frequency_windows()
{
    fd::ModalEigenRequest request = valid_request();
    auto spectral = spectral_request();
    spectral.frequency_min_hz = 2.0;
    spectral.frequency_max_hz = 1.0;
    auto admission = fd::admit_floquet_modal_request(request, spectral);
    check(!admission.accepted, "reversed Floquet frequency window is rejected");
    check(std::strcmp(admission.reason,
                      "floquet_modal_requires_valid_frequency_window") == 0,
          "invalid frequency window reason is stable");

    spectral = spectral_request();
    spectral.frequency_min_hz = -1.0;
    spectral.frequency_max_hz = 1.0;
    admission = fd::admit_floquet_modal_request(request, spectral);
    check(!admission.accepted, "negative Floquet frequency window is rejected");

    spectral = spectral_request();
    spectral.frequency_min_hz = 1.0;
    spectral.frequency_max_hz = 2.0;
    admission = fd::admit_floquet_modal_request(request, spectral);
    check(admission.accepted, "finite positive Floquet frequency window is admitted");
    check(admission.frequency_window, "admission records a selected frequency window");
}

void admits_sparse_bloch_operator_without_demag()
{
    fd::ModalEigenRequest request = valid_request();
    request.operator_request.include_demag = 0;
    request.mfem_sparse_operator_enabled = 1;
    const auto admission = fd::admit_floquet_modal_sparse_request(
        request, sparse_spectral_request());
    check(admission.accepted, "sparse Floquet operator is admitted without demag");
    check(!admission.dynamic_demag_k, "sparse no-demag route has no demag-k term");
    check(std::strcmp(admission.reason, "accepted_floquet_cpu_sparse_slepc") == 0,
          "sparse admission reason is stable");

    request.operator_request.include_demag = 1;
    const auto demag_admission = fd::admit_floquet_modal_sparse_request(
        request, sparse_spectral_request());
    check(!demag_admission.accepted,
          "sparse Floquet owner rejects a dynamic demag request");
    check(std::strcmp(
              demag_admission.reason,
              "floquet_sparse_modal_requires_shared_domain_sparse_owner") == 0,
          "sparse dynamic demag rejection reason is stable");
}

fd::PoissonAirboxSharedDomainComplexCsrMatrix diagonal_complex_csr(
    std::size_t dimension,
    const std::vector<std::complex<double>> &diagonal)
{
    check(dimension == diagonal.size(), "diagonal fixture has matching dimensions");
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = dimension;
    matrix.column_count = dimension;
    matrix.row_offsets.reserve(dimension + 1u);
    matrix.column_indices.reserve(dimension);
    matrix.values.reserve(dimension);
    matrix.row_offsets.push_back(0u);
    for (std::size_t row = 0u; row < dimension; ++row) {
        matrix.column_indices.push_back(static_cast<std::uint32_t>(row));
        matrix.values.push_back(diagonal[row]);
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
    }
    return matrix;
}

#if FULLMAG_FEM_WITH_SLEPC
fd::PoissonAirboxSharedDomainComplexCsrMatrix correlated_mass_csr(
    std::size_t dimension,
    std::size_t correlated_prefix,
    double correlation)
{
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = dimension;
    matrix.column_count = dimension;
    matrix.row_offsets.reserve(dimension + 1u);
    matrix.row_offsets.push_back(0u);
    for (std::size_t row = 0u; row < dimension; ++row) {
        for (std::size_t column = 0u; column < dimension; ++column) {
            const double value = row == column
                ? 1.0
                : (row < correlated_prefix && column < correlated_prefix
                    ? correlation : 0.0);
            if (value != 0.0) {
                matrix.column_indices.push_back(
                    static_cast<std::uint32_t>(column));
                matrix.values.emplace_back(value, 0.0);
            }
        }
        matrix.row_offsets.push_back(
            static_cast<std::uint32_t>(matrix.values.size()));
    }
    return matrix;
}
#endif

fd::PoissonAirboxSharedDomainComplexCsrMatrix q_to_phi_complex_csr(
    std::size_t q_dimension,
    std::complex<double> coupling)
{
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = q_dimension;
    matrix.column_count = 1u;
    matrix.row_offsets.reserve(q_dimension + 1u);
    matrix.row_offsets.push_back(0u);
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        if (row == 0u) {
            matrix.column_indices.push_back(0u);
            matrix.values.push_back(coupling);
        }
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
    }
    return matrix;
}

fd::PoissonAirboxSharedDomainComplexCsrMatrix phi_to_q_complex_csr(
    std::size_t q_dimension,
    std::complex<double> coupling)
{
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = 1u;
    matrix.column_count = q_dimension;
    matrix.row_offsets = {0u, 1u};
    matrix.column_indices = {0u};
    matrix.values = {coupling};
    return matrix;
}

std::vector<std::complex<double>> complex_csr_matvec_for_test(
    const fd::PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    const std::vector<std::complex<double>> &vector)
{
    check(matrix.column_count == vector.size(), "fixture CSR matvec dimensions match");
    std::vector<std::complex<double>> result(
        static_cast<std::size_t>(matrix.row_count), std::complex<double>{});
    for (std::uint64_t row = 0u; row < matrix.row_count; ++row) {
        for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
             entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            result[static_cast<std::size_t>(row)] +=
                matrix.values[entry] *
                vector[static_cast<std::size_t>(matrix.column_indices[entry])];
        }
    }
    return result;
}

double complex_norm_for_test(const std::vector<std::complex<double>> &vector)
{
    long double sum = 0.0L;
    for (const auto value : vector) {
        sum += static_cast<long double>(std::norm(value));
    }
    return std::sqrt(static_cast<double>(sum));
}

void admits_certified_shared_domain_sparse_operator()
{
    const auto a_qq = diagonal_complex_csr(2u, {2.0, 3.0});
    const auto b_qq = diagonal_complex_csr(2u, {1.0, 1.0});
    const auto positive_tangent_mass = diagonal_complex_csr(2u, {1.0, 1.0});
    const auto p = diagonal_complex_csr(1u, {1.0});
    const auto a_qphi = q_to_phi_complex_csr(2u, 0.25);
    const auto a_phiq = phi_to_q_complex_csr(2u, 0.25);
    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.positive_tangent_mass = &positive_tangent_mass;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = 2u;
    operator_view.phi_dof_count = 1u;

    fd::ModalEigenRequest request = valid_request();
    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"certified_shared_domain\"}";
    request.dynamic_demag_k_tangent_matrix_row_major = nullptr;
    request.dynamic_demag_k_tangent_matrix_value_count = 0u;
    request.floquet_shared_domain_operator = &operator_view;
    auto spectral = sparse_spectral_request();
    spectral.floquet_shared_domain_operator = &operator_view;

    auto admission = fd::admit_floquet_modal_sparse_request(request, spectral);
    check(admission.accepted,
          "certified shared-domain Floquet operator reaches sparse SLEPc admission");
    check(admission.dynamic_demag_k,
          "shared-domain Floquet admission retains dynamic demag-k");

    auto invalid_metric_operator = operator_view;
    invalid_metric_operator.positive_tangent_mass = nullptr;
    auto invalid_metric_spectral = spectral;
    invalid_metric_spectral.floquet_shared_domain_operator =
        &invalid_metric_operator;
    admission = fd::admit_floquet_modal_sparse_request(
        request, invalid_metric_spectral);
    check(!admission.accepted &&
              std::strcmp(
                  admission.reason,
                  "floquet_shared_domain_positive_tangent_mass_missing") == 0,
          "shared-domain Floquet rejects a missing positive tangent mass");

    const auto wrong_shape_mass = diagonal_complex_csr(1u, {1.0});
    invalid_metric_operator = operator_view;
    invalid_metric_operator.positive_tangent_mass = &wrong_shape_mass;
    invalid_metric_spectral.floquet_shared_domain_operator =
        &invalid_metric_operator;
    admission = fd::admit_floquet_modal_sparse_request(
        request, invalid_metric_spectral);
    check(!admission.accepted &&
              std::strcmp(
                  admission.reason,
                  "floquet_shared_domain_positive_tangent_mass_dimension_mismatch") == 0,
          "shared-domain Floquet rejects a positive tangent mass with the wrong shape");

    fd::PoissonAirboxSharedDomainComplexCsrMatrix nonhermitian_mass{};
    nonhermitian_mass.row_count = 2u;
    nonhermitian_mass.column_count = 2u;
    nonhermitian_mass.row_offsets = {0u, 2u, 3u};
    nonhermitian_mass.column_indices = {0u, 1u, 1u};
    nonhermitian_mass.values = {{1.0, 0.0}, {0.25, 0.0}, {1.0, 0.0}};
    invalid_metric_operator = operator_view;
    invalid_metric_operator.positive_tangent_mass = &nonhermitian_mass;
    invalid_metric_spectral.floquet_shared_domain_operator =
        &invalid_metric_operator;
    admission = fd::admit_floquet_modal_sparse_request(
        request, invalid_metric_spectral);
    check(!admission.accepted &&
              std::strcmp(
                  admission.reason,
                  "floquet_shared_domain_positive_tangent_mass_not_hermitian") == 0,
          "shared-domain Floquet rejects a non-Hermitian positive tangent mass");

    const auto nonfinite_mass = diagonal_complex_csr(
        2u,
        {std::complex<double>(std::numeric_limits<double>::quiet_NaN(), 0.0),
         std::complex<double>(1.0, 0.0)});
    invalid_metric_operator = operator_view;
    invalid_metric_operator.positive_tangent_mass = &nonfinite_mass;
    invalid_metric_spectral.floquet_shared_domain_operator =
        &invalid_metric_operator;
    admission = fd::admit_floquet_modal_sparse_request(
        request, invalid_metric_spectral);
    check(!admission.accepted &&
              std::strcmp(
                  admission.reason,
                  "floquet_shared_domain_positive_tangent_mass_csr_is_invalid") == 0,
          "shared-domain Floquet rejects a non-finite positive tangent mass CSR");

    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    admission = fd::admit_floquet_modal_sparse_request(request, spectral);
    check(!admission.accepted,
          "shared-domain owner rejects a mismatched dense operator marker");

    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"certified_shared_domain\"}";
    request.floquet_shared_domain_operator = nullptr;
    admission = fd::admit_floquet_modal_sparse_request(request, spectral);
    check(!admission.accepted,
          "shared-domain marker without its operator payload is rejected");
}

void reports_opt_in_action_diagnostic_unavailable_before_setup()
{
    const char *previous_action_diagnostic =
        std::getenv("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC");
    const bool had_previous_action_diagnostic = previous_action_diagnostic != nullptr;
    const std::string previous_action_diagnostic_value =
        had_previous_action_diagnostic ? previous_action_diagnostic : "";
    check(set_action_diagnostic_environment("1") == 0,
          "action-only diagnostic opt-in can be enabled for early failure regression");

    // The invalid shared-domain view returns before PETSc/SLEPc setup. The
    // result must still report an active but unavailable probe so the
    // production serializer cannot confuse this path with disabled=null.
    fd::FloquetSharedDomainSparseModalOperator invalid_operator{};
    const auto result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        invalid_operator, sparse_spectral_request());

    if (had_previous_action_diagnostic) {
        check(set_action_diagnostic_environment(
                  previous_action_diagnostic_value.c_str()) == 0,
              "action-only diagnostic environment is restored after early failure regression");
    } else {
        check(clear_action_diagnostic_environment() == 0,
              "action-only diagnostic environment is cleared after early failure regression");
    }

    const auto &diagnostic = result.floquet_schur_action_diagnostic;
    check(diagnostic.requested && !diagnostic.available &&
              std::strcmp(diagnostic.status, "unavailable") == 0 &&
              std::strcmp(
                  diagnostic.reason,
                  "diagnostic_not_reached_before_solver_setup_failure") == 0,
          "opt-in action diagnostic reports unavailable before shared-domain setup");
    check(diagnostic.action_count == 0 &&
              std::isnan(diagnostic.operator_normalization_scale) &&
              std::isnan(diagnostic.preconditioner_normalization_scale) &&
              std::isnan(diagnostic.max_potential_relative_residual) &&
              std::isnan(diagnostic.max_repeatability_relative_defect) &&
              std::isnan(diagnostic.additivity_relative_defect) &&
              std::isnan(diagnostic.mat_shell_reconstruction_relative_defect),
          "unavailable action diagnostic keeps all measurement scalars unset for JSON null");
}

void executes_native_sparse_matshell_above_dense_bound(bool force_inner_failure = false)
{
    constexpr std::size_t q_dimension = 514u;
    // Keep the synthetic fixture well away from exact zero; the 1 MHz
    // frequency makes shifted selection deterministic without encoding a
    // default zero-frequency threshold into this numerical fixture.
    constexpr double expected_frequency_hz = 1.0e6;
    // Keep the shift off the exact synthetic eigenvalue.  STSINVERT factors
    // (A - sigma B), which is singular when sigma equals the fixture's mode;
    // 100 Hz remains closer to row 0 than the 400 Hz row spacing and therefore
    // keeps mode selection deterministic while exercising the shifted solve.
    constexpr double target_frequency_hz = 1.0001e6;
    const double expected_omega = fd::omega_rad_s_from_frequency_hz(expected_frequency_hz);
    const std::complex<double> q_phi_coupling(force_inner_failure ? 1000.0 : 0.25, 0.0);
    const std::complex<double> phi_q_coupling(force_inner_failure ? 1000.0 : 0.25, 0.0);

    // a_qq models the Hermitian magnetic-Hessian block (K + D), which has a
    // REAL diagonal in production (see FIX H3's rotated_a_qq zero-diagonal
    // analysis).  The imaginary "rotate to a real target frequency" factor
    // therefore lives on b_qq's diagonal here instead of a_qq's: for a
    // decoupled diagonal row, (-i*phase_sign*A_eff)/b = mu, and choosing
    // b = -i makes mu = phase_sign*A_eff and lambda_imag = A_eff directly
    // (independent of phase_sign, since phase_sign^2 == 1), so a REAL
    // a_diagonal reproduces exactly the same expected eigenvalues as the
    // previous purely-imaginary construction did.
    std::vector<std::complex<double>> a_diagonal(q_dimension);
    std::vector<std::complex<double>> b_diagonal(
        q_dimension, std::complex<double>(0.0, -1.0));
    a_diagonal[0u] = q_phi_coupling * phi_q_coupling +
        std::complex<double>(expected_omega, 0.0);
    for (std::size_t row = 1u; row < q_dimension; ++row) {
        a_diagonal[row] = std::complex<double>(
            fd::omega_rad_s_from_frequency_hz(
                expected_frequency_hz + 400.0 * static_cast<double>(row)),
            0.0);
    }

    const auto a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
    const auto b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
    const auto positive_tangent_mass = diagonal_complex_csr(
        q_dimension,
        std::vector<std::complex<double>>(
            q_dimension, std::complex<double>(1.0, 0.0)));
    const auto p = diagonal_complex_csr(1u, {std::complex<double>(1.0, 0.0)});
    const auto a_qphi = q_to_phi_complex_csr(q_dimension, q_phi_coupling);
    const auto a_phiq = phi_to_q_complex_csr(q_dimension, phi_q_coupling);

    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.positive_tangent_mass = &positive_tangent_mass;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = q_dimension;
    operator_view.phi_dof_count = 1u;
    operator_view.boundary_kind = "robin";
    operator_view.gauge_policy = "nonzero_k_invertible_poisson";

    fd::SLEPcSparseGyrotropicModalEigenRequest spectral{};
    spectral.tangent_dof_count = static_cast<int>(q_dimension);
    spectral.requested_mode_count = 1;
    spectral.target_frequency_hz = target_frequency_hz;
    spectral.residual_tolerance = 1.0e-8;
    spectral.max_outer_iterations = 160;
    spectral.max_linear_iterations = force_inner_failure ? 1 : 96;

    const char *previous_action_diagnostic =
        std::getenv("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC");
    const bool had_previous_action_diagnostic = previous_action_diagnostic != nullptr;
    const std::string previous_action_diagnostic_value =
        had_previous_action_diagnostic ? previous_action_diagnostic : "";
    check(set_action_diagnostic_environment("1") == 0,
          "action-only diagnostic opt-in can be enabled for the prepared native regression");
    const auto result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, spectral);
    if (had_previous_action_diagnostic) {
        check(set_action_diagnostic_environment(
                  previous_action_diagnostic_value.c_str()) == 0,
              "action-only diagnostic environment is restored after the prepared regression");
    } else {
        check(clear_action_diagnostic_environment() == 0,
              "action-only diagnostic environment is cleared after the prepared regression");
    }
#if FULLMAG_FEM_WITH_SLEPC
    check(result.floquet_schur_action_diagnostic.requested,
          "native regression records that the action-only diagnostic was requested");
    check(result.floquet_schur_action_diagnostic.pre_eps_only &&
              !result.floquet_schur_action_diagnostic.dense_materialization &&
              std::strcmp(
                  result.floquet_schur_action_diagnostic.workspace_scope,
                  "isolated_clone_of_production_context") == 0 &&
              result.floquet_schur_action_diagnostic.expected_action_count == 9 &&
              result.floquet_schur_action_diagnostic.action_count <= 9,
          "action-only diagnostic is bounded, pre-EPS, and does not materialize a dense operator");
    if (force_inner_failure) {
        check(!result.ok && result.accepted_modes.empty(),
              "inner KSP failure must remain fail-closed");
        check(!result.ksp_diagnostics_available &&
                  !result.ksp_converged_reason_available &&
                  !result.ksp_last_true_residual_available,
              "hard EPS error leaves final KSP queries and postsolve true residual unavailable");
        check(result.ksp_monitor_registered &&
                  result.ksp_monitor_observation_count > 0 &&
                  result.ksp_monitor_last_iteration_available &&
                  result.ksp_monitor_last_iteration > 0 &&
                  result.ksp_monitor_recursive_residual_available &&
                  std::isfinite(result.ksp_monitor_recursive_residual_norm) &&
                  result.ksp_monitor_last_reason_available,
              "hard EPS error retains the in-solve recursive residual and observed reason without promoting them to final diagnostics");
        check(std::strcmp(result.floquet_schur_action_diagnostic.status, "disabled") != 0,
              "pre-EPS action diagnostic remains observable on the hard EPS failure path");
        return;
    }
    check(result.ksp_monitor_registered &&
              result.ksp_monitor_observation_count > 0 &&
              result.ksp_monitor_last_iteration_available &&
              result.ksp_monitor_recursive_residual_available &&
              result.ksp_monitor_last_reason_available,
          "successful solve retains the distinct shifted-KSP monitor observation");
    check(result.floquet_schur_action_diagnostic.available &&
              std::strcmp(result.floquet_schur_action_diagnostic.status, "measured") == 0 &&
              result.floquet_schur_action_diagnostic.action_count == 9 &&
              std::isfinite(
                  result.floquet_schur_action_diagnostic.homogeneity_tiny_relative_defect) &&
              std::isfinite(
                  result.floquet_schur_action_diagnostic.mat_shell_reconstruction_relative_defect),
          "native regression measures the bounded action-only probe and MatShell callback before EPS");
#endif
    check(result.execution_policy != nullptr &&
              std::strcmp(result.execution_policy, "petsc_sequential_cpu") == 0,
          "native Floquet result exposes the sequential PETSc policy");
    check(result.execution_scope != nullptr &&
              std::strcmp(result.execution_scope, "single_process_shared_memory") == 0,
          "native Floquet result exposes its single-process execution scope");
    check(result.communicator != nullptr &&
              std::strcmp(result.communicator, "PETSC_COMM_SELF") == 0,
          "native Floquet result exposes the PETSc communicator");
    check(result.scalability_scope != nullptr &&
              std::strcmp(result.scalability_scope, "single_process_only") == 0,
          "native Floquet result does not claim distributed scalability");
    check(result.poisson_ksp_type != nullptr &&
              std::strcmp(result.poisson_ksp_type, "preonly") == 0 &&
              result.poisson_pc_type != nullptr &&
              std::strcmp(result.poisson_pc_type, "lu") == 0,
          "native Floquet result exposes the Poisson LU policy");
    check(result.poisson_factorization_shift_policy != nullptr &&
              std::strcmp(
                  result.poisson_factorization_shift_policy,
                  "MAT_SHIFT_NONE") == 0,
          "native Floquet Poisson inversion preserves the original operator");
    check(result.poisson_iteration_semantics != nullptr &&
              std::strcmp(
                  result.poisson_iteration_semantics,
                  "preonly_factorization_no_iterative_convergence") == 0,
          "native Floquet result distinguishes Poisson factorization from iteration");
    check(result.ksp_type != nullptr &&
              std::strcmp(result.ksp_type, "gmres") == 0 &&
              result.pc_type != nullptr &&
              std::strcmp(result.pc_type, "lu") == 0 &&
              result.factorization_package != nullptr &&
              std::strcmp(result.factorization_package, "petsc_default_lu") == 0,
          "native Floquet result exposes the shifted GMRES/LU policy");
#if FULLMAG_FEM_WITH_SLEPC
    check(result.ksp_restart == 8 &&
              std::abs(result.ksp_breakdown_tolerance - 2.0) <=
                  std::numeric_limits<double>::epsilon(),
          "native Floquet result exposes the bounded GMRES restart and residual replacement policy");
    check(result.factorization_shift_policy != nullptr &&
              std::strstr(result.factorization_shift_policy,
                          "magnetic_only_") ==
                  result.factorization_shift_policy,
          "large native Floquet systems retain the bounded magnetic-only preconditioner");
    check(result.ok, result.unsupported_reason);
    check(result.accepted_mode_count == 1,
          "native Floquet MatShell regression accepts one requested mode");
    check(result.solver_adapter != nullptr &&
              std::strcmp(result.solver_adapter, "floquet_airbox_cpu_schur_slepc") == 0,
          "native Floquet MatShell regression reports its native adapter");
    const fd::SLEPcModalAcceptedMode &mode = result.accepted_modes.front();
    check(mode.floquet_mode_vector_physical_complex,
          "native Floquet mode exposes a physical complex q vector");
    check(mode.mode_vector.size() == q_dimension,
          "native Floquet physical q vector has the original complex dimension");
    check(mode.floquet_potential_real_split.size() == 1u,
          "native Floquet mode exposes the physical scalar potential");
    check(std::abs(mode.frequency_hz - expected_frequency_hz) < 1.0e-4,
          "native Floquet mode uses the analytical frequency after rotation");
    check(std::abs(mode.lambda_real) < 1.0e-6 &&
              std::abs(mode.lambda_imag - expected_omega) < 1.0e-3,
          "native Floquet mode restores the canonical lambda=i*omega convention");
    check(!mode.floquet_descriptor_certified,
          "native reduced blocks do not claim full descriptor certification");
    check(std::abs(mode.floquet_potential_real_split[0]) > 1.0e-6,
          "native Floquet scalar potential remains nonzero under coupling");

    const auto a_q_q = complex_csr_matvec_for_test(a_qq, mode.mode_vector);
    const auto a_q_phi = complex_csr_matvec_for_test(
        a_qphi, mode.floquet_potential_real_split);
    const auto b_q = complex_csr_matvec_for_test(b_qq, mode.mode_vector);
    const auto p_phi = complex_csr_matvec_for_test(
        p, mode.floquet_potential_real_split);
    const auto a_phi_q = complex_csr_matvec_for_test(a_phiq, mode.mode_vector);
    std::vector<std::complex<double>> magnetic_residual(q_dimension);
    for (std::size_t index = 0u; index < q_dimension; ++index) {
        magnetic_residual[index] = a_q_q[index] + a_q_phi[index] -
            std::complex<double>(0.0, mode.lambda_imag) * b_q[index];
    }
    const double magnetic_denominator = complex_norm_for_test(a_q_q) +
        complex_norm_for_test(a_q_phi) +
        std::abs(mode.lambda_imag) * complex_norm_for_test(b_q);
    const double magnetic_relative_residual =
        complex_norm_for_test(magnetic_residual) /
        (magnetic_denominator + std::numeric_limits<double>::min());
    check(magnetic_relative_residual < 1.0e-7,
          "native Floquet physical q/phi satisfies the original magnetic block");
    std::vector<std::complex<double>> potential_residual(1u);
    potential_residual[0u] = p_phi[0u] + a_phi_q[0u];
    check(complex_norm_for_test(potential_residual) < 1.0e-7,
          "native Floquet physical q/phi satisfies the original Poisson block");
#else
    check(!result.ok, "native Floquet endpoint stays unavailable without SLEPc");
    check(result.status != nullptr && std::strcmp(result.status, "unavailable") == 0,
          "native Floquet endpoint reports unavailable without SLEPc");
    check(result.unsupported_reason != nullptr &&
              std::strcmp(result.unsupported_reason, "slepc_not_available") == 0,
          "native Floquet endpoint reports the SLEPc capability failure");
#endif
}

void finalizes_certified_candidates_by_tangent_mass_before_nearest_cap()
{
    constexpr std::size_t q_dimension = 4u;
    constexpr double base_frequency_hz = 1.0e6;
    const fd::PoissonAirboxSharedDomainComplexCsrMatrix positive_tangent_mass{
        4u,
        4u,
        {0u, 2u, 4u, 5u, 6u},
        {0u, 1u, 0u, 1u, 2u, 3u},
        {{1.0, 0.0}, {0.99, 0.0}, {0.99, 0.0},
         {1.0, 0.0}, {1.0, 0.0}, {1.0, 0.0}},
    };

    const auto make_candidate = [q_dimension](
        int eigenpair_index,
        double frequency_hz,
        double target_distance,
        double residual,
        std::complex<double> amplitude,
        std::size_t component) {
        fd::detail::CertifiedFloquetModalCandidate candidate{};
        candidate.mode.floquet_descriptor_certified = true;
        candidate.mode.floquet_seam_frame_certified = true;
        candidate.mode.floquet_gauge_policy_satisfied = true;
        candidate.mode.floquet_mode_vector_physical_complex = true;
        candidate.mode.floquet_magnetic_residual = residual;
        candidate.mode.floquet_potential_residual = residual * 2.0;
        candidate.mode.floquet_potential_real_split = {
            std::complex<double>(static_cast<double>(eigenpair_index), 0.5)};
        candidate.mode.eigenpair_index = eigenpair_index;
        candidate.mode.lambda_real = -static_cast<double>(eigenpair_index);
        candidate.mode.lambda_imag = static_cast<double>(eigenpair_index) * 3.0;
        candidate.mode.frequency_hz = frequency_hz;
        candidate.mode.relative_residual = residual;
        candidate.mode.mode_vector.assign(q_dimension, std::complex<double>{});
        candidate.mode.mode_vector[component] = amplitude;
        candidate.target_distance = target_distance;
        return candidate;
    };

    std::vector<fd::detail::CertifiedFloquetModalCandidate> certified_candidates;
    certified_candidates.push_back(make_candidate(
        101, base_frequency_hz, 0.0005, 1.0e-6, {2.0, 0.5}, 0u));
    certified_candidates.push_back(make_candidate(
        202, base_frequency_hz + 0.001, 0.0005, 2.0e-6, {5.0, -1.0}, 1u));
    certified_candidates.push_back(make_candidate(
        303, base_frequency_hz + 0.002, 0.0015, 3.0e-6, {7.0, 0.25}, 2u));
    certified_candidates.push_back(make_candidate(
        404, base_frequency_hz + 400.0, 399.9995, 4.0e-6, {11.0, 0.0}, 3u));

    const auto finalization = fd::detail::finalize_certified_floquet_candidates(
        certified_candidates,
        q_dimension,
        &positive_tangent_mass,
        2u);
    check(finalization.success && finalization.failure_reason == nullptr,
          "certified candidate finalizer accepts a valid positive tangent mass");
    check(finalization.accepted_candidates.size() == 2u,
          "mass deduplication precedes the requested nearest-mode publication cap");

    const auto &first = finalization.accepted_candidates[0].mode;
    const auto &second = finalization.accepted_candidates[1].mode;
    check(first.eigenpair_index == 101 && second.eigenpair_index == 303,
          "mass overlap collapses the duplicate cluster, preserves the mass-orthogonal mode, and caps out the farther mode");
    check(first.mode_vector[0] == std::complex<double>(2.0, 0.5) &&
              second.mode_vector[2] == std::complex<double>(7.0, 0.25) &&
              first.mode_vector[1] == std::complex<double>{} &&
              second.mode_vector[0] == std::complex<double>{},
          "comparison normalization does not alter original candidate amplitudes or vectors");
    check(first.floquet_potential_real_split[0] ==
                  std::complex<double>(101.0, 0.5) &&
              second.floquet_potential_real_split[0] ==
                  std::complex<double>(303.0, 0.5) &&
              first.floquet_magnetic_residual == 1.0e-6 &&
              second.floquet_magnetic_residual == 3.0e-6 &&
              first.floquet_descriptor_certified &&
              second.floquet_seam_frame_certified &&
              first.lambda_real == -101.0 && second.lambda_imag == 909.0,
          "finalization preserves each source mode's phi, certificates, residuals, and eigenpair provenance");
    check(first.positive_frequency_pair_index == 0 &&
              second.positive_frequency_pair_index == 1 &&
              first.frequency_hz < second.frequency_hz,
          "survivors receive local indices after nearest selection and frequency ordering");

    const auto missing_metric = fd::detail::finalize_certified_floquet_candidates(
        certified_candidates, q_dimension, nullptr, 2u);
    check(!missing_metric.success &&
              std::strcmp(
                  missing_metric.failure_reason,
                  "floquet_shared_domain_positive_tangent_mass_missing") == 0,
          "finalizer fails closed when the positive tangent mass is missing");
}

void normalizes_si_scale_floquet_pencil()
{
#if FULLMAG_FEM_WITH_SLEPC
    constexpr std::size_t q_dimension = 8u;
    constexpr double coefficient_scale = 1.0e-60;
    constexpr double frequency_hz = 1.0e6;
    std::vector<std::complex<double>> a_diagonal(q_dimension);
    std::vector<std::complex<double>> b_diagonal(
        q_dimension, std::complex<double>(0.0, -coefficient_scale));
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        a_diagonal[row] = coefficient_scale * fd::omega_rad_s_from_frequency_hz(
            frequency_hz + 2.0e5 * static_cast<double>(row));
    }
    const auto a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
    const auto b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
    const auto positive_tangent_mass = diagonal_complex_csr(
        q_dimension,
        std::vector<std::complex<double>>(
            q_dimension, std::complex<double>(1.0, 0.0)));
    const auto p = diagonal_complex_csr(1u, {1.0});
    const auto a_qphi = q_to_phi_complex_csr(q_dimension, 0.0);
    const auto a_phiq = phi_to_q_complex_csr(q_dimension, 0.0);
    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.positive_tangent_mass = &positive_tangent_mass;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = q_dimension;
    operator_view.phi_dof_count = 1u;

    fd::SLEPcSparseGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = static_cast<int>(q_dimension);
    request.requested_mode_count = 1;
    request.target_frequency_hz = frequency_hz + 1.0e4;
    request.frequency_min_hz = 0.9 * frequency_hz;
    request.frequency_max_hz = 1.1 * frequency_hz;
    request.residual_tolerance = 1.0e-8;
    request.max_outer_iterations = 160;
    request.max_linear_iterations = 96;
    const auto result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, request);
    check(result.operator_normalization_scale > 1.0e40,
          "SI-scale generalized Floquet pencil is normalized before sparse LU");
    check(std::isfinite(result.preconditioner_normalization_scale) &&
              result.preconditioner_normalization_scale > 0.0,
          "shifted preconditioner reports a finite positive normalization");
    check(result.factorization_shift_policy != nullptr &&
              std::strstr(result.factorization_shift_policy,
                          "exact_schur_materialized_") ==
                  result.factorization_shift_policy,
          "small native Floquet systems precondition with the materialized exact Schur action");
    check(std::isfinite(result.factorization_shift_amount) &&
              result.factorization_shift_amount > 0.0,
          "preconditioner LU reports its resolved positive shift amount");
    check(result.ok, result.unsupported_reason);
    check(std::abs(result.frequency_hz - frequency_hz) < 1.0e-2,
          "pencil scaling preserves the physical eigenfrequency");
    check(result.positive_frequency_candidate_count > 0 &&
              result.frequency_window_candidate_count > 0,
          "native Floquet diagnostics count positive candidates in the target window");
    check(result.residual_evaluation_candidate_count > 0,
          "native Floquet diagnostics report evaluated residual candidates");
    check(std::isfinite(result.max_candidate_relative_residual) &&
              std::isfinite(result.max_eps_normalized_absolute_residual) &&
              std::isfinite(result.max_floquet_magnetic_relative_residual) &&
              std::isfinite(result.max_floquet_potential_relative_residual),
          "native Floquet diagnostics expose finite residual components");
    check(result.ksp_diagnostics_available &&
              result.ksp_converged_reason_available &&
              result.ksp_converged_reason > 0 &&
              result.linear_iterations_total > 0 &&
              result.ksp_last_iterations > 0 &&
              std::isfinite(result.ksp_final_residual),
          "Floquet diagnostics report the inner shift-invert KSP work and stop reason");
    check(result.shifted_ksp_configuration_before_eps_available &&
              result.shifted_ksp_pc_side_before_eps == static_cast<int>(PC_RIGHT) &&
              result.shifted_ksp_norm_type_before_eps ==
                  static_cast<int>(KSP_NORM_UNPRECONDITIONED),
          "Floquet diagnostics capture configured KSP settings before EPS independently of last-solve telemetry");
    check(result.ksp_last_true_residual_available &&
              std::isfinite(result.ksp_last_rhs_norm) &&
              result.ksp_last_rhs_norm > 0.0 &&
              std::isfinite(result.ksp_last_true_residual_norm) &&
              std::isfinite(result.ksp_last_true_relative_residual) &&
              result.ksp_last_true_relative_residual < 1.0e-8 &&
              result.ksp_true_residual_sample_count > 0 &&
              result.ksp_true_residual_measurement_failure_count == 0 &&
              std::isfinite(result.ksp_max_true_relative_residual) &&
              result.ksp_max_true_relative_residual >=
                  result.ksp_last_true_relative_residual &&
              result.ksp_pc_side == static_cast<int>(PC_RIGHT) &&
              result.ksp_norm_type == static_cast<int>(KSP_NORM_UNPRECONDITIONED),
          "Floquet diagnostics check the last solve against the original shifted shell");
    check(std::isfinite(result.worst_candidate_unprojected_magnetic_relative_residual) &&
              std::isfinite(result.worst_candidate_rotated_imaginary_rad_s) &&
              std::isfinite(result.worst_candidate_q_projection_ratio) &&
              result.worst_candidate_q_projection_ratio > 0.0,
          "Floquet diagnostics expose the unprojected candidate and reconstruction norm");
    check(result.eps_monitor_iteration > 0 &&
              result.eps_monitor_iteration <= result.outer_iterations,
          "Floquet EPS monitor records an iteration from the completed solve");
    check(result.eps_converged_reason_available && result.eps_converged_reason > 0,
          "converged Floquet fixture exposes the native EPS stop reason");
    check(result.eps_dimensions_available && result.eps_nev > 0 &&
              result.eps_ncv >= result.eps_nev,
          "Floquet diagnostics expose the resolved Krylov-Schur dimensions");
    check(result.max_candidate_relative_residual <= request.residual_tolerance,
          "native Floquet acceptance uses the requested physical block residual");
    const double expected_eps_tolerance = std::max(
        100.0 * std::numeric_limits<double>::epsilon(),
        1.0e-3 * request.residual_tolerance);
    check(std::abs(result.eps_normalized_absolute_tolerance - expected_eps_tolerance) <=
              std::numeric_limits<double>::epsilon() * expected_eps_tolerance,
          "SLEPc absolute true-residual prefilter uses the configured safety factor");
    check(result.max_eps_normalized_absolute_residual <=
              result.eps_normalized_absolute_tolerance,
          "converged EPS candidates satisfy the configured absolute true-residual cutoff");
#endif
}

void refills_native_floquet_nev_before_tangent_mass_cap()
{
#if FULLMAG_FEM_WITH_SLEPC
    constexpr std::size_t q_dimension = 8u;
    constexpr double coefficient_scale = 1.0e-60;
    constexpr double spectral_center_hz = 1.0e6;
    constexpr double shift_frequency_hz = spectral_center_hz - 1.0e4;
    // Preserve the original q=8 fixture for the dimension-limited and
    // cancellation cases below. Its real-split dimension caps NCV at 16, so
    // the separate q=32 operator is required to exercise a real NEV refill.
    const double frequency_offsets_hz[q_dimension] = {
        -0.003, -0.001, 0.001, 0.003, 0.2, 0.4, 0.6, 0.8};
    std::vector<std::complex<double>> a_diagonal(q_dimension);
    const std::vector<std::complex<double>> b_diagonal(
        q_dimension, std::complex<double>(0.0, -coefficient_scale));
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        a_diagonal[row] = coefficient_scale * fd::omega_rad_s_from_frequency_hz(
            spectral_center_hz + frequency_offsets_hz[row]);
    }
    const auto a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
    const auto b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
    const auto positive_tangent_mass = correlated_mass_csr(
        q_dimension, 4u, 0.99);
    const auto p = diagonal_complex_csr(1u, {1.0});
    const auto a_qphi = q_to_phi_complex_csr(q_dimension, 0.0);
    const auto a_phiq = phi_to_q_complex_csr(q_dimension, 0.0);
    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.positive_tangent_mass = &positive_tangent_mass;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = q_dimension;
    operator_view.phi_dof_count = 1u;

    const auto make_request = [=](int requested_count, int outer_budget) {
        fd::SLEPcSparseGyrotropicModalEigenRequest request{};
        request.tangent_dof_count = static_cast<int>(q_dimension);
        request.requested_mode_count = requested_count;
        request.target_frequency_hz = shift_frequency_hz;
        request.frequency_min_hz = spectral_center_hz - 1.0;
        request.frequency_max_hz = spectral_center_hz + 1.0;
        request.residual_tolerance = 1.0e-10;
        request.max_outer_iterations = outer_budget;
        request.max_linear_iterations = 96;
        return request;
    };

    constexpr std::size_t refill_q_dimension = 32u;
    constexpr double refill_spectral_center_hz = 1.0e6;
    constexpr double refill_window_half_width_hz = 1.0e5;
    constexpr double refill_shift_frequency_hz =
        refill_spectral_center_hz - 1.05e5;
    // With initial NEV=4, the four closest frequencies include only the
    // index-1 in-window mode; index 4 is the second in-window mode, and the
    // remaining 27 modes are explicitly separated above the window.
    std::vector<double> refill_frequency_offsets_hz{
        -1.1e5, -0.95e5, -1.3e5, -1.6e5, -0.35e5};
    for (std::size_t index = refill_frequency_offsets_hz.size();
         index < refill_q_dimension;
         ++index) {
        refill_frequency_offsets_hz.push_back(
            2.0e5 + 1.0e4 * static_cast<double>(index - 5u));
    }
    check(refill_frequency_offsets_hz.size() == refill_q_dimension,
          "provider refill fixture contains its full real-split spectral basis");
    int refill_fixture_window_mode_count = 0;
    for (std::size_t index = 0u;
         index < refill_frequency_offsets_hz.size();
         ++index) {
        const double frequency_hz =
            refill_spectral_center_hz + refill_frequency_offsets_hz[index];
        if (frequency_hz >= refill_spectral_center_hz -
                refill_window_half_width_hz &&
            frequency_hz <= refill_spectral_center_hz +
                refill_window_half_width_hz) {
            ++refill_fixture_window_mode_count;
        }
        if (index >= 5u) {
            check(refill_frequency_offsets_hz[index] >= 2.0e5 &&
                      (index == 5u ||
                       refill_frequency_offsets_hz[index] -
                               refill_frequency_offsets_hz[index - 1u] >=
                           1.0e4),
                  "all added Floquet refill modes stay separated outside the requested window");
        }
    }
    check(refill_fixture_window_mode_count == 2,
          "only the two independently specified refill modes lie in the requested window");

    std::vector<std::complex<double>> refill_a_diagonal(refill_q_dimension);
    const std::vector<std::complex<double>> refill_b_diagonal(
        refill_q_dimension, std::complex<double>(0.0, -coefficient_scale));
    for (std::size_t row = 0u; row < refill_q_dimension; ++row) {
        refill_a_diagonal[row] = coefficient_scale *
            fd::omega_rad_s_from_frequency_hz(
                refill_spectral_center_hz + refill_frequency_offsets_hz[row]);
    }
    const auto refill_a_qq = diagonal_complex_csr(
        refill_q_dimension, refill_a_diagonal);
    const auto refill_b_qq = diagonal_complex_csr(
        refill_q_dimension, refill_b_diagonal);
    const auto refill_positive_tangent_mass = diagonal_complex_csr(
        refill_q_dimension,
        std::vector<std::complex<double>>(
            refill_q_dimension, std::complex<double>(1.0, 0.0)));
    const auto refill_p = diagonal_complex_csr(1u, {1.0});
    const auto refill_a_qphi = q_to_phi_complex_csr(refill_q_dimension, 0.0);
    const auto refill_a_phiq = phi_to_q_complex_csr(refill_q_dimension, 0.0);
    fd::FloquetSharedDomainSparseModalOperator refill_operator_view{};
    refill_operator_view.a_qq = &refill_a_qq;
    refill_operator_view.b_qq = &refill_b_qq;
    refill_operator_view.positive_tangent_mass = &refill_positive_tangent_mass;
    refill_operator_view.p = &refill_p;
    refill_operator_view.a_qphi = &refill_a_qphi;
    refill_operator_view.a_phiq = &refill_a_phiq;
    refill_operator_view.q_complex_dof_count = refill_q_dimension;
    refill_operator_view.phi_dof_count = 1u;

    const auto make_refill_request = [=](int requested_count, int outer_budget) {
        fd::SLEPcSparseGyrotropicModalEigenRequest request{};
        request.tangent_dof_count = static_cast<int>(refill_q_dimension);
        request.requested_mode_count = requested_count;
        request.target_frequency_hz = refill_shift_frequency_hz;
        request.frequency_min_hz = refill_spectral_center_hz -
            refill_window_half_width_hz;
        request.frequency_max_hz = refill_spectral_center_hz +
            refill_window_half_width_hz;
        request.residual_tolerance = 1.0e-10;
        request.max_outer_iterations = outer_budget;
        request.max_linear_iterations = 96;
        return request;
    };
    const auto report_refill_diagnostics = [](
        const char *label,
        const fd::SLEPcTinyGyrotropicModalEigenResult &result) {
        const auto &probe = result.shifted_ksp_failure_probe;
        std::fprintf(
            stderr,
            "DIAG: %s ok=%d status=%s reason=%s attempts=%d solved=%d "
            "finalized_attempt=%d first_pool_available=%d first_unique=%d "
            "initial_nev=%d current_nev=%d finalized_nev=%d "
            "initial_ncv=%d ncv=%d initial_mpd=%d mpd=%d "
            "positive=%d window=%d residual_eval=%d residual_rejected=%d "
            "unique=%d accepted=%d max_residual=%.17g outer=%d/%d "
            "converged=%d eps_reason_available=%d eps_reason=%d "
            "probe_attempt=%d probe_nev=%lld probe_ncv=%lld "
            "callback_count=%llu callback_available=%d callback_iteration=%lld "
            "default_reason=%d:%d post_gate_reason=%d:%d "
            "probe_attempts=%llu probes=%llu probe_measurement_failures=%llu\n",
            label,
            result.ok ? 1 : 0,
            result.status != nullptr ? result.status : "",
            result.unsupported_reason != nullptr ? result.unsupported_reason : "",
            result.eps_attempt_count,
            result.eps_solved_attempt_count,
            result.eps_finalized_attempt_number,
            result.eps_first_attempt_unique_certified_mode_count_available ? 1 : 0,
            result.eps_first_attempt_unique_certified_mode_count,
            result.eps_initial_nev,
            result.eps_nev,
            result.eps_finalized_nev,
            result.eps_initial_ncv,
            result.eps_ncv,
            result.eps_initial_mpd,
            result.eps_mpd,
            result.positive_frequency_candidate_count,
            result.frequency_window_candidate_count,
            result.residual_evaluation_candidate_count,
            result.residual_rejection_count,
            result.eps_unique_certified_mode_count,
            result.accepted_mode_count,
            result.max_candidate_relative_residual,
            result.outer_iterations,
            result.max_outer_iterations,
            result.converged_eigenpair_count,
            result.eps_converged_reason_available ? 1 : 0,
            result.eps_converged_reason,
            probe.eps_attempt_number,
            static_cast<long long>(probe.eps_nev_argument),
            static_cast<long long>(probe.eps_ncv_argument),
            static_cast<unsigned long long>(probe.callback_count),
            probe.callback_observation_available ? 1 : 0,
            static_cast<long long>(probe.last_callback_iteration),
            probe.last_default_reason_available ? 1 : 0,
            probe.last_default_reason,
            probe.last_reason_after_gate_available ? 1 : 0,
            probe.last_reason_after_gate,
            static_cast<unsigned long long>(probe.true_probe_attempt_count),
            static_cast<unsigned long long>(probe.true_probe_count),
            static_cast<unsigned long long>(
                probe.true_probe_measurement_failure_count));
    };

    const auto refill_request = make_refill_request(2, 160);
    const auto refill_result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        refill_operator_view, refill_request);
    const double expected_first_refill_frequency_hz =
        refill_spectral_center_hz + refill_frequency_offsets_hz[1u];
    const double expected_second_refill_frequency_hz =
        refill_spectral_center_hz + refill_frequency_offsets_hz[4u];
    constexpr double expected_refill_frequency_tolerance_hz = 1.0e-3;
    bool saw_expected_first_refill_frequency = false;
    bool saw_expected_second_refill_frequency = false;
    bool refill_residuals_accepted = refill_result.accepted_modes.size() == 2u;
    for (const fd::SLEPcModalAcceptedMode &mode : refill_result.accepted_modes) {
        saw_expected_first_refill_frequency =
            saw_expected_first_refill_frequency ||
            std::abs(mode.frequency_hz - expected_first_refill_frequency_hz) <=
                expected_refill_frequency_tolerance_hz;
        saw_expected_second_refill_frequency =
            saw_expected_second_refill_frequency ||
            std::abs(mode.frequency_hz - expected_second_refill_frequency_hz) <=
                expected_refill_frequency_tolerance_hz;
        refill_residuals_accepted = refill_residuals_accepted &&
            mode.relative_residual <= refill_request.residual_tolerance;
    }
    const bool refill_expected_frequencies_present =
        refill_result.accepted_modes.size() == 2u &&
        saw_expected_first_refill_frequency &&
        saw_expected_second_refill_frequency;
    const bool refill_first_pool_observed_incomplete =
        refill_result.eps_first_attempt_unique_certified_mode_count_available &&
        refill_result.eps_first_attempt_unique_certified_mode_count == 1;
    const bool refill_attempt_telemetry_consistent =
        refill_result.eps_attempt_count >= 2 &&
        refill_result.eps_solved_attempt_count >= 2 &&
        refill_result.eps_finalized_attempt_number ==
            refill_result.eps_solved_attempt_count;
    const bool refill_dimensions_resolved_and_fixed =
        refill_result.eps_dimensions_available &&
        refill_result.eps_initial_nev == 4 &&
        refill_result.eps_nev > refill_result.eps_initial_nev &&
        refill_result.eps_initial_ncv == 32 &&
        refill_result.eps_ncv == refill_result.eps_initial_ncv &&
        refill_result.eps_initial_mpd > 0 &&
        refill_result.eps_mpd == refill_result.eps_initial_mpd &&
        refill_result.eps_nev < refill_result.eps_ncv;
    const bool refill_primary_contract =
        refill_result.ok && refill_result.accepted_mode_count == 2 &&
        refill_result.eps_unique_certified_mode_count == 2 &&
        refill_first_pool_observed_incomplete &&
        refill_attempt_telemetry_consistent &&
        refill_dimensions_resolved_and_fixed &&
        refill_expected_frequencies_present &&
        refill_residuals_accepted;
    if (!refill_primary_contract) {
        report_refill_diagnostics("native refill", refill_result);
    }
    check(refill_result.ok && refill_result.accepted_mode_count == 2,
          "native Floquet refill publishes the requested certified mode count");
    check(refill_attempt_telemetry_consistent,
          "native Floquet refill records attempts, safe solves, and the finalized pool identity");
    check(refill_first_pool_observed_incomplete,
          "the first finalized refill pool contains one certified mode before later attempts");
    check(refill_dimensions_resolved_and_fixed,
          "native Floquet refill grows NEV while holding the initial NCV and MPD fixed");
    check(refill_result.eps_unique_certified_mode_count == 2 &&
              refill_result.eps_cumulative_iterations_available &&
              refill_result.eps_iteration_budget_available &&
              refill_result.outer_iterations <= refill_result.max_outer_iterations &&
              refill_result.ksp_max_iterations == refill_request.max_linear_iterations,
          "native Floquet refill reports the unique certified pool within one cumulative EPS budget");
    check(refill_expected_frequencies_present,
          "refill returns both independently specified in-window eigenfrequencies");
    check(refill_residuals_accepted,
          "refilled modes retain the original descriptor residual gate");
    const auto first_mass_vector = complex_csr_matvec_for_test(
        refill_positive_tangent_mass, refill_result.accepted_modes[0].mode_vector);
    const auto second_mass_vector = complex_csr_matvec_for_test(
        refill_positive_tangent_mass, refill_result.accepted_modes[1].mode_vector);
    std::complex<double> mass_inner_product{};
    double first_mass_norm_squared = 0.0;
    double second_mass_norm_squared = 0.0;
    for (std::size_t index = 0u; index < refill_q_dimension; ++index) {
        mass_inner_product += std::conj(
            refill_result.accepted_modes[0].mode_vector[index]) *
            second_mass_vector[index];
        first_mass_norm_squared += std::real(
            std::conj(refill_result.accepted_modes[0].mode_vector[index]) *
            first_mass_vector[index]);
        second_mass_norm_squared += std::real(
            std::conj(refill_result.accepted_modes[1].mode_vector[index]) *
            second_mass_vector[index]);
    }
    const double normalized_mass_overlap = std::abs(mass_inner_product) /
        std::sqrt(first_mass_norm_squared * second_mass_norm_squared);
    check(std::isfinite(first_mass_norm_squared) && first_mass_norm_squared > 0.0 &&
              std::isfinite(second_mass_norm_squared) && second_mass_norm_squared > 0.0,
          "both returned Floquet modes have positive norm in the supplied tangent mass");
    check(std::isfinite(normalized_mass_overlap) &&
              normalized_mass_overlap < 0.90,
          "the returned nearest modes remain distinct in the positive tangent mass metric");

    const auto dimension_limited_request = make_request(9, 160);
    const auto dimension_limited_result =
        fd::solve_floquet_shared_domain_sparse_modal_spectrum(
            operator_view, dimension_limited_request);
    check(!dimension_limited_result.ok &&
              dimension_limited_result.status != nullptr &&
              std::strcmp(dimension_limited_result.status, "partial") == 0 &&
              dimension_limited_result.unsupported_reason != nullptr &&
              std::strcmp(
                  dimension_limited_result.unsupported_reason,
                  "floquet_nev_refill_dimension_limit_reached") == 0 &&
              dimension_limited_result.accepted_mode_count > 0 &&
              dimension_limited_result.accepted_mode_count < 9,
          "a dimension-limited refill returns only its certified partial pool");
    check(dimension_limited_result.eps_nev == 15 &&
              dimension_limited_result.eps_ncv == 16 &&
              dimension_limited_result.eps_mpd == 16,
          "the refill ceiling never exceeds the initially admitted Krylov dimensions");

    const auto budget_limited_request = make_refill_request(2, 1);
    const auto budget_limited_result =
        fd::solve_floquet_shared_domain_sparse_modal_spectrum(
            refill_operator_view, budget_limited_request);
    const bool budget_limit_is_an_actual_partial_refill =
        !budget_limited_result.ok &&
        budget_limited_result.status != nullptr &&
        std::strcmp(budget_limited_result.status, "partial") == 0 &&
        budget_limited_result.unsupported_reason != nullptr &&
        std::strcmp(
            budget_limited_result.unsupported_reason,
            "floquet_nev_refill_outer_iteration_budget_exhausted") == 0 &&
        budget_limited_result.accepted_mode_count == 1 &&
        budget_limited_result.eps_attempt_count == 1 &&
        budget_limited_result.eps_solved_attempt_count == 1 &&
        budget_limited_result.eps_first_attempt_unique_certified_mode_count_available &&
        budget_limited_result.eps_first_attempt_unique_certified_mode_count == 1 &&
        budget_limited_result.frequency_window_candidate_count > 0 &&
        budget_limited_result.residual_evaluation_candidate_count > 0 &&
        budget_limited_result.residual_rejection_count == 0;
    if (!budget_limit_is_an_actual_partial_refill) {
        report_refill_diagnostics("one-iteration budget", budget_limited_result);
    }
    check(!budget_limited_result.ok &&
              budget_limited_result.status != nullptr &&
              std::strcmp(budget_limited_result.status, "partial") == 0 &&
              budget_limited_result.unsupported_reason != nullptr &&
              std::strcmp(
                  budget_limited_result.unsupported_reason,
                  "floquet_nev_refill_outer_iteration_budget_exhausted") == 0 &&
              budget_limited_result.accepted_mode_count == 1,
          "one EPS iteration retains the one certified in-window mode and reports budget exhaustion");
    check(budget_limit_is_an_actual_partial_refill,
          "budget exhaustion is observed with a certified partial pool rather than residual rejection");
    check(budget_limited_result.eps_iteration_budget_available &&
              budget_limited_result.max_outer_iterations == 1 &&
              budget_limited_result.eps_cumulative_iterations_available &&
              budget_limited_result.outer_iterations == 1,
          "refill cannot reset or exceed the resolved total EPS iteration budget");

    CancelAfterPolls cancellation{};
    auto cancellation_request = make_request(2, 160);
    cancellation_request.cancel_user_data = &cancellation;
    cancellation_request.cancel_requested = cancel_after_polls;
    const auto cancelled_result =
        fd::solve_floquet_shared_domain_sparse_modal_spectrum(
            operator_view, cancellation_request);
    check(!cancelled_result.ok &&
              cancelled_result.status != nullptr &&
              std::strcmp(cancelled_result.status, "cancelled") == 0 &&
              cancelled_result.eps_cancellation_observed &&
              cancelled_result.eps_attempt_count == 1 &&
              cancelled_result.eps_solved_attempt_count == 1 &&
              cancelled_result.eps_converged_reason_available &&
              cancelled_result.eps_converged_reason == EPS_CONVERGED_USER,
          "native EPS cancellation stops refill and remains distinct from convergence");

    CancelOnceOnPoll pre_solve_cancellation{};
    pre_solve_cancellation.cancel_on_poll = 1;
    auto pre_solve_request = make_request(2, 160);
    pre_solve_request.cancel_user_data = &pre_solve_cancellation;
    pre_solve_request.cancel_requested = cancel_once_on_poll;
    const auto pre_solve_result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, pre_solve_request);
    check(!pre_solve_result.ok &&
              pre_solve_result.status != nullptr &&
              std::strcmp(pre_solve_result.status, "cancelled") == 0 &&
              pre_solve_result.eps_cancellation_observed &&
              pre_solve_result.eps_attempt_count == 0 &&
              pre_solve_cancellation.fired,
          "one-shot cancellation before EPS setup remains a terminal cancellation");

    CancelOnceOnPoll one_shot_cancellation{};
    one_shot_cancellation.cancel_on_poll = 3;
    auto one_shot_request = make_request(2, 160);
    one_shot_request.cancel_user_data = &one_shot_cancellation;
    one_shot_request.cancel_requested = cancel_once_on_poll;
    const auto one_shot_result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, one_shot_request);
    check(!one_shot_result.ok &&
              one_shot_result.status != nullptr &&
              std::strcmp(one_shot_result.status, "cancelled") == 0 &&
              one_shot_result.eps_cancellation_observed &&
              one_shot_result.eps_attempt_count == 1 &&
              one_shot_result.eps_solved_attempt_count == 1 &&
              one_shot_cancellation.fired,
          "a one-shot cancellation after EPS starts remains terminal if later polls clear");
#endif
}

void captures_near_pole_failure_probe()
{
#if FULLMAG_FEM_WITH_SLEPC
    constexpr std::size_t q_dimension = 8u;
    constexpr double coefficient_scale = 1.0e-60;
    constexpr double spectral_center_hz = 1.0e6;
    const double frequency_offsets_hz[q_dimension] = {
        -0.003, -0.001, 0.001, 0.003, 0.2, 0.4, 0.6, 0.8};
    std::vector<std::complex<double>> a_diagonal(q_dimension);
    const std::vector<std::complex<double>> b_diagonal(
        q_dimension, std::complex<double>(0.0, -coefficient_scale));
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        a_diagonal[row] = coefficient_scale * fd::omega_rad_s_from_frequency_hz(
            spectral_center_hz + frequency_offsets_hz[row]);
    }
    const auto a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
    const auto b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
    const auto positive_tangent_mass = correlated_mass_csr(
        q_dimension, 4u, 0.99);
    const auto p = diagonal_complex_csr(1u, {1.0});
    const auto a_qphi = q_to_phi_complex_csr(q_dimension, 0.0);
    const auto a_phiq = phi_to_q_complex_csr(q_dimension, 0.0);
    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.positive_tangent_mass = &positive_tangent_mass;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = q_dimension;
    operator_view.phi_dof_count = 1u;

    fd::SLEPcSparseGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = static_cast<int>(q_dimension);
    request.requested_mode_count = 2;
    request.target_frequency_hz = spectral_center_hz;
    request.frequency_min_hz = spectral_center_hz - 1.0;
    request.frequency_max_hz = spectral_center_hz + 1.0;
    request.residual_tolerance = 1.0e-10;
    request.max_outer_iterations = 160;
    request.max_linear_iterations = 96;
    const auto result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, request);

    const bool pinned_petsc_3_24_6 =
        PETSC_VERSION_MAJOR == 3 && PETSC_VERSION_MINOR == 24 &&
        PETSC_VERSION_SUBMINOR == 6;
    if (pinned_petsc_3_24_6) {
        check(!result.ok && result.status != nullptr &&
                  std::strcmp(result.status, "solve_error") == 0 &&
                  result.unsupported_reason != nullptr &&
                  std::strcmp(result.unsupported_reason,
                              "floquet_slepc_solve_failed") == 0,
              "pinned PETSc 3.24.6 keeps the original near-pole KSP failure observable");
    }

    if (!result.ok && result.unsupported_reason != nullptr &&
        std::strcmp(result.unsupported_reason,
                    "floquet_slepc_solve_failed") == 0) {
        const auto &probe = result.shifted_ksp_failure_probe;
        check(result.eps_attempt_count >= 1 &&
                  probe.eps_attempt_number == result.eps_attempt_count &&
                  probe.eps_dimension_arguments_available &&
                  probe.eps_nev_argument >= result.eps_initial_nev &&
                  probe.eps_nev_argument < probe.eps_ncv_argument &&
                  probe.eps_ncv_argument == 16,
              "near-pole failure probe records the actual failing attempt dimensions");
        check(probe.callback_count > 0 &&
                  probe.last_recursive_residual_available &&
                  probe.last_default_reason_available &&
                  probe.last_reason_after_gate_available &&
                  probe.last_callback_iteration >= 0,
              "near-pole failure retains its latest independent callback observation");
        check(probe.true_probe_attempt_count ==
                  probe.true_probe_count +
                      probe.true_probe_measurement_failure_count,
              "near-pole true-probe counters distinguish completed and failed measurements");
        if (probe.true_probe_attempt_count > 0) {
            check(probe.last_true_probe_default_reason_available &&
                      probe.last_true_probe_reason_after_gate_available &&
                      probe.last_true_probe_iteration >= 0 &&
                      probe.last_true_probe_callback_ordinal > 0 &&
                      probe.last_true_probe_callback_ordinal <= probe.callback_count,
                  "near-pole true-probe reasons remain paired with their own callback iteration");
            if (probe.last_true_probe_callback_ordinal == probe.callback_count) {
                check(probe.last_true_probe_reason_after_gate ==
                          probe.last_reason_after_gate,
                      "same-event near-pole callback and true-probe reasons agree");
            }
            if (probe.last_true_probe_available) {
                const double expected_threshold = std::max(
                    probe.last_true_atol,
                    probe.last_true_rtol * probe.last_true_rhs_norm);
                check(std::isfinite(probe.last_true_rhs_norm) &&
                          std::isfinite(probe.last_true_residual_norm) &&
                          probe.last_true_residual_threshold == expected_threshold,
                      "near-pole probe threshold is the unchanged shifted-system criterion");
                if (probe.last_true_tolerance_ratio_available) {
                    check(probe.last_true_residual_threshold > 0.0 &&
                              probe.last_true_tolerance_ratio ==
                                  probe.last_true_residual_norm /
                                      probe.last_true_residual_threshold,
                          "near-pole probe ratio is paired with the same shifted-system norms");
                }
            }
        }
        std::printf(
            "NEAR_POLE_SHIFTED_KSP_FAILURE attempt=%d nev=%lld ncv=%lld callback_count=%llu callback_iter=%lld recursive_available=%d recursive=%.17g default_reason_available=%d default_reason=%d post_gate_available=%d post_gate_reason=%d true_probe_attempts=%llu true_probes=%llu true_probe_failures=%llu true_probe_available=%d true_probe_iter=%lld rhs=%.17g true_residual=%.17g rtol=%.17g atol=%.17g threshold=%.17g ratio_available=%d ratio=%.17g\n",
            probe.eps_attempt_number,
            static_cast<long long>(probe.eps_nev_argument),
            static_cast<long long>(probe.eps_ncv_argument),
            static_cast<unsigned long long>(probe.callback_count),
            static_cast<long long>(probe.last_callback_iteration),
            probe.last_recursive_residual_available ? 1 : 0,
            probe.last_recursive_residual_norm,
            probe.last_default_reason_available ? 1 : 0,
            probe.last_default_reason,
            probe.last_reason_after_gate_available ? 1 : 0,
            probe.last_reason_after_gate,
            static_cast<unsigned long long>(probe.true_probe_attempt_count),
            static_cast<unsigned long long>(probe.true_probe_count),
            static_cast<unsigned long long>(
                probe.true_probe_measurement_failure_count),
            probe.last_true_probe_available ? 1 : 0,
            static_cast<long long>(probe.last_true_probe_iteration),
            probe.last_true_rhs_norm,
            probe.last_true_residual_norm,
            probe.last_true_rtol,
            probe.last_true_atol,
            probe.last_true_residual_threshold,
            probe.last_true_tolerance_ratio_available ? 1 : 0,
            probe.last_true_tolerance_ratio);
    } else {
        check(result.ok && result.accepted_mode_count > 0,
              "a provider that resolves the near-pole case must return a certified mode");
        for (const auto &mode : result.accepted_modes) {
            check(mode.relative_residual <= request.residual_tolerance,
                  "near-pole success retains the original physical residual gate");
        }
    }
#endif
}

} // namespace

int main()
{
    cleanup_and_cancellation_gates_fail_closed();
    accepts_finite_nonzero_k_cpu_contract();
    rejects_missing_dynamic_payload_and_gpu();
    rejects_zero_k_and_missing_pairs();
    accepts_raw_or_fixed_k_vectors();
    rejects_invalid_frequency_windows();
    admits_sparse_bloch_operator_without_demag();
    admits_certified_shared_domain_sparse_operator();
    reports_opt_in_action_diagnostic_unavailable_before_setup();
    executes_native_sparse_matshell_above_dense_bound();
    finalizes_certified_candidates_by_tangent_mass_before_nearest_cap();
    normalizes_si_scale_floquet_pencil();
    refills_native_floquet_nev_before_tangent_mass_cap();
    captures_near_pole_failure_probe();
    executes_native_sparse_matshell_above_dense_bound(true);
    std::printf("PASS: fem_floquet_modal_solver_contract\n");
    return 0;
}
