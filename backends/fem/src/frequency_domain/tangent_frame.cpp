#include "frequency_domain/tangent_frame.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kUnitTolerance = 1.0e-8;

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

bool normalize3(double v[3]) noexcept
{
    const double n = norm3(v);
    if (!std::isfinite(n) || n <= 0.0) {
        return false;
    }
    v[0] /= n;
    v[1] /= n;
    v[2] /= n;
    return true;
}

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

} // namespace

double dot3(const double a[3], const double b[3]) noexcept
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

TangentWorkspaceShape tangent_workspace_shape(std::uint64_t node_count) noexcept
{
    TangentWorkspaceShape shape{};
    shape.node_count = node_count;
    shape.full_dof_count = node_count * 3;
    shape.tangent_dof_count = node_count * 2;
    return shape;
}

FrequencyDomainStatus build_tangent_frame(
    const double *equilibrium_xyz,
    std::uint64_t node_count,
    TangentFrameNode *out_nodes,
    TangentFrameDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentFrameDiagnostics{};
        out_diagnostics->node_count = node_count;
    }
    if ((node_count > 0 && equilibrium_xyz == nullptr) || out_nodes == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "tangent frame requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_norm_error = 0.0;
    double max_basis_dot_abs = 0.0;
    for (std::uint64_t i = 0; i < node_count; ++i) {
        const double *src = equilibrium_xyz + i * 3;
        double m[3] = {src[0], src[1], src[2]};
        const double m_norm = norm3(m);
        const double norm_error = std::isfinite(m_norm) ? std::abs(m_norm - 1.0) : 1.0;
        max_norm_error = std::max(max_norm_error, norm_error);
        if (!std::isfinite(m_norm) || m_norm <= 0.0 || norm_error > kUnitTolerance) {
            if (out_diagnostics != nullptr) {
                out_diagnostics->max_norm_error = max_norm_error;
                copy_error(
                    out_diagnostics->error_message,
                    "equilibrium magnetization must contain finite unit vectors");
            }
            return FrequencyDomainStatus::validation_error;
        }
        normalize3(m);

        const double ref_z[3] = {0.0, 0.0, 1.0};
        const double ref_y[3] = {0.0, 1.0, 0.0};
        const double *reference = std::abs(m[2]) < 0.9 ? ref_z : ref_y;
        double e1[3]{};
        cross3(reference, m, e1);
        if (!normalize3(e1)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "failed to build tangent basis");
            }
            return FrequencyDomainStatus::validation_error;
        }
        double e2[3]{};
        cross3(m, e1, e2);
        if (!normalize3(e2)) {
            if (out_diagnostics != nullptr) {
                copy_error(out_diagnostics->error_message, "failed to build tangent basis");
            }
            return FrequencyDomainStatus::validation_error;
        }

        TangentFrameNode &node = out_nodes[i];
        for (int axis = 0; axis < 3; ++axis) {
            node.m[axis] = m[axis];
            node.e1[axis] = e1[axis];
            node.e2[axis] = e2[axis];
        }
        max_basis_dot_abs = std::max(max_basis_dot_abs, std::abs(dot3(node.m, node.e1)));
        max_basis_dot_abs = std::max(max_basis_dot_abs, std::abs(dot3(node.m, node.e2)));
        max_basis_dot_abs = std::max(max_basis_dot_abs, std::abs(dot3(node.e1, node.e2)));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_norm_error = max_norm_error;
        out_diagnostics->max_basis_dot_abs = max_basis_dot_abs;
    }
    return FrequencyDomainStatus::ok;
}

void project_full_to_tangent(
    const TangentFrameNode *nodes,
    const double *full_xyz,
    std::uint64_t node_count,
    double *out_tangent_2) noexcept
{
    if (nodes == nullptr || full_xyz == nullptr || out_tangent_2 == nullptr) {
        return;
    }
    for (std::uint64_t i = 0; i < node_count; ++i) {
        const double *v = full_xyz + i * 3;
        out_tangent_2[i * 2] = dot3(v, nodes[i].e1);
        out_tangent_2[i * 2 + 1] = dot3(v, nodes[i].e2);
    }
}

void lift_tangent_to_full(
    const TangentFrameNode *nodes,
    const double *tangent_2,
    std::uint64_t node_count,
    double *out_full_xyz) noexcept
{
    if (nodes == nullptr || tangent_2 == nullptr || out_full_xyz == nullptr) {
        return;
    }
    for (std::uint64_t i = 0; i < node_count; ++i) {
        const double a = tangent_2[i * 2];
        const double b = tangent_2[i * 2 + 1];
        double *out = out_full_xyz + i * 3;
        for (int axis = 0; axis < 3; ++axis) {
            out[axis] = a * nodes[i].e1[axis] + b * nodes[i].e2[axis];
        }
    }
}

void project_cartesian_complex_to_tangent(
    const TangentFrameNode *nodes,
    const double *cartesian_real_xyz,
    const double *cartesian_imag_xyz,
    std::uint64_t node_count,
    double *out_tangent_real_2,
    double *out_tangent_imag_2) noexcept
{
    if (nodes == nullptr ||
        cartesian_real_xyz == nullptr ||
        cartesian_imag_xyz == nullptr ||
        out_tangent_real_2 == nullptr ||
        out_tangent_imag_2 == nullptr) {
        return;
    }
    project_full_to_tangent(nodes, cartesian_real_xyz, node_count, out_tangent_real_2);
    project_full_to_tangent(nodes, cartesian_imag_xyz, node_count, out_tangent_imag_2);
}

void lift_tangent_complex_to_cartesian(
    const TangentFrameNode *nodes,
    const double *tangent_real_2,
    const double *tangent_imag_2,
    std::uint64_t node_count,
    double *out_cartesian_real_xyz,
    double *out_cartesian_imag_xyz) noexcept
{
    if (nodes == nullptr ||
        tangent_real_2 == nullptr ||
        tangent_imag_2 == nullptr ||
        out_cartesian_real_xyz == nullptr ||
        out_cartesian_imag_xyz == nullptr) {
        return;
    }
    lift_tangent_to_full(nodes, tangent_real_2, node_count, out_cartesian_real_xyz);
    lift_tangent_to_full(nodes, tangent_imag_2, node_count, out_cartesian_imag_xyz);
}

TangentProjectionDiagnostics diagnose_tangent_projection(
    const TangentFrameNode *nodes,
    const double *full_xyz,
    std::uint64_t node_count) noexcept
{
    TangentProjectionDiagnostics diagnostics{};
    diagnostics.node_count = node_count;
    if (nodes == nullptr || full_xyz == nullptr) {
        return diagnostics;
    }

    for (std::uint64_t i = 0; i < node_count; ++i) {
        const TangentFrameNode &node = nodes[i];
        const double *v = full_xyz + i * 3;
        const double tangent[2] = {dot3(v, node.e1), dot3(v, node.e2)};
        double lifted[3]{};
        for (int axis = 0; axis < 3; ++axis) {
            lifted[axis] = tangent[0] * node.e1[axis] + tangent[1] * node.e2[axis];
        }

        diagnostics.max_normal_component_abs =
            std::max(diagnostics.max_normal_component_abs, std::abs(dot3(v, node.m)));
        diagnostics.max_roundtrip_error =
            std::max(diagnostics.max_roundtrip_error, std::abs(dot3(lifted, node.m)));
        diagnostics.max_roundtrip_error = std::max(
            diagnostics.max_roundtrip_error,
            std::abs(dot3(lifted, node.e1) - tangent[0]));
        diagnostics.max_roundtrip_error = std::max(
            diagnostics.max_roundtrip_error,
            std::abs(dot3(lifted, node.e2) - tangent[1]));
    }
    return diagnostics;
}

} // namespace fullmag::fem::frequency_domain
