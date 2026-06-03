#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Runtime state for native FEM MFEM device selection and public device info.
 *
 * The state owns the plan-provided GPU index, optional MFEM device-string
 * override, populated ABI device-info cache, and cache-valid flag used by the
 * public device-info endpoint.
 */
struct MfemDeviceRuntimeState {
    int32_t gpu_device_index = -1;
    std::string device_string_override;
    fullmag_fem_device_info device_info_cache{};
    bool device_info_valid = false;
};

/*
 * Initialize native FEM MFEM device plan fields.
 *
 * Copies the ABI GPU device index and optional MFEM device-string override into
 * Context. Empty or null device strings clear stale overrides so a reused
 * Context follows the environment/default CPU policy for the new plan.
 *
 * It does not allocate Context resources, bootstrap GPU state, execute steps,
 * or own availability policy.
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

/*
 * Return the current native FEM device-info snapshot.
 *
 * Context stores the ABI device-info cache populated by this module. This
 * helper owns the read boundary used by public C ABI snapshot endpoints.
 */
fullmag_fem_device_info device_info_snapshot(const Context &ctx);

const char *configured_mfem_device_string();
const char *configured_mfem_device_string(const Context &ctx);
bool is_gpu_device_string(const char *device);
bool mfem_device_requests_gpu();
bool mfem_device_requests_gpu(const Context &ctx);

} // namespace fullmag::fem
