#pragma once

#include "cpu/mfem/integrators/rk_tableau.hpp"

namespace fullmag::fem {

/*
 * Own named explicit Runge-Kutta tableau accessors.
 *
 * The functions return immutable coefficient sets for Heun, RK4, Bogacki-
 * Shampine RK23, and Dormand-Prince RK45. They keep named tableau definitions
 * separate from workspace allocation and step execution.
 *
 * It does not allocate workspace, evaluate stages, perform steps, or run
 * adaptive control.
 */
const ExplicitTableau &heun_tableau();
const ExplicitTableau &rk4_tableau();
const ExplicitTableau &rk23_bs_tableau();
const ExplicitTableau &rk45_dp54_tableau();

} // namespace fullmag::fem
