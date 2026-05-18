/*
 * FEM field-buffers core source contract.
 *
 * This source owns nodal AoS field-buffer sizing, zero-initialization, and
 * startup seeding of the effective field from the external-field buffer. It does not import mesh topology, material fields, state vectors, runtime devices, or interaction physics.
 */

#include "core/fem_field_buffers.hpp"

#include "context.hpp"

#include <cstddef>

namespace fullmag::fem {

void fill_zero_vector_field(std::vector<double> &buffer, uint32_t n_nodes) {
    buffer.assign(static_cast<size_t>(n_nodes) * 3u, 0.0);
}

void initialize_context_field_buffers(Context &ctx) {
    fill_zero_vector_field(ctx.exchange.h_xyz, ctx.mesh.n_nodes);
    fill_zero_vector_field(ctx.demag.h_xyz, ctx.mesh.n_nodes);
    fill_zero_vector_field(ctx.anisotropy.h_uniaxial_xyz, ctx.mesh.n_nodes);
    fill_zero_vector_field(ctx.dmi.h_interfacial_xyz, ctx.mesh.n_nodes);
    fill_zero_vector_field(ctx.anisotropy.h_cubic_xyz, ctx.mesh.n_nodes);
    fill_zero_vector_field(ctx.dmi.h_bulk_xyz, ctx.mesh.n_nodes);
    fill_zero_vector_field(ctx.magnetoelastic.h_xyz, ctx.mesh.n_nodes);

    if (ctx.zeeman.has_external_field) {
        ctx.effective_field.h_xyz = ctx.zeeman.h_ext_xyz;
    } else {
        fill_zero_vector_field(ctx.effective_field.h_xyz, ctx.mesh.n_nodes);
    }
}

} // namespace fullmag::fem
