#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime output owned by the prescribed-strain magnetoelastic evaluator.
 *
 * Plan-level enable/coupling/strain inputs stay in Context compatibility
 * storage, while this state tracks the computed AoS-3 H_mel field and
 * conservative coupling energy from the last evaluation.
 */
struct MagnetoelasticRuntimeState {
    std::vector<double> h_xyz;
    double energy_joules = 0.0;
};

/*
 * Compute prescribed-strain magnetoelastic effective field and energy.
 *
 * The strain buffer uses Voigt engineering-shear order
 * `[e11, e22, e33, 2e23, 2e13, 2e12]`. The field contribution is returned in
 * A/m and stored in `ctx.magnetoelastic.h_xyz`; the conservative coupling
 * energy is stored in `ctx.magnetoelastic.energy_joules` in joules when lumped
 * masses are available.
 *
 * It does not import plan fields or add H_mel to H_eff.
 */
void compute_magnetoelastic_field(
    Context &ctx,
    const std::vector<double> &m_xyz);

} // namespace fullmag::fem
