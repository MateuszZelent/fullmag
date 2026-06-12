#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

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

} // namespace fullmag::fem::frequency_domain
