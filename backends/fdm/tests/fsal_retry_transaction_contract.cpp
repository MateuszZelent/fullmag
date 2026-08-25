#include <cstdio>
#include <array>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <type_traits>

#include "fullmag_fdm.h"
#include "../gpu/cuda/integrators/fsal_policy.hpp"
#include "../gpu/cuda/runtime/llg_checkpoint_policy.hpp"
#include "../gpu/cuda/runtime/step_transaction_controller.hpp"

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

std::size_t count_occurrences(const std::string &source, const char *token) {
    std::size_t count = 0;
    std::size_t offset = 0;
    while ((offset = source.find(token, offset)) != std::string::npos) {
        ++count;
        offset += std::char_traits<char>::length(token);
    }
    return count;
}

void report(bool condition, const char *id, const char *message, int &failures) {
    std::printf("%s %s: %s\n", condition ? "PASS" : "RED", id, message);
    if (!condition) ++failures;
}

} // namespace

int main() {
    using namespace fullmag::fdm;
    uint64_t single_magnetization_payload_bytes = 0;
    uint64_t single_abm3_payload_bytes = 0;
    uint64_t magnetization_payload_bytes = 0;
    uint64_t abm3_payload_bytes = 0;
    uint64_t overflow_payload_bytes = UINT64_C(0xa5a5a5a5a5a5a5a5);
    const bool transaction_payload_bytes_are_exact =
        context_step_transaction_payload_bytes(
            7, sizeof(float), false, single_magnetization_payload_bytes) &&
        single_magnetization_payload_bytes == UINT64_C(3) * 7 * sizeof(float) &&
        context_step_transaction_payload_bytes(
            7, sizeof(float), true, single_abm3_payload_bytes) &&
        single_abm3_payload_bytes == UINT64_C(12) * 7 * sizeof(float) &&
        context_step_transaction_payload_bytes(
            7, sizeof(double), false, magnetization_payload_bytes) &&
        magnetization_payload_bytes == UINT64_C(3) * 7 * sizeof(double) &&
        context_step_transaction_payload_bytes(
            7, sizeof(double), true, abm3_payload_bytes) &&
        abm3_payload_bytes == UINT64_C(12) * 7 * sizeof(double) &&
        !context_step_transaction_payload_bytes(
            UINT64_MAX, sizeof(double), true, overflow_payload_bytes) &&
        overflow_payload_bytes == UINT64_C(0xa5a5a5a5a5a5a5a5);
    Context transaction_accounting_overflow{};
    transaction_accounting_overflow.step_transaction_capture_count = UINT64_MAX;
    const bool transaction_accounting_fails_closed =
        !context_step_transaction_checked_add(
            transaction_accounting_overflow,
            transaction_accounting_overflow.step_transaction_capture_count, 1) &&
        !transaction_accounting_overflow.step_transaction_accounting_valid &&
        transaction_accounting_overflow.step_transaction_capture_count == UINT64_MAX;

    Context capture_sample{};
    const bool capture_sample_commits_atomically =
        context_commit_step_transaction_capture_sample(capture_sample, 24) &&
        capture_sample.step_transaction_accounting_valid &&
        capture_sample.step_transaction_capture_count == 1 &&
        capture_sample.step_transaction_capture_d2d_bytes == 24;
    Context capture_bytes_overflow{};
    capture_bytes_overflow.step_transaction_capture_count = 5;
    capture_bytes_overflow.step_transaction_capture_d2d_bytes = UINT64_MAX;
    const bool capture_bytes_overflow_fails_closed =
        !context_commit_step_transaction_capture_sample(
            capture_bytes_overflow, 1) &&
        !capture_bytes_overflow.step_transaction_accounting_valid &&
        capture_bytes_overflow.step_transaction_capture_count == 5 &&
        capture_bytes_overflow.step_transaction_capture_d2d_bytes == UINT64_MAX;
    Context capture_count_overflow{};
    capture_count_overflow.step_transaction_capture_count = UINT64_MAX;
    capture_count_overflow.step_transaction_capture_d2d_bytes = 7;
    const bool capture_count_overflow_fails_closed =
        !context_commit_step_transaction_capture_sample(
            capture_count_overflow, 1) &&
        !capture_count_overflow.step_transaction_accounting_valid &&
        capture_count_overflow.step_transaction_capture_count == UINT64_MAX &&
        capture_count_overflow.step_transaction_capture_d2d_bytes == 7;

    Context rollback_samples{};
    const bool rollback_first_sample_staged =
        context_stage_step_transaction_rollback_sample(
            rollback_samples, 30, 7) &&
        rollback_samples.step_transaction_rollback_count == 0 &&
        rollback_samples.step_transaction_rollback_d2d_bytes == 0 &&
        rollback_samples.step_transaction_rollback_latency_total_ns == 0 &&
        rollback_samples.step_transaction_rollback_latency_max_ns == 0;
    const bool rollback_first_sample_committed =
        context_commit_step_transaction_rollback_sample(rollback_samples) &&
        rollback_samples.step_transaction_rollback_count == 1 &&
        rollback_samples.step_transaction_rollback_d2d_bytes == 30 &&
        rollback_samples.step_transaction_rollback_latency_total_ns == 7 &&
        rollback_samples.step_transaction_rollback_latency_max_ns == 7;
    const bool rollback_second_sample_committed =
        context_stage_step_transaction_rollback_sample(
            rollback_samples, 50, 11) &&
        context_commit_step_transaction_rollback_sample(rollback_samples) &&
        rollback_samples.step_transaction_rollback_count == 2 &&
        rollback_samples.step_transaction_rollback_d2d_bytes == 80 &&
        rollback_samples.step_transaction_rollback_latency_total_ns == 18 &&
        rollback_samples.step_transaction_rollback_latency_max_ns == 11;

    Context discarded_rollback_sample{};
    const bool rollback_failure_staged =
        context_stage_step_transaction_rollback_sample(
            discarded_rollback_sample, 90, 13);
    context_discard_step_transaction_rollback_sample(discarded_rollback_sample);
    fullmag_fdm_step_transaction_telemetry_v1 discarded_rollback_telemetry{};
    discarded_rollback_telemetry.abi_version =
        FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    discarded_rollback_telemetry.struct_size =
        sizeof(discarded_rollback_telemetry);
    const bool rollback_failure_discards_public_sample =
        rollback_failure_staged &&
        context_get_step_transaction_telemetry_v1(
            discarded_rollback_sample, &discarded_rollback_telemetry) &&
        discarded_rollback_telemetry.accounting_valid == 0 &&
        discarded_rollback_telemetry.rollback_count == 0 &&
        discarded_rollback_telemetry.rollback_d2d_bytes == 0 &&
        discarded_rollback_telemetry.rollback_latency_total_ns == 0 &&
        discarded_rollback_telemetry.rollback_latency_max_ns == 0;

    Context rollback_total_overflow{};
    rollback_total_overflow.step_transaction_rollback_count = 2;
    rollback_total_overflow.step_transaction_rollback_d2d_bytes = 7;
    rollback_total_overflow.step_transaction_rollback_latency_total_ns = UINT64_MAX;
    rollback_total_overflow.step_transaction_rollback_latency_max_ns = 5;
    const bool rollback_total_overflow_fails_closed =
        context_stage_step_transaction_rollback_sample(
            rollback_total_overflow, 3, 1) &&
        !context_commit_step_transaction_rollback_sample(
            rollback_total_overflow) &&
        !rollback_total_overflow.step_transaction_accounting_valid &&
        rollback_total_overflow.step_transaction_rollback_count == 2 &&
        rollback_total_overflow.step_transaction_rollback_d2d_bytes == 7 &&
        rollback_total_overflow.step_transaction_rollback_latency_total_ns ==
            UINT64_MAX &&
        rollback_total_overflow.step_transaction_rollback_latency_max_ns == 5;
    Context rollback_bytes_overflow{};
    rollback_bytes_overflow.step_transaction_rollback_count = 2;
    rollback_bytes_overflow.step_transaction_rollback_d2d_bytes = UINT64_MAX;
    rollback_bytes_overflow.step_transaction_rollback_latency_total_ns = 5;
    rollback_bytes_overflow.step_transaction_rollback_latency_max_ns = 5;
    const bool rollback_bytes_overflow_fails_closed =
        context_stage_step_transaction_rollback_sample(
            rollback_bytes_overflow, 1, 1) &&
        !context_commit_step_transaction_rollback_sample(
            rollback_bytes_overflow) &&
        !rollback_bytes_overflow.step_transaction_accounting_valid &&
        rollback_bytes_overflow.step_transaction_rollback_count == 2 &&
        rollback_bytes_overflow.step_transaction_rollback_d2d_bytes == UINT64_MAX &&
        rollback_bytes_overflow.step_transaction_rollback_latency_total_ns == 5 &&
        rollback_bytes_overflow.step_transaction_rollback_latency_max_ns == 5;
    Context rollback_count_overflow{};
    rollback_count_overflow.step_transaction_rollback_count = UINT64_MAX;
    rollback_count_overflow.step_transaction_rollback_d2d_bytes = 7;
    rollback_count_overflow.step_transaction_rollback_latency_total_ns = 5;
    rollback_count_overflow.step_transaction_rollback_latency_max_ns = 5;
    const bool rollback_count_overflow_fails_closed =
        context_stage_step_transaction_rollback_sample(
            rollback_count_overflow, 1, 1) &&
        !context_commit_step_transaction_rollback_sample(
            rollback_count_overflow) &&
        !rollback_count_overflow.step_transaction_accounting_valid &&
        rollback_count_overflow.step_transaction_rollback_count == UINT64_MAX &&
        rollback_count_overflow.step_transaction_rollback_d2d_bytes == 7 &&
        rollback_count_overflow.step_transaction_rollback_latency_total_ns == 5 &&
        rollback_count_overflow.step_transaction_rollback_latency_max_ns == 5;
    Context rollback_max_boundary{};
    const bool rollback_max_boundary_is_monotonic =
        context_stage_step_transaction_rollback_sample(
            rollback_max_boundary, 1, UINT64_MAX) &&
        context_commit_step_transaction_rollback_sample(rollback_max_boundary) &&
        rollback_max_boundary.step_transaction_rollback_count == 1 &&
        rollback_max_boundary.step_transaction_rollback_d2d_bytes == 1 &&
        rollback_max_boundary.step_transaction_rollback_latency_total_ns ==
            UINT64_MAX &&
        rollback_max_boundary.step_transaction_rollback_latency_max_ns ==
            UINT64_MAX &&
        context_stage_step_transaction_rollback_sample(
            rollback_max_boundary, 1, 1) &&
        !context_commit_step_transaction_rollback_sample(
            rollback_max_boundary) &&
        !rollback_max_boundary.step_transaction_accounting_valid &&
        rollback_max_boundary.step_transaction_rollback_count == 1 &&
        rollback_max_boundary.step_transaction_rollback_d2d_bytes == 1 &&
        rollback_max_boundary.step_transaction_rollback_latency_total_ns ==
            UINT64_MAX &&
        rollback_max_boundary.step_transaction_rollback_latency_max_ns ==
            UINT64_MAX;
    Context rollback_saturated_max{};
    rollback_saturated_max.step_transaction_rollback_latency_max_ns = UINT64_MAX;
    const bool rollback_saturated_max_is_preserved =
        context_stage_step_transaction_rollback_sample(
            rollback_saturated_max, 2, 3) &&
        context_commit_step_transaction_rollback_sample(
            rollback_saturated_max) &&
        rollback_saturated_max.step_transaction_accounting_valid &&
        rollback_saturated_max.step_transaction_rollback_count == 1 &&
        rollback_saturated_max.step_transaction_rollback_d2d_bytes == 2 &&
        rollback_saturated_max.step_transaction_rollback_latency_total_ns == 3 &&
        rollback_saturated_max.step_transaction_rollback_latency_max_ns ==
            UINT64_MAX;
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
    Context decision_telemetry_context{};
    context_note_fsal_decision(decision_telemetry_context, thermal_decision);
    FsalReuseInput time_mismatch_input = exact_input;
    time_mismatch_input.requested.accepted_time_bits = fsal_double_bits(2.0e-12);
    const auto time_mismatch_decision = rhs_allows_fsal_reuse(time_mismatch_input);
    context_note_fsal_decision(decision_telemetry_context, time_mismatch_decision);
    const bool denied_reuse_reasons_are_counted =
        decision_telemetry_context.fsal_invalidation_count == 2 &&
        decision_telemetry_context.fsal_invalidation_reason_counts
            [FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE] == 1 &&
        decision_telemetry_context.fsal_invalidation_reason_counts
            [FULLMAG_FDM_FSAL_INVALIDATION_TIME_MISMATCH] == 1;
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
    fullmag_fdm_fsal_telemetry_v2 reason_telemetry{};
    reason_telemetry.abi_version = FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2;
    reason_telemetry.struct_size = sizeof(reason_telemetry);
    const bool reason_counts_are_typed =
        context_get_fsal_telemetry_v2(transaction_context, &reason_telemetry) &&
        reason_telemetry.invalidation_reason_counts
            [FULLMAG_FDM_FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH] == 1 &&
        reason_telemetry.invalidation_reason_counts
            [FULLMAG_FDM_FSAL_INVALIDATION_FIELD_MISMATCH] == 1;
    fullmag_fdm_fsal_telemetry_v1 invalid_telemetry{};
    invalid_telemetry.abi_version = FULLMAG_FDM_FSAL_TELEMETRY_ABI_V1 + 1;
    invalid_telemetry.struct_size = sizeof(invalid_telemetry);
    invalid_telemetry.transaction_commit_count = UINT64_C(0xa5a5a5a5a5a5a5a5);
    const auto invalid_telemetry_before = invalid_telemetry;
    const bool invalid_telemetry_unchanged =
        !context_get_fsal_telemetry_v1(transaction_context, &invalid_telemetry) &&
        std::memcmp(&invalid_telemetry, &invalid_telemetry_before,
                    sizeof(invalid_telemetry)) == 0;
    Context step_transaction_telemetry_context{};
    step_transaction_telemetry_context.step_transaction_accounting_valid = false;
    step_transaction_telemetry_context.step_transaction_capture_count = 11;
    step_transaction_telemetry_context.step_transaction_rollback_count = 13;
    step_transaction_telemetry_context.step_transaction_capture_d2d_bytes = 17;
    step_transaction_telemetry_context.step_transaction_rollback_d2d_bytes = 19;
    step_transaction_telemetry_context.step_transaction_rollback_latency_total_ns = 23;
    step_transaction_telemetry_context.step_transaction_rollback_latency_max_ns = 29;
    step_transaction_telemetry_context.accepted_step_index = 31;
    step_transaction_telemetry_context.gpu_transport_attempt_generation = 37;
    step_transaction_telemetry_context.thermal_rng_draws = 41;
    step_transaction_telemetry_context.stale_publication_count = 43;
    fullmag_fdm_step_transaction_telemetry_v1 step_transaction_telemetry{};
    step_transaction_telemetry.abi_version =
        FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    step_transaction_telemetry.struct_size = sizeof(step_transaction_telemetry);
    const bool step_transaction_snapshot_is_exact =
        context_get_step_transaction_telemetry_v1(
            step_transaction_telemetry_context, &step_transaction_telemetry) &&
        step_transaction_telemetry.abi_version ==
            FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1 &&
        step_transaction_telemetry.struct_size == sizeof(step_transaction_telemetry) &&
        step_transaction_telemetry.accounting_valid == 0 &&
        step_transaction_telemetry.reserved0 == 0 &&
        step_transaction_telemetry.capture_count == 11 &&
        step_transaction_telemetry.rollback_count == 13 &&
        step_transaction_telemetry.capture_d2d_bytes == 17 &&
        step_transaction_telemetry.rollback_d2d_bytes == 19 &&
        step_transaction_telemetry.rollback_latency_total_ns == 23 &&
        step_transaction_telemetry.rollback_latency_max_ns == 29 &&
        step_transaction_telemetry.accepted_step_index == 31 &&
        step_transaction_telemetry.attempt_generation == 37 &&
        step_transaction_telemetry.thermal_rng_draws == 41 &&
        step_transaction_telemetry.stale_publication_count == 43;
    fullmag_fdm_step_transaction_telemetry_v1 invalid_step_transaction_abi{};
    invalid_step_transaction_abi.abi_version =
        FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1 + 1;
    invalid_step_transaction_abi.struct_size = sizeof(invalid_step_transaction_abi);
    invalid_step_transaction_abi.capture_count = UINT64_C(0xa5a5a5a5a5a5a5a5);
    const auto invalid_step_transaction_abi_before = invalid_step_transaction_abi;
    fullmag_fdm_step_transaction_telemetry_v1 invalid_step_transaction_size{};
    invalid_step_transaction_size.abi_version =
        FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    invalid_step_transaction_size.struct_size =
        sizeof(invalid_step_transaction_size) - 1;
    invalid_step_transaction_size.rollback_count = UINT64_C(0x5a5a5a5a5a5a5a5a);
    const auto invalid_step_transaction_size_before = invalid_step_transaction_size;
    const bool invalid_step_transaction_requests_are_unchanged =
        !context_get_step_transaction_telemetry_v1(
            step_transaction_telemetry_context, &invalid_step_transaction_abi) &&
        std::memcmp(
            &invalid_step_transaction_abi, &invalid_step_transaction_abi_before,
            sizeof(invalid_step_transaction_abi)) == 0 &&
        !context_get_step_transaction_telemetry_v1(
            step_transaction_telemetry_context, &invalid_step_transaction_size) &&
        std::memcmp(
            &invalid_step_transaction_size, &invalid_step_transaction_size_before,
            sizeof(invalid_step_transaction_size)) == 0 &&
        !context_get_step_transaction_telemetry_v1(
            step_transaction_telemetry_context, nullptr);
    Context commit_gate{};
    commit_gate.integrator = FULLMAG_FDM_INTEGRATOR_RK23;
    commit_gate.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    context_stage_fsal_accepted_step(commit_gate, 1.0e-13);
    context_publish_pending_fsal(commit_gate);
    const bool premature_publication_rejected =
        !commit_gate.fsal_valid && commit_gate.accepted_step_index == 0 &&
        commit_gate.stale_publication_count == 1;
    context_stage_fsal_accepted_step(commit_gate, 1.0e-13);
    context_commit_accepted_step(commit_gate);
    context_publish_pending_fsal(commit_gate);
    const bool accepted_interval_advances_once =
        commit_gate.fsal_valid && commit_gate.step_count == 1 &&
        commit_gate.accepted_step_index == 1;
    context_invalidate_fsal_cache(
        commit_gate, FULLMAG_FDM_FSAL_INVALIDATION_REJECTED_STEP);
    const bool rejection_consumes_no_interval =
        commit_gate.step_count == 1 && commit_gate.accepted_step_index == 1;
    fullmag_fdm_step_stats output_sentinel{};
    std::memset(&output_sentinel, 0xa5, sizeof(output_sentinel));
    const auto output_sentinel_before = output_sentinel;
    fullmag_fdm_step_stats rejected_trial{};
    rejected_trial.step = 99;
    const bool rejected_output_is_byte_identical =
        !context_publish_accepted_step_stats(
            false, rejected_trial, &output_sentinel) &&
        std::memcmp(&output_sentinel, &output_sentinel_before,
                    sizeof(output_sentinel)) == 0;
    fullmag_fdm_llg_checkpoint_info_v2 checkpoint_identity{};
    checkpoint_identity.integrator = FULLMAG_FDM_INTEGRATOR_RK23;
    checkpoint_identity.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    checkpoint_identity.requested_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    checkpoint_identity.resolved_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    checkpoint_identity.executed_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    checkpoint_identity.requested_policy =
        FULLMAG_FDM_CHECKPOINT_POLICY_GPU_REQUIRED;
    checkpoint_identity.resolved_policy =
        FULLMAG_FDM_CHECKPOINT_POLICY_GPU_REQUIRED;
    checkpoint_identity.execution_realization =
        FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM;
    checkpoint_identity.device_ordinal = 2;
    auto wrong_device = checkpoint_identity;
    wrong_device.device_ordinal = 3;
    auto wrong_policy = checkpoint_identity;
    wrong_policy.resolved_policy = 0;
    Context checkpoint_unchanged{};
    checkpoint_unchanged.step_count = 17;
    checkpoint_unchanged.current_time = 4.0e-12;
    checkpoint_unchanged.current_dt = 5.0e-14;
    const bool wrong_identity_rejects_without_mutation =
        llg_checkpoint_execution_identity_matches(
            checkpoint_identity, checkpoint_identity) &&
        !llg_checkpoint_execution_identity_matches(
            wrong_device, checkpoint_identity) &&
        !llg_checkpoint_execution_identity_matches(
            wrong_policy, checkpoint_identity) &&
        checkpoint_unchanged.step_count == 17 &&
        checkpoint_unchanged.current_time == 4.0e-12 &&
        checkpoint_unchanged.current_dt == 5.0e-14;
    const std::array<fullmag_fdm_integrator, 5> public_integrators{
        FULLMAG_FDM_INTEGRATOR_HEUN,
        FULLMAG_FDM_INTEGRATOR_RK4,
        FULLMAG_FDM_INTEGRATOR_ABM3,
        FULLMAG_FDM_INTEGRATOR_RK23,
        FULLMAG_FDM_INTEGRATOR_DP45,
    };
    const std::array<fullmag_fdm_precision, 2> public_precisions{
        FULLMAG_FDM_PRECISION_SINGLE,
        FULLMAG_FDM_PRECISION_DOUBLE,
    };
    bool every_realization_is_transactional = true;
    bool every_realization_reuses_retry_rng_key = true;
    bool every_fault_boundary_rolls_back = true;
    constexpr std::array<StepTransactionPhase, 6> fault_boundaries{
        StepTransactionPhase::Begin,
        StepTransactionPhase::Capture,
        StepTransactionPhase::Integrator,
        StepTransactionPhase::FinalStats,
        StepTransactionPhase::Receipt,
        StepTransactionPhase::TransportCommit};
    for (const auto integrator : public_integrators) {
        for (const auto precision : public_precisions) {
            Context state{};
            state.integrator = integrator;
            state.precision = precision;
            state.current_dt = 7.0e-15;
            const auto retry_key0 = state.accepted_step_index;
            context_stage_accepted_step(state, 2.0e-14);
            every_realization_is_transactional =
                every_realization_is_transactional &&
                state.step_count == 0 && state.current_time == 0.0 &&
                state.current_dt == 7.0e-15 && state.accepted_step_index == 0;
            context_commit_accepted_step(state);
            const auto retry_key1 = state.accepted_step_index;
            const auto accepted_dt1 = state.current_dt;
            context_stage_accepted_step(state, 3.0e-14);
            context_reject_staged_step(state);
            every_realization_reuses_retry_rng_key =
                every_realization_reuses_retry_rng_key &&
                retry_key0 != retry_key1 &&
                state.accepted_step_index == retry_key1 &&
                state.current_dt == accepted_dt1;
            context_stage_accepted_step(state, 3.0e-14);
            context_commit_accepted_step(state);
            every_realization_is_transactional =
                every_realization_is_transactional && state.step_count == 2 &&
                state.accepted_step_index == 2 &&
                state.transaction_commit_count == 2 &&
                state.current_dt == 3.0e-14;
            for (const bool transport_bound : {false, true}) {
                for (const auto fault_boundary : fault_boundaries) {
                    Context failed{};
                    failed.integrator = integrator;
                    failed.precision = precision;
                    failed.step_count = 7;
                    failed.accepted_step_index = 7;
                    failed.accepted_state_revision = 8;
                    failed.current_time = 7.0e-13;
                    failed.current_dt = 4.0e-14;
                    failed.trial_dt = 9.0e-14;
                    failed.gpu_transport_rhs.active = transport_bound;
                    failed.gpu_transport_attempt_generation = 11;
                    failed.fsal_valid = true;
                    fullmag_fdm_step_stats failed_output{};
                    std::memset(&failed_output, 0x5a, sizeof(failed_output));
                    const auto failed_output_before = failed_output;
                    fullmag_fdm_step_stats failed_trial{};
                    failed_trial.step = 8;
                    const auto before_step_count = failed.step_count;
                    const auto before_accepted_step_index = failed.accepted_step_index;
                    const auto before_accepted_state_revision =
                        failed.accepted_state_revision;
                    const auto before_current_time = failed.current_time;
                    const auto before_current_dt = failed.current_dt;
                    const auto before_transport_attempt_generation =
                        failed.gpu_transport_attempt_generation;
                    StepTransactionController controller(fault_boundary, true);
                    const auto success = []() { return 0; };
                    const int rc = controller.run(
                        success,
                        success,
                        [&]() {
                            context_stage_accepted_step(failed, failed.trial_dt);
                            return 0;
                        },
                        success,
                        success,
                        success,
                        [&]() {
                            context_commit_accepted_step(failed);
                        },
                        [&]() {
                            (void)context_publish_accepted_step_stats(
                                true, failed_trial, &failed_output);
                        },
                        [&]() {
                            failed.step_count = before_step_count;
                            failed.accepted_step_index = before_accepted_step_index;
                            failed.accepted_state_revision =
                                before_accepted_state_revision;
                            failed.current_time = before_current_time;
                            failed.current_dt = before_current_dt;
                            failed.trial_dt = 0.0;
                            failed.gpu_transport_attempt_generation =
                                before_transport_attempt_generation;
                            failed.accepted_step_pending = false;
                            context_invalidate_fsal_cache(
                                failed, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
                            return 0;
                        });
                    every_fault_boundary_rolls_back =
                        every_fault_boundary_rolls_back &&
                        rc != 0 &&
                        ((fault_boundary == StepTransactionPhase::Begin &&
                          controller.phase_count() == 1 &&
                          controller.phase_trace()[0] ==
                              StepTransactionPhase::Begin) ||
                         (fault_boundary != StepTransactionPhase::Begin &&
                          controller.phase_count() >= 2 &&
                          controller.phase_trace()[controller.phase_count() - 1] ==
                              StepTransactionPhase::Rollback)) &&
                        failed.step_count == 7 &&
                        failed.accepted_step_index == 7 &&
                        failed.accepted_state_revision == 8 &&
                        failed.current_time == 7.0e-13 &&
                        failed.current_dt == 4.0e-14 &&
                        failed.trial_dt ==
                            (fault_boundary == StepTransactionPhase::Begin
                                 ? 9.0e-14 : 0.0) &&
                        failed.gpu_transport_rhs.active == transport_bound &&
                        failed.gpu_transport_attempt_generation == 11 &&
                        failed.fsal_valid ==
                            (fault_boundary == StepTransactionPhase::Begin) &&
                        !failed.accepted_step_pending &&
                        std::memcmp(&failed_output, &failed_output_before,
                                    sizeof(failed_output)) == 0;
                }
            }
        }
    }
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
    const auto context_telemetry_getter_begin =
        context.find("inline bool context_get_step_transaction_telemetry_v1(");
    const auto context_telemetry_getter_end =
        context.find("bool context_capture_pre_step_state(",
                     context_telemetry_getter_begin);
    const auto context_telemetry_getter = context.substr(
        context_telemetry_getter_begin,
        context_telemetry_getter_end - context_telemetry_getter_begin);
    const auto api = read(fdm / "api/c_api.cpp");
    const auto rollback_transaction_api_begin =
        api.find("bool rollback_step_transaction(");
    const auto rollback_transaction_api_end = api.find(
        "int execute_single_grid_step_transaction(",
        rollback_transaction_api_begin);
    const auto rollback_transaction_api = api.substr(
        rollback_transaction_api_begin,
        rollback_transaction_api_end - rollback_transaction_api_begin);
    const auto step_api_begin = api.find("int fullmag_fdm_backend_step(");
    const auto step_api_end = api.find(
        "int fullmag_fdm_context_bind_gpu_transport_v1", step_api_begin);
    const auto step_api = api.substr(step_api_begin, step_api_end - step_api_begin);
    const auto inactive_legacy_begin = step_api.find("#if 0");
    const auto active_step_api = step_api.substr(0, inactive_legacy_begin);
    const auto transaction_telemetry_api_begin = api.find(
        "int fullmag_fdm_backend_get_step_transaction_telemetry_v1(");
    const auto transaction_telemetry_api_end = api.find(
        "int fullmag_fdm_backend_execution_receipt_v1(",
        transaction_telemetry_api_begin);
    const auto transaction_telemetry_api = api.substr(
        transaction_telemetry_api_begin,
        transaction_telemetry_api_end - transaction_telemetry_api_begin);
    const auto runtime = read(fdm / "gpu/cuda/runtime/context.cu");
    const auto capture_runtime_begin =
        runtime.find("bool context_capture_pre_step_state(");
    const auto rollback_runtime_begin =
        runtime.find("bool context_rollback_pre_step_state(");
    const auto discard_runtime_begin =
        runtime.find("void context_discard_pre_step_state(");
    const auto capture_runtime = runtime.substr(
        capture_runtime_begin, rollback_runtime_begin - capture_runtime_begin);
    const auto rollback_runtime = runtime.substr(
        rollback_runtime_begin, discard_runtime_begin - rollback_runtime_begin);
    const auto checkpoint = read(fdm / "gpu/cuda/runtime/llg_checkpoint.cpp");
    const auto transaction_controller = read(
        fdm / "gpu/cuda/runtime/step_transaction_controller.hpp");
    const auto thermal64 = read(fdm / "gpu/cuda/interactions/demag_fp64.cu");
    const auto thermal32 = read(fdm / "gpu/cuda/interactions/demag_fp32.cu");
    const auto rk23_64 = read(fdm / "gpu/cuda/integrators/llg_rk23_fp64.cu");
    const auto rk23_32 = read(fdm / "gpu/cuda/integrators/llg_rk23_fp32.cu");
    const auto dp45_64 = read(fdm / "gpu/cuda/integrators/llg_dp45_fp64.cu");
    const auto dp45_32 = read(fdm / "gpu/cuda/integrators/llg_dp45_fp32.cu");
    const auto heun64 = read(fdm / "gpu/cuda/integrators/llg_fp64.cu");
    const auto heun32 = read(fdm / "gpu/cuda/integrators/llg_fp32.cu");
    const auto rk4_64 = read(fdm / "gpu/cuda/integrators/llg_rk4_fp64.cu");
    const auto rk4_32 = read(fdm / "gpu/cuda/integrators/llg_rk4_fp32.cu");
    const auto abm3_64 = read(fdm / "gpu/cuda/integrators/llg_abm3_fp64.cu");
    const auto abm3_32 = read(fdm / "gpu/cuda/integrators/llg_abm3_fp32.cu");
    const auto header = read(root / "native/include/fullmag_fdm.h");
    const auto rust = read(root / "crates/fullmag-fdm-sys/src/lib.rs");
    const auto fsal_telemetry_v2_begin =
        header.find("#define FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2");
    const auto fsal_telemetry_v2_end =
        header.find("} fullmag_fdm_fsal_telemetry_v2;", fsal_telemetry_v2_begin);
    const auto fsal_telemetry_v2_declaration = header.substr(
        fsal_telemetry_v2_begin,
        fsal_telemetry_v2_end - fsal_telemetry_v2_begin);
    const auto runner = read(
        root / "crates/fullmag-runner/src/fdm/gpu/cuda/native.rs");
    const std::string integrators = rk23_64 + rk23_32 + dp45_64 + dp45_32;
    int failures = 0;

    report(
        transaction_payload_bytes_are_exact &&
            transaction_accounting_fails_closed,
        "FDM-GPU-TRX-001-B1-RED",
        "step transaction payload bytes are exact and overflow-safe",
        failures);

    report(
        !contains(rk4_64, "stats->step = ctx.step_count") &&
            !contains(rk4_64, "stats->time_seconds = ctx.current_time") &&
            !contains(rk4_32, "stats->step = ctx.step_count") &&
            !contains(rk4_32, "stats->time_seconds = ctx.current_time") &&
            contains(rk4_64, "stats->step = ctx.pending_step_count") &&
            contains(rk4_64, "stats->time_seconds = ctx.pending_time") &&
            contains(rk4_32, "stats->step = ctx.pending_step_count") &&
            contains(rk4_32, "stats->time_seconds = ctx.pending_time"),
        "FDM-GPU-TRX-001-I1-RED",
        "RK4 full-stats metadata describes the staged accepted endpoint",
        failures);
    report(
        contains(header, "FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3") &&
            contains(header, "fullmag_fdm_checkpoint_execution_identity_v3") &&
            contains(header, "fullmag_fdm_llg_checkpoint_info_v3") &&
            contains(header, "thermal_seed") &&
            contains(header, "rng_algorithm") &&
            contains(header, "rng_realization") &&
            contains(checkpoint, "legacy LLG checkpoint v2 import is unsupported") &&
            contains(checkpoint, "!checkpoint_identity_v3_valid(") &&
            contains(checkpoint, "checkpoint_execution_receipt_v3_exportable") &&
            contains(checkpoint,
                "fullmag_fdm_executed_unknown_operator_mask_locked(receipt) == 0") &&
            contains(checkpoint, "receipt.fallback_count == 0") &&
            contains(checkpoint, "context_llg_checkpoint_import_v3") &&
            contains(checkpoint, "context_prepare_checkpoint_import_staging") &&
            contains(checkpoint, "context_commit_checkpoint_import_staging") &&
            contains(checkpoint, "ctx.gpu_transport_pre_step_m") &&
            contains(rust, "pub struct fullmag_fdm_llg_checkpoint_info_v3") &&
            contains(runner, "NativeLlgCheckpointV3") &&
            contains(runner, "fullmag_fdm_backend_llg_checkpoint_import_v3") &&
            !contains(runner, "fullmag_fdm_backend_llg_checkpoint_import_v2"),
        "FDM-GPU-TRX-001-I2-RED",
        "checkpoint v3 binds committed plan/receipt execution and RNG identity",
        failures);
    report(
        contains(transaction_controller, "StepTransactionController") &&
            contains(transaction_controller, "StepTransactionPhase") &&
            contains(transaction_controller, "StepTransactionPhase::FinalStats") &&
            contains(transaction_controller, "accepted_commit();") &&
            contains(transaction_controller, "publish();") &&
            contains(transaction_controller, "phase_trace") &&
            contains(api, "StepTransactionController transaction") &&
            contains(api, "transaction.run") &&
            contains(api, "if (ctx.step_interrupted)") &&
            contains(api, "rollback_step_transaction(ctx)") &&
            contains(heun64, "abort_step_from_tmp") &&
            contains(heun32, "abort_step_from_tmp") &&
            contains(rk4_64, "poll_interrupt") &&
            contains(rk4_32, "poll_interrupt") &&
            contains(abm3_64, "abort_step_from_tmp") &&
            contains(abm3_32, "abort_step_from_tmp") &&
            contains(rk23_64, "poll_interrupt") &&
            contains(rk23_32, "poll_interrupt") &&
            contains(dp45_64, "poll_interrupt") &&
            contains(dp45_32, "poll_interrupt") &&
            contains(runner,
                "public_cuda_step_rolls_back_after_every_integrator_and_final_stats_poll") &&
            contains(runner, "ffi::fullmag_fdm_backend_step(backend.handle") &&
            !contains(active_step_api, "context_capture_pre_step_state(*ctx)"),
        "FDM-GPU-TRX-001-I3-RED",
        "production step orchestration owns a distinct fault-injectable phase trace",
        failures);

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
    const std::string all_single_grid_integrators =
        heun64 + heun32 + rk4_64 + rk4_32 + abm3_64 + abm3_32 + integrators;
    report(
        every_realization_is_transactional && every_fault_boundary_rolls_back &&
            every_realization_reuses_retry_rng_key &&
            !contains(all_single_grid_integrators, "ctx.step_count += 1") &&
            !contains(all_single_grid_integrators, "ctx.current_time += dt") &&
            !contains(all_single_grid_integrators, "ctx.current_dt = dt") &&
            contains(heun64, "context_stage_accepted_step") &&
            contains(heun32, "context_stage_accepted_step") &&
            contains(rk4_64, "context_stage_accepted_step") &&
            contains(rk4_32, "context_stage_accepted_step") &&
            contains(abm3_64, "context_stage_accepted_step") &&
            contains(abm3_32, "context_stage_accepted_step"),
        "FDM-GPU-TRX-001-D",
        "all ten public family/precision realizations execute one accepted-interval state machine",
        failures);
    report(
        rejected_output_is_byte_identical &&
            contains(step_api, "fullmag_fdm_step_stats trial_stats{}") &&
            contains(step_api, "&trial_stats") &&
            contains(step_api, "context_publish_accepted_step_stats") &&
            contains(api, "context_capture_pre_step_state(ctx)") &&
            contains(api, "ctx.trial_dt = dt_seconds") &&
            api.find("context_capture_pre_step_state(ctx)") <
                api.find("ctx.trial_dt = dt_seconds") &&
            !contains(active_step_api, "ctx->current_dt = dt_seconds") &&
            contains(runtime, "gpu_transport_pre_step_abm_f_n") &&
            contains(runtime, "context_invalidate_observables") &&
            !contains(context, "M_PI") &&
            !contains(step_api, "context_fill_current_stats(*ctx, out_stats)"),
        "FDM-GPU-TRX-001-E",
        "trial dt/stats and late rollback are isolated from every public output",
        failures);
    report(
        wrong_identity_rejects_without_mutation &&
            contains(header, "FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3") &&
            contains(header, "fullmag_fdm_llg_checkpoint_info_v3") &&
            contains(header, "device_ordinal") &&
            contains(header, "requested_backend") &&
            contains(header, "resolved_backend") &&
            contains(header, "executed_backend") &&
            contains(header, "accepted_step_index") &&
            contains(checkpoint, "legacy LLG checkpoint v1 import is unsupported") &&
            contains(checkpoint, "context_llg_checkpoint_import_v3") &&
            contains(rust, "pub struct fullmag_fdm_llg_checkpoint_info_v3") &&
            contains(runner, "NativeLlgCheckpointV3") &&
            contains(runner, "fullmag_fdm_backend_llg_checkpoint_import_v3") &&
            !contains(runner, "fullmag_fdm_backend_llg_checkpoint_import_v1"),
        "FDM-GPU-TRX-001-F",
        "checkpoint v3 binds exact execution and accepted stochastic identity while legacy imports fail closed",
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
        contains(checkpoint, "legacy LLG checkpoint v1 import is unsupported") &&
            contains(checkpoint, "context_llg_checkpoint_import_v3") &&
            contains(checkpoint, "ctx.accepted_step_index = header.info.accepted_step_index") &&
            !contains(checkpoint, "ctx.fsal_valid = header.info.fsal_valid != 0") &&
            contains(checkpoint,
                "FULLMAG_FDM_FSAL_INVALIDATION_CHECKPOINT_RESTORE") &&
            contains(checkpoint, "checkpoint_identity_v3_valid"),
        "FDM-GPU-NUM-003-D",
        "checkpoint v3 restores exact RNG identity, invalidates FSAL, and legacy imports fail closed",
        failures);
    report(
        contains(header, "fullmag_fdm_fsal_invalidation_reason") &&
            contains(header, "fullmag_fdm_fsal_telemetry_v1") &&
            contains(header, "fullmag_fdm_fsal_telemetry_v2") &&
            contains(header, "fullmag_fdm_backend_get_fsal_telemetry_v2") &&
            reason_counts_are_typed &&
            denied_reuse_reasons_are_counted &&
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
            contains(rust, "pub struct fullmag_fdm_fsal_telemetry_v2") &&
            contains(rust, "pub fsal_reused") &&
            contains(rust, "pub transaction_commit_count"),
        "FDM-GPU-NUM-003-E",
        "typed C/Rust telemetry exposes reuse, invalidation, RNG and transaction proof",
        failures);
    report(
        contains(header, "FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1") &&
            contains(header, "fullmag_fdm_step_transaction_telemetry_v1") &&
            contains(header,
                "fullmag_fdm_backend_get_step_transaction_telemetry_v1") &&
            !contains(fsal_telemetry_v2_declaration,
                "fullmag_fdm_step_transaction_telemetry_v1"),
        "FDM-GPU-TRX-001-A",
        "step transaction telemetry must have an independent public ABI",
        failures);
    report(
        step_transaction_snapshot_is_exact &&
            invalid_step_transaction_requests_are_unchanged &&
            !contains(context_telemetry_getter, "cuda") &&
            !contains(context_telemetry_getter, "malloc") &&
            !contains(context_telemetry_getter, "new "),
        "FDM-GPU-TRX-001-B2-RED",
        "step transaction telemetry snapshots Context counters fail-closed",
        failures);
    report(
        capture_sample_commits_atomically &&
            capture_bytes_overflow_fails_closed &&
            capture_count_overflow_fails_closed &&
            rollback_first_sample_staged &&
            rollback_first_sample_committed &&
            rollback_second_sample_committed &&
            rollback_failure_discards_public_sample &&
            rollback_total_overflow_fails_closed &&
            rollback_bytes_overflow_fails_closed &&
            rollback_count_overflow_fails_closed &&
            rollback_max_boundary_is_monotonic &&
            rollback_saturated_max_is_preserved,
        "FDM-GPU-TRX-001-B5-RED",
        "transaction samples stage, commit, discard, and overflow atomically",
        failures);
    report(
        contains(runtime, "step_transaction_capture_d2d_bytes") &&
            contains(runtime, "step_transaction_rollback_d2d_bytes") &&
            contains(runtime, "steady_clock") &&
            contains(context, "step_transaction_rollback_latency_total_ns") &&
            contains(context, "step_transaction_rollback_latency_max_ns") &&
            count_occurrences(capture_runtime, "cudaStreamSynchronize(") == 3 &&
            count_occurrences(rollback_runtime, "cudaStreamSynchronize(") == 3,
        "FDM-GPU-TRX-001-B3-RED",
        "capture and rollback account real D2D bytes and rollback latency without new synchronization",
        failures);
    const auto rollback_state_restore = rollback_transaction_api.find(
        "context_rollback_pre_step_state(ctx)");
    const auto rollback_fsal_invalidation = rollback_transaction_api.find(
        "context_invalidate_fsal_cache(");
    const auto rollback_transport_restore = rollback_transaction_api.find(
        "context_rollback_gpu_transport_step(ctx)");
    const auto rollback_observables_invalidation = rollback_transaction_api.find(
        "context_invalidate_observables(ctx)");
    const auto rollback_observables_refresh = rollback_transaction_api.find(
        "context_refresh_observables(ctx)");
    const auto rollback_commit = rollback_transaction_api.find(
        "context_commit_step_transaction_rollback_sample(ctx)");
    const auto rollback_discard = rollback_transaction_api.find(
        "context_discard_step_transaction_rollback_sample(ctx)");
    const auto rollback_timestamp_end = rollback_runtime.find(
        "const auto rollback_finished_at = std::chrono::steady_clock::now()");
    const auto rollback_host_bookkeeping = rollback_runtime.find(
        "ctx.gpu_transport_pre_step_m_valid = false");
    const auto rollback_payload_accounting = rollback_runtime.find(
        "context_step_transaction_payload_bytes(");
    const auto rollback_last_restore_sync = rollback_runtime.rfind(
        "cudaStreamSynchronize(", rollback_timestamp_end);
    report(
        contains(rollback_runtime,
            "context_stage_step_transaction_rollback_sample(") &&
            !contains(rollback_runtime,
                "context_commit_step_transaction_rollback_sample(") &&
            rollback_timestamp_end != std::string::npos &&
            rollback_last_restore_sync != std::string::npos &&
            rollback_last_restore_sync < rollback_timestamp_end &&
            rollback_timestamp_end < rollback_host_bookkeeping &&
            rollback_timestamp_end < rollback_payload_accounting &&
            rollback_state_restore < rollback_fsal_invalidation &&
            rollback_fsal_invalidation < rollback_transport_restore &&
            rollback_transport_restore < rollback_observables_invalidation &&
            rollback_observables_invalidation < rollback_observables_refresh &&
            rollback_observables_refresh < rollback_commit &&
            rollback_commit < rollback_discard &&
            contains(rollback_transaction_api, "if (rollback_succeeded)") &&
            contains(rollback_transaction_api, "else"),
        "FDM-GPU-TRX-001-B6-RED",
        "rollback publishes only after full transport and observables success",
        failures);
    report(
        contains(transaction_telemetry_api, "#if FULLMAG_HAS_CUDA") &&
            contains(transaction_telemetry_api,
                "if (!handle || !out_telemetry) return FULLMAG_FDM_ERR_INVALID;") &&
            contains(transaction_telemetry_api,
                "context_get_step_transaction_telemetry_v1(*ctx, out_telemetry)") &&
            contains(transaction_telemetry_api,
                "? FULLMAG_FDM_OK : FULLMAG_FDM_ERR_ABI") &&
            contains(transaction_telemetry_api, "FULLMAG_FDM_ERR_CUDA"),
        "FDM-GPU-TRX-001-B4-RED",
        "native C ABI exposes the transaction telemetry snapshot and CPU-only failure",
        failures);

    static_assert(sizeof(fullmag_fdm_step_stats) == 192,
                  "legacy step-stats v1 ABI size must remain frozen");
    static_assert(offsetof(fullmag_fdm_step_stats, multilayer_pair_accumulation_count) == 184,
                  "legacy step-stats v1 tail must remain frozen");
    static_assert(sizeof(fullmag_fdm_step_transaction_telemetry_v1) == 96,
                  "step transaction telemetry v1 ABI size changed");
    static_assert(offsetof(fullmag_fdm_step_transaction_telemetry_v1, capture_count) == 16,
                  "step transaction telemetry v1 capture offset changed");
    static_assert(
        offsetof(fullmag_fdm_step_transaction_telemetry_v1, stale_publication_count) == 88,
        "step transaction telemetry v1 stale-publication offset changed");
    using StepTransactionTelemetryGetter = int (*) (
        fullmag_fdm_backend *, fullmag_fdm_step_transaction_telemetry_v1 *);
    static_assert(
        std::is_same_v<decltype(&fullmag_fdm_backend_get_step_transaction_telemetry_v1),
                       StepTransactionTelemetryGetter>,
        "step transaction telemetry getter signature changed");
    static_assert(sizeof(fullmag_fdm_llg_checkpoint_info_v1) == 96,
                  "checkpoint v1 layout must remain frozen");
    static_assert(sizeof(fullmag_fdm_llg_checkpoint_info_v2) == 248,
                  "checkpoint v2 exact-execution layout changed");
    static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v2, device_ordinal) == 40,
                  "checkpoint v2 device identity offset changed");
    static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v2, accepted_step_index) == 72,
                  "checkpoint v2 accepted identity offset changed");
    static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v2, fsal_integrator_identity) == 240,
                  "checkpoint v2 FSAL realization offset changed");
    static_assert(sizeof(fullmag_fdm_checkpoint_execution_identity_v3) == 88,
                  "checkpoint v3 execution identity layout changed");
    static_assert(offsetof(fullmag_fdm_checkpoint_execution_identity_v3, device_ordinal) == 80,
                  "checkpoint v3 device ordinal offset changed");
    static_assert(sizeof(fullmag_fdm_llg_checkpoint_info_v3) == 320,
                  "checkpoint v3 exact-execution layout changed");
    static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v3, execution_identity) == 8,
                  "checkpoint v3 execution identity offset changed");
    static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v3, thermal_seed) == 160,
                  "checkpoint v3 thermal seed offset changed");
    static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v3, fsal_integrator_identity) == 312,
                  "checkpoint v3 FSAL realization offset changed");

    if (failures != 0) {
        std::fprintf(stderr, "FDM FSAL/retry transaction contract: %d RED checks\n", failures);
        return 1;
    }
    std::puts("FDM FSAL/retry transaction contract: PASS");
    return 0;
}
