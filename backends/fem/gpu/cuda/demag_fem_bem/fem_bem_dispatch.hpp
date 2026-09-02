#pragma once

/*
 * Lightweight dispatch surface for the strict GPU Fredkin-Koehler runtime.
 *
 * Keep CUDA RK translation units independent of the MFEM implementation
 * headers owned by fem_bem.hpp.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_demag_fem_bem_initialize(Context &ctx, std::string &error);
void gpu_demag_fem_bem_destroy(Context &ctx);
bool gpu_demag_fem_bem_ready(const Context &ctx);
uint64_t gpu_demag_fem_bem_device_bytes(const Context &ctx);
const char *gpu_demag_fem_bem_operator_mode(const Context &ctx);

bool compute_device_demag_fem_bem_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    bool reset_initial_solution,
    bool field_and_recovered_energy,
    std::string &reason);

bool recover_device_demag_fem_bem_field_device(
    Context &ctx,
    void *raw_stream,
    std::string &reason);

} // namespace fullmag::fem
