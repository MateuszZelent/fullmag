#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemOperatorContextDescriptor;
struct EquilibriumStateDiagnostics;

enum class FrequencyDomainBoundaryKind {
    open_boundary,
    periodic_zero_phase,
    floquet_bloch,
};

enum class FrequencyDomainDemagKind {
    none,
    static_k0,
    dynamic_k,
};

enum class FrequencyDomainExcitationKind {
    uniform_field,
    field_resource,
    current_torque,
};

struct FrequencyDomainOperatorRequest {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    FrequencyDomainBoundaryKind boundary_kind = FrequencyDomainBoundaryKind::open_boundary;
    FrequencyDomainDemagKind demag_kind = FrequencyDomainDemagKind::none;
    double alpha = 0.0;
    double gamma0 = 0.0;
    bool include_exchange = false;
    bool include_zeeman = false;
    bool strict_gpu = false;
};

struct FrequencyDomainOperatorValidationDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    double alpha = 0.0;
    double gamma0 = 0.0;
    char error_message[128] = "";
};

struct LinearizedLlgOperatorDiagnostics {
    std::uint64_t active_node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    bool exchange_enabled = false;
    bool zeeman_enabled = false;
    bool uniaxial_anisotropy_enabled = false;
    bool dmi_enabled = false;
    bool demag_enabled = false;
    char frequency_units[16] = "";
    char angular_frequency_units[16] = "";
    char field_units[16] = "";
    double equilibrium_norm_error_max_abs = 0.0;
    double equilibrium_residual_max_abs = 0.0;
    double equilibrium_residual_rms = 0.0;
    char demag_realization[64] = "";
    char error_message[128] = "";
};

struct DrivenFrequencyResponseRequest {
    FrequencyDomainOperatorRequest operator_request{};
    const double *frequencies_hz = nullptr;
    std::uint64_t frequency_count = 0;
    FrequencyDomainExcitationKind excitation_kind = FrequencyDomainExcitationKind::uniform_field;
    bool write_response_fields = false;
};

struct ModalDynamicMatrixRequest {
    FrequencyDomainOperatorRequest operator_request{};
    std::uint64_t mode_count = 0;
    double target_frequency_hz = 0.0;
    bool branch_tracking = false;
    bool write_mode_fields = false;
};

struct FrequencyDomainSolveRequestDiagnostics {
    FrequencyDomainStudyKind study_kind = FrequencyDomainStudyKind::driven_frequency_response;
    std::uint64_t frequency_count = 0;
    std::uint64_t invalid_frequency_count = 0;
    std::uint64_t mode_count = 0;
    char error_message[128] = "";
};

FrequencyDomainStatus validate_frequency_domain_operator_request(
    const FrequencyDomainOperatorRequest &request,
    FrequencyDomainOperatorValidationDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus validate_driven_frequency_response_request(
    const DrivenFrequencyResponseRequest &request,
    FrequencyDomainSolveRequestDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus validate_modal_dynamic_matrix_request(
    const ModalDynamicMatrixRequest &request,
    FrequencyDomainSolveRequestDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus build_linearized_llg_operator_diagnostics(
    const MfemOperatorContextDescriptor &descriptor,
    const EquilibriumStateDiagnostics &equilibrium_diagnostics,
    const char *demag_realization,
    LinearizedLlgOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
