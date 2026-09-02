/*
 * GPU CUDA RK FSAL policy module header.
 *
 * Declares the source-state policy used by GPU RK methods with FSAL stages.
 * The policy is host-side and does not own RHS assembly or CUDA kernel launch.
 */
#pragma once

#include <cstdint>

namespace fullmag::fem {

struct Context;

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx);

/* Stable identity for the resolved field/RHS operator.  Runtime uploads that
 * change coefficient buffers invalidate the endpoint explicitly; this hash
 * covers the remaining plan-level switches and revisions used by the token
 * check in accepted-step finalization. */
uint64_t gpu_rk_fsal_operator_signature(const Context &ctx) noexcept;

} // namespace fullmag::fem
