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

} // namespace fdm
} // namespace fullmag

#endif // FULLMAG_HAS_CUDA

#endif // FULLMAG_FDM_KERNELS_HPP
