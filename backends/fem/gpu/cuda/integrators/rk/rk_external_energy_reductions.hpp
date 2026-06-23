/*
 * GPU CUDA RK external final energy reductions module header.
 *
 * Declares final Zeeman/external-field energy reductions used by the
 * device-resident RK stats path. Generic energy reduction orchestration
 * remains in rk_energy_reductions.hpp/.cu.
 *
 * Physics contract:
 *   E_Z = -mu0 sum_i Ms_i (m_i . H_ext_i) w_i.
 *
 * The device H_ext buffer is in A/m. This module owns only the final scalar
 * reduction for RK statistics; it does not import the plan field, upload H_ext,
 * add H_ext to H_eff, or apply gamma/damping torque factors.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_reduce_final_external_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason);

} // namespace fullmag::fem
#endif
