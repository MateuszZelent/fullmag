#pragma once

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Initialize the native Poisson-demag MFEM lifecycle.
 *
 * This allocates the scalar potential FE collection/space, Poisson bilinear
 * form, potential grid function, boundary-conditioned operator, periodic
 * reduction, RHS workspace, solution vector, and recovery workspace.
 */
bool context_initialize_poisson(Context &ctx, std::string &error);

/*
 * Destroy all native Poisson-demag MFEM lifecycle resources.
 *
 * Cached Hypre solver objects are deleted before the matrix they reference.
 * The function clears transitional Context handles and marks Poisson demag as
 * not ready.
 */
void context_destroy_poisson(Context &ctx);

} // namespace fullmag::fem
