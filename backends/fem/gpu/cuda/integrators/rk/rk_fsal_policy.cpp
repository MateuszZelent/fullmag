/*
 * GPU CUDA RK FSAL policy source contract.
 *
 * This source owns the host-side policy deciding whether an accepted FSAL RHS
 * may be reused for the next GPU RK attempt. Stochastic Brown thermal fields
 * and callback-driven stage sources disable reuse: their exact source state is
 * owned by an external provider and cannot be proven equal from the endpoint
 * token alone. Frozen-spin projection also disables reuse because it can
 * modify the accepted endpoint after the derivative was evaluated. Periodic
 * projection remains fail-closed until the projected candidate/endpoint
 * identity is qualified.
 * Static/analytical fields remain eligible.
 */

#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"

#include "context.hpp"

#include <cstdint>

namespace fullmag::fem {

namespace {

uint64_t mix_signature(uint64_t seed, uint64_t value) noexcept
{
    seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6u) + (seed >> 2u);
    return seed;
}

} // namespace

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0 ||
        ctx.oersted.has_stage_callback ||
        ctx.stage_transport.has_stage_callback ||
        ctx.frozen_spins.enabled() ||
        ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes) {
        return false;
    }
    return true;
}

uint64_t gpu_rk_fsal_operator_signature(const Context &ctx) noexcept
{
    uint64_t signature = 0x6a09e667f3bcc909ULL;
    signature = mix_signature(signature, ctx.mesh.n_nodes);
    signature = mix_signature(signature, ctx.mesh.n_elements);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.base_plan.integrator));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.base_plan.precision));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.demag.enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.demag.realization));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.exchange.mfem.ready));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.dmi.interfacial_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.dmi.bulk_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.anisotropy.uniaxial_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.anisotropy.cubic_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.magnetoelastic.enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.zeeman.has_external_field));
    signature = mix_signature(signature, ctx.zeeman.regional_drive_revision);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.oersted.has_cylinder));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.oersted.has_explicit_field));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.gpu_state.device.legacy_exchange.nnz));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.gpu_state.device.legacy_exchange.periodic_reduced_nnz));
    return signature;
}

} // namespace fullmag::fem
