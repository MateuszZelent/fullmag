/*
 * RK stage RHS source contract.
 *
 * This source owns one RK-stage RHS evaluation from the current stage
 * magnetization, including effective-field composition, optional direct-torque
 * addition, and stage-local timing. It does not define RK tableau coefficients, allocate stepper workspace, accept/reject adaptive steps, or publish final step metrics.
 */

#include "cpu/mfem/integrators/rk_stage_rhs.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/runtime/phase_timings.hpp"
#include "fem_common.hpp"

namespace fullmag::fem {

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
    std::string &error)
{
    if (!compute_effective_fields_for_magnetization(
            ctx,
            m_state,
            ws.h_ex_tmp,
            ws.h_demag_tmp,
            ws.h_eff_tmp,
            out_exchange_energy,
            out_demag_energy,
            true,
            timings,
            error)) {
        return false;
    }
    double max_rhs = 0.0;
    {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->rhs_wall_time_ns : nullptr);
        llg_rhs_aos(m_state, ws.h_eff_tmp,
                    ctx.material.gyromagnetic_ratio, ctx.material.damping,
                    ctx.material_fields.alpha_field.empty() ? nullptr : &ctx.material_fields.alpha_field,
                    out_k, max_rhs);
        add_stt_rhs_aos(ctx, m_state, out_k, max_rhs, ws.stt);
        zero_non_magnetic_nodes_aos(out_k, ctx.mesh.magnetic_node_mask);
    }
    if (out_max_rhs != nullptr) {
        *out_max_rhs = max_rhs;
    }
    return true;
}
#endif

} // namespace fullmag::fem
