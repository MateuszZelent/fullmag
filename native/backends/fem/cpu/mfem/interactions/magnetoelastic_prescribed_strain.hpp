#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime state owned by the prescribed-strain magnetoelastic evaluator.
 *
 * This state owns plan-level enablement, B1/B2 coupling constants, strain mode and
 * Voigt strain storage, the computed AoS-3 H_mel field, and conservative
 * coupling energy from the last evaluation.
 */
struct MagnetoelasticRuntimeState {
    bool enabled = false;
    double b1 = 0.0;
    double b2 = 0.0;
    bool uniform_strain = true;
    std::vector<double> strain_voigt;
    std::vector<double> h_xyz;
    double energy_joules = 0.0;
};

/*
 * Compute prescribed-strain magnetoelastic effective field and energy.
 *
 * This module owns prescribed-strain magnetoelastic H_mel and energy
 * evaluation from the current magnetization.
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
