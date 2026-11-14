#pragma once

/*
 * GPU CUDA Poisson demag Hypre device solver header.
 *
 * Owns strict GPU Poisson demag Hypre device-policy solver setup and solver
 * statistics extraction. Operator CSR records live in operators.hpp; lifecycle
 * and stage compute remain in poisson.hpp/.cpp.
 */

#include "gpu/cuda/demag_poisson/operators.hpp"

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

uint32_t demag_poisson_resolved_linear_engine(const Context&);
bool demag_poisson_device_scalar_pcg_amg_ready(const Context&);
fullmag_fem_poisson_device_pcg_counters_v1 demag_poisson_device_pcg_counters(const Context&, uint32_t scope = 0);

bool apply_demag_poisson_hypre_device_solver(Context&, GpuDemagPoissonWorkspace&, std::string&);
void destroy_demag_poisson_device_pcg(GpuDemagPoissonWorkspace&);

bool read_device_demag_amg_coarse_relax_type(
    const Context &ctx,
    std::int32_t &relax_type,
    std::string &error);

bool initialize_demag_poisson_hypre_device_solver(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

bool prepare_demag_poisson_hypre_device_solver_apply(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    bool fresh_zero,
    std::string &error);

bool set_demag_poisson_hypre_solver_iterative_mode(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    bool iterative_mode,
    std::string &error);

void read_demag_poisson_hypre_solver_stats(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual,
    bool &solver_reported_converged);

bool validate_demag_poisson_hypre_device_solve(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual,
    std::string &error);

} // namespace fullmag::fem
