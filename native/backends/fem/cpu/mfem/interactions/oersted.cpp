#include "cpu/mfem/interactions/oersted.hpp"

#include "context.hpp"

namespace fullmag::fem {

void add_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (ctx.has_oersted_cylinder) {
        add_oersted_cylinder_field(ctx, h_eff_xyz);
        return;
    }
    add_explicit_oersted_field(ctx, h_eff_xyz);
}

} // namespace fullmag::fem
