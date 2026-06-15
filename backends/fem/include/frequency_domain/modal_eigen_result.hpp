#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <string>

namespace fullmag::fem::frequency_domain {

struct FrequencyDomainContractResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    std::string error_message;
    std::string diagnostics_json;
    std::string result_json;
    std::string artifact_manifest_path;
};

} // namespace fullmag::fem::frequency_domain
