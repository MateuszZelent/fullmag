#ifndef FULLMAG_FDM_FSAL_POLICY_HPP
#define FULLMAG_FDM_FSAL_POLICY_HPP

#include "context.hpp"

#include <cstdint>
#include <cstring>

namespace fullmag {
namespace fdm {

struct FsalEndpointIdentity {
    uint64_t accepted_state_revision = 0;
    uint64_t accepted_time_bits = 0;
    uint64_t accepted_dt_bits = 0;
    uint64_t source_revision = 0;
    uint64_t field_revision = 0;
    uint64_t transport_revision = 0;
    uint64_t transport_state_identity = 0;
    uint64_t projection_policy_identity = 0;
    uint32_t integrator_identity = 0;
    uint32_t precision_identity = 0;
};

struct FsalReuseInput {
    bool cache_valid = false;
    double temperature = 0.0;
    bool waveform_discontinuity = false;
    FsalEndpointIdentity cached;
    FsalEndpointIdentity requested;
};

struct FsalReuseDecision {
    bool allowed;
    fullmag_fdm_fsal_invalidation_reason reason;
};

inline uint64_t fsal_double_bits(double value) {
    uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    return bits;
}

inline bool fsal_unknown_identity(const FsalEndpointIdentity &identity) {
    return identity.accepted_state_revision == 0 ||
           identity.source_revision == 0 || identity.field_revision == 0 ||
           identity.transport_revision == 0 ||
           identity.transport_state_identity == 0 ||
           identity.projection_policy_identity == 0 ||
           identity.integrator_identity == 0 || identity.precision_identity == 0;
}

inline FsalReuseDecision rhs_allows_fsal_reuse(const FsalReuseInput &input) {
    if (input.temperature > 0.0)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE};
    if (input.waveform_discontinuity)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_WAVEFORM_DISCONTINUITY};
    if (!input.cache_valid)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_CACHE_EMPTY};
    if (fsal_unknown_identity(input.cached) || fsal_unknown_identity(input.requested))
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_UNKNOWN_IDENTITY};
    if (input.cached.accepted_state_revision != input.requested.accepted_state_revision)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_STATE_MISMATCH};
    if (input.cached.accepted_time_bits != input.requested.accepted_time_bits ||
        input.cached.accepted_dt_bits != input.requested.accepted_dt_bits)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_TIME_MISMATCH};
    if (input.cached.source_revision != input.requested.source_revision)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_SOURCE_MISMATCH};
    if (input.cached.field_revision != input.requested.field_revision)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_FIELD_MISMATCH};
    if (input.cached.transport_revision != input.requested.transport_revision ||
        input.cached.transport_state_identity != input.requested.transport_state_identity)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH};
    if (input.cached.projection_policy_identity != input.requested.projection_policy_identity)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_PROJECTION_MISMATCH};
    if (input.cached.integrator_identity != input.requested.integrator_identity ||
        input.cached.precision_identity != input.requested.precision_identity)
        return {false, FULLMAG_FDM_FSAL_INVALIDATION_REALIZATION_MISMATCH};
    return {true, FULLMAG_FDM_FSAL_INVALIDATION_NONE};
}

inline uint64_t context_transport_state_identity(const Context &ctx) {
    // Zero is reserved for unknown. Bound transport is conservatively
    // non-reusable and its owner/revision still participates in identity.
    return ctx.gpu_transport_rhs.active ? (ctx.gpu_transport_owner_id + 2) : 1;
}

inline FsalEndpointIdentity context_current_fsal_identity(const Context &ctx, double dt) {
    return {ctx.accepted_state_revision, fsal_double_bits(ctx.current_time),
            fsal_double_bits(dt), ctx.rhs_source_revision, ctx.rhs_field_revision,
            ctx.rhs_transport_revision, context_transport_state_identity(ctx),
            ctx.projection_policy_identity,
            static_cast<uint32_t>(ctx.integrator) + 1,
            static_cast<uint32_t>(ctx.precision) + 1};
}

inline FsalEndpointIdentity context_cached_fsal_identity(const Context &ctx) {
    return {ctx.fsal_accepted_state_revision, ctx.fsal_accepted_time_bits,
            ctx.fsal_accepted_dt_bits, ctx.fsal_source_revision,
            ctx.fsal_field_revision, ctx.fsal_transport_revision,
            ctx.fsal_transport_state_identity, ctx.fsal_projection_policy_identity,
            ctx.fsal_integrator_identity, ctx.fsal_precision_identity};
}

inline FsalReuseDecision rhs_allows_fsal_reuse(const Context &ctx, double dt) {
    FsalReuseInput input;
    input.cache_valid = ctx.fsal_valid;
    input.temperature = ctx.temperature;
    input.waveform_discontinuity = ctx.oersted_time_dep_kind != 0 ||
                                   ctx.gpu_transport_rhs.active;
    input.cached = context_cached_fsal_identity(ctx);
    input.requested = context_current_fsal_identity(ctx, dt);
    return rhs_allows_fsal_reuse(input);
}

inline bool context_should_use_adaptive_device_graph(const Context &ctx) {
    return ctx.adaptive_enabled &&
           ctx.stats_mode == FULLMAG_FDM_STATS_NONE &&
           ctx.temperature <= 0.0 &&
           !(ctx.has_oersted_field && ctx.oersted_time_dep_kind != 0) &&
           !ctx.gpu_transport_rhs.active &&
           !ctx.gpu_transport_test_force_adaptive_retry;
}

inline void context_record_fsal_invalidation(
    Context &ctx, fullmag_fdm_fsal_invalidation_reason reason) {
    ctx.fsal_invalidation_reason = reason;
    ++ctx.fsal_invalidation_count;
    const auto reason_index = static_cast<uint32_t>(reason);
    if (reason_index < FULLMAG_FDM_FSAL_INVALIDATION_REASON_COUNT)
        ++ctx.fsal_invalidation_reason_counts[reason_index];
}

inline void context_invalidate_fsal_cache(
    Context &ctx, fullmag_fdm_fsal_invalidation_reason reason)
{
    ctx.fsal_valid = false;
    ctx.fsal_pending = false;
    context_record_fsal_invalidation(ctx, reason);
}

inline void context_note_fsal_decision(Context &ctx, const FsalReuseDecision &decision) {
    ctx.step_fsal_reused = decision.allowed;
    ctx.fsal_invalidation_reason = decision.reason;
    if (decision.allowed) {
        ++ctx.rhs_evaluations_saved;
    } else {
        context_record_fsal_invalidation(ctx, decision.reason);
    }
}

inline void context_note_transport_revision_change(Context &ctx) {
    ++ctx.rhs_transport_revision;
    context_invalidate_fsal_cache(
        ctx, FULLMAG_FDM_FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH);
}

inline void context_note_field_source_revision_change(Context &ctx) {
    ++ctx.rhs_source_revision;
    ++ctx.rhs_field_revision;
    context_invalidate_fsal_cache(
        ctx, FULLMAG_FDM_FSAL_INVALIDATION_FIELD_MISMATCH);
}

inline void context_stage_pending_fsal(Context &ctx, double dt) {
    if (ctx.temperature > 0.0 || ctx.oersted_time_dep_kind != 0 ||
        ctx.gpu_transport_rhs.active) {
        ctx.fsal_valid = false;
        ctx.fsal_pending = false;
        return;
    }
    ctx.fsal_pending = true;
    ctx.pending_fsal_accepted_state_revision = ctx.accepted_state_revision + 1;
    ctx.pending_fsal_accepted_time_bits = fsal_double_bits(ctx.current_time + dt);
    ctx.pending_fsal_accepted_dt_bits = fsal_double_bits(dt);
    ctx.pending_fsal_source_revision = ctx.rhs_source_revision;
    ctx.pending_fsal_field_revision = ctx.rhs_field_revision;
    ctx.pending_fsal_transport_revision = ctx.rhs_transport_revision;
    ctx.pending_fsal_transport_state_identity = context_transport_state_identity(ctx);
    ctx.pending_fsal_projection_policy_identity = ctx.projection_policy_identity;
    ctx.pending_fsal_integrator_identity = static_cast<uint32_t>(ctx.integrator) + 1;
    ctx.pending_fsal_precision_identity = static_cast<uint32_t>(ctx.precision) + 1;
}

inline void context_stage_accepted_step(Context &ctx, double dt) {
    ctx.accepted_step_pending = true;
    ctx.pending_step_count = ctx.step_count + 1;
    ctx.pending_time = ctx.current_time + dt;
    ctx.pending_dt = dt;
}

inline void context_stage_fsal_accepted_step(Context &ctx, double dt) {
    context_stage_accepted_step(ctx, dt);
    context_stage_pending_fsal(ctx, dt);
}

inline void context_reject_staged_step(Context &ctx) {
    ctx.accepted_step_pending = false;
    ctx.fsal_pending = false;
}

inline void context_publish_pending_fsal(Context &ctx) {
    if (!ctx.fsal_pending) return;
    if (ctx.pending_fsal_accepted_state_revision != ctx.accepted_state_revision ||
        ctx.pending_fsal_accepted_time_bits != fsal_double_bits(ctx.current_time)) {
        ++ctx.stale_publication_count;
        context_invalidate_fsal_cache(ctx, FULLMAG_FDM_FSAL_INVALIDATION_STALE_PUBLICATION);
        return;
    }
    ctx.fsal_accepted_state_revision = ctx.pending_fsal_accepted_state_revision;
    ctx.fsal_accepted_time_bits = ctx.pending_fsal_accepted_time_bits;
    ctx.fsal_accepted_dt_bits = ctx.pending_fsal_accepted_dt_bits;
    ctx.fsal_source_revision = ctx.pending_fsal_source_revision;
    ctx.fsal_field_revision = ctx.pending_fsal_field_revision;
    ctx.fsal_transport_revision = ctx.pending_fsal_transport_revision;
    ctx.fsal_transport_state_identity = ctx.pending_fsal_transport_state_identity;
    ctx.fsal_projection_policy_identity = ctx.pending_fsal_projection_policy_identity;
    ctx.fsal_integrator_identity = ctx.pending_fsal_integrator_identity;
    ctx.fsal_precision_identity = ctx.pending_fsal_precision_identity;
    ctx.fsal_valid = true;
    ctx.fsal_pending = false;
}

inline void context_commit_accepted_step(Context &ctx) {
    if (!ctx.accepted_step_pending) return;
    ctx.step_count = ctx.pending_step_count;
    ctx.current_time = ctx.pending_time;
    ctx.current_dt = ctx.pending_dt;
    ++ctx.accepted_step_index;
    ++ctx.accepted_state_revision;
    ++ctx.transaction_commit_count;
    ctx.accepted_step_pending = false;
    ctx.trial_dt = 0.0;
}

inline bool context_publish_accepted_step_stats(
    bool committed,
    const fullmag_fdm_step_stats &trial,
    fullmag_fdm_step_stats *output)
{
    if (!committed || output == nullptr) return false;
    *output = trial;
    return true;
}

inline bool context_get_fsal_telemetry_v1(
    const Context &ctx, fullmag_fdm_fsal_telemetry_v1 *out_telemetry)
{
    if (out_telemetry == nullptr ||
        out_telemetry->abi_version != FULLMAG_FDM_FSAL_TELEMETRY_ABI_V1 ||
        out_telemetry->struct_size != sizeof(fullmag_fdm_fsal_telemetry_v1)) {
        return false;
    }
    fullmag_fdm_fsal_telemetry_v1 result{};
    result.abi_version = FULLMAG_FDM_FSAL_TELEMETRY_ABI_V1;
    result.struct_size = sizeof(result);
    result.fsal_reused = ctx.step_fsal_reused ? 1U : 0U;
    result.fsal_invalidation_reason = ctx.fsal_invalidation_reason;
    result.fsal_invalidation_count = ctx.fsal_invalidation_count;
    result.rhs_evaluations_saved = ctx.rhs_evaluations_saved;
    result.thermal_rng_draws = ctx.thermal_rng_draws;
    result.accepted_step_index = ctx.accepted_step_index;
    result.stale_publication_count = ctx.stale_publication_count;
    result.transaction_commit_count = ctx.transaction_commit_count;
    *out_telemetry = result;
    return true;
}

inline bool context_get_fsal_telemetry_v2(
    const Context &ctx, fullmag_fdm_fsal_telemetry_v2 *out_telemetry)
{
    if (out_telemetry == nullptr ||
        out_telemetry->abi_version != FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2 ||
        out_telemetry->struct_size != sizeof(fullmag_fdm_fsal_telemetry_v2)) {
        return false;
    }
    fullmag_fdm_fsal_telemetry_v2 result{};
    result.abi_version = FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2;
    result.struct_size = sizeof(result);
    result.fsal_reused = ctx.step_fsal_reused ? 1U : 0U;
    result.fsal_invalidation_reason = ctx.fsal_invalidation_reason;
    result.fsal_invalidation_count = ctx.fsal_invalidation_count;
    result.rhs_evaluations_saved = ctx.rhs_evaluations_saved;
    result.thermal_rng_draws = ctx.thermal_rng_draws;
    result.accepted_step_index = ctx.accepted_step_index;
    result.stale_publication_count = ctx.stale_publication_count;
    result.transaction_commit_count = ctx.transaction_commit_count;
    std::memcpy(result.invalidation_reason_counts,
                ctx.fsal_invalidation_reason_counts,
                sizeof(result.invalidation_reason_counts));
    *out_telemetry = result;
    return true;
}

} // namespace fdm
} // namespace fullmag

#endif
