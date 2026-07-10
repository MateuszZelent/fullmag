#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstddef>

namespace fullmag::fem::frequency_domain {

constexpr double kGammaConsistencyRelativeTolerance = 1.0e-12;
constexpr double kDefaultZeroFrequencyToleranceRadPerS = 1.0e-9;

struct DynamicPencilMetadata {
    double gamma_abs_rad_per_s_t = 0.0;
    double mu0_t_m_per_a = 0.0;
    double gamma0_m_per_a_s = 0.0;
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
    const char *field_units = "A/m";
};

struct ComplexEigenvalue {
    double real_per_s = 0.0;
    double imag_rad_per_s = 0.0;
};

struct ModeKinematics {
    ComplexEigenvalue lambda{};
    double omega_rad_s = 0.0;
    double frequency_hz = 0.0;
    double decay_rate_per_s = 0.0;
    int branch_sign = 0;
    bool finite = false;
    bool stable = false;
    bool zero_frequency_mode = false;
};

struct ModeKinematicsPolicy {
    double zero_frequency_tolerance_rad_per_s =
        kDefaultZeroFrequencyToleranceRadPerS;
};

enum class ZeroFrequencyModePolicy {
    exclude,
    include,
};

FrequencyDomainStatus canonicalize_dynamic_pencil_metadata(
    const DynamicPencilMetadata &metadata,
    DynamicPencilMetadata *out_metadata,
    char *error_message,
    std::size_t error_message_capacity) noexcept;

DynamicPencilMetadata dynamic_pencil_metadata_from_legacy_gamma0(
    double legacy_gamma0_m_per_a_s,
    FrequencyDomainPhaseConvention phase_convention) noexcept;

DynamicPencilMetadata dynamic_pencil_metadata_from_legacy_gamma_mu0(
    double legacy_gamma_abs_rad_per_s_t,
    double legacy_mu0_t_m_per_a,
    FrequencyDomainPhaseConvention phase_convention) noexcept;

double omega_rad_s_from_frequency_hz(double frequency_hz) noexcept;
double frequency_hz_from_omega_rad_s(double omega_rad_s) noexcept;

ModeKinematics map_eigenvalue(
    ComplexEigenvalue lambda,
    FrequencyDomainPhaseConvention phase) noexcept;

ModeKinematics map_eigenvalue(
    ComplexEigenvalue lambda,
    FrequencyDomainPhaseConvention phase,
    ModeKinematicsPolicy policy) noexcept;

bool select_positive_frequency_mode(
    const ModeKinematics &kinematics,
    ZeroFrequencyModePolicy zero_frequency_policy) noexcept;

} // namespace fullmag::fem::frequency_domain
