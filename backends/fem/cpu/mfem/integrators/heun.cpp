/*
 * Heun tableau source contract.
 *
 * This source owns the fixed-step explicit trapezoidal RK2 tableau metadata for
 * native FEM LLG integration. It does not allocate workspace, evaluate stages, perform steps, or run adaptive control.
 */

#include "cpu/mfem/integrators/tableaus.hpp"

#include "context.hpp"

namespace fullmag::fem {

/*
 * Heun explicit RK2 integrator for the FEM LLG RHS.
 *
 * Equation and units
 * ------------------
 * The sampled RHS is dm/dt in 1/s:
 *
 *   dm/dt = -gamma_mu0/(1 + alpha^2)
 *            [m x H_eff + alpha m x (m x H_eff)] + tau_direct.
 *
 * m is dimensionless, H_eff is in A/m, gamma_mu0 is in m/(A s), and
 * tau_direct is in 1/s. The timestep dt is in seconds, so each increment
 * dt * k_i is dimensionless and can be added to m before renormalization.
 *
 * Method
 * ------
 * Heun is the explicit trapezoidal RK2 method:
 *
 *   k1 = f(t_n, m_n)
 *   k2 = f(t_n + dt, m_n + dt k1)
 *   m_{n+1} = m_n + dt/2 (k1 + k2)
 *
 * It has no embedded error estimate and no FSAL reuse. Adaptive control must
 * therefore not treat this tableau as an error-estimating pair.
 */
const ExplicitTableau &heun_tableau() {
    static const ExplicitTableau tableau = {
        /* stages */ 2,
        /* c */      {0.0, 1.0},
        /* a */      {{0},
                      {1.0}},
        /* b_hi */   {0.5, 0.5},
        /* b_lo */   {0},
        /* order_hi */  2,
        /* order_est */ 0,
        /* fsal */      false,
    };
    return tableau;
}

} // namespace fullmag::fem
