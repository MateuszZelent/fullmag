/*
 * GPU CUDA kernels module header.
 *
 * Compatibility umbrella header for split FEM CUDA owner modules.
 */

// ── S11: compatibility umbrella header for split CUDA modules ─────────
// All kernels use double precision (fp64) SoA layout.
// Single precision (fp32) is NOT supported — attempting to instantiate
// float variants will fail at compile time.
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/integrators/llg/llg_rhs_kernels.hpp"
#include "gpu/cuda/integrators/rk/adaptive_error_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_stage_kernels.hpp"
#include "gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"
#include "gpu/cuda/interactions/oersted/oersted_kernels.hpp"
#include "gpu/cuda/interactions/stt/stt_kernels.hpp"
#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"
#include "gpu/cuda/interactions/zeeman/zeeman_kernels.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/observables/observable_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/transfer/transfer_kernels.hpp"

#include <cuda_runtime.h>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace fullmag::fem {

/// Precision type used by all FEM CUDA kernels.
using fem_real_t = double;

// Compile-time guard: block single-precision (FEM-012).
static_assert(std::is_same_v<fem_real_t, double>,
    "fullmag FEM native kernels require double precision; "
    "single precision (float) is not implemented — set fem_real_t = double");

} // namespace fullmag::fem

#endif // FULLMAG_HAS_CUDA_RUNTIME
