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

__global__ void accumulate_heff_fused_xyz_kernel(
    FemGpuHeffAccumulateTerms terms,
    double *__restrict__ h_eff_x,
    double *__restrict__ h_eff_y,
    double *__restrict__ h_eff_z,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) {
        return;
    }
    const uint32_t mask = terms.active_mask;
    double sx = terms.h_ex_x[i] + terms.h_demag_x[i];
    double sy = terms.h_ex_y[i] + terms.h_demag_y[i];
    double sz = terms.h_ex_z[i] + terms.h_demag_z[i];
    if ((mask & FEM_GPU_HEFF_TERM_EXT) != 0u) {
        sx += terms.h_ext_x[i];
        sy += terms.h_ext_y[i];
        sz += terms.h_ext_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_DRIVE) != 0u) {
        sx += terms.h_drive_x[i];
        sy += terms.h_drive_y[i];
        sz += terms.h_drive_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_ANI) != 0u) {
        sx += terms.h_ani_x[i];
        sy += terms.h_ani_y[i];
        sz += terms.h_ani_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_CUBIC) != 0u) {
        sx += terms.h_cubic_x[i];
        sy += terms.h_cubic_y[i];
        sz += terms.h_cubic_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_DMI) != 0u) {
        sx += terms.h_dmi_x[i];
        sy += terms.h_dmi_y[i];
        sz += terms.h_dmi_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_BULK_DMI) != 0u) {
        sx += terms.h_bulk_dmi_x[i];
        sy += terms.h_bulk_dmi_y[i];
        sz += terms.h_bulk_dmi_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_OE_SCALED) != 0u) {
        // Use explicit IEEE-754 rounded mul+add so nvcc FP contraction cannot
        // turn scale*src + sx into an FMA that differs by 1 ULP from the
        // split scale_field + add_scaled_field_inplace sequence.
        const double oe_x = __dmul_rn(terms.h_oe_scale, terms.h_oe_src_x[i]);
        const double oe_y = __dmul_rn(terms.h_oe_scale, terms.h_oe_src_y[i]);
        const double oe_z = __dmul_rn(terms.h_oe_scale, terms.h_oe_src_z[i]);
        terms.h_oe_out_x[i] = oe_x;
        terms.h_oe_out_y[i] = oe_y;
        terms.h_oe_out_z[i] = oe_z;
        sx = __dadd_rn(sx, oe_x);
        sy = __dadd_rn(sy, oe_y);
        sz = __dadd_rn(sz, oe_z);
    } else if ((mask & FEM_GPU_HEFF_TERM_OE_EXPLICIT) != 0u) {
        sx += terms.h_oe_src_x[i];
        sy += terms.h_oe_src_y[i];
        sz += terms.h_oe_src_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_MEL) != 0u) {
        sx += terms.h_mel_x[i];
        sy += terms.h_mel_y[i];
        sz += terms.h_mel_z[i];
    }
    if ((mask & FEM_GPU_HEFF_TERM_THERM) != 0u) {
        sx += terms.h_therm_x[i];
        sy += terms.h_therm_y[i];
        sz += terms.h_therm_z[i];
    }
    h_eff_x[i] = sx;
    h_eff_y[i] = sy;
    h_eff_z[i] = sz;
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

__global__ void apply_full_domain_demag_correction_kernel(
    const double *__restrict__ h_demag_full,
    const double *__restrict__ h_demag_magnetic,
    double *__restrict__ h_eff_full,
    const uint8_t *__restrict__ magnetic_node_mask,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N &&
        (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        return;
    }
    if (i < N) {
        h_eff_full[i] += h_demag_full[i] - h_demag_magnetic[i];
    }
}

bool fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    const uint8_t *magnetic_node_mask,
    double *device_invalid_flag,
    int N,
    cudaStream_t stream,
    std::string &reason,
    GpuPerformanceCounterState *performance_counters)
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
    if (performance_counters != nullptr) {
        GpuPerformanceCounterDelta delta{};
        delta.normalization_launches = 1;
        delta.normalization_readbacks = 1;
        delta.control_fences = 1;
        delta.control_d2h_bytes = sizeof(double);
        gpu_performance_note(*performance_counters, delta);
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

void fullmag_cuda_accumulate_heff_fused_xyz(
    const FemGpuHeffAccumulateTerms &terms,
    double *h_eff_x,
    double *h_eff_y,
    double *h_eff_z,
    int N,
    cudaStream_t stream)
{
    if (N <= 0) {
        return;
    }
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    accumulate_heff_fused_xyz_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        terms, h_eff_x, h_eff_y, h_eff_z, N);
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

void fullmag_cuda_apply_full_domain_demag_correction(
    const double *h_demag_full,
    const double *h_demag_magnetic,
    double *h_eff_full,
    const uint8_t *magnetic_node_mask,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    apply_full_domain_demag_correction_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_demag_full,
        h_demag_magnetic,
        h_eff_full,
        magnetic_node_mask,
        N);
}

} // namespace fullmag::fem
