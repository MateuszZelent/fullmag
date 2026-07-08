#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct TangentExcitationDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    double max_abs_tangent_drive = 0.0;
    bool zero_drive_warning = false;
    char error_message[128] = "";
};

struct DynamicFieldPhasorView {
    const double *hx_re = nullptr;
    const double *hy_re = nullptr;
    const double *hz_re = nullptr;
    // Null imaginary component buffers represent a real-valued phasor.
    const double *hx_im = nullptr;
    const double *hy_im = nullptr;
    const double *hz_im = nullptr;
    std::uint64_t node_count = 0;
};

struct TangentComplexVectorView {
    double *real = nullptr;
    double *imag = nullptr;
    std::uint64_t tangent_dof_count = 0;
};

FrequencyDomainStatus build_uniform_field_tangent_excitation(
    const TangentFrameNode *nodes,
    std::uint64_t node_count,
    const double uniform_field_a_per_m[3],
    double *out_tangent_drive,
    TangentExcitationDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus project_dynamic_field_drive_to_tangent_rhs(
    const TangentFrameNode *nodes,
    std::uint64_t node_count,
    double gamma0,
    FrequencyDomainPhaseConvention convention,
    const DynamicFieldPhasorView &drive,
    TangentComplexVectorView out_rhs,
    TangentExcitationDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
