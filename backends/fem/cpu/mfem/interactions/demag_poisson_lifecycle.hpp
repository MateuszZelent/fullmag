#pragma once

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Initialize the native Poisson-demag MFEM lifecycle.
 *
 * This module owns allocation and readiness transitions for Poisson-demag MFEM
 * lifecycle resources.
 * This allocates the scalar potential FE collection/space, Poisson bilinear
 * form, potential grid function, boundary-conditioned operator, periodic
 * reduction, RHS workspace, solution vector, and recovery workspace.
 * On the device-Hypre GPU lane it frees the Poisson bilinear form (A0) as soon
 * as the boundary-conditioned operator is built, because nothing else on that
 * lane reads A0; every other lane keeps it.
 * It does not assemble per-step RHS, solve Poisson, recover fields, compute energy, or publish telemetry.
 */
bool context_initialize_poisson(Context &ctx, std::string &error);

/*
 * Destroy all native Poisson-demag MFEM lifecycle resources.
 *
 * This module owns teardown ordering for Poisson-demag MFEM lifecycle
 * resources.
 * Cached Hypre solver objects are deleted before the matrix they reference.
 * The function clears transitional Context handles and marks Poisson demag as
 * not ready.
 */
void context_destroy_poisson(Context &ctx);

} // namespace fullmag::fem
