#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Synchronize and expose native FEM context state I/O.
 *
 * This module owns host/device magnetization readback, observable field copy
 * semantics, external magnetization upload, cache invalidation, and post-upload
 * field-buffer refresh. It keeps C ABI state I/O behavior out of context
 * construction and interaction modules.
 *
 * It does not compute fields, advance integrators, own snapshots, or publish
 * step metrics.
 */
bool context_sync_gpu_magnetization_to_host(Context &ctx, std::string &error);
int context_copy_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error);
int context_copy_linearization_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error);
int context_upload_magnetization_f64(
    Context &ctx,
    const double *m_xyz,
    uint64_t len,
    std::string &error);

} // namespace fullmag::fem
