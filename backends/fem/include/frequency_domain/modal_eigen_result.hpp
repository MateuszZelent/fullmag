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

/*
 * Native execution evidence accumulated by the modal adapter.  This is an
 * internal typed bridge to the caller-sized result v20 sidecar; it is not
 * part of the frozen by-value v18 result layout.  A partial T3 snapshot may
 * attest HYPRE setup while the overall v20 measurement remains unavailable
 * until the complete T4 object graph and digest set have been measured.
 */
struct ModalGpuExecutionAttestation {
    bool hypre_policy_observed = false;
    bool hypre_policy_configured = false;
    bool hypre_memory_location_device = false;
    bool hypre_execution_policy_device = false;
    bool hypre_vendor_sptrans_enabled = false;
    bool hypre_vendor_spmv_enabled = false;
    bool hypre_vendor_spgemm_enabled = false;
    int hypre_first_error_code = 0;
    std::string hypre_failure_reason{};
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
    ModalGpuExecutionAttestation modal_gpu_attestation{};
};

} // namespace fullmag::fem::frequency_domain
