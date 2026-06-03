#pragma once

/*
 * GPU CUDA relaxation device-state module header.
 *
 * Owns persistent device buffers whose lifetime spans native FEM relaxation
 * steps. Step-local scratch stays in the RK workspace; algorithm memory such as
 * the nonlinear-CG search direction lives here so GPU minimizers do not depend
 * on host-side std::vector state.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <cstdint>

namespace fullmag::fem {

struct FemGpuRelaxationDeviceState {
    FemGpuComponentField nonlinear_cg_direction;
    FemGpuComponentField nonlinear_cg_direction_backup;
    uint64_t node_count = 0;
    bool nonlinear_cg_direction_valid = false;
};

} // namespace fullmag::fem
