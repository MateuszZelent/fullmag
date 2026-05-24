/*
 * GPU CUDA RK4/RK23 stage sequence compatibility source.
 *
 * Concrete RK4 and RK23/BS23 sequencing lives in rk4_stage_sequence and
 * rk23_stage_sequence. This translation unit is retained so older CMake/source
 * contracts keep a stable compatibility path during the modularization.
 */

#include "gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.hpp"

namespace fullmag::fem {
static_assert(true, "GPU CUDA RK4/RK23 stage sequence compatibility source");
} // namespace fullmag::fem
