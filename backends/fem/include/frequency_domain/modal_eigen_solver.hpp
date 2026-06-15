#pragma once

#include "frequency_domain/modal_eigen_request.hpp"
#include "frequency_domain/modal_eigen_result.hpp"

namespace fullmag::fem::frequency_domain {

FrequencyDomainContractResult solve_modal_eigen_contract(
    const ModalEigenRequest &request) noexcept;

FrequencyDomainContractResult solve_driven_response_contract(
    const DrivenResponseContractRequest &request) noexcept;

FrequencyDomainContractResult production_cpu_modal_eigen_unavailable(
    const ModalEigenRequest &request) noexcept;

} // namespace fullmag::fem::frequency_domain
