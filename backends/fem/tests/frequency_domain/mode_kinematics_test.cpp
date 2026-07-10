#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"
#include "frequency_domain/excitation.hpp"
#include "frequency_domain/mode_kinematics.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"
#include "frequency_domain/operator_contract.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <string>
#include <utility>

namespace fd = fullmag::fem::frequency_domain;

namespace {

int failure_count = 0;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failure_count;
    }
}

void check_relative_close(double actual, double expected, double tolerance, const char *message)
{
    const double scale = std::fmax(std::fmax(std::abs(actual), std::abs(expected)), 1.0e-30);
    check(std::abs(actual - expected) <= tolerance * scale, message);
}

bool contains(const char *haystack, const char *needle)
{
    return haystack != nullptr && std::strstr(haystack, needle) != nullptr;
}

bool contains(const std::string &haystack, const char *needle)
{
    return needle != nullptr && haystack.find(needle) != std::string::npos;
}

double extract_json_number(const std::string &json, const char *key)
{
    const std::size_t start = json.find(key != nullptr ? key : "");
    if (start == std::string::npos) {
        check(false, "expected JSON numeric key must be present");
        return std::numeric_limits<double>::quiet_NaN();
    }
    const char *number = json.c_str() + start + std::strlen(key);
    char *end = nullptr;
    const double value = std::strtod(number, &end);
    if (end == number) {
        check(false, "expected JSON numeric value must parse");
        return std::numeric_limits<double>::quiet_NaN();
    }
    return value;
}

void gamma_mu0_and_gamma0_are_equivalent_and_conflicts_reject()
{
    constexpr double gamma_abs_rad_per_s_t = 1.76085963023e11;
    constexpr double mu0_t_m_per_a = 1.25663706212e-6;
    constexpr double gamma0_m_per_a_s =
        gamma_abs_rad_per_s_t * mu0_t_m_per_a;

    fd::DynamicPencilMetadata gamma_mu0{};
    gamma_mu0.gamma_abs_rad_per_s_t = gamma_abs_rad_per_s_t;
    gamma_mu0.mu0_t_m_per_a = mu0_t_m_per_a;
    fd::DynamicPencilMetadata canonical_gamma_mu0{};
    char error_message[128]{};
    check(
        fd::canonicalize_dynamic_pencil_metadata(
            gamma_mu0,
            &canonical_gamma_mu0,
            error_message,
            sizeof(error_message)) == fd::FrequencyDomainStatus::ok,
        "gamma and mu0 metadata must canonicalize");

    fd::DynamicPencilMetadata gamma0{};
    gamma0.gamma0_m_per_a_s = gamma0_m_per_a_s;
    fd::DynamicPencilMetadata canonical_gamma0{};
    check(
        fd::canonicalize_dynamic_pencil_metadata(
            gamma0,
            &canonical_gamma0,
            error_message,
            sizeof(error_message)) == fd::FrequencyDomainStatus::ok,
        "gamma0 metadata must canonicalize");
    check_relative_close(
        canonical_gamma_mu0.gamma0_m_per_a_s,
        canonical_gamma0.gamma0_m_per_a_s,
        1.0e-13,
        "gamma/mu0 and gamma0 must produce identical canonical gamma0");

    fd::DynamicPencilMetadata consistent = gamma_mu0;
    consistent.gamma0_m_per_a_s = gamma0_m_per_a_s;
    check(
        fd::canonicalize_dynamic_pencil_metadata(
            consistent,
            &canonical_gamma0,
            error_message,
            sizeof(error_message)) == fd::FrequencyDomainStatus::ok,
        "consistent gamma, mu0 and gamma0 must be accepted");

    fd::DynamicPencilMetadata conflicting = consistent;
    conflicting.gamma0_m_per_a_s *= 1.01;
    check(
        fd::canonicalize_dynamic_pencil_metadata(
            conflicting,
            &canonical_gamma0,
            error_message,
            sizeof(error_message)) == fd::FrequencyDomainStatus::validation_error,
        "conflicting gamma accepted");
    check(
        std::strstr(error_message, "conflict") != nullptr,
        "gamma conflict must have an explicit diagnostic");

    fd::DynamicPencilMetadata missing_mu0{};
    missing_mu0.gamma_abs_rad_per_s_t = gamma_abs_rad_per_s_t;
    check(
        fd::canonicalize_dynamic_pencil_metadata(
            missing_mu0,
            &canonical_gamma0,
            error_message,
            sizeof(error_message)) == fd::FrequencyDomainStatus::validation_error,
        "gamma without mu0 must reject instead of accepting a scale error");
}

void gamma_consistency_tolerance_has_explicit_boundary_coverage()
{
    constexpr double gamma_abs_rad_per_s_t = 1.76085963023e11;
    constexpr double mu0_t_m_per_a = 1.25663706212e-6;
    constexpr double derived_gamma0_m_per_a_s =
        gamma_abs_rad_per_s_t * mu0_t_m_per_a;

    auto status_for_multiplier = [&](double relative_offset) {
        fd::DynamicPencilMetadata metadata{};
        metadata.gamma_abs_rad_per_s_t = gamma_abs_rad_per_s_t;
        metadata.mu0_t_m_per_a = mu0_t_m_per_a;
        metadata.gamma0_m_per_a_s =
            derived_gamma0_m_per_a_s * (1.0 + relative_offset);
        fd::DynamicPencilMetadata canonical{};
        char error_message[128]{};
        return fd::canonicalize_dynamic_pencil_metadata(
            metadata,
            &canonical,
            error_message,
            sizeof(error_message));
    };

    check(
        status_for_multiplier(0.9 * fd::kGammaConsistencyRelativeTolerance) ==
            fd::FrequencyDomainStatus::ok,
        "gamma mismatch just inside the relative tolerance must be accepted");
    check(
        status_for_multiplier(1.1 * fd::kGammaConsistencyRelativeTolerance) ==
            fd::FrequencyDomainStatus::validation_error,
        "gamma mismatch just outside the relative tolerance must be rejected");
    check(
        status_for_multiplier(0.1 * fd::kGammaConsistencyRelativeTolerance) ==
            fd::FrequencyDomainStatus::ok,
        "gamma mismatch comfortably inside the relative tolerance must be accepted");
    check(
        status_for_multiplier(10.0 * fd::kGammaConsistencyRelativeTolerance) ==
            fd::FrequencyDomainStatus::validation_error,
        "gamma mismatch comfortably outside the relative tolerance must be rejected");
}

void legacy_operator_validation_canonicalizes_gamma0()
{
    fd::FrequencyDomainOperatorRequest request{};
    request.node_count = 1;
    request.tangent_dof_count = 2;
    request.gamma0 = 2.211e5;

    fd::FrequencyDomainOperatorValidationDiagnostics diagnostics{};
    check(
        fd::validate_frequency_domain_operator_request(request, &diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        diagnostics.error_message);
    check_relative_close(
        diagnostics.gamma0_m_per_a_s,
        request.gamma0,
        1.0e-15,
        "operator diagnostics must expose the canonical gamma0 value");
}

void modal_contract_rejects_overflowing_legacy_gamma_pair_before_dispatch()
{
    fd::ModalEigenRequest request{};
    request.operator_request.gamma_rad_s_T = std::numeric_limits<double>::max();
    request.operator_request.mu0_T_m_A = 2.0;
    request.phase_convention = fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t;

    const fd::FrequencyDomainContractResult result =
        fd::solve_modal_eigen_contract(request);
    check(
        result.status == fd::FrequencyDomainStatus::validation_error,
        "modal contract must reject a finite gamma/mu0 pair whose product overflows");
    check(
        contains(result.error_message, "gamma"),
        "modal overflow rejection must identify the gamma metadata boundary");
}

void excitation_boundary_canonicalizes_and_rejects_invalid_legacy_gamma0()
{
    const fd::TangentFrameNode node{};
    const double hx_re[1] = {1.0};
    const double hy_re[1] = {0.0};
    const double hz_re[1] = {0.0};
    const fd::DynamicFieldPhasorView drive{
        hx_re,
        hy_re,
        hz_re,
        nullptr,
        nullptr,
        nullptr,
        1};

    for (const double invalid_gamma0 : {
             0.0,
             -1.0,
             std::numeric_limits<double>::quiet_NaN(),
             std::numeric_limits<double>::infinity()}) {
        double rhs_real[2]{};
        double rhs_imag[2]{};
        fd::TangentExcitationDiagnostics diagnostics{};
        check(
            fd::project_dynamic_field_drive_to_tangent_rhs(
                &node,
                1,
                invalid_gamma0,
                fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t,
                drive,
                fd::TangentComplexVectorView{rhs_real, rhs_imag, 2},
                &diagnostics) == fd::FrequencyDomainStatus::validation_error,
            "excitation boundary must reject non-positive and non-finite legacy gamma0");
    }

    constexpr double gamma0_m_per_a_s = 2.211e5;
    double rhs_real[2]{};
    double rhs_imag[2]{};
    fd::TangentExcitationDiagnostics diagnostics{};
    check(
        fd::project_dynamic_field_drive_to_tangent_rhs(
            &node,
            1,
            gamma0_m_per_a_s,
            fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t,
            drive,
            fd::TangentComplexVectorView{rhs_real, rhs_imag, 2},
            &diagnostics) == fd::FrequencyDomainStatus::ok,
        diagnostics.error_message);
    check_relative_close(
        rhs_real[1],
        -gamma0_m_per_a_s,
        1.0e-15,
        "excitation RHS must use canonical gamma0_m_per_a_s");
}

void hz_and_rad_per_second_round_trip()
{
    constexpr double frequency_hz = 4.75e9;
    const double omega_rad_s = fd::omega_rad_s_from_frequency_hz(frequency_hz);
    check_relative_close(
        fd::frequency_hz_from_omega_rad_s(omega_rad_s),
        frequency_hz,
        1.0e-15,
        "Hz to rad/s round trip must preserve frequency");
}

void plus_and_minus_phasors_select_opposite_positive_branches()
{
    constexpr double omega_rad_s = 2.0e10;
    const fd::ComplexEigenvalue plus_lambda{0.0, omega_rad_s};
    const fd::ComplexEigenvalue minus_lambda{0.0, -omega_rad_s};

    const fd::ModeKinematics plus = fd::map_eigenvalue(
        plus_lambda,
        fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
    const fd::ModeKinematics plus_conjugate = fd::map_eigenvalue(
        minus_lambda,
        fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
    check(plus.finite && plus.branch_sign == 1, "plus phasor must select Im(lambda)>0");
    check(plus_conjugate.branch_sign == -1, "plus phasor conjugate must be negative branch");
    check_relative_close(plus.omega_rad_s, omega_rad_s, 1.0e-15, "plus phasor omega sign");

    const fd::ModeKinematics minus = fd::map_eigenvalue(
        minus_lambda,
        fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t);
    const fd::ModeKinematics minus_conjugate = fd::map_eigenvalue(
        plus_lambda,
        fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t);
    check(minus.finite && minus.branch_sign == 1, "minus phasor must select Im(lambda)<0");
    check(minus_conjugate.branch_sign == -1, "minus phasor conjugate must be negative branch");
    check_relative_close(minus.omega_rad_s, omega_rad_s, 1.0e-15, "minus phasor omega sign");
}

void damped_conjugate_branches_keep_decay_and_stability()
{
    constexpr double decay_rate_per_s = 3.0e7;
    constexpr double omega_rad_s = 8.0e9;
    for (const double lambda_imag_rad_per_s : {omega_rad_s, -omega_rad_s}) {
        const fd::ModeKinematics stable = fd::map_eigenvalue(
            {-decay_rate_per_s, lambda_imag_rad_per_s},
            fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
        check(stable.stable, "damped conjugate branches must both be stable");
        check_relative_close(
            stable.decay_rate_per_s,
            decay_rate_per_s,
            1.0e-15,
            "damped conjugate branches must preserve decay rate");

        const fd::ModeKinematics unstable = fd::map_eigenvalue(
            {decay_rate_per_s, lambda_imag_rad_per_s},
            fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
        check(!unstable.stable, "positive real lambda must be unstable");
        check(unstable.decay_rate_per_s < 0.0, "unstable mode must expose negative decay rate");
    }
}

void zero_and_nonfinite_modes_are_explicit()
{
    const fd::ModeKinematics zero = fd::map_eigenvalue(
        {-1.0, 0.0},
        fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
    check(zero.finite, "zero mode must remain finite");
    check(zero.zero_frequency_mode, "zero mode must be classified explicitly");
    check(zero.branch_sign == 0, "zero mode must not receive an arbitrary branch");
    check(zero.frequency_hz == 0.0 && zero.omega_rad_s == 0.0, "zero mode frequency must be zero");

    const double nan = std::numeric_limits<double>::quiet_NaN();
    const double infinity = std::numeric_limits<double>::infinity();
    for (const fd::ComplexEigenvalue lambda : {
             fd::ComplexEigenvalue{nan, 1.0},
             fd::ComplexEigenvalue{0.0, infinity}}) {
        const fd::ModeKinematics invalid = fd::map_eigenvalue(
            lambda,
            fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
        check(!invalid.finite, "non-finite eigenvalue must be rejected by the mapper");
        check(!invalid.stable, "non-finite eigenvalue must not be reported stable");
        check(invalid.branch_sign == 0, "non-finite eigenvalue must not have a branch");
    }
}


void zero_frequency_tolerance_is_absolute_and_policy_is_explicit()
{
    const fd::ModeKinematics decay_independent = fd::map_eigenvalue(
        {-1.0e20, 1.0},
        fd::FrequencyDomainPhaseConvention::exp_i_omega_t);
    check(
        decay_independent.branch_sign == 1 && !decay_independent.zero_frequency_mode,
        "large decay must not change the absolute zero-frequency classification");

    constexpr double tolerance_rad_per_s = 1.0e-9;
    const fd::ModeKinematicsPolicy policy{tolerance_rad_per_s};
    const auto map = [&](double omega_rad_s) {
        return fd::map_eigenvalue(
            {-1.0e20, omega_rad_s},
            fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
            policy);
    };

    const fd::ModeKinematics exact_zero = map(0.0);
    const fd::ModeKinematics below = map(0.5 * tolerance_rad_per_s);
    const fd::ModeKinematics at = map(tolerance_rad_per_s);
    const fd::ModeKinematics above = map(2.0 * tolerance_rad_per_s);
    check(exact_zero.zero_frequency_mode, "exact zero must be classified as a zero mode");
    check(below.zero_frequency_mode, "frequency below tolerance must be a zero mode");
    check(at.zero_frequency_mode, "frequency at tolerance must be a zero mode");
    check(
        above.branch_sign == 1 && !above.zero_frequency_mode,
        "frequency above tolerance must retain its positive branch");
    check(
        !fd::select_positive_frequency_mode(
            at,
            fd::ZeroFrequencyModePolicy::exclude),
        "positive-frequency filters must explicitly exclude zero modes");
    check(
        fd::select_positive_frequency_mode(
            at,
            fd::ZeroFrequencyModePolicy::include),
        "positive-frequency selection must support an explicit include-zero policy");

    for (const double invalid_tolerance : {
             -1.0,
             std::numeric_limits<double>::infinity()}) {
        const fd::ModeKinematics invalid_policy = fd::map_eigenvalue(
            {0.0, 1.0},
            fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
            fd::ModeKinematicsPolicy{invalid_tolerance});
        check(
            !invalid_policy.finite,
            "zero-frequency tolerance must be finite and non-negative");
    }
}

fd::DensePoissonAirboxEigenOracleProblem dense_oracle_problem(
    const double *a_qq,
    const double *a_qphi,
    const double *a_phiq,
    const double *a_phiphi,
    const double *b_qq,
    const double *weights)
{
    fd::DensePoissonAirboxEigenOracleProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 1;
    problem.A_qq = fd::DenseRealMatrixView{a_qq, 2, 2};
    problem.A_qphi = fd::DenseRealMatrixView{a_qphi, 2, 1};
    problem.A_phiq = fd::DenseRealMatrixView{a_phiq, 1, 2};
    problem.A_phiphi = fd::DenseRealMatrixView{a_phiphi, 1, 1};
    problem.B_qq = fd::DenseRealMatrixView{b_qq, 2, 2};
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 1;
    return problem;
}

void dense_oracle_filter_excludes_zero_modes_without_rewriting_kinematics()
{
    const double omega_below = 0.5 * fd::kDefaultZeroFrequencyToleranceRadPerS;
    const double a_qq_below[4] = {0.0, -omega_below, omega_below, 0.0};
    const double a_qphi[2] = {0.0, 0.0};
    const double a_phiq[2] = {0.0, 0.0};
    const double a_phiphi[1] = {0.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[1] = {1.0};

    const fd::DensePoissonAirboxEigenOracleProblem below_problem =
        dense_oracle_problem(
            a_qq_below,
            a_qphi,
            a_phiq,
            a_phiphi,
            b_qq,
            weights);
    fd::DensePoissonAirboxEigenOracleResult below_result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(
            below_problem,
            &below_result) == fd::FrequencyDomainStatus::solve_error,
        "dense oracle positive-frequency filter must exclude a below-tolerance zero mode");
    check(
        contains(below_result.diagnostics_json, "\"stable\":true"),
        "unaccepted zero-mode artifacts must preserve mapper stability");
    check(
        contains(below_result.diagnostics_json, "\"finite\":true") &&
            contains(below_result.diagnostics_json, "\"zero_frequency_mode\":true"),
        "dense oracle artifacts must serialize finite and zero-mode mapper fields");
    check(
        contains(below_result.diagnostics_json, "\"eigenpair_found\":false") &&
            contains(below_result.diagnostics_json, "\"eigenpair_accepted\":false"),
        "dense oracle artifacts must keep selection state separate from stability");
    check(
        contains(below_result.diagnostics_json, "exclude_zero_frequency"),
        "dense oracle diagnostics must name the zero-frequency exclusion policy");

    const double omega_above = 2.0 * fd::kDefaultZeroFrequencyToleranceRadPerS;
    const double a_qq_above[4] = {0.0, -omega_above, omega_above, 0.0};
    const fd::DensePoissonAirboxEigenOracleProblem above_problem =
        dense_oracle_problem(
            a_qq_above,
            a_qphi,
            a_phiq,
            a_phiphi,
            b_qq,
            weights);
    fd::DensePoissonAirboxEigenOracleResult above_result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(
            above_problem,
            &above_result) == fd::FrequencyDomainStatus::ok,
        above_result.error_message);
    check(
        above_result.positive_frequency_branch_found,
        "dense oracle filter must accept a positive mode above tolerance");
}

fd::ModalEigenRequest tiny_analytic_modal_request(
    fd::FrequencyDomainPhaseConvention phase_convention)
{
    fd::ModalEigenRequest request{};
    request.operator_request.gamma_rad_s_T = 1.76085963023e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.requested_mode_count = 1;
    request.target_kind = "frequency_window";
    request.target_frequency_hz = 0.25;
    request.frequency_min_hz = 0.0;
    request.frequency_max_hz = 200.0;
    request.residual_tolerance = 1.0e-10;
    request.max_outer_iterations = 32;
    request.max_linear_iterations = 128;
    request.eigensolver_family = 1;
    request.tiny_validation_enabled = 1;
    request.tiny_validation_tangent_dof_count = 2;
    request.phase_convention = phase_convention;
    return request;
}

void tiny_analytic_canonical_lambda_never_reinterprets_decay_as_frequency()
{
    constexpr double decay_rate_per_s = 1.0e3;
    const double below_tolerance_omega_rad_s =
        0.5 * fd::kDefaultZeroFrequencyToleranceRadPerS;
    const double below_stiffness[4] = {
        -decay_rate_per_s,
        -below_tolerance_omega_rad_s,
        below_tolerance_omega_rad_s,
        -decay_rate_per_s,
    };
    const double identity_mass[4] = {1.0, 0.0, 0.0, 1.0};

    for (const fd::FrequencyDomainPhaseConvention phase : {
             fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
             fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t}) {
        fd::ModalEigenRequest request = tiny_analytic_modal_request(phase);
        request.tiny_validation_stiffness_matrix_row_major = below_stiffness;
        request.tiny_validation_mass_matrix_row_major = identity_mass;
        const fd::FrequencyDomainContractResult result =
            fd::solve_modal_eigen_contract(request);

        check(
            result.status == fd::FrequencyDomainStatus::solve_error,
            "tiny canonical damped mode at or below tolerance must be excluded for both phasors");
        check(
            contains(result.diagnostics_json, "\"eigenvalue_representation\":\"canonical_complex_lambda\"") &&
                contains(result.diagnostics_json, "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\"") &&
                contains(result.diagnostics_json, "map_eigenvalue(lambda, phase_convention).frequency_hz"),
            "tiny canonical zero-mode diagnostics must state representation and central mapping");
        check(
            contains(result.result_json, "\"eigenvalue_representation\":\"canonical_complex_lambda\"") &&
                contains(result.result_json, "\"accepted_mode_count\":0"),
            "tiny canonical zero-mode result must preserve representation and rejection");
    }
}

void tiny_analytic_canonical_lambda_selects_above_tolerance_for_both_phasors()
{
    constexpr double decay_rate_per_s = 1.0e3;
    constexpr double omega_rad_s = 1.0;
    constexpr double expected_frequency_hz =
        0.159154943091895335768883763372514;
    const double stiffness[4] = {
        -decay_rate_per_s,
        -omega_rad_s,
        omega_rad_s,
        -decay_rate_per_s,
    };
    const double identity_mass[4] = {1.0, 0.0, 0.0, 1.0};

    for (const fd::FrequencyDomainPhaseConvention phase : {
             fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
             fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t}) {
        fd::ModalEigenRequest request = tiny_analytic_modal_request(phase);
        request.tiny_validation_stiffness_matrix_row_major = stiffness;
        request.tiny_validation_mass_matrix_row_major = identity_mass;
        const fd::FrequencyDomainContractResult result =
            fd::solve_modal_eigen_contract(request);

        check(
            result.status == fd::FrequencyDomainStatus::ok,
            "tiny canonical above-threshold mode must be selected for both phasors");
        check(
            contains(result.diagnostics_json, "\"eigenvalue_representation\":\"canonical_complex_lambda\"") &&
                contains(result.diagnostics_json, "map_eigenvalue(lambda, phase_convention).frequency_hz"),
            "tiny canonical selected-mode diagnostics must state central mapping");
        check_relative_close(
            extract_json_number(result.result_json, "\"frequency_hz\":"),
            expected_frequency_hz,
            1.0e-9,
            "tiny canonical selected frequency must come from Im(lambda)");
        check_relative_close(
            extract_json_number(result.result_json, "\"eigenvalue_real\":"),
            -decay_rate_per_s,
            1.0e-12,
            "tiny canonical result must preserve raw decay in Re(lambda)");
    }
}

void tiny_analytic_diagonal_legacy_frequency_uses_explicit_adapter()
{
    const double stiffness_diagonal[2] = {2.0, 6.0};
    const double mass_diagonal[2] = {1.0, 2.0};

    for (const fd::FrequencyDomainPhaseConvention phase : {
             fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
             fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t}) {
        fd::ModalEigenRequest request = tiny_analytic_modal_request(phase);
        request.frequency_max_hz = 1.0;
        request.tiny_validation_stiffness_diagonal = stiffness_diagonal;
        request.tiny_validation_mass_diagonal = mass_diagonal;
        const fd::FrequencyDomainContractResult result =
            fd::solve_modal_eigen_contract(request);

        check(
            result.status == fd::FrequencyDomainStatus::ok,
            "tiny diagonal legacy angular frequency must remain selectable for both phasors");
        check(
            contains(
                result.diagnostics_json,
                "\"eigenvalue_representation\":\"legacy_real_angular_frequency_diagonal\"") &&
                contains(
                    result.diagnostics_json,
                    "\"eigenvalue_to_frequency\":\"legacy_real_angular_frequency_to_canonical_lambda_then_map_eigenvalue\""),
            "tiny diagonal diagnostics must state the explicit legacy representation adapter");
        check(
            contains(
                result.result_json,
                "\"eigenvalue_representation\":\"legacy_real_angular_frequency_diagonal\""),
            "tiny diagonal result must preserve legacy representation provenance");
    }
}

void tiny_slepc_non_window_maps_both_phasors_and_publishes_provenance()
{
#if FULLMAG_FEM_WITH_SLEPC
    constexpr double decay_rate_per_s = 1.0e3;
    constexpr double omega_rad_s = 1.0;
    const double stiffness[4] = {
        -decay_rate_per_s,
        -omega_rad_s,
        omega_rad_s,
        -decay_rate_per_s,
    };
    const double identity_mass[4] = {1.0, 0.0, 0.0, 1.0};

    for (const auto [phase, expected_lambda_imag] : {
             std::pair{
                 fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                 omega_rad_s},
             std::pair{
                 fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t,
                 -omega_rad_s}}) {
        fd::ModalEigenRequest request = tiny_analytic_modal_request(phase);
        request.target_kind = "nearest_frequency";
        request.target_frequency_hz = 0.159154943091895335768883763372514;
        request.tiny_validation_stiffness_matrix_row_major = stiffness;
        request.tiny_validation_mass_matrix_row_major = identity_mass;
        const fd::FrequencyDomainContractResult result =
            fd::solve_modal_eigen_contract(request);

        check(
            result.status == fd::FrequencyDomainStatus::ok,
            "tiny SLEPc non-window solve must select a positive mode for both phasors");
        check(
            contains(result.result_json, "\"solver_adapter\":\"slepc_modal_eigen\"") &&
                contains(result.result_json, "\"eigenvalue_representation\":\"canonical_complex_lambda\"") &&
                contains(
                    result.result_json,
                    "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase_convention).frequency_hz\"") &&
                contains(result.diagnostics_json, "\"eigenvalue_representation\":\"canonical_complex_lambda\"") &&
                contains(
                    result.diagnostics_json,
                    "\"eigenvalue_to_frequency\":\"map_eigenvalue(lambda, phase_convention).frequency_hz\""),
            "tiny SLEPc non-window diagnostics must publish canonical mapping provenance");
        check_relative_close(
            extract_json_number(result.result_json, "\"eigenvalue_imag\":"),
            expected_lambda_imag,
            1.0e-9,
            "tiny SLEPc non-window solve must apply the requested phasor convention");
    }
#endif
}

} // namespace

int main()
{
    gamma_mu0_and_gamma0_are_equivalent_and_conflicts_reject();
    gamma_consistency_tolerance_has_explicit_boundary_coverage();
    legacy_operator_validation_canonicalizes_gamma0();
    modal_contract_rejects_overflowing_legacy_gamma_pair_before_dispatch();
    excitation_boundary_canonicalizes_and_rejects_invalid_legacy_gamma0();
    hz_and_rad_per_second_round_trip();
    plus_and_minus_phasors_select_opposite_positive_branches();
    damped_conjugate_branches_keep_decay_and_stability();
    zero_and_nonfinite_modes_are_explicit();
    zero_frequency_tolerance_is_absolute_and_policy_is_explicit();
    dense_oracle_filter_excludes_zero_modes_without_rewriting_kinematics();
    tiny_analytic_canonical_lambda_never_reinterprets_decay_as_frequency();
    tiny_analytic_canonical_lambda_selects_above_tolerance_for_both_phasors();
    tiny_analytic_diagonal_legacy_frequency_uses_explicit_adapter();
    tiny_slepc_non_window_maps_both_phasors_and_publishes_provenance();
    if (failure_count != 0) {
        std::fprintf(stderr, "mode kinematics contract failed: %d assertion(s)\n", failure_count);
        return 1;
    }
    std::puts("mode kinematics contract passed");
    return 0;
}
