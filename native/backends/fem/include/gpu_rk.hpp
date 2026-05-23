#pragma once

#include "cpu/mfem/integrators/rk_tableau.hpp"
#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

struct GpuRkPlan {
    bool enabled = false;
    uint32_t stage_count = 0;
    bool uses_cuda_kernels = false;
    bool allows_exchange_host_sync = false;
    bool stage_exchange_device_resident = false;
    bool uses_gpu_poisson = false;
    const char *exchange_operator_mode = "unsupported";
    const char *demag_operator_mode = "none";
    const char *hypre_execution_policy = "none";
    const char *demag_residency = "none";
};

uint32_t gpu_rk_stage_count(fullmag_fem_integrator integrator);

double gpu_rk_resolve_slonczewski_thickness(const Context &ctx);

GpuRkPlan gpu_rk_plan_exchange_only(const Context &ctx, std::string &reason);

bool gpu_rk_exchange_only_step(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &reason);

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason);

} // namespace fullmag::fem
