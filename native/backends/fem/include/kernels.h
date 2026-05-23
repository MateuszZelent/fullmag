// ── S11: CUDA kernel declarations for fused LLG + field ops ───────────
// All kernels use double precision (fp64) SoA layout.
// Single precision (fp32) is NOT supported — attempting to instantiate
// float variants will fail at compile time.
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace fullmag::fem {

/// Precision type used by all FEM CUDA kernels.
using fem_real_t = double;

// Compile-time guard: block single-precision (FEM-012).
static_assert(std::is_same_v<fem_real_t, double>,
    "fullmag FEM native kernels require double precision; "
    "single precision (float) is not implemented — set fem_real_t = double");

/// Upload host AoS triples into device SoA component arrays.
void fullmag_cuda_upload_aos_to_soa(
    const fem_real_t *aos_xyz,
    fem_real_t *x,
    fem_real_t *y,
    fem_real_t *z,
    int N,
    cudaStream_t stream = nullptr);

/// Download device SoA component arrays into host AoS triples.
void fullmag_cuda_download_soa_to_aos(
    const fem_real_t *x,
    const fem_real_t *y,
    const fem_real_t *z,
    fem_real_t *aos_xyz,
    int N,
    cudaStream_t stream = nullptr);

/// Fused LLG RHS: dm/dt = -γ̄ (p m×H + α m×(m×H)), per-block max reduction.
/// `precession_enabled=false` sets p=0 for pure damping relaxation.
/// Input/output: SoA layout (separate mx, my, mz arrays).
void fullmag_cuda_llg_rhs_fused(
    const fem_real_t *mx, const fem_real_t *my, const fem_real_t *mz,
    const fem_real_t *hx, const fem_real_t *hy, const fem_real_t *hz,
    fem_real_t *dmx, fem_real_t *dmy, fem_real_t *dmz,
    fem_real_t *block_max_rhs,
    const fem_real_t *alpha_field,
    fem_real_t gamma, fem_real_t alpha,
    bool use_alpha_field,
    bool precession_enabled,
    int N, cudaStream_t stream = nullptr);

/// Add Slonczewski spin-transfer torque to an already assembled RHS.
void fullmag_cuda_add_slonczewski_stt_rhs(
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *ms,
    const uint8_t *magnetic_node_mask,
    fem_real_t *dmx,
    fem_real_t *dmy,
    fem_real_t *dmz,
    fem_real_t *block_max_rhs,
    fem_real_t current_density_mag,
    fem_real_t current_sign,
    fem_real_t free_layer_thickness,
    fem_real_t degree,
    fem_real_t lambda,
    fem_real_t epsilon_prime,
    fem_real_t px,
    fem_real_t py,
    fem_real_t pz,
    int N,
    cudaStream_t stream = nullptr);

/// Add Zhang-Li spin-transfer torque using tetrahedral element gradients.
void fullmag_cuda_add_zhang_li_stt_rhs(
    const fem_real_t *nodes_xyz,
    const uint32_t *elements,
    const uint8_t *magnetic_element_mask,
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *ms,
    const uint8_t *magnetic_node_mask,
    fem_real_t *work_x,
    fem_real_t *work_y,
    fem_real_t *work_z,
    fem_real_t *node_weight,
    fem_real_t *dmx,
    fem_real_t *dmy,
    fem_real_t *dmz,
    fem_real_t *block_max_rhs,
    fem_real_t current_x,
    fem_real_t current_y,
    fem_real_t current_z,
    fem_real_t degree,
    fem_real_t beta,
    int element_count,
    int node_count,
    cudaStream_t stream = nullptr);

/// DMI weak-residual field projection and energy for linear tetrahedra.
void fullmag_cuda_dmi_field_energy(
    const fem_real_t *nodes_xyz,
    const uint32_t *elements,
    const uint8_t *magnetic_element_mask,
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *ms,
    const fem_real_t *d_field,
    const fem_real_t *lumped_mass,
    const uint8_t *magnetic_node_mask,
    fem_real_t *residual_x,
    fem_real_t *residual_y,
    fem_real_t *residual_z,
    fem_real_t *h_dmi_x,
    fem_real_t *h_dmi_y,
    fem_real_t *h_dmi_z,
    fem_real_t *energy_out,
    fem_real_t uniform_ms,
    fem_real_t uniform_d,
    fem_real_t nx,
    fem_real_t ny,
    fem_real_t nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count,
    int node_count,
    cudaStream_t stream = nullptr);

/// Normalize each (mx,my,mz) to unit length (SoA layout).
void fullmag_cuda_normalize_vectors(
    fem_real_t *mx, fem_real_t *my, fem_real_t *mz,
    int N, cudaStream_t stream = nullptr);

/// h_eff = h_ex + h_demag [+ h_ext] (element-wise, SoA component).
void fullmag_cuda_accumulate_heff(
    const fem_real_t *h_ex, const fem_real_t *h_demag, const fem_real_t *h_ext,
    fem_real_t *h_eff,
    int N, bool has_ext, cudaStream_t stream = nullptr);

/// Legacy assembled FEM exchange: h_ex = -2/(mu0*Ms) * M_lumped^-1 * K * m.
void fullmag_cuda_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const fem_real_t *csr_values,
    const fem_real_t *m_component,
    const fem_real_t *ms,
    const fem_real_t *inv_lumped_mass,
    const uint8_t *magnetic_node_mask,
    fem_real_t *h_component,
    int rows,
    cudaStream_t stream = nullptr);

/// Per-block exchange energy partials for legacy sparse operator:
/// sum_i m_i · (K m)_i across x/y/z components.
void fullmag_cuda_legacy_sparse_exchange_energy_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const fem_real_t *csr_values,
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    fem_real_t *block_sums,
    int rows,
    cudaStream_t stream = nullptr);

/// Device Poisson demag RHS: b = Bx mx + By my + Bz mz.
void fullmag_cuda_demag_rhs_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const fem_real_t *csr_values_x,
    const fem_real_t *csr_values_y,
    const fem_real_t *csr_values_z,
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    fem_real_t *rhs,
    int rows,
    cudaStream_t stream = nullptr);

/// Device Poisson demag recovery: h_component = G_component u.
void fullmag_cuda_demag_recovery_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const fem_real_t *csr_values,
    const fem_real_t *u,
    const uint8_t *magnetic_node_mask,
    fem_real_t *h_component,
    int rows,
    cudaStream_t stream = nullptr);

/// Zero a sparse index list in a device vector.
void fullmag_cuda_zero_indexed_values(
    fem_real_t *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream = nullptr);

/// Per-block demag energy partials:
/// -0.5 * mu0 * Ms_i * (m_i . H_demag_i) * lumped_mass_i.
void fullmag_cuda_demag_energy_blocks(
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *h_demag_x,
    const fem_real_t *h_demag_y,
    const fem_real_t *h_demag_z,
    const fem_real_t *ms,
    const fem_real_t *lumped_mass,
    const uint8_t *magnetic_node_mask,
    fem_real_t *block_sums,
    int N,
    cudaStream_t stream = nullptr);

/// Per-block Zeeman energy partials:
/// -mu0 * Ms_i * (m_i . H_ext_i) * lumped_mass_i.
void fullmag_cuda_external_energy_blocks(
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *h_ext_x,
    const fem_real_t *h_ext_y,
    const fem_real_t *h_ext_z,
    const fem_real_t *ms,
    const fem_real_t *lumped_mass,
    const uint8_t *magnetic_node_mask,
    fem_real_t *block_sums,
    int N,
    cudaStream_t stream = nullptr);

/// Uniaxial anisotropy field and per-block energy partials.
void fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *ms,
    const fem_real_t *ku,
    const fem_real_t *ku2,
    const fem_real_t *lumped_mass,
    const uint8_t *magnetic_node_mask,
    fem_real_t *h_ani_x,
    fem_real_t *h_ani_y,
    fem_real_t *h_ani_z,
    fem_real_t *block_sums,
    fem_real_t uniform_ku,
    fem_real_t uniform_ku2,
    fem_real_t axis_x,
    fem_real_t axis_y,
    fem_real_t axis_z,
    bool use_ku_field,
    bool use_ku2_field,
    int N,
    cudaStream_t stream = nullptr);

/// Cubic anisotropy field and per-block energy partials.
void fullmag_cuda_cubic_anisotropy_field_energy_blocks(
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *ms,
    const fem_real_t *kc1,
    const fem_real_t *kc2,
    const fem_real_t *kc3,
    const fem_real_t *lumped_mass,
    const uint8_t *magnetic_node_mask,
    fem_real_t *h_cubic_x,
    fem_real_t *h_cubic_y,
    fem_real_t *h_cubic_z,
    fem_real_t *block_sums,
    fem_real_t uniform_kc1,
    fem_real_t uniform_kc2,
    fem_real_t uniform_kc3,
    fem_real_t c1x,
    fem_real_t c1y,
    fem_real_t c1z,
    fem_real_t c2x,
    fem_real_t c2y,
    fem_real_t c2z,
    bool use_kc1_field,
    bool use_kc2_field,
    bool use_kc3_field,
    int N,
    cudaStream_t stream = nullptr);

/// Prescribed-strain magnetoelastic field and per-block energy partials.
void fullmag_cuda_magnetoelastic_field_energy_blocks(
    const fem_real_t *mx,
    const fem_real_t *my,
    const fem_real_t *mz,
    const fem_real_t *ms,
    const fem_real_t *lumped_mass,
    const uint8_t *magnetic_node_mask,
    const fem_real_t *per_node_strain_voigt,
    fem_real_t *h_mel_x,
    fem_real_t *h_mel_y,
    fem_real_t *h_mel_z,
    fem_real_t *block_sums,
    fem_real_t b1,
    fem_real_t b2,
    fem_real_t e11,
    fem_real_t e22,
    fem_real_t e33,
    fem_real_t e23,
    fem_real_t e13,
    fem_real_t e12,
    bool use_per_node_strain,
    int N,
    cudaStream_t stream = nullptr);

/// h_accum += h_add (component-wise).
void fullmag_cuda_add_field_inplace(
    const fem_real_t *h_add,
    fem_real_t *h_accum,
    int N,
    cudaStream_t stream = nullptr);

/// h_accum += scale * h_add (component-wise).
void fullmag_cuda_add_scaled_field_inplace(
    const fem_real_t *h_add,
    fem_real_t *h_accum,
    fem_real_t scale,
    int N,
    cudaStream_t stream = nullptr);

/// Deterministic Brown thermal field and per-block max sigma partials.
void fullmag_cuda_thermal_field_blocks(
    const fem_real_t *ms,
    const fem_real_t *alpha,
    const fem_real_t *node_volumes,
    const uint8_t *magnetic_node_mask,
    fem_real_t *h_therm_x,
    fem_real_t *h_therm_y,
    fem_real_t *h_therm_z,
    fem_real_t *block_max_sigma,
    fem_real_t gamma_red,
    fem_real_t uniform_alpha,
    fem_real_t temperature,
    fem_real_t dt_seconds,
    uint64_t seed,
    uint64_t step_index,
    bool use_alpha_field,
    int N,
    cudaStream_t stream = nullptr);

/// Per-block max |H_eff| and max |m x H_eff| for step telemetry.
void fullmag_cuda_field_metric_blocks(
    const fem_real_t *mx, const fem_real_t *my, const fem_real_t *mz,
    const fem_real_t *hx, const fem_real_t *hy, const fem_real_t *hz,
    const uint8_t *magnetic_node_mask,
    fem_real_t *block_max_h,
    fem_real_t *block_max_torque,
    int N,
    cudaStream_t stream = nullptr);

/// Per-block sums of magnetization components and magnetic node count.
void fullmag_cuda_magnetization_sum_blocks(
    const fem_real_t *mx, const fem_real_t *my, const fem_real_t *mz,
    const uint8_t *magnetic_node_mask,
    fem_real_t *block_sum_x,
    fem_real_t *block_sum_y,
    fem_real_t *block_sum_z,
    fem_real_t *block_count,
    int N,
    cudaStream_t stream = nullptr);

/// Per-block max adaptive embedded error norm:
/// max_i |dt * sum_s (b_hi_s - b_lo_s) * k_s| /
///       (atol + rtol * max(|m_old_i|, |m_new_i|)).
void fullmag_cuda_adaptive_error_norm_blocks(
    const fem_real_t *old_mx, const fem_real_t *old_my, const fem_real_t *old_mz,
    const fem_real_t *new_mx, const fem_real_t *new_my, const fem_real_t *new_mz,
    const fem_real_t *k0x, const fem_real_t *k0y, const fem_real_t *k0z,
    const fem_real_t *k1x, const fem_real_t *k1y, const fem_real_t *k1z,
    const fem_real_t *k2x, const fem_real_t *k2y, const fem_real_t *k2z,
    const fem_real_t *k3x, const fem_real_t *k3y, const fem_real_t *k3z,
    const fem_real_t *k4x, const fem_real_t *k4y, const fem_real_t *k4z,
    const fem_real_t *k5x, const fem_real_t *k5y, const fem_real_t *k5z,
    const fem_real_t *k6x, const fem_real_t *k6y, const fem_real_t *k6z,
    fem_real_t b_hi0, fem_real_t b_hi1, fem_real_t b_hi2, fem_real_t b_hi3,
    fem_real_t b_hi4, fem_real_t b_hi5, fem_real_t b_hi6,
    fem_real_t b_lo0, fem_real_t b_lo1, fem_real_t b_lo2, fem_real_t b_lo3,
    fem_real_t b_lo4, fem_real_t b_lo5, fem_real_t b_lo6,
    fem_real_t dt, fem_real_t adaptive_atol, fem_real_t adaptive_rtol,
    fem_real_t *block_max_scaled_error,
    int stages,
    int N,
    cudaStream_t stream = nullptr);

/// Query/execute CUB device-wide max reduction.
/// Call once with temp_storage=nullptr to get temp_storage_bytes,
/// then again with allocated buffer.
void fullmag_cuda_device_max(
    const fem_real_t *data, int N, fem_real_t *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream = nullptr);

/// Query/execute CUB device-wide sum reduction.
void fullmag_cuda_device_sum(
    const fem_real_t *data, int N, fem_real_t *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem

#endif // FULLMAG_HAS_CUDA_RUNTIME
