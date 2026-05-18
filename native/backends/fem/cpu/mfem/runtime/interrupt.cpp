/*
 * Interrupt runtime source contract.
 *
 * This source owns cooperative interrupt callback installation, polling, and
 * step-interrupted latching for native FEM runtime calls. It does not own step execution, stage completion, field composition, or metrics publication.
 */

#include "cpu/mfem/runtime/interrupt.hpp"

#include "context.hpp"

namespace fullmag::fem {

void set_interrupt_poll(
    Context &ctx,
    fullmag_fem_interrupt_poll_fn poll_fn,
    void *user_data)
{
    ctx.interrupt.poll = poll_fn;
    ctx.interrupt.user_data = user_data;
}

bool poll_interrupt(Context &ctx)
{
    if (ctx.interrupt.poll == nullptr) {
        return false;
    }
    if (ctx.interrupt.poll(ctx.interrupt.user_data) == 0) {
        return false;
    }
    ctx.interrupt.step_interrupted = true;
    return true;
}

} // namespace fullmag::fem
