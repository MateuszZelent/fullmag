#pragma once

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_capture_step_transaction_device(Context &ctx, std::string &error);
bool gpu_rk_restore_step_transaction_device(Context &ctx, std::string &error);

} // namespace fullmag::fem
