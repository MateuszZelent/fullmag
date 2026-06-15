#pragma once

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kFrequencyDomainAbiVersion = 1;

struct LinearizedOperatorRequest {
    std::uint32_t abi_version = kFrequencyDomainAbiVersion;
    const char *mesh_asset_id = nullptr;
    const char *equilibrium_source_kind = nullptr;
    double gamma_rad_s_T = 0.0;
    double mu0_T_m_A = 0.0;
    double alpha = 0.0;
    int include_exchange = 0;
    int include_demag = 0;
    const char *demag_realization = nullptr;
    const char *damping_policy = nullptr;
    const char *spin_wave_bc_kind = nullptr;
    const double *k_vector_rad_m = nullptr;
    int k_vector_len = 0;
    const char *operator_diagnostics_json = nullptr;
};

struct ModalEigenRequest {
    std::uint32_t abi_version = kFrequencyDomainAbiVersion;
    LinearizedOperatorRequest operator_request{};
    int requested_mode_count = 0;
    const char *target_kind = nullptr;
    double target_frequency_hz = 0.0;
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    double residual_tolerance = 0.0;
    int max_outer_iterations = 0;
    int max_linear_iterations = 0;
    const char *output_directory = nullptr;
    int write_partial_artifacts = 0;
    int completeness_policy = 0;
    int eigensolver_family = 0;
    int spectral_transform_kind = 0;
    void *cancel_user_data = nullptr;
    int (*cancel_requested)(void *user_data) = nullptr;
    void *progress_user_data = nullptr;
    void (*progress_callback)(void *user_data, const char *progress_json) = nullptr;
};

struct DrivenResponseContractRequest {
    std::uint32_t abi_version = kFrequencyDomainAbiVersion;
    LinearizedOperatorRequest operator_request{};
    const double *frequencies_hz = nullptr;
    int frequency_count = 0;
    const double *excitation_field_A_m = nullptr;
    int excitation_field_len = 0;
    double excitation_phase_rad = 0.0;
    double residual_tolerance = 0.0;
    int max_linear_iterations = 0;
    const char *output_directory = nullptr;
    int write_partial_artifacts = 0;
    void *cancel_user_data = nullptr;
    int (*cancel_requested)(void *user_data) = nullptr;
    void *progress_user_data = nullptr;
    void (*progress_callback)(void *user_data, const char *progress_json) = nullptr;
};

} // namespace fullmag::fem::frequency_domain
