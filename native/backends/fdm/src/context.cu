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
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_exchange_field_fp32(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx);
extern void launch_effective_field_fp32(Context &ctx);

/* ── Helper: element size based on precision ── */

static size_t scalar_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(float) : sizeof(double);
}

static size_t complex_size(fullmag_fdm_precision prec) {
    return (prec == FULLMAG_FDM_PRECISION_SINGLE) ? sizeof(cufftComplex) : sizeof(cufftDoubleComplex);
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

static bool alloc_demag_kernel(Context &ctx) {
    if (!ctx.has_demag_tensor_kernel) {
        return true;
    }
    size_t bytes = ctx.fft_cell_count * complex_size(ctx.precision);
    cudaError_t err = cudaMalloc(&ctx.demag_kernel.xx, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_xx)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.yy, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_yy)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.zz, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_zz)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.xy, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_xy)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.xz, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_xz)", err); return false; }
    err = cudaMalloc(&ctx.demag_kernel.yz, bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(kern_yz)", err); return false; }
    return true;
}

static void free_demag_kernel(Context &ctx) {
    if (ctx.demag_kernel.xx) { cudaFree(ctx.demag_kernel.xx); ctx.demag_kernel.xx = nullptr; }
    if (ctx.demag_kernel.yy) { cudaFree(ctx.demag_kernel.yy); ctx.demag_kernel.yy = nullptr; }
    if (ctx.demag_kernel.zz) { cudaFree(ctx.demag_kernel.zz); ctx.demag_kernel.zz = nullptr; }
    if (ctx.demag_kernel.xy) { cudaFree(ctx.demag_kernel.xy); ctx.demag_kernel.xy = nullptr; }
    if (ctx.demag_kernel.xz) { cudaFree(ctx.demag_kernel.xz); ctx.demag_kernel.xz = nullptr; }
    if (ctx.demag_kernel.yz) { cudaFree(ctx.demag_kernel.yz); ctx.demag_kernel.yz = nullptr; }
}

static bool alloc_active_mask(Context &ctx) {
    if (!ctx.has_active_mask) {
        return true;
    }
    size_t bytes = ctx.cell_count * sizeof(uint8_t);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.active_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(active_mask)", err);
        return false;
    }
    return true;
}

static void free_active_mask(Context &ctx) {
    if (ctx.active_mask) {
        cudaFree(ctx.active_mask);
        ctx.active_mask = nullptr;
    }
}

static bool alloc_region_mask(Context &ctx) {
    if (!ctx.has_region_mask) {
        return true;
    }
    size_t bytes = ctx.cell_count * sizeof(uint32_t);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.region_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(region_mask)", err);
        return false;
    }
    return true;
}

static void free_region_mask(Context &ctx) {
    if (ctx.region_mask) {
        cudaFree(ctx.region_mask);
        ctx.region_mask = nullptr;
    }
}

static bool alloc_reduction_scratch(Context &ctx) {
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.reduction_scratch),
        ctx.cell_count * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(reduction_scratch)", err);
        return false;
    }
    ctx.reduction_scratch_len = ctx.cell_count;
    return true;
}

static void free_reduction_scratch(Context &ctx) {
    if (ctx.reduction_scratch) {
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
    }
    ctx.reduction_scratch_len = 0;
}

template <typename Scalar>
__global__ void downsample_field_preview_to_f64_kernel(
    const Scalar *field_x,
    const Scalar *field_y,
    const Scalar *field_z,
    uint32_t full_x,
    uint32_t full_y,
    uint32_t full_z,
    uint32_t preview_x,
    uint32_t preview_y,
    uint32_t preview_z,
    uint32_t z_origin,
    uint32_t z_stride,
    double *out_xyz)
{
    uint64_t preview_count =
        static_cast<uint64_t>(preview_x) * preview_y * preview_z;
    uint64_t preview_index =
        static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (preview_index >= preview_count) {
        return;
    }

    uint32_t px = static_cast<uint32_t>(preview_index % preview_x);
    uint32_t py = static_cast<uint32_t>((preview_index / preview_x) % preview_y);
    uint32_t pz = static_cast<uint32_t>(preview_index / (static_cast<uint64_t>(preview_x) * preview_y));

    uint32_t x_start = static_cast<uint32_t>((static_cast<uint64_t>(px) * full_x) / preview_x);
    uint32_t x_end = static_cast<uint32_t>((static_cast<uint64_t>(px + 1) * full_x) / preview_x);
    if (x_end <= x_start) x_end = x_start + 1;
    if (x_end > full_x) x_end = full_x;

    uint32_t y_start = static_cast<uint32_t>((static_cast<uint64_t>(py) * full_y) / preview_y);
    uint32_t y_end = static_cast<uint32_t>((static_cast<uint64_t>(py + 1) * full_y) / preview_y);
    if (y_end <= y_start) y_end = y_start + 1;
    if (y_end > full_y) y_end = full_y;

    uint32_t z_start = z_origin + pz * z_stride;
    if (z_start >= full_z) z_start = full_z - 1;
    uint32_t z_end = z_origin + (pz + 1) * z_stride;
    if (z_end <= z_start) z_end = z_start + 1;
    if (z_end > full_z) z_end = full_z;

    double accum_x = 0.0;
    double accum_y = 0.0;
    double accum_z = 0.0;
    double count = 0.0;

    for (uint32_t z = z_start; z < z_end; ++z) {
        for (uint32_t y = y_start; y < y_end; ++y) {
            for (uint32_t x = x_start; x < x_end; ++x) {
                uint64_t index =
                    (static_cast<uint64_t>(z) * full_y + y) * full_x + x;
                accum_x += static_cast<double>(field_x[index]);
                accum_y += static_cast<double>(field_y[index]);
                accum_z += static_cast<double>(field_z[index]);
                count += 1.0;
            }
        }
    }

    out_xyz[preview_index * 3 + 0] = accum_x / count;
    out_xyz[preview_index * 3 + 1] = accum_y / count;
    out_xyz[preview_index * 3 + 2] = accum_z / count;
}

static bool alloc_fft_workspace(Context &ctx) {
    if (!ctx.enable_demag) {
        return true;
    }

    ctx.fft_nx = ctx.nx * 2;
    ctx.fft_ny = ctx.ny * 2;
    ctx.fft_nz = ctx.thin_film_2d_demag ? 1 : ctx.nz * 2;
    ctx.fft_cell_count =
        static_cast<uint64_t>(ctx.fft_nx) * ctx.fft_ny * ctx.fft_nz;

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        size_t bytes = ctx.fft_cell_count * sizeof(cufftDoubleComplex);
        cudaError_t err = cudaMalloc(&ctx.fft_x, bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_x)", err); return false; }
        err = cudaMalloc(&ctx.fft_y, bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_y)", err); return false; }
        err = cudaMalloc(&ctx.fft_z, bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_z)", err); return false; }

        cufftResult fft_err =
            ctx.thin_film_2d_demag
                ? cufftPlan2d(
                      &ctx.fft_plan,
                      static_cast<int>(ctx.fft_ny),
                      static_cast<int>(ctx.fft_nx),
                      CUFFT_Z2Z)
                : cufftPlan3d(
                      &ctx.fft_plan,
                      static_cast<int>(ctx.fft_nz),
                      static_cast<int>(ctx.fft_ny),
                      static_cast<int>(ctx.fft_nx),
                      CUFFT_Z2Z);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(
                ctx,
                ctx.thin_film_2d_demag ? "cufftPlan2d(Z2Z)" : "cufftPlan3d(Z2Z)",
                fft_err);
            return false;
        }
    } else {
        size_t bytes = ctx.fft_cell_count * sizeof(cufftComplex);
        cudaError_t err = cudaMalloc(&ctx.fft_x, bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_x)", err); return false; }
        err = cudaMalloc(&ctx.fft_y, bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_y)", err); return false; }
        err = cudaMalloc(&ctx.fft_z, bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_z)", err); return false; }

        cufftResult fft_err =
            ctx.thin_film_2d_demag
                ? cufftPlan2d(
                      &ctx.fft_plan,
                      static_cast<int>(ctx.fft_ny),
                      static_cast<int>(ctx.fft_nx),
                      CUFFT_C2C)
                : cufftPlan3d(
                      &ctx.fft_plan,
                      static_cast<int>(ctx.fft_nz),
                      static_cast<int>(ctx.fft_ny),
                      static_cast<int>(ctx.fft_nx),
                      CUFFT_C2C);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(
                ctx,
                ctx.thin_film_2d_demag ? "cufftPlan2d(C2C)" : "cufftPlan3d(C2C)",
                fft_err);
            return false;
        }
    }

    ctx.fft_plan_valid = true;
    return true;
}

static void free_fft_workspace(Context &ctx) {
    if (ctx.fft_plan_valid) {
        cufftDestroy(ctx.fft_plan);
        ctx.fft_plan = 0;
        ctx.fft_plan_valid = false;
    }
    if (ctx.fft_x) { cudaFree(ctx.fft_x); ctx.fft_x = nullptr; }
    if (ctx.fft_y) { cudaFree(ctx.fft_y); ctx.fft_y = nullptr; }
    if (ctx.fft_z) { cudaFree(ctx.fft_z); ctx.fft_z = nullptr; }
    ctx.fft_cell_count = 0;
}

/* ── Public context functions ── */

bool context_alloc_device(Context &ctx) {
    if (!alloc_active_mask(ctx)) return false;
    if (!alloc_region_mask(ctx)) return false;
    if (!alloc_reduction_scratch(ctx)) return false;
    if (!alloc_vector_field(ctx, ctx.m))    return false;
    if (!alloc_vector_field(ctx, ctx.h_ex)) return false;
    if (!alloc_vector_field(ctx, ctx.h_demag)) return false;
    if (!alloc_vector_field(ctx, ctx.k1))   return false;
    if (!alloc_vector_field(ctx, ctx.tmp))  return false;
    if (!alloc_vector_field(ctx, ctx.work)) return false;

    // DP45: allocate 5 extra stage buffers + FSAL
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45) {
        if (!alloc_vector_field(ctx, ctx.k2)) return false;
        if (!alloc_vector_field(ctx, ctx.k3)) return false;
        if (!alloc_vector_field(ctx, ctx.k4)) return false;
        if (!alloc_vector_field(ctx, ctx.k5)) return false;
        if (!alloc_vector_field(ctx, ctx.k6)) return false;
        if (!alloc_vector_field(ctx, ctx.k_fsal)) return false;
        ctx.fsal_valid = false;
    }

    // ABM3: allocate 3 history buffers
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_ABM3) {
        if (!alloc_vector_field(ctx, ctx.abm_f_n))  return false;
        if (!alloc_vector_field(ctx, ctx.abm_f_n1)) return false;
        if (!alloc_vector_field(ctx, ctx.abm_f_n2)) return false;
        ctx.abm_startup = 0;
        ctx.abm_last_dt = 0.0;
    }

    if (!alloc_fft_workspace(ctx)) return false;
    if (!alloc_demag_kernel(ctx)) return false;

    // Zero out working buffers
    size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaMemset(ctx.h_ex.x, 0, bytes);
    cudaMemset(ctx.h_ex.y, 0, bytes);
    cudaMemset(ctx.h_ex.z, 0, bytes);
    cudaMemset(ctx.h_demag.x, 0, bytes);
    cudaMemset(ctx.h_demag.y, 0, bytes);
    cudaMemset(ctx.h_demag.z, 0, bytes);
    cudaMemset(ctx.k1.x, 0, bytes);
    cudaMemset(ctx.k1.y, 0, bytes);
    cudaMemset(ctx.k1.z, 0, bytes);
    cudaMemset(ctx.tmp.x, 0, bytes);
    cudaMemset(ctx.tmp.y, 0, bytes);
    cudaMemset(ctx.tmp.z, 0, bytes);
    cudaMemset(ctx.work.x, 0, bytes);
    cudaMemset(ctx.work.y, 0, bytes);
    cudaMemset(ctx.work.z, 0, bytes);

    return true;
}

void context_free_device(Context &ctx) {
    free_vector_field(ctx.m);
    free_vector_field(ctx.h_ex);
    free_vector_field(ctx.h_demag);
    free_vector_field(ctx.k1);
    free_vector_field(ctx.tmp);
    free_vector_field(ctx.work);
    // DP45 stage buffers
    free_vector_field(ctx.k2);
    free_vector_field(ctx.k3);
    free_vector_field(ctx.k4);
    free_vector_field(ctx.k5);
    free_vector_field(ctx.k6);
    free_vector_field(ctx.k_fsal);
    // ABM3 history buffers
    free_vector_field(ctx.abm_f_n);
    free_vector_field(ctx.abm_f_n1);
    free_vector_field(ctx.abm_f_n2);
    free_fft_workspace(ctx);
    free_demag_kernel(ctx);
    free_active_mask(ctx);
    free_region_mask(ctx);
    free_reduction_scratch(ctx);
}

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
            bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
            hx[i] = is_active ? m_xyz[3 * i + 0] : 0.0;
            hy[i] = is_active ? m_xyz[3 * i + 1] : 0.0;
            hz[i] = is_active ? m_xyz[3 * i + 2] : 0.0;
        }
        cudaMemcpy(ctx.m.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        cudaMemcpy(ctx.m.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        cudaMemcpy(ctx.m.z, hz.data(), bytes, cudaMemcpyHostToDevice);
    } else {
        // f64 → f32 conversion + deinterleave
        std::vector<float> hx(n), hy(n), hz(n);
        for (uint64_t i = 0; i < n; i++) {
            bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
            hx[i] = is_active ? static_cast<float>(m_xyz[3 * i + 0]) : 0.0f;
            hy[i] = is_active ? static_cast<float>(m_xyz[3 * i + 1]) : 0.0f;
            hz[i] = is_active ? static_cast<float>(m_xyz[3 * i + 2]) : 0.0f;
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
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG: field = &ctx.h_demag; break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF: field = &ctx.work; break;
        case FULLMAG_FDM_OBSERVABLE_H_EXT: {
            for (uint64_t i = 0; i < n; i++) {
                bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                out_xyz[3 * i + 0] =
                    (ctx.has_external_field && is_active) ? ctx.external_field[0] : 0.0;
                out_xyz[3 * i + 1] =
                    (ctx.has_external_field && is_active) ? ctx.external_field[1] : 0.0;
                out_xyz[3 * i + 2] =
                    (ctx.has_external_field && is_active) ? ctx.external_field[2] : 0.0;
            }
            return true;
        }
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

bool context_download_field_preview_f64(
    const Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    double *out_xyz,
    uint64_t out_len)
{
    if (!out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0 || z_stride == 0) {
        return false;
    }

    uint64_t preview_count =
        static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz;
    if (out_len != preview_count * 3) {
        return false;
    }
    if (z_origin >= ctx.nz) {
        return false;
    }

    if (preview_nx == ctx.nx && preview_ny == ctx.ny && preview_nz == ctx.nz
        && z_origin == 0 && z_stride == 1)
    {
        return context_download_field_f64(ctx, observable, out_xyz, out_len);
    }

    const DeviceVectorField *field = nullptr;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:
            field = &ctx.m;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            field = &ctx.h_ex;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            field = &ctx.h_demag;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &ctx.work;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EXT: {
            for (uint32_t pz = 0; pz < preview_nz; ++pz) {
                uint32_t z_start = z_origin + pz * z_stride;
                if (z_start >= ctx.nz) z_start = ctx.nz - 1;
                uint32_t z_end = z_origin + (pz + 1) * z_stride;
                if (z_end <= z_start) z_end = z_start + 1;
                if (z_end > ctx.nz) z_end = ctx.nz;
                for (uint32_t py = 0; py < preview_ny; ++py) {
                    uint32_t y_start = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py) * ctx.ny) / preview_ny);
                    uint32_t y_end = static_cast<uint32_t>(
                        (static_cast<uint64_t>(py + 1) * ctx.ny) / preview_ny);
                    if (y_end <= y_start) y_end = y_start + 1;
                    if (y_end > ctx.ny) y_end = ctx.ny;
                    for (uint32_t px = 0; px < preview_nx; ++px) {
                        uint32_t x_start = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px) * ctx.nx) / preview_nx);
                        uint32_t x_end = static_cast<uint32_t>(
                            (static_cast<uint64_t>(px + 1) * ctx.nx) / preview_nx);
                        if (x_end <= x_start) x_end = x_start + 1;
                        if (x_end > ctx.nx) x_end = ctx.nx;

                        double active_count = 0.0;
                        double count = 0.0;
                        for (uint32_t z = z_start; z < z_end; ++z) {
                            for (uint32_t y = y_start; y < y_end; ++y) {
                                for (uint32_t x = x_start; x < x_end; ++x) {
                                    uint64_t index =
                                        (static_cast<uint64_t>(z) * ctx.ny + y) * ctx.nx + x;
                                    bool is_active =
                                        !ctx.has_active_mask || ctx.active_mask_host[index] != 0;
                                    active_count += is_active ? 1.0 : 0.0;
                                    count += 1.0;
                                }
                            }
                        }

                        uint64_t preview_index =
                            (static_cast<uint64_t>(pz) * preview_ny + py) * preview_nx + px;
                        double scale =
                            (ctx.has_external_field && count > 0.0) ? (active_count / count) : 0.0;
                        out_xyz[preview_index * 3 + 0] = ctx.external_field[0] * scale;
                        out_xyz[preview_index * 3 + 1] = ctx.external_field[1] * scale;
                        out_xyz[preview_index * 3 + 2] = ctx.external_field[2] * scale;
                    }
                }
            }
            return true;
        }
        default:
            return false;
    }

    double *device_out = nullptr;
    cudaError_t err =
        cudaMalloc(reinterpret_cast<void **>(&device_out), preview_count * 3 * sizeof(double));
    if (err != cudaSuccess) {
        const_cast<Context &>(ctx).last_error = "cudaMalloc(preview_out) failed";
        set_cuda_error(const_cast<Context &>(ctx), "cudaMalloc(preview_out)", err);
        return false;
    }

    constexpr uint32_t threads_per_block = 256;
    uint32_t blocks = static_cast<uint32_t>(
        (preview_count + threads_per_block - 1) / threads_per_block);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        downsample_field_preview_to_f64_kernel<<<blocks, threads_per_block>>>(
            reinterpret_cast<const double *>(field->x),
            reinterpret_cast<const double *>(field->y),
            reinterpret_cast<const double *>(field->z),
            ctx.nx,
            ctx.ny,
            ctx.nz,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            device_out);
    } else {
        downsample_field_preview_to_f64_kernel<<<blocks, threads_per_block>>>(
            reinterpret_cast<const float *>(field->x),
            reinterpret_cast<const float *>(field->y),
            reinterpret_cast<const float *>(field->z),
            ctx.nx,
            ctx.ny,
            ctx.nz,
            preview_nx,
            preview_ny,
            preview_nz,
            z_origin,
            z_stride,
            device_out);
    }

    err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(const_cast<Context &>(ctx), "downsample_field_preview_to_f64_kernel", err);
        cudaFree(device_out);
        return false;
    }
    err = cudaMemcpy(
        out_xyz,
        device_out,
        preview_count * 3 * sizeof(double),
        cudaMemcpyDeviceToHost);
    cudaFree(device_out);
    if (err != cudaSuccess) {
        set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(preview_out)", err);
        return false;
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

bool context_refresh_observables(Context &ctx) {
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        if (ctx.enable_exchange) {
            launch_exchange_field_fp64(ctx);
        }
        if (ctx.enable_demag) {
            launch_demag_field_fp64(ctx);
        }
        launch_effective_field_fp64(ctx);
    } else {
        if (ctx.enable_exchange) {
            launch_exchange_field_fp32(ctx);
        }
        if (ctx.enable_demag) {
            launch_demag_field_fp32(ctx);
        }
        launch_effective_field_fp32(ctx);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "context_refresh_observables", err);
        return false;
    }
    return true;
}

} // namespace fdm
} // namespace fullmag
