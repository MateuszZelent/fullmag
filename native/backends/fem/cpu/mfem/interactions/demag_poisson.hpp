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
#include "cpu/mfem/interactions/demag_poisson_solve.hpp"
#include "cpu/mfem/interactions/demag_poisson_telemetry.hpp"

namespace fullmag::fem {

/*
 * Aggregated include surface for native Poisson-demag responsibilities.
 */

} // namespace fullmag::fem
