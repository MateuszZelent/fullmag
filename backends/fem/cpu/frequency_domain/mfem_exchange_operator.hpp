#pragma once

#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "frequency_domain/operator_terms.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemExchangeOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t edge_count = 0;
    std::uint64_t invalid_edge_count = 0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus apply_mfem_exchange_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    double *out_tangent,
    MfemExchangeOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
