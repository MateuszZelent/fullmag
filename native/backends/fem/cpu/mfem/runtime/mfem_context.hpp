#pragma once

#include "fullmag_fem.h"

#include <string>

namespace mfem {
class Device;
}

namespace fullmag::fem {

struct Context;

/*
 * Runtime state for actual MFEM context selection handles.
 *
 * The state owns the selected CUDA device index observed during MFEM
 * initialization and the opaque mfem::Device handle used by the MFEM stack.
 * Mesh, field spaces, exchange operators, Poisson demag resources, and CUDA
 * streams stay in their dedicated follow-up runtime owners.
 */
struct MfemContextRuntimeState {
    int selected_device_index = -1;
    mfem::Device *device = nullptr;
};

/*
 * Initialize, publish, and destroy the native MFEM runtime context.
 *
 * This module owns MFEM device creation, mesh/FES/GridFunction allocation,
 * host-to-MFEM initialization of magnetization/material fields, exchange
 * operator bootstrap, legacy sparse exchange upload, and deterministic teardown
 * of MFEM-owned runtime pointers. It must not own physical interactions,
 * timestep integration, or step telemetry.
 */
#if FULLMAG_HAS_MFEM_STACK
bool context_initialize_mfem(Context &ctx, std::string &error);
bool context_upload_mfem_exchange_to_gpu_state(Context &ctx, std::string &error);
void context_destroy_mfem(Context &ctx);
#endif

} // namespace fullmag::fem
