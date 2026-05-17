#pragma once

#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Initialize native FEM MFEM device plan fields.
 *
 * Copies the ABI GPU device index and optional MFEM device-string override into
 * Context. Empty or null device strings clear stale overrides so a reused
 * Context follows the environment/default CPU policy for the new plan.
 */
void initialize_mfem_device_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan);

/*
 * Populate native FEM device-info cache.
 *
 * Publishes the resolved MFEM backend/device provenance into the public ABI
 * cache. Without the MFEM stack it reports the CPU scaffold; with MFEM it tags
 * CPU/GPU realizations and, when CUDA runtime support is built, fills CUDA
 * device and version metadata.
 */
void context_populate_device_info(Context &ctx);

const char *configured_mfem_device_string();
const char *configured_mfem_device_string(const Context &ctx);
bool is_gpu_device_string(const char *device);
bool mfem_device_requests_gpu();
bool mfem_device_requests_gpu(const Context &ctx);

} // namespace fullmag::fem
