/*
 * AoS field runtime source contract.
 *
 * This source owns generic AoS/component field packing, unpacking, accumulation,
 * projection, and zeroing helpers used by runtime modules. It does not evaluate LLG RHS, compose H_eff, own state I/O, or publish metrics.
 */

#include "cpu/mfem/runtime/aos_field.hpp"

#include "context.hpp"

#include <cstdint>

namespace fullmag::fem {

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
