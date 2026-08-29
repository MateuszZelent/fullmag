/*
 * Explicit RK workspace source contract.
 *
 * This source owns explicit RK tableau dispatch and reusable stepper workspace
 * allocation/invalidation for native FEM LLG integration. It does not evaluate stage RHS, perform complete RK steps, compose H_eff, or own adaptive control.
 */

#include "cpu/mfem/integrators/rk_explicit.hpp"

#include "cpu/mfem/integrators/tableaus.hpp"
#include "context.hpp"

#include <cstdio>
#include <cstdlib>
#include <utility>

namespace fullmag::fem {

StepperWorkspace::~StepperWorkspace() = default;

StepperWorkspace::StepperWorkspace(const StepperWorkspace &other)
    : allocated(other.allocated),
      dof_len(other.dof_len),
      stages(other.stages),
      m_stage(other.m_stage),
      m_candidate(other.m_candidate),
      h_ex_tmp(other.h_ex_tmp),
      h_demag_tmp(other.h_demag_tmp),
      h_eff_tmp(other.h_eff_tmp),
      stt(other.stt),
      err(other.err),
      attempt_checkpoint(nullptr),
      fsal_valid(other.fsal_valid),
      endpoint_telemetry(other.endpoint_telemetry)
{
    for (int i = 0; i < MAX_RK_STAGES; ++i) {
        k[i] = other.k[i];
    }
}

StepperWorkspace &StepperWorkspace::operator=(const StepperWorkspace &other)
{
    if (this == &other) {
        return *this;
    }
    allocated = other.allocated;
    dof_len = other.dof_len;
    stages = other.stages;
    for (int i = 0; i < MAX_RK_STAGES; ++i) {
        k[i] = other.k[i];
    }
    m_stage = other.m_stage;
    m_candidate = other.m_candidate;
    h_ex_tmp = other.h_ex_tmp;
    h_demag_tmp = other.h_demag_tmp;
    h_eff_tmp = other.h_eff_tmp;
    stt = other.stt;
    err = other.err;
    transaction_journal.reset();
    attempt_checkpoint.reset();
    fsal_valid = other.fsal_valid;
    endpoint_telemetry = other.endpoint_telemetry;
    return *this;
}

StepperWorkspace::StepperWorkspace(StepperWorkspace &&other) noexcept
    : allocated(other.allocated),
      dof_len(other.dof_len),
      stages(other.stages),
      m_stage(std::move(other.m_stage)),
      m_candidate(std::move(other.m_candidate)),
      h_ex_tmp(std::move(other.h_ex_tmp)),
      h_demag_tmp(std::move(other.h_demag_tmp)),
      h_eff_tmp(std::move(other.h_eff_tmp)),
      stt(std::move(other.stt)),
      err(std::move(other.err)),
      attempt_checkpoint(nullptr),
      fsal_valid(other.fsal_valid),
      endpoint_telemetry(std::move(other.endpoint_telemetry))
{
    for (int i = 0; i < MAX_RK_STAGES; ++i) {
        k[i] = std::move(other.k[i]);
    }
}

StepperWorkspace &StepperWorkspace::operator=(StepperWorkspace &&other) noexcept
{
    if (this == &other) {
        return *this;
    }
    allocated = other.allocated;
    dof_len = other.dof_len;
    stages = other.stages;
    for (int i = 0; i < MAX_RK_STAGES; ++i) {
        k[i] = std::move(other.k[i]);
    }
    m_stage = std::move(other.m_stage);
    m_candidate = std::move(other.m_candidate);
    h_ex_tmp = std::move(other.h_ex_tmp);
    h_demag_tmp = std::move(other.h_demag_tmp);
    h_eff_tmp = std::move(other.h_eff_tmp);
    stt = std::move(other.stt);
    err = std::move(other.err);
    transaction_journal.reset();
    attempt_checkpoint.reset();
    fsal_valid = other.fsal_valid;
    endpoint_telemetry = std::move(other.endpoint_telemetry);
    return *this;
}

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
    bool stage_buffers_ready = true;
    for (int i = 0; i < stages; ++i) {
        if (ws.k[i].size() != dof_len) {
            stage_buffers_ready = false;
            break;
        }
    }
    if (ws.allocated && ws.dof_len == dof_len && ws.stages == stages && stage_buffers_ready) {
        return;
    }
    ws.dof_len = dof_len;
    ws.stages = stages;
    for (int i = 0; i < stages; ++i) {
        ws.k[i].resize(dof_len, 0.0);
    }
    ws.m_stage.resize(dof_len, 0.0);
    ws.m_candidate.resize(dof_len, 0.0);
    ws.h_ex_tmp.resize(dof_len, 0.0);
    ws.h_demag_tmp.resize(dof_len, 0.0);
    ws.h_eff_tmp.resize(dof_len, 0.0);
    prepare_stt_workspace(ws.stt, dof_len, dof_len / 3u);
    ws.err.resize(dof_len, 0.0);
    ws.fsal_valid = false;
    ws.endpoint_telemetry = {};
    ws.allocated = true;
}

} // namespace fullmag::fem
