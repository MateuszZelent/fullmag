#include "frequency_domain/mode_kinematics.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

void copy_error(char *destination, std::size_t capacity, const char *message) noexcept
{
    if (destination == nullptr || capacity == 0) {
        return;
    }
    std::snprintf(destination, capacity, "%s", message != nullptr ? message : "");
}

bool phase_convention_valid(FrequencyDomainPhaseConvention phase) noexcept
{
    return phase == FrequencyDomainPhaseConvention::exp_i_omega_t ||
        phase == FrequencyDomainPhaseConvention::exp_minus_i_omega_t;
}

} // namespace

FrequencyDomainStatus canonicalize_dynamic_pencil_metadata(
    const DynamicPencilMetadata &metadata,
    DynamicPencilMetadata *out_metadata,
    char *error_message,
    std::size_t error_message_capacity) noexcept
{
    if (out_metadata == nullptr) {
        copy_error(error_message, error_message_capacity, "dynamic pencil metadata output is null");
        return FrequencyDomainStatus::validation_error;
    }
    *out_metadata = {};
    copy_error(error_message, error_message_capacity, "");

    if (!phase_convention_valid(metadata.phase_convention)) {
        copy_error(error_message, error_message_capacity, "dynamic pencil phase convention is invalid");
        return FrequencyDomainStatus::validation_error;
    }

    const bool has_gamma_abs = metadata.gamma_abs_rad_per_s_t != 0.0;
    const bool has_mu0 = metadata.mu0_t_m_per_a != 0.0;
    const bool has_gamma0 = metadata.gamma0_m_per_a_s != 0.0;
    if (has_gamma_abs != has_mu0) {
        copy_error(error_message, error_message_capacity, "gamma and mu0 must be supplied together");
        return FrequencyDomainStatus::validation_error;
    }
    if (!has_gamma0 && !has_gamma_abs) {
        copy_error(error_message, error_message_capacity, "gamma0 or gamma with mu0 is required");
        return FrequencyDomainStatus::validation_error;
    }
    if ((has_gamma_abs &&
         (!(metadata.gamma_abs_rad_per_s_t > 0.0) ||
          !std::isfinite(metadata.gamma_abs_rad_per_s_t) ||
          !(metadata.mu0_t_m_per_a > 0.0) ||
          !std::isfinite(metadata.mu0_t_m_per_a))) ||
        (has_gamma0 &&
         (!(metadata.gamma0_m_per_a_s > 0.0) ||
          !std::isfinite(metadata.gamma0_m_per_a_s)))) {
        copy_error(error_message, error_message_capacity, "dynamic pencil gamma values must be finite and positive");
        return FrequencyDomainStatus::validation_error;
    }

    const double derived_gamma0_m_per_a_s = has_gamma_abs
        ? metadata.gamma_abs_rad_per_s_t * metadata.mu0_t_m_per_a
        : metadata.gamma0_m_per_a_s;
    if (!std::isfinite(derived_gamma0_m_per_a_s) || !(derived_gamma0_m_per_a_s > 0.0)) {
        copy_error(error_message, error_message_capacity, "derived gamma0 is non-finite or non-positive");
        return FrequencyDomainStatus::validation_error;
    }
    if (has_gamma_abs && has_gamma0) {
        const double scale = std::max(
            std::abs(derived_gamma0_m_per_a_s),
            std::abs(metadata.gamma0_m_per_a_s));
        if (std::abs(derived_gamma0_m_per_a_s - metadata.gamma0_m_per_a_s) >
            kGammaConsistencyRelativeTolerance * scale) {
            copy_error(error_message, error_message_capacity, "gamma, mu0 and gamma0 conflict");
            return FrequencyDomainStatus::validation_error;
        }
    }

    *out_metadata = metadata;
    out_metadata->gamma0_m_per_a_s = derived_gamma0_m_per_a_s;
    out_metadata->field_units = "A/m";
    return FrequencyDomainStatus::ok;
}

DynamicPencilMetadata dynamic_pencil_metadata_from_legacy_gamma0(
    double legacy_gamma0_m_per_a_s,
    FrequencyDomainPhaseConvention phase_convention) noexcept
{
    DynamicPencilMetadata metadata{};
    metadata.gamma0_m_per_a_s = legacy_gamma0_m_per_a_s;
    metadata.phase_convention = phase_convention;
    return metadata;
}

DynamicPencilMetadata dynamic_pencil_metadata_from_legacy_gamma_mu0(
    double legacy_gamma_abs_rad_per_s_t,
    double legacy_mu0_t_m_per_a,
    FrequencyDomainPhaseConvention phase_convention) noexcept
{
    DynamicPencilMetadata metadata{};
    metadata.gamma_abs_rad_per_s_t = legacy_gamma_abs_rad_per_s_t;
    metadata.mu0_t_m_per_a = legacy_mu0_t_m_per_a;
    metadata.phase_convention = phase_convention;
    return metadata;
}

double omega_rad_s_from_frequency_hz(double frequency_hz) noexcept
{
    return kTwoPi * frequency_hz;
}

double frequency_hz_from_omega_rad_s(double omega_rad_s) noexcept
{
    return omega_rad_s / kTwoPi;
}

ModeKinematics map_eigenvalue(
    ComplexEigenvalue lambda,
    FrequencyDomainPhaseConvention phase) noexcept
{
    ModeKinematics result{};
    result.lambda = lambda;
    if (!std::isfinite(lambda.real_per_s) ||
        !std::isfinite(lambda.imag_rad_per_s) ||
        !phase_convention_valid(phase)) {
        return result;
    }

    const double phase_sign =
        phase == FrequencyDomainPhaseConvention::exp_i_omega_t ? 1.0 : -1.0;
    const double signed_omega_rad_s = phase_sign * lambda.imag_rad_per_s;
    const double zero_scale = std::max(
        {1.0, std::abs(lambda.real_per_s), std::abs(lambda.imag_rad_per_s)});
    const double zero_tolerance =
        64.0 * std::numeric_limits<double>::epsilon() * zero_scale;

    result.finite = true;
    result.decay_rate_per_s = -lambda.real_per_s;
    result.stable = lambda.real_per_s <= 0.0;
    if (std::abs(signed_omega_rad_s) <= zero_tolerance) {
        result.zero_frequency_mode = true;
        return result;
    }

    result.omega_rad_s = signed_omega_rad_s;
    result.frequency_hz = frequency_hz_from_omega_rad_s(signed_omega_rad_s);
    result.branch_sign = signed_omega_rad_s > 0.0 ? 1 : -1;
    return result;
}

} // namespace fullmag::fem::frequency_domain
