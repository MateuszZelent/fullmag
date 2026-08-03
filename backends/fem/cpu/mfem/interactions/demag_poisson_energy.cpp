/*
 * Poisson demag energy source contract.
 *
 * This source owns Poisson demag energy integration and the cached-field helper,
 * which matches the direct physical field energy for frozen-field reuse. It does
 * not add a separate Robin term. It does not assemble RHS, solve Poisson, recover fields, or manage cache validity.
 */

#include "cpu/mfem/interactions/demag_poisson_energy.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <limits>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

double demag_poisson_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    if (ctx.material_fields.runtime &&
        ctx.material_fields.runtime->has_elementwise_ms()) {
        return -0.5 * kMu0 *
            ctx.material_fields.runtime->ms_weighted_aos3_mass_bilinear(
                m_xyz, h_demag_xyz);
    }
    if (ctx.integration_weights.mfem_lumped_mass.empty()) {
        return 0.0;
    }

    const size_t n = std::min(
        {ctx.integration_weights.mfem_lumped_mass.size(), m_xyz.size() / 3u, h_demag_xyz.size() / 3u});
    double demag_energy = 0.0;
#ifdef _OPENMP
    energy_threads = std::max(1, energy_threads);
#else
    (void)energy_threads;
#endif
#ifdef _OPENMP
#pragma omp parallel for schedule(static) reduction(+:demag_energy) if(energy_threads > 1 && static_cast<int>(n) >= 2048) num_threads(energy_threads)
#endif
    for (int node_index = 0; node_index < static_cast<int>(n); ++node_index) {
        const size_t node = static_cast<size_t>(node_index);
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const size_t base = node * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        const double ms_i = scalar_field_value(
            ctx.material_fields.Ms_field,
            node,
            ctx.material_fields.material.saturation_magnetisation);
        demag_energy += -0.5 * kMu0 * ms_i * mdoth * ctx.integration_weights.mfem_lumped_mass[node];
    }
    return demag_energy;
}

double demag_poisson_cached_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    return demag_poisson_energy_from_field(ctx, m_xyz, h_demag_xyz, energy_threads);
}

#if FULLMAG_HAS_MFEM_STACK
double demag_poisson_energy_from_rhs_potential(
    const mfem::Vector &rhs,
    const mfem::Vector &potential)
{
    if (rhs.Size() != potential.Size()) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return 0.5 * kMu0 * (rhs * potential);
}
#endif

relaxation::EnergyDifference demag_poisson_energy_difference_from_endpoint_fields(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz,
    const std::vector<double> &current_h_demag_xyz,
    const std::vector<double> &trial_h_demag_xyz)
{
    relaxation::EnergyDifference result;
    const size_t field_size = current_m_xyz.size();
    if (field_size == 0u || field_size % 3u != 0u ||
        trial_m_xyz.size() != field_size ||
        current_h_demag_xyz.size() != field_size ||
        trial_h_demag_xyz.size() != field_size) {
        result.delta_joules = std::numeric_limits<double>::quiet_NaN();
        result.absolute_term_sum_joules = std::numeric_limits<double>::quiet_NaN();
        result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    const size_t nodes = field_size / 3u;
    if (ctx.material_fields.runtime &&
        ctx.material_fields.runtime->has_elementwise_ms()) {
        std::vector<double> dm(field_size);
        std::vector<double> hs(field_size);
        for (size_t i = 0; i < field_size; ++i) {
            dm[i] = trial_m_xyz[i] - current_m_xyz[i];
            hs[i] = trial_h_demag_xyz[i] + current_h_demag_xyz[i];
        }
        const auto termwise =
            ctx.material_fields.runtime->ms_weighted_aos3_mass_bilinear_termwise(dm, hs);
        result.delta_joules = -0.5 * kMu0 * termwise.value;
        result.absolute_term_sum_joules = 0.5 * kMu0 * termwise.absolute_term_sum;
        result.roundoff_bound_joules =
            relaxation::reduction_roundoff_bound(termwise.scalar_term_count) *
            result.absolute_term_sum_joules;
        return result;
    }
    if (ctx.integration_weights.mfem_lumped_mass.size() < nodes) {
        result.delta_joules = std::numeric_limits<double>::quiet_NaN();
        result.absolute_term_sum_joules = std::numeric_limits<double>::quiet_NaN();
        result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    for (size_t node = 0; node < nodes; ++node) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const double ms = scalar_field_value(
            ctx.material_fields.Ms_field,
            node,
            ctx.material_fields.material.saturation_magnetisation);
        const double weight = -0.5 * kMu0 * ms *
            ctx.integration_weights.mfem_lumped_mass[node];
        const size_t base = 3u * node;
        for (size_t component = 0; component < 3u; ++component) {
            const double term = weight *
                (trial_m_xyz[base + component] - current_m_xyz[base + component]) *
                (trial_h_demag_xyz[base + component] + current_h_demag_xyz[base + component]);
            result.delta_joules += term;
            result.absolute_term_sum_joules += std::abs(term);
        }
    }
    result.roundoff_bound_joules = relaxation::reduction_roundoff_bound(field_size) *
        result.absolute_term_sum_joules;
    return result;
}

relaxation::EnergyDifference robin_boundary_energy_difference_from_endpoint_products(
    double coefficient,
    const std::vector<double> &current_u,
    const std::vector<double> &trial_u,
    const std::vector<double> &current_boundary_product,
    const std::vector<double> &trial_boundary_product)
{
    relaxation::EnergyDifference result;
    if (!std::isfinite(coefficient) || coefficient < 0.0 || current_u.empty() ||
        trial_u.size() != current_u.size() ||
        current_boundary_product.size() != current_u.size() ||
        trial_boundary_product.size() != current_u.size()) {
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    for (size_t i = 0; i < current_u.size(); ++i) {
        const double term = 0.5 * coefficient * (trial_u[i] - current_u[i]) *
            (trial_boundary_product[i] + current_boundary_product[i]);
        if (!std::isfinite(term)) {
            result.delta_joules = result.absolute_term_sum_joules =
                result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
            return result;
        }
        result.delta_joules += term;
        result.absolute_term_sum_joules += std::abs(term);
    }
    result.roundoff_bound_joules =
        relaxation::reduction_roundoff_bound(current_u.size()) *
        result.absolute_term_sum_joules;
    return result;
}

} // namespace fullmag::fem
