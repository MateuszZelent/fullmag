#pragma once

#include <memory>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * One native FEM explicit-RK call transaction.
 *
 * Host and device state are captured by begin(), with device copies ordered on
 * the solver compute stream. Unless commit() is called, rollback restores
 * every published field/cache/controller/residency/counter owned by the step.
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
    struct Impl;
    Context *ctx_ = nullptr;
    std::unique_ptr<Impl> impl_;
};

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
    ~RkAttemptCacheSnapshot();

    RkAttemptCacheSnapshot(const RkAttemptCacheSnapshot &) = delete;
    RkAttemptCacheSnapshot &operator=(const RkAttemptCacheSnapshot &) = delete;

    void restore_preserving_attempt_counters();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace fullmag::fem
