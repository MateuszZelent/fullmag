#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

enum class FrequencyDomainOperatorTermKind : std::uint32_t {
    exchange,
    zeeman,
    local_anisotropy,
    dmi,
    surface_anisotropy,
    demag_nonlocal,
};

struct TangentOperatorLocalBlock {
    // Row-major 2x2 block mapping local tangent coordinates [u, v].
    FrequencyDomainOperatorTermKind kind = FrequencyDomainOperatorTermKind::zeeman;
    double a00 = 0.0;
    double a01 = 0.0;
    double a10 = 0.0;
    double a11 = 0.0;
};

struct TangentOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t applied_term_count = 0;
    std::uint64_t unsupported_term_count = 0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

struct TangentOperatorEdgeBlock {
    FrequencyDomainOperatorTermKind kind = FrequencyDomainOperatorTermKind::exchange;
    std::uint64_t node_i = 0;
    std::uint64_t node_j = 0;
    double stiffness = 0.0;
};

struct TangentEdgeOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t edge_count = 0;
    std::uint64_t invalid_edge_count = 0;
    std::uint64_t unsupported_edge_count = 0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

struct TangentCombinedOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t node_block_count = 0;
    std::uint64_t edge_count = 0;
    std::uint64_t invalid_edge_count = 0;
    std::uint64_t unsupported_term_count = 0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

struct TangentPrecessionDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    double gamma0 = 0.0;
    double max_abs_rhs = 0.0;
    char error_message[128] = "";
};

struct TangentDampingDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    double alpha = 0.0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

struct TangentFrequencyMassDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    double alpha = 0.0;
    double max_alpha = 0.0;
    double max_abs_output = 0.0;
    char error_message[128] = "";
};

const char *operator_term_kind_to_string(FrequencyDomainOperatorTermKind kind) noexcept;

TangentOperatorLocalBlock project_cartesian_local_operator_to_tangent(
    const TangentFrameNode &node,
    FrequencyDomainOperatorTermKind kind,
    const double cartesian_row_major_3x3[9]) noexcept;

FrequencyDomainStatus apply_tangent_local_operator(
    const TangentOperatorLocalBlock *terms,
    std::uint64_t term_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_nodewise_operator(
    const TangentOperatorLocalBlock *node_blocks,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_edge_operator(
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentEdgeOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_edge_operator(
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentEdgeOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_combined_operator(
    const TangentOperatorLocalBlock *node_blocks,
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentCombinedOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_combined_operator(
    const TangentFrameNode *nodes,
    const TangentOperatorLocalBlock *node_blocks,
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentCombinedOperatorDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_precession_operator(
    const TangentFrameNode *nodes,
    const double *effective_field_tangent,
    TangentWorkspaceShape shape,
    double gamma0,
    double *out_rhs_tangent,
    TangentPrecessionDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_damping_operator(
    const TangentFrameNode *nodes,
    const double *tangent_delta,
    TangentWorkspaceShape shape,
    double alpha,
    double *out_damping_tangent,
    TangentDampingDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_tangent_frequency_mass_operator(
    const TangentFrameNode *nodes,
    const double *tangent_delta,
    TangentWorkspaceShape shape,
    double alpha,
    const double *alpha_per_node,
    double *out_mass_tangent,
    TangentFrequencyMassDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
