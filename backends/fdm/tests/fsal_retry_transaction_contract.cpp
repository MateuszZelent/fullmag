#include <cstdio>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "fullmag_fdm.h"
#include "../gpu/cuda/integrators/fsal_policy.hpp"

namespace {

std::string read(const std::filesystem::path &path) {
    std::ifstream input(path);
    if (!input) return {};
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

bool contains(const std::string &source, const char *token) {
    return source.find(token) != std::string::npos;
}

void report(bool condition, const char *id, const char *message, int &failures) {
    std::printf("%s %s: %s\n", condition ? "PASS" : "RED", id, message);
    if (!condition) ++failures;
}

} // namespace

int main() {
    using namespace fullmag::fdm;
    const FsalEndpointIdentity exact_identity{
        7, fsal_double_bits(1.0e-12), fsal_double_bits(1.0e-13),
        2, 3, 4, 5, 6, 7, 8};
    FsalReuseInput exact_input{};
    exact_input.cache_valid = true;
    exact_input.cached = exact_identity;
    exact_input.requested = exact_identity;
    const auto exact_decision = rhs_allows_fsal_reuse(exact_input);
    FsalReuseInput unknown_input = exact_input;
    unknown_input.requested.accepted_state_revision = 0;
    const auto unknown_decision = rhs_allows_fsal_reuse(unknown_input);
    FsalReuseInput thermal_input = exact_input;
    thermal_input.temperature = 300.0;
    const auto thermal_decision = rhs_allows_fsal_reuse(thermal_input);
    Context transaction_context{};
    const uint64_t invalidations_before_noop =
        transaction_context.fsal_invalidation_count;
    context_publish_pending_fsal(transaction_context);
    const bool empty_publish_is_noop =
        transaction_context.fsal_invalidation_count == invalidations_before_noop &&
        transaction_context.stale_publication_count == 0;
    transaction_context.fsal_valid = true;
    context_note_transport_revision_change(transaction_context);
    const bool transport_revision_invalidates =
        transaction_context.rhs_transport_revision == 2 &&
        !transaction_context.fsal_valid &&
        transaction_context.fsal_invalidation_reason ==
            FULLMAG_FDM_FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH;
    transaction_context.fsal_valid = true;
    context_note_field_source_revision_change(transaction_context);
    const bool field_source_revision_invalidates =
        transaction_context.rhs_source_revision == 2 &&
        transaction_context.rhs_field_revision == 2 &&
        !transaction_context.fsal_valid &&
        transaction_context.fsal_invalidation_reason ==
            FULLMAG_FDM_FSAL_INVALIDATION_FIELD_MISMATCH;
    fullmag_fdm_fsal_telemetry_v1 invalid_telemetry{};
    invalid_telemetry.abi_version = FULLMAG_FDM_FSAL_TELEMETRY_ABI_V1 + 1;
    invalid_telemetry.struct_size = sizeof(invalid_telemetry);
    invalid_telemetry.transaction_commit_count = UINT64_C(0xa5a5a5a5a5a5a5a5);
    const auto invalid_telemetry_before = invalid_telemetry;
    const bool invalid_telemetry_unchanged =
        !context_get_fsal_telemetry_v1(transaction_context, &invalid_telemetry) &&
        std::memcmp(&invalid_telemetry, &invalid_telemetry_before,
                    sizeof(invalid_telemetry)) == 0;
    Context commit_gate{};
    commit_gate.integrator = FULLMAG_FDM_INTEGRATOR_RK23;
    commit_gate.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    context_stage_accepted_step(commit_gate, 1.0e-13);
    context_publish_pending_fsal(commit_gate);
    const bool premature_publication_rejected =
        !commit_gate.fsal_valid && commit_gate.accepted_step_index == 0 &&
        commit_gate.stale_publication_count == 1;
    context_stage_accepted_step(commit_gate, 1.0e-13);
    context_commit_accepted_step(commit_gate);
    context_publish_pending_fsal(commit_gate);
    const bool accepted_interval_advances_once =
        commit_gate.fsal_valid && commit_gate.step_count == 1 &&
        commit_gate.accepted_step_index == 1;
    context_invalidate_fsal_cache(
        commit_gate, FULLMAG_FDM_FSAL_INVALIDATION_REJECTED_STEP);
    const bool rejection_consumes_no_interval =
        commit_gate.step_count == 1 && commit_gate.accepted_step_index == 1;
    Context observation_context{};
    observation_context.step_count = 9;
    observation_context.current_time = 9.0e-13;
    observation_context.pending_step_count = 10;
    observation_context.pending_time = 1.0e-12;
    fullmag_fdm_step_stats observation_stats{};
    fullmag_fdm_fill_step_stats_metadata(
        observation_context, &observation_stats, 1.0e-13);
    const bool public_observation_is_authoritative =
        observation_stats.step == 9 &&
        observation_stats.time_seconds == observation_context.current_time;
    observation_context.accepted_step_pending = true;
    fullmag_fdm_fill_step_stats_metadata(
        observation_context, &observation_stats, 1.0e-13);
    const bool internal_final_refresh_uses_pending_endpoint =
        observation_stats.step == 10 &&
        observation_stats.time_seconds == observation_context.pending_time;
    observation_context.accepted_step_pending = false;
    fullmag_fdm_fill_step_stats_metadata(
        observation_context, &observation_stats, 0.0);
    const bool post_error_observation_is_authoritative =
        observation_stats.step == 9 &&
        observation_stats.time_seconds == observation_context.current_time;
    const auto file = std::filesystem::path(__FILE__);
    const auto root = file.parent_path().parent_path().parent_path().parent_path();
    const auto fdm = root / "backends/fdm";
    const auto policy = read(fdm / "gpu/cuda/integrators/fsal_policy.hpp");
    const auto context = read(fdm / "include/context.hpp");
    const auto api = read(fdm / "api/c_api.cpp");
    const auto runtime = read(fdm / "gpu/cuda/runtime/context.cu");
    const auto checkpoint = read(fdm / "gpu/cuda/runtime/llg_checkpoint.cpp");
    const auto thermal64 = read(fdm / "gpu/cuda/interactions/demag_fp64.cu");
    const auto thermal32 = read(fdm / "gpu/cuda/interactions/demag_fp32.cu");
    const auto rk23_64 = read(fdm / "gpu/cuda/integrators/llg_rk23_fp64.cu");
    const auto rk23_32 = read(fdm / "gpu/cuda/integrators/llg_rk23_fp32.cu");
    const auto dp45_64 = read(fdm / "gpu/cuda/integrators/llg_dp45_fp64.cu");
    const auto dp45_32 = read(fdm / "gpu/cuda/integrators/llg_dp45_fp32.cu");
    const auto header = read(root / "native/include/fullmag_fdm.h");
    const auto rust = read(root / "crates/fullmag-fdm-sys/src/lib.rs");
    const std::string integrators = rk23_64 + rk23_32 + dp45_64 + dp45_32;
    int failures = 0;

    report(
        exact_decision.allowed &&
            exact_decision.reason == FULLMAG_FDM_FSAL_INVALIDATION_NONE &&
            contains(policy, "rhs_allows_fsal_reuse") &&
            contains(rk23_64, "rhs_allows_fsal_reuse") &&
            contains(rk23_32, "rhs_allows_fsal_reuse") &&
            contains(dp45_64, "rhs_allows_fsal_reuse") &&
            contains(dp45_32, "rhs_allows_fsal_reuse"),
        "FDM-GPU-NUM-003-A",
        "one fail-closed FSAL policy owns all four adaptive realizations",
        failures);
    report(
        !unknown_decision.allowed &&
            unknown_decision.reason == FULLMAG_FDM_FSAL_INVALIDATION_UNKNOWN_IDENTITY &&
            contains(policy, "accepted_state_revision") &&
            contains(policy, "accepted_time_bits") &&
            contains(policy, "source_revision") &&
            contains(policy, "field_revision") &&
            contains(policy, "transport_revision") &&
            contains(policy, "projection_policy_identity") &&
            contains(policy, "integrator_identity") &&
            contains(policy, "precision_identity") &&
            contains(policy, "unknown_identity"),
        "FDM-GPU-NUM-003-B",
        "cache identity is exact and unknown identities fail closed",
        failures);
    report(
        !thermal_decision.allowed && empty_publish_is_noop &&
            transport_revision_invalidates && field_source_revision_invalidates &&
            thermal_decision.reason == FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE &&
            contains(policy, "temperature > 0.0") &&
            contains(policy, "waveform_discontinuity") &&
            contains(policy, "FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH") &&
            !contains(integrators, "ctx.fsal_valid &&") &&
            !contains(integrators, "ctx.fsal_valid = true"),
        "FDM-GPU-NUM-003-C",
        "thermal, dynamic source, transport and local FSAL exceptions are forbidden",
        failures);
    report(
        contains(context, "accepted_step_index") &&
            contains(thermal64, "ctx.accepted_step_index") &&
            contains(thermal32, "ctx.accepted_step_index") &&
            !contains(thermal64, "ctx.step_count,") &&
            !contains(thermal32, "ctx.step_count,"),
        "FDM-GPU-TRX-001-A",
        "thermal RNG uses an explicit accepted-interval identity in both precisions",
        failures);
    report(
        contains(integrators, "context_invalidate_fsal_cache") &&
            contains(integrators, "fsal_rejected_step") &&
            !contains(integrators, "copy_field_d2d(ctx.k_fsal, ctx.k1") &&
            !contains(integrators, "copy_field_d2d_fp32(ctx.k_fsal, ctx.k1"),
        "FDM-GPU-TRX-001-B",
        "reject invalidates FSAL and never republishes a retry derivative",
        failures);
    report(
        premature_publication_rejected && accepted_interval_advances_once &&
            rejection_consumes_no_interval && public_observation_is_authoritative &&
            internal_final_refresh_uses_pending_endpoint &&
            post_error_observation_is_authoritative &&
            contains(api, "context_capture_pre_step_state") &&
            contains(api, "context_rollback_pre_step_state") &&
            contains(runtime, "ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE") &&
            contains(runtime, "sizeof(float)") &&
            contains(runtime, "ctx.accepted_step_index = ctx.gpu_transport_pre_step_accepted_step_index") &&
            contains(runtime, "ctx.current_dt = ctx.gpu_transport_pre_step_current_dt") &&
            contains(runtime, "ctx.fsal_pending = false") &&
            contains(runtime, "ctx.accepted_step_pending = false") &&
            contains(api, "context_commit_accepted_step") &&
            contains(api, "context_publish_pending_fsal") &&
            api.find("context_commit_gpu_transport_step") <
                api.find("context_commit_accepted_step"),
        "FDM-GPU-TRX-001-C",
        "late failures roll back bound/unbound FP32/FP64 and one final boundary commits",
        failures);
    report(
        contains(checkpoint, "context_invalidate_fsal_cache") &&
            contains(checkpoint, "accepted_step_index = header.info.step_count") &&
            !contains(checkpoint, "ctx.fsal_valid = header.info.fsal_valid != 0"),
        "FDM-GPU-NUM-003-D",
        "checkpoint v1 restore reconstructs RNG identity and invalidates incomplete FSAL identity",
        failures);
    report(
        contains(header, "fullmag_fdm_fsal_invalidation_reason") &&
            contains(header, "fullmag_fdm_fsal_telemetry_v1") &&
            contains(header, "fullmag_fdm_backend_get_fsal_telemetry_v1") &&
            invalid_telemetry_unchanged &&
            contains(policy, "out_telemetry->abi_version !=") &&
            contains(policy, "out_telemetry->struct_size !=") &&
            contains(api, "context_get_fsal_telemetry_v1") &&
            contains(header, "fsal_reused") &&
            contains(header, "rhs_evaluations_saved") &&
            contains(header, "thermal_rng_draws") &&
            contains(header, "accepted_step_index") &&
            contains(header, "stale_publication_count") &&
            contains(header, "transaction_commit_count") &&
            contains(rust, "pub struct fullmag_fdm_fsal_telemetry_v1") &&
            contains(rust, "pub fsal_reused") &&
            contains(rust, "pub transaction_commit_count"),
        "FDM-GPU-NUM-003-E",
        "typed C/Rust telemetry exposes reuse, invalidation, RNG and transaction proof",
        failures);

    static_assert(sizeof(fullmag_fdm_step_stats) == 192,
                  "legacy step-stats v1 ABI size must remain frozen");
    static_assert(offsetof(fullmag_fdm_step_stats, multilayer_pair_accumulation_count) == 184,
                  "legacy step-stats v1 tail must remain frozen");

    if (failures != 0) {
        std::fprintf(stderr, "FDM FSAL/retry transaction contract: %d RED checks\n", failures);
        return 1;
    }
    std::puts("FDM FSAL/retry transaction contract: PASS");
    return 0;
}
