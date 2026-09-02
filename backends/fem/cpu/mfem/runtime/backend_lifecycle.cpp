/*
 * FEM backend lifecycle runtime source contract.
 *
 * This source owns runtime initialization and teardown for a native FEM
 * Context: Context construction delegation, transfer-audit environment import,
 * GPU state release, and, when compiled with MFEM, MFEM context destruction. It
 * does not own C ABI handle allocation/deletion, exported backend create/destroy
 * entrypoints, or solver execution.
 */

#include "cpu/mfem/runtime/backend_lifecycle.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

namespace fullmag::fem {

bool initialize_backend_runtime(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (!context_from_plan(ctx, plan, error)) {
        return false;
    }
    configure_transfer_audit_from_env(ctx.transfer_audit.audit);
    return true;
}

void destroy_backend_runtime(Context &ctx)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    gpu_rk_destroy_phase_timing_events(ctx);
#endif
#if FULLMAG_HAS_MFEM_STACK
    context_destroy_mfem(ctx);
#endif
    gpu_state_destroy(ctx.gpu_state.device);
    gpu_performance_reset(ctx.gpu_state.performance_counters);
}

} // namespace fullmag::fem
