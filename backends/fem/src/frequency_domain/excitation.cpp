#include "frequency_domain/excitation.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kZeroTangentDriveTolerance = 1.0e-15;

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

} // namespace

FrequencyDomainStatus build_uniform_field_tangent_excitation(
    const TangentFrameNode *nodes,
    std::uint64_t node_count,
    const double uniform_field_a_per_m[3],
    double *out_tangent_drive,
    TangentExcitationDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentExcitationDiagnostics{};
        out_diagnostics->node_count = node_count;
        out_diagnostics->tangent_dof_count = node_count * 2;
    }
    if ((node_count > 0 && nodes == nullptr) || uniform_field_a_per_m == nullptr || out_tangent_drive == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "excitation projection requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_tangent_drive = 0.0;
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        const TangentFrameNode &node = nodes[node_index];
        const double e1_drive = dot3(uniform_field_a_per_m, node.e1);
        const double e2_drive = dot3(uniform_field_a_per_m, node.e2);
        out_tangent_drive[node_index * 2] = e1_drive;
        out_tangent_drive[node_index * 2 + 1] = e2_drive;
        max_abs_tangent_drive = std::max(max_abs_tangent_drive, std::abs(e1_drive));
        max_abs_tangent_drive = std::max(max_abs_tangent_drive, std::abs(e2_drive));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_tangent_drive = max_abs_tangent_drive;
    }
    if (!std::isfinite(max_abs_tangent_drive) || max_abs_tangent_drive <= kZeroTangentDriveTolerance) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "excitation has zero tangent drive");
        }
        return FrequencyDomainStatus::validation_error;
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
