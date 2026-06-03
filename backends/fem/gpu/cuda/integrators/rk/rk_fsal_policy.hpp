/*
 * GPU CUDA RK FSAL policy module header.
 *
 * Declares the autonomous-RHS policy used by GPU RK methods with FSAL stages.
 * The policy is host-side and does not own RHS assembly or CUDA kernel launch.
 */
#pragma once

namespace fullmag::fem {

struct Context;

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx);

} // namespace fullmag::fem
