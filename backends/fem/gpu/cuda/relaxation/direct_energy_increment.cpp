/*
 * Shared direct energy-increment evaluation for native FEM CUDA minimizers.
 */

#include "gpu/cuda/relaxation/direct_energy_increment.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include "context.hpp"
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <string>

namespace fullmag::fem {
namespace {

bool checked_add_scaled(size_t &value, size_t count, size_t scale)
{
    if (count != 0u && scale > (std::numeric_limits<size_t>::max() - value) / count) {
        return false;
    }
    value += count * scale;
    return true;
}

constexpr size_t kDirectLocalDeltaTailSlot = 0;
constexpr size_t kDirectLocalAbsoluteTailSlot = 1;
constexpr size_t kDirectDemagDeltaTailSlot = 2;
constexpr size_t kDirectDemagAbsoluteTailSlot = 3;
constexpr size_t kDirectExchangeDeltaTailSlot = 4;
constexpr size_t kDirectExchangeAbsoluteTailSlot = 5;
constexpr size_t kDirectInterfacialDmiDeltaTailSlot = 6;
constexpr size_t kDirectInterfacialDmiAbsoluteTailSlot = 7;
constexpr size_t kDirectBulkDmiDeltaTailSlot = 8;
constexpr size_t kDirectBulkDmiAbsoluteTailSlot = 9;
constexpr size_t kDirectActiveStateChangeTailSlot = 10;
constexpr size_t kDirectRepresentableChordTailSlot = 11;
constexpr size_t kDirectEnergyTailSlots = 12;
static_assert(
    kGpuFinalScalarSlots + kDirectEnergyTailSlots <= FEM_GPU_SCALAR_RESULT_SLOTS,
    "GPU direct energy batch must fit in the shared scalar result buffer");

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

bool reduce_scalar_sum(
    Context &ctx,
    cudaStream_t stream,
    const double *block_values,
    int block_count,
    double *result_slot,
    const char *operation,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    fullmag_cuda_device_sum(
        block_values,
        block_count,
        result_slot,
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    return cuda_launch_ok(operation, reason);
}

const char *gpu_final_scalar_slot_name(GpuFinalScalarSlot slot)
{
    switch (slot) {
    case GpuFinalScalarSlot::MaxRhs:
        return "MaxRhs";
    case GpuFinalScalarSlot::ExchangeEnergy:
        return "ExchangeEnergy";
    case GpuFinalScalarSlot::DemagEnergy:
        return "DemagEnergy";
    case GpuFinalScalarSlot::DemagRobinBoundaryEnergy:
        return "DemagRobinBoundaryEnergy";
    case GpuFinalScalarSlot::ExternalEnergy:
        return "ExternalEnergy";
    case GpuFinalScalarSlot::DriveEnergy:
        return "DriveEnergy";
    case GpuFinalScalarSlot::DmiEnergy:
        return "DmiEnergy";
    case GpuFinalScalarSlot::BulkDmiEnergy:
        return "BulkDmiEnergy";
    case GpuFinalScalarSlot::AnisotropyEnergy:
        return "AnisotropyEnergy";
    case GpuFinalScalarSlot::CubicAnisotropyEnergy:
        return "CubicAnisotropyEnergy";
    case GpuFinalScalarSlot::MagnetoelasticEnergy:
        return "MagnetoelasticEnergy";
    case GpuFinalScalarSlot::MaxHEff:
        return "MaxHEff";
    case GpuFinalScalarSlot::MaxHDemag:
        return "MaxHDemag";
    case GpuFinalScalarSlot::MaxTorque:
        return "MaxTorque";
    case GpuFinalScalarSlot::MxSum:
        return "MxSum";
    case GpuFinalScalarSlot::MySum:
        return "MySum";
    case GpuFinalScalarSlot::MzSum:
        return "MzSum";
    case GpuFinalScalarSlot::MomentWeight:
        return "MomentWeight";
    case GpuFinalScalarSlot::Count:
        return "Count";
    }
    return "unknown";
}

bool unpack_energy_snapshot(
    const Context &ctx,
    const double *energy_terms,
    GpuDirectEnergySnapshot &snapshot,
    const char *non_finite_reason,
    std::string &reason)
{
    std::copy_n(energy_terms, kGpuFinalScalarSlots, snapshot.terms_j.begin());
    snapshot.total_energy_j = 0.0;
    const auto add = [&](GpuFinalScalarSlot slot, bool enabled) {
        if (enabled) {
            snapshot.total_energy_j +=
                snapshot.terms_j[static_cast<size_t>(slot)];
        }
    };
    add(GpuFinalScalarSlot::ExchangeEnergy, ctx.exchange.enabled);
    add(GpuFinalScalarSlot::DemagEnergy, ctx.demag.enabled);
    add(GpuFinalScalarSlot::ExternalEnergy, ctx.zeeman.has_external_field);
    add(GpuFinalScalarSlot::DriveEnergy, !ctx.zeeman.regional_drives.empty());
    add(GpuFinalScalarSlot::AnisotropyEnergy, ctx.anisotropy.uniaxial_enabled);
    add(GpuFinalScalarSlot::CubicAnisotropyEnergy, ctx.anisotropy.cubic_enabled);
    add(GpuFinalScalarSlot::DmiEnergy, ctx.dmi.interfacial_enabled);
    add(GpuFinalScalarSlot::BulkDmiEnergy, ctx.dmi.bulk_enabled);
    add(GpuFinalScalarSlot::MagnetoelasticEnergy, ctx.magnetoelastic.enabled);
    if (!std::isfinite(snapshot.total_energy_j)) {
        reason = non_finite_reason;
        return false;
    }
    return true;
}

bool direct_difference(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    bool use_precomputed_representable_chord,
    bool track_active_state_change,
    GpuDirectArmijoResult &result,
    std::string &reason)
{
    auto &trial = result.trial_snapshot;
    auto &difference = result.difference;
    auto &gpu = ctx.gpu_state.device;
    double *const tail = gpu.reductions.scalar_result + kGpuFinalScalarSlots;
    if (!cuda_ok(
            cudaMemsetAsync(
                tail, 0,
                (use_precomputed_representable_chord
                     ? kDirectRepresentableChordTailSlot
                     : kDirectEnergyTailSlots) *
                    sizeof(double),
                stream),
            "cudaMemsetAsync GPU direct minimizer scalar tail",
            reason)) {
        return false;
    }
    fullmag_cuda_relax_direct_energy_difference_blocks(
        base_m.x, base_m.y, base_m.z,
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        base_h_demag.x, base_h_demag.y, base_h_demag.z,
        gpu.fields.h_demag.x, gpu.fields.h_demag.y, gpu.fields.h_demag.z,
        gpu.fields.h_ext.x, gpu.fields.h_ext.y, gpu.fields.h_ext.z,
        gpu.materials.ms, gpu.materials.ku, gpu.materials.ku2,
        gpu.materials.kc1, gpu.materials.kc2, gpu.materials.kc3,
        gpu.materials.anisotropy_axis_x, gpu.materials.anisotropy_axis_y,
        gpu.materials.anisotropy_axis_z, gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        ctx.demag.enabled, ctx.zeeman.has_external_field,
        ctx.anisotropy.uniaxial_enabled, ctx.anisotropy.cubic_enabled,
        ctx.anisotropy.uniaxial_Ku, ctx.anisotropy.uniaxial_Ku2,
        !ctx.material_fields.Ku_field.empty(), !ctx.material_fields.Ku2_field.empty(),
        ctx.anisotropy.cubic_Kc1, ctx.anisotropy.cubic_Kc2,
        ctx.anisotropy.cubic_Kc3,
        ctx.anisotropy.cubic_axis1[0], ctx.anisotropy.cubic_axis1[1],
        ctx.anisotropy.cubic_axis1[2], ctx.anisotropy.cubic_axis2[0],
        ctx.anisotropy.cubic_axis2[1], ctx.anisotropy.cubic_axis2[2],
        !ctx.material_fields.Kc1_field.empty(),
        !ctx.material_fields.Kc2_field.empty(),
        !ctx.material_fields.Kc3_field.empty(),
        gpu.reductions.scalar_workspace,
        gpu.rk.k[1].x,
        gpu.rk.k[1].y,
        gpu.rk.k[1].z,
        node_count, stream);
    if (!cuda_launch_ok("launch GPU direct minimizer local energy difference", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.reductions.scalar_workspace, block_count,
            tail + kDirectLocalDeltaTailSlot,
            "launch GPU direct minimizer local delta reduction", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.rk.k[1].x, block_count,
            tail + kDirectLocalAbsoluteTailSlot,
            "launch GPU direct minimizer local absolute reduction", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.rk.k[1].y, block_count,
            tail + kDirectDemagDeltaTailSlot,
            "launch GPU direct minimizer demag delta reduction", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.rk.k[1].z, block_count,
            tail + kDirectDemagAbsoluteTailSlot,
            "launch GPU direct minimizer demag absolute reduction", reason)) {
        return false;
    }

    if (ctx.exchange.enabled) {
        fullmag_cuda_legacy_sparse_exchange_difference_blocks(
            gpu.legacy_exchange.csr_row_offsets,
            gpu.legacy_exchange.csr_col_indices,
            gpu.legacy_exchange.csr_values,
            base_m.x, base_m.y, base_m.z,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            gpu.reductions.scalar_workspace,
            gpu.rk.k[1].x,
            node_count, stream);
        if (!cuda_launch_ok("launch GPU direct minimizer exchange difference", reason) ||
            !reduce_scalar_sum(
                ctx, stream, gpu.reductions.scalar_workspace, block_count,
                tail + kDirectExchangeDeltaTailSlot,
                "launch GPU direct minimizer exchange delta reduction", reason) ||
            !reduce_scalar_sum(
                ctx, stream, gpu.rk.k[1].x, block_count,
                tail + kDirectExchangeAbsoluteTailSlot,
                "launch GPU direct minimizer exchange absolute reduction", reason)) {
            return false;
        }
    }

    const auto add_dmi_difference = [&](
        bool bulk_mode,
        size_t delta_tail_slot,
        size_t absolute_tail_slot) -> bool {
        if (!(bulk_mode ? ctx.dmi.bulk_enabled : ctx.dmi.interfacial_enabled)) {
            return true;
        }
        fullmag_cuda_dmi_energy_difference(
            gpu.mesh_geometry.nodes_xyz, gpu.mesh_geometry.elements,
            gpu.mesh_geometry.magnetic_element_mask,
            base_m.x, base_m.y, base_m.z,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            bulk_mode ? gpu.materials.dbulk : gpu.materials.dind,
            tail + delta_tail_slot,
            tail + absolute_tail_slot,
            bulk_mode ? ctx.dmi.bulk_D : ctx.dmi.interfacial_D,
            ctx.dmi.interface_normal[0], ctx.dmi.interface_normal[1],
            ctx.dmi.interface_normal[2],
            bulk_mode ? !ctx.material_fields.Dbulk_field.empty()
                      : !ctx.material_fields.Dind_field.empty(),
            bulk_mode, static_cast<int>(ctx.mesh.n_elements), stream);
        if (!cuda_launch_ok("launch GPU direct minimizer DMI difference", reason)) {
            return false;
        }
        return true;
    };
    if (!add_dmi_difference(
            false,
            kDirectInterfacialDmiDeltaTailSlot,
            kDirectInterfacialDmiAbsoluteTailSlot) ||
        !add_dmi_difference(
            true,
            kDirectBulkDmiDeltaTailSlot,
            kDirectBulkDmiAbsoluteTailSlot)) {
        return false;
    }

    if (track_active_state_change) {
        fullmag_cuda_relax_active_state_change_blocks(
            base_m.x, base_m.y, base_m.z,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            gpu.mesh_regions.magnetic_node_mask,
            gpu.reductions.scalar_workspace,
            node_count,
            stream);
        if (!cuda_launch_ok("launch GPU direct minimizer active-state comparison", reason) ||
            !reduce_scalar_sum(
                ctx, stream, gpu.reductions.scalar_workspace, block_count,
                tail + kDirectActiveStateChangeTailSlot,
                "launch GPU direct minimizer active-state change reduction", reason)) {
            return false;
        }
    }

    std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> scalars{};
    const size_t read_count = kGpuFinalScalarSlots + kDirectEnergyTailSlots;
    if (!gpu_rk_read_control_scalar_results(
            ctx, stream,
            "cudaMemcpyAsync GPU direct minimizer energy batch device->host",
            scalars.data(), read_count, reason)) {
        return false;
    }
    if (!unpack_energy_snapshot(
            ctx,
            scalars.data(),
            trial,
            "GPU direct minimizer produced non-finite trial energy",
            reason)) {
        return false;
    }
    const double exchange_delta =
        scalars[kGpuFinalScalarSlots + kDirectExchangeDeltaTailSlot];
    const double exchange_absolute =
        scalars[kGpuFinalScalarSlots + kDirectExchangeAbsoluteTailSlot];
    const double interfacial_dmi_delta =
        scalars[kGpuFinalScalarSlots + kDirectInterfacialDmiDeltaTailSlot];
    const double interfacial_dmi_absolute =
        scalars[kGpuFinalScalarSlots + kDirectInterfacialDmiAbsoluteTailSlot];
    const double bulk_dmi_delta =
        scalars[kGpuFinalScalarSlots + kDirectBulkDmiDeltaTailSlot];
    const double bulk_dmi_absolute =
        scalars[kGpuFinalScalarSlots + kDirectBulkDmiAbsoluteTailSlot];
    const double changed_active_nodes =
        scalars[kGpuFinalScalarSlots + kDirectActiveStateChangeTailSlot];
    if (!std::isfinite(changed_active_nodes) || changed_active_nodes < 0.0) {
        reason = "GPU direct minimizer active-state change reduction is invalid";
        return false;
    }
    result.trial_active_state_unchanged =
        track_active_state_change && changed_active_nodes == 0.0;
    result.representable_chord_energy_linear_increment_j =
        scalars[kGpuFinalScalarSlots + kDirectRepresentableChordTailSlot];
    if (use_precomputed_representable_chord &&
        !std::isfinite(result.representable_chord_energy_linear_increment_j)) {
        reason = "GPU direct minimizer representable-chord increment is non-finite";
        return false;
    }
    const double local_delta =
        scalars[kGpuFinalScalarSlots + kDirectLocalDeltaTailSlot];
    const double local_absolute =
        scalars[kGpuFinalScalarSlots + kDirectLocalAbsoluteTailSlot];
    const double direct_delta =
        local_delta + exchange_delta + interfacial_dmi_delta + bulk_dmi_delta;
    const double direct_absolute =
        local_absolute + exchange_absolute + interfacial_dmi_absolute + bulk_dmi_absolute;
    result.local_delta_j =
        scalars[kGpuFinalScalarSlots + kDirectLocalDeltaTailSlot];
    result.demag_delta_j =
        scalars[kGpuFinalScalarSlots + kDirectDemagDeltaTailSlot];
    result.demag_absolute_term_sum_j =
        scalars[kGpuFinalScalarSlots + kDirectDemagAbsoluteTailSlot];
    result.demag_roundoff_bound_j =
        relaxation::reduction_roundoff_bound(
            static_cast<size_t>(node_count) * 128u) *
        result.demag_absolute_term_sum_j;
    result.exchange_delta_j = exchange_delta;
    result.interfacial_dmi_delta_j = interfacial_dmi_delta;
    result.bulk_dmi_delta_j = bulk_dmi_delta;

    GpuDirectEnergyReductionCounts reduction_counts{};
    if (!gpu_direct_energy_reduction_counts(
            ctx,
            static_cast<size_t>(node_count),
            ctx.mesh.n_elements,
            static_cast<size_t>(gpu.legacy_exchange.nnz),
            reduction_counts)) {
        reason = "GPU direct minimizer energy reduction term count overflow";
        return false;
    }
    if (!gpu_compose_term_complete_energy_difference(
        ctx,
        base,
        trial,
        direct_delta,
        direct_absolute,
        0u,
        difference,
        result.endpoint_residual_delta_j,
        result.endpoint_residual_operand_absolute_sum_j,
        reason)) {
        return false;
    }
    const double owner_roundoff_bound =
        relaxation::reduction_roundoff_bound(reduction_counts.local) * local_absolute +
        relaxation::reduction_roundoff_bound(reduction_counts.exchange) * exchange_absolute +
        relaxation::reduction_roundoff_bound(reduction_counts.interfacial_dmi) * interfacial_dmi_absolute +
        relaxation::reduction_roundoff_bound(reduction_counts.bulk_dmi) * bulk_dmi_absolute +
        relaxation::reduction_roundoff_bound(4u) * direct_absolute;
    const double endpoint_roundoff_bound =
        relaxation::reduction_roundoff_bound(2u) *
            result.endpoint_residual_operand_absolute_sum_j +
        relaxation::reduction_roundoff_bound(4u) *
            result.endpoint_residual_operand_absolute_sum_j;
    result.difference.roundoff_bound_joules =
        owner_roundoff_bound + endpoint_roundoff_bound +
        relaxation::reduction_roundoff_bound(2u) *
            result.difference.absolute_term_sum_joules;
    if (!std::isfinite(result.difference.roundoff_bound_joules)) {
        reason = "GPU direct minimizer owner-specific roundoff bound is non-finite";
        return false;
    }
    return true;
}

bool compute_fresh_snapshot(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    GpuDirectEnergySnapshot &snapshot,
    std::string &reason)
{
    if (!gpu_relax_compute_effective_field_and_energy_terms(
            ctx, stream, node_count, block_count, reason) ||
        !gpu_direct_energy_snapshot(ctx, stream, snapshot, reason)) {
        return false;
    }
    return true;
}

} // namespace

bool gpu_unpack_direct_energy_snapshot(
    const Context &ctx,
    const double *energy_terms,
    GpuDirectEnergySnapshot &snapshot,
    std::string &reason)
{
    return unpack_energy_snapshot(
        ctx,
        energy_terms,
        snapshot,
        "GPU direct minimizer produced non-finite snapshot energy",
        reason);
}

GpuEnergyIncrementOwner gpu_energy_increment_owner(
    const Context &ctx,
    GpuFinalScalarSlot slot)
{
    switch (slot) {
    case GpuFinalScalarSlot::ExchangeEnergy:
        return ctx.exchange.enabled ? GpuEnergyIncrementOwner::Direct
                                    : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::DemagEnergy:
        return ctx.demag.enabled ? GpuEnergyIncrementOwner::Direct
                                 : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::DemagRobinBoundaryEnergy:
        return GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::ExternalEnergy:
        return ctx.zeeman.has_external_field ? GpuEnergyIncrementOwner::Direct
                                             : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::DriveEnergy:
        return !ctx.zeeman.regional_drives.empty()
            ? GpuEnergyIncrementOwner::EndpointResidual
            : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::DmiEnergy:
        return ctx.dmi.interfacial_enabled ? GpuEnergyIncrementOwner::Direct
                                           : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::BulkDmiEnergy:
        return ctx.dmi.bulk_enabled ? GpuEnergyIncrementOwner::Direct
                                    : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::AnisotropyEnergy:
        return ctx.anisotropy.uniaxial_enabled ? GpuEnergyIncrementOwner::Direct
                                               : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::CubicAnisotropyEnergy:
        return ctx.anisotropy.cubic_enabled
            ? GpuEnergyIncrementOwner::Direct
            : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::MagnetoelasticEnergy:
        return ctx.magnetoelastic.enabled
            ? GpuEnergyIncrementOwner::EndpointResidual
            : GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::MaxRhs:
    case GpuFinalScalarSlot::MaxHEff:
    case GpuFinalScalarSlot::MaxHDemag:
    case GpuFinalScalarSlot::MaxTorque:
    case GpuFinalScalarSlot::MxSum:
    case GpuFinalScalarSlot::MySum:
    case GpuFinalScalarSlot::MzSum:
    case GpuFinalScalarSlot::MomentWeight:
        return GpuEnergyIncrementOwner::NotEnergy;
    case GpuFinalScalarSlot::Count:
        return GpuEnergyIncrementOwner::Unsupported;
    }
    return GpuEnergyIncrementOwner::Unsupported;
}

bool gpu_direct_energy_reduction_counts(
    const Context &ctx,
    size_t node_count,
    size_t element_count,
    size_t exchange_nnz,
    GpuDirectEnergyReductionCounts &counts)
{
    counts = {};
    if (((ctx.demag.enabled || ctx.zeeman.has_external_field ||
          ctx.anisotropy.uniaxial_enabled || ctx.anisotropy.cubic_enabled) &&
         !checked_add_scaled(counts.local, node_count, 512u)) ||
        (ctx.exchange.enabled &&
         (!checked_add_scaled(counts.exchange, exchange_nnz, 16u) ||
          !checked_add_scaled(counts.exchange, node_count, 32u))) ||
        (ctx.dmi.interfacial_enabled &&
         !checked_add_scaled(counts.interfacial_dmi, element_count, 512u)) ||
        (ctx.dmi.bulk_enabled &&
         !checked_add_scaled(counts.bulk_dmi, element_count, 512u))) {
        counts = {};
        return false;
    }
    return true;
}

bool gpu_compose_term_complete_energy_difference(
    const Context &ctx,
    const GpuDirectEnergySnapshot &base,
    const GpuDirectEnergySnapshot &trial,
    double direct_delta_j,
    double direct_absolute_term_sum_j,
    size_t scalar_term_count,
    relaxation::EnergyDifference &difference,
    double &endpoint_residual_delta_j,
    double &endpoint_residual_operand_absolute_sum_j,
    std::string &reason)
{
    if (!std::isfinite(direct_delta_j) ||
        !std::isfinite(direct_absolute_term_sum_j) ||
        direct_absolute_term_sum_j < 0.0) {
        reason = "GPU direct minimizer produced a non-finite direct energy increment";
        return false;
    }

    endpoint_residual_delta_j = 0.0;
    endpoint_residual_operand_absolute_sum_j = 0.0;
    for (int raw_slot = 0;
         raw_slot < static_cast<int>(GpuFinalScalarSlot::Count);
         ++raw_slot) {
        const auto slot = static_cast<GpuFinalScalarSlot>(raw_slot);
        switch (gpu_energy_increment_owner(ctx, slot)) {
        case GpuEnergyIncrementOwner::NotEnergy:
        case GpuEnergyIncrementOwner::Direct:
            break;
        case GpuEnergyIncrementOwner::EndpointResidual: {
            const double base_term = base.terms_j[static_cast<size_t>(slot)];
            const double trial_term = trial.terms_j[static_cast<size_t>(slot)];
            if (!std::isfinite(base_term) || !std::isfinite(trial_term)) {
                reason = std::string("GPU direct minimizer produced a non-finite endpoint residual for ") +
                    gpu_final_scalar_slot_name(slot);
                return false;
            }
            endpoint_residual_delta_j += trial_term - base_term;
            endpoint_residual_operand_absolute_sum_j +=
                std::abs(base_term) + std::abs(trial_term);
            break;
        }
        case GpuEnergyIncrementOwner::Unsupported:
            reason = std::string("GPU direct minimizer has no energy-increment owner for ") +
                gpu_final_scalar_slot_name(slot);
            return false;
        }
    }
    if (!std::isfinite(endpoint_residual_delta_j) ||
        !std::isfinite(endpoint_residual_operand_absolute_sum_j)) {
        reason = "GPU direct minimizer produced a non-finite endpoint residual composition";
        return false;
    }
    difference = relaxation::compose_term_complete_energy_difference(
        endpoint_residual_delta_j,
        endpoint_residual_operand_absolute_sum_j,
        direct_delta_j,
        direct_absolute_term_sum_j,
        scalar_term_count);
    if (!std::isfinite(difference.delta_joules) ||
        !std::isfinite(difference.absolute_term_sum_joules) ||
        !std::isfinite(difference.roundoff_bound_joules)) {
        reason = "GPU direct minimizer produced a non-finite term-complete energy difference";
        return false;
    }
    return true;
}

bool gpu_relax_compute_effective_field_and_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            node_count,
            ctx.state.current_time,
            "launch GPU direct minimizer h_eff accumulation",
            reason)) {
        return false;
    }
    // The final energy-term reduction leaves its slots in
    // gpu.reductions.scalar_result for the caller's batched Armijo readback.
    return gpu_rk_reduce_final_energy_terms(
        ctx, stream, node_count, block_count, reason);
}

bool gpu_direct_armijo_demag_refinement_eligible(
    const Context &ctx,
    const GpuDirectArmijoResult &result,
    double armijo_rhs_j)
{
    if (!ctx.demag.enabled ||
        result.decision != relaxation::ArmijoDifferenceDecision::Refine ||
        !std::isfinite(armijo_rhs_j) ||
        !std::isfinite(result.endpoint_residual_operand_absolute_sum_j) ||
        result.endpoint_residual_operand_absolute_sum_j < 0.0 ||
        result.endpoint_residual_operand_absolute_sum_j > 0.0 ||
        !std::isfinite(result.difference.roundoff_bound_joules) ||
        !std::isfinite(result.demag_roundoff_bound_j) ||
        result.demag_roundoff_bound_j < 0.0 ||
        result.demag_roundoff_bound_j >
            result.difference.roundoff_bound_joules) {
        return false;
    }
    relaxation::EnergyDifference non_demag_difference = result.difference;
    non_demag_difference.roundoff_bound_joules =
        result.difference.roundoff_bound_joules -
        result.demag_roundoff_bound_j;
    return relaxation::strict_armijo_difference_decision(
               non_demag_difference,
               armijo_rhs_j) ==
        relaxation::ArmijoDifferenceDecision::Accept;
}

bool gpu_direct_energy_snapshot(
    Context &ctx,
    cudaStream_t stream,
    GpuDirectEnergySnapshot &snapshot,
    std::string &reason)
{
    std::array<double, kGpuFinalScalarSlots> energy_terms{};
    if (!gpu_rk_read_control_scalar_results(
            ctx, stream,
            "cudaMemcpyAsync GPU direct minimizer energy terms device->host",
            energy_terms.data(), energy_terms.size(), reason)) {
        return false;
    }
    return unpack_energy_snapshot(
        ctx,
        energy_terms.data(),
        snapshot,
        "GPU direct minimizer produced non-finite snapshot energy",
        reason);
}

bool gpu_unpack_pgbb_current_metrics(
    const Context &ctx,
    const std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> &packed_scalars,
    GpuPgbbCurrentMetrics &metrics,
    std::string &reason)
{
    metrics.energy_snapshot_finite =
        packed_scalars[kGpuPgbbCurrentFiniteFlagsSlot] != 0.0;
    metrics.gradient_norm_finite =
        packed_scalars[kGpuPgbbCurrentFiniteFlagsSlot + 1u] != 0.0;
    metrics.projected_gradient_norm_finite =
        packed_scalars[kGpuPgbbCurrentFiniteFlagsSlot + 2u] != 0.0;
    metrics.gradient_norm_sq =
        packed_scalars[kGpuPgbbCurrentGradientNormSlot];
    metrics.projected_gradient_norm_sq =
        packed_scalars[kGpuPgbbCurrentProjectedGradientNormSlot];
    if (!metrics.energy_snapshot_finite ||
        !unpack_energy_snapshot(
            ctx,
            packed_scalars.data(),
            metrics.energy_snapshot,
            "GPU projected-gradient BB produced non-finite total energy",
            reason)) {
        if (reason.empty()) {
            reason = "GPU projected-gradient BB produced non-finite total energy";
        }
        return false;
    }
    if (!metrics.gradient_norm_finite) {
        reason = "GPU projected-gradient BB produced a non-finite or negative tangent-gradient norm";
        return false;
    }
    if (!metrics.projected_gradient_norm_finite) {
        reason = "GPU projected-gradient BB produced a non-finite or negative J A/m energy-metric tangent-gradient norm";
        return false;
    }
    return true;
}

bool gpu_direct_armijo_evaluate(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    double armijo_rhs_j,
    bool track_active_state_change,
    GpuDirectArmijoResult &result,
    std::string &reason)
{
    if (!direct_difference(
            ctx, stream, node_count, block_count, base_m, base_h_demag,
            base, false, track_active_state_change, result, reason)) {
        return false;
    }
    result.decision = relaxation::strict_armijo_difference_decision(
        result.difference, armijo_rhs_j);
    result.refinement_attempted =
        gpu_direct_armijo_demag_refinement_eligible(
            ctx, result, armijo_rhs_j);
    result.refinement_accepted = false;
    return true;
}

bool gpu_direct_minimizer_precompute_representable_chord_increment(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &trial_m,
    const FemGpuComponentField &accepted_h_eff,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    fullmag_cuda_relax_representable_chord_energy_linear_increment_blocks(
        base_m.x, base_m.y, base_m.z,
        trial_m.x, trial_m.y, trial_m.z,
        accepted_h_eff.x, accepted_h_eff.y, accepted_h_eff.z,
        gpu.materials.ms, gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.reductions.scalar_workspace, node_count, stream);
    return cuda_launch_ok(
               "launch GPU direct minimizer representable-chord increment", reason) &&
        reduce_scalar_sum(
            ctx, stream, gpu.reductions.scalar_workspace, block_count,
            gpu.reductions.scalar_result + kGpuFinalScalarSlots +
                kDirectRepresentableChordTailSlot,
            "launch GPU direct minimizer representable-chord reduction", reason);
}

bool gpu_direct_minimizer_armijo_evaluate(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    double armijo_coefficient,
    bool track_active_state_change,
    GpuDirectArmijoResult &result,
    std::string &reason)
{
    if (!direct_difference(
            ctx, stream, node_count, block_count, base_m, base_h_demag,
            base, true, track_active_state_change, result, reason)) {
        return false;
    }
    const double chord =
        result.representable_chord_energy_linear_increment_j;
    result.armijo_rhs_j = armijo_coefficient * chord;
    result.decision =
        std::isfinite(chord) && chord < 0.0 &&
            std::isfinite(result.armijo_rhs_j)
        ? relaxation::strict_armijo_difference_decision(
              result.difference, result.armijo_rhs_j)
        : relaxation::ArmijoDifferenceDecision::Reject;
    result.refinement_attempted =
        gpu_direct_armijo_demag_refinement_eligible(
            ctx, result, result.armijo_rhs_j);
    result.refinement_accepted = false;
    return true;
}

bool gpu_direct_armijo_refine(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &trial_m,
    FemGpuComponentField &base_h_demag_scratch,
    double armijo_rhs_j,
    GpuDirectArmijoResult &result,
    std::string &reason)
{
    if (!gpu_direct_armijo_demag_refinement_eligible(
            ctx, result, armijo_rhs_j)) {
        result.refinement_attempted = false;
        return true;
    }
    result.refinement_attempted = true;

    const fullmag_fem_solver_config ordinary_solver = ctx.demag.solver;
    const double ordinary_rtol = ordinary_solver.relative_tolerance;
    const double refinement_floor =
        16.0 * std::numeric_limits<double>::epsilon();
    const double refined_rtol =
        std::max(refinement_floor, ordinary_rtol * 0.1);
    if (!std::isfinite(ordinary_rtol) || !std::isfinite(refined_rtol) ||
        ordinary_rtol <= refined_rtol) {
        return true;
    }

    struct SolverRestore {
        Context &ctx;
        fullmag_fem_solver_config solver;
        ~SolverRestore() { ctx.demag.solver = solver; }
    } restore{ctx, ordinary_solver};
    ctx.demag.solver.relative_tolerance = refined_rtol;

    auto &gpu = ctx.gpu_state.device;
    GpuDirectEnergySnapshot refined_base{};
    if (!gpu_rk_copy_component_device(
            base_m,
            gpu.magnetization.m,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU direct minimizer refinement base m",
            reason) ||
        !compute_fresh_snapshot(
            ctx,
            stream,
            node_count,
            block_count,
            refined_base,
            reason) ||
        !gpu_rk_copy_component_device(
            gpu.fields.h_demag,
            base_h_demag_scratch,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU direct minimizer refinement base H_demag",
            reason) ||
        !gpu_rk_copy_component_device(
            trial_m,
            gpu.magnetization.m,
            gpu.lifecycle.node_count,
            stream,
            "cudaMemcpyAsync GPU direct minimizer refinement trial m",
            reason) ||
        !gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            node_count,
            ctx.state.current_time,
            "launch GPU direct minimizer refined trial h_eff accumulation",
            reason) ||
        !gpu_rk_reduce_final_energy_terms(
            ctx, stream, node_count, block_count, reason)) {
        return false;
    }
    result.refinement_rhs_evaluations += 2u;

    const relaxation::EnergyDifference ordinary_difference = result.difference;
    if (!direct_difference(
            ctx,
            stream,
            node_count,
            block_count,
            base_m,
            base_h_demag_scratch,
            refined_base,
            false,
            false,
            result,
            reason)) {
        return false;
    }
    const GpuDirectEnergySnapshot refined_trial = result.trial_snapshot;
    const relaxation::EnergyDifference refined_difference = result.difference;
    result.refinement_accepted =
        relaxation::strict_armijo_difference_refinement_accepts(
            ordinary_difference, refined_difference, armijo_rhs_j);
    if (result.refinement_accepted) {
        result.difference = refined_difference;
        result.trial_snapshot = refined_trial;
    } else {
        ctx.demag.solver = ordinary_solver;
        GpuDirectEnergySnapshot restored_base{};
        if (!gpu_rk_copy_component_device(
                base_m,
                gpu.magnetization.m,
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU direct minimizer restore ordinary base m",
                reason) ||
            !compute_fresh_snapshot(
                ctx,
                stream,
                node_count,
                block_count,
                restored_base,
                reason) ||
            !gpu_rk_copy_component_device(
                gpu.fields.h_demag,
                base_h_demag_scratch,
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU direct minimizer restore ordinary base H_demag",
                reason)) {
            return false;
        }
        result.refinement_rhs_evaluations += 1u;
    }
    return true;
}

} // namespace fullmag::fem
#endif
