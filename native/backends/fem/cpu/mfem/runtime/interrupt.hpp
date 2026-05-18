#pragma once

namespace fullmag::fem {

struct Context;

/*
 * Poll the native FEM cooperative interrupt hook.
 *
 * Interactive and managed-runtime paths install an optional C ABI callback on
 * Context. This runtime helper centralizes callback invocation, preserves the
 * historical convention that a nonzero callback return requests interruption,
 * and latches `Context::step_interrupted` for downstream status reporting.
 *
 * It does not own step execution, stage completion, field composition, or
 * metrics publication.
 */
bool poll_interrupt(Context &ctx);

} // namespace fullmag::fem
