/*
 * GPU CUDA RK device I/O module header.
 *
 * Compatibility umbrella for audited scalar readback and component-field copy
 * helpers used by the device-resident RK stepper. RK orchestration remains in
 * rk_step.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#endif
