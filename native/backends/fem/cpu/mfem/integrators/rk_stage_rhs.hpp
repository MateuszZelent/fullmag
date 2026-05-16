#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;
struct StepperWorkspace;

/*
 * Evaluate one explicit Runge-Kutta RHS stage for the native FEM LLG solver.
 *
 * The caller supplies the stage magnetization state. This module owns the
 * stage-local effective-field assembly, LLG RHS conversion, direct STT RHS
 * addition, non-magnetic node masking, optional max-RHS output, optional
 * exchange/demag energy outputs, and RHS phase timing accumulation.
 */
#if FULLMAG_HAS_MFEM_STACK
bool evaluate_rk_stage_rhs(
    Context &ctx,
    const std::vector<double> &m_state,
    StepperWorkspace &ws,
    std::vector<double> &out_k,
    double *out_max_rhs,
    double *out_exchange_energy,
    double *out_demag_energy,
    PhaseTimings *timings,
    std::string &error);
#endif

} // namespace fullmag::fem
