#pragma once

#include <array>
#include <cstddef>

namespace fullmag::fdm {

enum class StepTransactionPhase {
    Begin,
    Capture,
    Integrator,
    FinalStats,
    Receipt,
    TransportCommit,
    AcceptedCommit,
    Publish,
    Rollback,
};

class StepTransactionController {
public:
    using PhaseTrace = std::array<StepTransactionPhase, 9>;

    explicit StepTransactionController(
        StepTransactionPhase injected_failure = StepTransactionPhase::Publish,
        bool inject_failure = false,
        int injected_error = -1)
        : injected_failure_(injected_failure),
          inject_failure_(inject_failure),
          injected_error_(injected_error) {}

    template <typename Begin, typename Capture, typename Integrator, typename FinalStats,
              typename Receipt, typename TransportCommit,
              typename AcceptedCommit, typename Publish, typename Rollback>
    int run(
        Begin &&begin,
        Capture &&capture,
        Integrator &&integrator,
        FinalStats &&final_stats,
        Receipt &&receipt,
        TransportCommit &&transport_commit,
        AcceptedCommit &&accepted_commit,
        Publish &&publish,
        Rollback &&rollback)
    {
        const auto attempt = [&](StepTransactionPhase phase, auto &&operation) {
            note(phase);
            if (inject_failure_ && phase == injected_failure_)
                return injected_error_;
            return operation();
        };
        int rc = attempt(StepTransactionPhase::Begin, begin);
        if (rc != 0) return rc;
        rc = attempt(StepTransactionPhase::Capture, capture);
        if (rc == 0) rc = attempt(StepTransactionPhase::Integrator, integrator);
        if (rc == 0) rc = attempt(StepTransactionPhase::FinalStats, final_stats);
        if (rc == 0) rc = attempt(StepTransactionPhase::Receipt, receipt);
        if (rc == 0) {
            rc = attempt(StepTransactionPhase::TransportCommit, transport_commit);
        }
        if (rc != 0) {
            note(StepTransactionPhase::Rollback);
            const int rollback_rc = rollback();
            return rollback_rc == 0 ? rc : rollback_rc;
        }
        note(StepTransactionPhase::AcceptedCommit);
        accepted_commit();
        note(StepTransactionPhase::Publish);
        publish();
        return 0;
    }

    const PhaseTrace &phase_trace() const { return phase_trace_; }
    std::size_t phase_count() const { return phase_count_; }

private:
    void note(StepTransactionPhase phase) {
        if (phase_count_ < phase_trace_.size()) phase_trace_[phase_count_++] = phase;
    }

    PhaseTrace phase_trace_{};
    std::size_t phase_count_ = 0;
    StepTransactionPhase injected_failure_;
    bool inject_failure_;
    int injected_error_;
};

} // namespace fullmag::fdm
