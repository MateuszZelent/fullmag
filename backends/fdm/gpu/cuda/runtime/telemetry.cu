/*
 * telemetry.cu - Native FDM step diagnostics and observable reductions.
 *
 * C ABI entrypoints request telemetry through Context; this owner wires the
 * current device state to energy, field-amplitude, and torque reductions.
 */

#include "context.hpp"

#include <cstring>

namespace fullmag {
namespace fdm {

extern double launch_exchange_energy_fp64(Context &ctx);
extern double launch_exchange_energy_fp32(Context &ctx);
extern double launch_demag_energy_fp64(Context &ctx);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp64(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp64(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp32(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp64(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp32(Context &ctx);
extern double reduce_dmi_energy_fp64(Context &ctx);
extern double reduce_dmi_energy_fp32(Context &ctx);
extern double reduce_current_rhs_norm_fp64(Context &ctx);
extern double reduce_current_rhs_norm_fp32(Context &ctx);
extern double reduce_max_norm_fp64(
    Context &ctx,
    const void *vx,
    const void *vy,
    const void *vz,
    uint64_t n);
extern double reduce_max_norm_fp32(
    Context &ctx,
    const void *vx,
    const void *vy,
    const void *vz,
    uint64_t n);
extern double reduce_max_cross_norm_fp64(
    Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz,
    uint64_t n);
extern double reduce_max_cross_norm_fp32(
    Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz,
    uint64_t n);

namespace {

uint64_t requested_stats_mask(const Context &ctx) {
    switch (ctx.stats_mode) {
    case FULLMAG_FDM_STATS_CONTROL:
        return FULLMAG_FDM_STATS_QUANTITY_CONTROL;
    case FULLMAG_FDM_STATS_REQUESTED:
        return ctx.stats_quantity_mask;
    case FULLMAG_FDM_STATS_FULL:
    case FULLMAG_FDM_STATS_NONE:
    default:
        return FULLMAG_FDM_STATS_QUANTITY_ALL;
    }
}

uint64_t expand_stats_dependencies(uint64_t mask) {
    if ((mask & FULLMAG_FDM_STATS_QUANTITY_E_TOTAL) != 0) {
        mask |= FULLMAG_FDM_STATS_QUANTITY_E_EX |
            FULLMAG_FDM_STATS_QUANTITY_E_DEMAG |
            FULLMAG_FDM_STATS_QUANTITY_E_EXT |
            FULLMAG_FDM_STATS_QUANTITY_E_ANI |
            FULLMAG_FDM_STATS_QUANTITY_E_DMI;
    }
    return mask;
}

} // namespace

bool context_fill_current_stats(Context &ctx, fullmag_fdm_step_stats *out_stats) {
    if (out_stats == nullptr) return false;
    const uint64_t quantity_mask =
        expand_stats_dependencies(requested_stats_mask(ctx));
    if (context_copy_endpoint_stats(ctx, out_stats, quantity_mask)) {
        ++ctx.endpoint_field_cache.stats_snapshot_cache_hit_count;
        return true;
    }
    uint64_t required_field_mask = 0;
    if ((quantity_mask & (FULLMAG_FDM_STATS_QUANTITY_E_DEMAG |
                          FULLMAG_FDM_STATS_QUANTITY_MAX_H_DEMAG)) != 0) {
        required_field_mask |= OBSERVABLE_ENDPOINT_H_DEMAG;
    }
    if ((quantity_mask & (FULLMAG_FDM_STATS_QUANTITY_MAX_H_EFF |
                          FULLMAG_FDM_STATS_QUANTITY_MAX_TORQUE |
                          FULLMAG_FDM_STATS_QUANTITY_MAX_RHS)) != 0) {
        required_field_mask |= OBSERVABLE_ENDPOINT_CORE_FIELDS;
    }
    if (required_field_mask != 0 &&
        !context_ensure_observable_fields(ctx, required_field_mask)) {
        return false;
    }

    std::memset(out_stats, 0, sizeof(*out_stats));
    out_stats->step = ctx.accepted_step_pending ? ctx.pending_step_count : ctx.step_count;
    out_stats->time_seconds = ctx.accepted_step_pending ? ctx.pending_time : ctx.current_time;

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_EX) != 0) {
            out_stats->exchange_energy_joules =
                ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_DEMAG) != 0) {
            out_stats->demag_energy_joules =
                ctx.enable_demag ? launch_demag_energy_fp64(ctx) : 0.0;
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_EXT) != 0) {
            out_stats->external_energy_joules = launch_external_energy_fp64(ctx);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_ANI) != 0) {
            out_stats->anisotropy_energy_joules =
                reduce_uniaxial_anisotropy_energy_fp64(ctx);
            out_stats->cubic_energy_joules = reduce_cubic_anisotropy_energy_fp64(ctx);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_DMI) != 0) {
            out_stats->dmi_energy_joules = reduce_dmi_energy_fp64(ctx);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_H_EFF) != 0) {
            out_stats->max_effective_field_amplitude = reduce_max_norm_fp64(
                ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_H_DEMAG) != 0) {
            out_stats->max_demag_field_amplitude = ctx.enable_demag
                ? reduce_max_norm_fp64(
                    ctx,
                    ctx.h_demag.x,
                    ctx.h_demag.y,
                    ctx.h_demag.z,
                    ctx.cell_count)
                : 0.0;
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_TORQUE) != 0) {
            out_stats->max_torque_Apm = reduce_max_cross_norm_fp64(
                ctx,
                ctx.m.x, ctx.m.y, ctx.m.z,
                ctx.work.x, ctx.work.y, ctx.work.z,
                ctx.cell_count);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_RHS) != 0) {
            out_stats->max_rhs_amplitude = reduce_current_rhs_norm_fp64(ctx);
        }
    } else {
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_EX) != 0) {
            out_stats->exchange_energy_joules =
                ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_DEMAG) != 0) {
            out_stats->demag_energy_joules =
                ctx.enable_demag ? launch_demag_energy_fp32(ctx) : 0.0;
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_EXT) != 0) {
            out_stats->external_energy_joules = launch_external_energy_fp32(ctx);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_ANI) != 0) {
            out_stats->anisotropy_energy_joules =
                reduce_uniaxial_anisotropy_energy_fp32(ctx);
            out_stats->cubic_energy_joules = reduce_cubic_anisotropy_energy_fp32(ctx);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_DMI) != 0) {
            out_stats->dmi_energy_joules = reduce_dmi_energy_fp32(ctx);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_H_EFF) != 0) {
            out_stats->max_effective_field_amplitude = reduce_max_norm_fp32(
                ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_H_DEMAG) != 0) {
            out_stats->max_demag_field_amplitude = ctx.enable_demag
                ? reduce_max_norm_fp32(
                    ctx,
                    ctx.h_demag.x,
                    ctx.h_demag.y,
                    ctx.h_demag.z,
                    ctx.cell_count)
                : 0.0;
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_TORQUE) != 0) {
            out_stats->max_torque_Apm = reduce_max_cross_norm_fp32(
                ctx,
                ctx.m.x, ctx.m.y, ctx.m.z,
                ctx.work.x, ctx.work.y, ctx.work.z,
                ctx.cell_count);
        }
        if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_MAX_RHS) != 0) {
            out_stats->max_rhs_amplitude = reduce_current_rhs_norm_fp32(ctx);
        }
    }

    if ((quantity_mask & FULLMAG_FDM_STATS_QUANTITY_E_TOTAL) != 0) {
        out_stats->total_energy_joules =
            out_stats->exchange_energy_joules +
            out_stats->demag_energy_joules +
            out_stats->external_energy_joules +
            out_stats->anisotropy_energy_joules +
            out_stats->cubic_energy_joules +
            out_stats->dmi_energy_joules;
    }
    context_publish_endpoint_stats(ctx, *out_stats, quantity_mask);
    return true;
}

} // namespace fdm
} // namespace fullmag
