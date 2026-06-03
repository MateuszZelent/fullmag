#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Recovered-field postprocessing for Poisson demag.
 *
 * This module owns the solver-field postprocessing that happens after
 * H_demag = -grad(u) has been recovered: periodic representative projection,
 * synchronization of the full-domain visualization demag field, and
 * reconstruction of the visualization H_eff buffer. It does not assemble or
 * solve the Poisson system and does not define demag energy.
 */
void finalize_demag_poisson_recovered_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz);

void update_demag_poisson_visual_effective_field(
    Context &ctx,
    const std::vector<double> &h_eff_xyz,
    const std::vector<double> &h_demag_xyz);

} // namespace fullmag::fem
