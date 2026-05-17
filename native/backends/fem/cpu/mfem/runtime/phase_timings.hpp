#pragma once

#include "cpu/mfem/interactions/demag_poisson_telemetry.hpp"

#include <cstdint>

namespace fullmag::fem {

/*
 * Native FEM per-phase wall-clock timings.
 *
 * This runtime telemetry value object is passed through effective-field,
 * demag, integrator, snapshot, and step-stat aggregation paths during one
 * native FEM evaluation. It intentionally stays outside Context so module
 * entrypoints can accumulate timing data without exporting transient telemetry
 * definitions from the Context compatibility facade.
 */
struct PhaseTimings {
    uint64_t exchange_wall_time_ns = 0;
    DemagPoissonPhaseTimings demag;
    uint64_t rhs_wall_time_ns = 0;
    uint64_t extra_energy_wall_time_ns = 0;
    uint64_t snapshot_wall_time_ns = 0;
};

} // namespace fullmag::fem
