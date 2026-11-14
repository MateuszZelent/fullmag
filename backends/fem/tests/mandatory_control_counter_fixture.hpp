#pragma once
#include "backend_handle.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

namespace fullmag::fem::test {
inline bool direct_performance_attempt_lifecycle_contract()
{
    GpuPerformanceCounterState state;
    GpuPerformanceCounterDelta work{};
    work.rhs_evaluations = 3;
    work.control_fences = 2;
    work.control_d2h_bytes = 112;
    work.device_pcg_status_readbacks = 1;
    work.device_pcg_control_d2h_bytes = 104;
    work.device_pcg_solves = 1;
    work.device_pcg_active_iterations = 6;
    work.mandatory_controls.poisson_certificate_readbacks = 1;
    work.mandatory_controls.poisson_certificate_bytes = 8;
    // Unavailable and legacy outside-attempt behavior remain disabled.
    gpu_performance_note(state, work);
    if (gpu_performance_device_pcg_snapshot(state,104).solves != 0) return false;
    gpu_performance_configure(state,true,FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT,64,1,0);
    gpu_performance_note(state, work);
    if (gpu_performance_device_pcg_snapshot(state,104).solves != 1 ||
        gpu_performance_mandatory_controls_snapshot(state).poisson_certificate_readbacks != 1 ||
        gpu_performance_snapshot(state).physical_control_fences != 0) return false;
    {
        GpuPerformanceAttemptScope attempt(state,1);
        gpu_performance_note(state,work);
        if (gpu_performance_device_pcg_snapshot(state,104).solves != 1 ||
            gpu_performance_mandatory_controls_snapshot(state).poisson_certificate_readbacks != 1 ||
            gpu_performance_snapshot(state).physical_rhs_evaluations != 0) return false;
        attempt.commit();
    }
    auto stable = gpu_performance_snapshot(state);
    if (stable.completed_attempt_count != 1 || stable.physical_rhs_evaluations != 3 ||
        stable.accepted_rhs_evaluations != 3 || stable.physical_control_fences != 2 ||
        gpu_performance_device_pcg_snapshot(state,104).solves != 2) return false;
    {
        GpuPerformanceAttemptScope attempt(state,2);
        gpu_performance_note(state,work);
        attempt.reject();
    }
    try {
        GpuPerformanceAttemptScope attempt(state,2);
        gpu_performance_note(state,work);
        throw 1;
    } catch (int) {}
    stable = gpu_performance_snapshot(state);
    if (state.attempt_active || stable.completed_step != 1 ||
        stable.completed_attempt_count != 1 || stable.rejected_attempt_count != 1 ||
        stable.failed_attempt_count != 1 || stable.physical_rhs_evaluations != 9 ||
        stable.accepted_rhs_evaluations != 3 ||
        gpu_performance_device_pcg_snapshot(state,104).solves != 4 ||
        gpu_performance_mandatory_controls_snapshot(state).poisson_certificate_readbacks != 4)
        return false;
    GpuPerformanceCounterState copied = state;
    if (gpu_performance_device_pcg_snapshot(copied,104).solves != 4 ||
        gpu_performance_snapshot(copied).failed_attempt_count != 1) return false;
    gpu_performance_reset(state);
    return gpu_performance_snapshot(state).physical_rhs_evaluations == 0 &&
        gpu_performance_device_pcg_snapshot(state,104).solves == 0 &&
        gpu_performance_mandatory_controls_snapshot(state).poisson_certificate_readbacks == 0;
}

inline bool mandatory_control_accounting_contract()
{
    fullmag_fem_backend backend{};
    auto &state=backend.context.gpu_state.performance_counters;
    auto &audit=backend.context.transfer_audit.audit;
    enum Kind {Core, BbCertificate, BbDescent, PoissonCertificate};
    const auto read=[&](uint64_t bytes,Kind kind) {
        GpuPerformanceCounterDelta delta{};
        delta.control_fences=1; delta.control_d2h_bytes=bytes;
        auto &m=delta.mandatory_controls;
        if (kind==BbCertificate) {
            m.bb_certificate_record_bytes=bytes; m.bb_certificate_readbacks=1; m.bb_certificate_bytes=bytes;
        } else if (kind==BbDescent) { m.bb_descent_readbacks=1; m.bb_descent_bytes=bytes;
        } else if (kind==PoissonCertificate) {m.poisson_certificate_readbacks=1; m.poisson_certificate_bytes=bytes;}
        record_device_control_scalar_to_host(audit,bytes);
        note_hot_loop_mandatory_controls(audit,m);
        gpu_performance_note(state,delta);
    };
    fullmag_fem_gpu_mandatory_control_counters_v1 out{};
    if (fullmag_fem_backend_get_mandatory_control_counters_v1(&backend,2,&out)!=FULLMAG_FEM_ERR_INVALID) return false;
    if (fullmag_fem_backend_get_mandatory_control_counters_v1(nullptr,0,&out)!=FULLMAG_FEM_ERR_INVALID) return false;
    gpu_performance_begin_attempt(state,1);
    read(96,BbCertificate); read(8,PoissonCertificate); read(8,PoissonCertificate);
    if (gpu_performance_mandatory_controls_snapshot(state).bb_certificate_readbacks) return false;
    gpu_performance_reject_attempt(state);
    if (gpu_performance_mandatory_controls_snapshot(state).bb_certificate_readbacks!=1 ||
        audit.mandatory_controls_hot_loop.bb_certificate_readbacks) return false;
    GpuPerformanceCounterState copied=state;
    if (gpu_performance_mandatory_controls_snapshot(copied).poisson_certificate_readbacks!=2) return false;
    gpu_performance_reset(state); audit={};
    gpu_performance_begin_attempt(state,1);
    {
        TransferAuditScope hot(audit,TransferAuditScopeKind::HotLoop);
        for (int i=0;i<92;++i) {
            read(184,Core); read(240,Core); read(24,Core); read(144,Core);
            read(96,BbCertificate); read(8,BbDescent);
            read(8,PoissonCertificate); read(8,PoissonCertificate);
        }
        read(8,PoissonCertificate); read(8,PoissonCertificate);
        for (int i=0;i<18;++i) {read(240,Core);read(8,PoissonCertificate);read(8,PoissonCertificate);}
    }
    if (audit.counters.hot_loop_control_scalar_host_sync_count!=792 ||
        audit.counters.hot_loop_control_scalar_d2h_bytes!=70128) return false;
    gpu_performance_reject_attempt(state);
    if (gpu_performance_snapshot(state).physical_control_fences!=792) return false;
    gpu_performance_begin_attempt(state,1);
    {
        TransferAuditScope hot(audit,TransferAuditScopeKind::HotLoop);
        for (int i=0;i<2;++i) {
            read(184,Core); read(144,Core); read(8,PoissonCertificate); read(8,PoissonCertificate);
            GpuPerformanceCounterDelta delta{};
            if (!resolve_confirmation_control_delta({0,0,0,0,0,0},{4,344,2,16,0,0},delta.mandatory_controls)) return false;
            note_hot_loop_mandatory_controls(audit,delta.mandatory_controls);
            gpu_performance_note(state,delta);
        }
    }
    gpu_performance_fail_attempt(state);
    if (audit.counters.hot_loop_control_scalar_host_sync_count!=800 ||
        audit.counters.hot_loop_control_scalar_d2h_bytes!=70816) return false;
    if (fullmag_fem_backend_get_mandatory_control_counters_v1(&backend,1,&out)!=FULLMAG_FEM_OK) return false;
    if (out.bb_certificate_readbacks!=92 || out.bb_certificate_bytes!=8832 ||
        out.bb_descent_readbacks!=92 || out.bb_descent_bytes!=736 ||
        out.poisson_certificate_readbacks!=226 || out.poisson_certificate_bytes!=1808 ||
        out.confirmation_observations!=2 || out.confirmation_metric_readbacks!=4 || out.confirmation_metric_bytes!=656) return false;
    const uint64_t credited=out.bb_certificate_readbacks+out.bb_descent_readbacks+out.poisson_certificate_readbacks+out.confirmation_metric_readbacks;
    const uint64_t credited_bytes=out.bb_certificate_bytes+out.bb_descent_bytes+out.poisson_certificate_bytes+out.confirmation_metric_bytes;
    if (800-credited!=386 || 70816-credited_bytes!=58784 || 386>389 || 58784>256*389) return false;
    fullmag_fem_gpu_mandatory_control_counters_v1 physical{};
    if (fullmag_fem_backend_get_mandatory_control_counters_v1(&backend,0,&physical)!=FULLMAG_FEM_OK ||
        physical.confirmation_observations!=2 || physical.bb_certificate_bytes!=8832) return false;
    const auto saved=audit;
    audit.reset_step_violation();
    if (audit.mandatory_controls_hot_loop.confirmation_observations!=2) return false;
    audit={}; audit=saved;
    if (audit.counters.hot_loop_control_scalar_host_sync_count!=800 || audit.mandatory_controls_hot_loop.confirmation_metric_bytes!=656) return false;
    // Extra PCG status is excluded from confirmation, never subtracted twice.
    if (!resolve_confirmation_control_delta({0,0,0,0,0,0},{5,448,2,16,1,104},out) ||
        out.confirmation_metric_readbacks!=2 || out.confirmation_metric_bytes!=328) return false;
    if (resolve_confirmation_control_delta({0,0,0,0,0,0},{2,16,2,16,1,104},out)) return false;
    gpu_performance_reset(state); audit={};
    if (gpu_performance_mandatory_controls_snapshot(state).bb_certificate_readbacks || audit.mandatory_controls_hot_loop.confirmation_observations) return false;
    return true;
}
} // namespace fullmag::fem::test
