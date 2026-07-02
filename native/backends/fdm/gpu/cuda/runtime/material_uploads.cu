/*
 * material_uploads.cu - host-to-device material payload uploads for FDM CUDA.
 */

#include "context_internal.hpp"

#include <cuda_runtime.h>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag {
namespace fdm {

bool context_upload_active_mask(Context &ctx, const uint8_t *mask, uint64_t len) {
    if (!ctx.has_active_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "active_mask length mismatch";
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.active_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(active_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_region_mask(Context &ctx, const uint32_t *mask, uint64_t len) {
    if (!ctx.has_region_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "region_mask length mismatch";
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.region_mask,
        mask,
        ctx.cell_count * sizeof(uint32_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(region_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_exchange_lut(Context &ctx, const double *lut, uint64_t len) {
    if (!ctx.has_exchange_lut) {
        return true;
    }
    constexpr uint64_t N = FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
    if (!lut || len != N * N) {
        ctx.last_error = "exchange_lut length mismatch: expected "
            + std::to_string(N * N) + ", got " + std::to_string(len);
        return false;
    }
    cudaError_t err = cudaMemcpy(
        ctx.exchange_lut,
        lut,
        N * N * sizeof(double),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(exchange_lut)", err);
        return false;
    }
    return true;
}

bool context_upload_demag_kernel_spectra(
    Context &ctx,
    const double *kxx,
    const double *kyy,
    const double *kzz,
    const double *kxy,
    const double *kxz,
    const double *kyz,
    uint64_t len)
{
    if (!ctx.has_demag_tensor_kernel) {
        return true;
    }
    if (!kxx || !kyy || !kzz || !kxy || !kxz || !kyz || len != ctx.fft_cell_count * 2) {
        ctx.last_error = "demag kernel spectrum length mismatch";
        return false;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        auto upload = [&](void *dst, const double *src, const char *label) -> bool {
            cudaError_t err = cudaMemcpy(
                dst,
                src,
                len * sizeof(double),
                cudaMemcpyHostToDevice);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, label, err);
                return false;
            }
            return true;
        };
        return upload(ctx.demag_kernel.xx, kxx, "cudaMemcpy(kern_xx)")
            && upload(ctx.demag_kernel.yy, kyy, "cudaMemcpy(kern_yy)")
            && upload(ctx.demag_kernel.zz, kzz, "cudaMemcpy(kern_zz)")
            && upload(ctx.demag_kernel.xy, kxy, "cudaMemcpy(kern_xy)")
            && upload(ctx.demag_kernel.xz, kxz, "cudaMemcpy(kern_xz)")
            && upload(ctx.demag_kernel.yz, kyz, "cudaMemcpy(kern_yz)");
    }

    auto convert_and_upload = [&](void *dst, const double *src, const char *label) -> bool {
        std::vector<float> converted(len);
        for (uint64_t i = 0; i < len; i++) {
            converted[i] = static_cast<float>(src[i]);
        }
        cudaError_t err = cudaMemcpy(
            dst,
            converted.data(),
            len * sizeof(float),
            cudaMemcpyHostToDevice);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, label, err);
            return false;
        }
        return true;
    };

    return convert_and_upload(ctx.demag_kernel.xx, kxx, "cudaMemcpy(kern_xx)")
        && convert_and_upload(ctx.demag_kernel.yy, kyy, "cudaMemcpy(kern_yy)")
        && convert_and_upload(ctx.demag_kernel.zz, kzz, "cudaMemcpy(kern_zz)")
        && convert_and_upload(ctx.demag_kernel.xy, kxy, "cudaMemcpy(kern_xy)")
        && convert_and_upload(ctx.demag_kernel.xz, kxz, "cudaMemcpy(kern_xz)")
        && convert_and_upload(ctx.demag_kernel.yz, kyz, "cudaMemcpy(kern_yz)");
}

} // namespace fdm
} // namespace fullmag
