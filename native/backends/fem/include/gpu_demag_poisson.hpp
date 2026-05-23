#pragma once

#include "gpu_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_demag_poisson_initialize(Context &ctx, std::string &error);

void gpu_demag_poisson_destroy(Context &ctx);

bool gpu_demag_poisson_ready(const Context &ctx);

uint64_t gpu_demag_poisson_device_bytes(const Context &ctx);

const char *gpu_demag_poisson_operator_mode(const Context &ctx);

const char *gpu_demag_poisson_hypre_policy(const Context &ctx);

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *stream,
    std::string &reason);

} // namespace fullmag::fem
