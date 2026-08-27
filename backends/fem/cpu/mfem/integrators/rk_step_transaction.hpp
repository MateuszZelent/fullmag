#pragma once

#include <memory>
#include <string>

namespace fullmag::fem {

struct Context;
struct StepperWorkspace;
struct RkStepTransactionJournal;

struct RkStepTransactionJournalDeleter {
    void operator()(RkStepTransactionJournal *journal) const noexcept;
};

using RkStepTransactionJournalPtr =
    std::unique_ptr<RkStepTransactionJournal, RkStepTransactionJournalDeleter>;

/*
 * One native FEM explicit-RK call transaction.
 *
 * Host and device state are captured by begin(), with device copies ordered on
 * the solver compute stream. Unless commit() is called, rollback restores
 * every published field/cache/controller/residency/counter owned by the step.
 * The host snapshot storage is owned by StepperWorkspace and recaptured in
 * place across public steps; the remaining deep-copy payload is intentionally
 * retained until the minimal-journal migration is independently qualified.
 */
class RkStepTransaction {
public:
    explicit RkStepTransaction(Context &ctx);
    ~RkStepTransaction();

    RkStepTransaction(const RkStepTransaction &) = delete;
    RkStepTransaction &operator=(const RkStepTransaction &) = delete;

    bool begin(std::string &error);
    bool rollback(std::string &error);
    void commit();

private:
    friend struct RkStepTransactionJournal;
    struct Impl;
    Context *ctx_ = nullptr;
    RkStepTransactionJournal *journal_ = nullptr;
    Impl *impl_ = nullptr;
};

/* Prepare or reset the reusable host journal during Context setup. */
void rk_step_transaction_prepare_workspace(StepperWorkspace &workspace);
void rk_step_transaction_reset_workspace(StepperWorkspace &workspace) noexcept;

/* Restore the device checkpoint owned by the active outer step transaction. */
bool rk_restore_active_step_device_checkpoint(Context &ctx, std::string &error);

/*
 * Per-adaptive-attempt snapshot for published host fields and physical caches.
 * Solver-work counters and the Brown raw draw deliberately remain cumulative
 * across retries; candidate fields and demag warm-start values do not.
 */
class RkAttemptCacheSnapshot {
public:
    explicit RkAttemptCacheSnapshot(Context &ctx);
    RkAttemptCacheSnapshot(Context &ctx, bool capture_now);
    ~RkAttemptCacheSnapshot();

    RkAttemptCacheSnapshot(const RkAttemptCacheSnapshot &) = delete;
    RkAttemptCacheSnapshot &operator=(const RkAttemptCacheSnapshot &) = delete;

    bool prepare(std::string &error);
    bool capture(std::string &error);
    void restore_preserving_attempt_counters();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace fullmag::fem
