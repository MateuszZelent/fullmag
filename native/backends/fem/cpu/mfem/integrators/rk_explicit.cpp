#include "cpu/mfem/integrators/rk_explicit.hpp"

#include "cpu/mfem/integrators/tableaus.hpp"
#include "context.hpp"

#include <cstdio>
#include <cstdlib>

namespace fullmag::fem {

/*
 * Explicit Runge-Kutta time integrators for the native FEM LLG backend.
 *
 * Physical equation integrated by this module
 * ------------------------------------------
 * The state variable is the reduced magnetization m = M / Ms, dimensionless,
 * with |m| = 1 on magnetic degrees of freedom. The RHS produced by the field
 * assembler and torque terms has units 1/s and follows the Fullmag solver
 * convention documented in docs/physics/units.md:
 *
 *   dm/dt =
 *     -gamma_mu0 / (1 + alpha^2)
 *       [m x H_eff + alpha m x (m x H_eff)]
 *     + tau_direct.
 *
 * H_eff is measured in A/m, gamma_mu0 is measured in m/(A s), alpha is
 * dimensionless, and tau_direct is measured in 1/s. This file does not define
 * exchange, demag, anisotropy, DMI, thermal noise, or STT physics. It only
 * defines how an already assembled RHS is sampled in time.
 *
 * Numerical methods
 * -----------------
 * HEUN, RK4, RK23_BS, and RK45_DP54 live in separate files in this directory.
 * This file owns only the common dispatch and reusable workspace allocation.
 *
 * Units and acceptance
 * --------------------
 * The tableaus are dimensionless. The step size dt is in seconds. Stage
 * increments dt * k_i are dimensionless because k_i has units 1/s. Adaptive
 * rejection is handled by the caller using the weighted norm
 * |err| / (atol + rtol * max(|m_old|, |m_new|)); this module only exposes the
 * tableaus and reusable workspace allocation.
 */

const ExplicitTableau &tableau_for_integrator(fullmag_fem_integrator integrator) {
    switch (integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:      return heun_tableau();
        case FULLMAG_FEM_INTEGRATOR_RK4:       return rk4_tableau();
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:   return rk23_bs_tableau();
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54: return rk45_dp54_tableau();
        default:
            std::fprintf(
                stderr,
                "FATAL: tableau_for_integrator called with unsupported "
                "integrator value %d; refusing silent fallback to Heun\n",
                static_cast<int>(integrator));
            std::abort();
    }
}

void stepper_workspace_allocate(StepperWorkspace &ws, std::size_t dof_len, int stages) {
    if (ws.allocated && ws.dof_len == dof_len) {
        return;
    }
    ws.dof_len = dof_len;
    ws.m_backup.resize(dof_len, 0.0);
    for (int i = 0; i < stages; ++i) {
        ws.k[i].resize(dof_len, 0.0);
    }
    ws.m_stage.resize(dof_len, 0.0);
    ws.h_ex_tmp.resize(dof_len, 0.0);
    ws.h_demag_tmp.resize(dof_len, 0.0);
    ws.h_eff_tmp.resize(dof_len, 0.0);
    ws.err.resize(dof_len, 0.0);
    ws.fsal_valid = false;
    ws.allocated = true;
}

} // namespace fullmag::fem
