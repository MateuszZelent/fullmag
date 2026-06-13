#include "frequency_domain/anisotropy_operator.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

bool normalize_axis(const double axis[3], double out_axis[3]) noexcept
{
    if (axis == nullptr) {
        return false;
    }
    const double norm_sq = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
    if (!(norm_sq > 0.0) || !std::isfinite(norm_sq)) {
        return false;
    }
    const double inv_norm = 1.0 / std::sqrt(norm_sq);
    out_axis[0] = axis[0] * inv_norm;
    out_axis[1] = axis[1] * inv_norm;
    out_axis[2] = axis[2] * inv_norm;
    return std::isfinite(out_axis[0]) && std::isfinite(out_axis[1]) && std::isfinite(out_axis[2]);
}

} // namespace

FrequencyDomainStatus build_uniaxial_anisotropy_tangent_blocks(
    const TangentFrameNode *nodes,
    const double axis[3],
    double anisotropy_field_a_per_m,
    std::uint64_t node_count,
    TangentOperatorLocalBlock *out_blocks,
    UniaxialAnisotropyTangentOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = UniaxialAnisotropyTangentOperatorDiagnostics{};
        out_diagnostics->node_count = node_count;
        out_diagnostics->anisotropy_field_a_per_m = anisotropy_field_a_per_m;
    }
    if ((node_count > 0 && nodes == nullptr) || out_blocks == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "uniaxial anisotropy tangent blocks require non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!std::isfinite(anisotropy_field_a_per_m)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "uniaxial anisotropy tangent field must be finite");
        }
        return FrequencyDomainStatus::validation_error;
    }
    double unit_axis[3]{};
    if (!normalize_axis(axis, unit_axis)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "uniaxial anisotropy axis must be finite and non-zero");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_axis_tangent = 0.0;
    double max_abs_block_coeff = 0.0;
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        const TangentFrameNode &node = nodes[node_index];
        const double u1 = dot3(unit_axis, node.e1);
        const double u2 = dot3(unit_axis, node.e2);

        TangentOperatorLocalBlock &block = out_blocks[node_index];
        block.kind = FrequencyDomainOperatorTermKind::local_anisotropy;
        block.a00 = anisotropy_field_a_per_m * u1 * u1;
        block.a01 = anisotropy_field_a_per_m * u1 * u2;
        block.a10 = anisotropy_field_a_per_m * u2 * u1;
        block.a11 = anisotropy_field_a_per_m * u2 * u2;

        max_abs_axis_tangent = std::max(max_abs_axis_tangent, std::abs(u1));
        max_abs_axis_tangent = std::max(max_abs_axis_tangent, std::abs(u2));
        max_abs_block_coeff = std::max(max_abs_block_coeff, std::abs(block.a00));
        max_abs_block_coeff = std::max(max_abs_block_coeff, std::abs(block.a01));
        max_abs_block_coeff = std::max(max_abs_block_coeff, std::abs(block.a10));
        max_abs_block_coeff = std::max(max_abs_block_coeff, std::abs(block.a11));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_axis_tangent = max_abs_axis_tangent;
        out_diagnostics->max_abs_block_coeff = max_abs_block_coeff;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
