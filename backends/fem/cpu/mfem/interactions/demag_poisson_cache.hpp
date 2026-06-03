#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Frozen-field cache policy for Poisson demagnetizing fields.
 *
 * This module owns when a cached Poisson H_demag field may be reused, how a
 * freshly solved field and full-domain visualization field are stored, and how
 * cached fields are restored into the solver output buffers. It does not solve
 * the Poisson system, recover H_demag from a potential, or define the demag
 * energy convention.
 */
bool demag_poisson_should_refresh_field(const Context &ctx);

void demag_poisson_store_refreshed_field_cache(
    Context &ctx,
    const std::vector<double> &h_demag_xyz);

bool demag_poisson_try_load_cached_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz);

} // namespace fullmag::fem
