/*
 * Exchange field-compute source contract.
 *
 * This source owns component upload, exchange operator application, exchange
 * energy accumulation, nonmagnetic-node zeroing, optional H_eff export, and
 * transfer-audit scoping. It does not assemble exchange operators or own runtime refresh.
 */
#include "cpu/mfem/interactions/exchange_field.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/operator_dependency.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/interactions/exchange_mass_projection.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
constexpr int kInterruptPollStride = 256;

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool allow_interrupt,
    std::string &error)
{
    if (!ctx.mfem_context.ready) {
        error = "MFEM exchange requested before MFEM context initialization";
        return false;
    }
    if (!ctx.exchange.mfem.operator_lifecycle.setup_complete) {
        error = "MFEM exchange operator dependencies are invalid; setup must be rebuilt before apply";
        return false;
    }
    auto *mesh = ctx.mfem_context.mesh;
    if (mesh == nullptr) {
        error = "MFEM exchange operator dependencies cannot be checked without a mesh";
        return false;
    }
    const auto current_key = make_exchange_operator_dependency_key(
        ctx,
        *mesh,
        mfem::Device::IsEnabled());
    if (current_key != ctx.exchange.mfem.operator_lifecycle.active_key) {
        ++ctx.exchange.mfem.operator_lifecycle.invalidation_count;
        ctx.exchange.mfem.operator_lifecycle.setup_complete = false;
        ctx.exchange.mfem.ready = false;
        error = "MFEM exchange operator dependencies changed; setup must be rebuilt before apply";
        return false;
    }

    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.mass_form);
    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_mz);
    auto *gf_ms = static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_ms);
    auto *inv_lumped_mass = static_cast<mfem::Vector *>(ctx.exchange.mfem.inv_lumped_mass);
    auto *tmp_vec = static_cast<mfem::Vector *>(ctx.exchange.mfem.tmp_vec);
    auto *out_vec = static_cast<mfem::Vector *>(ctx.exchange.mfem.out_vec);
    if (exchange_form == nullptr || gf_mx == nullptr || gf_my == nullptr || gf_mz == nullptr ||
        gf_ms == nullptr || inv_lumped_mass == nullptr || tmp_vec == nullptr || out_vec == nullptr) {
        error = "MFEM exchange scaffold is missing one or more operator/device buffers";
        return false;
    }
    if (ctx.exchange.mfem.use_consistent_mass && mass_form == nullptr) {
        error = "MFEM mass form is required for consistent-mass exchange but is null";
        return false;
    }

    TransferAuditScope exchange_audit_scope(
        ctx.transfer_audit.audit,
        TransferAuditScopeKind::ExchangeInterop);

    if (!copy_local_node_aos_to_mfem_state(ctx, m_xyz, error)) {
        error = "MFEM exchange state adapter failed: " + error;
        return false;
    }

    double exchange_energy_accum = 0.0;
    double component_energy = 0.0;

    if (!apply_exchange_component_mass_projection(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_mx,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.exchange.mfem.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.exchange.mfem.h_x,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    component_energy = 0.0;
    if (!apply_exchange_component_mass_projection(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_my,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.exchange.mfem.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.exchange.mfem.h_y,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    component_energy = 0.0;
    if (!apply_exchange_component_mass_projection(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_mz,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.exchange.mfem.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.exchange.mfem.h_z,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    pack_components_to_aos(ctx.exchange.mfem.h_x, ctx.exchange.mfem.h_y, ctx.exchange.mfem.h_z, h_ex_xyz);

    if (!ctx.mesh.magnetic_node_mask.empty()) {
        for (size_t i = 0; i < ctx.mesh.magnetic_node_mask.size(); ++i) {
            if (allow_interrupt &&
                i > 0 &&
                (i % static_cast<size_t>(kInterruptPollStride)) == 0 &&
                poll_interrupt(ctx)) {
                return false;
            }
            if (ctx.mesh.magnetic_node_mask[i] == 0u) {
                const size_t base = i * 3u;
                h_ex_xyz[base + 0u] = 0.0;
                h_ex_xyz[base + 1u] = 0.0;
                h_ex_xyz[base + 2u] = 0.0;
            }
        }
    }

    if (h_eff_xyz != nullptr) {
        h_eff_xyz->resize(h_ex_xyz.size());
        if (ctx.zeeman.has_external_field) {
            for (size_t i = 0; i < h_ex_xyz.size(); ++i) {
                (*h_eff_xyz)[i] = h_ex_xyz[i] + ctx.zeeman.h_ext_xyz[i];
            }
        } else {
            *h_eff_xyz = h_ex_xyz;
        }
    }

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange_energy_accum;
    }

    return true;
}
#endif

} // namespace fullmag::fem
