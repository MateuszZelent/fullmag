#pragma once

#include "cpu/frequency_domain/mfem_operator_context.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemTangentSpaceLayout {
    std::uint64_t node_count = 0;
    std::uint64_t full_dof_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t full_components_per_node = 3;
    std::uint64_t tangent_components_per_node = 2;
    std::uint64_t tangent_stride = 2;
    std::uint64_t e1_component_offset = 0;
    std::uint64_t e2_component_offset = 1;
};

struct MfemTangentSpaceDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t full_dof_count = 0;
    std::uint64_t tangent_dof_count = 0;
    char error_message[128] = "";
};

FrequencyDomainStatus build_mfem_tangent_space_layout(
    const MfemOperatorContextDescriptor &descriptor,
    MfemTangentSpaceLayout *out_layout,
    MfemTangentSpaceDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
