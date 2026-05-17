#include "cpu/mfem/interactions/exchange_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

bool debug_startup_env_enabled()
{
    const char *raw = std::getenv("FULLMAG_FEM_DEBUG_STARTUP");
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
           std::strcmp(raw, "true") == 0 ||
           std::strcmp(raw, "TRUE") == 0 ||
           std::strcmp(raw, "on") == 0 ||
           std::strcmp(raw, "ON") == 0 ||
           std::strcmp(raw, "yes") == 0 ||
           std::strcmp(raw, "YES") == 0;
}

void debug_checkpoint(const char *stage)
{
    if (!debug_startup_env_enabled()) {
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
            ctx.m_xyz,
            ctx.h_ex_xyz,
            ctx.h_demag_xyz,
            ctx.h_eff_xyz,
            &exchange_energy,
            &demag_energy,
            false,
            nullptr,
            error)) {
        return false;
    }
    ctx.mfem_exchange_ready = true;
    debug_checkpoint("context_refresh_exchange_field_mfem:done");
    return true;
}
#endif

} // namespace fullmag::fem
