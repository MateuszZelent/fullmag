#pragma once

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Initialize and upload native FEM GPU state runtime buffers.
 *
 * This module owns the context bootstrap sequence for FemGpuState metadata,
 * optional device allocation, runtime coefficient upload, mesh geometry
 * upload, MFEM exchange device publication, and initial field uploads. It
 * keeps the plan/context construction path from owning residency mechanics.
 */
bool initialize_context_gpu_state(Context &ctx, std::string &error);

} // namespace fullmag::fem
