/*
 * field_transfer.cu - FDM CUDA field transfer, previews, and async snapshots.
 */

#include "context_internal.hpp"

#include <cuda_runtime.h>
#include <algorithm>
#include <cmath>
#include <new>
#include <string>
#include <vector>

namespace fullmag {
namespace fdm {

extern bool launch_multilayer_dmi_field_fp64(Context &ctx);
extern bool launch_multilayer_dmi_field_fp32(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp64(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp32(Context &ctx);
extern void launch_multilayer_exchange_field_fp64(Context &ctx);
extern void launch_multilayer_exchange_field_fp32(Context &ctx);
extern bool launch_multilayer_effective_field_fp64(Context &ctx);
extern bool launch_multilayer_effective_field_fp32(Context &ctx);

static bool upload_f64_array(Context &ctx, double *&dst, const double *src,
                             uint64_t count, const char *label);

static bool ensure_preview_download_scratch(Context &ctx, size_t required_bytes) {
    if (ctx.preview_download_scratch
        && ctx.preview_download_scratch_len_bytes >= required_bytes)
    {
        return true;
    }
    if (ctx.preview_download_scratch) {
        cudaFree(ctx.preview_download_scratch);
        ctx.preview_download_scratch = nullptr;
        ctx.preview_download_scratch_len_bytes = 0;
    }
    cudaError_t err = cudaMalloc(&ctx.preview_download_scratch, required_bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(preview_download_scratch)", err);
        return false;
    }
    ctx.preview_download_scratch_len_bytes = required_bytes;
    return true;
}

void free_preview_download_scratch(Context &ctx) {
    if (ctx.preview_download_scratch) {
        cudaFree(ctx.preview_download_scratch);
        ctx.preview_download_scratch = nullptr;
    }
    ctx.preview_download_scratch_len_bytes = 0;
}

static void destroy_async_snapshot_resources(AsyncFieldSnapshot &snapshot) {
    if (snapshot.done_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        snapshot.done_event = nullptr;
    }
    if (snapshot.staging_done_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.staging_done_event));
        snapshot.staging_done_event = nullptr;
    }
    if (snapshot.ready_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.ready_event));
        snapshot.ready_event = nullptr;
    }
    if (snapshot.stream) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(snapshot.stream));
        snapshot.stream = nullptr;
    }
    if (snapshot.host_soa) {
        cudaFreeHost(snapshot.host_soa);
        snapshot.host_soa = nullptr;
    }
    snapshot.host_soa_len_bytes = 0;
    free_vector_field(snapshot.staging);
    snapshot.needs_wait = false;
}

static void destroy_async_preview_resources(AsyncPreviewSnapshot &snapshot) {
    if (snapshot.done_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        snapshot.done_event = nullptr;
    }
    if (snapshot.staging_done_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.staging_done_event));
        snapshot.staging_done_event = nullptr;
    }
    if (snapshot.ready_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.ready_event));
        snapshot.ready_event = nullptr;
    }
    if (snapshot.stream) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(snapshot.stream));
        snapshot.stream = nullptr;
    }
    if (snapshot.host_xyz) {
        cudaFreeHost(snapshot.host_xyz);
        snapshot.host_xyz = nullptr;
    }
    if (snapshot.device_xyz) {
        cudaFree(snapshot.device_xyz);
        snapshot.device_xyz = nullptr;
    }
    snapshot.host_xyz_len_bytes = 0;
    snapshot.needs_wait = false;
}

template <typename InputScalar, typename OutputScalar>
__global__ void downsample_field_preview_kernel(
    const InputScalar *field_x,
    const InputScalar *field_y,
    const InputScalar *field_z,
    uint32_t full_x,
    uint32_t full_y,
    uint32_t full_z,
    uint32_t preview_x,
    uint32_t preview_y,
    uint32_t preview_z,
    uint32_t z_origin,
    uint32_t z_stride,
    OutputScalar *out_xyz)
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

    out_xyz[preview_index * 3 + 0] = static_cast<OutputScalar>(accum_x / count);
    out_xyz[preview_index * 3 + 1] = static_cast<OutputScalar>(accum_y / count);
    out_xyz[preview_index * 3 + 2] = static_cast<OutputScalar>(accum_z / count);
}

void free_anisotropy_fields(Context &ctx) {
    auto free_f64 = [](double *&ptr) {
        if (ptr) { cudaFree(ptr); ptr = nullptr; }
    };
    free_f64(ctx.ku1_field);
    free_f64(ctx.ku2_field);
}

bool context_upload_anisotropy_fields(Context &ctx, const double *ku1, const double *ku2, uint64_t len) {
    if (!ctx.has_uniaxial_anisotropy || len != ctx.cell_count) {
        return true;
    }
    if (ku1) {
        if (!upload_f64_array(ctx, ctx.ku1_field, ku1, len, "cudaMalloc(ku1_field)")) return false;
    }
    if (ku2) {
        if (!upload_f64_array(ctx, ctx.ku2_field, ku2, len, "cudaMalloc(ku2_field)")) return false;
    }
    return true;
}

void free_cubic_anisotropy_fields(Context &ctx) {
    auto free_f64 = [](double *&ptr) {
        if (ptr) { cudaFree(ptr); ptr = nullptr; }
    };
    free_f64(ctx.kc1_field);
    free_f64(ctx.kc2_field);
    free_f64(ctx.kc3_field);
}

bool context_upload_cubic_anisotropy_fields(Context &ctx, const double *kc1, const double *kc2, const double *kc3, uint64_t len) {
    if (!ctx.has_cubic_anisotropy || len != ctx.cell_count) {
        return true;
    }
    if (kc1) {
        if (!upload_f64_array(ctx, ctx.kc1_field, kc1, len, "cudaMalloc(kc1_field)")) return false;
    }
    if (kc2) {
        if (!upload_f64_array(ctx, ctx.kc2_field, kc2, len, "cudaMalloc(kc2_field)")) return false;
    }
    if (kc3) {
        if (!upload_f64_array(ctx, ctx.kc3_field, kc3, len, "cudaMalloc(kc3_field)")) return false;
    }
    return true;
}

void free_boundary_correction(Context &ctx) {
    auto free_f64 = [](double *&ptr) {
        if (ptr) { cudaFree(ptr); ptr = nullptr; }
    };
    free_f64(ctx.volume_fraction);
    free_f64(ctx.face_link_xp); free_f64(ctx.face_link_xm);
    free_f64(ctx.face_link_yp); free_f64(ctx.face_link_ym);
    free_f64(ctx.face_link_zp); free_f64(ctx.face_link_zm);
    free_f64(ctx.delta_xp); free_f64(ctx.delta_xm);
    free_f64(ctx.delta_yp); free_f64(ctx.delta_ym);
    free_f64(ctx.delta_zp); free_f64(ctx.delta_zm);
    if (ctx.demag_corr_target_idx) { cudaFree(ctx.demag_corr_target_idx); ctx.demag_corr_target_idx = nullptr; }
    if (ctx.demag_corr_source_idx) { cudaFree(ctx.demag_corr_source_idx); ctx.demag_corr_source_idx = nullptr; }
    if (ctx.demag_corr_tensor)     { cudaFree(ctx.demag_corr_tensor);     ctx.demag_corr_tensor = nullptr; }
    ctx.boundary_tier = 0;
    ctx.has_demag_boundary_corr = false;
}

static bool upload_f64_array(Context &ctx, double *&dst, const double *src,
                              uint64_t count, const char *label) {
    size_t bytes = count * sizeof(double);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&dst), bytes);
    if (err != cudaSuccess) { set_cuda_error(ctx, label, err); return false; }
    err = cudaMemcpy(dst, src, bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, label, err); return false; }
    return true;
}

bool context_upload_boundary_correction(
    Context &ctx,
    uint8_t tier,
    double phi_floor,
    double delta_min,
    const double *volume_fraction,
    const double *face_link_xp, const double *face_link_xm,
    const double *face_link_yp, const double *face_link_ym,
    const double *face_link_zp, const double *face_link_zm,
    const double *delta_xp, const double *delta_xm,
    const double *delta_yp, const double *delta_ym,
    const double *delta_zp, const double *delta_zm,
    uint64_t cell_count)
{
    if (tier == 0 || cell_count != ctx.cell_count) {
        return true; // nothing to upload
    }
    if (!volume_fraction) {
        ctx.last_error = "boundary_correction: volume_fraction is required";
        return false;
    }

    ctx.boundary_tier = tier;
    ctx.phi_floor = (phi_floor > 0.0) ? phi_floor : 0.05;
    ctx.delta_min = (delta_min > 0.0) ? delta_min
                  : 0.1 * fmin(fmin(ctx.dx, ctx.dy), ctx.dz);

    uint64_t n = ctx.cell_count;
    if (!upload_f64_array(ctx, ctx.volume_fraction, volume_fraction, n, "cudaMalloc(volume_fraction)"))
        return false;

    // Face links (T0+T1)
    if (face_link_xp && face_link_xm && face_link_yp && face_link_ym
        && face_link_zp && face_link_zm)
    {
        if (!upload_f64_array(ctx, ctx.face_link_xp, face_link_xp, n, "face_link_xp")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_xm, face_link_xm, n, "face_link_xm")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_yp, face_link_yp, n, "face_link_yp")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_ym, face_link_ym, n, "face_link_ym")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_zp, face_link_zp, n, "face_link_zp")) return false;
        if (!upload_f64_array(ctx, ctx.face_link_zm, face_link_zm, n, "face_link_zm")) return false;
    }

    // Intersection distances (T1 only)
    if (tier >= 2 && delta_xp && delta_xm && delta_yp && delta_ym
        && delta_zp && delta_zm)
    {
        if (!upload_f64_array(ctx, ctx.delta_xp, delta_xp, n, "delta_xp")) return false;
        if (!upload_f64_array(ctx, ctx.delta_xm, delta_xm, n, "delta_xm")) return false;
        if (!upload_f64_array(ctx, ctx.delta_yp, delta_yp, n, "delta_yp")) return false;
        if (!upload_f64_array(ctx, ctx.delta_ym, delta_ym, n, "delta_ym")) return false;
        if (!upload_f64_array(ctx, ctx.delta_zp, delta_zp, n, "delta_zp")) return false;
        if (!upload_f64_array(ctx, ctx.delta_zm, delta_zm, n, "delta_zm")) return false;
    }

    return true;
}

bool context_upload_demag_boundary_corr(
    Context &ctx,
    const int32_t *target_idx,
    const int32_t *source_idx,
    const double *tensor,
    uint32_t target_count,
    uint32_t stencil_size)
{
    if (target_count == 0 || stencil_size == 0 || !target_idx || !source_idx || !tensor) {
        return true; // nothing to upload
    }

    ctx.demag_corr_target_count = target_count;
    ctx.demag_corr_stencil_size = stencil_size;

    // Target indices
    {
        size_t bytes = target_count * sizeof(int32_t);
        cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.demag_corr_target_idx), bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(demag_target_idx)", err); return false; }
        err = cudaMemcpy(ctx.demag_corr_target_idx, target_idx, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(demag_target_idx)", err); return false; }
    }

    // Source indices
    {
        size_t bytes = (uint64_t)target_count * stencil_size * sizeof(int32_t);
        cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.demag_corr_source_idx), bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(demag_source_idx)", err); return false; }
        err = cudaMemcpy(ctx.demag_corr_source_idx, source_idx, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(demag_source_idx)", err); return false; }
    }

    // Correction tensors (6 components per pair)
    {
        size_t bytes = (uint64_t)target_count * stencil_size * 6 * sizeof(double);
        cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.demag_corr_tensor), bytes);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(demag_tensor)", err); return false; }
        err = cudaMemcpy(ctx.demag_corr_tensor, tensor, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(demag_tensor)", err); return false; }
    }

    ctx.has_demag_boundary_corr = true;
    return true;
}

template <typename HostScalar>
static bool context_upload_magnetization_impl(Context &ctx, const HostScalar *m_xyz, uint64_t len) {
    uint64_t n = ctx.cell_count;
    if (!m_xyz || len != n * 3) {
        ctx.last_error = "magnetization length mismatch";
        return false;
    }

    size_t bytes = n * scalar_size(ctx.precision);
    auto upload_component = [&](void *dst, const void *src, const char *label) -> bool {
        cudaError_t err = cudaMemcpy(dst, src, bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, label, err);
            return false;
        }
        return true;
    };

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(n), hy(n), hz(n);
        for (uint64_t i = 0; i < n; i++) {
            bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
            hx[i] = is_active ? static_cast<double>(m_xyz[3 * i + 0]) : 0.0;
            hy[i] = is_active ? static_cast<double>(m_xyz[3 * i + 1]) : 0.0;
            hz[i] = is_active ? static_cast<double>(m_xyz[3 * i + 2]) : 0.0;
        }
        return upload_component(ctx.m.x, hx.data(), "cudaMemcpy(m.x)")
            && upload_component(ctx.m.y, hy.data(), "cudaMemcpy(m.y)")
            && upload_component(ctx.m.z, hz.data(), "cudaMemcpy(m.z)");
    }

    std::vector<float> hx(n), hy(n), hz(n);
    for (uint64_t i = 0; i < n; i++) {
        bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
        hx[i] = is_active ? static_cast<float>(m_xyz[3 * i + 0]) : 0.0f;
        hy[i] = is_active ? static_cast<float>(m_xyz[3 * i + 1]) : 0.0f;
        hz[i] = is_active ? static_cast<float>(m_xyz[3 * i + 2]) : 0.0f;
    }
    return upload_component(ctx.m.x, hx.data(), "cudaMemcpy(m.x)")
        && upload_component(ctx.m.y, hy.data(), "cudaMemcpy(m.y)")
        && upload_component(ctx.m.z, hz.data(), "cudaMemcpy(m.z)");
}

bool context_upload_magnetization_f64(Context &ctx, const double *m_xyz, uint64_t len) {
    return context_upload_magnetization_impl(ctx, m_xyz, len);
}

bool context_upload_magnetization_f32(Context &ctx, const float *m_xyz, uint64_t len) {
    return context_upload_magnetization_impl(ctx, m_xyz, len);
}

template <typename HostScalar>
static bool upload_vector_field_aos_host(
    Context &ctx,
    DeviceVectorField &dst,
    const HostScalar *src_xyz,
    uint64_t cell_count,
    const char *label)
{
    if (!src_xyz) {
        ctx.last_error = std::string(label) + " source is null";
        return false;
    }

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(cell_count), hy(cell_count), hz(cell_count);
        for (uint64_t i = 0; i < cell_count; ++i) {
            hx[i] = static_cast<double>(src_xyz[i * 3 + 0]);
            hy[i] = static_cast<double>(src_xyz[i * 3 + 1]);
            hz[i] = static_cast<double>(src_xyz[i * 3 + 2]);
        }
        const size_t bytes = cell_count * sizeof(double);
        cudaError_t err = cudaMemcpy(dst.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".x").c_str(), err); return false; }
        err = cudaMemcpy(dst.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".y").c_str(), err); return false; }
        err = cudaMemcpy(dst.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".z").c_str(), err); return false; }
        return true;
    }

    std::vector<float> hx(cell_count), hy(cell_count), hz(cell_count);
    for (uint64_t i = 0; i < cell_count; ++i) {
        hx[i] = static_cast<float>(src_xyz[i * 3 + 0]);
        hy[i] = static_cast<float>(src_xyz[i * 3 + 1]);
        hz[i] = static_cast<float>(src_xyz[i * 3 + 2]);
    }
    const size_t bytes = cell_count * sizeof(float);
    cudaError_t err = cudaMemcpy(dst.x, hx.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".x").c_str(), err); return false; }
    err = cudaMemcpy(dst.y, hy.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".y").c_str(), err); return false; }
    err = cudaMemcpy(dst.z, hz.data(), bytes, cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { set_cuda_error(ctx, (std::string(label) + ".z").c_str(), err); return false; }
    return true;
}


template <typename HostScalar>
static bool context_upload_layer_magnetization_impl(
    Context &ctx,
    uint32_t layer_index,
    const HostScalar *m_xyz,
    uint64_t len)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "per-layer magnetization upload requires a staged v2 multilayer plan";
        return false;
    }
    if (layer_index >= ctx.multilayer_layers.size()) {
        ctx.last_error = "layer_index out of range";
        return false;
    }

    DeviceMultilayerLayer &layer = ctx.multilayer_layers[layer_index];
    if (!m_xyz || len != layer.cell_count * 3) {
        ctx.last_error = "layer magnetization length mismatch";
        return false;
    }

    return upload_vector_field_aos_host(
        ctx,
        layer.m,
        m_xyz,
        layer.cell_count,
        "cudaMemcpy(multilayer_layer_m)");
}

bool context_upload_layer_magnetization_f64(
    Context &ctx,
    uint32_t layer_index,
    const double *m_xyz,
    uint64_t len)
{
    return context_upload_layer_magnetization_impl(ctx, layer_index, m_xyz, len);
}

bool context_upload_layer_magnetization_f32(
    Context &ctx,
    uint32_t layer_index,
    const float *m_xyz,
    uint64_t len)
{
    return context_upload_layer_magnetization_impl(ctx, layer_index, m_xyz, len);
}

template <typename HostScalar>
static bool context_download_field_impl(
    Context &ctx,
    fullmag_fdm_observable observable,
    HostScalar *out_xyz,
    uint64_t out_len)
{
    uint64_t n = ctx.cell_count;
    if (!out_xyz || out_len != n * 3) {
        return false;
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_ANI
        && !context_refresh_anisotropy_observable(ctx))
    {
        return false;
    }

    const DeviceVectorField *field;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M: field = &ctx.m; break;
        case FULLMAG_FDM_OBSERVABLE_H_EX: field = &ctx.h_ex; break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG: field = &ctx.h_demag; break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI: field = &ctx.h_ani; break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF: field = &ctx.work; break;
        case FULLMAG_FDM_OBSERVABLE_H_OE: {
            const double scale = oersted_field_scale(ctx);
            for (uint64_t i = 0; i < n; i++) {
                const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                out_xyz[3 * i + 0] = 0.0;
                out_xyz[3 * i + 1] = 0.0;
                out_xyz[3 * i + 2] = 0.0;
                if (!ctx.has_oersted_field || !is_active || scale == 0.0) {
                    continue;
                }
            }
            const DeviceVectorField *oe_field = ctx.has_oersted_field ? &ctx.h_oe_static : nullptr;
            auto copy_components = [&](auto tag) -> bool {
                using DeviceScalar = decltype(tag);
                std::vector<DeviceScalar> hx(n), hy(n), hz(n);
                size_t bytes = n * sizeof(DeviceScalar);
                cudaError_t err = cudaMemcpy(hx.data(), oe_field->x, bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) {
                    set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_oe.x)", err);
                    return false;
                }
                err = cudaMemcpy(hy.data(), oe_field->y, bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) {
                    set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_oe.y)", err);
                    return false;
                }
                err = cudaMemcpy(hz.data(), oe_field->z, bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) {
                    set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(h_oe.z)", err);
                    return false;
                }
                for (uint64_t i = 0; i < n; i++) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    if (!is_active) {
                        continue;
                    }
                    out_xyz[3 * i + 0] = static_cast<HostScalar>(scale * static_cast<double>(hx[i]));
                    out_xyz[3 * i + 1] = static_cast<HostScalar>(scale * static_cast<double>(hy[i]));
                    out_xyz[3 * i + 2] = static_cast<HostScalar>(scale * static_cast<double>(hz[i]));
                }
                return true;
            };
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                return copy_components(double{0.0});
            }
            return copy_components(float{0.0f});
        }
        case FULLMAG_FDM_OBSERVABLE_H_EXT: {
            for (uint64_t i = 0; i < n; i++) {
                bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                out_xyz[3 * i + 0] = (ctx.has_external_field && is_active)
                    ? static_cast<HostScalar>(ctx.external_field[0])
                    : static_cast<HostScalar>(0.0);
                out_xyz[3 * i + 1] = (ctx.has_external_field && is_active)
                    ? static_cast<HostScalar>(ctx.external_field[1])
                    : static_cast<HostScalar>(0.0);
                out_xyz[3 * i + 2] = (ctx.has_external_field && is_active)
                    ? static_cast<HostScalar>(ctx.external_field[2])
                    : static_cast<HostScalar>(0.0);
            }
            return true;
        }
        default:
            return false;
    }

    auto copy_components = [&](auto tag) -> bool {
        using DeviceScalar = decltype(tag);
        std::vector<DeviceScalar> hx(n), hy(n), hz(n);
        size_t bytes = n * sizeof(DeviceScalar);
        cudaError_t err = cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(field.x)", err);
            return false;
        }
        err = cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(field.y)", err);
            return false;
        }
        err = cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(const_cast<Context &>(ctx), "cudaMemcpy(field.z)", err);
            return false;
        }
        for (uint64_t i = 0; i < n; i++) {
            out_xyz[3 * i + 0] = static_cast<HostScalar>(hx[i]);
            out_xyz[3 * i + 1] = static_cast<HostScalar>(hy[i]);
            out_xyz[3 * i + 2] = static_cast<HostScalar>(hz[i]);
        }
        return true;
    };

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        return copy_components(double{});
    }
    return copy_components(float{});
}

bool context_download_field_f64(
    Context &ctx,
    fullmag_fdm_observable observable,
    double *out_xyz,
    uint64_t out_len)
{
    return context_download_field_impl(ctx, observable, out_xyz, out_len);
}

bool context_download_field_f32(
    Context &ctx,
    fullmag_fdm_observable observable,
    float *out_xyz,
    uint64_t out_len)
{
    return context_download_field_impl(ctx, observable, out_xyz, out_len);
}

static bool context_refresh_multilayer_exchange_observable(Context &ctx)
{
    if (!ctx.enable_exchange) {
        return true;
    }
    ctx.last_error.clear();
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        launch_multilayer_exchange_field_fp64(ctx);
    } else {
        launch_multilayer_exchange_field_fp32(ctx);
    }
    return ctx.last_error.empty();
}

template <typename HostScalar>
static bool context_download_layer_field_impl(
    Context &ctx,
    uint32_t layer_index,
    fullmag_fdm_observable observable,
    HostScalar *out_xyz,
    uint64_t out_len)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "per-layer field copy requires a staged v2 multilayer plan";
        return false;
    }
    if (layer_index >= ctx.multilayer_layers.size()) {
        ctx.last_error = "layer_index out of range";
        return false;
    }

    const DeviceMultilayerLayer &layer = ctx.multilayer_layers[layer_index];
    if (!out_xyz || out_len != layer.cell_count * 3) {
        ctx.last_error = "layer out_len mismatch";
        return false;
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_EX
        && !context_refresh_multilayer_exchange_observable(ctx))
    {
        return false;
    }
    if (observable == FULLMAG_FDM_OBSERVABLE_H_DMI) {
        const bool ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_dmi_field_fp64(ctx)
            : launch_multilayer_dmi_field_fp32(ctx);
        if (!ok) {
            return false;
        }
    }
    if (observable == FULLMAG_FDM_OBSERVABLE_H_ANI) {
        const bool ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_anisotropy_field_fp64(ctx)
            : launch_multilayer_anisotropy_field_fp32(ctx);
        if (!ok) {
            return false;
        }
    }
    if (observable == FULLMAG_FDM_OBSERVABLE_H_EFF) {
        if (!context_refresh_multilayer_exchange_observable(ctx)) {
            return false;
        }
        const bool dmi_ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_dmi_field_fp64(ctx)
            : launch_multilayer_dmi_field_fp32(ctx);
        if (!dmi_ok) {
            return false;
        }
        const bool anisotropy_ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_anisotropy_field_fp64(ctx)
            : launch_multilayer_anisotropy_field_fp32(ctx);
        if (!anisotropy_ok) {
            return false;
        }
        const bool effective_ok = ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? launch_multilayer_effective_field_fp64(ctx)
            : launch_multilayer_effective_field_fp32(ctx);
        if (!effective_ok) {
            return false;
        }
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_EXT) {
        const uint64_t n = layer.cell_count;
        std::vector<uint8_t> active_mask;
        if (layer.has_active_mask) {
            active_mask.resize(n);
            cudaError_t err = cudaMemcpy(
                active_mask.data(),
                layer.active_mask,
                static_cast<size_t>(n) * sizeof(uint8_t),
                cudaMemcpyDeviceToHost);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_h_ext_active_mask)", err);
                return false;
            }
        }
        for (uint64_t i = 0; i < n; ++i) {
            const bool is_active = !layer.has_active_mask || active_mask[i] != 0;
            out_xyz[i * 3 + 0] = (ctx.has_external_field && is_active)
                ? static_cast<HostScalar>(ctx.external_field[0])
                : HostScalar{};
            out_xyz[i * 3 + 1] = (ctx.has_external_field && is_active)
                ? static_cast<HostScalar>(ctx.external_field[1])
                : HostScalar{};
            out_xyz[i * 3 + 2] = (ctx.has_external_field && is_active)
                ? static_cast<HostScalar>(ctx.external_field[2])
                : HostScalar{};
        }
        return true;
    }

    const DeviceVectorField *field = nullptr;
    switch (observable) {
        case FULLMAG_FDM_OBSERVABLE_M:
            field = &layer.m;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EX:
            field = &layer.h_ex;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DEMAG:
            field = &layer.h_demag;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_DMI:
            field = &layer.h_dmi;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            field = &layer.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &layer.tmp;
            break;
        default:
            ctx.last_error = "unsupported multilayer layer observable";
            return false;
    }

    auto copy_components = [&](auto tag) -> bool {
        using DeviceScalar = decltype(tag);
        const uint64_t n = layer.cell_count;
        std::vector<DeviceScalar> hx(n), hy(n), hz(n);
        const size_t bytes = static_cast<size_t>(n) * sizeof(DeviceScalar);
        cudaError_t err = cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_field.x)", err);
            return false;
        }
        err = cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_field.y)", err);
            return false;
        }
        err = cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemcpy(multilayer_layer_field.z)", err);
            return false;
        }
        for (uint64_t i = 0; i < n; ++i) {
            out_xyz[i * 3 + 0] = static_cast<HostScalar>(hx[i]);
            out_xyz[i * 3 + 1] = static_cast<HostScalar>(hy[i]);
            out_xyz[i * 3 + 2] = static_cast<HostScalar>(hz[i]);
        }
        return true;
    };

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        return copy_components(double{});
    }
    return copy_components(float{});
}

bool context_download_layer_field_f64(
    Context &ctx,
    uint32_t layer_index,
    fullmag_fdm_observable observable,
    double *out_xyz,
    uint64_t out_len)
{
    return context_download_layer_field_impl(ctx, layer_index, observable, out_xyz, out_len);
}

bool context_download_layer_field_f32(
    Context &ctx,
    uint32_t layer_index,
    fullmag_fdm_observable observable,
    float *out_xyz,
    uint64_t out_len)
{
    return context_download_layer_field_impl(ctx, layer_index, observable, out_xyz, out_len);
}

template <typename HostScalar>
static bool context_download_field_preview_impl(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    HostScalar *out_xyz,
    uint64_t out_len)
{
    if (!out_xyz || preview_nx == 0 || preview_ny == 0 || preview_nz == 0 || z_stride == 0) {
        return false;
    }

    uint64_t preview_count = static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz;
    if (out_len != preview_count * 3 || z_origin >= ctx.nz) {
        return false;
    }

    if (preview_nx == ctx.nx && preview_ny == ctx.ny && preview_nz == ctx.nz
        && z_origin == 0 && z_stride == 1)
    {
        return context_download_field_impl(ctx, observable, out_xyz, out_len);
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_ANI
        && !context_refresh_anisotropy_observable(ctx))
    {
        return false;
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
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            field = &ctx.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &ctx.work;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_OE:
            if (!ctx.has_oersted_field) {
                for (uint64_t i = 0; i < preview_count * 3u; ++i) {
                    out_xyz[i] = static_cast<HostScalar>(0.0);
                }
                return true;
            }
            field = &ctx.h_oe_static;
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
                        out_xyz[preview_index * 3 + 0] =
                            static_cast<HostScalar>(ctx.external_field[0] * scale);
                        out_xyz[preview_index * 3 + 1] =
                            static_cast<HostScalar>(ctx.external_field[1] * scale);
                        out_xyz[preview_index * 3 + 2] =
                            static_cast<HostScalar>(ctx.external_field[2] * scale);
                    }
                }
            }
            return true;
        }
        default:
            return false;
    }

    if (!ensure_preview_download_scratch(ctx, preview_count * 3 * sizeof(HostScalar))) {
        return false;
    }
    auto *device_out = reinterpret_cast<HostScalar *>(ctx.preview_download_scratch);

    constexpr uint32_t threads_per_block = 256;
    uint32_t blocks =
        static_cast<uint32_t>((preview_count + threads_per_block - 1) / threads_per_block);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        downsample_field_preview_kernel<double, HostScalar><<<blocks, threads_per_block>>>(
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
        downsample_field_preview_kernel<float, HostScalar><<<blocks, threads_per_block>>>(
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

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "downsample_field_preview_kernel", err);
        return false;
    }
    err = cudaMemcpy(
        out_xyz,
        device_out,
        preview_count * 3 * sizeof(HostScalar),
        cudaMemcpyDeviceToHost);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(preview_out)", err);
        return false;
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_OE) {
        const double scale = oersted_field_scale(ctx);
        for (uint64_t i = 0; i < preview_count * 3u; ++i) {
            out_xyz[i] = static_cast<HostScalar>(static_cast<double>(out_xyz[i]) * scale);
        }
    }

    return true;
}

bool context_download_field_preview_f64(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    double *out_xyz,
    uint64_t out_len)
{
    return context_download_field_preview_impl(
        ctx,
        observable,
        preview_nx,
        preview_ny,
        preview_nz,
        z_origin,
        z_stride,
        out_xyz,
        out_len);
}

bool context_download_field_preview_f32(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride,
    float *out_xyz,
    uint64_t out_len)
{
    return context_download_field_preview_impl(
        ctx,
        observable,
        preview_nx,
        preview_ny,
        preview_nz,
        z_origin,
        z_stride,
        out_xyz,
        out_len);
}

AsyncFieldSnapshot *context_begin_async_field_snapshot(
    Context &ctx,
    fullmag_fdm_observable observable)
{
    auto *snapshot = new (std::nothrow) AsyncFieldSnapshot();
    if (snapshot == nullptr) {
        ctx.last_error = "failed to allocate async field snapshot";
        return nullptr;
    }
    snapshot->precision = ctx.precision;
    snapshot->cell_count = ctx.cell_count;
    snapshot->host_soa_len_bytes = ctx.cell_count * 3u * scalar_size(ctx.precision);

    auto fail = [&](const char *label, cudaError_t err) -> AsyncFieldSnapshot * {
        ctx.last_error = std::string(label) + ": " + cudaGetErrorString(err);
        destroy_async_snapshot_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    auto fail_message = [&](const std::string &message) -> AsyncFieldSnapshot * {
        ctx.last_error = message;
        destroy_async_snapshot_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    const size_t component_bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaError_t err = cudaMalloc(&snapshot->staging.x, component_bytes);
    if (err != cudaSuccess) return fail("cudaMalloc(snapshot.x)", err);
    err = cudaMalloc(&snapshot->staging.y, component_bytes);
    if (err != cudaSuccess) return fail("cudaMalloc(snapshot.y)", err);
    err = cudaMalloc(&snapshot->staging.z, component_bytes);
    if (err != cudaSuccess) return fail("cudaMalloc(snapshot.z)", err);

    err = cudaHostAlloc(&snapshot->host_soa, snapshot->host_soa_len_bytes, cudaHostAllocDefault);
    if (err != cudaSuccess) return fail("cudaHostAlloc(snapshot.host_soa)", err);

    cudaStream_t io_stream{};
    err = cudaStreamCreateWithFlags(&io_stream, cudaStreamNonBlocking);
    if (err != cudaSuccess) return fail("cudaStreamCreate(snapshot.io_stream)", err);
    snapshot->stream = reinterpret_cast<void *>(io_stream);

    cudaEvent_t ready_event{};
    err = cudaEventCreateWithFlags(&ready_event, cudaEventDisableTiming);
    if (err != cudaSuccess) return fail("cudaEventCreate(snapshot.ready_event)", err);
    snapshot->ready_event = reinterpret_cast<void *>(ready_event);

    cudaEvent_t staging_done_event{};
    err = cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming);
    if (err != cudaSuccess) return fail("cudaEventCreate(snapshot.staging_done_event)", err);
    snapshot->staging_done_event = reinterpret_cast<void *>(staging_done_event);

    cudaEvent_t done_event{};
    err = cudaEventCreateWithFlags(&done_event, cudaEventDisableTiming);
    if (err != cudaSuccess) return fail("cudaEventCreate(snapshot.done_event)", err);
    snapshot->done_event = reinterpret_cast<void *>(done_event);

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
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            if (!context_refresh_anisotropy_observable(ctx)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_ani snapshot"
                                           : ctx.last_error);
            }
            field = &ctx.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &ctx.work;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_OE:
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                if (!ctx.has_oersted_field) {
                    auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                    std::fill(host, host + (ctx.cell_count * 3u), 0.0);
                    snapshot->needs_wait = false;
                    return snapshot;
                }
                std::vector<double> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                err = cudaMemcpy(hx.data(), ctx.h_oe_static.x, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_x)", err);
                err = cudaMemcpy(hy.data(), ctx.h_oe_static.y, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_y)", err);
                err = cudaMemcpy(hz.data(), ctx.h_oe_static.z, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_z)", err);
                auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                const double scale = oersted_field_scale(ctx);
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_oersted_field && is_active) ? hx[i] * scale : 0.0;
                    host[ctx.cell_count + i] =
                        (ctx.has_oersted_field && is_active) ? hy[i] * scale : 0.0;
                    host[(ctx.cell_count * 2u) + i] =
                        (ctx.has_oersted_field && is_active) ? hz[i] * scale : 0.0;
                }
            } else {
                if (!ctx.has_oersted_field) {
                    auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                    std::fill(host, host + (ctx.cell_count * 3u), 0.0f);
                    snapshot->needs_wait = false;
                    return snapshot;
                }
                std::vector<float> hx(ctx.cell_count), hy(ctx.cell_count), hz(ctx.cell_count);
                err = cudaMemcpy(hx.data(), ctx.h_oe_static.x, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_x)", err);
                err = cudaMemcpy(hy.data(), ctx.h_oe_static.y, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_y)", err);
                err = cudaMemcpy(hz.data(), ctx.h_oe_static.z, component_bytes, cudaMemcpyDeviceToHost);
                if (err != cudaSuccess) return fail("cudaMemcpy(snapshot.h_oe_z)", err);
                auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                const float scale = static_cast<float>(oersted_field_scale(ctx));
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_oersted_field && is_active) ? hx[i] * scale : 0.0f;
                    host[ctx.cell_count + i] =
                        (ctx.has_oersted_field && is_active) ? hy[i] * scale : 0.0f;
                    host[(ctx.cell_count * 2u) + i] =
                        (ctx.has_oersted_field && is_active) ? hz[i] * scale : 0.0f;
                }
            }
            snapshot->needs_wait = false;
            return snapshot;
        case FULLMAG_FDM_OBSERVABLE_H_EXT:
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                auto *host = reinterpret_cast<double *>(snapshot->host_soa);
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_external_field && is_active) ? ctx.external_field[0] : 0.0;
                    host[ctx.cell_count + i] =
                        (ctx.has_external_field && is_active) ? ctx.external_field[1] : 0.0;
                    host[(ctx.cell_count * 2u) + i] =
                        (ctx.has_external_field && is_active) ? ctx.external_field[2] : 0.0;
                }
            } else {
                auto *host = reinterpret_cast<float *>(snapshot->host_soa);
                for (uint64_t i = 0; i < ctx.cell_count; ++i) {
                    const bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
                    host[i] = (ctx.has_external_field && is_active)
                        ? static_cast<float>(ctx.external_field[0])
                        : 0.0f;
                    host[ctx.cell_count + i] = (ctx.has_external_field && is_active)
                        ? static_cast<float>(ctx.external_field[1])
                        : 0.0f;
                    host[(ctx.cell_count * 2u) + i] = (ctx.has_external_field && is_active)
                        ? static_cast<float>(ctx.external_field[2])
                        : 0.0f;
                }
            }
            snapshot->needs_wait = false;
            return snapshot;
        default:
            return fail_message("unsupported async snapshot observable");
    }

    err = cudaEventRecord(ready_event, nullptr);
    if (err != cudaSuccess) return fail("cudaEventRecord(snapshot.ready_event)", err);

    err = cudaStreamWaitEvent(io_stream, ready_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(snapshot.ready_event)", err);

    err = cudaMemcpyAsync(
        snapshot->staging.x, field->x, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.x)", err);
    err = cudaMemcpyAsync(
        snapshot->staging.y, field->y, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.y)", err);
    err = cudaMemcpyAsync(
        snapshot->staging.z, field->z, component_bytes, cudaMemcpyDeviceToDevice, io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.z)", err);

    err = cudaEventRecord(staging_done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(snapshot.staging_done_event)", err);

    err = cudaStreamWaitEvent(nullptr, staging_done_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(snapshot.staging_done_event)", err);

    auto *host_bytes = static_cast<unsigned char *>(snapshot->host_soa);
    err = cudaMemcpyAsync(
        host_bytes,
        snapshot->staging.x,
        component_bytes,
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.host_x)", err);
    err = cudaMemcpyAsync(
        host_bytes + component_bytes,
        snapshot->staging.y,
        component_bytes,
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.host_y)", err);
    err = cudaMemcpyAsync(
        host_bytes + (component_bytes * 2u),
        snapshot->staging.z,
        component_bytes,
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(snapshot.host_z)", err);

    err = cudaEventRecord(done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(snapshot.done_event)", err);

    snapshot->needs_wait = true;
    return snapshot;
}

bool context_wait_async_field_snapshot(
    AsyncFieldSnapshot &snapshot,
    const void **out_data,
    uint64_t &out_len_bytes,
    fullmag_fdm_snapshot_desc &out_desc,
    std::string &error)
{
    if (out_data == nullptr) {
        error = "async snapshot output pointer is null";
        return false;
    }

    if (snapshot.needs_wait) {
        cudaError_t err =
            cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        if (err != cudaSuccess) {
            error = std::string("cudaEventSynchronize(snapshot.done_event): ")
                + cudaGetErrorString(err);
            return false;
        }
        snapshot.needs_wait = false;
    }

    *out_data = snapshot.host_soa;
    out_len_bytes = static_cast<uint64_t>(snapshot.host_soa_len_bytes);
    out_desc.cell_count = snapshot.cell_count;
    out_desc.component_count = 3;
    out_desc.scalar_bytes =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE ? 4u : 8u;
    out_desc.scalar_type =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE
            ? FULLMAG_FDM_SNAPSHOT_SCALAR_F32
            : FULLMAG_FDM_SNAPSHOT_SCALAR_F64;
    return true;
}

void context_destroy_async_field_snapshot(AsyncFieldSnapshot *snapshot) {
    if (snapshot == nullptr) {
        return;
    }
    destroy_async_snapshot_resources(*snapshot);
    delete snapshot;
}

AsyncPreviewSnapshot *context_begin_async_preview_snapshot(
    Context &ctx,
    fullmag_fdm_observable observable,
    uint32_t preview_nx,
    uint32_t preview_ny,
    uint32_t preview_nz,
    uint32_t z_origin,
    uint32_t z_stride)
{
    if (preview_nx == 0 || preview_ny == 0 || preview_nz == 0 || z_stride == 0 || z_origin >= ctx.nz) {
        ctx.last_error = "invalid preview snapshot dimensions";
        return nullptr;
    }

    auto *snapshot = new (std::nothrow) AsyncPreviewSnapshot();
    if (snapshot == nullptr) {
        ctx.last_error = "failed to allocate async preview snapshot";
        return nullptr;
    }
    snapshot->precision = ctx.precision;
    snapshot->preview_count = static_cast<uint64_t>(preview_nx) * preview_ny * preview_nz;
    snapshot->host_xyz_len_bytes = snapshot->preview_count * 3u * scalar_size(ctx.precision);

    auto fail = [&](const char *label, cudaError_t err) -> AsyncPreviewSnapshot * {
        ctx.last_error = std::string(label) + ": " + cudaGetErrorString(err);
        destroy_async_preview_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    auto fail_message = [&](const std::string &message) -> AsyncPreviewSnapshot * {
        ctx.last_error = message;
        destroy_async_preview_resources(*snapshot);
        delete snapshot;
        return nullptr;
    };

    cudaError_t err =
        cudaHostAlloc(&snapshot->host_xyz, snapshot->host_xyz_len_bytes, cudaHostAllocDefault);
    if (err != cudaSuccess) return fail("cudaHostAlloc(preview_snapshot.host_xyz)", err);

    cudaStream_t io_stream{};
    err = cudaStreamCreateWithFlags(&io_stream, cudaStreamNonBlocking);
    if (err != cudaSuccess) return fail("cudaStreamCreate(preview_snapshot.io_stream)", err);
    snapshot->stream = reinterpret_cast<void *>(io_stream);

    cudaEvent_t ready_event{};
    err = cudaEventCreateWithFlags(&ready_event, cudaEventDisableTiming);
    if (err != cudaSuccess) return fail("cudaEventCreate(preview_snapshot.ready_event)", err);
    snapshot->ready_event = reinterpret_cast<void *>(ready_event);

    cudaEvent_t staging_done_event{};
    err = cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming);
    if (err != cudaSuccess) return fail("cudaEventCreate(preview_snapshot.staging_done_event)", err);
    snapshot->staging_done_event = reinterpret_cast<void *>(staging_done_event);

    cudaEvent_t done_event{};
    err = cudaEventCreateWithFlags(&done_event, cudaEventDisableTiming);
    if (err != cudaSuccess) return fail("cudaEventCreate(preview_snapshot.done_event)", err);
    snapshot->done_event = reinterpret_cast<void *>(done_event);

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
        case FULLMAG_FDM_OBSERVABLE_H_ANI:
            if (!context_refresh_anisotropy_observable(ctx)) {
                return fail_message(
                    ctx.last_error.empty() ? "failed to refresh H_ani preview snapshot"
                                           : ctx.last_error);
            }
            field = &ctx.h_ani;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_EFF:
            field = &ctx.work;
            break;
        case FULLMAG_FDM_OBSERVABLE_H_OE:
            if (!ctx.has_oersted_field) {
                if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                    std::fill(
                        reinterpret_cast<double *>(snapshot->host_xyz),
                        reinterpret_cast<double *>(snapshot->host_xyz)
                            + (snapshot->preview_count * 3u),
                        0.0);
                } else {
                    std::fill(
                        reinterpret_cast<float *>(snapshot->host_xyz),
                        reinterpret_cast<float *>(snapshot->host_xyz)
                            + (snapshot->preview_count * 3u),
                        0.0f);
                }
                snapshot->needs_wait = false;
                return snapshot;
            }
            if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
                if (!context_download_field_preview_f64(
                        ctx,
                        observable,
                        preview_nx,
                        preview_ny,
                        preview_nz,
                        z_origin,
                        z_stride,
                        reinterpret_cast<double *>(snapshot->host_xyz),
                        snapshot->preview_count * 3u))
                {
                    return fail_message(
                        ctx.last_error.empty() ? "failed to build async preview for H_OE"
                                               : ctx.last_error);
                }
            } else {
                if (!context_download_field_preview_f32(
                        ctx,
                        observable,
                        preview_nx,
                        preview_ny,
                        preview_nz,
                        z_origin,
                        z_stride,
                        reinterpret_cast<float *>(snapshot->host_xyz),
                        snapshot->preview_count * 3u))
                {
                    return fail_message(
                        ctx.last_error.empty() ? "failed to build async preview for H_OE"
                                               : ctx.last_error);
                }
            }
            snapshot->needs_wait = false;
            return snapshot;
        case FULLMAG_FDM_OBSERVABLE_H_EXT:
            break;
        default:
            return fail_message("unsupported async preview observable");
    }

    if (observable == FULLMAG_FDM_OBSERVABLE_H_EXT) {
        if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            auto *out_xyz = reinterpret_cast<double *>(snapshot->host_xyz);
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
        } else {
            auto *out_xyz = reinterpret_cast<float *>(snapshot->host_xyz);
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
                        out_xyz[preview_index * 3 + 0] =
                            static_cast<float>(ctx.external_field[0] * scale);
                        out_xyz[preview_index * 3 + 1] =
                            static_cast<float>(ctx.external_field[1] * scale);
                        out_xyz[preview_index * 3 + 2] =
                            static_cast<float>(ctx.external_field[2] * scale);
                    }
                }
            }
        }
        snapshot->needs_wait = false;
        return snapshot;
    }

    err = cudaMalloc(&snapshot->device_xyz, snapshot->host_xyz_len_bytes);
    if (err != cudaSuccess) return fail("cudaMalloc(preview_snapshot.device_xyz)", err);

    err = cudaEventRecord(ready_event, nullptr);
    if (err != cudaSuccess) return fail("cudaEventRecord(preview_snapshot.ready_event)", err);

    err = cudaStreamWaitEvent(io_stream, ready_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(preview_snapshot.ready_event)", err);

    constexpr uint32_t threads_per_block = 256;
    uint32_t blocks = static_cast<uint32_t>(
        (snapshot->preview_count + threads_per_block - 1) / threads_per_block);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        downsample_field_preview_kernel<double, double><<<blocks, threads_per_block, 0, io_stream>>>(
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
            reinterpret_cast<double *>(snapshot->device_xyz));
    } else {
        downsample_field_preview_kernel<float, float><<<blocks, threads_per_block, 0, io_stream>>>(
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
            reinterpret_cast<float *>(snapshot->device_xyz));
    }

    err = cudaGetLastError();
    if (err != cudaSuccess) {
        return fail("downsample_field_preview_kernel(async)", err);
    }

    err = cudaEventRecord(staging_done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(preview_snapshot.staging_done_event)", err);

    err = cudaStreamWaitEvent(nullptr, staging_done_event, 0);
    if (err != cudaSuccess) return fail("cudaStreamWaitEvent(preview_snapshot.staging_done_event)", err);

    err = cudaMemcpyAsync(
        snapshot->host_xyz,
        snapshot->device_xyz,
        snapshot->host_xyz_len_bytes,
        cudaMemcpyDeviceToHost,
        io_stream);
    if (err != cudaSuccess) return fail("cudaMemcpyAsync(preview_snapshot.host_xyz)", err);

    err = cudaEventRecord(done_event, io_stream);
    if (err != cudaSuccess) return fail("cudaEventRecord(preview_snapshot.done_event)", err);

    snapshot->needs_wait = true;
    return snapshot;
}

bool context_wait_async_preview_snapshot(
    AsyncPreviewSnapshot &snapshot,
    const void **out_data,
    uint64_t &out_len_bytes,
    fullmag_fdm_snapshot_desc &out_desc,
    std::string &error)
{
    if (out_data == nullptr) {
        error = "async preview snapshot output pointer is null";
        return false;
    }

    if (snapshot.needs_wait) {
        cudaError_t err =
            cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot.done_event));
        if (err != cudaSuccess) {
            error = std::string("cudaEventSynchronize(preview_snapshot.done_event): ")
                + cudaGetErrorString(err);
            return false;
        }
        snapshot.needs_wait = false;
    }

    *out_data = snapshot.host_xyz;
    out_len_bytes = static_cast<uint64_t>(snapshot.host_xyz_len_bytes);
    out_desc.cell_count = snapshot.preview_count;
    out_desc.component_count = 3;
    out_desc.scalar_bytes =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE ? 4u : 8u;
    out_desc.scalar_type =
        snapshot.precision == FULLMAG_FDM_PRECISION_SINGLE
            ? FULLMAG_FDM_SNAPSHOT_SCALAR_F32
            : FULLMAG_FDM_SNAPSHOT_SCALAR_F64;
    return true;
}

void context_destroy_async_preview_snapshot(AsyncPreviewSnapshot *snapshot) {
    if (snapshot == nullptr) {
        return;
    }
    destroy_async_preview_resources(*snapshot);
    delete snapshot;
}


} // namespace fdm
} // namespace fullmag
