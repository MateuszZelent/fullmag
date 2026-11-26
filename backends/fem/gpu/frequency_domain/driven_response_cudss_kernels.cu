/*
 * CUDA kernels for GPU cuDSS frequency-domain driven response.
 *
 * Phase 0 compiling seam skeleton; device omega diagonal update and unscaled
 * residual certification kernels are implemented by Track 3 in Phase 1.
 */

#include <cuda_runtime.h>

namespace fullmag::fem::frequency_domain {

namespace {
[[maybe_unused]] constexpr int kDrivenResponseCudssBlockSize = 256;
} // namespace

} // namespace fullmag::fem::frequency_domain
