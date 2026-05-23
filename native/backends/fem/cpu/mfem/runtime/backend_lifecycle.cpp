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
#include "gpu_state.hpp"
#include "transfer_audit.hpp"

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
#if FULLMAG_HAS_MFEM_STACK
    context_destroy_mfem(ctx);
#endif
    gpu_state_destroy(ctx.gpu_state.device);
}

} // namespace fullmag::fem
