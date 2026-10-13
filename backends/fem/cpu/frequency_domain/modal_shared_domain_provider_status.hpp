#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

namespace fullmag::fem::frequency_domain {

constexpr FrequencyDomainStatus resolve_shared_domain_provider_terminal_status(
    FrequencyDomainStatus provider_status,
    bool output_complete) noexcept
{
    if (provider_status != FrequencyDomainStatus::ok) {
        return provider_status;
    }
    return output_complete
        ? FrequencyDomainStatus::ok
        : FrequencyDomainStatus::operator_error;
}

} // namespace fullmag::fem::frequency_domain
