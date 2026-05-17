#include "cpu/mfem/interactions/thermal_brown_sampler.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/thermal_brown_sigma.hpp"

#include <algorithm>
#include <cmath>
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
    for (uint8_t magnetic : ctx.magnetic_node_mask) {
        if (magnetic != 0u) {
            magnetic_node_count += 1;
        }
    }
    if (magnetic_node_count == 0) {
        return 0.0;
    }

    double total_magnetic_volume = 0.0;
    for (uint32_t element = 0; element < ctx.n_elements; ++element) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(element)] == 0u) {
            continue;
        }
        total_magnetic_volume += tetrahedron_volume(ctx.nodes_xyz, ctx.elements, element);
    }
    if (total_magnetic_volume <= 0.0) {
        return 0.0;
    }
    return total_magnetic_volume / static_cast<double>(magnetic_node_count);
}

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

} // namespace

void initialize_thermal_brown_field(Context &ctx)
{
    if (ctx.temperature > 0.0) {
        ctx.h_therm_xyz.assign(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);
    }
}

void refresh_thermal_brown_field(Context &ctx)
{
    if (ctx.h_therm_xyz.size() != static_cast<size_t>(ctx.n_nodes) * 3u) {
        ctx.h_therm_xyz.assign(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);
    }
    if (ctx.temperature <= 0.0 || ctx.current_dt <= 0.0) {
        ctx.thermal_sigma = 0.0;
        std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
        return;
    }
    if (ctx.last_thermal_refresh_time == ctx.current_time &&
        ctx.last_thermal_refresh_dt == ctx.current_dt) {
        return;
    }

    const bool has_per_node_volume = !ctx.node_volumes.empty();
    const double average_volume =
        has_per_node_volume ? 0.0 : average_magnetic_node_volume(ctx);
    if (!has_per_node_volume && !(average_volume > 0.0)) {
        ctx.thermal_sigma = 0.0;
        std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
        ctx.last_thermal_refresh_time = ctx.current_time;
        ctx.last_thermal_refresh_dt = ctx.current_dt;
        return;
    }

    static thread_local bool rng_initialized = false;
    static thread_local uint64_t rng_active_seed = 0;
    static thread_local std::mt19937_64 rng;
    if (!rng_initialized || rng_active_seed != ctx.thermal_seed) {
        if (ctx.thermal_seed != 0) {
            rng.seed(ctx.thermal_seed);
        } else {
            std::random_device rd;
            rng.seed(rd());
        }
        rng_active_seed = ctx.thermal_seed;
        rng_initialized = true;
    }

    double max_sigma = 0.0;
    std::normal_distribution<double> unit_normal(0.0, 1.0);
    for (size_t node = 0; node < static_cast<size_t>(ctx.n_nodes); ++node) {
        const size_t base = node * 3u;
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[node] == 0u) {
            ctx.h_therm_xyz[base + 0] = 0.0;
            ctx.h_therm_xyz[base + 1] = 0.0;
            ctx.h_therm_xyz[base + 2] = 0.0;
            continue;
        }

        const double damping = scalar_field_value(
            ctx.alpha_field,
            node,
            ctx.material.damping);
        const double saturation_magnetisation = scalar_field_value(
            ctx.Ms_field,
            node,
            ctx.material.saturation_magnetisation);
        const double volume =
            has_per_node_volume ? ctx.node_volumes[node] : average_volume;
        const double sigma = thermal_brown_sigma(
            ctx.temperature,
            damping,
            ctx.material.gyromagnetic_ratio,
            saturation_magnetisation,
            volume,
            ctx.current_dt);
        max_sigma = std::max(max_sigma, sigma);

        if (sigma == 0.0) {
            ctx.h_therm_xyz[base + 0] = 0.0;
            ctx.h_therm_xyz[base + 1] = 0.0;
            ctx.h_therm_xyz[base + 2] = 0.0;
            continue;
        }

        ctx.h_therm_xyz[base + 0] = unit_normal(rng) * sigma;
        ctx.h_therm_xyz[base + 1] = unit_normal(rng) * sigma;
        ctx.h_therm_xyz[base + 2] = unit_normal(rng) * sigma;
    }

    ctx.thermal_sigma = max_sigma;
    ctx.last_thermal_refresh_time = ctx.current_time;
    ctx.last_thermal_refresh_dt = ctx.current_dt;
}

} // namespace fullmag::fem
