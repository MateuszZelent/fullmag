#pragma once

#include "fullmag_fem.h"

#include "cpu/mfem/interactions/demag_poisson_boundary.hpp"
#include "cpu/mfem/interactions/demag_poisson_cache.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/demag_poisson_field.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "cpu/mfem/interactions/demag_poisson_lifecycle.hpp"
#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"
#include "cpu/mfem/interactions/demag_poisson_ready.hpp"
#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"
#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"
#include "cpu/mfem/interactions/demag_poisson_runtime.hpp"
#include "cpu/mfem/interactions/demag_poisson_solve.hpp"
#include "cpu/mfem/interactions/demag_poisson_telemetry.hpp"

namespace fullmag::fem {

/*
 * Aggregated include surface for native Poisson-demag responsibilities.
 *
 * This umbrella header exists for compatibility with callers that need the
 * complete Poisson-demag surface, but it does not define RHS assembly,
 * boundary policy, solve, recovery, energy, cache, or telemetry. It also does
 * not own runtime state. Those responsibilities stay in the dedicated owner modules:
 * demag_poisson_rhs.*, demag_poisson_boundary.*, demag_poisson_solve.*,
 * demag_poisson_recovery.*, demag_poisson_energy.*, demag_poisson_cache.*,
 * demag_poisson_runtime.*, and demag_poisson_telemetry.*.
 */

} // namespace fullmag::fem
