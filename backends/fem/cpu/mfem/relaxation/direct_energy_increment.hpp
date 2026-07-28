#pragma once

#include "fullmag_fem.h"
#include "src/relaxation_numerics.hpp"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

bool direct_minimizer_armijo_accepts(
    Context &ctx,
    const char *algorithm_name,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_h_demag,
    const std::vector<double> &previous_h_eff,
    const fullmag_fem_step_stats &current_stats,
    const fullmag_fem_step_stats &trial_stats,
    fullmag_fem_step_stats &profile_stats,
    relaxation::EnergyDifference &direct_difference,
    relaxation::EnergyDifference &accepted_difference,
    double &armijo_increment_rhs_j,
    std::string &error);

} // namespace fullmag::fem
