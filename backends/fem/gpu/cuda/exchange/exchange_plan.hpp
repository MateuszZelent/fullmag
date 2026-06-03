#pragma once

/*
 * GPU CUDA exchange planning module header.
 *
 * Declares readiness metadata for the device-resident FEM GPU exchange stage.
 */

#include <string>

namespace fullmag::fem {

struct Context;

struct GpuExchangePlan {
    bool stage_exchange_device_resident = false;
    bool supports_legacy_sparse_gpu = false;
    bool supports_partial_assembly_gpu = false;
    const char *operator_mode = "unsupported";
};

GpuExchangePlan gpu_exchange_plan_stage_exchange(const Context &ctx, std::string &reason);

} // namespace fullmag::fem
