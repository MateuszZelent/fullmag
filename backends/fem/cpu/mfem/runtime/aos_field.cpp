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

} // namespace

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
        const double x = m_xyz[base + 0u];
        const double y = m_xyz[base + 1u];
        const double z = m_xyz[base + 2u];
        if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) {
            error = "magnetization normalization encountered non-finite values" +
                magnetization_node_context(ctx, node, nodes, x, y, z);
            return false;
        }
        const bool active = ctx.mesh.magnetic_node_mask.empty() ||
            ctx.mesh.magnetic_node_mask[node] != 0u;
        if (!active) {
            continue;
        }
        const double norm = vector_norm3(x, y, z);
        if (!(norm > 0.0) || !std::isfinite(norm)) {
            error = "active magnetic node has zero or invalid magnetization norm" +
                magnetization_node_context(ctx, node, nodes, x, y, z);
            return false;
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

} // namespace fullmag::fem
