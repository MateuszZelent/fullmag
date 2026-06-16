#include "frequency_domain/zeeman_operator.hpp"

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

bool vector3_is_finite(const double values[3]) noexcept
{
    return std::isfinite(values[0]) &&
        std::isfinite(values[1]) &&
        std::isfinite(values[2]);
}

} // namespace

FrequencyDomainStatus build_zeeman_tangent_blocks(
    const TangentFrameNode *nodes,
    const double h_ext_a_per_m[3],
    std::uint64_t node_count,
    TangentOperatorLocalBlock *out_blocks,
    ZeemanTangentOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = ZeemanTangentOperatorDiagnostics{};
        out_diagnostics->node_count = node_count;
    }
    if ((node_count > 0 && nodes == nullptr) || h_ext_a_per_m == nullptr || out_blocks == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "Zeeman tangent blocks require non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!vector3_is_finite(h_ext_a_per_m)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "Zeeman tangent blocks require finite external field");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_parallel_field_abs = 0.0;
    double max_transverse_field_abs = 0.0;
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        const TangentFrameNode &node = nodes[node_index];
        const double h_parallel = dot3(h_ext_a_per_m, node.m);
        const double h_tangent_1 = dot3(h_ext_a_per_m, node.e1);
        const double h_tangent_2 = dot3(h_ext_a_per_m, node.e2);
        const double h_transverse = std::sqrt(h_tangent_1 * h_tangent_1 + h_tangent_2 * h_tangent_2);

        max_parallel_field_abs = std::max(max_parallel_field_abs, std::abs(h_parallel));
        max_transverse_field_abs = std::max(max_transverse_field_abs, h_transverse);

        TangentOperatorLocalBlock &block = out_blocks[node_index];
        block.kind = FrequencyDomainOperatorTermKind::zeeman;
        // A fixed field has delta_H = 0; the linearized Zeeman contribution is
        // -gamma0 * delta_m x H0, represented through the shared -m0 x (...) rotator.
        block.a00 = -h_parallel;
        block.a01 = 0.0;
        block.a10 = 0.0;
        block.a11 = -h_parallel;
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_parallel_field_abs = max_parallel_field_abs;
        out_diagnostics->max_transverse_field_abs = max_transverse_field_abs;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
