/*
 * Magnetoelastic aggregate source contract.
 *
 * This source owns prescribed-strain magnetoelastic ABI plan import for enable
 * state, B1/B2 constants, uniform-strain mode, strain buffers, and runtime
 * strain upload. It does not compute B1/B2 H_mel/energy or add H_mel to H_eff.
 */
#include "cpu/mfem/interactions/magnetoelastic.hpp"

#include "context.hpp"
#include "gpu_state.hpp"

#include <limits>

namespace fullmag::fem {

void initialize_magnetoelastic_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan)
{
    ctx.magnetoelastic.enabled = plan.has_magnetoelastic != 0;
    ctx.magnetoelastic.b1 = plan.mel_b1;
    ctx.magnetoelastic.b2 = plan.mel_b2;
    ctx.magnetoelastic.uniform_strain = plan.mel_uniform_strain != 0;
    ctx.magnetoelastic.strain_voigt.clear();
    if (ctx.magnetoelastic.enabled && plan.mel_strain_voigt != nullptr && plan.mel_strain_len > 0) {
        ctx.magnetoelastic.strain_voigt.assign(
            plan.mel_strain_voigt,
            plan.mel_strain_voigt + static_cast<size_t>(plan.mel_strain_len));
    }
    ctx.magnetoelastic.energy_joules = 0.0;
}

bool upload_magnetoelastic_strain(
    Context &ctx,
    const double *strain_voigt,
    uint64_t len,
    bool uniform,
    std::string &error)
{
    if (strain_voigt == nullptr || len == 0) {
        error = "strain data pointer is null or length is zero";
        return false;
    }
    if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
        error = "strain data length exceeds host addressable size";
        return false;
    }

    ctx.magnetoelastic.uniform_strain = uniform;
    ctx.magnetoelastic.strain_voigt.assign(
        strain_voigt,
        strain_voigt + static_cast<size_t>(len));

    if (ctx.gpu_state.allocated && !ctx.magnetoelastic.uniform_strain) {
        if (!gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state,
                ctx.magnetoelastic.strain_voigt.data(),
                static_cast<uint64_t>(ctx.magnetoelastic.strain_voigt.size()),
                ctx.transfer_audit,
                error)) {
            return false;
        }
    }

    if (ctx.magnetoelastic.enabled) {
        compute_magnetoelastic_field(ctx, ctx.state.m_xyz);
    }
    return true;
}

} // namespace fullmag::fem
