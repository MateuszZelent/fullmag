#pragma once

#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct ZeemanTangentOperatorDiagnostics {
    std::uint64_t node_count = 0;
    double max_parallel_field_abs = 0.0;
    double max_transverse_field_abs = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus build_zeeman_tangent_blocks(
    const TangentFrameNode *nodes,
    const double h_ext_a_per_m[3],
    std::uint64_t node_count,
    TangentOperatorLocalBlock *out_blocks,
    ZeemanTangentOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
