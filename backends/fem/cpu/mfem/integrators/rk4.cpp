/*
 * RK4 tableau source contract.
 *
 * This source owns the classical fixed-step fourth-order RK tableau metadata
 * for native FEM LLG integration. It does not allocate workspace, evaluate stages, perform steps, or run adaptive control.
 */

#include "cpu/mfem/integrators/tableaus.hpp"

#include "context.hpp"

namespace fullmag::fem {

/*
 * Classical RK4 integrator for the FEM LLG RHS.
 *
 * Equation and units
 * ------------------
 * The RHS samples dm/dt in 1/s under the canonical Fullmag LLG convention:
 *
 *   dm/dt = -gamma_mu0/(1 + alpha^2)
 *            [m x H_eff + alpha m x (m x H_eff)] + tau_direct.
 *
 * m is dimensionless, H_eff is in A/m, gamma_mu0 is in m/(A s), and dt is in
 * seconds. All stage increments dt * k_i are dimensionless magnetization
 * updates and must be followed by the caller's projection/normalization policy.
 *
 * Method
 * ------
 * This is the fixed-step fourth-order Runge-Kutta method with nodes
 * c = [0, 1/2, 1/2, 1]. It has no embedded lower-order estimator, so adaptive
 * rejection must not be driven from this tableau.
 */
const ExplicitTableau &rk4_tableau() {
    static const ExplicitTableau tableau = {
        /* stages */ 4,
        /* c */      {0.0, 0.5, 0.5, 1.0},
        /* a */      {{0},
                      {0.5},
                      {0.0, 0.5},
                      {0.0, 0.0, 1.0}},
        /* b_hi */   {1.0/6.0, 1.0/3.0, 1.0/3.0, 1.0/6.0},
        /* b_lo */   {0},
        /* order_hi */  4,
        /* order_est */ 0,
        /* fsal */      false,
    };
    return tableau;
}

} // namespace fullmag::fem
