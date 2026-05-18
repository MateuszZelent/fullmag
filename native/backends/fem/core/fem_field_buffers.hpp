#pragma once

#include <cstdint>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Own FEM field buffer sizing and zero-initialization.
 *
 * The module sizes nodal AOS-3 field buffers and seeds the transitional
 * effective-field buffer from the Zeeman/external-field buffer when present.
 * It also owns transitional nodal scalar integration weights used by local
 * interaction energy tests and by the MFEM lumped-mass path.
 * Context remains the compatibility facade while this code moves toward the
 * documented FemFieldBuffers owner.
 *
 * It does not own mesh topology, material fields, state vectors, runtime
 * devices, integrators, or interaction physics.
 */
struct FemIntegrationWeightsRuntimeState {
    std::vector<double> mfem_lumped_mass;
};

void fill_zero_vector_field(std::vector<double> &buffer, uint32_t n_nodes);

void initialize_context_field_buffers(Context &ctx);

} // namespace fullmag::fem
