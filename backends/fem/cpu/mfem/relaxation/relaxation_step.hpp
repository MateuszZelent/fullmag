#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

struct FemRelaxationRuntimeState {
    double step_size = 1.0e-6;
    bool use_bb1 = true;
    uint64_t reset_consecutive = 0;
    uint64_t accepted_steps = 0;
    std::vector<double> nonlinear_cg_direction;
};

int run_native_relaxation_step(
    Context &ctx,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem
