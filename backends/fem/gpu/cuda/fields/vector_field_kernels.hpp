/*
 * GPU CUDA vector field kernels module header.
 *
 * Declares exported FEM CUDA wrappers for shared vector field operations.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>
#include <string>

#include "gpu/cuda/runtime/performance_counters.hpp"

namespace fullmag::fem {

/// Validate and normalize each active (mx,my,mz) to unit length (SoA layout).
/// Zero, subnormal-norm, NaN, and Inf active vectors fail through one bounded
/// scalar readback; inactive nodes are left unchanged.
bool fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    const uint8_t *magnetic_node_mask,
    double *device_invalid_flag,
    int N,
    cudaStream_t stream,
    std::string &reason,
    GpuPerformanceCounterState *performance_counters = nullptr);

/// h_eff = h_ex + h_demag [+ h_ext] (element-wise, SoA component).
void fullmag_cuda_accumulate_heff(
    const double *h_ex, const double *h_demag, const double *h_ext,
    double *h_eff,
    int N, bool has_ext, cudaStream_t stream = nullptr);

enum FemGpuHeffTermBits : uint32_t {
    FEM_GPU_HEFF_TERM_EXT = 1u << 0,
    FEM_GPU_HEFF_TERM_DRIVE = 1u << 1,
    FEM_GPU_HEFF_TERM_ANI = 1u << 2,
    FEM_GPU_HEFF_TERM_CUBIC = 1u << 3,
    FEM_GPU_HEFF_TERM_DMI = 1u << 4,
    FEM_GPU_HEFF_TERM_BULK_DMI = 1u << 5,
    FEM_GPU_HEFF_TERM_OE_SCALED = 1u << 6,
    FEM_GPU_HEFF_TERM_OE_EXPLICIT = 1u << 7,
    FEM_GPU_HEFF_TERM_MEL = 1u << 8,
    FEM_GPU_HEFF_TERM_THERM = 1u << 9,
};

struct FemGpuHeffAccumulateTerms {
    const double *h_ex_x = nullptr;
    const double *h_ex_y = nullptr;
    const double *h_ex_z = nullptr;
    const double *h_demag_x = nullptr;
    const double *h_demag_y = nullptr;
    const double *h_demag_z = nullptr;
    const double *h_ext_x = nullptr;
    const double *h_ext_y = nullptr;
    const double *h_ext_z = nullptr;
    const double *h_drive_x = nullptr;
    const double *h_drive_y = nullptr;
    const double *h_drive_z = nullptr;
    const double *h_ani_x = nullptr;
    const double *h_ani_y = nullptr;
    const double *h_ani_z = nullptr;
    const double *h_cubic_x = nullptr;
    const double *h_cubic_y = nullptr;
    const double *h_cubic_z = nullptr;
    const double *h_dmi_x = nullptr;
    const double *h_dmi_y = nullptr;
    const double *h_dmi_z = nullptr;
    const double *h_bulk_dmi_x = nullptr;
    const double *h_bulk_dmi_y = nullptr;
    const double *h_bulk_dmi_z = nullptr;
    const double *h_oe_src_x = nullptr;
    const double *h_oe_src_y = nullptr;
    const double *h_oe_src_z = nullptr;
    double *h_oe_out_x = nullptr;
    double *h_oe_out_y = nullptr;
    double *h_oe_out_z = nullptr;
    double h_oe_scale = 1.0;
    const double *h_mel_x = nullptr;
    const double *h_mel_y = nullptr;
    const double *h_mel_z = nullptr;
    const double *h_therm_x = nullptr;
    const double *h_therm_y = nullptr;
    const double *h_therm_z = nullptr;
    uint32_t active_mask = 0u;
};

/// Fused single-launch XYZ effective-field accumulation preserving the exact
/// FP64 addition order of the split component-wise accumulation path.
void fullmag_cuda_accumulate_heff_fused_xyz(
    const FemGpuHeffAccumulateTerms &terms,
    double *h_eff_x,
    double *h_eff_y,
    double *h_eff_z,
    int N,
    cudaStream_t stream = nullptr);

/// Zero a sparse index list in a device vector.
void fullmag_cuda_zero_indexed_values(
    double *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream = nullptr);

/// h_accum += h_add (component-wise).
void fullmag_cuda_add_field_inplace(
    const double *h_add,
    double *h_accum,
    int N,
    cudaStream_t stream = nullptr);

/// Add the full-domain demag continuation to airbox nodes of staged H_eff only.
/// Magnetic nodes retain the ordinary solver effective field; a null mask
/// treats every node as magnetic.
void fullmag_cuda_apply_full_domain_demag_correction(
    const double *h_demag_full,
    const double *h_demag_magnetic,
    double *h_eff_full,
    const uint8_t *magnetic_node_mask,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif // FULLMAG_HAS_CUDA_RUNTIME
