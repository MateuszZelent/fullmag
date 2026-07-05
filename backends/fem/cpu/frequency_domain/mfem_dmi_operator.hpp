#pragma once

#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "frequency_domain/operator_terms.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemDmiOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t element_count = 0;
    double max_abs_output = 0.0;
    double max_abs_residual = 0.0;
    double max_abs_full_field = 0.0;
    char error_message[128] = "";
};

enum class MfemDmiInteractionKind : std::uint32_t {
    interfacial,
    bulk,
};

struct MfemDmiElementTangentData {
    MfemDmiInteractionKind kind = MfemDmiInteractionKind::interfacial;
    std::uint32_t node_indices[4] = {0, 0, 0, 0};
    double shape[4] = {0.25, 0.25, 0.25, 0.25};
    double grad_shape[4][3] = {};
    double weight = 0.0;
    double d = 0.0;
    double normal[3] = {0.0, 0.0, 1.0};
};

FrequencyDomainStatus apply_mfem_dmi_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentOperatorLocalBlock *dmi_blocks,
    const double *tangent_in,
    double *out_tangent,
    MfemDmiOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_mfem_dmi_element_tangent_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const MfemDmiElementTangentData *elements,
    std::uint64_t element_count,
    const double *lumped_mass,
    const double *ms_field,
    double uniform_ms,
    const double *tangent_in,
    double *workspace_delta_xyz,
    double *workspace_residual_xyz,
    double *workspace_field_xyz,
    double *out_tangent,
    MfemDmiOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
