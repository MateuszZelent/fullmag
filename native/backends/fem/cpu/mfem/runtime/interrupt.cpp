#include "cpu/mfem/runtime/interrupt.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool poll_interrupt(Context &ctx)
{
    if (ctx.interrupt_poll == nullptr) {
        return false;
    }
    if (ctx.interrupt_poll(ctx.interrupt_poll_user_data) == 0) {
        return false;
    }
    ctx.step_interrupted = true;
    return true;
}

} // namespace fullmag::fem
