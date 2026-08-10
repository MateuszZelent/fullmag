#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct ModalEigenTypedResult {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::vector<std::complex<double>> mode_lambda{};
    std::vector<std::complex<double>> mode_q_complex{};
    std::vector<std::complex<double>> mode_phi_complex{};
    std::vector<std::complex<double>> mode_delta_m_xyz_complex{};
    std::vector<double> mode_residuals{};
    std::vector<std::uint64_t> mode_cluster_ids{};
};

enum class ModalResolvedFallbackState : std::uint32_t {
    none = 0,
    explicit_fallback = 1,
};

struct ModalExecutionProvenance {
    std::uint32_t execution_target = 0;
    std::uint32_t scalar_representation = 1;
    std::uint32_t spectral_transform_kind = 0;
    ModalResolvedFallbackState fallback_state = ModalResolvedFallbackState::none;
    std::string engine_id = "unavailable";
    std::string fallback_reason = "none";
};

struct ModalCertificateBindingProvenance {
    std::uint32_t status = 0;
    std::string canonical_preimage_sha256{};
    std::string reason = "none";
};

struct FrequencyDomainContractResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    std::string error_message;
    std::string diagnostics_json;
    std::string result_json;
    std::string artifact_manifest_path;
    ModalEigenTypedResult modal_eigen{};
    ModalExecutionProvenance modal_execution{};
    ModalCertificateBindingProvenance certificate_binding{};
};

} // namespace fullmag::fem::frequency_domain
