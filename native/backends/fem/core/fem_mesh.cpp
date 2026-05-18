/*
 * FEM mesh core source contract.
 *
 * This source owns mesh geometry/marker import, magnetic mask policy, static
 * periodic topology reduction, periodic compatibility gates, periodic material
 * class validation, and nodal-volume geometry helpers. It does not own base scalar plan fields, material fields, state initialization, field buffers, runtime devices, or interaction physics.
 */

#include "core/fem_mesh.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace fullmag::fem {
namespace {

template <typename T>
void copy_optional_span(
    const T *source,
    size_t count,
    std::vector<T> &destination,
    T fill_value = T{})
{
    destination.assign(count, fill_value);
    if (source != nullptr && count > 0) {
        std::copy(source, source + count, destination.begin());
    }
}

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

bool initialize_mesh_plan_fields(
    Context &ctx,
    const fullmag_fem_mesh_desc &mesh,
    std::string &error)
{
    if (mesh.n_periodic_node_pairs > 0 && mesh.periodic_node_pairs == nullptr) {
        error = "FEM mesh periodic_node_pairs pointer is null";
        return false;
    }

    ctx.mesh.nodes_xyz.assign(
        mesh.nodes_xyz,
        mesh.nodes_xyz + static_cast<size_t>(ctx.n_nodes) * 3u);
    ctx.mesh.elements.assign(
        mesh.elements,
        mesh.elements + static_cast<size_t>(ctx.n_elements) * 4u);
    copy_optional_span(
        mesh.element_markers,
        static_cast<size_t>(ctx.n_elements),
        ctx.mesh.element_markers,
        0u);
    copy_optional_span(
        mesh.boundary_faces,
        static_cast<size_t>(ctx.n_boundary_faces) * 3u,
        ctx.mesh.boundary_faces,
        0u);
    copy_optional_span(
        mesh.boundary_markers,
        static_cast<size_t>(ctx.n_boundary_faces),
        ctx.mesh.boundary_markers,
        0u);

    ctx.mesh.periodic_node_pairs.clear();
    if (mesh.n_periodic_node_pairs > 0) {
        const size_t pair_scalar_count =
            static_cast<size_t>(mesh.n_periodic_node_pairs) * 2u;
        ctx.mesh.periodic_node_pairs.assign(
            mesh.periodic_node_pairs,
            mesh.periodic_node_pairs + pair_scalar_count);
    }
    if (!build_static_periodic_reduction(ctx, error)) {
        return false;
    }

    ctx.mesh.periodic_boundary_marker_set.clear();
    if (mesh.periodic_boundary_pair_markers != nullptr &&
        mesh.periodic_boundary_pair_count > 0) {
        for (uint32_t i = 0; i < mesh.periodic_boundary_pair_count; ++i) {
            ctx.mesh.periodic_boundary_marker_set.insert(
                mesh.periodic_boundary_pair_markers[2u * i]);
            ctx.mesh.periodic_boundary_marker_set.insert(
                mesh.periodic_boundary_pair_markers[2u * i + 1u]);
        }
    }

    return true;
}

void initialize_magnetic_masks(Context &ctx)
{
    ctx.mesh.magnetic_element_mask.assign(static_cast<size_t>(ctx.n_elements), 1u);
    if (!ctx.mesh.element_markers.empty()) {
        bool has_air = false;
        bool has_magnetic = false;
        for (size_t i = 0; i < ctx.mesh.element_markers.size(); ++i) {
            has_air = has_air || ctx.mesh.element_markers[i] == 0u;
            has_magnetic = has_magnetic || ctx.mesh.element_markers[i] != 0u;
        }
        if (has_air && has_magnetic) {
            for (size_t i = 0; i < ctx.mesh.element_markers.size(); ++i) {
                ctx.mesh.magnetic_element_mask[i] =
                    ctx.mesh.element_markers[i] != 0u ? 1u : 0u;
            }
        }
    }

    ctx.mesh.magnetic_node_mask.assign(static_cast<size_t>(ctx.n_nodes), 0u);
    for (uint32_t e = 0; e < ctx.n_elements; ++e) {
        if (ctx.mesh.magnetic_element_mask[e] == 0u) {
            continue;
        }
        const size_t base = static_cast<size_t>(e) * 4u;
        for (int v = 0; v < 4; ++v) {
            ctx.mesh.magnetic_node_mask[ctx.mesh.elements[base + static_cast<size_t>(v)]] = 1u;
        }
    }
}

bool validate_periodic_plan_compatibility(Context &ctx, std::string &error)
{
    if (ctx.mesh.periodic_node_pairs.empty()) {
        return true;
    }
    if (!ctx.enable_exchange) {
        error = "native FEM periodic_node_pairs require enable_exchange=true";
        return false;
    }

#if !FULLMAG_HAS_MFEM_STACK
    const bool demag_pbc_supported = false;
#else
    const bool demag_pbc_supported = true;
#endif
    if ((!demag_pbc_supported && ctx.enable_demag) ||
        ctx.enable_magnetoelastic || ctx.has_oersted_cylinder ||
        ctx.has_oersted_field || ctx.temperature > 0.0 ||
        ctx.has_zhang_li_stt || ctx.has_slonczewski_stt) {
        error =
            "native FEM time-domain periodic_node_pairs currently support only "
            "exchange, uniform Zeeman field, local anisotropy, DMI, and (MFEM stack) "
            "demag via algebraic P^T A P; magnetoelastic, thermal noise, "
            "Oersted and STT require dedicated periodic reduced operators";
        return false;
    }

    if (!validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Ms_field, "Ms_field", error) ||
        !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.A_field, "A_field", error) ||
        !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.alpha_field, "alpha_field", error)) {
        return false;
    }
    if (ctx.enable_anisotropy || ctx.enable_cubic_anisotropy) {
        if (!validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Ku_field, "Ku_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Ku2_field, "Ku2_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Kc1_field, "Kc1_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Kc2_field, "Kc2_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Kc3_field, "Kc3_field", error)) {
            return false;
        }
    }
    if (ctx.enable_dmi || ctx.enable_bulk_dmi) {
        if (!validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Dind_field, "Dind_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.material_fields.Dbulk_field, "Dbulk_field", error)) {
            return false;
        }
    }
    return true;
}

bool build_static_periodic_reduction(Context &ctx, std::string &error) {
    ctx.mesh.periodic_reduced_node.clear();
    ctx.mesh.periodic_representative_nodes.clear();
    ctx.mesh.periodic_reduced_node_count = 0;
    if (ctx.mesh.periodic_node_pairs.empty()) {
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

    const size_t n_pairs = ctx.mesh.periodic_node_pairs.size() / 2u;
    for (size_t pair_index = 0; pair_index < n_pairs; ++pair_index) {
        const uint32_t node_a = ctx.mesh.periodic_node_pairs[pair_index * 2u];
        const uint32_t node_b = ctx.mesh.periodic_node_pairs[pair_index * 2u + 1u];
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
    ctx.mesh.periodic_reduced_node.assign(static_cast<size_t>(ctx.n_nodes), 0u);
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t root = find_root(node);
        uint32_t reduced = root_to_reduced[static_cast<size_t>(root)];
        if (reduced == unset_reduced) {
            reduced = static_cast<uint32_t>(ctx.mesh.periodic_representative_nodes.size());
            root_to_reduced[static_cast<size_t>(root)] = reduced;
            ctx.mesh.periodic_representative_nodes.push_back(root);
        }
        ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)] = reduced;
    }
    ctx.mesh.periodic_reduced_node_count =
        static_cast<uint32_t>(ctx.mesh.periodic_representative_nodes.size());
    return true;
}

bool validate_periodic_scalar_field_classes(
    const Context &ctx,
    const std::vector<double> &field,
    const char *field_name,
    std::string &error)
{
    if (field.empty() || ctx.mesh.periodic_reduced_node.empty()) {
        return true;
    }
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
        const uint32_t representative =
            ctx.mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
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
    ctx.mesh.node_volumes.assign(n, 0.0);

    for (uint32_t elem = 0; elem < ctx.n_elements; ++elem) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const double v_tet = tetrahedron_volume(ctx.mesh.nodes_xyz, ctx.mesh.elements, elem);
        const double quarter_v = v_tet * 0.25;
        const size_t base = static_cast<size_t>(elem) * 4u;
        for (int k = 0; k < 4; ++k) {
            const uint32_t node = ctx.mesh.elements[base + static_cast<size_t>(k)];
            ctx.mesh.node_volumes[node] += quarter_v;
        }
    }
}

} // namespace fullmag::fem
