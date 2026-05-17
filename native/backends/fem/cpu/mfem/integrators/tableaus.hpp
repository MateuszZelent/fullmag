#pragma once

#include "cpu/mfem/integrators/rk_tableau.hpp"

namespace fullmag::fem {

const ExplicitTableau &heun_tableau();
const ExplicitTableau &rk4_tableau();
const ExplicitTableau &rk23_bs_tableau();
const ExplicitTableau &rk45_dp54_tableau();

} // namespace fullmag::fem
