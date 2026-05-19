/*
 * FEM backend step runtime source contract.
 *
 * This source owns one-step runtime orchestration behind the C ABI facade:
 * transfer-audit hot-loop scoping, explicit RK dispatch, GPU RK stats
 * finalization, interrupt snapshot handling, and stage-completion error
 * latching. It does not own exported C ABI entrypoint plumbing, Context
 * construction, interaction physics kernels, or field/state copy APIs.
 */

#include "cpu/mfem/runtime/backend_step.hpp"

#include "context.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_explicit_step.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "gpu_rk.hpp"
#include "transfer_audit.hpp"

namespace fullmag::fem {

namespace {

constexpr const char *kUnavailableMessage =
    "fullmag_fem native backend was built without the MFEM stack; rebuild with FULLMAG_USE_MFEM_STACK=ON and an installed MFEM toolchain";

} // namespace

int run_backend_step(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    error.clear();
    bool ok = false;
    ctx.interrupt.step_interrupted = false;
    ctx.transfer_audit.audit.reset_step_violation();
    const auto &tab = tableau_for_integrator(ctx.base_plan.integrator);
    {
        TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            TransferAuditScopeKind::HotLoop);
        ok = context_step_explicit_rk_mfem(
            ctx, tab, dt_seconds, out_stats, error);
    }
    if (ctx.transfer_audit.audit.hot_loop_violation) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        error = ctx.transfer_audit.audit.hot_loop_violation_message;
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!ok) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (!gpu_rk_finalize_step_stats(ctx, out_stats, error)) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (ctx.interrupt.step_interrupted) {
        if (!context_snapshot_stats_mfem(ctx, out_stats, error)) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED,
            nullptr,
            0.0,
            0.0);
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_ERR_INTERRUPTED;
    }
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)dt_seconds;
    (void)out_stats;
    error = kUnavailableMessage;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
