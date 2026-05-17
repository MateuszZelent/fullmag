#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute prescribed-strain magnetoelastic effective field and energy.
 *
 * The strain buffer uses Voigt engineering-shear order
 * `[e11, e22, e33, 2e23, 2e13, 2e12]`. The field contribution is returned in
 * A/m and stored in `ctx.h_mel_xyz`; the conservative coupling energy is stored
 * in `ctx.mel_energy` in joules when lumped masses are available.
 */
void compute_magnetoelastic_field(
    Context &ctx,
    const std::vector<double> &m_xyz);

} // namespace fullmag::fem
