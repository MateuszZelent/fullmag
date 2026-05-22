/*
 * kernels.hpp — Kernel launch declarations.
 *
 * Phase 2 will add:
 *   - exchange_field_fp64 / fp32
 *   - llg_rhs_fp64 / fp32
 *   - heun_step_fp64 / fp32
 *   - reductions
 *
 * NOT part of the public ABI.
 */

#ifndef FULLMAG_FDM_KERNELS_HPP
#define FULLMAG_FDM_KERNELS_HPP

#include "context.hpp"

#ifdef FULLMAG_HAS_CUDA

namespace fullmag {
namespace fdm {

// WP5: exchange field
// void launch_exchange_field_fp64(const Context &ctx);
// double launch_exchange_energy_fp64(const Context &ctx);

// WP6: LLG RHS and Heun stepping
// void launch_llg_rhs_fp64(const Context &ctx, DeviceVectorField &out);
// void launch_heun_predictor_fp64(Context &ctx, double dt);
// void launch_heun_corrector_fp64(Context &ctx, double dt);
// void launch_normalize_fp64(Context &ctx);

// GPU-native Newell tensor computation
void launch_newell_compute_spectra_fp64(Context &ctx);
void launch_newell_compute_spectra_fp32(Context &ctx);

// Multilayer convolution demag execution boundary. The first native CUDA
// slice owns identity-grid push_m/pull_h and tensor spectral multiplication;
// non-identity transfer maps are added behind the same launch boundary.
void launch_multilayer_demag_field_fp64(Context &ctx);
void launch_multilayer_demag_field_fp32(Context &ctx);

// Native multilayer exchange field over staged layer-local grids.
void launch_multilayer_exchange_field_fp64(Context &ctx);
void launch_multilayer_exchange_field_fp32(Context &ctx);

// First native v2 timestep slice: Heun over staged multilayer layers with
// demag and layer-local exchange fields. Other v2 integrators stay explicitly
// rejected at the C API boundary.
void launch_multilayer_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
void launch_multilayer_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
void launch_multilayer_rk4_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
void launch_multilayer_rk4_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);

// DP45 adaptive integrators
void launch_dp45_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
void launch_dp45_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);

// ABM3 multi-step integrators
void launch_abm3_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats);
void launch_abm3_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats);

} // namespace fdm
} // namespace fullmag

#endif // FULLMAG_HAS_CUDA

#endif // FULLMAG_FDM_KERNELS_HPP
