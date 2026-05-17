#include "core/fem_field_buffers.hpp"

#include "context.hpp"

#include <cstddef>

namespace fullmag::fem {

void fill_zero_vector_field(std::vector<double> &buffer, uint32_t n_nodes) {
    buffer.assign(static_cast<size_t>(n_nodes) * 3u, 0.0);
}

void initialize_context_field_buffers(Context &ctx) {
    fill_zero_vector_field(ctx.h_ex_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_demag_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_ani_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_dmi_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_cubic_ani_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_bulk_dmi_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_mel_xyz, ctx.n_nodes);

    if (ctx.has_external_field) {
        ctx.h_eff_xyz = ctx.h_ext_xyz;
    } else {
        fill_zero_vector_field(ctx.h_eff_xyz, ctx.n_nodes);
    }
}

} // namespace fullmag::fem
