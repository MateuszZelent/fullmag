/*
 * GPU CUDA RK FSAL policy source contract.
 *
 * This source owns the host-side policy deciding whether an accepted FSAL RHS
 * may be reused as k[0] for the next GPU RK attempt (`gpu_rk_rhs_allows_fsal_k0_reuse`)
 * and whether RK23/RK45 may bypass the post-normalization final RHS refresh via
 * the tableau endpoint cache (`gpu_rk_allows_endpoint_rhs_shortcut`).
 *
 * Stochastic Brown thermal fields, callback-driven stage sources, discontinuous
 * pulse drives, and host-expression waveforms fail closed and disable reuse.
 * Frozen-spin projection and periodic-reduced meshes remain eligible for FSAL
 * k[0] reuse after accepted-step projection/normalization, while still disabling
 * the RK23/RK45 endpoint RHS shortcut.
 */

#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"

#include "context.hpp"

#include <cstdint>
#include <cstring>

namespace fullmag::fem {

namespace {

uint64_t mix_signature(uint64_t seed, uint64_t value) noexcept
{
    seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6u) + (seed >> 2u);
    return seed;
}

uint64_t mix_double(uint64_t seed, double value) noexcept
{
    // Normalize -0.0 to +0.0 so semantically equal zero parameters hash identically.
    if (value == 0.0) {
        value = 0.0;
    }
    uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    return mix_signature(seed, bits);
}

bool waveform_kind_is_discontinuous_or_host(uint32_t kind) noexcept
{
    switch (kind) {
    case FULLMAG_FEM_TIME_CONSTANT:
    case FULLMAG_FEM_TIME_SINUSOIDAL:
    case FULLMAG_FEM_TIME_PIECEWISE_LINEAR:
    case FULLMAG_FEM_TIME_SINC_PULSE:
        return false;
    case FULLMAG_FEM_TIME_PULSE:
    case FULLMAG_FEM_TIME_HOST_EXPRESSION:
    default:
        return true;
    }
}

} // namespace

bool gpu_rk_has_discontinuous_or_host_drive(const Context &ctx)
{
    for (const auto &drive : ctx.zeeman.regional_drives) {
        if (waveform_kind_is_discontinuous_or_host(drive.waveform.kind)) {
            return true;
        }
    }
    // Oersted time_dep_kind: 0 = constant, 1 = sinusoidal, 2 = pulse (step jump).
    if (ctx.oersted.time_dep_kind >= FULLMAG_FEM_TIME_PULSE) {
        return true;
    }
    if (waveform_kind_is_discontinuous_or_host(ctx.sot.envelope_kind)) {
        return true;
    }
    return false;
}

bool gpu_rk_rhs_allows_fsal_k0_reuse(const Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0 ||
        ctx.oersted.has_stage_callback ||
        ctx.stage_transport.has_stage_callback ||
        gpu_rk_has_discontinuous_or_host_drive(ctx)) {
        return false;
    }
    return true;
}

bool gpu_rk_allows_endpoint_rhs_shortcut(const Context &ctx)
{
    return gpu_rk_rhs_allows_fsal_k0_reuse(ctx) &&
        !ctx.frozen_spins.enabled() &&
        !ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes;
}

bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)
{
    return gpu_rk_rhs_allows_fsal_k0_reuse(ctx);
}

uint64_t gpu_rk_fsal_operator_signature(const Context &ctx) noexcept
{
    uint64_t signature = 0x6a09e667f3bcc909ULL;
    signature = mix_signature(signature, ctx.mesh.n_nodes);
    signature = mix_signature(signature, ctx.mesh.n_elements);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.base_plan.integrator));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.base_plan.precision));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.base_plan.precession_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.demag.enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.demag.realization));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.exchange.mfem.ready));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.dmi.interfacial_enabled));
    signature = mix_double(signature, ctx.dmi.interfacial_D);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.dmi.rotated_interfacial_enabled));
    signature = mix_double(signature, ctx.dmi.rotated_interfacial_D);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.dmi.bulk_enabled));
    signature = mix_double(signature, ctx.dmi.bulk_D);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.anisotropy.uniaxial_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.anisotropy.cubic_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.magnetoelastic.enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.zeeman.has_external_field));
    signature = mix_double(signature, ctx.zeeman.external_field_am[0]);
    signature = mix_double(signature, ctx.zeeman.external_field_am[1]);
    signature = mix_double(signature, ctx.zeeman.external_field_am[2]);
    signature = mix_double(signature, ctx.zeeman.stage_start_time_s);
    signature = mix_signature(signature, ctx.zeeman.regional_drive_revision);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.oersted.has_cylinder));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.oersted.has_explicit_field));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.oersted.time_dep_kind));
    signature = mix_double(signature, ctx.oersted.current);
    signature = mix_double(signature, ctx.oersted.time_dep_freq);
    signature = mix_double(signature, ctx.oersted.time_dep_phase);
    signature = mix_double(signature, ctx.oersted.time_dep_offset);
    signature = mix_double(signature, ctx.oersted.time_dep_t_on);
    signature = mix_double(signature, ctx.oersted.time_dep_t_off);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.stt.zhang_li_enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.stt.slonczewski_enabled));
    signature = mix_double(signature, ctx.stt.current_density_am2[0]);
    signature = mix_double(signature, ctx.stt.current_density_am2[1]);
    signature = mix_double(signature, ctx.stt.current_density_am2[2]);
    signature = mix_double(signature, ctx.stt.degree);
    signature = mix_double(signature, ctx.stt.beta);
    signature = mix_double(signature, ctx.stt.spin_polarization[0]);
    signature = mix_double(signature, ctx.stt.spin_polarization[1]);
    signature = mix_double(signature, ctx.stt.spin_polarization[2]);
    signature = mix_double(signature, ctx.stt.lambda);
    signature = mix_double(signature, ctx.stt.epsilon_prime);
    signature = mix_double(signature, ctx.stt.free_layer_thickness);
    signature = mix_double(signature, ctx.stt.current_sign);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.stt.formula_version));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.stt.realization_version));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.stt.operator_version));
    signature = mix_double(signature, ctx.stt.stack_normal[0]);
    signature = mix_double(signature, ctx.stt.stack_normal[1]);
    signature = mix_double(signature, ctx.stt.stack_normal[2]);
    signature = mix_double(signature, ctx.stt.lande_g);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.sot.enabled));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.sot.formula_version));
    signature = mix_double(signature, ctx.sot.current_density_am2);
    signature = mix_double(signature, ctx.sot.xi_dl);
    signature = mix_double(signature, ctx.sot.xi_fl);
    signature = mix_double(signature, ctx.sot.thickness);
    signature = mix_double(signature, ctx.sot.envelope_value);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.sot.envelope_kind));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.sot.envelope_time_origin));
    signature = mix_double(signature, ctx.sot.envelope_amplitude);
    signature = mix_double(signature, ctx.sot.envelope_frequency_hz);
    signature = mix_double(signature, ctx.sot.envelope_phase_rad);
    signature = mix_double(signature, ctx.sot.envelope_offset);
    signature = mix_double(signature, ctx.sot.envelope_t_on_s);
    signature = mix_double(signature, ctx.sot.envelope_t_off_s);
    signature = mix_double(signature, ctx.sot.envelope_center_s);
    signature = mix_double(signature, ctx.sot.envelope_bandwidth_hz);
    signature = mix_double(signature, ctx.sot.sigma[0]);
    signature = mix_double(signature, ctx.sot.sigma[1]);
    signature = mix_double(signature, ctx.sot.sigma[2]);
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.frozen_spins.enabled()));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.frozen_spins.frozen_count()));
    signature = mix_signature(signature, ctx.gpu_state.device.relaxation.state_generation);
    signature = mix_signature(
        signature,
        static_cast<uint64_t>(ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.gpu_state.device.legacy_exchange.nnz));
    signature = mix_signature(signature, static_cast<uint64_t>(ctx.gpu_state.device.legacy_exchange.periodic_reduced_nnz));
    return signature;
}

void gpu_rk_retain_restored_fsal_on_retry(Context &ctx)
{
    auto &rk = ctx.gpu_state.device.rk;
    rk.fsal_valid = rk.fsal_valid && gpu_rk_rhs_allows_fsal_k0_reuse(ctx);
}

} // namespace fullmag::fem
