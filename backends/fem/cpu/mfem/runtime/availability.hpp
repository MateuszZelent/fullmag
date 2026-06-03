#pragma once

#include "fullmag_fem.h"

namespace fullmag::fem {

/*
 * Query native FEM CPU/GPU runtime availability.
 *
 * This runtime module owns lane availability policy for the native FEM backend:
 * MFEM stack presence, CUDA runtime/device visibility, MFEM CUDA support, CEED
 * requests, selected GPU index parsing, lane reason strings, and legacy
 * availability mirror fields. The C ABI layer only copies the returned
 * snapshot to callers.
 *
 * It does not initialize MFEM contexts, choose devices, manage GPU state, or
 * execute solver steps.
 */
fullmag_fem_availability_info query_availability();

} // namespace fullmag::fem
