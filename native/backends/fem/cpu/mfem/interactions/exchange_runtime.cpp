/*
 * Exchange runtime refresh source contract.
 *
 * This source owns the Context runtime wrapper that syncs magnetization from
 * device/host state, calls effective-field composition, publishes exchange
 * readiness, and emits optional startup checkpoints. It does not assemble operators or compute exchange components directly.
 */
#include "cpu/mfem/interactions/exchange_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "fem_common.hpp"

#include <cstdio>
#include <string>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

void debug_checkpoint(const char *stage)
{
    static const bool enabled = debug_startup_env_enabled();
    if (!enabled) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

} // namespace

bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error)
{
    debug_checkpoint("context_refresh_exchange_field_mfem:enter");
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return false;
    }
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.state.m_xyz,
            ctx.exchange.h_xyz,
            ctx.demag.h_xyz,
            ctx.effective_field.h_xyz,
            &exchange_energy,
            &demag_energy,
            false,
            nullptr,
            error)) {
        return false;
    }
    ctx.exchange.mfem.ready = true;
    debug_checkpoint("context_refresh_exchange_field_mfem:done");
    return true;
}
#endif

} // namespace fullmag::fem
