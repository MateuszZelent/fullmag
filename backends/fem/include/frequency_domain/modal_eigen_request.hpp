#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/mode_kinematics.hpp"
#include "fullmag_fem.h"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kFrequencyDomainLegacyAbiVersion = 12;
constexpr std::uint32_t kFrequencyDomainPriorAbiVersion = 13;
constexpr std::uint32_t kFrequencyDomainPreviousAbiVersion = 14;
constexpr std::uint32_t kFrequencyDomainV15AbiVersion = 15;
constexpr std::uint32_t kFrequencyDomainV16AbiVersion = 16;
constexpr std::uint32_t kFrequencyDomainV17AbiVersion = 17;
constexpr std::uint32_t kFrequencyDomainV18AbiVersion = 18;
constexpr std::uint32_t kFrequencyDomainAbiVersion = 19;

enum class ModalExecutionTarget : std::uint32_t {
    auto_select = 0,
    production_cpu = 1,
    production_gpu = 2,
    // Resolved-result lane only; public requests must use an execution lane.
    validation = 3,
};

enum class ModalScalarRepresentation : std::uint32_t {
    real_split = 0,
    complex_double = 1,
};

enum class ModalResultFieldRepresentation : std::uint32_t {
    tangent_q = 0,
    cartesian_delta_m = 1,
    tangent_q_and_cartesian_delta_m = 2,
};

enum class ModalSpectralTransformKind : std::uint32_t {
    auto_select = 0,
    shift_invert = 1,
};

struct LinearizedOperatorRequest {
    std::uint32_t abi_version = kFrequencyDomainAbiVersion;
    std::uint32_t struct_size = 0;
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

inline DynamicPencilMetadata dynamic_pencil_metadata_from_legacy_operator_request(
    const LinearizedOperatorRequest &request,
    FrequencyDomainPhaseConvention phase_convention) noexcept
{
    return dynamic_pencil_metadata_from_legacy_gamma_mu0(
        request.gamma_rad_s_T,
        request.mu0_T_m_A,
        phase_convention);
}

struct CsrMatrixView {
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
    const std::uint32_t *row_offsets = nullptr;
    std::uint64_t row_offsets_len = 0;
    const std::uint32_t *column_indices = nullptr;
    std::uint64_t column_indices_len = 0;
    const double *values = nullptr;
    std::uint64_t values_len = 0;
};

struct ModalEigenRequest {
    std::uint32_t abi_version = kFrequencyDomainAbiVersion;
    std::uint32_t struct_size = 0;
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
    ModalSpectralTransformKind spectral_transform_kind =
        ModalSpectralTransformKind::auto_select;
    void *cancel_user_data = nullptr;
    int (*cancel_requested)(void *user_data) = nullptr;
    void *progress_user_data = nullptr;
    void (*progress_callback)(void *user_data, const char *progress_json) = nullptr;
    int tiny_validation_enabled = 0;
    std::uint64_t tiny_validation_tangent_dof_count = 0;
    const double *tiny_validation_stiffness_matrix_row_major = nullptr;
    const double *tiny_validation_mass_matrix_row_major = nullptr;
    const double *tiny_validation_stiffness_diagonal = nullptr;
    const double *tiny_validation_mass_diagonal = nullptr;
    int mfem_operator_enabled = 0;
    std::uint64_t mfem_tangent_dof_count = 0;
    const double *mfem_stiffness_matrix_row_major = nullptr;
    const double *mfem_gyrotropic_matrix_row_major = nullptr;
    const double *mfem_mass_matrix_row_major = nullptr;
    // Immutable MFEM magnetic-JVP dependency descriptor supplied by the
    // payload owner.  This is consumed only by magnetic modal routes; Poisson
    // descriptor blocks intentionally have a separate identity.
    const char *mfem_linearized_pencil_dependency_digest = nullptr;
    // Canonical gamma0 used when the MFEM payload materialized L and B_alpha.
    // A positive value takes precedence over the legacy gamma/mu0 request
    // representation while reconstructing the payload pencil identity.
    double mfem_linearized_pencil_gamma0_m_per_a_s = 0.0;
    int mfem_sparse_operator_enabled = 0;
    CsrMatrixView mfem_sparse_stiffness_csr{};
    CsrMatrixView mfem_sparse_gyrotropic_csr{};
    CsrMatrixView mfem_sparse_mass_csr{};
    bool has_floquet_k_vector = false;
    double floquet_k_vector_rad_per_m[3] = {0.0, 0.0, 0.0};
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
    const FrequencyDomainFloquetPeriodicPair *floquet_periodic_pairs = nullptr;
    std::uint64_t floquet_periodic_pair_count = 0;
    int poisson_airbox_block_enabled = 0;
    std::uint64_t poisson_airbox_q_dof_count = 0;
    std::uint64_t poisson_airbox_phi_dof_count = 0;
    CsrMatrixView poisson_airbox_a_qq_csr{};
    CsrMatrixView poisson_airbox_a_qphi_csr{};
    CsrMatrixView poisson_airbox_a_phiq_csr{};
    CsrMatrixView poisson_airbox_a_phiphi_csr{};
    CsrMatrixView poisson_airbox_b_qq_csr{};
    const double *poisson_airbox_phi_mean_weights = nullptr;
    std::uint64_t poisson_airbox_phi_mean_weights_count = 0;
    double poisson_airbox_target_frequency_hz = 0.0;
    double poisson_airbox_expected_reference_frequency_hz = 0.0;
    const char *poisson_airbox_periodic_mesh_certificate_schema = nullptr;
    std::uint64_t poisson_airbox_magnetic_pair_count = 0;
    std::uint64_t poisson_airbox_airbox_pair_count = 0;
    int poisson_airbox_shift_invert_action_enabled = 0;
    int poisson_airbox_shift_invert_action_device = 0;
    double poisson_airbox_shift_sigma_real = 0.0;
    double poisson_airbox_shift_sigma_imag = 0.0;
    const double *poisson_airbox_shift_action_vector_real = nullptr;
    const double *poisson_airbox_shift_action_vector_imag = nullptr;
    std::uint64_t poisson_airbox_shift_action_vector_count = 0;
    const char *poisson_airbox_outer_boundary_kind = nullptr;
    double poisson_airbox_robin_beta = 0.0;
    const char *poisson_airbox_gauge_policy = nullptr;
    const char *poisson_airbox_gauge_reason = nullptr;
    const char *poisson_airbox_assembly_kind = nullptr;
    const double *dynamic_demag_k_tangent_matrix_row_major = nullptr;
    std::uint64_t dynamic_demag_k_tangent_matrix_value_count = 0;
    ModalExecutionTarget execution_target = ModalExecutionTarget::auto_select;
    ModalScalarRepresentation scalar_representation = ModalScalarRepresentation::complex_double;
    ModalResultFieldRepresentation result_field_representation =
        ModalResultFieldRepresentation::tangent_q;
    /* Physical shared-domain mesh/material/equilibrium payload.  This is
       intentionally separate from the legacy synthetic CSR descriptor. */
    int poisson_airbox_shared_domain_enabled = 0;
    const FullmagFemModalSharedDomainPayload *poisson_airbox_shared_domain_payload = nullptr;
};

struct DrivenResponseContractRequest {
    std::uint32_t abi_version = kFrequencyDomainAbiVersion;
    std::uint32_t struct_size = 0;
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
