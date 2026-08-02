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

struct FrequencyDomainContractResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    std::string error_message;
    std::string diagnostics_json;
    std::string result_json;
    std::string artifact_manifest_path;
    ModalEigenTypedResult modal_eigen{};
};

} // namespace fullmag::fem::frequency_domain
