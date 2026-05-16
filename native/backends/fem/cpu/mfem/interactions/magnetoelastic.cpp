#include "cpu/mfem/interactions/magnetoelastic.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {
namespace {

/*
 * Prescribed-strain magnetoelastic interaction for the native FEM CPU backend.
 *
 * Physical contract
 * -----------------
 * The module implements cubic B1/B2 small-strain coupling as an effective field
 * in A/m plus conservative energy in joules. The LLG RHS later converts this
 * H_eff contribution into dm/dt.
 */

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

} // namespace

void compute_magnetoelastic_field(
    Context &ctx,
    const std::vector<double> &m_xyz)
{
    const size_t n = ctx.n_nodes;
    ctx.h_mel_xyz.assign(n * 3u, 0.0);
    ctx.mel_energy = 0.0;

    if (!ctx.enable_magnetoelastic || ctx.mel_strain_voigt.empty()) {
        return;
    }

    const double b1 = ctx.mel_b1;
    const double b2 = ctx.mel_b2;
    const double uniform_ms = ctx.material.saturation_magnetisation;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }

        const double ms_i = scalar_field_value(ctx.Ms_field, i, uniform_ms);
        if (!(ms_i > 0.0)) {
            continue;
        }
        const double inv_mu0_ms = -1.0 / (kMu0 * ms_i);

        const double *eps = ctx.mel_uniform_strain
            ? ctx.mel_strain_voigt.data()
            : ctx.mel_strain_voigt.data() + i * 6u;
        const double e11 = eps[0];
        const double e22 = eps[1];
        const double e33 = eps[2];
        const double e23 = eps[3] * 0.5;
        const double e13 = eps[4] * 0.5;
        const double e12 = eps[5] * 0.5;

        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];

        ctx.h_mel_xyz[base + 0] =
            inv_mu0_ms * (2.0 * b1 * mx * e11 + 2.0 * b2 * (my * e12 + mz * e13));
        ctx.h_mel_xyz[base + 1] =
            inv_mu0_ms * (2.0 * b1 * my * e22 + 2.0 * b2 * (mx * e12 + mz * e23));
        ctx.h_mel_xyz[base + 2] =
            inv_mu0_ms * (2.0 * b1 * mz * e33 + 2.0 * b2 * (mx * e13 + my * e23));

        if (i < ctx.mfem_lumped_mass.size()) {
            const double e_density =
                b1 * (mx * mx * e11 + my * my * e22 + mz * mz * e33) +
                2.0 * b2 * (mx * my * e12 + mx * mz * e13 + my * mz * e23);
            energy += e_density * ctx.mfem_lumped_mass[i];
        }
    }

    ctx.mel_energy = energy;
}

void add_magnetoelastic_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.enable_magnetoelastic || ctx.h_mel_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.h_mel_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.h_mel_xyz[i];
    }
}

} // namespace fullmag::fem
