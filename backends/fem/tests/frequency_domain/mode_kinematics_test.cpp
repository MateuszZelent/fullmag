#include "frequency_domain/mode_kinematics.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <limits>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_relative_close(double actual, double expected, double tolerance, const char *message)
{
    const double scale = std::fmax(std::fmax(std::abs(actual), std::abs(expected)), 1.0e-30);
    check(std::abs(actual - expected) <= tolerance * scale, message);
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

} // namespace

int main()
{
    gamma_mu0_and_gamma0_are_equivalent_and_conflicts_reject();
    hz_and_rad_per_second_round_trip();
    plus_and_minus_phasors_select_opposite_positive_branches();
    damped_conjugate_branches_keep_decay_and_stability();
    zero_and_nonfinite_modes_are_explicit();
    std::puts("mode kinematics contract passed");
    return 0;
}
