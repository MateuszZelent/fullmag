/*
 * AoS field runtime source contract.
 *
 * This source owns generic AoS/component field packing, unpacking, accumulation,
 * projection, and zeroing helpers used by runtime modules. It does not evaluate LLG RHS, compose H_eff, own state I/O, or publish metrics.
 */

#include "cpu/mfem/runtime/aos_field.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <cstdint>
#include <cmath>
#include <limits>

namespace fullmag::fem {
namespace {

size_t active_node_count(const Context &ctx, size_t nodes)
{
    if (ctx.mesh.magnetic_node_mask.empty()) {
        return nodes;
    }
    size_t count = 0;
    for (uint8_t active : ctx.mesh.magnetic_node_mask) {
        if (active != 0u) {
            ++count;
        }
    }
    return count;
}

std::string magnetization_node_context(
    const Context &ctx,
    size_t node,
    size_t nodes,
    double x,
    double y,
    double z)
{
    const std::string mask_state = ctx.mesh.magnetic_node_mask.empty()
        ? "empty"
        : std::to_string(static_cast<unsigned>(ctx.mesh.magnetic_node_mask[node]));
    return " at node " + std::to_string(node) +
        " value=(" + std::to_string(x) + "," + std::to_string(y) + "," +
        std::to_string(z) + ") magnetic_mask=" + mask_state +
        " active_nodes=" + std::to_string(active_node_count(ctx, nodes)) +
        "/" + std::to_string(nodes);
}

bool validate_periodic_node_map(const Context &ctx, std::string &error)
{
    const size_t nodes = static_cast<size_t>(ctx.mesh.n_nodes);
    const auto &reduced = ctx.mesh.periodic_reduced_node;
    const auto &representatives = ctx.mesh.periodic_representative_nodes;
    if (reduced.empty()) {
        if (!representatives.empty() || ctx.mesh.periodic_reduced_node_count != 0) {
            error = "periodic AoS map has representatives without a reduced-node map";
            return false;
        }
        return true;
    }
    if (reduced.size() != nodes) {
        error = "periodic AoS reduced-node map size mismatch";
        return false;
    }
    const size_t class_count = ctx.mesh.periodic_reduced_node_count != 0
        ? static_cast<size_t>(ctx.mesh.periodic_reduced_node_count)
        : representatives.size();
    if (class_count == 0 || representatives.size() != class_count) {
        error = "periodic AoS representative map size mismatch";
        return false;
    }
    for (uint32_t representative : representatives) {
        if (representative >= ctx.mesh.n_nodes) {
            error = "periodic AoS representative references a node outside the mesh";
            return false;
        }
    }
    for (uint32_t class_index : reduced) {
        if (static_cast<size_t>(class_index) >= class_count) {
            error = "periodic AoS reduced-node class index is out of range";
            return false;
        }
    }
    return true;
}

} // namespace

bool bind_local_node_aos_vector_field(
    const Context &ctx,
    std::vector<double> &field_xyz,
    AosVectorFieldView &view,
    std::string &error)
{
    const size_t nodes = static_cast<size_t>(ctx.mesh.n_nodes);
    if (nodes > std::numeric_limits<size_t>::max() / 3u ||
        field_xyz.size() != nodes * 3u) {
        error = "local-node AoS field length mismatch";
        return false;
    }
    if (!validate_periodic_node_map(ctx, error)) {
        return false;
    }
    if (!ctx.mesh.periodic_reduced_node.empty() &&
        ctx.mesh.periodic_reduced_node_count == 0) {
        error = "local-node AoS field has no periodic-node class count";
        return false;
    }
    if (!ctx.mesh.periodic_reduced_node.empty() &&
        ctx.mesh.periodic_map_revision == 0) {
        error = "local-node AoS field has no periodic-map revision";
        return false;
    }
    view.data = field_xyz.empty() ? nullptr : field_xyz.data();
    view.node_count = nodes;
    view.space = AosVectorFieldSpace::local_nodes;
    view.periodic_map_revision = ctx.mesh.periodic_map_revision;
    return true;
}

void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    x.resize(n);
    y.resize(n);
    z.resize(n);
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0u];
        y[i] = aos[i * 3u + 1u];
        z[i] = aos[i * 3u + 2u];
    }
}

void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    if (x.size() != n || y.size() != n || z.size() != n) {
        unpack_aos_to_components(aos, x, y, z);
        return;
    }
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0u];
        y[i] = aos[i * 3u + 1u];
        z[i] = aos[i * 3u + 2u];
    }
}

void pack_components_to_aos(
    const std::vector<double> &x,
    const std::vector<double> &y,
    const std::vector<double> &z,
    std::vector<double> &aos)
{
    const size_t n = x.size();
    aos.resize(n * 3u);
    for (size_t i = 0; i < n; ++i) {
        aos[i * 3u + 0u] = x[i];
        aos[i * 3u + 1u] = y[i];
        aos[i * 3u + 2u] = z[i];
    }
}

bool normalize_active_magnetization_aos(
    const Context &ctx,
    std::vector<double> &m_xyz,
    std::string &error)
{
    const size_t nodes = static_cast<size_t>(ctx.mesh.n_nodes);
    const size_t expected_len = nodes * 3u;
    if (m_xyz.size() != expected_len) {
        error = "magnetization normalization length mismatch";
        return false;
    }
    if (!ctx.mesh.magnetic_node_mask.empty() &&
        ctx.mesh.magnetic_node_mask.size() != nodes) {
        error = "magnetization normalization magnetic-node mask size mismatch";
        return false;
    }

    for (size_t node = 0; node < nodes; ++node) {
        const size_t base = node * 3u;
        const bool active = ctx.mesh.magnetic_node_mask.empty() ||
            ctx.mesh.magnetic_node_mask[node] != 0u;
        if (!active) {
            continue;
        }
        const double x = m_xyz[base + 0u];
        const double y = m_xyz[base + 1u];
        const double z = m_xyz[base + 2u];
        if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) {
            error = "magnetization normalization encountered non-finite values" +
                magnetization_node_context(ctx, node, nodes, x, y, z);
            return false;
        }
        const double norm = vector_norm3(x, y, z);
        if (!(norm >= std::numeric_limits<double>::min()) || !std::isfinite(norm)) {
            error = "active magnetic node has zero, subnormal, or invalid magnetization norm" +
                magnetization_node_context(ctx, node, nodes, x, y, z);
            return false;
        }
        const double unit_roundoff_budget =
            8.0 * std::numeric_limits<double>::epsilon();
        if (std::abs(norm - 1.0) <= unit_roundoff_budget) {
            continue;
        }
        const double inv = 1.0 / norm;
        m_xyz[base + 0u] = x * inv;
        m_xyz[base + 1u] = y * inv;
        m_xyz[base + 2u] = z * inv;
    }
    return true;
}

void project_static_periodic_aos(
    const Context &ctx,
    std::vector<double> &field_xyz)
{
    if (ctx.mesh.periodic_reduced_node.empty()) {
        return;
    }
    std::string error;
    if (!validate_periodic_node_map(ctx, error) ||
        field_xyz.size() != static_cast<size_t>(ctx.mesh.n_nodes) * 3u) {
        return;
    }
    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
        const uint32_t representative =
            ctx.mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
        const size_t dst = static_cast<size_t>(node) * 3u;
        const size_t src = static_cast<size_t>(representative) * 3u;
        field_xyz[dst + 0u] = field_xyz[src + 0u];
        field_xyz[dst + 1u] = field_xyz[src + 1u];
        field_xyz[dst + 2u] = field_xyz[src + 2u];
    }
}

bool project_static_periodic_aos_checked(
    const Context &ctx,
    std::vector<double> &field_xyz,
    std::string &error)
{
    AosVectorFieldView view;
    if (!bind_local_node_aos_vector_field(ctx, field_xyz, view, error)) {
        return false;
    }
    if (view.periodic_map_revision == 0) {
        return true;
    }
    for (size_t node = 0; node < view.node_count; ++node) {
        const uint32_t reduced = ctx.mesh.periodic_reduced_node[node];
        const uint32_t representative =
            ctx.mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
        const size_t dst = node * 3u;
        const size_t src = static_cast<size_t>(representative) * 3u;
        view.data[dst + 0u] = view.data[src + 0u];
        view.data[dst + 1u] = view.data[src + 1u];
        view.data[dst + 2u] = view.data[src + 2u];
    }
    return true;
}

} // namespace fullmag::fem
