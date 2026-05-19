/*
 * Effective-field composition source contract.
 *
 * This source owns the field/direct-torque enablement gate, eager initial
 * effective-field refresh policy, top-level H_eff composition, periodic
 * projection of composed local fields, and last-energy bookkeeping for local
 * interaction modules. It does not assemble exchange operators, implement demag solvers, define individual interaction physics, own state I/O, or publish step metrics.
 */

#include "cpu/mfem/interactions/effective_field.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_field.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/exchange_runtime.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/phase_timings.hpp"
#include "fem_common.hpp"

namespace fullmag::fem {

bool has_any_field_or_direct_torque_term(const Context &ctx)
{
    return ctx.exchange.enabled
        || ctx.demag.enabled
        || ctx.zeeman.has_external_field
        || ctx.anisotropy.uniaxial_enabled
        || ctx.dmi.interfacial_enabled
        || ctx.dmi.bulk_enabled
        || ctx.anisotropy.cubic_enabled
        || ctx.oersted.has_cylinder
        || ctx.oersted.has_explicit_field
        || ctx.magnetoelastic.enabled
        || ctx.stt.zhang_li_enabled
        || ctx.stt.slonczewski_enabled
        || (ctx.thermal_brown.temperature > 0.0);
}

#if FULLMAG_HAS_MFEM_STACK
bool refresh_initial_effective_field_from_plan(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (plan.eager_initial_effective_field == 0) {
        return true;
    }
    if (!ctx.exchange.enabled && !ctx.demag.enabled) {
        return true;
    }
    return context_refresh_exchange_field_mfem(ctx, error);
}

bool compute_effective_fields_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> &h_demag_xyz,
    std::vector<double> &h_eff_xyz,
    double *exchange_energy,
    double *demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    if (ctx.exchange.enabled) {
        h_ex_xyz.resize(m_xyz.size());
    } else {
        h_ex_xyz.assign(m_xyz.size(), 0.0);
    }
    if (ctx.demag.enabled) {
        h_demag_xyz.resize(m_xyz.size());
    } else {
        h_demag_xyz.assign(m_xyz.size(), 0.0);
    }
    h_eff_xyz.resize(m_xyz.size());

    double exchange = 0.0;
    if (ctx.exchange.enabled) {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->exchange_wall_time_ns : nullptr);
        if (!compute_exchange_for_magnetization(
                ctx,
                m_xyz,
                h_ex_xyz,
                nullptr,
                exchange_energy != nullptr ? &exchange : nullptr,
                allow_interrupt,
                error))
        {
            return false;
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
    }

    double demag = 0.0;
    if (ctx.demag.enabled) {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->demag.wall_time_ns : nullptr);
        if (!compute_demag_field_for_magnetization(
                ctx, m_xyz, h_demag_xyz, demag, allow_interrupt, timings, error)) {
            return false;
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
    }

    {
        ScopedPhaseTimer timer(timings != nullptr ? &timings->extra_energy_wall_time_ns : nullptr);
        double anisotropy_energy = 0.0;
        if (ctx.anisotropy.uniaxial_enabled) {
            compute_uniaxial_anisotropy_field(
                ctx, m_xyz, ctx.anisotropy.h_uniaxial_xyz,
                &anisotropy_energy);
            if (!ctx.mesh.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.anisotropy.h_uniaxial_xyz);
            }
        } else {
            ctx.anisotropy.h_uniaxial_xyz.assign(m_xyz.size(), 0.0);
        }

        double dmi = 0.0;
        if (ctx.dmi.interfacial_enabled) {
            if (!compute_interfacial_dmi_field(
                    ctx, m_xyz, ctx.dmi.h_interfacial_xyz, &dmi, error)) {
                return false;
            }
            if (!ctx.mesh.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.dmi.h_interfacial_xyz);
            }
        } else {
            ctx.dmi.h_interfacial_xyz.assign(m_xyz.size(), 0.0);
        }

        if (ctx.anisotropy.cubic_enabled) {
            double cubic_energy = 0.0;
            compute_cubic_anisotropy_field(
                ctx, m_xyz, ctx.anisotropy.h_cubic_xyz, &cubic_energy);
            anisotropy_energy += cubic_energy;
            if (!ctx.mesh.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.anisotropy.h_cubic_xyz);
            }
        } else {
            ctx.anisotropy.h_cubic_xyz.assign(m_xyz.size(), 0.0);
        }

        double bulk_dmi = 0.0;
        if (ctx.dmi.bulk_enabled) {
            if (!compute_bulk_dmi_field(
                    ctx, m_xyz, ctx.dmi.h_bulk_xyz, &bulk_dmi, error)) {
                return false;
            }
            if (!ctx.mesh.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.dmi.h_bulk_xyz);
            }
        } else {
            ctx.dmi.h_bulk_xyz.assign(m_xyz.size(), 0.0);
        }

        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            h_eff_xyz[i] = h_ex_xyz[i] + h_demag_xyz[i] +
                           ctx.anisotropy.h_uniaxial_xyz[i] + ctx.dmi.h_interfacial_xyz[i] +
                           ctx.anisotropy.h_cubic_xyz[i];
        }
        add_zeeman_field(ctx, h_eff_xyz);

        if (ctx.dmi.bulk_enabled && !ctx.dmi.h_bulk_xyz.empty()) {
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += ctx.dmi.h_bulk_xyz[i];
            }
        }

        add_oersted_field(ctx, h_eff_xyz);

        if (ctx.thermal_brown.temperature > 0.0) {
            refresh_thermal_brown_field(ctx);
            add_thermal_brown_field(ctx, h_eff_xyz);
        }

        if (ctx.magnetoelastic.enabled) {
            compute_magnetoelastic_field(ctx, m_xyz);
            add_magnetoelastic_field(ctx, h_eff_xyz);
        } else {
            ctx.magnetoelastic.energy_joules = 0.0;
        }
        if (!ctx.mesh.periodic_reduced_node.empty()) {
            project_static_periodic_aos(ctx, h_eff_xyz);
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
        ctx.anisotropy.energy_joules = anisotropy_energy;
        ctx.dmi.energy_joules = dmi + bulk_dmi;
    }

    update_demag_poisson_visual_effective_field(ctx, h_eff_xyz, h_demag_xyz);

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange;
    }
    if (demag_energy != nullptr) {
        *demag_energy = demag;
    }

    return true;
}
#endif

} // namespace fullmag::fem
