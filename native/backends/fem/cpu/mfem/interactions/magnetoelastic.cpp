#include "cpu/mfem/interactions/magnetoelastic.hpp"

#include "context.hpp"

namespace fullmag::fem {

void initialize_magnetoelastic_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan)
{
    ctx.enable_magnetoelastic = plan.has_magnetoelastic != 0;
    ctx.mel_b1 = plan.mel_b1;
    ctx.mel_b2 = plan.mel_b2;
    ctx.mel_uniform_strain = plan.mel_uniform_strain != 0;
    ctx.mel_strain_voigt.clear();
    if (ctx.enable_magnetoelastic && plan.mel_strain_voigt != nullptr && plan.mel_strain_len > 0) {
        ctx.mel_strain_voigt.assign(
            plan.mel_strain_voigt,
            plan.mel_strain_voigt + static_cast<size_t>(plan.mel_strain_len));
    }
    ctx.mel_energy = 0.0;
}

/*
 * Compatibility translation unit for the prescribed-strain magnetoelastic
 * aggregate include surface. Plan import is kept here; field/energy computation
 * and H_eff addition live in dedicated modules.
 */

} // namespace fullmag::fem
