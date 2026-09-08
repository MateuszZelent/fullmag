#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool compute_object_stats_for_elements(
    Context &ctx,
    const std::uint32_t *element_indices,
    std::uint64_t element_count,
    fullmag_fem_object_stats_v1 &stats,
    std::string &error);

} // namespace fullmag::fem
