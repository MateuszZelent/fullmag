/*
 * multilayer_convolution.cu - Native CUDA boundary for FDM multilayer demag.
 *
 * This file owns the CUDA-side push_m, tensor multiply, and pull_h boundaries
 * for multilayer convolution. The first executable slice supports identity
 * native/convolution grids using the Context FFT workspace; transfer maps for
 * heterogeneous grids are added behind the same launch functions.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cufft.h>
#include <limits>
#include <string>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);

namespace {

constexpr int BLOCK_SIZE = 256;

__device__ inline cufftDoubleComplex cadd64(cufftDoubleComplex a, cufftDoubleComplex b) {
    return make_cuDoubleComplex(a.x + b.x, a.y + b.y);
}

__device__ inline cufftDoubleComplex cmul64(cufftDoubleComplex a, cufftDoubleComplex b) {
    return make_cuDoubleComplex(
        a.x * b.x - a.y * b.y,
        a.x * b.y + a.y * b.x);
}

__device__ inline cufftDoubleComplex cneg64(cufftDoubleComplex a) {
    return make_cuDoubleComplex(-a.x, -a.y);
}

__device__ inline cufftComplex cadd32(cufftComplex a, cufftComplex b) {
    return make_cuFloatComplex(a.x + b.x, a.y + b.y);
}

__device__ inline cufftComplex cmul32(cufftComplex a, cufftComplex b) {
    return make_cuFloatComplex(
        a.x * b.x - a.y * b.y,
        a.x * b.y + a.y * b.x);
}

__device__ inline cufftComplex cneg32(cufftComplex a) {
    return make_cuFloatComplex(-a.x, -a.y);
}

__global__ void push_multilayer_m_identity_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    uint32_t px,
    uint32_t py,
    uint32_t pz,
    int has_active_mask,
    double ms)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(px) * py * pz;
    if (idx >= total) return;

    uint32_t z = static_cast<uint32_t>(idx / (static_cast<uint64_t>(py) * px));
    uint64_t rem = idx - static_cast<uint64_t>(z) * py * px;
    uint32_t y = static_cast<uint32_t>(rem / px);
    uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * px);

    if (x < nx && y < ny && z < nz) {
        uint64_t src = (static_cast<uint64_t>(z) * ny + y) * nx + x;
        if (!has_active_mask || active_mask[src] != 0) {
            fx[idx] = make_cuDoubleComplex(ms * mx[src], 0.0);
            fy[idx] = make_cuDoubleComplex(ms * my[src], 0.0);
            fz[idx] = make_cuDoubleComplex(ms * mz[src], 0.0);
            return;
        }
    }

    fx[idx] = make_cuDoubleComplex(0.0, 0.0);
    fy[idx] = make_cuDoubleComplex(0.0, 0.0);
    fz[idx] = make_cuDoubleComplex(0.0, 0.0);
}

__global__ void push_multilayer_m_identity_fp32_kernel(
    const float * __restrict__ mx,
    const float * __restrict__ my,
    const float * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    cufftComplex * __restrict__ fx,
    cufftComplex * __restrict__ fy,
    cufftComplex * __restrict__ fz,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    uint32_t px,
    uint32_t py,
    uint32_t pz,
    int has_active_mask,
    float ms)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(px) * py * pz;
    if (idx >= total) return;

    uint32_t z = static_cast<uint32_t>(idx / (static_cast<uint64_t>(py) * px));
    uint64_t rem = idx - static_cast<uint64_t>(z) * py * px;
    uint32_t y = static_cast<uint32_t>(rem / px);
    uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * px);

    if (x < nx && y < ny && z < nz) {
        uint64_t src = (static_cast<uint64_t>(z) * ny + y) * nx + x;
        if (!has_active_mask || active_mask[src] != 0) {
            fx[idx] = make_cuFloatComplex(ms * mx[src], 0.0f);
            fy[idx] = make_cuFloatComplex(ms * my[src], 0.0f);
            fz[idx] = make_cuFloatComplex(ms * mz[src], 0.0f);
            return;
        }
    }

    fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
    fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
    fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
}

__global__ void push_multilayer_m_transfer_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    const uint64_t * __restrict__ push_offsets,
    const uint64_t * __restrict__ push_indices,
    const double * __restrict__ push_weights,
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    uint32_t cx,
    uint32_t cy,
    uint32_t cz,
    uint32_t px,
    uint32_t py,
    uint32_t pz,
    uint64_t push_cell_count,
    int has_active_mask,
    double ms)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(px) * py * pz;
    if (idx >= total) return;

    uint32_t z = static_cast<uint32_t>(idx / (static_cast<uint64_t>(py) * px));
    uint64_t rem = idx - static_cast<uint64_t>(z) * py * px;
    uint32_t y = static_cast<uint32_t>(rem / px);
    uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * px);

    if (x >= cx || y >= cy || z >= cz) {
        fx[idx] = make_cuDoubleComplex(0.0, 0.0);
        fy[idx] = make_cuDoubleComplex(0.0, 0.0);
        fz[idx] = make_cuDoubleComplex(0.0, 0.0);
        return;
    }

    uint64_t conv_idx = (static_cast<uint64_t>(z) * cy + y) * cx + x;
    if (conv_idx >= push_cell_count) {
        fx[idx] = make_cuDoubleComplex(0.0, 0.0);
        fy[idx] = make_cuDoubleComplex(0.0, 0.0);
        fz[idx] = make_cuDoubleComplex(0.0, 0.0);
        return;
    }

    uint64_t begin = push_offsets[conv_idx];
    uint64_t end = push_offsets[conv_idx + 1];
    double total_weight = 0.0;
    double acc_x = 0.0;
    double acc_y = 0.0;
    double acc_z = 0.0;

    for (uint64_t entry = begin; entry < end; ++entry) {
        uint64_t src = push_indices[entry];
        if (has_active_mask && active_mask[src] == 0) continue;

        double weight = push_weights[entry];
        acc_x += mx[src] * weight;
        acc_y += my[src] * weight;
        acc_z += mz[src] * weight;
        total_weight += weight;
    }

    if (total_weight > 0.0) {
        fx[idx] = make_cuDoubleComplex(ms * acc_x / total_weight, 0.0);
        fy[idx] = make_cuDoubleComplex(ms * acc_y / total_weight, 0.0);
        fz[idx] = make_cuDoubleComplex(ms * acc_z / total_weight, 0.0);
    } else {
        fx[idx] = make_cuDoubleComplex(0.0, 0.0);
        fy[idx] = make_cuDoubleComplex(0.0, 0.0);
        fz[idx] = make_cuDoubleComplex(0.0, 0.0);
    }
}

__global__ void push_multilayer_m_transfer_fp32_kernel(
    const float * __restrict__ mx,
    const float * __restrict__ my,
    const float * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    const uint64_t * __restrict__ push_offsets,
    const uint64_t * __restrict__ push_indices,
    const double * __restrict__ push_weights,
    cufftComplex * __restrict__ fx,
    cufftComplex * __restrict__ fy,
    cufftComplex * __restrict__ fz,
    uint32_t cx,
    uint32_t cy,
    uint32_t cz,
    uint32_t px,
    uint32_t py,
    uint32_t pz,
    uint64_t push_cell_count,
    int has_active_mask,
    float ms)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(px) * py * pz;
    if (idx >= total) return;

    uint32_t z = static_cast<uint32_t>(idx / (static_cast<uint64_t>(py) * px));
    uint64_t rem = idx - static_cast<uint64_t>(z) * py * px;
    uint32_t y = static_cast<uint32_t>(rem / px);
    uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * px);

    if (x >= cx || y >= cy || z >= cz) {
        fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
        return;
    }

    uint64_t conv_idx = (static_cast<uint64_t>(z) * cy + y) * cx + x;
    if (conv_idx >= push_cell_count) {
        fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
        return;
    }

    uint64_t begin = push_offsets[conv_idx];
    uint64_t end = push_offsets[conv_idx + 1];
    double total_weight = 0.0;
    double acc_x = 0.0;
    double acc_y = 0.0;
    double acc_z = 0.0;

    for (uint64_t entry = begin; entry < end; ++entry) {
        uint64_t src = push_indices[entry];
        if (has_active_mask && active_mask[src] == 0) continue;

        double weight = push_weights[entry];
        acc_x += static_cast<double>(mx[src]) * weight;
        acc_y += static_cast<double>(my[src]) * weight;
        acc_z += static_cast<double>(mz[src]) * weight;
        total_weight += weight;
    }

    if (total_weight > 0.0) {
        fx[idx] = make_cuFloatComplex(ms * static_cast<float>(acc_x / total_weight), 0.0f);
        fy[idx] = make_cuFloatComplex(ms * static_cast<float>(acc_y / total_weight), 0.0f);
        fz[idx] = make_cuFloatComplex(ms * static_cast<float>(acc_z / total_weight), 0.0f);
    } else {
        fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
    }
}

__global__ void multiply_demag_tensor_kernel_fp64(
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    const cufftDoubleComplex * __restrict__ kxx,
    const cufftDoubleComplex * __restrict__ kyy,
    const cufftDoubleComplex * __restrict__ kzz,
    const cufftDoubleComplex * __restrict__ kxy,
    const cufftDoubleComplex * __restrict__ kxz,
    const cufftDoubleComplex * __restrict__ kyz,
    uint64_t total)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= total) return;

    cufftDoubleComplex mx = fx[idx];
    cufftDoubleComplex my = fy[idx];
    cufftDoubleComplex mz = fz[idx];

    cufftDoubleComplex hx = cneg64(cadd64(cadd64(cmul64(kxx[idx], mx), cmul64(kxy[idx], my)), cmul64(kxz[idx], mz)));
    cufftDoubleComplex hy = cneg64(cadd64(cadd64(cmul64(kxy[idx], mx), cmul64(kyy[idx], my)), cmul64(kyz[idx], mz)));
    cufftDoubleComplex hz = cneg64(cadd64(cadd64(cmul64(kxz[idx], mx), cmul64(kyz[idx], my)), cmul64(kzz[idx], mz)));

    fx[idx] = hx;
    fy[idx] = hy;
    fz[idx] = hz;
}

__global__ void multiply_demag_tensor_kernel_fp32(
    cufftComplex * __restrict__ fx,
    cufftComplex * __restrict__ fy,
    cufftComplex * __restrict__ fz,
    const cufftComplex * __restrict__ kxx,
    const cufftComplex * __restrict__ kyy,
    const cufftComplex * __restrict__ kzz,
    const cufftComplex * __restrict__ kxy,
    const cufftComplex * __restrict__ kxz,
    const cufftComplex * __restrict__ kyz,
    uint64_t total)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= total) return;

    cufftComplex mx = fx[idx];
    cufftComplex my = fy[idx];
    cufftComplex mz = fz[idx];

    cufftComplex hx = cneg32(cadd32(cadd32(cmul32(kxx[idx], mx), cmul32(kxy[idx], my)), cmul32(kxz[idx], mz)));
    cufftComplex hy = cneg32(cadd32(cadd32(cmul32(kxy[idx], mx), cmul32(kyy[idx], my)), cmul32(kyz[idx], mz)));
    cufftComplex hz = cneg32(cadd32(cadd32(cmul32(kxz[idx], mx), cmul32(kyz[idx], my)), cmul32(kzz[idx], mz)));

    fx[idx] = hx;
    fy[idx] = hy;
    fz[idx] = hz;
}

__global__ void pull_multilayer_h_identity_fp64_kernel(
    const cufftDoubleComplex * __restrict__ fx,
    const cufftDoubleComplex * __restrict__ fy,
    const cufftDoubleComplex * __restrict__ fz,
    const uint8_t * __restrict__ active_mask,
    double * __restrict__ hx,
    double * __restrict__ hy,
    double * __restrict__ hz,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    uint32_t px,
    uint32_t py,
    int has_active_mask,
    double normalisation)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    if (idx >= total) return;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0;
        hy[idx] = 0.0;
        hz[idx] = 0.0;
        return;
    }

    uint32_t z = static_cast<uint32_t>(idx / (static_cast<uint64_t>(ny) * nx));
    uint64_t rem = idx - static_cast<uint64_t>(z) * ny * nx;
    uint32_t y = static_cast<uint32_t>(rem / nx);
    uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * nx);
    uint64_t src = (static_cast<uint64_t>(z) * py + y) * px + x;

    hx[idx] += fx[src].x * normalisation;
    hy[idx] += fy[src].x * normalisation;
    hz[idx] += fz[src].x * normalisation;
}

__global__ void pull_multilayer_h_identity_fp32_kernel(
    const cufftComplex * __restrict__ fx,
    const cufftComplex * __restrict__ fy,
    const cufftComplex * __restrict__ fz,
    const uint8_t * __restrict__ active_mask,
    float * __restrict__ hx,
    float * __restrict__ hy,
    float * __restrict__ hz,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    uint32_t px,
    uint32_t py,
    int has_active_mask,
    float normalisation)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    if (idx >= total) return;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0f;
        hy[idx] = 0.0f;
        hz[idx] = 0.0f;
        return;
    }

    uint32_t z = static_cast<uint32_t>(idx / (static_cast<uint64_t>(ny) * nx));
    uint64_t rem = idx - static_cast<uint64_t>(z) * ny * nx;
    uint32_t y = static_cast<uint32_t>(rem / nx);
    uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * nx);
    uint64_t src = (static_cast<uint64_t>(z) * py + y) * px + x;

    hx[idx] += fx[src].x * normalisation;
    hy[idx] += fy[src].x * normalisation;
    hz[idx] += fz[src].x * normalisation;
}

__global__ void pull_multilayer_h_transfer_fp64_kernel(
    const cufftDoubleComplex * __restrict__ fx,
    const cufftDoubleComplex * __restrict__ fy,
    const cufftDoubleComplex * __restrict__ fz,
    const uint64_t * __restrict__ pull_indices,
    const double * __restrict__ pull_weights,
    const uint8_t * __restrict__ active_mask,
    double * __restrict__ hx,
    double * __restrict__ hy,
    double * __restrict__ hz,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    uint64_t pull_cell_count,
    int has_active_mask,
    double normalisation)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    if (idx >= total) return;
    if (idx >= pull_cell_count) return;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0;
        hy[idx] = 0.0;
        hz[idx] = 0.0;
        return;
    }

    double acc_x = 0.0;
    double acc_y = 0.0;
    double acc_z = 0.0;
    uint64_t map_base = idx * 8;
    for (uint32_t corner = 0; corner < 8; ++corner) {
        uint64_t src = pull_indices[map_base + corner];
        double weight = pull_weights[map_base + corner];
        acc_x += fx[src].x * weight;
        acc_y += fy[src].x * weight;
        acc_z += fz[src].x * weight;
    }

    hx[idx] += acc_x * normalisation;
    hy[idx] += acc_y * normalisation;
    hz[idx] += acc_z * normalisation;
}

__global__ void pull_multilayer_h_transfer_fp32_kernel(
    const cufftComplex * __restrict__ fx,
    const cufftComplex * __restrict__ fy,
    const cufftComplex * __restrict__ fz,
    const uint64_t * __restrict__ pull_indices,
    const double * __restrict__ pull_weights,
    const uint8_t * __restrict__ active_mask,
    float * __restrict__ hx,
    float * __restrict__ hy,
    float * __restrict__ hz,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    uint64_t pull_cell_count,
    int has_active_mask,
    float normalisation)
{
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    if (idx >= total) return;
    if (idx >= pull_cell_count) return;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0f;
        hy[idx] = 0.0f;
        hz[idx] = 0.0f;
        return;
    }

    double acc_x = 0.0;
    double acc_y = 0.0;
    double acc_z = 0.0;
    uint64_t map_base = idx * 8;
    for (uint32_t corner = 0; corner < 8; ++corner) {
        uint64_t src = pull_indices[map_base + corner];
        double weight = pull_weights[map_base + corner];
        acc_x += static_cast<double>(fx[src].x) * weight;
        acc_y += static_cast<double>(fy[src].x) * weight;
        acc_z += static_cast<double>(fz[src].x) * weight;
    }

    hx[idx] += static_cast<float>(acc_x) * normalisation;
    hy[idx] += static_cast<float>(acc_y) * normalisation;
    hz[idx] += static_cast<float>(acc_z) * normalisation;
}

bool ensure_launch_size(Context &ctx, uint64_t total, const char *operation) {
    uint64_t blocks = (total + BLOCK_SIZE - 1) / BLOCK_SIZE;
    if (blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = std::string(operation) + ": CUDA grid dimension exceeds int range";
        return false;
    }
    return true;
}

bool same_grid_dimensions(
    const fullmag_fdm_grid_desc &lhs,
    const fullmag_fdm_grid_desc &rhs)
{
    return lhs.nx == rhs.nx && lhs.ny == rhs.ny && lhs.nz == rhs.nz;
}

bool same_grid_cell_size(
    const fullmag_fdm_grid_desc &lhs,
    const fullmag_fdm_grid_desc &rhs)
{
    return lhs.dx == rhs.dx && lhs.dy == rhs.dy && lhs.dz == rhs.dz;
}

bool identity_transfer_supported(
    Context &ctx,
    const DeviceMultilayerLayer &src,
    const DeviceMultilayerLayer &dst,
    const DeviceMultilayerTensorKernel &kernel,
    const char *operation)
{
    if (!same_grid_dimensions(src.native_grid, src.convolution_grid) ||
        !same_grid_cell_size(src.native_grid, src.convolution_grid))
    {
        ctx.last_error = std::string(operation)
            + ": source native grid must match source convolution grid for identity transfer";
        return false;
    }
    if (!same_grid_dimensions(dst.native_grid, dst.convolution_grid) ||
        !same_grid_cell_size(dst.native_grid, dst.convolution_grid))
    {
        ctx.last_error = std::string(operation)
            + ": destination native grid must match destination convolution grid for identity transfer";
        return false;
    }
    if (!same_grid_cell_size(src.convolution_grid, kernel.fft_grid) ||
        !same_grid_cell_size(dst.convolution_grid, kernel.fft_grid))
    {
        ctx.last_error = std::string(operation)
            + ": identity transfer requires convolution-grid cell sizes to match the FFT grid";
        return false;
    }
    if (src.convolution_grid.nx > kernel.fft_grid.nx ||
        src.convolution_grid.ny > kernel.fft_grid.ny ||
        src.convolution_grid.nz > kernel.fft_grid.nz ||
        dst.convolution_grid.nx > kernel.fft_grid.nx ||
        dst.convolution_grid.ny > kernel.fft_grid.ny ||
        dst.convolution_grid.nz > kernel.fft_grid.nz)
    {
        ctx.last_error = std::string(operation)
            + ": identity transfer requires convolution grids to fit inside the FFT grid";
        return false;
    }
    return true;
}

bool source_identity_grid_supported(
    Context &ctx,
    const DeviceMultilayerLayer &src,
    const char *operation)
{
    if (!same_grid_dimensions(src.native_grid, src.convolution_grid) ||
        !same_grid_cell_size(src.native_grid, src.convolution_grid))
    {
        ctx.last_error = std::string(operation)
            + ": source native grid must match source convolution grid for identity transfer";
        return false;
    }
    return true;
}

bool destination_identity_grid_supported(
    Context &ctx,
    const DeviceMultilayerLayer &dst,
    const char *operation)
{
    if (!same_grid_dimensions(dst.native_grid, dst.convolution_grid) ||
        !same_grid_cell_size(dst.native_grid, dst.convolution_grid))
    {
        ctx.last_error = std::string(operation)
            + ": destination native grid must match destination convolution grid for identity transfer";
        return false;
    }
    return true;
}

bool convolution_grid_supported(
    Context &ctx,
    const DeviceMultilayerLayer &src,
    const DeviceMultilayerLayer &dst,
    const DeviceMultilayerTensorKernel &kernel,
    const char *operation)
{
    if (!same_grid_cell_size(src.convolution_grid, kernel.fft_grid) ||
        !same_grid_cell_size(dst.convolution_grid, kernel.fft_grid))
    {
        ctx.last_error = std::string(operation)
            + ": multilayer transfer requires convolution-grid cell sizes to match the FFT grid";
        return false;
    }
    if (src.convolution_grid.nx > kernel.fft_grid.nx ||
        src.convolution_grid.ny > kernel.fft_grid.ny ||
        src.convolution_grid.nz > kernel.fft_grid.nz ||
        dst.convolution_grid.nx > kernel.fft_grid.nx ||
        dst.convolution_grid.ny > kernel.fft_grid.ny ||
        dst.convolution_grid.nz > kernel.fft_grid.nz)
    {
        ctx.last_error = std::string(operation)
            + ": multilayer transfer requires convolution grids to fit inside the FFT grid";
        return false;
    }
    return true;
}

bool source_push_map_supported(
    Context &ctx,
    const DeviceMultilayerLayer &src,
    const char *operation)
{
    if (src.push_map.cell_count != src.convolution_cell_count ||
        src.push_map.offsets == nullptr ||
        (src.push_map.entry_count > 0 &&
            (src.push_map.indices == nullptr || src.push_map.weights == nullptr)))
    {
        ctx.last_error = std::string(operation)
            + ": source push_pull transfer map is not initialized";
        return false;
    }
    return true;
}

bool destination_pull_map_supported(
    Context &ctx,
    const DeviceMultilayerLayer &dst,
    const DeviceMultilayerTensorKernel &kernel,
    const char *operation)
{
    if (kernel.dst_pull_map.cell_count != dst.cell_count ||
        (kernel.dst_pull_map.cell_count > 0 &&
            (kernel.dst_pull_map.indices == nullptr || kernel.dst_pull_map.weights == nullptr)))
    {
        ctx.last_error = std::string(operation)
            + ": destination push_pull transfer map is not initialized for the tensor-kernel FFT grid";
        return false;
    }
    return true;
}

bool transfer_supported(
    Context &ctx,
    const DeviceMultilayerLayer &src,
    const DeviceMultilayerLayer &dst,
    const DeviceMultilayerTensorKernel &kernel,
    const char *operation)
{
    const bool src_supported =
        src.transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY ||
        src.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL;
    const bool dst_supported =
        dst.transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY ||
        dst.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL;
    if (!src_supported || !dst_supported)
    {
        ctx.last_error = std::string(operation)
            + ": unsupported native multilayer transfer kind";
        return false;
    }
    if (src.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL &&
        !source_push_map_supported(ctx, src, operation))
    {
        return false;
    }
    if (dst.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL &&
        !destination_pull_map_supported(ctx, dst, kernel, operation))
    {
        return false;
    }
    if (src.transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY &&
        dst.transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY)
    {
        return identity_transfer_supported(ctx, src, dst, kernel, operation);
    }
    if (src.transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY &&
        !source_identity_grid_supported(ctx, src, operation))
    {
        return false;
    }
    if (dst.transfer_kind == FULLMAG_FDM_TRANSFER_IDENTITY &&
        !destination_identity_grid_supported(ctx, dst, operation))
    {
        return false;
    }
    return convolution_grid_supported(ctx, src, dst, kernel, operation);
}

bool zero_layer_h_demag_fp64(Context &ctx, cudaStream_t stream) {
    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        const size_t bytes = static_cast<size_t>(layer.cell_count) * sizeof(double);
        cudaError_t err = cudaMemsetAsync(layer.h_demag.x, 0, bytes, stream);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemsetAsync(multilayer_h_demag.x)", err); return false; }
        err = cudaMemsetAsync(layer.h_demag.y, 0, bytes, stream);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemsetAsync(multilayer_h_demag.y)", err); return false; }
        err = cudaMemsetAsync(layer.h_demag.z, 0, bytes, stream);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemsetAsync(multilayer_h_demag.z)", err); return false; }
    }
    return true;
}

bool zero_layer_h_demag_fp32(Context &ctx, cudaStream_t stream) {
    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        const size_t bytes = static_cast<size_t>(layer.cell_count) * sizeof(float);
        cudaError_t err = cudaMemsetAsync(layer.h_demag.x, 0, bytes, stream);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemsetAsync(multilayer_h_demag.x)", err); return false; }
        err = cudaMemsetAsync(layer.h_demag.y, 0, bytes, stream);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemsetAsync(multilayer_h_demag.y)", err); return false; }
        err = cudaMemsetAsync(layer.h_demag.z, 0, bytes, stream);
        if (err != cudaSuccess) { set_cuda_error(ctx, "cudaMemsetAsync(multilayer_h_demag.z)", err); return false; }
    }
    return true;
}

} // namespace

void launch_multilayer_demag_field_fp64(Context &ctx) {
    if (!ctx.enable_demag || ctx.multilayer_kernels.empty()) {
        return;
    }
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "launch_multilayer_demag_field_fp64 requires a staged v2 multilayer plan";
        return;
    }
    if (!context_begin_compute_stream_work(ctx, "launch_multilayer_demag_field_fp64")) {
        return;
    }

    cudaStream_t stream = context_compute_stream(ctx);
    if (!zero_layer_h_demag_fp64(ctx, stream)) {
        context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp64");
        return;
    }

    for (const DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
        if (kernel.src_layer >= ctx.multilayer_layers.size() ||
            kernel.dst_layer >= ctx.multilayer_layers.size())
        {
            ctx.last_error = "launch_multilayer_demag_field_fp64: kernel layer index out of range";
            break;
        }
        if (!context_prepare_multilayer_fft_workspace_for_kernel(ctx, kernel)) {
            break;
        }

        const DeviceMultilayerLayer &src = ctx.multilayer_layers[kernel.src_layer];
        DeviceMultilayerLayer &dst = ctx.multilayer_layers[kernel.dst_layer];
        if (!transfer_supported(ctx, src, dst, kernel, "launch_multilayer_demag_field_fp64") ||
            !ensure_launch_size(ctx, kernel.kernel_len, "launch_multilayer_demag_field_fp64") ||
            !ensure_launch_size(ctx, dst.cell_count, "launch_multilayer_demag_field_fp64"))
        {
            break;
        }

        const int grid_padded =
            static_cast<int>((kernel.kernel_len + BLOCK_SIZE - 1) / BLOCK_SIZE);
        const int grid_dst =
            static_cast<int>((dst.cell_count + BLOCK_SIZE - 1) / BLOCK_SIZE);

        if (src.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL) {
            push_multilayer_m_transfer_fp64_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
                static_cast<const double*>(src.m.x),
                static_cast<const double*>(src.m.y),
                static_cast<const double*>(src.m.z),
                src.active_mask,
                src.push_map.offsets,
                src.push_map.indices,
                src.push_map.weights,
                static_cast<cufftDoubleComplex*>(ctx.fft_x),
                static_cast<cufftDoubleComplex*>(ctx.fft_y),
                static_cast<cufftDoubleComplex*>(ctx.fft_z),
                src.convolution_grid.nx,
                src.convolution_grid.ny,
                src.convolution_grid.nz,
                kernel.fft_grid.nx,
                kernel.fft_grid.ny,
                kernel.fft_grid.nz,
                src.push_map.cell_count,
                src.has_active_mask ? 1 : 0,
                src.material.saturation_magnetisation);
        } else {
            push_multilayer_m_identity_fp64_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
                static_cast<const double*>(src.m.x),
                static_cast<const double*>(src.m.y),
                static_cast<const double*>(src.m.z),
                src.active_mask,
                static_cast<cufftDoubleComplex*>(ctx.fft_x),
                static_cast<cufftDoubleComplex*>(ctx.fft_y),
                static_cast<cufftDoubleComplex*>(ctx.fft_z),
                src.native_grid.nx,
                src.native_grid.ny,
                src.native_grid.nz,
                kernel.fft_grid.nx,
                kernel.fft_grid.ny,
                kernel.fft_grid.nz,
                src.has_active_mask ? 1 : 0,
                src.material.saturation_magnetisation);
        }

        cufftResult fft_err = cufftExecZ2Z(
            ctx.fft_plan,
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer forward x)", fft_err);
            break;
        }
        fft_err = cufftExecZ2Z(
            ctx.fft_plan,
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer forward y)", fft_err);
            break;
        }
        fft_err = cufftExecZ2Z(
            ctx.fft_plan,
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer forward z)", fft_err);
            break;
        }

        multiply_demag_tensor_kernel_fp64<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            static_cast<const cufftDoubleComplex*>(kernel.tensor.xx),
            static_cast<const cufftDoubleComplex*>(kernel.tensor.yy),
            static_cast<const cufftDoubleComplex*>(kernel.tensor.zz),
            static_cast<const cufftDoubleComplex*>(kernel.tensor.xy),
            static_cast<const cufftDoubleComplex*>(kernel.tensor.xz),
            static_cast<const cufftDoubleComplex*>(kernel.tensor.yz),
            kernel.kernel_len);

        fft_err = cufftExecZ2Z(
            ctx.fft_plan,
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            CUFFT_INVERSE);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer inverse x)", fft_err);
            break;
        }
        fft_err = cufftExecZ2Z(
            ctx.fft_plan,
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            CUFFT_INVERSE);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer inverse y)", fft_err);
            break;
        }
        fft_err = cufftExecZ2Z(
            ctx.fft_plan,
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            CUFFT_INVERSE);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer inverse z)", fft_err);
            break;
        }

        if (dst.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL) {
            pull_multilayer_h_transfer_fp64_kernel<<<grid_dst, BLOCK_SIZE, 0, stream>>>(
                static_cast<const cufftDoubleComplex*>(ctx.fft_x),
                static_cast<const cufftDoubleComplex*>(ctx.fft_y),
                static_cast<const cufftDoubleComplex*>(ctx.fft_z),
                kernel.dst_pull_map.indices,
                kernel.dst_pull_map.weights,
                dst.active_mask,
                static_cast<double*>(dst.h_demag.x),
                static_cast<double*>(dst.h_demag.y),
                static_cast<double*>(dst.h_demag.z),
                dst.native_grid.nx,
                dst.native_grid.ny,
                dst.native_grid.nz,
                kernel.dst_pull_map.cell_count,
                dst.has_active_mask ? 1 : 0,
                1.0 / static_cast<double>(kernel.kernel_len));
        } else {
            pull_multilayer_h_identity_fp64_kernel<<<grid_dst, BLOCK_SIZE, 0, stream>>>(
                static_cast<const cufftDoubleComplex*>(ctx.fft_x),
                static_cast<const cufftDoubleComplex*>(ctx.fft_y),
                static_cast<const cufftDoubleComplex*>(ctx.fft_z),
                dst.active_mask,
                static_cast<double*>(dst.h_demag.x),
                static_cast<double*>(dst.h_demag.y),
                static_cast<double*>(dst.h_demag.z),
                dst.native_grid.nx,
                dst.native_grid.ny,
                dst.native_grid.nz,
                kernel.fft_grid.nx,
                kernel.fft_grid.ny,
                dst.has_active_mask ? 1 : 0,
                1.0 / static_cast<double>(kernel.kernel_len));
        }
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "launch_multilayer_demag_field_fp64", err);
    }
    context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp64");
}

void launch_multilayer_demag_field_fp32(Context &ctx) {
    if (!ctx.enable_demag || ctx.multilayer_kernels.empty()) {
        return;
    }
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "launch_multilayer_demag_field_fp32 requires a staged v2 multilayer plan";
        return;
    }
    if (!context_begin_compute_stream_work(ctx, "launch_multilayer_demag_field_fp32")) {
        return;
    }

    cudaStream_t stream = context_compute_stream(ctx);
    if (!zero_layer_h_demag_fp32(ctx, stream)) {
        context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp32");
        return;
    }

    for (const DeviceMultilayerTensorKernel &kernel : ctx.multilayer_kernels) {
        if (kernel.src_layer >= ctx.multilayer_layers.size() ||
            kernel.dst_layer >= ctx.multilayer_layers.size())
        {
            ctx.last_error = "launch_multilayer_demag_field_fp32: kernel layer index out of range";
            break;
        }
        if (!context_prepare_multilayer_fft_workspace_for_kernel(ctx, kernel)) {
            break;
        }

        const DeviceMultilayerLayer &src = ctx.multilayer_layers[kernel.src_layer];
        DeviceMultilayerLayer &dst = ctx.multilayer_layers[kernel.dst_layer];
        if (!transfer_supported(ctx, src, dst, kernel, "launch_multilayer_demag_field_fp32") ||
            !ensure_launch_size(ctx, kernel.kernel_len, "launch_multilayer_demag_field_fp32") ||
            !ensure_launch_size(ctx, dst.cell_count, "launch_multilayer_demag_field_fp32"))
        {
            break;
        }

        const int grid_padded =
            static_cast<int>((kernel.kernel_len + BLOCK_SIZE - 1) / BLOCK_SIZE);
        const int grid_dst =
            static_cast<int>((dst.cell_count + BLOCK_SIZE - 1) / BLOCK_SIZE);

        if (src.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL) {
            push_multilayer_m_transfer_fp32_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
                static_cast<const float*>(src.m.x),
                static_cast<const float*>(src.m.y),
                static_cast<const float*>(src.m.z),
                src.active_mask,
                src.push_map.offsets,
                src.push_map.indices,
                src.push_map.weights,
                static_cast<cufftComplex*>(ctx.fft_x),
                static_cast<cufftComplex*>(ctx.fft_y),
                static_cast<cufftComplex*>(ctx.fft_z),
                src.convolution_grid.nx,
                src.convolution_grid.ny,
                src.convolution_grid.nz,
                kernel.fft_grid.nx,
                kernel.fft_grid.ny,
                kernel.fft_grid.nz,
                src.push_map.cell_count,
                src.has_active_mask ? 1 : 0,
                static_cast<float>(src.material.saturation_magnetisation));
        } else {
            push_multilayer_m_identity_fp32_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
                static_cast<const float*>(src.m.x),
                static_cast<const float*>(src.m.y),
                static_cast<const float*>(src.m.z),
                src.active_mask,
                static_cast<cufftComplex*>(ctx.fft_x),
                static_cast<cufftComplex*>(ctx.fft_y),
                static_cast<cufftComplex*>(ctx.fft_z),
                src.native_grid.nx,
                src.native_grid.ny,
                src.native_grid.nz,
                kernel.fft_grid.nx,
                kernel.fft_grid.ny,
                kernel.fft_grid.nz,
                src.has_active_mask ? 1 : 0,
                static_cast<float>(src.material.saturation_magnetisation));
        }

        cufftResult fft_err = cufftExecC2C(
            ctx.fft_plan,
            static_cast<cufftComplex*>(ctx.fft_x),
            static_cast<cufftComplex*>(ctx.fft_x),
            CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer forward x)", fft_err);
            break;
        }
        fft_err = cufftExecC2C(
            ctx.fft_plan,
            static_cast<cufftComplex*>(ctx.fft_y),
            static_cast<cufftComplex*>(ctx.fft_y),
            CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer forward y)", fft_err);
            break;
        }
        fft_err = cufftExecC2C(
            ctx.fft_plan,
            static_cast<cufftComplex*>(ctx.fft_z),
            static_cast<cufftComplex*>(ctx.fft_z),
            CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer forward z)", fft_err);
            break;
        }

        multiply_demag_tensor_kernel_fp32<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
            static_cast<cufftComplex*>(ctx.fft_x),
            static_cast<cufftComplex*>(ctx.fft_y),
            static_cast<cufftComplex*>(ctx.fft_z),
            static_cast<const cufftComplex*>(kernel.tensor.xx),
            static_cast<const cufftComplex*>(kernel.tensor.yy),
            static_cast<const cufftComplex*>(kernel.tensor.zz),
            static_cast<const cufftComplex*>(kernel.tensor.xy),
            static_cast<const cufftComplex*>(kernel.tensor.xz),
            static_cast<const cufftComplex*>(kernel.tensor.yz),
            kernel.kernel_len);

        fft_err = cufftExecC2C(
            ctx.fft_plan,
            static_cast<cufftComplex*>(ctx.fft_x),
            static_cast<cufftComplex*>(ctx.fft_x),
            CUFFT_INVERSE);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer inverse x)", fft_err);
            break;
        }
        fft_err = cufftExecC2C(
            ctx.fft_plan,
            static_cast<cufftComplex*>(ctx.fft_y),
            static_cast<cufftComplex*>(ctx.fft_y),
            CUFFT_INVERSE);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer inverse y)", fft_err);
            break;
        }
        fft_err = cufftExecC2C(
            ctx.fft_plan,
            static_cast<cufftComplex*>(ctx.fft_z),
            static_cast<cufftComplex*>(ctx.fft_z),
            CUFFT_INVERSE);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer inverse z)", fft_err);
            break;
        }

        if (dst.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL) {
            pull_multilayer_h_transfer_fp32_kernel<<<grid_dst, BLOCK_SIZE, 0, stream>>>(
                static_cast<const cufftComplex*>(ctx.fft_x),
                static_cast<const cufftComplex*>(ctx.fft_y),
                static_cast<const cufftComplex*>(ctx.fft_z),
                kernel.dst_pull_map.indices,
                kernel.dst_pull_map.weights,
                dst.active_mask,
                static_cast<float*>(dst.h_demag.x),
                static_cast<float*>(dst.h_demag.y),
                static_cast<float*>(dst.h_demag.z),
                dst.native_grid.nx,
                dst.native_grid.ny,
                dst.native_grid.nz,
                kernel.dst_pull_map.cell_count,
                dst.has_active_mask ? 1 : 0,
                1.0f / static_cast<float>(kernel.kernel_len));
        } else {
            pull_multilayer_h_identity_fp32_kernel<<<grid_dst, BLOCK_SIZE, 0, stream>>>(
                static_cast<const cufftComplex*>(ctx.fft_x),
                static_cast<const cufftComplex*>(ctx.fft_y),
                static_cast<const cufftComplex*>(ctx.fft_z),
                dst.active_mask,
                static_cast<float*>(dst.h_demag.x),
                static_cast<float*>(dst.h_demag.y),
                static_cast<float*>(dst.h_demag.z),
                dst.native_grid.nx,
                dst.native_grid.ny,
                dst.native_grid.nz,
                kernel.fft_grid.nx,
                kernel.fft_grid.ny,
                dst.has_active_mask ? 1 : 0,
                1.0f / static_cast<float>(kernel.kernel_len));
        }
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "launch_multilayer_demag_field_fp32", err);
    }
    context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp32");
}

} // namespace fdm
} // namespace fullmag
