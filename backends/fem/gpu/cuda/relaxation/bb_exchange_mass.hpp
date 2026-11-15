#pragma once

#include "gpu/cuda/state/component_field.hpp"
#include <cstdint>
#include <memory>
#include <string>

namespace mfem { class SparseMatrix; }
struct fullmag_fem_gpu_bb_pcg_certificate_v1;
namespace fullmag::fem {
struct Context;
struct TransferAudit;
struct GpuPerformanceCounterState;
struct GpuBbExchangeMassWorkspace;
inline constexpr double kGpuBbCertificateRelativeTolerance = 1e-8;

// Numerical policy only: physical fields, energy, torque and Poisson
// certification do not use this operator.
bool gpu_bb_exchange_mass_enabled(const Context &ctx);
bool gpu_bb_exchange_mass_prepare(Context &ctx, std::string &error);
// Copy the existing terminal host record only; never query or touch the GPU.
void gpu_bb_exchange_mass_certificate(
    const Context &ctx, fullmag_fem_gpu_bb_pcg_certificate_v1 &certificate);

#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
bool gpu_bb_exchange_mass_create(
    const mfem::SparseMatrix &mass_ms,
    const mfem::SparseMatrix &stiffness_a,
    std::shared_ptr<GpuBbExchangeMassWorkspace> &workspace,
    TransferAudit &audit,
    std::string &error);

// Solve the three-component SPD block system with cooperative device PCG.
// Only the terminal certificate returns to the host, never inner CG scalars.
bool gpu_bb_exchange_mass_solve(
    GpuBbExchangeMassWorkspace &workspace,
    const FemGpuComponentField &gradient,
    const FemGpuComponentField &direction,
    double step_m_per_a,
    void *compute_stream,
    TransferAudit &audit,
    std::string &error, GpuPerformanceCounterState *performance = nullptr);

double gpu_bb_exchange_mass_last_relative_residual(
    const GpuBbExchangeMassWorkspace &workspace);
uint64_t gpu_bb_exchange_mass_last_iterations(
    const GpuBbExchangeMassWorkspace &workspace);
#endif
} // namespace fullmag::fem
