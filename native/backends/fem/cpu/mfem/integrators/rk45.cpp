#include "cpu/mfem/integrators/tableaus.hpp"

#include "context.hpp"

namespace fullmag::fem {

/*
 * Dormand-Prince RK45 adaptive integrator for the FEM LLG RHS.
 *
 * Equation and units
 * ------------------
 * Each stage samples dm/dt in 1/s under the solver convention:
 *
 *   dm/dt = -gamma_mu0/(1 + alpha^2)
 *            [m x H_eff + alpha m x (m x H_eff)] + tau_direct.
 *
 * m is dimensionless. H_eff is in A/m. gamma_mu0 is in m/(A s). Direct torque
 * terms such as STT, when represented as RHS terms, must already be in 1/s.
 * With dt in seconds, all accepted and error-estimate increments are
 * dimensionless magnetization updates.
 *
 * Method
 * ------
 * Dormand-Prince 5(4) uses a fifth-order accepted solution and a fourth-order
 * embedded estimate. The method is FSAL: k7 at c=1 can be reused as the next
 * k1 after an accepted step. Rejected steps and any field-contract change must
 * clear FSAL. The adaptive controller outside this file bounds dt by dt_min,
 * dt_max, safety, growth_limit, shrink_limit, and max_reject.
 */
const ExplicitTableau &rk45_dp54_tableau() {
    static const ExplicitTableau tableau = {
        /* stages */ 7,
        /* c */      {0.0, 0.2, 0.3, 0.8, 8.0/9.0, 1.0, 1.0},
        /* a */      {{0},
                      {0.2},
                      {3.0/40.0, 9.0/40.0},
                      {44.0/45.0, -56.0/15.0, 32.0/9.0},
                      {19372.0/6561.0, -25360.0/2187.0, 64448.0/6561.0, -212.0/729.0},
                      {9017.0/3168.0, -355.0/33.0, 46732.0/5247.0, 49.0/176.0, -5103.0/18656.0},
                      {35.0/384.0, 0.0, 500.0/1113.0, 125.0/192.0, -2187.0/6784.0, 11.0/84.0}},
        /* b_hi */   {35.0/384.0, 0.0, 500.0/1113.0, 125.0/192.0, -2187.0/6784.0, 11.0/84.0, 0.0},
        /* b_lo */   {5179.0/57600.0, 0.0, 7571.0/16695.0, 393.0/640.0, -92097.0/339200.0, 187.0/2100.0, 1.0/40.0},
        /* order_hi */  5,
        /* order_est */ 4,
        /* fsal */      true,
    };
    return tableau;
}

} // namespace fullmag::fem
