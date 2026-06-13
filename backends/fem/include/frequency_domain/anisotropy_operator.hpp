#pragma once

#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct UniaxialAnisotropyTangentOperatorDiagnostics {
    std::uint64_t node_count = 0;
    double anisotropy_field_a_per_m = 0.0;
    double max_abs_axis_tangent = 0.0;
    double max_abs_block_coeff = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus build_uniaxial_anisotropy_tangent_blocks(
    const TangentFrameNode *nodes,
    const double axis[3],
    double anisotropy_field_a_per_m,
    std::uint64_t node_count,
    TangentOperatorLocalBlock *out_blocks,
    UniaxialAnisotropyTangentOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
