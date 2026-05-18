/*
 * Magnetoelastic aggregate source contract.
 *
 * This source owns prescribed-strain magnetoelastic ABI plan import for enable
 * state, B1/B2 constants, uniform-strain mode, and strain buffers. It does not compute B1/B2 H_mel/energy or add H_mel to H_eff.
 */
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
    ctx.magnetoelastic.energy_joules = 0.0;
}

} // namespace fullmag::fem
