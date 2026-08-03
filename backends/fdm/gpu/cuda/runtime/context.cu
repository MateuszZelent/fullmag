/*
 * context.cu — CUDA device memory management for the FDM backend.
 *
 * Handles allocation, upload, download of SoA device buffers.
 * AoS ↔ SoA conversion happens at the host/device boundary.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <vector>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_exchange_field_fp32(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_anisotropy_field_fp64(Context &ctx);
extern void launch_anisotropy_field_fp32(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx, double evaluation_time);
extern void launch_effective_field_fp32(Context &ctx, double evaluation_time);
extern void launch_newell_compute_spectra_fp64(Context &ctx);
extern void launch_newell_compute_spectra_fp32(Context &ctx);
extern bool launch_multilayer_dmi_field_fp64(Context &ctx);
extern bool launch_multilayer_dmi_field_fp32(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp64(Context &ctx);
extern bool launch_multilayer_anisotropy_field_fp32(Context &ctx);
extern void launch_multilayer_exchange_field_fp64(Context &ctx);
extern void launch_multilayer_exchange_field_fp32(Context &ctx);
extern bool launch_multilayer_effective_field_fp64(Context &ctx);
extern bool launch_multilayer_effective_field_fp32(Context &ctx);
static void free_boundary_correction(Context &ctx);
static void free_anisotropy_fields(Context &ctx);
static void free_cubic_anisotropy_fields(Context &ctx);
static bool context_refresh_anisotropy_observable(Context &ctx);
static bool upload_f64_array(Context &ctx, double *&dst, const double *src,
                              uint64_t len, const char *label);

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
    if (!ctx.enable_demag) {
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

static uint64_t grid_cell_count(const fullmag_fdm_grid_desc &grid) {
    return static_cast<uint64_t>(grid.nx) * grid.ny * grid.nz;
}

static bool alloc_vector_field_cells(
    Context &ctx,
    DeviceVectorField &field,
    uint64_t cell_count,
    const char *label)
{
    size_t bytes = cell_count * scalar_size(ctx.precision);
    auto alloc_component = [&](void **dst, const char *component) -> bool {
        cudaError_t err = cudaMalloc(dst, bytes);
        if (err != cudaSuccess) {
            std::string name = std::string(label) + "." + component;
            set_cuda_error(ctx, name.c_str(), err);
            return false;
        }
        return true;
    };
    return alloc_component(&field.x, "x") &&
        alloc_component(&field.y, "y") &&
        alloc_component(&field.z, "z");
}

static bool upload_vector_field_aos_f64(
    Context &ctx,
    DeviceVectorField &dst,
    const double *src_xyz,
    uint64_t cell_count,
    const char *label)
{
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<double> hx(cell_count), hy(cell_count), hz(cell_count);
        for (uint64_t i = 0; i < cell_count; ++i) {
            hx[i] = src_xyz[i * 3 + 0];
            hy[i] = src_xyz[i * 3 + 1];
            hz[i] = src_xyz[i * 3 + 2];
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

static bool alloc_tensor_kernel_cells(
    Context &ctx,
    DeviceDemagKernel &kernel,
    uint64_t cell_count,
    const char *label)
{
    const size_t bytes = cell_count * complex_size(ctx.precision);
    auto alloc_component = [&](void **dst, const char *component) -> bool {
        cudaError_t err = cudaMalloc(dst, bytes);
        if (err != cudaSuccess) {
            std::string name = std::string(label) + "." + component;
            set_cuda_error(ctx, name.c_str(), err);
            return false;
        }
        return true;
    };
    return alloc_component(&kernel.xx, "xx") &&
        alloc_component(&kernel.yy, "yy") &&
        alloc_component(&kernel.zz, "zz") &&
        alloc_component(&kernel.xy, "xy") &&
        alloc_component(&kernel.xz, "xz") &&
        alloc_component(&kernel.yz, "yz");
}

static void free_device_demag_kernel(DeviceDemagKernel &kernel) {
    if (kernel.xx) { cudaFree(kernel.xx); kernel.xx = nullptr; }
    if (kernel.yy) { cudaFree(kernel.yy); kernel.yy = nullptr; }
    if (kernel.zz) { cudaFree(kernel.zz); kernel.zz = nullptr; }
    if (kernel.xy) { cudaFree(kernel.xy); kernel.xy = nullptr; }
    if (kernel.xz) { cudaFree(kernel.xz); kernel.xz = nullptr; }
    if (kernel.yz) { cudaFree(kernel.yz); kernel.yz = nullptr; }
}

static void free_device_push_map(DeviceMultilayerPushMap &map) {
    if (map.offsets) {
        cudaFree(map.offsets);
        map.offsets = nullptr;
    }
    if (map.indices) {
        cudaFree(map.indices);
        map.indices = nullptr;
    }
    if (map.weights) {
        cudaFree(map.weights);
        map.weights = nullptr;
    }
    map.cell_count = 0;
    map.entry_count = 0;
}

static void free_device_pull_map(DeviceMultilayerPullMap &map) {
    if (map.indices) {
        cudaFree(map.indices);
        map.indices = nullptr;
    }
    if (map.weights) {
        cudaFree(map.weights);
        map.weights = nullptr;
    }
    map.cell_count = 0;
}

static void unbind_multilayer_fft_workspace(Context &ctx) {
    if (!ctx.fft_workspace_bound_to_multilayer_cache) {
        return;
    }
    ctx.fft_nx = 0;
    ctx.fft_ny = 0;
    ctx.fft_nz = 0;
    ctx.fft_cell_count = 0;
    ctx.fft_component_stride = 0;
    ctx.fft_x = nullptr;
    ctx.fft_y = nullptr;
    ctx.fft_z = nullptr;
    ctx.fft_work_area = nullptr;
    ctx.fft_work_area_bytes = 0;
    ctx.fft_plan = 0;
    ctx.fft_plan_valid = false;
    ctx.fft_components_share_allocation = false;
    ctx.fft_workspace_bound_to_multilayer_cache = false;
}

static void free_multilayer_fft_workspace(DeviceMultilayerFftWorkspace &workspace) {
    if (workspace.plan_valid) {
        cufftDestroy(workspace.plan);
        workspace.plan = 0;
        workspace.plan_valid = false;
    }
    if (workspace.work_area) {
        cudaFree(workspace.work_area);
        workspace.work_area = nullptr;
    }
    workspace.work_area_bytes = 0;
    if (workspace.components_share_allocation) {
        if (workspace.fft_x) { cudaFree(workspace.fft_x); }
        workspace.fft_x = nullptr;
        workspace.fft_y = nullptr;
        workspace.fft_z = nullptr;
    } else {
        if (workspace.fft_x) { cudaFree(workspace.fft_x); workspace.fft_x = nullptr; }
        if (workspace.fft_y) { cudaFree(workspace.fft_y); workspace.fft_y = nullptr; }
        if (workspace.fft_z) { cudaFree(workspace.fft_z); workspace.fft_z = nullptr; }
    }
    workspace.cell_count = 0;
    workspace.component_stride = 0;
    workspace.components_share_allocation = false;
}

static void free_multilayer_fft_workspaces(Context &ctx) {
    unbind_multilayer_fft_workspace(ctx);
    for (DeviceMultilayerFftWorkspace &workspace : ctx.multilayer_fft_workspaces) {
        free_multilayer_fft_workspace(workspace);
    }
    ctx.multilayer_fft_workspaces.clear();
}

static uint64_t flatten_grid_index(uint32_t x, uint32_t y, uint32_t z, const fullmag_fdm_grid_desc &grid) {
    return (static_cast<uint64_t>(z) * grid.ny + y) * grid.nx + x;
}

static uint64_t clamp_grid_index(int64_t value, uint32_t upper) {
    if (value < 0) return 0;
    const uint64_t last = upper > 0 ? static_cast<uint64_t>(upper - 1) : 0;
    const uint64_t as_u64 = static_cast<uint64_t>(value);
    return as_u64 > last ? last : as_u64;
}

static bool upload_u64_array(
    Context &ctx,
    uint64_t *&dst,
    const std::vector<uint64_t> &src,
    const char *label)
{
    if (src.empty()) {
        return true;
    }
    cudaError_t err = cudaMalloc(
        reinterpret_cast<void **>(&dst),
        src.size() * sizeof(uint64_t));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    err = cudaMemcpy(dst, src.data(), src.size() * sizeof(uint64_t), cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

static bool upload_f64_vector(
    Context &ctx,
    double *&dst,
    const std::vector<double> &src,
    const char *label)
{
    if (src.empty()) {
        return true;
    }
    cudaError_t err = cudaMalloc(
        reinterpret_cast<void **>(&dst),
        src.size() * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    err = cudaMemcpy(dst, src.data(), src.size() * sizeof(double), cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

static void build_push_map_host(
    const fullmag_fdm_grid_desc &native_grid,
    const fullmag_fdm_grid_desc &convolution_grid,
    std::vector<uint64_t> &offsets,
    std::vector<uint64_t> &indices,
    std::vector<double> &weights)
{
    const uint64_t conv_cells = grid_cell_count(convolution_grid);
    offsets.assign(conv_cells + 1, 0);
    indices.clear();
    weights.clear();

    for (uint32_t cz = 0; cz < convolution_grid.nz; ++cz) {
        for (uint32_t cy = 0; cy < convolution_grid.ny; ++cy) {
            for (uint32_t cx = 0; cx < convolution_grid.nx; ++cx) {
                const uint64_t conv_idx = flatten_grid_index(cx, cy, cz, convolution_grid);
                offsets[conv_idx] = indices.size();

                const double c_lo_x = static_cast<double>(cx) * convolution_grid.dx;
                const double c_lo_y = static_cast<double>(cy) * convolution_grid.dy;
                const double c_lo_z = static_cast<double>(cz) * convolution_grid.dz;
                const double c_hi_x = c_lo_x + convolution_grid.dx;
                const double c_hi_y = c_lo_y + convolution_grid.dy;
                const double c_hi_z = c_lo_z + convolution_grid.dz;

                const int64_t nx_lo = static_cast<int64_t>(std::floor(c_lo_x / native_grid.dx));
                const int64_t nx_hi = static_cast<int64_t>(std::ceil(c_hi_x / native_grid.dx));
                const int64_t ny_lo = static_cast<int64_t>(std::floor(c_lo_y / native_grid.dy));
                const int64_t ny_hi = static_cast<int64_t>(std::ceil(c_hi_y / native_grid.dy));
                const int64_t nz_lo = static_cast<int64_t>(std::floor(c_lo_z / native_grid.dz));
                const int64_t nz_hi = static_cast<int64_t>(std::ceil(c_hi_z / native_grid.dz));

                for (int64_t nz = nz_lo; nz < nz_hi; ++nz) {
                    if (nz < 0 || nz >= static_cast<int64_t>(native_grid.nz)) continue;
                    const double n_lo_z = static_cast<double>(nz) * native_grid.dz;
                    const double n_hi_z = n_lo_z + native_grid.dz;
                    const double oz = std::max(0.0, std::min(c_hi_z, n_hi_z) - std::max(c_lo_z, n_lo_z));
                    if (oz <= 0.0) continue;
                    for (int64_t ny = ny_lo; ny < ny_hi; ++ny) {
                        if (ny < 0 || ny >= static_cast<int64_t>(native_grid.ny)) continue;
                        const double n_lo_y = static_cast<double>(ny) * native_grid.dy;
                        const double n_hi_y = n_lo_y + native_grid.dy;
                        const double oy = std::max(0.0, std::min(c_hi_y, n_hi_y) - std::max(c_lo_y, n_lo_y));
                        if (oy <= 0.0) continue;
                        for (int64_t nx = nx_lo; nx < nx_hi; ++nx) {
                            if (nx < 0 || nx >= static_cast<int64_t>(native_grid.nx)) continue;
                            const double n_lo_x = static_cast<double>(nx) * native_grid.dx;
                            const double n_hi_x = n_lo_x + native_grid.dx;
                            const double ox = std::max(0.0, std::min(c_hi_x, n_hi_x) - std::max(c_lo_x, n_lo_x));
                            if (ox <= 0.0) continue;

                            indices.push_back(flatten_grid_index(
                                static_cast<uint32_t>(nx),
                                static_cast<uint32_t>(ny),
                                static_cast<uint32_t>(nz),
                                native_grid));
                            weights.push_back(ox * oy * oz);
                        }
                    }
                }
            }
        }
    }
    offsets[conv_cells] = indices.size();
}

static void build_pull_map_host(
    const fullmag_fdm_grid_desc &native_grid,
    const fullmag_fdm_grid_desc &convolution_grid,
    const fullmag_fdm_grid_desc &fft_grid,
    std::vector<uint64_t> &indices,
    std::vector<double> &weights)
{
    const uint64_t native_cells = grid_cell_count(native_grid);
    indices.assign(native_cells * 8, 0);
    weights.assign(native_cells * 8, 0.0);

    for (uint32_t nz = 0; nz < native_grid.nz; ++nz) {
        for (uint32_t ny = 0; ny < native_grid.ny; ++ny) {
            for (uint32_t nx = 0; nx < native_grid.nx; ++nx) {
                const uint64_t native_idx = flatten_grid_index(nx, ny, nz, native_grid);
                const double fx = ((static_cast<double>(nx) + 0.5) * native_grid.dx) / convolution_grid.dx - 0.5;
                const double fy = ((static_cast<double>(ny) + 0.5) * native_grid.dy) / convolution_grid.dy - 0.5;
                const double fz = ((static_cast<double>(nz) + 0.5) * native_grid.dz) / convolution_grid.dz - 0.5;

                const double x_floor = std::floor(fx);
                const double y_floor = std::floor(fy);
                const double z_floor = std::floor(fz);
                const int64_t x0 = static_cast<int64_t>(x_floor);
                const int64_t y0 = static_cast<int64_t>(y_floor);
                const int64_t z0 = static_cast<int64_t>(z_floor);
                const double wx = fx - x_floor;
                const double wy = fy - y_floor;
                const double wz = fz - z_floor;

                uint64_t corner = 0;
                for (int dz = 0; dz < 2; ++dz) {
                    const uint32_t iz = static_cast<uint32_t>(clamp_grid_index(z0 + dz, convolution_grid.nz));
                    const double wz_i = dz == 0 ? 1.0 - wz : wz;
                    for (int dy = 0; dy < 2; ++dy) {
                        const uint32_t iy = static_cast<uint32_t>(clamp_grid_index(y0 + dy, convolution_grid.ny));
                        const double wy_i = dy == 0 ? 1.0 - wy : wy;
                        for (int dx = 0; dx < 2; ++dx) {
                            const uint32_t ix = static_cast<uint32_t>(clamp_grid_index(x0 + dx, convolution_grid.nx));
                            const double wx_i = dx == 0 ? 1.0 - wx : wx;
                            const uint64_t dst = native_idx * 8 + corner;
                            indices[dst] = flatten_grid_index(ix, iy, iz, fft_grid);
                            weights[dst] = wx_i * wy_i * wz_i;
                            ++corner;
                        }
                    }
                }
            }
        }
    }
}

static bool build_and_upload_push_map(
    Context &ctx,
    DeviceMultilayerLayer &layer)
{
    if (layer.transfer_kind != FULLMAG_FDM_TRANSFER_PUSH_PULL) {
        return true;
    }

    std::vector<uint64_t> push_offsets;
    std::vector<uint64_t> push_indices;
    std::vector<double> push_weights;
    build_push_map_host(
        layer.native_grid,
        layer.convolution_grid,
        push_offsets,
        push_indices,
        push_weights);

    layer.push_map.cell_count = layer.convolution_cell_count;
    layer.push_map.entry_count = push_indices.size();
    if (!upload_u64_array(ctx, layer.push_map.offsets, push_offsets, "cudaMemcpy(multilayer_push_map_offsets)") ||
        !upload_u64_array(ctx, layer.push_map.indices, push_indices, "cudaMemcpy(multilayer_push_map_indices)") ||
        !upload_f64_vector(ctx, layer.push_map.weights, push_weights, "cudaMemcpy(multilayer_push_map_weights)"))
    {
        return false;
    }

    return true;
}

static bool build_and_upload_kernel_pull_map(
    Context &ctx,
    DeviceMultilayerTensorKernel &kernel,
    const DeviceMultilayerLayer &dst_layer)
{
    if (dst_layer.transfer_kind != FULLMAG_FDM_TRANSFER_PUSH_PULL) {
        return true;
    }

    std::vector<uint64_t> pull_indices;
    std::vector<double> pull_weights;
    build_pull_map_host(
        dst_layer.native_grid,
        dst_layer.convolution_grid,
        kernel.fft_grid,
        pull_indices,
        pull_weights);

    kernel.dst_pull_map.cell_count = dst_layer.cell_count;
    return upload_u64_array(
            ctx,
            kernel.dst_pull_map.indices,
            pull_indices,
            "cudaMemcpy(multilayer_pull_map_indices)") &&
        upload_f64_vector(
            ctx,
            kernel.dst_pull_map.weights,
            pull_weights,
            "cudaMemcpy(multilayer_pull_map_weights)");
}

static bool upload_tensor_kernel_component(
    Context &ctx,
    void *dst,
    const fullmag_fdm_complex64 *src,
    uint64_t len,
    const char *label)
{
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        std::vector<cufftDoubleComplex> values(len);
        for (uint64_t i = 0; i < len; ++i) {
            values[i].x = src[i].re;
            values[i].y = src[i].im;
        }
        cudaError_t err = cudaMemcpy(
            dst,
            values.data(),
            len * sizeof(cufftDoubleComplex),
            cudaMemcpyHostToDevice);
        if (err != cudaSuccess) {
            set_cuda_error(ctx, label, err);
            return false;
        }
        return true;
    }

    std::vector<cufftComplex> values(len);
    for (uint64_t i = 0; i < len; ++i) {
        values[i].x = static_cast<float>(src[i].re);
        values[i].y = static_cast<float>(src[i].im);
    }
    cudaError_t err = cudaMemcpy(
        dst,
        values.data(),
        len * sizeof(cufftComplex),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

static void free_multilayer_plan_v2(Context &ctx) {
    free_multilayer_fft_workspaces(ctx);
    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        free_vector_field(layer.m);
        free_vector_field(layer.h_ex);
        free_vector_field(layer.h_demag);
        free_vector_field(layer.h_dmi);
        free_vector_field(layer.h_ani);
        free_vector_field(layer.tmp);
        free_vector_field(layer.k1);
        free_vector_field(layer.k2);
        free_vector_field(layer.k3);
        free_vector_field(layer.k4);
        free_device_push_map(layer.push_map);
        if (layer.active_mask) {
            cudaFree(layer.active_mask);
            layer.active_mask = nullptr;
        }
    }
    for (DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
        free_device_demag_kernel(kernel.tensor);
        free_device_pull_map(kernel.dst_pull_map);
    }
    ctx.multilayer_layers.clear();
    ctx.multilayer_kernels.clear();
    ctx.has_multilayer_plan_v2 = false;
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

static bool alloc_sot_active_mask(Context &ctx) {
    if (!ctx.has_sot_active_mask) {
        return true;
    }
    const size_t bytes = ctx.cell_count * sizeof(uint8_t);
    const cudaError_t err =
        cudaMalloc(reinterpret_cast<void **>(&ctx.sot_active_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(sot_active_mask)", err);
        return false;
    }
    return true;
}

static void free_sot_active_mask(Context &ctx) {
    if (ctx.sot_active_mask) {
        cudaFree(ctx.sot_active_mask);
        ctx.sot_active_mask = nullptr;
    }
}

static bool alloc_slonczewski_active_mask(Context &ctx) {
    if (!ctx.has_slonczewski_active_mask) {
        return true;
    }
    const size_t bytes = ctx.cell_count * sizeof(uint8_t);
    const cudaError_t err =
        cudaMalloc(reinterpret_cast<void **>(&ctx.slonczewski_active_mask), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(slonczewski_active_mask)", err);
        return false;
    }
    return true;
}

static void free_slonczewski_active_mask(Context &ctx) {
    if (ctx.slonczewski_active_mask) {
        cudaFree(ctx.slonczewski_active_mask);
        ctx.slonczewski_active_mask = nullptr;
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

static bool alloc_exchange_lut(Context &ctx) {
    if (!ctx.has_exchange_lut) {
        return true;
    }
    constexpr uint64_t N = FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
    size_t bytes = N * N * sizeof(double);
    cudaError_t err = cudaMalloc(reinterpret_cast<void **>(&ctx.exchange_lut), bytes);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(exchange_lut)", err);
        return false;
    }
    return true;
}

static void free_exchange_lut(Context &ctx) {
    if (ctx.exchange_lut) {
        cudaFree(ctx.exchange_lut);
        ctx.exchange_lut = nullptr;
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
    err = cudaMalloc(reinterpret_cast<void **>(&ctx.reduction_scratch_aux),
        ctx.cell_count * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(reduction_scratch_aux)", err);
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    ctx.reduction_scratch_aux_len = ctx.cell_count;
    err = cudaMalloc(reinterpret_cast<void **>(&ctx.adaptive_policy_scratch),
        3 * sizeof(double));
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMalloc(adaptive_policy_scratch)", err);
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
        ctx.reduction_scratch_aux_len = 0;
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
        ctx.reduction_scratch_len = 0;
        return false;
    }
    return true;
}

static void free_reduction_scratch(Context &ctx) {
    if (ctx.reduction_scratch) {
        cudaFree(ctx.reduction_scratch);
        ctx.reduction_scratch = nullptr;
    }
    ctx.reduction_scratch_len = 0;
    if (ctx.reduction_scratch_aux) {
        cudaFree(ctx.reduction_scratch_aux);
        ctx.reduction_scratch_aux = nullptr;
    }
    ctx.reduction_scratch_aux_len = 0;
    if (ctx.adaptive_policy_scratch) {
        cudaFree(ctx.adaptive_policy_scratch);
        ctx.adaptive_policy_scratch = nullptr;
    }
}

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

static void free_preview_download_scratch(Context &ctx) {
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

static bool alloc_fft_workspace(Context &ctx) {
    if (!ctx.enable_demag) {
        return true;
    }

    if (ctx.fft_nx == 0 || ctx.fft_ny == 0 || ctx.fft_nz == 0) {
        ctx.fft_nx = ctx.nx * 2;
        ctx.fft_ny = ctx.ny * 2;
        ctx.fft_nz = ctx.thin_film_2d_demag ? 1 : ctx.nz * 2;
    }
    ctx.fft_cell_count =
        static_cast<uint64_t>(ctx.fft_nx) * ctx.fft_ny * ctx.fft_nz;

    if (ctx.fft_cell_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = "demag FFT component stride exceeds cuFFT PlanMany limit";
        return false;
    }

    const int rank = ctx.thin_film_2d_demag ? 2 : 3;
    int dims[3] = {};
    if (ctx.thin_film_2d_demag) {
        dims[0] = static_cast<int>(ctx.fft_ny);
        dims[1] = static_cast<int>(ctx.fft_nx);
    } else {
        dims[0] = static_cast<int>(ctx.fft_nz);
        dims[1] = static_cast<int>(ctx.fft_ny);
        dims[2] = static_cast<int>(ctx.fft_nx);
    }
    int inembed[3] = {dims[0], dims[1], dims[2]};
    int onembed[3] = {dims[0], dims[1], dims[2]};
    const int component_stride = static_cast<int>(ctx.fft_cell_count);

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        size_t bytes = ctx.fft_cell_count * sizeof(cufftDoubleComplex);
        cudaError_t err = cudaMalloc(&ctx.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_xyz)", err); return false; }
        auto *base = static_cast<cufftDoubleComplex*>(ctx.fft_x);
        ctx.fft_y = base + ctx.fft_cell_count;
        ctx.fft_z = base + (2 * ctx.fft_cell_count);
        ctx.fft_component_stride = ctx.fft_cell_count;
        ctx.fft_components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&ctx.fft_plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(Z2Z, batch=3)", fft_err);
            return false;
        }
        ctx.fft_plan_valid = true;

        fft_err = cufftSetAutoAllocation(ctx.fft_plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(Z2Z, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            ctx.fft_plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_Z2Z,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(Z2Z, batch=3)", fft_err);
            return false;
        }

        ctx.fft_work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&ctx.fft_work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(ctx.fft_plan, ctx.fft_work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(Z2Z, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(ctx.fft_plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(Z2Z, batch=3)", fft_err);
            return false;
        }
    } else {
        size_t bytes = ctx.fft_cell_count * sizeof(cufftComplex);
        cudaError_t err = cudaMalloc(&ctx.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_xyz)", err); return false; }
        auto *base = static_cast<cufftComplex*>(ctx.fft_x);
        ctx.fft_y = base + ctx.fft_cell_count;
        ctx.fft_z = base + (2 * ctx.fft_cell_count);
        ctx.fft_component_stride = ctx.fft_cell_count;
        ctx.fft_components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&ctx.fft_plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(C2C, batch=3)", fft_err);
            return false;
        }
        ctx.fft_plan_valid = true;

        fft_err = cufftSetAutoAllocation(ctx.fft_plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(C2C, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            ctx.fft_plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_C2C,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(C2C, batch=3)", fft_err);
            return false;
        }

        ctx.fft_work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&ctx.fft_work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(ctx.fft_plan, ctx.fft_work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(C2C, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(ctx.fft_plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(C2C, batch=3)", fft_err);
            return false;
        }
    }

    return true;
}

static void free_fft_workspace(Context &ctx) {
    if (ctx.fft_workspace_bound_to_multilayer_cache) {
        unbind_multilayer_fft_workspace(ctx);
        return;
    }
    if (ctx.fft_plan_valid) {
        cufftDestroy(ctx.fft_plan);
        ctx.fft_plan = 0;
        ctx.fft_plan_valid = false;
    }
    if (ctx.fft_work_area) {
        cudaFree(ctx.fft_work_area);
        ctx.fft_work_area = nullptr;
    }
    ctx.fft_work_area_bytes = 0;
    if (ctx.fft_components_share_allocation) {
        if (ctx.fft_x) { cudaFree(ctx.fft_x); }
        ctx.fft_x = nullptr;
        ctx.fft_y = nullptr;
        ctx.fft_z = nullptr;
    } else {
        if (ctx.fft_x) { cudaFree(ctx.fft_x); ctx.fft_x = nullptr; }
        if (ctx.fft_y) { cudaFree(ctx.fft_y); ctx.fft_y = nullptr; }
        if (ctx.fft_z) { cudaFree(ctx.fft_z); ctx.fft_z = nullptr; }
    }
    ctx.fft_cell_count = 0;
    ctx.fft_component_stride = 0;
    ctx.fft_components_share_allocation = false;
}

static bool multilayer_fft_workspace_matches_grid(
    const DeviceMultilayerFftWorkspace &workspace,
    const fullmag_fdm_grid_desc &grid,
    uint64_t cell_count)
{
    return workspace.plan_valid &&
        workspace.fft_x != nullptr &&
        workspace.fft_y != nullptr &&
        workspace.fft_z != nullptr &&
        workspace.fft_grid.nx == grid.nx &&
        workspace.fft_grid.ny == grid.ny &&
        workspace.fft_grid.nz == grid.nz &&
        workspace.cell_count == cell_count;
}

static void bind_multilayer_fft_workspace(
    Context &ctx,
    DeviceMultilayerFftWorkspace &workspace)
{
    ctx.fft_nx = workspace.fft_grid.nx;
    ctx.fft_ny = workspace.fft_grid.ny;
    ctx.fft_nz = workspace.fft_grid.nz;
    ctx.fft_cell_count = workspace.cell_count;
    ctx.fft_component_stride = workspace.component_stride;
    ctx.fft_x = workspace.fft_x;
    ctx.fft_y = workspace.fft_y;
    ctx.fft_z = workspace.fft_z;
    ctx.fft_work_area = workspace.work_area;
    ctx.fft_work_area_bytes = workspace.work_area_bytes;
    ctx.fft_plan = workspace.plan;
    ctx.fft_plan_valid = workspace.plan_valid;
    ctx.fft_components_share_allocation = workspace.components_share_allocation;
    ctx.thin_film_2d_demag = workspace.fft_grid.nz == 1;
    ctx.fft_workspace_bound_to_multilayer_cache = true;
}

static bool alloc_multilayer_fft_workspace(
    Context &ctx,
    DeviceMultilayerFftWorkspace &workspace,
    const fullmag_fdm_grid_desc &grid)
{
    workspace.fft_grid = grid;
    workspace.cell_count = grid_cell_count(grid);

    if (workspace.cell_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = "multilayer demag FFT component stride exceeds cuFFT PlanMany limit";
        return false;
    }

    const bool thin_film = grid.nz == 1;
    const int rank = thin_film ? 2 : 3;
    int dims[3] = {};
    if (thin_film) {
        dims[0] = static_cast<int>(grid.ny);
        dims[1] = static_cast<int>(grid.nx);
    } else {
        dims[0] = static_cast<int>(grid.nz);
        dims[1] = static_cast<int>(grid.ny);
        dims[2] = static_cast<int>(grid.nx);
    }
    int inembed[3] = {dims[0], dims[1], dims[2]};
    int onembed[3] = {dims[0], dims[1], dims[2]};
    const int component_stride = static_cast<int>(workspace.cell_count);

    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        size_t bytes = workspace.cell_count * sizeof(cufftDoubleComplex);
        cudaError_t err = cudaMalloc(&workspace.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_xyz)", err); return false; }
        auto *base = static_cast<cufftDoubleComplex*>(workspace.fft_x);
        workspace.fft_y = base + workspace.cell_count;
        workspace.fft_z = base + (2 * workspace.cell_count);
        workspace.component_stride = workspace.cell_count;
        workspace.components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&workspace.plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }
        workspace.plan_valid = true;

        fft_err = cufftSetAutoAllocation(workspace.plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            workspace.plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_Z2Z,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }

        workspace.work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&workspace.work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(workspace.plan, workspace.work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(workspace.plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(multilayer Z2Z, batch=3)", fft_err);
            return false;
        }
    } else {
        size_t bytes = workspace.cell_count * sizeof(cufftComplex);
        cudaError_t err = cudaMalloc(&workspace.fft_x, bytes * 3);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_xyz)", err); return false; }
        auto *base = static_cast<cufftComplex*>(workspace.fft_x);
        workspace.fft_y = base + workspace.cell_count;
        workspace.fft_z = base + (2 * workspace.cell_count);
        workspace.component_stride = workspace.cell_count;
        workspace.components_share_allocation = true;

        cufftResult fft_err = cufftCreate(&workspace.plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftCreate(multilayer C2C, batch=3)", fft_err);
            return false;
        }
        workspace.plan_valid = true;

        fft_err = cufftSetAutoAllocation(workspace.plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetAutoAllocation(multilayer C2C, batch=3)", fft_err);
            return false;
        }

        size_t work_area_bytes = 0;
        fft_err = cufftMakePlanMany(
            workspace.plan,
            rank,
            dims,
            inembed,
            1,
            component_stride,
            onembed,
            1,
            component_stride,
            CUFFT_C2C,
            3,
            &work_area_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftMakePlanMany(multilayer C2C, batch=3)", fft_err);
            return false;
        }

        workspace.work_area_bytes = static_cast<uint64_t>(work_area_bytes);
        if (work_area_bytes > 0) {
            err = cudaMalloc(&workspace.work_area, work_area_bytes);
            if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMalloc(multilayer_fft_work_area)", err); return false; }
        }
        fft_err = cufftSetWorkArea(workspace.plan, workspace.work_area);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetWorkArea(multilayer C2C, batch=3)", fft_err);
            return false;
        }
        fft_err = cufftSetStream(workspace.plan, context_compute_stream(ctx));
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftSetStream(multilayer C2C, batch=3)", fft_err);
            return false;
        }
    }

    return true;
}

static DeviceMultilayerFftWorkspace *ensure_multilayer_fft_workspace(
    Context &ctx,
    const fullmag_fdm_grid_desc &grid,
    uint64_t cell_count)
{
    for (DeviceMultilayerFftWorkspace &workspace : ctx.multilayer_fft_workspaces) {
        if (multilayer_fft_workspace_matches_grid(workspace, grid, cell_count)) {
            return &workspace;
        }
    }

    if (!ctx.fft_workspace_bound_to_multilayer_cache &&
        (ctx.fft_plan_valid ||
            ctx.fft_x != nullptr ||
            ctx.fft_y != nullptr ||
            ctx.fft_z != nullptr ||
            ctx.fft_work_area != nullptr))
    {
        free_fft_workspace(ctx);
    }

    ctx.multilayer_fft_workspaces.emplace_back();
    DeviceMultilayerFftWorkspace &workspace = ctx.multilayer_fft_workspaces.back();
    if (!alloc_multilayer_fft_workspace(ctx, workspace, grid)) {
        free_multilayer_fft_workspace(workspace);
        ctx.multilayer_fft_workspaces.pop_back();
        return nullptr;
    }
    return &workspace;
}

/* ── Public context functions ── */

bool context_alloc_device(Context &ctx) {
    if (!context_create_compute_stream(ctx)) return false;
    if (!alloc_active_mask(ctx)) return false;
    if (!alloc_sot_active_mask(ctx)) return false;
    if (!alloc_slonczewski_active_mask(ctx)) return false;
    if (!alloc_region_mask(ctx)) return false;
    if (!alloc_exchange_lut(ctx)) return false;
    if (!alloc_reduction_scratch(ctx)) return false;
    if (!alloc_vector_field(ctx, ctx.m))    return false;
    if (!alloc_vector_field(ctx, ctx.h_ex)) return false;
    if (!alloc_vector_field(ctx, ctx.h_demag)) return false;
    if (!alloc_vector_field(ctx, ctx.h_ani)) return false;
    if (!alloc_vector_field(ctx, ctx.k1))   return false;
    if (!alloc_vector_field(ctx, ctx.tmp))  return false;
    if (!alloc_vector_field(ctx, ctx.work)) return false;

    // DP45 / RK23 / RK4: allocate extra stage buffers as needed.
    // DP45 needs k2..k6 + k_fsal; RK23 needs k2, k3, k_fsal; RK4 needs k2, k3, k4.
    // We allocate the union of required buffers per integrator.
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK4) {
        if (!alloc_vector_field(ctx, ctx.k2)) return false;
        if (!alloc_vector_field(ctx, ctx.k3)) return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK4) {
        if (!alloc_vector_field(ctx, ctx.k4)) return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45) {
        if (!alloc_vector_field(ctx, ctx.k5)) return false;
        if (!alloc_vector_field(ctx, ctx.k6)) return false;
    }
    if (ctx.integrator == FULLMAG_FDM_INTEGRATOR_DP45
        || ctx.integrator == FULLMAG_FDM_INTEGRATOR_RK23) {
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
    if (ctx.enable_demag && !ctx.has_demag_tensor_kernel) {
        ctx.last_error =
            "FDM CUDA demag requires validated Newell tensor spectra; automatic native spectrum construction is unavailable";
        return false;
    }

    // Oersted static field buffer
    if (ctx.has_oersted_field) {
        if (!alloc_vector_field(ctx, ctx.h_oe_static)) return false;
    }

    // Zero out working buffers
    size_t bytes = ctx.cell_count * scalar_size(ctx.precision);
    cudaMemset(ctx.h_ex.x, 0, bytes);
    cudaMemset(ctx.h_ex.y, 0, bytes);
    cudaMemset(ctx.h_ex.z, 0, bytes);
    cudaMemset(ctx.h_demag.x, 0, bytes);
    cudaMemset(ctx.h_demag.y, 0, bytes);
    cudaMemset(ctx.h_demag.z, 0, bytes);
    cudaMemset(ctx.h_ani.x, 0, bytes);
    cudaMemset(ctx.h_ani.y, 0, bytes);
    cudaMemset(ctx.h_ani.z, 0, bytes);
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
    context_destroy_compute_stream(ctx);
    free_multilayer_plan_v2(ctx);
    free_vector_field(ctx.m);
    free_vector_field(ctx.h_ex);
    free_vector_field(ctx.h_demag);
    free_vector_field(ctx.h_ani);
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
    // Oersted static field
    free_vector_field(ctx.h_oe_static);
    free_fft_workspace(ctx);
    free_demag_kernel(ctx);
    free_active_mask(ctx);
    free_sot_active_mask(ctx);
    free_slonczewski_active_mask(ctx);
    free_region_mask(ctx);
    free_exchange_lut(ctx);
    free_boundary_correction(ctx);
    free_reduction_scratch(ctx);
    free_preview_download_scratch(ctx);
    free_anisotropy_fields(ctx);
    free_cubic_anisotropy_fields(ctx);
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

bool context_upload_sot_active_mask(Context &ctx, const uint8_t *mask, uint64_t len) {
    if (!ctx.has_sot_active_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "sot_active_mask length mismatch";
        return false;
    }
    const cudaError_t err = cudaMemcpy(
        ctx.sot_active_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(sot_active_mask)", err);
        return false;
    }
    return true;
}

bool context_upload_slonczewski_active_mask(Context &ctx, const uint8_t *mask, uint64_t len) {
    if (!ctx.has_slonczewski_active_mask) {
        return true;
    }
    if (!mask || len != ctx.cell_count) {
        ctx.last_error = "slonczewski_active_mask length mismatch";
        return false;
    }
    const cudaError_t err = cudaMemcpy(
        ctx.slonczewski_active_mask,
        mask,
        ctx.cell_count * sizeof(uint8_t),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaMemcpy(slonczewski_active_mask)", err);
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

bool context_upload_multilayer_plan_v2(
    Context &ctx,
    const fullmag_fdm_multilayer_plan_desc_v2 &plan)
{
    free_multilayer_plan_v2(ctx);
    ctx.has_multilayer_plan_v2 = true;
    ctx.multilayer_layers.reserve(plan.layer_count);
    ctx.multilayer_kernels.reserve(plan.kernel_count);

    auto fail = [&]() -> bool {
        free_multilayer_plan_v2(ctx);
        return false;
    };

    for (uint32_t i = 0; i < plan.layer_count; ++i) {
        const fullmag_fdm_layer_desc_v2 &src = plan.layers[i];
        ctx.multilayer_layers.emplace_back();
        DeviceMultilayerLayer &dst = ctx.multilayer_layers.back();
        dst.native_grid = src.native_grid;
        dst.convolution_grid = src.convolution_grid;
        dst.transfer_kind = src.transfer_kind;
        dst.layer_index = src.layer_index;
        dst.z_offset_cells = src.z_offset_cells;
        dst.material = src.material;
        dst.has_uniaxial_anisotropy = src.has_uniaxial_anisotropy != 0;
        dst.Ku1 = src.uniaxial_anisotropy_constant;
        dst.Ku2 = src.uniaxial_anisotropy_k2;
        dst.anisU[0] = src.anisotropy_axis[0];
        dst.anisU[1] = src.anisotropy_axis[1];
        dst.anisU[2] = src.anisotropy_axis[2];
        dst.has_cubic_anisotropy = src.has_cubic_anisotropy != 0;
        dst.Kc1 = src.cubic_Kc1;
        dst.Kc2 = src.cubic_Kc2;
        dst.Kc3 = src.cubic_Kc3;
        dst.cubic_axis1[0] = src.cubic_axis1[0];
        dst.cubic_axis1[1] = src.cubic_axis1[1];
        dst.cubic_axis1[2] = src.cubic_axis1[2];
        dst.cubic_axis2[0] = src.cubic_axis2[0];
        dst.cubic_axis2[1] = src.cubic_axis2[1];
        dst.cubic_axis2[2] = src.cubic_axis2[2];
        dst.cell_count = grid_cell_count(src.native_grid);
        dst.convolution_cell_count = grid_cell_count(src.convolution_grid);
        dst.has_active_mask = src.active_mask != nullptr;

        if (!alloc_vector_field_cells(ctx, dst.m, dst.cell_count, "multilayer_m")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_ex, dst.cell_count, "multilayer_h_ex")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_demag, dst.cell_count, "multilayer_h_demag")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_dmi, dst.cell_count, "multilayer_h_dmi")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.h_ani, dst.cell_count, "multilayer_h_ani")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.tmp, dst.cell_count, "multilayer_tmp")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k1, dst.cell_count, "multilayer_k1")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k2, dst.cell_count, "multilayer_k2")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k3, dst.cell_count, "multilayer_k3")) {
            return fail();
        }
        if (!alloc_vector_field_cells(ctx, dst.k4, dst.cell_count, "multilayer_k4")) {
            return fail();
        }
        if (!upload_vector_field_aos_f64(
                ctx,
                dst.m,
                src.initial_magnetization_xyz,
                dst.cell_count,
                "cudaMemcpy(multilayer_m)"))
        {
            return fail();
        }
        const size_t layer_bytes = dst.cell_count * scalar_size(ctx.precision);
        cudaError_t zero_err = cudaMemset(dst.h_ex.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ex.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ex.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ex.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ex.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ex.z)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_demag.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_demag.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_demag.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_demag.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_demag.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_demag.z)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_dmi.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_dmi.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_dmi.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_dmi.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_dmi.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_dmi.z)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ani.x, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ani.x)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ani.y, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ani.y)", zero_err);
            return fail();
        }
        zero_err = cudaMemset(dst.h_ani.z, 0, layer_bytes);
        if (zero_err != cudaSuccess) {
            set_cuda_error(ctx, "cudaMemset(multilayer_h_ani.z)", zero_err);
            return fail();
        }
        if (dst.has_active_mask) {
            cudaError_t err = cudaMalloc(
                reinterpret_cast<void **>(&dst.active_mask),
                dst.cell_count * sizeof(uint8_t));
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMalloc(multilayer_active_mask)", err);
                return fail();
            }
            err = cudaMemcpy(
                dst.active_mask,
                src.active_mask,
                dst.cell_count * sizeof(uint8_t),
                cudaMemcpyHostToDevice);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemcpy(multilayer_active_mask)", err);
                return fail();
            }
        }
    }

    for (uint32_t i = 0; i < plan.kernel_count; ++i) {
        const fullmag_fdm_tensor_kernel_desc_v2 &src = plan.kernels[i];
        ctx.multilayer_kernels.emplace_back();
        DeviceMultilayerTensorKernel &dst = ctx.multilayer_kernels.back();
        dst.fft_grid = src.fft_grid;
        dst.dst_layer = src.dst_layer;
        dst.src_layer = src.src_layer;
        dst.z_shift_meters = src.z_shift_meters;
        dst.kernel_len = src.kernel_len;

        if (!alloc_tensor_kernel_cells(ctx, dst.tensor, dst.kernel_len, "multilayer_kernel")) {
            return fail();
        }
        if (!upload_tensor_kernel_component(
                ctx, dst.tensor.xx, src.kernel_xx, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_xx)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.yy, src.kernel_yy, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_yy)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.zz, src.kernel_zz, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_zz)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.xy, src.kernel_xy, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_xy)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.xz, src.kernel_xz, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_xz)") ||
            !upload_tensor_kernel_component(
                ctx, dst.tensor.yz, src.kernel_yz, dst.kernel_len,
                "cudaMemcpy(multilayer_kernel_yz)"))
        {
            return fail();
        }
    }

    if (ctx.enable_demag && !ctx.multilayer_kernels.empty()) {
        for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
            if (!build_and_upload_push_map(ctx, layer)) {
                return fail();
            }
        }
        for (DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
            DeviceMultilayerLayer &dst_layer = ctx.multilayer_layers[kernel.dst_layer];
            if (!build_and_upload_kernel_pull_map(ctx, kernel, dst_layer)) {
                return fail();
            }
        }
    }

    return true;
}

bool context_prepare_multilayer_fft_workspace_v2(Context &ctx) {
    if (!ctx.has_multilayer_plan_v2 || !ctx.enable_demag) {
        return true;
    }
    if (ctx.multilayer_kernels.empty()) {
        ctx.last_error = "multilayer FFT workspace requires at least one tensor kernel";
        return false;
    }

    const DeviceMultilayerTensorKernel &first = ctx.multilayer_kernels.front();
    return context_prepare_multilayer_fft_workspace_for_kernel(ctx, first);
}

bool context_prepare_multilayer_fft_workspace_for_kernel(
    Context &ctx,
    const DeviceMultilayerTensorKernel &kernel)
{
    if (!ctx.has_multilayer_plan_v2 || !ctx.enable_demag) {
        return true;
    }

    if (kernel.kernel_len != grid_cell_count(kernel.fft_grid)) {
        ctx.last_error =
            "multilayer FFT workspace kernel length must match the tensor-kernel grid";
        return false;
    }

    if (!context_create_compute_stream(ctx)) {
        return false;
    }

    if (ctx.fft_workspace_bound_to_multilayer_cache &&
        ctx.fft_plan_valid &&
        ctx.fft_x != nullptr &&
        ctx.fft_y != nullptr &&
        ctx.fft_z != nullptr &&
        ctx.fft_nx == kernel.fft_grid.nx &&
        ctx.fft_ny == kernel.fft_grid.ny &&
        ctx.fft_nz == kernel.fft_grid.nz &&
        ctx.fft_cell_count == kernel.kernel_len)
    {
        return true;
    }

    DeviceMultilayerFftWorkspace *workspace =
        ensure_multilayer_fft_workspace(ctx, kernel.fft_grid, kernel.kernel_len);
    if (!workspace) {
        return false;
    }
    bind_multilayer_fft_workspace(ctx, *workspace);
    return true;
}

/* ── Boundary correction upload ── */

static void free_anisotropy_fields(Context &ctx) {
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

static void free_cubic_anisotropy_fields(Context &ctx) {
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

static void free_boundary_correction(Context &ctx) {
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

/* ── Oersted field precomputation (infinite cylinder, Ampère's law) ──
 *
 * For a z-axis cylinder carrying unit current I = 1 A:
 *   inside  (r < R):  H_phi = r / (2π R²)
 *   outside (r >= R):  H_phi = 1 / (2π r)
 *
 * H_x = -H_phi * sin(phi) = -H_phi * (y - cy) / r
 * H_y = +H_phi * cos(phi) = +H_phi * (x - cx) / r
 * H_z = 0
 *
 * For non-z axes we apply a rotation matrix.
 * The result is stored in h_oe_static for I=1A; at runtime it is scaled
 * by oersted_current * time_envelope(t).
 */
bool context_precompute_oersted_field(Context &ctx) {
    if (!ctx.has_oersted_cylinder) return true;

    uint64_t n = ctx.cell_count;
    double R = ctx.oersted_radius;
    const double center[3] = {
        ctx.oersted_center[0],
        ctx.oersted_center[1],
        ctx.oersted_center[2],
    };
    const double axis_norm = sqrt(
        ctx.oersted_axis[0] * ctx.oersted_axis[0]
        + ctx.oersted_axis[1] * ctx.oersted_axis[1]
        + ctx.oersted_axis[2] * ctx.oersted_axis[2]);

    if (R <= 0.0) {
        ctx.last_error = "oersted_radius must be positive";
        return false;
    }
    if (!isfinite(axis_norm) || axis_norm <= 1e-30) {
        ctx.last_error = "oersted_axis must be finite and nonzero";
        return false;
    }
    const double axis[3] = {
        ctx.oersted_axis[0] / axis_norm,
        ctx.oersted_axis[1] / axis_norm,
        ctx.oersted_axis[2] / axis_norm,
    };

    double inv_2pi = 1.0 / (2.0 * M_PI);
    double R2 = R * R;

    // Compute on host in SoA layout
    std::vector<double> hx(n), hy(n), hz(n);

    for (uint64_t idx = 0; idx < n; ++idx) {
        uint64_t iz = idx / (ctx.ny * ctx.nx);
        uint64_t rem = idx - iz * ctx.ny * ctx.nx;
        uint64_t iy = rem / ctx.nx;
        uint64_t ix = rem - iy * ctx.nx;

        const double rel[3] = {
            (ix + 0.5) * ctx.dx - center[0],
            (iy + 0.5) * ctx.dy - center[1],
            (iz + 0.5) * ctx.dz - center[2],
        };
        const double axial = rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2];
        const double radial[3] = {
            rel[0] - axial * axis[0],
            rel[1] - axial * axis[1],
            rel[2] - axial * axis[2],
        };
        const double r = sqrt(
            radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2]);

        double H_phi;
        if (r < 1e-30) {
            // At exact center, field is zero (by symmetry)
            H_phi = 0.0;
        } else if (r < R) {
            // Inside: H_phi = I * r / (2 * pi * R^2)  for I = 1 A
            H_phi = inv_2pi * r / R2;
        } else {
            // Outside: H_phi = I / (2 * pi * r)  for I = 1 A
            H_phi = inv_2pi / r;
        }

        if (r < 1e-30) {
            hx[idx] = 0.0;
            hy[idx] = 0.0;
            hz[idx] = 0.0;
            continue;
        }
        const double rhat[3] = {radial[0] / r, radial[1] / r, radial[2] / r};
        const double phi_hat[3] = {
            axis[1] * rhat[2] - axis[2] * rhat[1],
            axis[2] * rhat[0] - axis[0] * rhat[2],
            axis[0] * rhat[1] - axis[1] * rhat[0],
        };
        hx[idx] = H_phi * phi_hat[0];
        hy[idx] = H_phi * phi_hat[1];
        hz[idx] = H_phi * phi_hat[2];
    }

    // Upload to device
    size_t bytes = n * scalar_size(ctx.precision);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        cudaError_t err;
        err = cudaMemcpy(ctx.h_oe_static.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_z)", err); return false; }
    } else {
        // Convert to float and upload
        std::vector<float> hx_f(n), hy_f(n), hz_f(n);
        for (uint64_t i = 0; i < n; ++i) {
            hx_f[i] = static_cast<float>(hx[i]);
            hy_f[i] = static_cast<float>(hy[i]);
            hz_f[i] = static_cast<float>(hz[i]);
        }
        cudaError_t err;
        err = cudaMemcpy(ctx.h_oe_static.x, hx_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(h_oe_z)", err); return false; }
    }

    return true;
}

bool context_upload_oersted_field(Context &ctx, const double *field_xyz, uint64_t len) {
    if (!ctx.has_oersted_field || field_xyz == nullptr) {
        return true;
    }
    if (len != ctx.cell_count * 3u) {
        ctx.last_error = "oersted_field_len mismatch";
        return false;
    }

    const uint64_t n = ctx.cell_count;
    std::vector<double> hx(n), hy(n), hz(n);
    for (uint64_t i = 0; i < n; ++i) {
        hx[i] = field_xyz[3u * i + 0];
        hy[i] = field_xyz[3u * i + 1];
        hz[i] = field_xyz[3u * i + 2];
    }

    const size_t bytes = n * scalar_size(ctx.precision);
    cudaError_t err;
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        err = cudaMemcpy(ctx.h_oe_static.x, hx.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_z)", err); return false; }
    } else {
        std::vector<float> hx_f(n), hy_f(n), hz_f(n);
        for (uint64_t i = 0; i < n; ++i) {
            hx_f[i] = static_cast<float>(hx[i]);
            hy_f[i] = static_cast<float>(hy[i]);
            hz_f[i] = static_cast<float>(hz[i]);
        }
        err = cudaMemcpy(ctx.h_oe_static.x, hx_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_x)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.y, hy_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_y)", err); return false; }
        err = cudaMemcpy(ctx.h_oe_static.z, hz_f.data(), bytes, cudaMemcpyHostToDevice);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemcpy(oersted_field_z)", err); return false; }
    }

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
        const bool uploaded = upload_component(ctx.m.x, hx.data(), "cudaMemcpy(m.x)")
            && upload_component(ctx.m.y, hy.data(), "cudaMemcpy(m.y)")
            && upload_component(ctx.m.z, hz.data(), "cudaMemcpy(m.z)");
        if (uploaded) context_reset_integrator_history(ctx);
        return uploaded;
    }

    std::vector<float> hx(n), hy(n), hz(n);
    for (uint64_t i = 0; i < n; i++) {
        bool is_active = !ctx.has_active_mask || ctx.active_mask_host[i] != 0;
        hx[i] = is_active ? static_cast<float>(m_xyz[3 * i + 0]) : 0.0f;
        hy[i] = is_active ? static_cast<float>(m_xyz[3 * i + 1]) : 0.0f;
        hz[i] = is_active ? static_cast<float>(m_xyz[3 * i + 2]) : 0.0f;
    }
    const bool uploaded = upload_component(ctx.m.x, hx.data(), "cudaMemcpy(m.x)")
        && upload_component(ctx.m.y, hy.data(), "cudaMemcpy(m.y)")
        && upload_component(ctx.m.z, hz.data(), "cudaMemcpy(m.z)");
    if (uploaded) context_reset_integrator_history(ctx);
    return uploaded;
}

bool context_upload_magnetization_f64(Context &ctx, const double *m_xyz, uint64_t len) {
    return context_upload_magnetization_impl(ctx, m_xyz, len);
}

bool context_upload_magnetization_f32(Context &ctx, const float *m_xyz, uint64_t len) {
    return context_upload_magnetization_impl(ctx, m_xyz, len);
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

    const bool uploaded = upload_vector_field_aos_host(
        ctx,
        layer.m,
        m_xyz,
        layer.cell_count,
        "cudaMemcpy(multilayer_layer_m)");
    if (uploaded) context_reset_integrator_history(ctx);
    return uploaded;
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
            const double scale = oersted_field_scale(ctx, ctx.current_time);
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
        const double scale = oersted_field_scale(ctx, ctx.current_time);
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
                const double scale = oersted_field_scale(ctx, ctx.current_time);
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
                const float scale = static_cast<float>(oersted_field_scale(ctx, ctx.current_time));
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
        launch_effective_field_fp64(ctx, ctx.current_time);
    } else {
        if (ctx.enable_exchange) {
            launch_exchange_field_fp32(ctx);
        }
        if (ctx.enable_demag) {
            launch_demag_field_fp32(ctx);
        }
        launch_effective_field_fp32(ctx, ctx.current_time);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "context_refresh_observables", err);
        return false;
    }
    return true;
}

bool context_refresh_demag_observable(Context &ctx) {
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        if (ctx.enable_demag) {
            launch_demag_field_fp64(ctx);
        }
    } else {
        if (ctx.enable_demag) {
            launch_demag_field_fp32(ctx);
        }
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "context_refresh_demag_observable", err);
        return false;
    }
    return true;
}

static bool context_refresh_anisotropy_observable(Context &ctx) {
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        launch_anisotropy_field_fp64(ctx);
    } else {
        launch_anisotropy_field_fp32(ctx);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "context_refresh_anisotropy_observable", err);
        return false;
    }
    return true;
}

} // namespace fdm
} // namespace fullmag
