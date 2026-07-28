/*
 * Brown thermal sampler source contract.
 *
 * This source owns H_therm buffer initialization, node-volume fallback,
 * deterministic accepted-interval RNG seeding, retry raw-draw reuse, and
 * nonmagnetic-node zeroing. It does not define the sigma formula or add H_therm to H_eff.
 */
#include "cpu/mfem/interactions/thermal_brown_sampler.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/thermal_brown_sigma.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <random>

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

double average_magnetic_node_volume(const Context &ctx)
{
    size_t magnetic_node_count = 0;
    for (uint8_t magnetic : ctx.mesh.magnetic_node_mask) {
        if (magnetic != 0u) {
            magnetic_node_count += 1;
        }
    }
    if (magnetic_node_count == 0) {
        return 0.0;
    }

    double total_magnetic_volume = 0.0;
    for (uint32_t element = 0; element < ctx.mesh.n_elements; ++element) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(element)] == 0u) {
            continue;
        }
        total_magnetic_volume += tetrahedron_volume(ctx.mesh.nodes_xyz, ctx.mesh.cell_nodes, element);
    }
    if (total_magnetic_volume <= 0.0) {
        return 0.0;
    }
    return total_magnetic_volume / static_cast<double>(magnetic_node_count);
}

uint64_t splitmix64(uint64_t value)
{
    value += 0x9e3779b97f4a7c15ull;
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ull;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebull;
    return value ^ (value >> 31);
}

uint64_t deterministic_thermal_seed(const Context &ctx)
{
    uint64_t seed = splitmix64(ctx.thermal_brown.seed);
    seed ^= splitmix64(ctx.state.step_count);
    return splitmix64(seed);
}

} // namespace

void initialize_thermal_brown_field(Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0) {
        ctx.thermal_brown.h_xyz.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
        ctx.thermal_brown.xi_xyz.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
        ctx.thermal_brown.raw_draw_valid = false;
    }
}

void refresh_thermal_brown_field(Context &ctx)
{
    if (ctx.thermal_brown.h_xyz.size() != static_cast<size_t>(ctx.mesh.n_nodes) * 3u) {
        ctx.thermal_brown.h_xyz.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
        ctx.thermal_brown.xi_xyz.assign(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
        ctx.thermal_brown.raw_draw_valid = false;
    }
    if (ctx.thermal_brown.temperature <= 0.0 || ctx.adaptive_dt.current_dt <= 0.0) {
        ctx.thermal_brown.sigma = 0.0;
        std::fill(ctx.thermal_brown.h_xyz.begin(), ctx.thermal_brown.h_xyz.end(), 0.0);
        return;
    }
    if (ctx.thermal_brown.raw_draw_valid &&
        ctx.thermal_brown.accepted_interval_index == ctx.state.step_count &&
        ctx.thermal_brown.last_refresh_dt == ctx.adaptive_dt.current_dt) {
        return;
    }

    const bool has_per_node_volume = !ctx.mesh.node_volumes.empty();
    const double average_volume =
        has_per_node_volume ? 0.0 : average_magnetic_node_volume(ctx);
    if (!has_per_node_volume && !(average_volume > 0.0)) {
        ctx.thermal_brown.sigma = 0.0;
        std::fill(ctx.thermal_brown.h_xyz.begin(), ctx.thermal_brown.h_xyz.end(), 0.0);
        ctx.thermal_brown.last_refresh_time = ctx.state.current_time;
        ctx.thermal_brown.last_refresh_dt = ctx.adaptive_dt.current_dt;
        return;
    }

    if (!ctx.thermal_brown.raw_draw_valid ||
        ctx.thermal_brown.accepted_interval_index != ctx.state.step_count) {
        std::mt19937_64 deterministic_rng;
        std::mt19937_64 *rng_ptr = nullptr;
        if (ctx.thermal_brown.seed != 0) {
            deterministic_rng.seed(deterministic_thermal_seed(ctx));
            rng_ptr = &deterministic_rng;
        } else {
            static thread_local bool rng_initialized = false;
            static thread_local std::mt19937_64 rng;
            if (!rng_initialized) {
                std::random_device rd;
                rng.seed(rd());
                rng_initialized = true;
            }
            rng_ptr = &rng;
        }
        std::normal_distribution<double> unit_normal(0.0, 1.0);
        for (size_t node = 0; node < static_cast<size_t>(ctx.mesh.n_nodes); ++node) {
            const size_t base = node * 3u;
            if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
                ctx.thermal_brown.xi_xyz[base + 0] = 0.0;
                ctx.thermal_brown.xi_xyz[base + 1] = 0.0;
                ctx.thermal_brown.xi_xyz[base + 2] = 0.0;
                continue;
            }
            ctx.thermal_brown.xi_xyz[base + 0] = unit_normal(*rng_ptr);
            ctx.thermal_brown.xi_xyz[base + 1] = unit_normal(*rng_ptr);
            ctx.thermal_brown.xi_xyz[base + 2] = unit_normal(*rng_ptr);
        }
        ctx.thermal_brown.accepted_interval_index = ctx.state.step_count;
        ctx.thermal_brown.raw_draw_valid = true;
    }

    double max_sigma = 0.0;
    for (size_t node = 0; node < static_cast<size_t>(ctx.mesh.n_nodes); ++node) {
        const size_t base = node * 3u;
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
            ctx.thermal_brown.h_xyz[base + 0] = 0.0;
            ctx.thermal_brown.h_xyz[base + 1] = 0.0;
            ctx.thermal_brown.h_xyz[base + 2] = 0.0;
            continue;
        }

        const double damping = scalar_field_value(
            ctx.material_fields.alpha_field,
            node,
            ctx.material_fields.material.damping);
        const double saturation_magnetisation = scalar_field_value(
            ctx.material_fields.Ms_field,
            node,
            ctx.material_fields.material.saturation_magnetisation);
        const double volume =
            has_per_node_volume ? ctx.mesh.node_volumes[node] : average_volume;
        const double sigma = thermal_brown_sigma(
            ctx.thermal_brown.temperature,
            damping,
            ctx.material_fields.material.gyromagnetic_ratio,
            saturation_magnetisation,
            volume,
            ctx.adaptive_dt.current_dt);
        max_sigma = std::max(max_sigma, sigma);

        if (sigma == 0.0) {
            ctx.thermal_brown.h_xyz[base + 0] = 0.0;
            ctx.thermal_brown.h_xyz[base + 1] = 0.0;
            ctx.thermal_brown.h_xyz[base + 2] = 0.0;
            continue;
        }

        ctx.thermal_brown.h_xyz[base + 0] = ctx.thermal_brown.xi_xyz[base + 0] * sigma;
        ctx.thermal_brown.h_xyz[base + 1] = ctx.thermal_brown.xi_xyz[base + 1] * sigma;
        ctx.thermal_brown.h_xyz[base + 2] = ctx.thermal_brown.xi_xyz[base + 2] * sigma;
    }

    ctx.thermal_brown.sigma = max_sigma;
    ctx.thermal_brown.last_refresh_time = ctx.state.current_time;
    ctx.thermal_brown.last_refresh_dt = ctx.adaptive_dt.current_dt;
}

} // namespace fullmag::fem
