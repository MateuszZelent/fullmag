#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct EquilibriumStateDiagnostics {
    std::uint64_t node_count = 0;
    double max_norm_error = 0.0;
    double max_m_cross_h_abs = 0.0;
    double rms_m_cross_h_abs = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus build_equilibrium_state(
    const double *equilibrium_xyz,
    const double *static_field_xyz,
    std::uint64_t node_count,
    double max_allowed_m_cross_h_abs,
    TangentFrameNode *out_nodes,
    EquilibriumStateDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
