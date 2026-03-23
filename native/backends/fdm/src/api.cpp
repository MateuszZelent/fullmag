/*
 * api.cpp — Public C ABI implementation for the FDM backend.
 *
 * This file dispatches to the internal Context and kernel implementations.
 * It is the sole file that exposes symbols matching fullmag_fdm.h.
 */

#include "fullmag_fdm.h"
#include "context.hpp"

#include <cstring>
#include <new>

using namespace fullmag::fdm;

/* ── Availability ── */

int fullmag_fdm_is_available(void) {
#if FULLMAG_HAS_CUDA
    int device_count = 0;
    cudaError_t err = cudaGetDeviceCount(&device_count);
    return (err == cudaSuccess && device_count > 0) ? 1 : 0;
#else
    return 0;
#endif
}

/* ── Create ── */

fullmag_fdm_backend *fullmag_fdm_backend_create(
    const fullmag_fdm_plan_desc *plan)
{
#if FULLMAG_HAS_CUDA
    if (!plan) return nullptr;

    auto *ctx = new (std::nothrow) Context();
    if (!ctx) return nullptr;

    // Copy grid
    ctx->nx = plan->grid.nx;
    ctx->ny = plan->grid.ny;
    ctx->nz = plan->grid.nz;
    ctx->cell_count = static_cast<uint64_t>(ctx->nx) * ctx->ny * ctx->nz;
    ctx->dx = plan->grid.dx;
    ctx->dy = plan->grid.dy;
    ctx->dz = plan->grid.dz;

    // Copy material
    ctx->Ms    = plan->material.saturation_magnetisation;
    ctx->A     = plan->material.exchange_stiffness;
    ctx->alpha = plan->material.damping;
    ctx->gamma = plan->material.gyromagnetic_ratio;

    // Execution config
    ctx->precision  = plan->precision;
    ctx->integrator = plan->integrator;

    // Validate
    if (ctx->cell_count == 0) {
        ctx->last_error = "grid has zero cells";
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }
    uint64_t expected_len = ctx->cell_count * 3;
    if (plan->initial_magnetization_len != expected_len) {
        ctx->last_error = "initial_magnetization_len mismatch: expected "
            + std::to_string(expected_len)
            + ", got " + std::to_string(plan->initial_magnetization_len);
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Allocate device buffers
    if (!context_alloc_device(*ctx)) {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Upload initial magnetization
    if (!context_upload_magnetization(
            *ctx, plan->initial_magnetization_xyz,
            plan->initial_magnetization_len))
    {
        return reinterpret_cast<fullmag_fdm_backend *>(ctx);
    }

    // Query device info
    context_query_device_info(*ctx);

    return reinterpret_cast<fullmag_fdm_backend *>(ctx);
#else
    (void)plan;
    return nullptr;
#endif
}

/* ── Step ── */

int fullmag_fdm_backend_step(
    fullmag_fdm_backend    *handle,
    double                  dt_seconds,
    fullmag_fdm_step_stats *out_stats)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_stats) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (ctx->precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        // Declared in llg_fp64.cu
        extern void launch_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
        launch_heun_step_fp64(*ctx, dt_seconds, out_stats);
    } else {
        // Declared in llg_fp32.cu
        extern void launch_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
        launch_heun_step_fp32(*ctx, dt_seconds, out_stats);
    }

    // Check for CUDA errors
    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        extern void set_cuda_error(Context &ctx, const char *op, cudaError_t err);
        set_cuda_error(*ctx, "heun_step", err);
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)dt_seconds; (void)out_stats;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Copy field ── */

int fullmag_fdm_backend_copy_field_f64(
    fullmag_fdm_backend   *handle,
    fullmag_fdm_observable observable,
    double                *out_xyz,
    uint64_t               out_len)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_xyz) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (out_len != ctx->cell_count * 3) {
        ctx->last_error = "out_len mismatch";
        return FULLMAG_FDM_ERR_INVALID;
    }

    if (!context_download_field_f64(*ctx, observable, out_xyz, out_len)) {
        return FULLMAG_FDM_ERR_CUDA;
    }

    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)observable; (void)out_xyz; (void)out_len;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Device info ── */

int fullmag_fdm_backend_get_device_info(
    fullmag_fdm_backend     *handle,
    fullmag_fdm_device_info *out_info)
{
#if FULLMAG_HAS_CUDA
    if (!handle || !out_info) return FULLMAG_FDM_ERR_INVALID;
    auto *ctx = reinterpret_cast<Context *>(handle);

    if (!ctx->device_info_valid) {
        if (!context_query_device_info(*ctx)) {
            return FULLMAG_FDM_ERR_CUDA;
        }
    }

    *out_info = ctx->device_info_cache;
    return FULLMAG_FDM_OK;
#else
    (void)handle; (void)out_info;
    return FULLMAG_FDM_ERR_CUDA;
#endif
}

/* ── Error ── */

const char *fullmag_fdm_backend_last_error(fullmag_fdm_backend *handle) {
    if (!handle) return "null handle";
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    return ctx->last_error.empty() ? nullptr : ctx->last_error.c_str();
#else
    return "CUDA backend not compiled";
#endif
}

/* ── Destroy ── */

void fullmag_fdm_backend_destroy(fullmag_fdm_backend *handle) {
    if (!handle) return;
#if FULLMAG_HAS_CUDA
    auto *ctx = reinterpret_cast<Context *>(handle);
    context_free_device(*ctx);
    delete ctx;
#endif
}
