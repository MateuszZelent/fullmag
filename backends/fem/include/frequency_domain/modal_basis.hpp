#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace fullmag::fem::frequency_domain {

enum class ModalBasisPolicy : std::uint32_t {
    use_existing_required = 1,
    use_existing_or_compute = 2,
    force_recompute = 3,
};

enum class ModalBasisCompletenessPolicy : std::uint32_t {
    best_effort = 0,
    certified_count = 1,
};

enum class ModalBasisCompletenessStatus : std::uint32_t {
    not_certified = 0,
    certified = 1,
    partial_convergence = 2,
    truncated_by_requested_count = 3,
    window_exhausted = 4,
};

enum class ModalBasisCompletenessMethod : std::uint32_t {
    none = 0,
    contour_interval_count = 1,
    sparse_direct_sample = 2,
};

struct ModalBasisCacheKeyInput {
    const char *operator_signature = nullptr;
    const char *equilibrium_signature = nullptr;
    const char *material_signature = nullptr;
    const char *boundary_signature = nullptr;
    const char *demag_signature = nullptr;
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
};

struct ModalBasisCacheKey {
    char value[512] = "";
    char error_message[128] = "";
};

struct ModalBasisCompletenessCertificate {
    ModalBasisCompletenessPolicy policy = ModalBasisCompletenessPolicy::best_effort;
    ModalBasisCompletenessStatus status = ModalBasisCompletenessStatus::not_certified;
    ModalBasisCompletenessMethod certification_method =
        ModalBasisCompletenessMethod::none;
    int estimated_modes_in_window = 0;
    int certified_modes_in_window = 0;
    int returned_modes = 0;
    int accepted_modes_before_cap = 0;
    bool result_truncated = false;
    double max_eigenmode_relative_residual = 0.0;
    double max_allowed_eigenmode_relative_residual = 0.0;
};

struct ModalBasisCompletenessDecision {
    bool allowed = false;
    bool additional_modes_may_exist = true;
    char reason[128] = "";
};

inline bool modal_basis_signature_present(const char *value) noexcept
{
    return value != nullptr && value[0] != '\0';
}

inline const char *modal_basis_phase_token(
    FrequencyDomainPhaseConvention convention) noexcept
{
    switch (convention) {
    case FrequencyDomainPhaseConvention::exp_i_omega_t:
        return "exp_plus_i_omega_t";
    case FrequencyDomainPhaseConvention::exp_minus_i_omega_t:
        return "exp_minus_i_omega_t";
    }
    return nullptr;
}

inline void modal_basis_copy_error(
    ModalBasisCacheKey *out_key,
    const char *message) noexcept
{
    if (out_key == nullptr) {
        return;
    }
    std::strncpy(out_key->error_message, message, sizeof(out_key->error_message) - 1);
    out_key->error_message[sizeof(out_key->error_message) - 1] = '\0';
}

inline const char *modal_basis_completeness_status_token(
    ModalBasisCompletenessStatus status) noexcept
{
    switch (status) {
    case ModalBasisCompletenessStatus::not_certified:
        return "not_certified";
    case ModalBasisCompletenessStatus::certified:
        return "certified";
    case ModalBasisCompletenessStatus::partial_convergence:
        return "partial_convergence";
    case ModalBasisCompletenessStatus::truncated_by_requested_count:
        return "truncated_by_requested_count";
    case ModalBasisCompletenessStatus::window_exhausted:
        return "window_exhausted";
    }
    return "unknown";
}

inline void modal_basis_write_decision(
    ModalBasisCompletenessDecision *decision,
    bool allowed,
    bool additional_modes_may_exist,
    const char *reason) noexcept
{
    if (decision == nullptr) {
        return;
    }
    *decision = ModalBasisCompletenessDecision{};
    decision->allowed = allowed;
    decision->additional_modes_may_exist = additional_modes_may_exist;
    std::strncpy(decision->reason, reason, sizeof(decision->reason) - 1);
    decision->reason[sizeof(decision->reason) - 1] = '\0';
}

inline bool modal_basis_completeness_allows_response(
    const ModalBasisCompletenessCertificate &certificate,
    ModalBasisCompletenessDecision *decision) noexcept
{
    const char *status_token =
        modal_basis_completeness_status_token(certificate.status);
    if (certificate.policy != ModalBasisCompletenessPolicy::certified_count) {
        modal_basis_write_decision(
            decision,
            false,
            true,
            status_token);
        return false;
    }
    if (certificate.status != ModalBasisCompletenessStatus::certified) {
        modal_basis_write_decision(
            decision,
            false,
            true,
            status_token);
        return false;
    }
    if (certificate.certification_method == ModalBasisCompletenessMethod::none) {
        modal_basis_write_decision(
            decision,
            false,
            true,
            "not_certified");
        return false;
    }
    if (certificate.result_truncated ||
        certificate.returned_modes < certificate.accepted_modes_before_cap ||
        certificate.certified_modes_in_window < certificate.estimated_modes_in_window) {
        modal_basis_write_decision(
            decision,
            false,
            true,
            "truncated_by_requested_count");
        return false;
    }
    if (!std::isfinite(certificate.max_eigenmode_relative_residual) ||
        !std::isfinite(certificate.max_allowed_eigenmode_relative_residual) ||
        certificate.max_allowed_eigenmode_relative_residual <= 0.0 ||
        certificate.max_eigenmode_relative_residual >
            certificate.max_allowed_eigenmode_relative_residual) {
        modal_basis_write_decision(
            decision,
            false,
            true,
            "residual_not_certified");
        return false;
    }

    modal_basis_write_decision(decision, true, false, "certified");
    return true;
}

inline FrequencyDomainStatus build_modal_basis_cache_key(
    const ModalBasisCacheKeyInput &input,
    ModalBasisCacheKey *out_key) noexcept
{
    if (out_key == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_key = ModalBasisCacheKey{};
    if (!modal_basis_signature_present(input.operator_signature)) {
        modal_basis_copy_error(out_key, "modal basis cache key requires operator signature");
        return FrequencyDomainStatus::validation_error;
    }
    if (!modal_basis_signature_present(input.equilibrium_signature)) {
        modal_basis_copy_error(out_key, "modal basis cache key requires equilibrium signature");
        return FrequencyDomainStatus::validation_error;
    }
    if (!modal_basis_signature_present(input.material_signature)) {
        modal_basis_copy_error(out_key, "modal basis cache key requires material signature");
        return FrequencyDomainStatus::validation_error;
    }
    if (!modal_basis_signature_present(input.boundary_signature)) {
        modal_basis_copy_error(out_key, "modal basis cache key requires boundary signature");
        return FrequencyDomainStatus::validation_error;
    }
    if (!modal_basis_signature_present(input.demag_signature)) {
        modal_basis_copy_error(out_key, "modal basis cache key requires demag signature");
        return FrequencyDomainStatus::validation_error;
    }
    const char *phase_token = modal_basis_phase_token(input.phase_convention);
    if (phase_token == nullptr) {
        modal_basis_copy_error(out_key, "modal basis cache key requires known phase convention");
        return FrequencyDomainStatus::validation_error;
    }
    if (!std::isfinite(input.frequency_min_hz) ||
        !std::isfinite(input.frequency_max_hz) ||
        input.frequency_min_hz < 0.0 ||
        !(input.frequency_min_hz < input.frequency_max_hz)) {
        modal_basis_copy_error(out_key, "modal basis cache key requires a valid frequency window");
        return FrequencyDomainStatus::validation_error;
    }

    const int written = std::snprintf(
        out_key->value,
        sizeof(out_key->value),
        "operator=%s|equilibrium=%s|material=%s|boundary=%s|demag=%s|phase=%s|frequency_window_hz=[%.17g,%.17g]",
        input.operator_signature,
        input.equilibrium_signature,
        input.material_signature,
        input.boundary_signature,
        input.demag_signature,
        phase_token,
        input.frequency_min_hz,
        input.frequency_max_hz);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(out_key->value)) {
        modal_basis_copy_error(out_key, "modal basis cache key exceeds fixed buffer");
        out_key->value[0] = '\0';
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
