#pragma once

#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "frequency_domain/zeeman_operator.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemZeemanOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    double max_parallel_field_abs = 0.0;
    double max_transverse_field_abs = 0.0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus apply_mfem_zeeman_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const double h_ext_a_per_m[3],
    TangentOperatorLocalBlock *workspace_blocks,
    const double *tangent_in,
    double *out_tangent,
    MfemZeemanOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
