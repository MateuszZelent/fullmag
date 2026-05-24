/*
 * GPU CUDA kernels module header.
 *
 * Declares exported FEM CUDA kernel wrappers for device-resident field,
 * torque, and transfer operations, and includes split CUDA owner modules.
 */

// ── S11: CUDA kernel declarations for shared vector field ops ─────────
// All kernels use double precision (fp64) SoA layout.
// Single precision (fp32) is NOT supported — attempting to instantiate
// float variants will fail at compile time.
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/integrators/llg/llg_rhs_kernels.hpp"
#include "gpu/cuda/integrators/rk/adaptive_error_kernels.hpp"
#include "gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"
#include "gpu/cuda/interactions/oersted/oersted_kernels.hpp"
#include "gpu/cuda/interactions/stt/stt_kernels.hpp"
#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"
#include "gpu/cuda/interactions/zeeman/zeeman_kernels.hpp"
#include "gpu/cuda/kernels/demag_kernels.hpp"
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

/// Normalize each (mx,my,mz) to unit length (SoA layout).
void fullmag_cuda_normalize_vectors(
    fem_real_t *mx, fem_real_t *my, fem_real_t *mz,
    int N, cudaStream_t stream = nullptr);

/// h_eff = h_ex + h_demag [+ h_ext] (element-wise, SoA component).
void fullmag_cuda_accumulate_heff(
    const fem_real_t *h_ex, const fem_real_t *h_demag, const fem_real_t *h_ext,
    fem_real_t *h_eff,
    int N, bool has_ext, cudaStream_t stream = nullptr);

/// Zero a sparse index list in a device vector.
void fullmag_cuda_zero_indexed_values(
    fem_real_t *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream = nullptr);

/// h_accum += h_add (component-wise).
void fullmag_cuda_add_field_inplace(
    const fem_real_t *h_add,
    fem_real_t *h_accum,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem

#endif // FULLMAG_HAS_CUDA_RUNTIME
