#pragma once

#include "cpu/mfem/integrators/rk_tableau.hpp"
#include "cpu/mfem/interactions/stt.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace fullmag::fem {

/*
 * Reusable explicit Runge-Kutta stepper workspace.
 *
 * The native FEM explicit RK path reuses these AOS buffers across accepted and
 * rejected steps: magnetization backup, stage RHS vectors, temporary effective
 * fields, adaptive error estimates, and the FSAL cache validity flag. The
 * structure contains storage only; physical RHS assembly and time integration
 * live in the RK modules.
 *
 * It does not evaluate stage RHS, advance time, compose H_eff, or own adaptive
 * accept/reject policy.
 */
struct StepperWorkspace {
    bool allocated = false;
    std::size_t dof_len = 0;                       // n_nodes * 3
    int stages = 0;                                // currently allocated RK stages
    std::vector<double> m_backup;                  // backup of m before stage loop
    std::vector<double> k[MAX_RK_STAGES];          // stage derivatives k_i
    std::vector<double> m_stage;                   // temp: m at stage evaluation point
    std::vector<double> m_candidate;               // private high-order candidate
    std::vector<double> h_ex_tmp;                  // temp exchange field
    std::vector<double> h_demag_tmp;               // temp demag field
    std::vector<double> h_eff_tmp;                 // temp effective field
    SttWorkspace stt;                              // temp direct-torque scratch
    std::vector<double> err;                       // error = h*(b_hi - b_lo) . K
    bool fsal_valid = false;                       // true when k[0] holds valid FSAL RHS
};

enum class RkStepFailurePoint : uint32_t {
    None = 0,
    AfterCandidateMagnetization = 1,
    DuringFinalFieldRefresh = 2,
    DuringFinalStatistics = 3,
};

struct RkStepFailureInjectionState {
    RkStepFailurePoint next = RkStepFailurePoint::None;
    uint64_t injected_count = 0;
};

/*
 * Runtime owner for the reusable explicit RK workspace.
 *
 * Context stores this owner rather than a flat StepperWorkspace so the
 * integrator subsystem remains the boundary for RK storage. It does not
 * evaluate stages, choose tableaus, advance time, or own adaptive policy.
 */
struct RkStepperRuntimeState {
    StepperWorkspace workspace{};
    RkStepFailureInjectionState failure_injection{};
};

} // namespace fullmag::fem
