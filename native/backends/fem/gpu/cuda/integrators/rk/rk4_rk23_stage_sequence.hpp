/*
 * GPU CUDA RK4/RK23 stage sequence compatibility header.
 *
 * Compatibility include for callers migrating to per-integrator stage sequence
 * owners. Concrete RK4 and RK23/BS23 sequencing lives in rk4_stage_sequence
 * and rk23_stage_sequence.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk23_stage_sequence.hpp"
#include "gpu/cuda/integrators/rk/rk4_stage_sequence.hpp"
#endif
