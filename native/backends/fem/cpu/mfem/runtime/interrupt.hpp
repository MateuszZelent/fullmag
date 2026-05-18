#pragma once

#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Runtime state for cooperative interrupt polling.
 *
 * The interrupt runtime owns the optional C ABI callback, caller-provided user
 * data, and the per-step latch that reports whether the current native FEM step
 * was cancelled by the user.
 */
struct InterruptRuntimeState {
    fullmag_fem_interrupt_poll_fn poll = nullptr;
    void *user_data = nullptr;
    bool step_interrupted = false;
};

/*
 * Poll the native FEM cooperative interrupt hook.
 *
 * Interactive and managed-runtime paths install an optional C ABI callback on
 * Context. This runtime helper centralizes callback invocation, preserves the
 * historical convention that a nonzero callback return requests interruption,
 * and latches `Context::interrupt.step_interrupted` for downstream status
 * reporting.
 *
 * It does not own step execution, stage completion, field composition, or
 * metrics publication.
 */
bool poll_interrupt(Context &ctx);

} // namespace fullmag::fem
