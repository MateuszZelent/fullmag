// ── GPU CUDA vector field kernels source contract ─────────────────────
// This source owns exported FEM CUDA wrappers for shared vector field
// operations. It does not own RK orchestration, LLG RHS, AoS/SoA transfer
// wrappers, Context construction, MFEM runtime lifecycle, interaction physics,
// or C ABI entrypoints.

#include "gpu/cuda/fields/vector_field_kernels.hpp"

#include <cfloat>
#include <cmath>
#include <math_constants.h>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void normalize_unit_vectors_kernel(
    double *__restrict__ mx, double *__restrict__ my, double *__restrict__ mz,
    const uint8_t *__restrict__ magnetic_node_mask,
    unsigned long long *__restrict__ invalid_flag,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        if (magnetic_node_mask != nullptr && magnetic_node_mask[i] == 0u) {
            return;
        }
        const double x = mx[i], y = my[i], z = mz[i];
        const double norm = sqrt(x * x + y * y + z * z);
        if (!isfinite(x) || !isfinite(y) || !isfinite(z) ||
            !isfinite(norm) || norm < DBL_MIN) {
            atomicExch(invalid_flag, __double_as_longlong(CUDART_INF));
            return;
        }
        const double inv = 1.0 / norm;
        mx[i] = x * inv;
        my[i] = y * inv;
        mz[i] = z * inv;
    }
}

__global__ void accumulate_heff_kernel(
    const double *__restrict__ h_ex,
    const double *__restrict__ h_demag,
    const double *__restrict__ h_ext,
    double *__restrict__ h_eff,
    int N,
    bool has_ext)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        double val = h_ex[i] + h_demag[i];
        if (has_ext) {
            val += h_ext[i];
        }
        h_eff[i] = val;
    }
}

__global__ void zero_indexed_values_kernel(
    double *__restrict__ values,
    const uint32_t *__restrict__ indices,
    int count)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < count) {
        values[indices[i]] = 0.0;
    }
}

__global__ void add_field_inplace_kernel(
    const double *__restrict__ h_add,
    double *__restrict__ h_accum,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        h_accum[i] += h_add[i];
    }
}

bool fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    const uint8_t *magnetic_node_mask,
    double *device_invalid_flag,
    int N,
    cudaStream_t stream,
    std::string &reason)
{
    if (device_invalid_flag == nullptr) {
        reason = "GPU vector normalization requires a preallocated invalid-vector scalar";
        return false;
    }
    cudaError_t rc = cudaMemsetAsync(device_invalid_flag, 0, sizeof(double), stream);
    if (rc != cudaSuccess) {
        reason = std::string("cudaMemsetAsync GPU normalization guard failed: ") +
            cudaGetErrorString(rc);
        return false;
    }
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    normalize_unit_vectors_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz,
        magnetic_node_mask,
        reinterpret_cast<unsigned long long *>(device_invalid_flag),
        N);
    rc = cudaPeekAtLastError();
    if (rc != cudaSuccess) {
        reason = std::string("launch GPU guarded vector normalization failed: ") +
            cudaGetErrorString(rc);
        return false;
    }
    double invalid = 0.0;
    rc = cudaMemcpyAsync(
        &invalid,
        device_invalid_flag,
        sizeof(double),
        cudaMemcpyDeviceToHost,
        stream);
    if (rc == cudaSuccess) {
        rc = cudaStreamSynchronize(stream);
    }
    if (rc != cudaSuccess) {
        reason = std::string("GPU normalization guard scalar readback failed: ") +
            cudaGetErrorString(rc);
        return false;
    }
    if (invalid != 0.0) {
        reason = "GPU RK stage contains zero, subnormal-norm, or nonfinite active magnetization";
        return false;
    }
    return true;
}

void fullmag_cuda_accumulate_heff(
    const double *h_ex, const double *h_demag, const double *h_ext,
    double *h_eff,
    int N, bool has_ext, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    accumulate_heff_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_ex, h_demag, h_ext, h_eff, N, has_ext);
}

void fullmag_cuda_zero_indexed_values(
    double *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream)
{
    if (count <= 0) {
        return;
    }
    const int num_blocks = (count + kBlockSize - 1) / kBlockSize;
    zero_indexed_values_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        values,
        indices,
        count);
}

void fullmag_cuda_add_field_inplace(
    const double *h_add,
    double *h_accum,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    add_field_inplace_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_add,
        h_accum,
        N);
}

} // namespace fullmag::fem
