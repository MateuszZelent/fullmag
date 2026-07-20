/*
 * GPU CUDA projected-gradient BB relaxation kernels header.
 *
 * Declares device-resident tangent-gradient, FEM mass-metric reduction, and
 * normalized retraction kernels for the native FEM GPU relaxation lane.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

void fullmag_cuda_relax_tangent_gradient_and_norm_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *gx,
    double *gy,
    double *gz,
    double *block_norm_sq,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_metric_dot_blocks(
    const double *ax,
    const double *ay,
    const double *az,
    const double *bx,
    const double *by,
    const double *bz,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_dot,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_energy_weighted_dot_blocks(
    const double *ax,
    const double *ay,
    const double *az,
    const double *bx,
    const double *by,
    const double *bz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_dot,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_retract_field(
    const double *mx,
    const double *my,
    const double *mz,
    const double *dx,
    const double *dy,
    const double *dz,
    const uint8_t *magnetic_node_mask,
    double step_size,
    double *out_x,
    double *out_y,
    double *out_z,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_project_static_periodic_field(
    double *x,
    double *y,
    double *z,
    const uint32_t *periodic_representative_nodes,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_direct_energy_difference_blocks(
    const double *current_mx,
    const double *current_my,
    const double *current_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    const double *current_h_demag_x,
    const double *current_h_demag_y,
    const double *current_h_demag_z,
    const double *trial_h_demag_x,
    const double *trial_h_demag_y,
    const double *trial_h_demag_z,
    const double *h_ext_x,
    const double *h_ext_y,
    const double *h_ext_z,
    const double *ms,
    const double *ku,
    const double *ku2,
    const double *axis_x,
    const double *axis_y,
    const double *axis_z,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool demag_enabled,
    double uniform_ku, double uniform_ku2,
    bool use_ku_field, bool use_ku2_field,
    double *block_delta_energy,
    double *block_absolute_terms,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_bb_curvature_blocks(
    const double *previous_mx,
    const double *previous_my,
    const double *previous_mz,
    const double *trial_mx,
    const double *trial_my,
    const double *trial_mz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_s_dot_s,
    double *block_s_dot_y,
    double *block_y_dot_y,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_prepare_direction_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *gx,
    const double *gy,
    const double *gz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool direction_valid,
    double *px,
    double *py,
    double *pz,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_pr_plus_numerator_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_numerator,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_gradient_norm_and_pr_plus_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *previous_gx,
    const double *previous_gy,
    const double *previous_gz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *trial_gx,
    double *trial_gy,
    double *trial_gz,
    double *block_norm_sq,
    double *block_previous_energy_norm_sq,
    double *block_numerator,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    bool direction_valid,
    double *gx,
    double *gy,
    double *gz,
    double *px,
    double *py,
    double *pz,
    double *block_gradient_norm_sq,
    double *block_gradient_energy_norm_sq,
    double *block_p_dot_g,
    double *block_direction_norm_sq,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_update_direction_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *previous_px,
    const double *previous_py,
    const double *previous_pz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double beta,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_update_direction_from_reduced_pr_plus(
    const double *mx,
    const double *my,
    const double *mz,
    const double *trial_gx,
    const double *trial_gy,
    const double *trial_gz,
    const double *previous_px,
    const double *previous_py,
    const double *previous_pz,
    const double *previous_gradient_energy_norm_sq_scalar,
    const double *pr_plus_numerator_scalar,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double relative_roundoff_bound,
    bool previous_direction_valid,
    bool restart_step,
    double *next_px,
    double *next_py,
    double *next_pz,
    double *block_p_dot_g,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_relax_ncg_reset_direction_if_not_descent(
    const double *gx,
    const double *gy,
    const double *gz,
    const double *p_dot_g_scalar,
    const uint8_t *magnetic_node_mask,
    double *px,
    double *py,
    double *pz,
    int n,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
