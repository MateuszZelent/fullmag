/*
 * Zeeman energy source contract.
 *
 * This source owns E_Z = -mu0 integral Ms m.H_ext dV over nodal lumped weights
 * with per-node Ms fallback. It does not broadcast H_ext or add H_ext to H_eff.
 */
#include "cpu/mfem/interactions/zeeman_energy.hpp"

#include "core/fem_element_quadrature_material.hpp"
#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace fullmag::fem {

double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    if (!ctx.zeeman.has_external_field) {
        return 0.0;
    }

    if (!ctx.material_fields.Ms_element_field.empty() &&
        ctx.material_fields.runtime.has_value()) {
        return -kMu0 * ctx.material_fields.runtime->ms_weighted_aos3_mass_bilinear(
            m_xyz, ctx.zeeman.h_ext_xyz);
    }

    const size_t n = std::min(ctx.integration_weights.mfem_lumped_mass.size(), m_xyz.size() / 3u);
    double energy = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double mdoth =
            m_xyz[base + 0] * ctx.zeeman.h_ext_xyz[base + 0] +
            m_xyz[base + 1] * ctx.zeeman.h_ext_xyz[base + 1] +
            m_xyz[base + 2] * ctx.zeeman.h_ext_xyz[base + 2];
        const double Ms_i = scalar_field_value(
            ctx.material_fields.Ms_field,
            i,
            ctx.material_fields.material.saturation_magnetisation);
        energy += -kMu0 * Ms_i * mdoth * ctx.integration_weights.mfem_lumped_mass[i];
    }
    return energy;
}

relaxation::EnergyDifference zeeman_energy_difference_from_field(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz)
{
    relaxation::EnergyDifference result;
    if (current_m_xyz.size() == 0u || current_m_xyz.size() % 3u != 0u ||
        trial_m_xyz.size() != current_m_xyz.size() ||
        ctx.zeeman.h_ext_xyz.size() != current_m_xyz.size()) {
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    const size_t nodes = current_m_xyz.size() / 3u;
    if (!ctx.zeeman.has_external_field) {
        return result;
    }
    if (!ctx.material_fields.Ms_element_field.empty() &&
        ctx.material_fields.runtime.has_value()) {
        std::vector<double> delta(trial_m_xyz.size());
        for (size_t index = 0; index < delta.size(); ++index) {
            delta[index] = trial_m_xyz[index] - current_m_xyz[index];
        }
        const Aos3MassBilinearTermwiseResult termwise =
            ctx.material_fields.runtime->ms_weighted_aos3_mass_bilinear_termwise(
                delta, ctx.zeeman.h_ext_xyz);
        result.delta_joules = -kMu0 * termwise.value;
        result.absolute_term_sum_joules = kMu0 * termwise.absolute_term_sum;
        result.roundoff_bound_joules = relaxation::reduction_roundoff_bound(
            termwise.scalar_term_count) * result.absolute_term_sum_joules;
        return result;
    }
    if (ctx.integration_weights.mfem_lumped_mass.size() < nodes) {
        return result;
    }
    for (size_t node = 0; node < nodes; ++node) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) continue;
        const double ms = scalar_field_value(ctx.material_fields.Ms_field, node,
            ctx.material_fields.material.saturation_magnetisation);
        const double weight = -kMu0 * ms * ctx.integration_weights.mfem_lumped_mass[node];
        const size_t base = 3u * node;
        for (size_t c = 0; c < 3u; ++c) {
            const double term = weight * (trial_m_xyz[base+c] - current_m_xyz[base+c]) *
                ctx.zeeman.h_ext_xyz[base+c];
            result.delta_joules += term;
            result.absolute_term_sum_joules += std::abs(term);
        }
    }
    result.roundoff_bound_joules = relaxation::reduction_roundoff_bound(current_m_xyz.size()) * result.absolute_term_sum_joules;
    return result;
}

double zeeman_energy_from_element_quadrature_material(
    const ElementQuadratureMaterial &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_ext_xyz)
{
    return -kMu0 * material.ms_weighted_aos3_mass_bilinear(m_xyz, h_ext_xyz);
}

} // namespace fullmag::fem
