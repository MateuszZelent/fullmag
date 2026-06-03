/*
 * Prescribed-strain magnetoelastic source contract.
 *
 * This source owns cubic B1/B2 small-strain H_mel computation, engineering
 * shear conversion, conservative-energy accumulation, per-node Ms fallback, and
 * nonmagnetic-node zeroing. It does not import plan fields or add H_mel to H_eff.
 */
#include "cpu/mfem/interactions/magnetoelastic_prescribed_strain.hpp"

#include "context.hpp"
#include "fem_common.hpp"

namespace fullmag::fem {

void compute_magnetoelastic_field(
    Context &ctx,
    const std::vector<double> &m_xyz)
{
    const size_t n = ctx.mesh.n_nodes;
    ctx.magnetoelastic.h_xyz.assign(n * 3u, 0.0);
    ctx.magnetoelastic.energy_joules = 0.0;

    if (!ctx.magnetoelastic.enabled || ctx.magnetoelastic.strain_voigt.empty()) {
        return;
    }

    const double b1 = ctx.magnetoelastic.b1;
    const double b2 = ctx.magnetoelastic.b2;
    const double uniform_ms = ctx.material_fields.material.saturation_magnetisation;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }

        const double ms_i = scalar_field_value(ctx.material_fields.Ms_field, i, uniform_ms);
        if (!(ms_i > 0.0)) {
            continue;
        }
        const double inv_mu0_ms = -1.0 / (kMu0 * ms_i);

        const double *eps = ctx.magnetoelastic.uniform_strain
            ? ctx.magnetoelastic.strain_voigt.data()
            : ctx.magnetoelastic.strain_voigt.data() + i * 6u;
        const double e11 = eps[0];
        const double e22 = eps[1];
        const double e33 = eps[2];
        const double tensor_e23 = eps[3] * 0.5;
        const double tensor_e13 = eps[4] * 0.5;
        const double tensor_e12 = eps[5] * 0.5;

        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];

        ctx.magnetoelastic.h_xyz[base + 0] =
            inv_mu0_ms * (2.0 * b1 * mx * e11 + 2.0 * b2 * (my * tensor_e12 + mz * tensor_e13));
        ctx.magnetoelastic.h_xyz[base + 1] =
            inv_mu0_ms * (2.0 * b1 * my * e22 + 2.0 * b2 * (mx * tensor_e12 + mz * tensor_e23));
        ctx.magnetoelastic.h_xyz[base + 2] =
            inv_mu0_ms * (2.0 * b1 * mz * e33 + 2.0 * b2 * (mx * tensor_e13 + my * tensor_e23));

        if (i < ctx.integration_weights.mfem_lumped_mass.size()) {
            const double e_density =
                b1 * (mx * mx * e11 + my * my * e22 + mz * mz * e33) +
                2.0 * b2 * (mx * my * tensor_e12 + mx * mz * tensor_e13 + my * mz * tensor_e23);
            energy += e_density * ctx.integration_weights.mfem_lumped_mass[i];
        }
    }

    ctx.magnetoelastic.energy_joules = energy;
}

} // namespace fullmag::fem
