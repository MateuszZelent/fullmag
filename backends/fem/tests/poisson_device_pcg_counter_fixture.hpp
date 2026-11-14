#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>

#include "fullmag_fem.h"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"
#include "gpu/cuda/demag_poisson/control_state.hpp"
#include "gpu/cuda/demag_poisson/pcg_device_scalar_kernels.hpp"

namespace fullmag::fem::test {

inline bool device_pcg_cumulative_readback_upper_bound(
    uint64_t solves,uint64_t iterations,uint64_t &bound,uint32_t stride=8u)
{
    bound=0;
    if (stride!=4u && stride!=8u) return false;
    if (solves==0) return iterations==0;
    if (stride==4u) {
        if (solves>std::numeric_limits<uint64_t>::max()-iterations/4u) return false;
        bound=solves+iterations/4u;
        return true;
    }
    if (iterations==0) { bound=solves; return true; }
    constexpr uint64_t maximum=std::numeric_limits<uint64_t>::max();
    if (solves>(maximum-iterations)/2) return false;
    const uint64_t numerator=iterations+2*solves;
    const uint64_t extra=numerator/8;
    if (solves>maximum-extra) return false;
    bound=solves+extra;
    return true;
}

inline bool device_pcg_initial_batch_readback_bound_contract()
{
    constexpr uint64_t iterations[]={0,5,6,13,14,500};
    constexpr uint64_t expected[]={1,1,2,2,3,63};
    for (std::size_t index=0;index<sizeof(iterations)/sizeof(iterations[0]);++index) {
        uint64_t bound=0;
        if (!device_pcg_cumulative_readback_upper_bound(1,iterations[index],bound) ||
            bound!=expected[index]) return false;
    }
    uint64_t bound=1;
    if (!device_pcg_cumulative_readback_upper_bound(0,0,bound) || bound!=0) return false;
    if (device_pcg_cumulative_readback_upper_bound(0,1,bound)) return false;
    if (!device_pcg_cumulative_readback_upper_bound(4,0,bound) || bound!=4) return false;
    if (!device_pcg_cumulative_readback_upper_bound(1,5,bound,4u) || bound!=2u ||
        !device_pcg_cumulative_readback_upper_bound(2,8,bound,4u) || bound!=4u) return false;
    if (device_pcg_cumulative_readback_upper_bound(1,1,bound,5u)) return false;
    if (device_pcg_cumulative_readback_upper_bound(std::numeric_limits<uint64_t>::max()/2,2,bound)) return false;
    return true;
}

inline bool gpu_pcg_control_runtime_state_contract()
{
    static_assert(sizeof(fullmag_fem_gpu_pcg_control_config_v1) == 16u,
                  "GPU PCG control config ABI must stay 16 bytes");
    static_assert(sizeof(fullmag_fem_gpu_pcg_control_info_v1) == 64u,
                  "GPU PCG control info ABI must stay 64 bytes");
    static_assert(offsetof(fullmag_fem_gpu_pcg_control_info_v1, solve_attempts) == 16u,
                  "GPU PCG control info counters must start after the 16-byte prefix");
    static_assert(offsetof(fullmag_fem_gpu_pcg_control_info_v1, hot_loop_amg_apply_calls) == 56u,
                  "GPU PCG control info counters must remain six contiguous u64 values");

    if (!gpu_pcg_control_config_fields_valid(1u, 16u, 4u, 0u) ||
        !gpu_pcg_control_config_fields_valid(1u, 16u, 8u, 0u) ||
        gpu_pcg_control_config_fields_valid(0u, 16u, 4u, 0u) ||
        gpu_pcg_control_config_fields_valid(1u, 15u, 4u, 0u) ||
        gpu_pcg_control_config_fields_valid(1u, 16u, 4u, 1u) ||
        gpu_pcg_control_config_fields_valid(1u, 16u, 0u, 0u) ||
        gpu_pcg_control_config_fields_valid(1u, 16u, 5u, 0u)) return false;
    if (!gpu_pcg_control_info_header_valid(1u, 64u) ||
        gpu_pcg_control_info_header_valid(0u, 64u) ||
        gpu_pcg_control_info_header_valid(1u, 63u)) return false;

    GpuPcgControlRuntimeState baseline;
    if (baseline.requested_status_batch_stride != 0u ||
        baseline.resolved_status_batch_stride() != 8u ||
        !baseline.try_set_status_batch_stride(8u) ||
        baseline.requested_status_batch_stride != 8u ||
        baseline.resolved_status_batch_stride() != 8u) return false;

    GpuPcgControlRuntimeState experiment;
    if (!experiment.try_set_status_batch_stride(4u) ||
        experiment.requested_status_batch_stride != 4u ||
        experiment.resolved_status_batch_stride() != 4u) return false;
    experiment.record_solve_attempt(true);
    // Attempts latch policy before any HYPRE enqueue, including a failure in
    // the solver's input validation path.
    if (experiment.try_set_status_batch_stride(8u)) return false;
    experiment.record_enqueued_iteration(true);
    experiment.record_amg_apply(true);
    experiment.record_amg_apply(false);
    if (!experiment.first_attempt_started || experiment.solve_attempts != 1u ||
        experiment.enqueued_iterations != 1u || experiment.amg_apply_calls != 2u ||
        experiment.hot_loop_solve_attempts != 1u ||
        experiment.hot_loop_enqueued_iterations != 1u ||
        experiment.hot_loop_amg_apply_calls != 1u) return false;
    // A workspace reset has no operation on Context-owned counters or latch.
    experiment.record_solve_attempt(false);
    if (experiment.try_set_status_batch_stride(8u) ||
        experiment.requested_status_batch_stride != 4u ||
        experiment.solve_attempts != 2u ||
        experiment.hot_loop_solve_attempts != 1u) return false;
    return true;
}

inline bool device_pcg_setup_copy_physical_accounting_contract()
{
    GpuPerformanceCounterState state;
    state.available = true;
    GpuPerformanceCounterDelta setup{};
    setup.device_to_device_bytes = sizeof(double);
    gpu_performance_note(state, setup);
    auto snapshot = gpu_performance_snapshot(state);
    if (snapshot.physical_device_to_device_bytes != sizeof(double) ||
        snapshot.accepted_device_to_device_bytes != 0) return false;

    // A rejected step contributes actual work without claiming an accepted
    // endpoint; setup must survive both transactional paths exactly once.
    GpuPerformanceCounterDelta attempted{};
    attempted.device_to_device_bytes = 2 * sizeof(double);
    gpu_performance_begin_attempt(state, 1);
    gpu_performance_note(state, attempted);
    gpu_performance_reject_attempt(state);
    snapshot = gpu_performance_snapshot(state);
    if (snapshot.physical_device_to_device_bytes != 3 * sizeof(double) ||
        snapshot.accepted_device_to_device_bytes != 0) return false;
    gpu_performance_begin_attempt(state, 1);
    gpu_performance_note(state, attempted);
    gpu_performance_commit_attempt(state);
    snapshot = gpu_performance_snapshot(state);
    return snapshot.physical_device_to_device_bytes == 5 * sizeof(double) &&
        // Accepted lifetime includes the backtrack work of this step, while
        // setup stays exclusively in physical lifetime.
        snapshot.accepted_device_to_device_bytes == 4 * sizeof(double);
}

inline bool device_pcg_batch_terminal_budget_contract()
{
    if (demag_pcg_next_batch_iterations(0,0)!=0 ||
        demag_pcg_next_batch_iterations(0,10,5)!=0 ||
        demag_pcg_next_batch_iterations(0,500,4u)!=4u ||
        demag_pcg_next_batch_iterations(0,500,8u)!=5u) return false;
    constexpr uint32_t strides[] = {4u, 8u};
    for (const uint32_t stride : strides) {
        for (uint32_t maximum=1;maximum<=500;++maximum) {
            for (uint32_t active=0;active<=maximum;++active) {
                uint32_t queued=0;
                uint64_t reads=0;
                uint32_t last_batch=0;
                do {
                    const auto batch=demag_pcg_next_batch_iterations(queued,maximum,stride);
                    if (batch==0 || batch>maximum-queued || batch>stride) return false;
                    last_batch=batch;
                    queued+=batch;
                    ++reads;
                } while (queued<active);
                const uint32_t previous=queued-last_batch;
                const uint32_t remaining=maximum-previous;
                const uint32_t first_limit=stride<5u ? stride : 5u;
                const uint32_t batch_limit=previous==0u ? first_limit : stride;
                const uint32_t expected_last=remaining<batch_limit ? remaining : batch_limit;
                if (last_batch!=expected_last) return false;
                // Initialization can latch before either of two pre-loop calls.
                // Later terminal states arise after the active iteration's AMG.
                const auto post_latch=queued-active+(active==0 ? 2u : 0u);
                uint64_t read_bound=0;
                if (post_latch>7 ||
                    !device_pcg_cumulative_readback_upper_bound(1,active,read_bound,stride) ||
                    reads>read_bound) return false;
            }
        }
    }
    constexpr uint32_t maximum=std::numeric_limits<uint32_t>::max();
    if (demag_pcg_next_batch_iterations(maximum-2,maximum,8)!=2 ||
        demag_pcg_next_batch_iterations(maximum,maximum,8)!=0 ||
        demag_pcg_next_batch_iterations(0,maximum,3)!=0) return false;

    // A previous solve's 66 iterations do not provide a lower bound for the
    // next solve. Its proposed first batch passes the readback check while
    // violating the separate post-terminal AMG bound by a large margin.
    constexpr uint32_t previous_iterations=66,active=1;
    constexpr uint32_t history_batch=previous_iterations-1;
    uint64_t read_bound=0;
    return device_pcg_cumulative_readback_upper_bound(1,active,read_bound) &&
        read_bound>=1 && history_batch-active>7;
}

inline bool device_pcg_physical_subaccounting_survives_rollback()
{
    constexpr uint64_t record_bytes=104;
    GpuPerformanceCounterState state;
    TransferAudit audit;
    gpu_performance_begin_attempt(state,1);
    GpuPerformanceCounterDelta first{};
    first.control_fences=2;
    first.control_d2h_bytes=2*record_bytes;
    first.device_pcg_status_readbacks=2;
    first.device_pcg_control_d2h_bytes=2*record_bytes;
    first.device_pcg_solves=1;
    first.device_pcg_active_iterations=9;
    record_device_pcg_solve_started(audit,record_bytes);
    record_device_pcg_status_to_host(audit,record_bytes,8);
    record_device_pcg_status_to_host(audit,record_bytes,1);
    if (audit.device_pcg_hot_loop.status_readbacks || audit.device_pcg_hot_loop.solves ||
        audit.device_pcg_hot_loop.active_iterations || audit.counters.hot_loop_control_scalar_host_sync_count)
        return false;
    gpu_performance_note(state,first);
    if (!(gpu_performance_device_pcg_snapshot(state,record_bytes).status_readbacks==0)) return false;
    gpu_performance_reject_attempt(state);
    auto pcg=gpu_performance_device_pcg_snapshot(state,record_bytes);
    if (!(pcg.status_readbacks==2 && pcg.solves==1 && pcg.active_iterations==9)) return false;
    GpuPerformanceCounterState copied=state;
    if (!(gpu_performance_device_pcg_snapshot(copied,record_bytes).status_readbacks==2)) return false;
    gpu_performance_begin_attempt(state,1);
    GpuPerformanceCounterDelta failed{};
    failed.control_fences=3;
    failed.control_d2h_bytes=record_bytes+16;
    failed.device_pcg_status_readbacks=1;
    failed.device_pcg_control_d2h_bytes=record_bytes;
    failed.device_pcg_solves=1;
    {
        TransferAuditScope hot_loop(audit,TransferAuditScopeKind::HotLoop);
        record_device_pcg_solve_started(audit,record_bytes);
        record_device_pcg_status_to_host(audit,record_bytes,0);
        record_device_control_scalar_to_host(audit,8);
        record_device_control_scalar_to_host(audit,8);
        gpu_performance_note(state,failed);
    }
    gpu_performance_fail_attempt(state);
    pcg=gpu_performance_device_pcg_snapshot(state,record_bytes);
    const auto aggregate=gpu_performance_snapshot(state);
    if (!(pcg.status_readbacks==3 && pcg.solves==2 && pcg.active_iterations==9)) return false;
    if (!(pcg.control_d2h_bytes==pcg.status_readbacks*pcg.status_record_bytes)) return false;
    if (!(aggregate.physical_control_fences-pcg.status_readbacks==2)) return false;
    if (!(aggregate.physical_control_d2h_bytes-pcg.control_d2h_bytes==16)) return false;
    uint64_t readback_bound=0;
    if (!device_pcg_cumulative_readback_upper_bound(pcg.solves,pcg.active_iterations,readback_bound) ||
        pcg.status_readbacks<pcg.solves || pcg.status_readbacks>readback_bound) return false;
    const auto hot=audit.device_pcg_hot_loop;
    if (hot.status_readbacks!=1 || hot.solves!=1 || hot.active_iterations!=0 ||
        hot.control_d2h_bytes!=hot.status_readbacks*hot.status_record_bytes) return false;
    // Physical includes the outside-HotLoop solve. Only the scoped record can
    // be subtracted from the exact HotLoop aggregate, preserving its 2/16 base.
    if (audit.counters.hot_loop_control_scalar_host_sync_count-hot.status_readbacks!=2 ||
        audit.counters.hot_loop_control_scalar_d2h_bytes-hot.control_d2h_bytes!=16) return false;
    if (pcg.status_readbacks==hot.status_readbacks) return false;
    const TransferAudit saved_audit=audit;
    audit.reset_step_violation();
    if (audit.device_pcg_hot_loop.status_readbacks!=1) return false;
    {
        TransferAuditScope hot_loop(audit,TransferAuditScopeKind::HotLoop);
        record_device_pcg_status_to_host(audit,record_bytes,1);
    }
    audit=saved_audit; // Same value-copy rollback boundary as existing audit.
    if (audit.device_pcg_hot_loop.status_readbacks!=1 ||
        audit.counters.hot_loop_control_scalar_host_sync_count!=3) return false;
    audit={};
    if (audit.device_pcg_hot_loop.status_readbacks || audit.device_pcg_hot_loop.solves) return false;
    gpu_performance_reset(state);
    pcg=gpu_performance_device_pcg_snapshot(state,record_bytes);
    if (!(pcg.status_readbacks==0 && pcg.solves==0 && pcg.active_iterations==0)) return false;
    return true;
}

} // namespace fullmag::fem::test
