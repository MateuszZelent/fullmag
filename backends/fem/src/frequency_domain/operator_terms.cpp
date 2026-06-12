#include "frequency_domain/operator_terms.hpp"

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

bool is_local_term(FrequencyDomainOperatorTermKind kind) noexcept
{
    switch (kind) {
    case FrequencyDomainOperatorTermKind::exchange:
    case FrequencyDomainOperatorTermKind::zeeman:
    case FrequencyDomainOperatorTermKind::local_anisotropy:
    case FrequencyDomainOperatorTermKind::dmi:
    case FrequencyDomainOperatorTermKind::surface_anisotropy:
        return true;
    case FrequencyDomainOperatorTermKind::demag_nonlocal:
        return false;
    }
    return false;
}

} // namespace

const char *operator_term_kind_to_string(FrequencyDomainOperatorTermKind kind) noexcept
{
    switch (kind) {
    case FrequencyDomainOperatorTermKind::exchange:
        return "exchange";
    case FrequencyDomainOperatorTermKind::zeeman:
        return "zeeman";
    case FrequencyDomainOperatorTermKind::local_anisotropy:
        return "local_anisotropy";
    case FrequencyDomainOperatorTermKind::dmi:
        return "dmi";
    case FrequencyDomainOperatorTermKind::surface_anisotropy:
        return "surface_anisotropy";
    case FrequencyDomainOperatorTermKind::demag_nonlocal:
        return "demag_nonlocal";
    }
    return "unknown";
}

FrequencyDomainStatus apply_tangent_local_operator(
    const TangentOperatorLocalBlock *terms,
    std::uint64_t term_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentOperatorDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
    }
    if ((term_count > 0 && terms == nullptr) || tangent_in == nullptr || out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "tangent operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t unsupported = 0;
    for (std::uint64_t term_index = 0; term_index < term_count; ++term_index) {
        if (!is_local_term(terms[term_index].kind)) {
            ++unsupported;
        }
    }
    if (unsupported > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->unsupported_term_count = unsupported;
            copy_error(out_diagnostics->error_message, "unsupported nonlocal tangent operator term");
        }
        return FrequencyDomainStatus::operator_error;
    }

    std::fill(out_tangent, out_tangent + shape.tangent_dof_count, 0.0);
    double max_abs_output = 0.0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        const double x0 = tangent_in[node_index * 2];
        const double x1 = tangent_in[node_index * 2 + 1];
        double y0 = 0.0;
        double y1 = 0.0;
        for (std::uint64_t term_index = 0; term_index < term_count; ++term_index) {
            const TangentOperatorLocalBlock &term = terms[term_index];
            y0 += term.a00 * x0 + term.a01 * x1;
            y1 += term.a10 * x0 + term.a11 * x1;
        }
        out_tangent[node_index * 2] = y0;
        out_tangent[node_index * 2 + 1] = y1;
        max_abs_output = std::max(max_abs_output, std::abs(y0));
        max_abs_output = std::max(max_abs_output, std::abs(y1));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->applied_term_count = term_count;
        out_diagnostics->max_abs_output = max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_tangent_nodewise_operator(
    const TangentOperatorLocalBlock *node_blocks,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentOperatorDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
    }
    if ((shape.node_count > 0 && node_blocks == nullptr) ||
        tangent_in == nullptr ||
        out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "nodewise tangent operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t unsupported = 0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        if (!is_local_term(node_blocks[node_index].kind)) {
            ++unsupported;
        }
    }
    if (unsupported > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->unsupported_term_count = unsupported;
            copy_error(out_diagnostics->error_message, "unsupported nodewise tangent operator term");
        }
        return FrequencyDomainStatus::operator_error;
    }

    double max_abs_output = 0.0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        const double x0 = tangent_in[node_index * 2];
        const double x1 = tangent_in[node_index * 2 + 1];
        const TangentOperatorLocalBlock &block = node_blocks[node_index];
        const double y0 = block.a00 * x0 + block.a01 * x1;
        const double y1 = block.a10 * x0 + block.a11 * x1;
        out_tangent[node_index * 2] = y0;
        out_tangent[node_index * 2 + 1] = y1;
        max_abs_output = std::max(max_abs_output, std::abs(y0));
        max_abs_output = std::max(max_abs_output, std::abs(y1));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->applied_term_count = shape.node_count;
        out_diagnostics->max_abs_output = max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_tangent_edge_operator(
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentEdgeOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentEdgeOperatorDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
        out_diagnostics->edge_count = edge_count;
    }
    if ((edge_count > 0 && edges == nullptr) || tangent_in == nullptr || out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "edge tangent operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t invalid_edges = 0;
    std::uint64_t unsupported_edges = 0;
    for (std::uint64_t edge_index = 0; edge_index < edge_count; ++edge_index) {
        const TangentOperatorEdgeBlock &edge = edges[edge_index];
        if (edge.kind != FrequencyDomainOperatorTermKind::exchange) {
            ++unsupported_edges;
        }
        if (edge.node_i >= shape.node_count ||
            edge.node_j >= shape.node_count ||
            edge.node_i == edge.node_j) {
            ++invalid_edges;
        }
    }
    if (unsupported_edges > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->unsupported_edge_count = unsupported_edges;
            copy_error(out_diagnostics->error_message, "unsupported tangent edge operator term");
        }
        return FrequencyDomainStatus::operator_error;
    }
    if (invalid_edges > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->invalid_edge_count = invalid_edges;
            copy_error(out_diagnostics->error_message, "invalid tangent edge node index");
        }
        return FrequencyDomainStatus::validation_error;
    }

    std::fill(out_tangent, out_tangent + shape.tangent_dof_count, 0.0);
    double max_abs_output = 0.0;
    for (std::uint64_t edge_index = 0; edge_index < edge_count; ++edge_index) {
        const TangentOperatorEdgeBlock &edge = edges[edge_index];
        for (std::uint64_t component = 0; component < 2; ++component) {
            const std::uint64_t dof_i = edge.node_i * 2 + component;
            const std::uint64_t dof_j = edge.node_j * 2 + component;
            const double delta = edge.stiffness * (tangent_in[dof_i] - tangent_in[dof_j]);
            out_tangent[dof_i] += delta;
            out_tangent[dof_j] -= delta;
            max_abs_output = std::max(max_abs_output, std::abs(out_tangent[dof_i]));
            max_abs_output = std::max(max_abs_output, std::abs(out_tangent[dof_j]));
        }
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_output = max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_tangent_combined_operator(
    const TangentOperatorLocalBlock *node_blocks,
    const TangentOperatorEdgeBlock *edges,
    std::uint64_t edge_count,
    const double *tangent_in,
    TangentWorkspaceShape shape,
    double *out_tangent,
    TangentCombinedOperatorDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentCombinedOperatorDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
        out_diagnostics->node_block_count = shape.node_count;
        out_diagnostics->edge_count = edge_count;
    }
    if ((shape.node_count > 0 && node_blocks == nullptr) ||
        (edge_count > 0 && edges == nullptr) ||
        tangent_in == nullptr ||
        out_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "combined tangent operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }

    std::uint64_t unsupported_terms = 0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        if (!is_local_term(node_blocks[node_index].kind)) {
            ++unsupported_terms;
        }
    }
    for (std::uint64_t edge_index = 0; edge_index < edge_count; ++edge_index) {
        if (edges[edge_index].kind != FrequencyDomainOperatorTermKind::exchange) {
            ++unsupported_terms;
        }
    }
    if (unsupported_terms > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->unsupported_term_count = unsupported_terms;
            copy_error(out_diagnostics->error_message, "unsupported combined tangent operator term");
        }
        return FrequencyDomainStatus::operator_error;
    }

    std::uint64_t invalid_edges = 0;
    for (std::uint64_t edge_index = 0; edge_index < edge_count; ++edge_index) {
        const TangentOperatorEdgeBlock &edge = edges[edge_index];
        if (edge.node_i >= shape.node_count ||
            edge.node_j >= shape.node_count ||
            edge.node_i == edge.node_j) {
            ++invalid_edges;
        }
    }
    if (invalid_edges > 0) {
        if (out_diagnostics != nullptr) {
            out_diagnostics->invalid_edge_count = invalid_edges;
            copy_error(out_diagnostics->error_message, "invalid combined tangent edge node index");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_output = 0.0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        const double x0 = tangent_in[node_index * 2];
        const double x1 = tangent_in[node_index * 2 + 1];
        const TangentOperatorLocalBlock &block = node_blocks[node_index];
        const double y0 = block.a00 * x0 + block.a01 * x1;
        const double y1 = block.a10 * x0 + block.a11 * x1;
        out_tangent[node_index * 2] = y0;
        out_tangent[node_index * 2 + 1] = y1;
        max_abs_output = std::max(max_abs_output, std::abs(y0));
        max_abs_output = std::max(max_abs_output, std::abs(y1));
    }

    for (std::uint64_t edge_index = 0; edge_index < edge_count; ++edge_index) {
        const TangentOperatorEdgeBlock &edge = edges[edge_index];
        for (std::uint64_t component = 0; component < 2; ++component) {
            const std::uint64_t dof_i = edge.node_i * 2 + component;
            const std::uint64_t dof_j = edge.node_j * 2 + component;
            const double delta = edge.stiffness * (tangent_in[dof_i] - tangent_in[dof_j]);
            out_tangent[dof_i] += delta;
            out_tangent[dof_j] -= delta;
            max_abs_output = std::max(max_abs_output, std::abs(out_tangent[dof_i]));
            max_abs_output = std::max(max_abs_output, std::abs(out_tangent[dof_j]));
        }
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_output = max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_tangent_precession_operator(
    const TangentFrameNode *nodes,
    const double *effective_field_tangent,
    TangentWorkspaceShape shape,
    double gamma0,
    double *out_rhs_tangent,
    TangentPrecessionDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentPrecessionDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
        out_diagnostics->gamma0 = gamma0;
    }
    if ((shape.node_count > 0 && nodes == nullptr) ||
        effective_field_tangent == nullptr ||
        out_rhs_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "tangent precession operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!(gamma0 > 0.0) || !std::isfinite(gamma0)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "gamma0 must be finite and positive");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_rhs = 0.0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        const double h1 = effective_field_tangent[node_index * 2];
        const double h2 = effective_field_tangent[node_index * 2 + 1];
        const double y1 = -gamma0 * h2;
        const double y2 = gamma0 * h1;
        out_rhs_tangent[node_index * 2] = y1;
        out_rhs_tangent[node_index * 2 + 1] = y2;
        max_abs_rhs = std::max(max_abs_rhs, std::abs(y1));
        max_abs_rhs = std::max(max_abs_rhs, std::abs(y2));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_rhs = max_abs_rhs;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_tangent_damping_operator(
    const TangentFrameNode *nodes,
    const double *tangent_delta,
    TangentWorkspaceShape shape,
    double alpha,
    double *out_damping_tangent,
    TangentDampingDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentDampingDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
        out_diagnostics->alpha = alpha;
    }
    if ((shape.node_count > 0 && nodes == nullptr) ||
        tangent_delta == nullptr ||
        out_damping_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "tangent damping operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!(alpha >= 0.0) || !std::isfinite(alpha)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "alpha must be finite and non-negative");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_output = 0.0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        const double q1 = tangent_delta[node_index * 2];
        const double q2 = tangent_delta[node_index * 2 + 1];
        const double y1 = -alpha * q2;
        const double y2 = alpha * q1;
        out_damping_tangent[node_index * 2] = y1;
        out_damping_tangent[node_index * 2 + 1] = y2;
        max_abs_output = std::max(max_abs_output, std::abs(y1));
        max_abs_output = std::max(max_abs_output, std::abs(y2));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_output = max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_tangent_frequency_mass_operator(
    const TangentFrameNode *nodes,
    const double *tangent_delta,
    TangentWorkspaceShape shape,
    double alpha,
    double *out_mass_tangent,
    TangentFrequencyMassDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentFrequencyMassDiagnostics{};
        out_diagnostics->node_count = shape.node_count;
        out_diagnostics->tangent_dof_count = shape.tangent_dof_count;
        out_diagnostics->alpha = alpha;
    }
    if ((shape.node_count > 0 && nodes == nullptr) ||
        tangent_delta == nullptr ||
        out_mass_tangent == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "tangent frequency mass operator requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (shape.tangent_dof_count != shape.node_count * 2) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "invalid tangent workspace shape");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (!(alpha >= 0.0) || !std::isfinite(alpha)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "alpha must be finite and non-negative");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_output = 0.0;
    for (std::uint64_t node_index = 0; node_index < shape.node_count; ++node_index) {
        const double q1 = tangent_delta[node_index * 2];
        const double q2 = tangent_delta[node_index * 2 + 1];
        const double y1 = q1 + alpha * q2;
        const double y2 = q2 - alpha * q1;
        out_mass_tangent[node_index * 2] = y1;
        out_mass_tangent[node_index * 2 + 1] = y2;
        max_abs_output = std::max(max_abs_output, std::abs(y1));
        max_abs_output = std::max(max_abs_output, std::abs(y2));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_output = max_abs_output;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
