#include "frequency_domain/equilibrium_state.hpp"

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

double norm3(const double v[3]) noexcept
{
    return std::sqrt(dot3(v, v));
}

void cross3(const double a[3], const double b[3], double out[3]) noexcept
{
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
}

} // namespace

FrequencyDomainStatus build_equilibrium_state(
    const double *equilibrium_xyz,
    const double *static_field_xyz,
    std::uint64_t node_count,
    double max_allowed_m_cross_h_abs,
    TangentFrameNode *out_nodes,
    EquilibriumStateDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = EquilibriumStateDiagnostics{};
        out_diagnostics->node_count = node_count;
    }
    if ((node_count > 0 && (equilibrium_xyz == nullptr || static_field_xyz == nullptr)) ||
        out_nodes == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "equilibrium state requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!(max_allowed_m_cross_h_abs >= 0.0) || !std::isfinite(max_allowed_m_cross_h_abs)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "equilibrium torque tolerance must be finite and non-negative");
        }
        return FrequencyDomainStatus::validation_error;
    }

    TangentFrameDiagnostics frame_diagnostics{};
    const FrequencyDomainStatus frame_status =
        build_tangent_frame(equilibrium_xyz, node_count, out_nodes, &frame_diagnostics);
    if (out_diagnostics != nullptr) {
        out_diagnostics->max_norm_error = frame_diagnostics.max_norm_error;
    }
    if (frame_status != FrequencyDomainStatus::ok) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, frame_diagnostics.error_message);
        }
        return frame_status;
    }

    double max_torque = 0.0;
    double torque_square_sum = 0.0;
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        const TangentFrameNode &node = out_nodes[node_index];
        const double *h = static_field_xyz + node_index * 3;
        if (!std::isfinite(h[0]) || !std::isfinite(h[1]) || !std::isfinite(h[2])) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "static equilibrium field must contain finite values");
            }
            return FrequencyDomainStatus::validation_error;
        }
        double torque[3]{};
        cross3(node.m, h, torque);
        const double torque_norm = norm3(torque);
        if (!std::isfinite(torque_norm)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "equilibrium residual must be finite");
            }
            return FrequencyDomainStatus::validation_error;
        }
        max_torque = std::max(max_torque, torque_norm);
        torque_square_sum += torque_norm * torque_norm;
    }

    const double rms_torque =
        node_count > 0 ? std::sqrt(torque_square_sum / static_cast<double>(node_count)) : 0.0;
    if (!std::isfinite(rms_torque)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "equilibrium residual RMS must be finite");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (out_diagnostics != nullptr) {
        out_diagnostics->max_m_cross_h_abs = max_torque;
        out_diagnostics->rms_m_cross_h_abs = rms_torque;
    }

    if (max_torque > max_allowed_m_cross_h_abs) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "equilibrium residual exceeds m cross H tolerance");
        }
        return FrequencyDomainStatus::validation_error;
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
