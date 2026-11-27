#pragma once

#include <cstdint>
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

/*
 * Free the unconstrained Poisson stiffness form (A0) on the device-Hypre GPU
 * lane once the device Poisson setup has completed, and return its matrix
 * bytes. A0 only feeds the boundary-conditioned operator and the CPU solve;
 * the GPU lane then reads only poisson_bc_op (aliased by Hypre) and the
 * device operators. Every other lane and any incomplete setup keeps A0. A
 * later setup builds a new state with its own A0, and a failed rebuild
 * restores this state, whose GPU workspace still serves the run.
 */
uint64_t context_release_poisson_stiffness_after_device_setup(Context &ctx);

} // namespace fullmag::fem
