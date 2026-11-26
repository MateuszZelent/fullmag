#pragma once

#include "gpu/cuda/state/component_field.hpp"
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace mfem { class SparseMatrix; }
namespace fullmag::fem {
struct Context;
struct TransferAudit;
struct GpuBbExchangeMassWorkspace;

struct GpuBbExchangeMassStatus {
    uint32_t requested_policy = 0; // 0=auto, 1=none, 2=exchange_mass
    bool resolved_enabled = false;
    uint64_t last_iterations = 0;
    double last_relative_residual = 0.0;
    const char *solver_kind = "not_used";         // "cooperative_device_pcg" | "not_used"
    const char *preconditioner_kind = "not_used"; // "device_jacobi" | "not_used"
    const char *fallback_reason = "";             // "" | "policy_none" | "exchange_disabled" | "mfem_forms_unavailable" | "cooperative_launch_unsupported"
};

// Numerical policy only: physical fields, energy, torque and Poisson
// certification do not use this operator.
void gpu_bb_exchange_mass_resolve(const Context &ctx, GpuBbExchangeMassStatus &out);
bool gpu_bb_exchange_mass_enabled(const Context &ctx);
bool gpu_bb_exchange_mass_prepare(Context &ctx, std::string &error);

#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
bool gpu_bb_exchange_mass_create(
    const mfem::SparseMatrix &mass_ms,
    const mfem::SparseMatrix &stiffness_a,
    std::shared_ptr<GpuBbExchangeMassWorkspace> &workspace,
    TransferAudit &audit,
    std::string &error);

const FemGpuComponentField &gpu_bb_exchange_mass_direction(const GpuBbExchangeMassWorkspace &workspace);

// Solve the three-component SPD block system with cooperative device PCG.
// Only the terminal certificate returns to the host, never inner CG scalars.
bool gpu_bb_exchange_mass_solve(
    GpuBbExchangeMassWorkspace &workspace,
    const FemGpuComponentField &gradient,
    const FemGpuComponentField &direction,
    double step_m_per_a,
    void *compute_stream,
    TransferAudit &audit,
    std::string &error);

// Fused hot-loop variant: runs cooperative PCG, optional periodic projection,
// tangent projection with active-node mask, and <z, g>_{Ms M_lumped} reduction
// on compute_stream with a single terminal host sync.
bool gpu_bb_exchange_mass_solve_and_project(
    GpuBbExchangeMassWorkspace &workspace,
    const FemGpuComponentField &m_backup,
    const FemGpuComponentField &gradient,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *active_node_mask,
    bool has_periodic_reduced_nodes,
    const uint32_t *periodic_representative_nodes,
    double *scalar_workspace,
    double *scalar_result_slot,
    void *reduction_temp_storage,
    size_t reduction_temp_storage_bytes,
    int blocks,
    double step_m_per_a,
    void *compute_stream,
    TransferAudit &audit,
    double &out_direction_dot_gradient,
    std::string &error);

double gpu_bb_exchange_mass_last_relative_residual(
    const GpuBbExchangeMassWorkspace &workspace);
uint64_t gpu_bb_exchange_mass_last_iterations(
    const GpuBbExchangeMassWorkspace &workspace);
#endif
} // namespace fullmag::fem
