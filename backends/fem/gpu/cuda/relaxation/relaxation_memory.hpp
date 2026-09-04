#pragma once

/*
 * GPU CUDA relaxation memory module header.
 *
 * Declares allocation/free helpers for persistent relaxation device state.
 */

#include "gpu/cuda/relaxation/relaxation_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_relaxation_state_allocate(
    FemGpuRelaxationDeviceState &relaxation,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_relaxation_state_free(FemGpuRelaxationDeviceState &relaxation);

/* Resolve and publish one complete preconditioner setup transaction.  A
 * failed setup clears the active dispatch and leaves the state unusable until
 * a later successful setup; no partially configured object is published. */
bool gpu_relaxation_prepare_preconditioner(
    FemGpuRelaxationDeviceState &relaxation,
    const GpuRelaxationPreconditionerSetupRequest &request,
    std::string &error);

/* Apply the already resolved strategy to raw g and write z to a distinct
 * device field.  This function is hot-loop safe: it performs no setup,
 * allocation, host transfer, or host convergence test. */
bool gpu_relaxation_apply_preconditioner(
    FemGpuRelaxationDeviceState &relaxation,
    const FemGpuComponentField &gradient,
    FemGpuComponentField &preconditioned_gradient,
    uint64_t node_count,
    double exchange_weight,
    void *stream,
    std::string &error);

/* Enqueue the resolved device failure latch into the caller's existing
 * scalar/control packet.  It intentionally has no host readback of its own. */
bool gpu_relaxation_enqueue_preconditioner_failure(
    const FemGpuRelaxationDeviceState &relaxation,
    double *device_scalar_slot,
    void *stream,
    std::string &error);

const uint32_t *gpu_relaxation_preconditioner_failure_latch(
    const FemGpuRelaxationDeviceState &relaxation) noexcept;

} // namespace fullmag::fem
