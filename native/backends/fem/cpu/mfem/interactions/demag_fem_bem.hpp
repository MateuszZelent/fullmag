#pragma once

#include "fullmag_fem.h"

#include "cpu/mfem/interactions/demag_fem_bem_boundary_values.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_energy.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_potential.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_rhs.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_solve.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_surface.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_telemetry.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_workspace.hpp"

namespace fullmag::fem {

/*
 * Aggregated include surface for native Fredkin-Koehler FEM/BEM demag modules.
 *
 * This umbrella owns only the stable include surface for open-boundary
 * Fredkin-Koehler demag.
 * This umbrella header keeps a stable include target for open-boundary demag,
 * but it does not define surface extraction, BEM operator assembly, sparse
 * solves, potential transfer, recovery, energy, or telemetry. Those
 * responsibilities stay in the dedicated owner modules:
 * demag_fem_bem_surface.*, demag_fem_bem_operator.*,
 * demag_fem_bem_linear_solve.*, demag_fem_bem_potential.*,
 * demag_fem_bem_solve.*, demag_fem_bem_energy.*, and
 * demag_fem_bem_telemetry.*.
 */

} // namespace fullmag::fem
