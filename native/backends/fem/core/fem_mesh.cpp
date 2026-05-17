#include "core/fem_mesh.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace fullmag::fem {
namespace {

double tetrahedron_volume(
    const std::vector<double> &nodes_xyz,
    const std::vector<uint32_t> &elements,
    uint32_t element_index)
{
    const size_t base = static_cast<size_t>(element_index) * 4u;
    const auto read_coord = [&](uint32_t node, int axis) -> double {
        return nodes_xyz[static_cast<size_t>(node) * 3u + static_cast<size_t>(axis)];
    };

    const uint32_t n0 = elements[base + 0];
    const uint32_t n1 = elements[base + 1];
    const uint32_t n2 = elements[base + 2];
    const uint32_t n3 = elements[base + 3];

    const double ax = read_coord(n1, 0) - read_coord(n0, 0);
    const double ay = read_coord(n1, 1) - read_coord(n0, 1);
    const double az = read_coord(n1, 2) - read_coord(n0, 2);
    const double bx = read_coord(n2, 0) - read_coord(n0, 0);
    const double by = read_coord(n2, 1) - read_coord(n0, 1);
    const double bz = read_coord(n2, 2) - read_coord(n0, 2);
    const double cx = read_coord(n3, 0) - read_coord(n0, 0);
    const double cy = read_coord(n3, 1) - read_coord(n0, 1);
    const double cz = read_coord(n3, 2) - read_coord(n0, 2);

    const double determinant =
        ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx);

    return std::abs(determinant) / 6.0;
}

} // namespace

bool build_static_periodic_reduction(Context &ctx, std::string &error) {
    ctx.periodic_reduced_node.clear();
    ctx.periodic_representative_nodes.clear();
    ctx.periodic_reduced_node_count = 0;
    if (ctx.periodic_node_pairs.empty()) {
        return true;
    }

    std::vector<uint32_t> parent(static_cast<size_t>(ctx.n_nodes), 0u);
    for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
        parent[static_cast<size_t>(i)] = i;
    }

    auto find_root = [&](uint32_t node) {
        uint32_t root = node;
        while (parent[static_cast<size_t>(root)] != root) {
            root = parent[static_cast<size_t>(root)];
        }
        while (parent[static_cast<size_t>(node)] != node) {
            const uint32_t next = parent[static_cast<size_t>(node)];
            parent[static_cast<size_t>(node)] = root;
            node = next;
        }
        return root;
    };

    auto unite = [&](uint32_t a, uint32_t b) {
        const uint32_t root_a = find_root(a);
        const uint32_t root_b = find_root(b);
        if (root_a == root_b) {
            return;
        }
        const uint32_t representative = std::min(root_a, root_b);
        const uint32_t dependent = std::max(root_a, root_b);
        parent[static_cast<size_t>(dependent)] = representative;
    };

    const size_t n_pairs = ctx.periodic_node_pairs.size() / 2u;
    for (size_t pair_index = 0; pair_index < n_pairs; ++pair_index) {
        const uint32_t node_a = ctx.periodic_node_pairs[pair_index * 2u];
        const uint32_t node_b = ctx.periodic_node_pairs[pair_index * 2u + 1u];
        if (node_a >= ctx.n_nodes || node_b >= ctx.n_nodes) {
            error = "FEM mesh periodic_node_pairs references node outside mesh";
            return false;
        }
        if (node_a == node_b) {
            error = "FEM mesh periodic_node_pairs contains a self-pair";
            return false;
        }
        unite(node_a, node_b);
    }

    const uint32_t unset_reduced = static_cast<uint32_t>(-1);
    std::vector<uint32_t> root_to_reduced(static_cast<size_t>(ctx.n_nodes), unset_reduced);
    ctx.periodic_reduced_node.assign(static_cast<size_t>(ctx.n_nodes), 0u);
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t root = find_root(node);
        uint32_t reduced = root_to_reduced[static_cast<size_t>(root)];
        if (reduced == unset_reduced) {
            reduced = static_cast<uint32_t>(ctx.periodic_representative_nodes.size());
            root_to_reduced[static_cast<size_t>(root)] = reduced;
            ctx.periodic_representative_nodes.push_back(root);
        }
        ctx.periodic_reduced_node[static_cast<size_t>(node)] = reduced;
    }
    ctx.periodic_reduced_node_count =
        static_cast<uint32_t>(ctx.periodic_representative_nodes.size());
    return true;
}

bool validate_periodic_scalar_field_classes(
    const Context &ctx,
    const std::vector<double> &field,
    const char *field_name,
    std::string &error)
{
    if (field.empty() || ctx.periodic_reduced_node.empty()) {
        return true;
    }
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(node)];
        const uint32_t representative =
            ctx.periodic_representative_nodes[static_cast<size_t>(reduced)];
        const double value = field[static_cast<size_t>(node)];
        const double expected = field[static_cast<size_t>(representative)];
        const double tolerance = 1e-12 * std::max(1.0, std::abs(expected));
        if (std::abs(value - expected) > tolerance) {
            error = std::string("native FEM periodic_node_pairs require per-node field '") +
                    field_name + "' to be equal within each periodic node class";
            return false;
        }
    }
    return true;
}

void compute_node_volumes(Context &ctx) {
    const size_t n = static_cast<size_t>(ctx.n_nodes);
    ctx.node_volumes.assign(n, 0.0);

    for (uint32_t elem = 0; elem < ctx.n_elements; ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const double v_tet = tetrahedron_volume(ctx.nodes_xyz, ctx.elements, elem);
        const double quarter_v = v_tet * 0.25;
        const size_t base = static_cast<size_t>(elem) * 4u;
        for (int k = 0; k < 4; ++k) {
            const uint32_t node = ctx.elements[base + static_cast<size_t>(k)];
            ctx.node_volumes[node] += quarter_v;
        }
    }
}

} // namespace fullmag::fem
