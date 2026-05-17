#include "cpu/mfem/interactions/effective_field.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_field.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

#include <chrono>

namespace {

using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start)
{
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

class ScopedPhaseTimer {
public:
    explicit ScopedPhaseTimer(uint64_t *accumulator)
        : accumulator_(accumulator)
    {
        if (accumulator_ != nullptr) {
            start_ = SteadyClock::now();
        }
    }

    ~ScopedPhaseTimer()
    {
        if (accumulator_ != nullptr) {
            *accumulator_ += elapsed_ns(start_);
        }
    }

private:
    uint64_t *accumulator_ = nullptr;
    SteadyClock::time_point start_{};
};

} // namespace

namespace fullmag::fem {

bool has_any_field_or_direct_torque_term(const Context &ctx)
{
    return ctx.enable_exchange
        || ctx.enable_demag
        || ctx.has_external_field
        || ctx.enable_anisotropy
        || ctx.enable_dmi
        || ctx.enable_bulk_dmi
        || ctx.enable_cubic_anisotropy
        || ctx.has_oersted_cylinder
        || ctx.has_oersted_field
        || ctx.enable_magnetoelastic
        || ctx.has_zhang_li_stt
        || ctx.has_slonczewski_stt
        || (ctx.temperature > 0.0);
}

#if FULLMAG_HAS_MFEM_STACK
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
    if (ctx.enable_exchange) {
        h_ex_xyz.resize(m_xyz.size());
    } else {
        h_ex_xyz.assign(m_xyz.size(), 0.0);
    }
    if (ctx.enable_demag) {
        h_demag_xyz.resize(m_xyz.size());
    } else {
        h_demag_xyz.assign(m_xyz.size(), 0.0);
    }
    h_eff_xyz.resize(m_xyz.size());

    double exchange = 0.0;
    if (ctx.enable_exchange) {
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
    if (ctx.enable_demag) {
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
        if (ctx.enable_anisotropy) {
            compute_uniaxial_anisotropy_field(
                ctx, m_xyz, ctx.h_ani_xyz,
                &anisotropy_energy);
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_ani_xyz);
            }
        } else {
            ctx.h_ani_xyz.assign(m_xyz.size(), 0.0);
        }

        double dmi = 0.0;
        if (ctx.enable_dmi) {
            if (!compute_interfacial_dmi_field(
                    ctx, m_xyz, ctx.h_dmi_xyz, &dmi, error)) {
                return false;
            }
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_dmi_xyz);
            }
        }

        if (ctx.enable_cubic_anisotropy) {
            double cubic_energy = 0.0;
            compute_cubic_anisotropy_field(
                ctx, m_xyz, ctx.h_cubic_ani_xyz, &cubic_energy);
            anisotropy_energy += cubic_energy;
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_cubic_ani_xyz);
            }
        }

        double bulk_dmi = 0.0;
        if (ctx.enable_bulk_dmi) {
            if (!compute_bulk_dmi_field(
                    ctx, m_xyz, ctx.h_bulk_dmi_xyz, &bulk_dmi, error)) {
                return false;
            }
            if (!ctx.periodic_reduced_node.empty()) {
                project_static_periodic_aos(ctx, ctx.h_bulk_dmi_xyz);
            }
        }

        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            h_eff_xyz[i] = h_ex_xyz[i] + h_demag_xyz[i] +
                           ctx.h_ani_xyz[i] + ctx.h_dmi_xyz[i] +
                           ctx.h_cubic_ani_xyz[i];
        }
        add_zeeman_field(ctx, h_eff_xyz);

        if (ctx.enable_bulk_dmi && !ctx.h_bulk_dmi_xyz.empty()) {
            for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
                h_eff_xyz[i] += ctx.h_bulk_dmi_xyz[i];
            }
        }

        add_oersted_field(ctx, h_eff_xyz);

        if (ctx.temperature > 0.0) {
            refresh_thermal_brown_field(ctx);
            add_thermal_brown_field(ctx, h_eff_xyz);
        }

        double magnetoelastic_energy = 0.0;
        if (ctx.enable_magnetoelastic) {
            compute_magnetoelastic_field(ctx, m_xyz);
            magnetoelastic_energy = ctx.mel_energy;
            add_magnetoelastic_field(ctx, h_eff_xyz);
        }
        if (!ctx.periodic_reduced_node.empty()) {
            project_static_periodic_aos(ctx, h_eff_xyz);
        }
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }
        ctx.last_anisotropy_energy_joules = anisotropy_energy;
        ctx.last_dmi_energy_joules = dmi + bulk_dmi;
        ctx.last_magnetoelastic_energy_joules = magnetoelastic_energy;
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
