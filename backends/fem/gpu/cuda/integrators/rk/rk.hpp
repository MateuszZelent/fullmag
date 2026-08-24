#pragma once

/*
 * GPU CUDA RK module header.
 *
 * Declares device-resident GPU RK readiness planning and step orchestration.
 */

#include "cpu/mfem/integrators/rk_tableau.hpp"
#include "fullmag_fem.h"
#include "gpu/cuda/integrators/rk/rk_snapshot.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"

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
    FemGpuExecutionClass execution_class = FemGpuExecutionClass::Unknown;
    uint64_t required_operator_mask = 0;
    uint64_t resolved_device_operator_mask = 0;
    uint64_t resolved_host_operator_mask = 0;
    uint64_t resolved_unknown_operator_mask = 0;
};

uint32_t gpu_rk_stage_count(fullmag_fem_integrator integrator);

double gpu_rk_resolve_slonczewski_thickness(const Context &ctx);

GpuRkPlan gpu_rk_plan_device_resident(const Context &ctx, std::string &reason);

uint64_t gpu_rk_required_operator_mask(const Context &ctx);

bool gpu_rk_plan_is_strict_device_resident(
    const GpuRkPlan &plan,
    std::string &reason);

bool gpu_rk_strict_transfer_audit_is_clean(
    const fullmag_fem_transfer_audit &transfer,
    std::string &reason);

bool gpu_rk_device_resident_step(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &reason);

} // namespace fullmag::fem
