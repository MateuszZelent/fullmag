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

__global__ void accumulate_demag_tensor_kernel_fp64(
    const cufftDoubleComplex * __restrict__ source_x,
    const cufftDoubleComplex * __restrict__ source_y,
    const cufftDoubleComplex * __restrict__ source_z,
    cufftDoubleComplex * __restrict__ destination_x,
    cufftDoubleComplex * __restrict__ destination_y,
    cufftDoubleComplex * __restrict__ destination_z,
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

    cufftDoubleComplex mx = source_x[idx];
    cufftDoubleComplex my = source_y[idx];
    cufftDoubleComplex mz = source_z[idx];
    cufftDoubleComplex hx = cneg64(cadd64(
        cadd64(cmul64(kxx[idx], mx), cmul64(kxy[idx], my)),
        cmul64(kxz[idx], mz)));
    cufftDoubleComplex hy = cneg64(cadd64(
        cadd64(cmul64(kxy[idx], mx), cmul64(kyy[idx], my)),
        cmul64(kyz[idx], mz)));
    cufftDoubleComplex hz = cneg64(cadd64(
        cadd64(cmul64(kxz[idx], mx), cmul64(kyz[idx], my)),
        cmul64(kzz[idx], mz)));

    destination_x[idx] = cadd64(destination_x[idx], hx);
    destination_y[idx] = cadd64(destination_y[idx], hy);
    destination_z[idx] = cadd64(destination_z[idx], hz);
}

__global__ void accumulate_demag_tensor_kernel_fp32(
    const cufftComplex * __restrict__ source_x,
    const cufftComplex * __restrict__ source_y,
    const cufftComplex * __restrict__ source_z,
    cufftComplex * __restrict__ destination_x,
    cufftComplex * __restrict__ destination_y,
    cufftComplex * __restrict__ destination_z,
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

    cufftComplex mx = source_x[idx];
    cufftComplex my = source_y[idx];
    cufftComplex mz = source_z[idx];
    cufftComplex hx = cneg32(cadd32(
        cadd32(cmul32(kxx[idx], mx), cmul32(kxy[idx], my)),
        cmul32(kxz[idx], mz)));
    cufftComplex hy = cneg32(cadd32(
        cadd32(cmul32(kxy[idx], mx), cmul32(kyy[idx], my)),
        cmul32(kyz[idx], mz)));
    cufftComplex hz = cneg32(cadd32(
        cadd32(cmul32(kxz[idx], mx), cmul32(kyz[idx], my)),
        cmul32(kzz[idx], mz)));

    destination_x[idx] = cadd32(destination_x[idx], hx);
    destination_y[idx] = cadd32(destination_y[idx], hy);
    destination_z[idx] = cadd32(destination_z[idx], hz);
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

bool check_kernel_launch(Context &ctx, const char *operation) {
    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        return false;
    }
    return true;
}

const DeviceMultilayerTensorKernel *find_multilayer_tensor_kernel(
    const Context &ctx,
    uint32_t dst_layer,
    uint32_t src_layer)
{
    for (size_t index = 0; index < ctx.multilayer_kernels.size(); ++index) {
        const DeviceMultilayerTensorKernel &kernel = ctx.multilayer_kernels[index];
        if (kernel.dst_layer == dst_layer && kernel.src_layer == src_layer) {
            return &kernel;
        }
    }
    return nullptr;
}

bool classify_multilayer_batch_plan(
    Context &ctx,
    const char *operation,
    bool &use_batched)
{
    use_batched = false;
    if (ctx.multilayer_layers.empty() || ctx.multilayer_kernels.empty()) {
        return true;
    }

    bool has_push_pull = false;
    for (const DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        if (layer.transfer_kind == FULLMAG_FDM_TRANSFER_PUSH_PULL) {
            has_push_pull = true;
        } else if (layer.transfer_kind != FULLMAG_FDM_TRANSFER_IDENTITY) {
            ctx.last_error = std::string(operation) +
                ": unsupported multilayer transfer kind; refusing native refresh";
            return false;
        }
    }
    if (has_push_pull) {
        // The existing pair-wise path is kept for the explicit assisted
        // transfer lane.  It is never labelled device-resident by the runner.
        return true;
    }

    if (ctx.periodic_x || ctx.periodic_y || ctx.periodic_z) {
        ctx.last_error = std::string(operation) +
            ": periodic multilayer demag is not supported by the D-07 native lane";
        return false;
    }

    const uint64_t layer_count = ctx.multilayer_layers.size();
    if (layer_count > std::numeric_limits<uint32_t>::max()) {
        ctx.last_error = std::string(operation) +
            ": D-07 native refresh layer count exceeds uint32";
        return false;
    }
    const uint64_t expected_kernel_count = layer_count * layer_count;
    if (ctx.multilayer_kernels.size() != expected_kernel_count) {
        ctx.last_error = std::string(operation) +
            ": D-07 native refresh requires exactly L^2 tensor kernels";
        return false;
    }
    if (ctx.multilayer_batch_component_stride >
            std::numeric_limits<uint64_t>::max() / 3u ||
        ctx.multilayer_batch_layer_count != layer_count ||
        ctx.multilayer_batch_component_stride == 0 ||
        ctx.multilayer_batch_layer_stride != ctx.multilayer_batch_component_stride * 3u ||
        ctx.multilayer_batch_source_fft_x == nullptr ||
        ctx.multilayer_batch_source_fft_y == nullptr ||
        ctx.multilayer_batch_source_fft_z == nullptr ||
        ctx.multilayer_batch_destination_fft_x == nullptr ||
        ctx.multilayer_batch_destination_fft_y == nullptr ||
        ctx.multilayer_batch_destination_fft_z == nullptr ||
        !ctx.fft_plan_valid)
    {
        ctx.last_error = std::string(operation) +
            ": D-07 device-resident spectra were not prepared before refresh";
        return false;
    }

    const DeviceMultilayerLayer &first_layer = ctx.multilayer_layers.front();
    if (!same_grid_dimensions(first_layer.native_grid, first_layer.convolution_grid) ||
        !same_grid_cell_size(first_layer.native_grid, first_layer.convolution_grid))
    {
        ctx.last_error = std::string(operation) +
            ": D-07 native refresh requires identity native/convolution grids";
        return false;
    }
    for (const DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        if (!same_grid_dimensions(layer.native_grid, first_layer.native_grid) ||
            !same_grid_cell_size(layer.native_grid, first_layer.native_grid) ||
            !same_grid_dimensions(layer.convolution_grid, first_layer.convolution_grid) ||
            !same_grid_cell_size(layer.convolution_grid, first_layer.convolution_grid))
        {
            ctx.last_error = std::string(operation) +
                ": D-07 native refresh requires one common identity layer grid";
            return false;
        }
    }

    const DeviceMultilayerTensorKernel &first_kernel = ctx.multilayer_kernels.front();
    if (!ensure_launch_size(
            ctx, ctx.multilayer_batch_component_stride, operation) ||
        !ensure_launch_size(ctx, first_layer.cell_count, operation))
    {
        return false;
    }
    if (first_kernel.kernel_len != ctx.multilayer_batch_component_stride ||
        first_layer.native_grid.nx > first_kernel.fft_grid.nx ||
        first_layer.native_grid.ny > first_kernel.fft_grid.ny ||
        first_layer.native_grid.nz > first_kernel.fft_grid.nz ||
        !same_grid_cell_size(first_layer.native_grid, first_kernel.fft_grid))
    {
        ctx.last_error = std::string(operation) +
            ": D-07 native refresh requires one common padded FFT grid";
        return false;
    }

    std::vector<uint8_t> seen(expected_kernel_count, 0);
    for (size_t index = 0; index < ctx.multilayer_kernels.size(); ++index) {
        const DeviceMultilayerTensorKernel &kernel = ctx.multilayer_kernels[index];
        if (kernel.src_layer >= layer_count || kernel.dst_layer >= layer_count ||
            kernel.kernel_len != ctx.multilayer_batch_component_stride ||
            !same_grid_dimensions(kernel.fft_grid, first_kernel.fft_grid) ||
            !same_grid_cell_size(kernel.fft_grid, first_kernel.fft_grid) ||
            kernel.tensor.xx == nullptr || kernel.tensor.yy == nullptr ||
            kernel.tensor.zz == nullptr || kernel.tensor.xy == nullptr ||
            kernel.tensor.xz == nullptr || kernel.tensor.yz == nullptr)
        {
            ctx.last_error = std::string(operation) +
                ": D-07 native refresh rejected an invalid tensor descriptor";
            return false;
        }
        const uint64_t pair = static_cast<uint64_t>(kernel.dst_layer) * layer_count +
            kernel.src_layer;
        if (seen[pair] != 0) {
            ctx.last_error = std::string(operation) +
                ": D-07 native refresh rejected a duplicate tensor pair";
            return false;
        }
        seen[pair] = 1;
    }
    for (uint8_t pair_seen : seen) {
        if (pair_seen == 0) {
            ctx.last_error = std::string(operation) +
                ": D-07 native refresh rejected an incomplete tensor pair catalog";
            return false;
        }
    }
    use_batched = true;
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

void launch_multilayer_demag_field_fp64_batched(Context &ctx) {
    if (!context_begin_compute_stream_work(ctx, "launch_multilayer_demag_field_fp64_batched")) {
        return;
    }
    cudaStream_t stream = context_compute_stream(ctx);
    const uint64_t layer_count = ctx.multilayer_layers.size();
    const uint64_t component_stride = ctx.multilayer_batch_component_stride;
    const uint64_t layer_stride = ctx.multilayer_batch_layer_stride;
    const fullmag_fdm_grid_desc &fft_grid = ctx.multilayer_kernels.front().fft_grid;
    const int grid_padded = static_cast<int>((component_stride + BLOCK_SIZE - 1) / BLOCK_SIZE);
    ctx.multilayer_demag_stage_counters.begin_refresh(layer_count);
    if (!zero_layer_h_demag_fp64(ctx, stream)) {
        context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp64_batched");
        return;
    }

    for (uint32_t src_index = 0; src_index < layer_count; ++src_index) {
        const DeviceMultilayerLayer &src = ctx.multilayer_layers[src_index];
        auto *source_x = static_cast<cufftDoubleComplex *>(ctx.multilayer_batch_source_fft_x) +
            static_cast<uint64_t>(src_index) * layer_stride;
        auto *source_y = static_cast<cufftDoubleComplex *>(ctx.multilayer_batch_source_fft_y) +
            static_cast<uint64_t>(src_index) * layer_stride;
        auto *source_z = static_cast<cufftDoubleComplex *>(ctx.multilayer_batch_source_fft_z) +
            static_cast<uint64_t>(src_index) * layer_stride;

        push_multilayer_m_identity_fp64_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
            static_cast<const double *>(src.m.x),
            static_cast<const double *>(src.m.y),
            static_cast<const double *>(src.m.z),
            src.active_mask,
            source_x,
            source_y,
            source_z,
            src.native_grid.nx,
            src.native_grid.ny,
            src.native_grid.nz,
            fft_grid.nx,
            fft_grid.ny,
            fft_grid.nz,
            src.has_active_mask ? 1 : 0,
            src.material.saturation_magnetisation);
        if (!check_kernel_launch(ctx, "launch_multilayer_demag_field_fp64_batched(push)")) {
            break;
        }

        cufftResult fft_err = cufftExecZ2Z(
            ctx.fft_plan, source_x, source_x, CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer batched forward)", fft_err);
            break;
        }
        ctx.multilayer_demag_stage_counters.note_forward_fft();
    }

    if (ctx.last_error.empty()) {
        for (uint32_t dst_index = 0; dst_index < layer_count; ++dst_index) {
            const DeviceMultilayerLayer &dst = ctx.multilayer_layers[dst_index];
            auto *destination_x = static_cast<cufftDoubleComplex *>(ctx.multilayer_batch_destination_fft_x) +
                static_cast<uint64_t>(dst_index) * layer_stride;
            auto *destination_y = static_cast<cufftDoubleComplex *>(ctx.multilayer_batch_destination_fft_y) +
                static_cast<uint64_t>(dst_index) * layer_stride;
            auto *destination_z = static_cast<cufftDoubleComplex *>(ctx.multilayer_batch_destination_fft_z) +
                static_cast<uint64_t>(dst_index) * layer_stride;
            const size_t bytes = static_cast<size_t>(component_stride) * sizeof(cufftDoubleComplex);
            cudaError_t err = cudaMemsetAsync(destination_x, 0, bytes, stream);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemsetAsync(multilayer_batch_destination.x)", err);
                break;
            }
            err = cudaMemsetAsync(destination_y, 0, bytes, stream);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemsetAsync(multilayer_batch_destination.y)", err);
                break;
            }
            err = cudaMemsetAsync(destination_z, 0, bytes, stream);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemsetAsync(multilayer_batch_destination.z)", err);
                break;
            }

            for (uint32_t src_index = 0; src_index < layer_count; ++src_index) {
                const DeviceMultilayerTensorKernel *kernel =
                    find_multilayer_tensor_kernel(ctx, dst_index, src_index);
                if (kernel == nullptr) {
                    ctx.last_error =
                        "launch_multilayer_demag_field_fp64_batched: tensor pair is missing";
                    break;
                }
                const auto *source_x = static_cast<const cufftDoubleComplex *>(
                    ctx.multilayer_batch_source_fft_x) +
                    static_cast<uint64_t>(src_index) * layer_stride;
                const auto *source_y = static_cast<const cufftDoubleComplex *>(
                    ctx.multilayer_batch_source_fft_y) +
                    static_cast<uint64_t>(src_index) * layer_stride;
                const auto *source_z = static_cast<const cufftDoubleComplex *>(
                    ctx.multilayer_batch_source_fft_z) +
                    static_cast<uint64_t>(src_index) * layer_stride;

                accumulate_demag_tensor_kernel_fp64<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
                    source_x,
                    source_y,
                    source_z,
                    destination_x,
                    destination_y,
                    destination_z,
                    static_cast<const cufftDoubleComplex *>(kernel->tensor.xx),
                    static_cast<const cufftDoubleComplex *>(kernel->tensor.yy),
                    static_cast<const cufftDoubleComplex *>(kernel->tensor.zz),
                    static_cast<const cufftDoubleComplex *>(kernel->tensor.xy),
                    static_cast<const cufftDoubleComplex *>(kernel->tensor.xz),
                    static_cast<const cufftDoubleComplex *>(kernel->tensor.yz),
                    component_stride);
                if (!check_kernel_launch(
                        ctx, "launch_multilayer_demag_field_fp64_batched(accumulate)")) {
                    break;
                }
                ctx.multilayer_demag_stage_counters.note_pair_accumulation();
            }
            if (!ctx.last_error.empty()) {
                break;
            }

            cufftResult fft_err = cufftExecZ2Z(
                ctx.fft_plan, destination_x, destination_x, CUFFT_INVERSE);
            if (fft_err != CUFFT_SUCCESS) {
                set_cufft_error(ctx, "cufftExecZ2Z(multilayer batched inverse)", fft_err);
                break;
            }
            ctx.multilayer_demag_stage_counters.note_inverse_fft();

            const int grid_destination = static_cast<int>(
                (dst.cell_count + BLOCK_SIZE - 1) / BLOCK_SIZE);
            pull_multilayer_h_identity_fp64_kernel<<<grid_destination, BLOCK_SIZE, 0, stream>>>(
                destination_x,
                destination_y,
                destination_z,
                dst.active_mask,
                static_cast<double *>(dst.h_demag.x),
                static_cast<double *>(dst.h_demag.y),
                static_cast<double *>(dst.h_demag.z),
                dst.native_grid.nx,
                dst.native_grid.ny,
                dst.native_grid.nz,
                fft_grid.nx,
                fft_grid.ny,
                dst.has_active_mask ? 1 : 0,
                1.0 / static_cast<double>(component_stride));
            if (!check_kernel_launch(ctx, "launch_multilayer_demag_field_fp64_batched(pull)")) {
                break;
            }
        }
    }

    if (ctx.last_error.empty() &&
        !ctx.multilayer_demag_stage_counters.matches(
            expected_multilayer_batch_counts(layer_count)))
    {
        ctx.last_error =
            "launch_multilayer_demag_field_fp64_batched: D-07 stage counter mismatch";
    }
    context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp64_batched");
}

void launch_multilayer_demag_field_fp32_batched(Context &ctx) {
    if (!context_begin_compute_stream_work(ctx, "launch_multilayer_demag_field_fp32_batched")) {
        return;
    }
    cudaStream_t stream = context_compute_stream(ctx);
    const uint64_t layer_count = ctx.multilayer_layers.size();
    const uint64_t component_stride = ctx.multilayer_batch_component_stride;
    const uint64_t layer_stride = ctx.multilayer_batch_layer_stride;
    const fullmag_fdm_grid_desc &fft_grid = ctx.multilayer_kernels.front().fft_grid;
    const int grid_padded = static_cast<int>((component_stride + BLOCK_SIZE - 1) / BLOCK_SIZE);
    ctx.multilayer_demag_stage_counters.begin_refresh(layer_count);
    if (!zero_layer_h_demag_fp32(ctx, stream)) {
        context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp32_batched");
        return;
    }

    for (uint32_t src_index = 0; src_index < layer_count; ++src_index) {
        const DeviceMultilayerLayer &src = ctx.multilayer_layers[src_index];
        auto *source_x = static_cast<cufftComplex *>(ctx.multilayer_batch_source_fft_x) +
            static_cast<uint64_t>(src_index) * layer_stride;
        auto *source_y = static_cast<cufftComplex *>(ctx.multilayer_batch_source_fft_y) +
            static_cast<uint64_t>(src_index) * layer_stride;
        auto *source_z = static_cast<cufftComplex *>(ctx.multilayer_batch_source_fft_z) +
            static_cast<uint64_t>(src_index) * layer_stride;

        push_multilayer_m_identity_fp32_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
            static_cast<const float *>(src.m.x),
            static_cast<const float *>(src.m.y),
            static_cast<const float *>(src.m.z),
            src.active_mask,
            source_x,
            source_y,
            source_z,
            src.native_grid.nx,
            src.native_grid.ny,
            src.native_grid.nz,
            fft_grid.nx,
            fft_grid.ny,
            fft_grid.nz,
            src.has_active_mask ? 1 : 0,
            static_cast<float>(src.material.saturation_magnetisation));
        if (!check_kernel_launch(ctx, "launch_multilayer_demag_field_fp32_batched(push)")) {
            break;
        }

        cufftResult fft_err = cufftExecC2C(
            ctx.fft_plan, source_x, source_x, CUFFT_FORWARD);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "cufftExecC2C(multilayer batched forward)", fft_err);
            break;
        }
        ctx.multilayer_demag_stage_counters.note_forward_fft();
    }

    if (ctx.last_error.empty()) {
        for (uint32_t dst_index = 0; dst_index < layer_count; ++dst_index) {
            const DeviceMultilayerLayer &dst = ctx.multilayer_layers[dst_index];
            auto *destination_x = static_cast<cufftComplex *>(ctx.multilayer_batch_destination_fft_x) +
                static_cast<uint64_t>(dst_index) * layer_stride;
            auto *destination_y = static_cast<cufftComplex *>(ctx.multilayer_batch_destination_fft_y) +
                static_cast<uint64_t>(dst_index) * layer_stride;
            auto *destination_z = static_cast<cufftComplex *>(ctx.multilayer_batch_destination_fft_z) +
                static_cast<uint64_t>(dst_index) * layer_stride;
            const size_t bytes = static_cast<size_t>(component_stride) * sizeof(cufftComplex);
            cudaError_t err = cudaMemsetAsync(destination_x, 0, bytes, stream);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemsetAsync(multilayer_batch_destination.x)", err);
                break;
            }
            err = cudaMemsetAsync(destination_y, 0, bytes, stream);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemsetAsync(multilayer_batch_destination.y)", err);
                break;
            }
            err = cudaMemsetAsync(destination_z, 0, bytes, stream);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "cudaMemsetAsync(multilayer_batch_destination.z)", err);
                break;
            }

            for (uint32_t src_index = 0; src_index < layer_count; ++src_index) {
                const DeviceMultilayerTensorKernel *kernel =
                    find_multilayer_tensor_kernel(ctx, dst_index, src_index);
                if (kernel == nullptr) {
                    ctx.last_error =
                        "launch_multilayer_demag_field_fp32_batched: tensor pair is missing";
                    break;
                }
                const auto *source_x = static_cast<const cufftComplex *>(
                    ctx.multilayer_batch_source_fft_x) +
                    static_cast<uint64_t>(src_index) * layer_stride;
                const auto *source_y = static_cast<const cufftComplex *>(
                    ctx.multilayer_batch_source_fft_y) +
                    static_cast<uint64_t>(src_index) * layer_stride;
                const auto *source_z = static_cast<const cufftComplex *>(
                    ctx.multilayer_batch_source_fft_z) +
                    static_cast<uint64_t>(src_index) * layer_stride;

                accumulate_demag_tensor_kernel_fp32<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
                    source_x,
                    source_y,
                    source_z,
                    destination_x,
                    destination_y,
                    destination_z,
                    static_cast<const cufftComplex *>(kernel->tensor.xx),
                    static_cast<const cufftComplex *>(kernel->tensor.yy),
                    static_cast<const cufftComplex *>(kernel->tensor.zz),
                    static_cast<const cufftComplex *>(kernel->tensor.xy),
                    static_cast<const cufftComplex *>(kernel->tensor.xz),
                    static_cast<const cufftComplex *>(kernel->tensor.yz),
                    component_stride);
                if (!check_kernel_launch(
                        ctx, "launch_multilayer_demag_field_fp32_batched(accumulate)")) {
                    break;
                }
                ctx.multilayer_demag_stage_counters.note_pair_accumulation();
            }
            if (!ctx.last_error.empty()) {
                break;
            }

            cufftResult fft_err = cufftExecC2C(
                ctx.fft_plan, destination_x, destination_x, CUFFT_INVERSE);
            if (fft_err != CUFFT_SUCCESS) {
                set_cufft_error(ctx, "cufftExecC2C(multilayer batched inverse)", fft_err);
                break;
            }
            ctx.multilayer_demag_stage_counters.note_inverse_fft();

            const int grid_destination = static_cast<int>(
                (dst.cell_count + BLOCK_SIZE - 1) / BLOCK_SIZE);
            pull_multilayer_h_identity_fp32_kernel<<<grid_destination, BLOCK_SIZE, 0, stream>>>(
                destination_x,
                destination_y,
                destination_z,
                dst.active_mask,
                static_cast<float *>(dst.h_demag.x),
                static_cast<float *>(dst.h_demag.y),
                static_cast<float *>(dst.h_demag.z),
                dst.native_grid.nx,
                dst.native_grid.ny,
                dst.native_grid.nz,
                fft_grid.nx,
                fft_grid.ny,
                dst.has_active_mask ? 1 : 0,
                1.0f / static_cast<float>(component_stride));
            if (!check_kernel_launch(ctx, "launch_multilayer_demag_field_fp32_batched(pull)")) {
                break;
            }
        }
    }

    if (ctx.last_error.empty() &&
        !ctx.multilayer_demag_stage_counters.matches(
            expected_multilayer_batch_counts(layer_count)))
    {
        ctx.last_error =
            "launch_multilayer_demag_field_fp32_batched: D-07 stage counter mismatch";
    }
    context_end_compute_stream_work(ctx, "launch_multilayer_demag_field_fp32_batched");
}

} // namespace

static void launch_multilayer_demag_field_fp64_assisted(Context &ctx) {
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
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer batch forward)", fft_err);
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
            set_cufft_error(ctx, "cufftExecZ2Z(multilayer batch inverse)", fft_err);
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

static void launch_multilayer_demag_field_fp32_assisted(Context &ctx) {
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
            set_cufft_error(ctx, "cufftExecC2C(multilayer batch forward)", fft_err);
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
            set_cufft_error(ctx, "cufftExecC2C(multilayer batch inverse)", fft_err);
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

void launch_multilayer_demag_field_fp64(Context &ctx) {
    if (!ctx.enable_demag || ctx.multilayer_kernels.empty()) {
        return;
    }
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "launch_multilayer_demag_field_fp64 requires a staged v2 multilayer plan";
        return;
    }
    bool use_batched = false;
    if (!classify_multilayer_batch_plan(
            ctx, "launch_multilayer_demag_field_fp64", use_batched)) {
        return;
    }
    if (use_batched) {
        launch_multilayer_demag_field_fp64_batched(ctx);
    } else {
        launch_multilayer_demag_field_fp64_assisted(ctx);
    }
}

void launch_multilayer_demag_field_fp32(Context &ctx) {
    if (!ctx.enable_demag || ctx.multilayer_kernels.empty()) {
        return;
    }
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = "launch_multilayer_demag_field_fp32 requires a staged v2 multilayer plan";
        return;
    }
    bool use_batched = false;
    if (!classify_multilayer_batch_plan(
            ctx, "launch_multilayer_demag_field_fp32", use_batched)) {
        return;
    }
    if (use_batched) {
        launch_multilayer_demag_field_fp32_batched(ctx);
    } else {
        launch_multilayer_demag_field_fp32_assisted(ctx);
    }
}

} // namespace fdm
} // namespace fullmag
