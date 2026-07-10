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

bool context_fill_current_stats(Context &ctx, fullmag_fdm_step_stats *out_stats) {
    if (!context_refresh_observables(ctx)) {
        return false;
    }

    std::memset(out_stats, 0, sizeof(*out_stats));
    out_stats->step = ctx.step_count;
    out_stats->time_seconds = ctx.current_time;

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        out_stats->exchange_energy_joules =
            ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
        out_stats->demag_energy_joules =
            ctx.enable_demag ? launch_demag_energy_fp64(ctx) : 0.0;
        out_stats->external_energy_joules = launch_external_energy_fp64(ctx);
        out_stats->anisotropy_energy_joules = reduce_uniaxial_anisotropy_energy_fp64(ctx);
        out_stats->cubic_energy_joules = reduce_cubic_anisotropy_energy_fp64(ctx);
        out_stats->dmi_energy_joules = reduce_dmi_energy_fp64(ctx);
        out_stats->max_effective_field_amplitude =
            reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
        out_stats->max_demag_field_amplitude = ctx.enable_demag
            ? reduce_max_norm_fp64(
                ctx,
                ctx.h_demag.x,
                ctx.h_demag.y,
                ctx.h_demag.z,
                ctx.cell_count)
            : 0.0;
        out_stats->max_torque_Apm = reduce_max_cross_norm_fp64(
            ctx,
            ctx.m.x, ctx.m.y, ctx.m.z,
            ctx.work.x, ctx.work.y, ctx.work.z,
            ctx.cell_count);
        out_stats->max_rhs_amplitude = reduce_current_rhs_norm_fp64(ctx);
    } else {
        out_stats->exchange_energy_joules =
            ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
        out_stats->demag_energy_joules =
            ctx.enable_demag ? launch_demag_energy_fp32(ctx) : 0.0;
        out_stats->external_energy_joules = launch_external_energy_fp32(ctx);
        out_stats->anisotropy_energy_joules = reduce_uniaxial_anisotropy_energy_fp32(ctx);
        out_stats->cubic_energy_joules = reduce_cubic_anisotropy_energy_fp32(ctx);
        out_stats->dmi_energy_joules = reduce_dmi_energy_fp32(ctx);
        out_stats->max_effective_field_amplitude =
            reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
        out_stats->max_demag_field_amplitude = ctx.enable_demag
            ? reduce_max_norm_fp32(
                ctx,
                ctx.h_demag.x,
                ctx.h_demag.y,
                ctx.h_demag.z,
                ctx.cell_count)
            : 0.0;
        out_stats->max_torque_Apm = reduce_max_cross_norm_fp32(
            ctx,
            ctx.m.x, ctx.m.y, ctx.m.z,
            ctx.work.x, ctx.work.y, ctx.work.z,
            ctx.cell_count);
        out_stats->max_rhs_amplitude = reduce_current_rhs_norm_fp32(ctx);
    }

    out_stats->total_energy_joules =
        out_stats->exchange_energy_joules +
        out_stats->demag_energy_joules +
        out_stats->external_energy_joules +
        out_stats->anisotropy_energy_joules +
        out_stats->cubic_energy_joules +
        out_stats->dmi_energy_joules;
    return true;
}

} // namespace fdm
} // namespace fullmag
