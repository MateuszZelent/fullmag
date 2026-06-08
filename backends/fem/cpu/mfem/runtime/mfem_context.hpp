#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace mfem {
class Coefficient;
class Device;
class FiniteElementCollection;
class FiniteElementSpace;
class GridFunction;
class Mesh;
}

namespace fullmag::fem {

struct Context;

/*
 * Runtime state for actual MFEM context selection handles.
 *
 * The state owns the selected CUDA device index observed during MFEM
 * initialization, the mfem::Device handle, the base MFEM mesh/FES/GridFunction
 * lifecycle handles, and reusable host component buffers used to initialize or
 * refresh the magnetization GridFunctions. Exchange operators, Poisson demag
 * resources, and CUDA streams stay in their dedicated runtime owners.
 */
struct MfemContextRuntimeState {
    int selected_device_index = -1;
    mfem::Device *device = nullptr;
    std::vector<double> m_x;
    std::vector<double> m_y;
    std::vector<double> m_z;
    mfem::Mesh *mesh = nullptr;
    mfem::FiniteElementCollection *fec = nullptr;
    mfem::FiniteElementSpace *fes = nullptr;
    mfem::GridFunction *gf_mx = nullptr;
    mfem::GridFunction *gf_my = nullptr;
    mfem::GridFunction *gf_mz = nullptr;
    mfem::GridFunction *gf_a = nullptr;
    mfem::GridFunction *gf_ms = nullptr;
    mfem::Coefficient *a_coeff = nullptr;
    mfem::Coefficient *ms_coeff = nullptr;
    bool ready = false;
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
