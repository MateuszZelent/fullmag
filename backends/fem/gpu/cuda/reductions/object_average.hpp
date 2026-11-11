#pragma once

#include "gpu/cuda/reductions/object_average_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {
struct Context;
struct TransferAudit;

// Setup-only: prepares membership and max(N,E) record scratch for allocation-free misses.
bool prepare_membership_shape(
    GpuObjectAverageState &state, uint64_t node_count, uint64_t element_count,
    const TransferAudit &audit, std::string &error);
int gpu_object_average(
    Context &ctx, const uint32_t *indices, uint64_t count,
    bool element_set, double *out_xyz, std::string &error);
}
