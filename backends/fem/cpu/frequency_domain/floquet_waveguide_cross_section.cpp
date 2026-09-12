#include "frequency_domain/floquet_waveguide_cross_section.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <unordered_map>
#include <utility>

namespace fullmag::fem::frequency_domain {
namespace {

constexpr std::uint64_t kMaxReferenceNodes = 4096;
constexpr std::uint64_t kMaxReferenceTriangles = 65536;
constexpr std::uint64_t kMaxReferenceRobinEdges = 65536;
constexpr double kMinimumTriangleAreaM2 = 1.0e-30;

void copy_error(FloquetWaveguideCrossSectionBlockResult *result, const char *message) noexcept
{
    if (result == nullptr) {
        return;
    }
    std::strncpy(result->error_message, message != nullptr ? message : "", 255u);
    result->error_message[255] = '\0';
}

bool finite_span(const double *values, std::uint64_t count) noexcept
{
    if (count > 0u && values == nullptr) {
        return false;
    }
    for (std::uint64_t index = 0u; index < count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

bool checked_product(std::uint64_t lhs, std::uint64_t rhs, std::uint64_t *out) noexcept
{
    if (out == nullptr || (rhs != 0u && lhs > std::numeric_limits<std::uint64_t>::max() / rhs)) {
        return false;
    }
    *out = lhs * rhs;
    return true;
}

bool checked_square(std::uint64_t value, std::uint64_t *out) noexcept
{
    return checked_product(value, value, out);
}

bool finite_vector(const std::vector<double> &values) noexcept
{
    return std::all_of(values.begin(), values.end(), [](double value) {
        return std::isfinite(value);
    });
}

double dot2(const double left[2], const double right[2]) noexcept
{
    return left[0] * right[0] + left[1] * right[1];
}

void add_entry(std::vector<double> &matrix, std::uint64_t columns, std::uint64_t row,
               std::uint64_t column, double value)
{
    matrix[static_cast<std::size_t>(row * columns + column)] += value;
}

FrequencyDomainStatus validate_problem(
    const FloquetWaveguideCrossSectionProblem &problem,
    std::unordered_map<std::uint32_t, std::uint64_t> &magnetic_order,
    std::uint64_t *q_dof_count,
    char error_message[256]) noexcept
{
    auto fail = [&](const char *message) {
        if (error_message != nullptr) {
            std::strncpy(error_message, message, 255u);
            error_message[255] = '\0';
        }
        return FrequencyDomainStatus::validation_error;
    };
    if (problem.node_count == 0u || problem.triangle_count == 0u ||
        problem.node_count > kMaxReferenceNodes ||
        problem.triangle_count > kMaxReferenceTriangles ||
        problem.robin_edge_count > kMaxReferenceRobinEdges || problem.node_count >
            static_cast<std::uint64_t>(std::numeric_limits<std::uint32_t>::max()) ||
        problem.node_xy_m == nullptr || problem.triangle_nodes == nullptr ||
        problem.magnetic_element_mask == nullptr || problem.magnetic_node_indices == nullptr ||
        problem.magnetic_node_count == 0u || problem.magnetic_node_count > problem.node_count ||
        problem.tangent_frames_xyz == nullptr ||
        problem.robin_edge_count > 0u && problem.robin_edges == nullptr) {
        return fail("waveguide cross-section topology or required buffer is invalid");
    }
    std::uint64_t node_values = 0u;
    std::uint64_t triangle_values = 0u;
    std::uint64_t q_count = 0u;
    if (!checked_product(problem.node_count, 2u, &node_values) ||
        !checked_product(problem.triangle_count, 3u, &triangle_values) ||
        !checked_product(problem.magnetic_node_count, 2u, &q_count) ||
        !finite_span(problem.node_xy_m, node_values) ||
        !finite_span(problem.tangent_frames_xyz, problem.node_count * 6u) ||
        !finite_span(problem.saturation_magnetization_a_per_m,
                     problem.saturation_magnetization_count)) {
        return fail("waveguide cross-section numeric buffers are invalid");
    }
    if (problem.saturation_magnetization_a_per_m != nullptr &&
        problem.saturation_magnetization_count != problem.node_count) {
        return fail("waveguide cross-section nodal Ms count must equal node count");
    }
    if (problem.saturation_magnetization_a_per_m == nullptr &&
        (!std::isfinite(problem.uniform_saturation_magnetization_a_per_m) ||
         problem.uniform_saturation_magnetization_a_per_m < 0.0)) {
        return fail("waveguide cross-section uniform Ms must be finite and non-negative");
    }
    if (problem.saturation_magnetization_a_per_m != nullptr) {
        for (std::uint64_t node = 0u; node < problem.node_count; ++node) {
            if (problem.saturation_magnetization_a_per_m[node] < 0.0) {
                return fail("waveguide cross-section nodal Ms must be non-negative");
            }
        }
    }
    if (!std::isfinite(problem.robin_beta) || problem.robin_beta < 0.0 ||
        !std::isfinite(problem.normalization_length_m) || problem.normalization_length_m <= 0.0) {
        return fail("waveguide cross-section Robin coefficient or length is invalid");
    }
    if (problem.robin_edge_marker != nullptr && problem.robin_edge_count == 0u) {
        return fail("waveguide cross-section Robin marker has no edges");
    }

    magnetic_order.clear();
    magnetic_order.reserve(static_cast<std::size_t>(problem.magnetic_node_count));
    for (std::uint64_t compact = 0u; compact < problem.magnetic_node_count; ++compact) {
        const std::uint32_t node = problem.magnetic_node_indices[compact];
        if (node >= problem.node_count ||
            !magnetic_order.emplace(node, compact).second) {
            return fail("waveguide cross-section magnetic node map is invalid or duplicated");
        }
        for (int component = 0; component < 2; ++component) {
            const double *frame = problem.tangent_frames_xyz + 6u * node + 3u * component;
            const double norm = std::sqrt(frame[0] * frame[0] + frame[1] * frame[1] + frame[2] * frame[2]);
            if (!std::isfinite(norm) || std::abs(norm - 1.0) > 1.0e-7) {
                return fail("waveguide cross-section tangent frame is not unit length");
            }
        }
        const double *e1 = problem.tangent_frames_xyz + 6u * node;
        const double *e2 = e1 + 3u;
        if (std::abs(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) > 1.0e-7) {
            return fail("waveguide cross-section tangent frame is not orthogonal");
        }
    }

    for (std::uint64_t triangle = 0u; triangle < problem.triangle_count; ++triangle) {
        const std::uint32_t *nodes = problem.triangle_nodes + 3u * triangle;
        if (nodes[0] >= problem.node_count || nodes[1] >= problem.node_count ||
            nodes[2] >= problem.node_count || nodes[0] == nodes[1] || nodes[0] == nodes[2] ||
            nodes[1] == nodes[2]) {
            return fail("waveguide cross-section triangle has invalid nodes");
        }
        if (problem.magnetic_element_mask[triangle] > 1u) {
            return fail("waveguide cross-section magnetic element mask is not boolean");
        }
        if (problem.magnetic_element_mask[triangle] != 0u) {
            for (int local = 0; local < 3; ++local) {
                if (magnetic_order.find(nodes[local]) == magnetic_order.end()) {
                    return fail("magnetic triangle vertex is absent from the magnetic node map");
                }
            }
        }
    }
    for (std::uint64_t edge = 0u; edge < problem.robin_edge_count; ++edge) {
        const std::uint32_t *nodes = problem.robin_edges + 2u * edge;
        if (nodes[0] >= problem.node_count || nodes[1] >= problem.node_count ||
            nodes[0] == nodes[1]) {
            return fail("waveguide cross-section Robin edge has invalid nodes");
        }
        if (problem.robin_edge_marker != nullptr && problem.robin_edge_marker[edge] > 1u) {
            return fail("waveguide cross-section Robin edge marker is not boolean");
        }
    }
    if (q_dof_count != nullptr) {
        *q_dof_count = q_count;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace

FrequencyDomainStatus assemble_floquet_waveguide_cross_section_blocks(
    const FloquetWaveguideCrossSectionProblem &problem,
    FloquetWaveguideCrossSectionBlockResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetWaveguideCrossSectionBlockResult{};
    out_result->scalar_dof_count = problem.node_count;
    out_result->q_dof_count = problem.magnetic_node_count * 2u;

    std::unordered_map<std::uint32_t, std::uint64_t> magnetic_order;
    std::uint64_t q_dof_count = 0u;
    const FrequencyDomainStatus validation = validate_problem(
        problem, magnetic_order, &q_dof_count, out_result->error_message);
    if (validation != FrequencyDomainStatus::ok) {
        return validation;
    }
    const std::uint64_t scalar = problem.node_count;
    std::uint64_t scalar_values = 0u;
    std::uint64_t coupling_values = 0u;
    if (!checked_square(scalar, &scalar_values) ||
        !checked_product(scalar, q_dof_count, &coupling_values)) {
        copy_error(out_result, "waveguide cross-section output shape overflows");
        return FrequencyDomainStatus::validation_error;
    }

    try {
        out_result->k_perp_row_major.assign(static_cast<std::size_t>(scalar_values), 0.0);
        out_result->mass_row_major.assign(static_cast<std::size_t>(scalar_values), 0.0);
        out_result->a_phiq_perp_row_major.assign(static_cast<std::size_t>(coupling_values), 0.0);
        out_result->a_phiq_axial_row_major.assign(static_cast<std::size_t>(coupling_values), 0.0);
        out_result->a_qphi_perp_row_major.assign(static_cast<std::size_t>(coupling_values), 0.0);
        out_result->a_qphi_axial_row_major.assign(static_cast<std::size_t>(coupling_values), 0.0);

        const double scale = 1.0 / problem.normalization_length_m;
        for (std::uint64_t triangle = 0u; triangle < problem.triangle_count; ++triangle) {
            const std::uint32_t *nodes = problem.triangle_nodes + 3u * triangle;
            const double *p0 = problem.node_xy_m + 2u * nodes[0];
            const double *p1 = problem.node_xy_m + 2u * nodes[1];
            const double *p2 = problem.node_xy_m + 2u * nodes[2];
            const double det = (p1[0] - p0[0]) * (p2[1] - p0[1]) -
                (p2[0] - p0[0]) * (p1[1] - p0[1]);
            const double area = 0.5 * std::abs(det);
            if (!std::isfinite(det) || !std::isfinite(area) || area <= kMinimumTriangleAreaM2) {
                copy_error(out_result, "waveguide cross-section triangle is degenerate");
                return FrequencyDomainStatus::validation_error;
            }
            const double gradients[3][2] = {
                {(p1[1] - p2[1]) / det, (p2[0] - p1[0]) / det},
                {(p2[1] - p0[1]) / det, (p0[0] - p2[0]) / det},
                {(p0[1] - p1[1]) / det, (p1[0] - p0[0]) / det},
            };
            out_result->cross_section_area_m2 += area * scale;
            for (int local_row = 0; local_row < 3; ++local_row) {
                const std::uint64_t row = nodes[local_row];
                for (int local_column = 0; local_column < 3; ++local_column) {
                    const std::uint64_t column = nodes[local_column];
                    add_entry(out_result->k_perp_row_major, scalar, row, column,
                              area * scale * dot2(gradients[local_row], gradients[local_column]));
                    const double mass = area * scale * (local_row == local_column ? 1.0 / 6.0 : 1.0 / 12.0);
                    add_entry(out_result->mass_row_major, scalar, row, column, mass);
                }
            }

            if (problem.magnetic_element_mask[triangle] == 0u) {
                continue;
            }
            for (int local_test = 0; local_test < 3; ++local_test) {
                const std::uint64_t potential_row = nodes[local_test];
                for (int local_source = 0; local_source < 3; ++local_source) {
                    const std::uint32_t global_node = nodes[local_source];
                    const auto compact = magnetic_order.find(global_node);
                    const std::uint64_t magnetic_node = compact->second;
                    const double ms = problem.saturation_magnetization_a_per_m != nullptr
                        ? problem.saturation_magnetization_a_per_m[global_node]
                        : problem.uniform_saturation_magnetization_a_per_m;
                    const double source_weight = area * scale * ms / 3.0;
                    for (int component = 0; component < 2; ++component) {
                        const double *frame = problem.tangent_frames_xyz +
                            6u * global_node + 3u * component;
                        const std::uint64_t q_column = 2u * magnetic_node + component;
                        const double transverse = gradients[local_test][0] * frame[0] +
                            gradients[local_test][1] * frame[1];
                        const double axial = -frame[2];
                        add_entry(out_result->a_phiq_perp_row_major, q_dof_count,
                                  potential_row, q_column, source_weight * transverse);
                        add_entry(out_result->a_phiq_axial_row_major, q_dof_count,
                                  potential_row, q_column, source_weight * axial);
                    }
                }
            }
        }

        for (std::uint64_t edge = 0u; edge < problem.robin_edge_count; ++edge) {
            if (problem.robin_edge_marker != nullptr && problem.robin_edge_marker[edge] == 0u) {
                continue;
            }
            const std::uint32_t node_a = problem.robin_edges[2u * edge];
            const std::uint32_t node_b = problem.robin_edges[2u * edge + 1u];
            const double *a = problem.node_xy_m + 2u * node_a;
            const double *b = problem.node_xy_m + 2u * node_b;
            const double dx = b[0] - a[0];
            const double dy = b[1] - a[1];
            const double length = std::hypot(dx, dy);
            if (!std::isfinite(length) || length <= 0.0) {
                copy_error(out_result, "waveguide cross-section Robin edge is degenerate");
                return FrequencyDomainStatus::validation_error;
            }
            out_result->robin_boundary_length_m += length * scale;
            const double edge_scale = problem.robin_beta * length * scale / 6.0;
            add_entry(out_result->k_perp_row_major, scalar, node_a, node_a, 2.0 * edge_scale);
            add_entry(out_result->k_perp_row_major, scalar, node_a, node_b, edge_scale);
            add_entry(out_result->k_perp_row_major, scalar, node_b, node_a, edge_scale);
            add_entry(out_result->k_perp_row_major, scalar, node_b, node_b, 2.0 * edge_scale);
        }

        // The magnetic row block is the Hermitian transpose of the source
        // block.  The axial i*k term changes sign under conjugation.
        for (std::uint64_t row = 0u; row < scalar; ++row) {
            for (std::uint64_t column = 0u; column < q_dof_count; ++column) {
                const double perp = out_result->a_phiq_perp_row_major[
                    static_cast<std::size_t>(row * q_dof_count + column)];
                const double axial = out_result->a_phiq_axial_row_major[
                    static_cast<std::size_t>(row * q_dof_count + column)];
                out_result->a_qphi_perp_row_major[
                    static_cast<std::size_t>(column * scalar + row)] = perp;
                out_result->a_qphi_axial_row_major[
                    static_cast<std::size_t>(column * scalar + row)] = -axial;
            }
        }
        if (!std::isfinite(out_result->cross_section_area_m2) ||
            !std::isfinite(out_result->robin_boundary_length_m) ||
            !finite_vector(out_result->k_perp_row_major) ||
            !finite_vector(out_result->mass_row_major) ||
            !finite_vector(out_result->a_qphi_perp_row_major) ||
            !finite_vector(out_result->a_qphi_axial_row_major) ||
            !finite_vector(out_result->a_phiq_perp_row_major) ||
            !finite_vector(out_result->a_phiq_axial_row_major)) {
            copy_error(out_result, "waveguide cross-section assembly produced a non-finite block");
            return FrequencyDomainStatus::operator_error;
        }
        out_result->normalization_length_m = problem.normalization_length_m;
        return FrequencyDomainStatus::ok;
    } catch (...) {
        out_result->k_perp_row_major.clear();
        out_result->mass_row_major.clear();
        out_result->a_qphi_perp_row_major.clear();
        out_result->a_qphi_axial_row_major.clear();
        out_result->a_phiq_perp_row_major.clear();
        out_result->a_phiq_axial_row_major.clear();
        copy_error(out_result, "waveguide cross-section assembler failed while allocating blocks");
        return FrequencyDomainStatus::operator_error;
    }
}

} // namespace fullmag::fem::frequency_domain
