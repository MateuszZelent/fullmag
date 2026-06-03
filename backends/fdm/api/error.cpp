/*
 * error.cpp — Error formatting utilities.
 */

#include "context.hpp"
#include <cstdio>
#include <cstring>

namespace fullmag {
namespace fdm {

#if FULLMAG_HAS_CUDA

void set_cuda_error(Context &ctx, const char *operation, cudaError_t err) {
    char buf[512];
    std::snprintf(buf, sizeof(buf), "CUDA error in %s: %s (%d)",
                  operation, cudaGetErrorString(err), static_cast<int>(err));
    ctx.last_error = buf;
}

void set_cufft_error(Context &ctx, const char *operation, cufftResult err) {
    char buf[512];
    std::snprintf(buf, sizeof(buf), "cuFFT error in %s: %d",
                  operation, static_cast<int>(err));
    ctx.last_error = buf;
}

#endif // FULLMAG_HAS_CUDA

} // namespace fdm
} // namespace fullmag
