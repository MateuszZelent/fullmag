/*
 * context.cu — CUDA device memory management for the FDM backend.
 *
 * Handles allocation, upload, download of SoA device buffers.
 * AoS ↔ SoA conversion happens at the host/device boundary.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

/* ── Helper: element size based on precision ── */

static size_t scalar_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(float) : sizeof(double);
}

/* ── Allocate one SoA vector field (3 components) ── */

static bool alloc_vector_field(Context &ctx, DeviceVectorField &field) {
    size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaError_t err;

    err = cudaMalloc(&field.x, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(x)", err); return false; }

    err = cudaMalloc(&field.y, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(y)", err); return false; }

    err = cudaMalloc(&field.z, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(z)", err); return false; }

    return true;
}

static void free_vector_field(DeviceVectorField &field) {
    if (field.x) { cudaFree(field.x); field.x = nullptr; }
    if (field.y) { cudaFree(field.y); field.y = nullptr; }
    if (field.z) { cudaFree(field.z); field.z = nullptr; }
}

/* ── Public context functions ── */

bool context_alloc_device(Context &ctx) {
    if (!alloc_vector_field(ctx, ctx.m))    return false;
    if (!alloc_vector_field(ctx, ctx.h_ex)) return false;
    if (!alloc_vector_field(ctx, ctx.k1))   return false;
    if (!alloc_vector_field(ctx, ctx.tmp))  return false;

    // Zero out working buffers
    size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaMemset(ctx.h_ex.x, 0, bytes);
    cudaMemset(ctx.h_ex.y, 0, bytes);
    cudaMemset(ctx.h_ex.z, 0, bytes);
    cudaMemset(ctx.k1.x, 0, bytes);
    cudaMemset(ctx.k1.y, 0, bytes);
    cudaMemset(ctx.k1.z, 0, bytes);
    cudaMemset(ctx.tmp.x, 0, bytes);
    cudaMemset(ctx.tmp.y, 0, bytes);
    cudaMemset(ctx.tmp.z, 0, bytes);

    return true;
}

void context_free_device(Context &ctx) {
    free_vector_field(ctx.m);
    free_vector_field(ctx.h_ex);
    free_vector_field(ctx.k1);
    free_vector_field(ctx.tmp);
}

bool context_upload_magnetization(Context &ctx, const double *m_xyz, uint64_t len) {
    uint64_t n = ctx.cell_count;
    if (len != n * 3) {
        ctx.last_error = "magnetization length mismatch";
        return false;
    }

    // Convert AoS f64 host → SoA device
    size_t bytes = n * scalar_size(ctx.precision);

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        // Deinterleave on host, then copy
        std::vector<double> hx(n), hy(n), hz(n);
        for (uint64_t i = 0; i < n; i++) {
            hx[i] = m_xyz[3 * i + 0];
            hy[i] = m_xyz[3 * i + 1];
            hz[i] = m_xyz[3 * i + 2];
        }
        cudaMemcpy(ctx.m.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        cudaMemcpy(ctx.m.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        cudaMemcpy(ctx.m.z, hz.data(), bytes, cudaMemcpyHostToDevice);
    } else {
        // f64 → f32 conversion + deinterleave
        std::vector<float> hx(n), hy(n), hz(n);
        for (uint64_t i = 0; i < n; i++) {
            hx[i] = static_cast<float>(m_xyz[3 * i + 0]);
            hy[i] = static_cast<float>(m_xyz[3 * i + 1]);
            hz[i] = static_cast<float>(m_xyz[3 * i + 2]);
        }
        cudaMemcpy(ctx.m.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        cudaMemcpy(ctx.m.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        cudaMemcpy(ctx.m.z, hz.data(), bytes, cudaMemcpyHostToDevice);
    }

    return true;
}

bool context_download_field_f64(
    const Context &ctx,
    fullmag_fdm_observable observable,
    double *out_xyz,
    uint64_t out_len)
{
    uint64_t n = ctx.cell_count;
    if (out_len != n * 3) return false;

    const DeviceVectorField *field;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:    field = &ctx.m;    break;
        case FULLMAG_FDM_OBSERVABLE_H_EX: field = &ctx.h_ex; break;
        default: return false;
    }

    size_t bytes = n * scalar_size(ctx.precision);

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(n), hy(n), hz(n);
        cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
        cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
        cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
        for (uint64_t i = 0; i < n; i++) {
            out_xyz[3 * i + 0] = hx[i];
            out_xyz[3 * i + 1] = hy[i];
            out_xyz[3 * i + 2] = hz[i];
        }
    } else {
        std::vector<float> hx(n), hy(n), hz(n);
        cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
        cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
        cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
        for (uint64_t i = 0; i < n; i++) {
            out_xyz[3 * i + 0] = static_cast<double>(hx[i]);
            out_xyz[3 * i + 1] = static_cast<double>(hy[i]);
            out_xyz[3 * i + 2] = static_cast<double>(hz[i]);
        }
    }

    return true;
}

bool context_query_device_info(Context &ctx) {
    int device;
    cudaError_t err = cudaGetDevice(&device);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaGetDevice", err);
        return false;
    }

    cudaDeviceProp props;
    err = cudaGetDeviceProperties(&props, device);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaGetDeviceProperties", err);
        return false;
    }

    std::memset(&ctx.device_info_cache, 0, sizeof(ctx.device_info_cache));
    std::strncpy(ctx.device_info_cache.name, props.name,
                 sizeof(ctx.device_info_cache.name) - 1);
    ctx.device_info_cache.compute_capability_major = props.major;
    ctx.device_info_cache.compute_capability_minor = props.minor;

    int driver_ver = 0, runtime_ver = 0;
    cudaDriverGetVersion(&driver_ver);
    cudaRuntimeGetVersion(&runtime_ver);
    ctx.device_info_cache.driver_version  = driver_ver;
    ctx.device_info_cache.runtime_version = runtime_ver;
    ctx.device_info_valid = true;

    return true;
}

} // namespace fdm
} // namespace fullmag
