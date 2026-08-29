#pragma once

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_capture_step_transaction_device(Context &ctx, std::string &error);
bool gpu_rk_restore_step_transaction_device(Context &ctx, std::string &error);

/* Read event elapsed values after an existing stream fence/readback. */
bool gpu_rk_collect_step_transaction_timing(Context &ctx, std::string &error);

/* Release lazily allocated transaction timing events during backend teardown. */
void gpu_rk_destroy_step_transaction_timing(Context &ctx);

} // namespace fullmag::fem
