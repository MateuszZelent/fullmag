/*
 * context_internal.hpp - private CUDA runtime helpers shared by FDM context modules.
 */

#ifndef FULLMAG_FDM_CONTEXT_INTERNAL_HPP
#define FULLMAG_FDM_CONTEXT_INTERNAL_HPP

#include "context.hpp"

#include <cstddef>

namespace fullmag {
namespace fdm {

inline size_t scalar_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(float) : sizeof(double);
}

inline size_t complex_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(cufftComplex) : sizeof(cufftDoubleComplex);
}

void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
void set_cufft_error(Context &ctx, const char *operation, cufftResult err);

void free_vector_field(DeviceVectorField &field);
void free_boundary_correction(Context &ctx);
void free_anisotropy_fields(Context &ctx);
void free_cubic_anisotropy_fields(Context &ctx);
void free_preview_download_scratch(Context &ctx);

bool context_refresh_anisotropy_observable(Context &ctx);

} // namespace fdm
} // namespace fullmag

#endif // FULLMAG_FDM_CONTEXT_INTERNAL_HPP
