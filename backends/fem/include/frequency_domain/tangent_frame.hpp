#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct TangentFrameNode {
    double m[3] = {0.0, 0.0, 1.0};
    double e1[3] = {1.0, 0.0, 0.0};
    double e2[3] = {0.0, 1.0, 0.0};
};

struct TangentFrameDiagnostics {
    std::uint64_t node_count = 0;
    double max_norm_error = 0.0;
    double max_basis_dot_abs = 0.0;
    char error_message[128] = "";
};

struct TangentWorkspaceShape {
    std::uint64_t node_count = 0;
    std::uint64_t full_dof_count = 0;
    std::uint64_t tangent_dof_count = 0;
};

struct TangentProjectionDiagnostics {
    std::uint64_t node_count = 0;
    double max_normal_component_abs = 0.0;
    double max_roundtrip_error = 0.0;
};

double dot3(const double a[3], const double b[3]) noexcept;

TangentWorkspaceShape tangent_workspace_shape(std::uint64_t node_count) noexcept;

FrequencyDomainStatus build_tangent_frame(
    const double *equilibrium_xyz,
    std::uint64_t node_count,
    TangentFrameNode *out_nodes,
    TangentFrameDiagnostics *out_diagnostics) noexcept;

void project_full_to_tangent(
    const TangentFrameNode *nodes,
    const double *full_xyz,
    std::uint64_t node_count,
    double *out_tangent_2) noexcept;

void lift_tangent_to_full(
    const TangentFrameNode *nodes,
    const double *tangent_2,
    std::uint64_t node_count,
    double *out_full_xyz) noexcept;

void project_cartesian_complex_to_tangent(
    const TangentFrameNode *nodes,
    const double *cartesian_real_xyz,
    const double *cartesian_imag_xyz,
    std::uint64_t node_count,
    double *out_tangent_real_2,
    double *out_tangent_imag_2) noexcept;

void lift_tangent_complex_to_cartesian(
    const TangentFrameNode *nodes,
    const double *tangent_real_2,
    const double *tangent_imag_2,
    std::uint64_t node_count,
    double *out_cartesian_real_xyz,
    double *out_cartesian_imag_xyz) noexcept;

TangentProjectionDiagnostics diagnose_tangent_projection(
    const TangentFrameNode *nodes,
    const double *full_xyz,
    std::uint64_t node_count) noexcept;

} // namespace fullmag::fem::frequency_domain
