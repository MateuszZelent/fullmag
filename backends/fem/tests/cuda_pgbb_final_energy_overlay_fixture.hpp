#pragma once

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats_publication.hpp"

#include <array>
#include <limits>
#include <string>

namespace fullmag::fem::test {

inline void gpu_pgbb_final_energy_overlay_contract(
    void (*check)(bool, const char *))
{
    using namespace fullmag::fem;
    std::array<double, kGpuFinalScalarSlots> readback{};
    std::array<double, kGpuFinalScalarSlots> accepted_terms{};
    std::array<bool, kGpuFinalScalarSlots> energy_term_mask{};
    for (size_t i = 0; i < kGpuFinalScalarSlots; ++i) {
        readback[i] = -1000.0 - static_cast<double>(i);
        accepted_terms[i] = 2000.0 + static_cast<double>(i);
    }

    constexpr std::array<GpuFinalScalarSlot, 9> energy_slots{
        GpuFinalScalarSlot::ExchangeEnergy,
        GpuFinalScalarSlot::DemagEnergy,
        GpuFinalScalarSlot::ExternalEnergy,
        GpuFinalScalarSlot::DriveEnergy,
        GpuFinalScalarSlot::DmiEnergy,
        GpuFinalScalarSlot::BulkDmiEnergy,
        GpuFinalScalarSlot::AnisotropyEnergy,
        GpuFinalScalarSlot::CubicAnisotropyEnergy,
        GpuFinalScalarSlot::MagnetoelasticEnergy,
    };
    for (size_t i = 0; i < energy_slots.size(); ++i) {
        const auto index = static_cast<size_t>(energy_slots[i]);
        accepted_terms[index] = 0.25 + static_cast<double>(i);
        energy_term_mask[index] = true;
    }
    accepted_terms[static_cast<size_t>(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)] =
        std::numeric_limits<double>::quiet_NaN();

    readback[static_cast<size_t>(GpuFinalScalarSlot::MaxRhs)] = 0.5;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MaxHEff)] = 2.0;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MaxHDemag)] = 3.0;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MaxTorque)] = 7.0;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MxSum)] = 6.0;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MySum)] = 8.0;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MzSum)] = 10.0;
    readback[static_cast<size_t>(GpuFinalScalarSlot::MomentWeight)] = 2.0;
    const auto fresh_readback = readback;

    std::string reason;
    check(gpu_rk_overlay_final_energy_terms(
              readback, accepted_terms, energy_term_mask, reason),
          "finite accepted energy terms overlay the resident scalar slots");
    for (const auto slot : energy_slots) {
        const auto index = static_cast<size_t>(slot);
        check(readback[index] == accepted_terms[index],
              "every published energy slot comes from the accepted trial snapshot");
    }
    check(readback[static_cast<size_t>(GpuFinalScalarSlot::MaxRhs)] ==
                  fresh_readback[static_cast<size_t>(GpuFinalScalarSlot::MaxRhs)] &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MaxHEff)] ==
                  fresh_readback[static_cast<size_t>(GpuFinalScalarSlot::MaxHEff)] &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MaxHDemag)] ==
                  fresh_readback[static_cast<size_t>(GpuFinalScalarSlot::MaxHDemag)] &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MaxTorque)] == 7.0 &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MxSum)] == 6.0 &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MySum)] == 8.0 &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MzSum)] == 10.0 &&
              readback[static_cast<size_t>(GpuFinalScalarSlot::MomentWeight)] == 2.0,
          "energy overlay leaves fresh torque and moment reduction slots intact");
    check(readback[static_cast<size_t>(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)] ==
              fresh_readback[static_cast<size_t>(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)],
          "unpublished Robin diagnostic slot is not treated as an energy contribution");

    Context ctx{};
    ctx.exchange.enabled = true;
    ctx.demag.enabled = true;
    ctx.zeeman.has_external_field = true;
    ctx.zeeman.regional_drives.emplace_back();
    ctx.dmi.interfacial_enabled = true;
    ctx.dmi.bulk_enabled = true;
    ctx.anisotropy.uniaxial_enabled = true;
    ctx.anisotropy.cubic_enabled = true;
    ctx.magnetoelastic.enabled = true;
    fullmag_fem_step_stats stats{};
    gpu_rk_publish_final_step_stats(ctx, readback, stats);
    check(stats.exchange_energy_joules == 0.25 &&
              stats.demag_energy_joules == 1.25 &&
              stats.external_energy_joules == 2.25 &&
              stats.drive_energy_joules == 3.25 &&
              stats.dmi_energy_joules == 9.5 &&
              stats.anisotropy_energy_joules == 13.5 &&
              stats.magnetoelastic_energy_joules == 8.25 &&
              stats.total_energy_joules == 38.25,
          "published energy components and total come from the accepted snapshot");
    check(stats.max_torque_Apm == 7.0,
          "published torque remains from the fresh observable reduction");
    check(stats.mx == 3.0 && stats.my == 4.0 && stats.mz == 5.0,
          "published magnetization moment remains from the fresh reduction");

    auto invalid_terms = accepted_terms;
    invalid_terms[static_cast<size_t>(GpuFinalScalarSlot::MagnetoelasticEnergy)] =
        std::numeric_limits<double>::quiet_NaN();
    const auto before_invalid_overlay = readback;
    reason.clear();
    check(!gpu_rk_overlay_final_energy_terms(
              readback, invalid_terms, energy_term_mask, reason),
          "non-finite accepted energy terms remain a finalization failure");
    check(!reason.empty(), "non-finite energy overlay reports a reason");
    for (size_t i = 0; i < readback.size(); ++i) {
        check(readback[i] == before_invalid_overlay[i],
              "failed energy validation does not partially alter publication scalars");
    }
}

} // namespace fullmag::fem::test
