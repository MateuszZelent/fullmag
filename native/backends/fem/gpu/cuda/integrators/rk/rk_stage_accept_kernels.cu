// ── GPU CUDA RK stage accept kernels source contract ──────────────────
// This compatibility source keeps the historical stage accept module in the
// build while low-level accepted-state update kernels live in per-integrator
// modules. It does not own predictor kernels, accept kernel implementations,
// RK orchestration, RHS assembly, adaptive-error policy, interaction kernels,
// or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_stage_accept_kernels.hpp"

namespace fullmag::fem {
namespace {
constexpr bool kRkStageAcceptKernelsCompatibilityTranslationUnit = true;
static_assert(kRkStageAcceptKernelsCompatibilityTranslationUnit);
} // namespace
} // namespace fullmag::fem
