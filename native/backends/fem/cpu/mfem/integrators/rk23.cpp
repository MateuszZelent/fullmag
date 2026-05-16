#include "cpu/mfem/integrators/tableaus.hpp"

#include "context.hpp"

namespace fullmag::fem {

/*
 * Bogacki-Shampine RK23 adaptive integrator for the FEM LLG RHS.
 *
 * Equation and units
 * ------------------
 * The sampled function is the Fullmag LLG RHS in 1/s:
 *
 *   dm/dt = -gamma_mu0/(1 + alpha^2)
 *            [m x H_eff + alpha m x (m x H_eff)] + tau_direct.
 *
 * H_eff is in A/m, gamma_mu0 is in m/(A s), alpha is dimensionless, and
 * tau_direct is in 1/s. The tableau coefficients are dimensionless; dt is in
 * seconds; the embedded error vector dt * sum((b_hi - b_lo) k_i) is
 * dimensionless and compared to dimensionless magnetization tolerances.
 *
 * Method
 * ------
 * Bogacki-Shampine 3(2) uses a third-order accepted solution and a second-order
 * embedded estimate. The last stage is FSAL: after an accepted step, k4 at c=1
 * may become k1 for the next step if the caller keeps the field/torque contract
 * unchanged. Rejected steps must invalidate FSAL.
 */
const ExplicitTableau &rk23_bs_tableau() {
    static const ExplicitTableau tableau = {
        /* stages */ 4,
        /* c */      {0.0, 0.5, 0.75, 1.0},
        /* a */      {{0},
                      {0.5},
                      {0.0, 0.75},
                      {2.0/9.0, 1.0/3.0, 4.0/9.0}},
        /* b_hi */   {2.0/9.0, 1.0/3.0, 4.0/9.0, 0.0},
        /* b_lo */   {7.0/24.0, 0.25, 1.0/3.0, 0.125},
        /* order_hi */  3,
        /* order_est */ 2,
        /* fsal */      true,
    };
    return tableau;
}

} // namespace fullmag::fem
