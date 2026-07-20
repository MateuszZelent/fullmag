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

constexpr size_t kDirectLocalDeltaTailSlot = 0;
constexpr size_t kDirectLocalAbsoluteTailSlot = 1;
constexpr size_t kDirectExchangeDeltaTailSlot = 2;
constexpr size_t kDirectInterfacialDmiDeltaTailSlot = 3;
constexpr size_t kDirectBulkDmiDeltaTailSlot = 4;
constexpr size_t kDirectEnergyTailSlots = 5;
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

bool direct_difference(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    GpuDirectArmijoResult &result,
    std::string &reason)
{
    auto &trial = result.trial_snapshot;
    auto &difference = result.difference;
    auto &gpu = ctx.gpu_state.device;
    double *const tail = gpu.reductions.scalar_result + kGpuFinalScalarSlots;
    if (!cuda_ok(
            cudaMemsetAsync(
                tail, 0, kDirectEnergyTailSlots * sizeof(double), stream),
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
        gpu.materials.anisotropy_axis_x, gpu.materials.anisotropy_axis_y,
        gpu.materials.anisotropy_axis_z, gpu.mesh_metrics.lumped_mass,
        gpu.mesh_regions.magnetic_node_mask,
        ctx.demag.enabled,
        ctx.anisotropy.uniaxial_Ku, ctx.anisotropy.uniaxial_Ku2,
        !ctx.material_fields.Ku_field.empty(), !ctx.material_fields.Ku2_field.empty(),
        gpu.reductions.scalar_workspace,
        gpu.rk.k[1].x, node_count, stream);
    if (!cuda_launch_ok("launch GPU direct minimizer local energy difference", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.reductions.scalar_workspace, block_count,
            tail + kDirectLocalDeltaTailSlot,
            "launch GPU direct minimizer local delta reduction", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.rk.k[1].x, block_count,
            tail + kDirectLocalAbsoluteTailSlot,
            "launch GPU direct minimizer local absolute reduction", reason)) {
        return false;
    }

    fullmag_cuda_legacy_sparse_exchange_difference_blocks(
        gpu.legacy_exchange.csr_row_offsets,
        gpu.legacy_exchange.csr_col_indices,
        gpu.legacy_exchange.csr_values,
        base_m.x, base_m.y, base_m.z,
        gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
        gpu.reductions.scalar_workspace, node_count, stream);
    if (!cuda_launch_ok("launch GPU direct minimizer exchange difference", reason) ||
        !reduce_scalar_sum(
            ctx, stream, gpu.reductions.scalar_workspace, block_count,
            tail + kDirectExchangeDeltaTailSlot,
            "launch GPU direct minimizer exchange delta reduction", reason)) {
        return false;
    }

    const auto add_dmi_difference = [&](bool bulk_mode, size_t tail_slot) -> bool {
        if (!(bulk_mode ? ctx.dmi.bulk_enabled : ctx.dmi.interfacial_enabled)) {
            return true;
        }
        fullmag_cuda_dmi_energy_difference(
            gpu.mesh_geometry.nodes_xyz, gpu.mesh_geometry.elements,
            gpu.mesh_geometry.magnetic_element_mask,
            base_m.x, base_m.y, base_m.z,
            gpu.magnetization.m.x, gpu.magnetization.m.y, gpu.magnetization.m.z,
            bulk_mode ? gpu.materials.dbulk : gpu.materials.dind,
            tail + tail_slot,
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
    if (!add_dmi_difference(false, kDirectInterfacialDmiDeltaTailSlot) ||
        !add_dmi_difference(true, kDirectBulkDmiDeltaTailSlot)) {
        return false;
    }

    std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> scalars{};
    const size_t read_count = kGpuFinalScalarSlots + kDirectEnergyTailSlots;
    if (!gpu_rk_read_control_scalar_results(
            ctx, stream,
            "cudaMemcpyAsync GPU direct minimizer energy batch device->host",
            scalars.data(), read_count, reason)) {
        return false;
    }
    std::copy_n(scalars.begin(), kGpuFinalScalarSlots, trial.terms_j.begin());
    trial.total_energy_j = 0.0;
    const auto add_term = [&](GpuFinalScalarSlot slot, bool enabled) {
        if (enabled) {
            trial.total_energy_j += trial.terms_j[static_cast<size_t>(slot)];
        }
    };
    add_term(GpuFinalScalarSlot::ExchangeEnergy, true);
    add_term(GpuFinalScalarSlot::DemagEnergy, ctx.demag.enabled);
    add_term(GpuFinalScalarSlot::ExternalEnergy, ctx.zeeman.has_external_field);
    add_term(GpuFinalScalarSlot::DriveEnergy, !ctx.zeeman.regional_drives.empty());
    add_term(GpuFinalScalarSlot::AnisotropyEnergy, ctx.anisotropy.uniaxial_enabled);
    add_term(GpuFinalScalarSlot::CubicAnisotropyEnergy, ctx.anisotropy.cubic_enabled);
    add_term(GpuFinalScalarSlot::DmiEnergy, ctx.dmi.interfacial_enabled);
    add_term(GpuFinalScalarSlot::BulkDmiEnergy, ctx.dmi.bulk_enabled);
    add_term(GpuFinalScalarSlot::MagnetoelasticEnergy, ctx.magnetoelastic.enabled);
    if (!std::isfinite(trial.total_energy_j)) {
        reason = "GPU direct minimizer produced non-finite trial energy";
        return false;
    }
    const double exchange_delta =
        scalars[kGpuFinalScalarSlots + kDirectExchangeDeltaTailSlot];
    const double interfacial_dmi_delta =
        scalars[kGpuFinalScalarSlots + kDirectInterfacialDmiDeltaTailSlot];
    const double bulk_dmi_delta =
        scalars[kGpuFinalScalarSlots + kDirectBulkDmiDeltaTailSlot];
    const double direct_delta =
        scalars[kGpuFinalScalarSlots + kDirectLocalDeltaTailSlot] +
        exchange_delta + interfacial_dmi_delta + bulk_dmi_delta;
    const double direct_absolute =
        scalars[kGpuFinalScalarSlots + kDirectLocalAbsoluteTailSlot] +
        std::abs(exchange_delta) + std::abs(interfacial_dmi_delta) +
        std::abs(bulk_dmi_delta);
    result.local_delta_j =
        scalars[kGpuFinalScalarSlots + kDirectLocalDeltaTailSlot];
    result.exchange_delta_j = exchange_delta;
    result.interfacial_dmi_delta_j = interfacial_dmi_delta;
    result.bulk_dmi_delta_j = bulk_dmi_delta;

    const auto slot = [](GpuFinalScalarSlot value) {
        return static_cast<size_t>(value);
    };
    double endpoint_replaced = 0.0;
    const auto add_endpoint_delta = [&](GpuFinalScalarSlot energy_slot, bool enabled) {
        if (enabled) {
            endpoint_replaced +=
                trial.terms_j[slot(energy_slot)] - base.terms_j[slot(energy_slot)];
        }
    };
    add_endpoint_delta(GpuFinalScalarSlot::ExchangeEnergy, true);
    add_endpoint_delta(GpuFinalScalarSlot::DemagEnergy, ctx.demag.enabled);
    add_endpoint_delta(
        GpuFinalScalarSlot::ExternalEnergy, ctx.zeeman.has_external_field);
    add_endpoint_delta(
        GpuFinalScalarSlot::AnisotropyEnergy, ctx.anisotropy.uniaxial_enabled);
    add_endpoint_delta(GpuFinalScalarSlot::DmiEnergy, ctx.dmi.interfacial_enabled);
    add_endpoint_delta(GpuFinalScalarSlot::BulkDmiEnergy, ctx.dmi.bulk_enabled);
    result.endpoint_replaced_delta_j = endpoint_replaced;
    difference = relaxation::compose_direct_energy_difference(
        trial.total_energy_j - base.total_energy_j,
        endpoint_replaced,
        direct_delta,
        direct_absolute,
        static_cast<size_t>(node_count) * 3u);
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
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_compute_effective_field_for_magnetization_fresh_demag(
            ctx,
            gpu.magnetization.m,
            stream,
            node_count,
            ctx.state.current_time,
            "launch GPU direct minimizer refined h_eff accumulation",
            reason) ||
        !gpu_rk_reduce_final_energy_terms(
            ctx, stream, node_count, block_count, reason) ||
        !gpu_direct_energy_snapshot(ctx, stream, snapshot, reason)) {
        return false;
    }
    return true;
}

} // namespace

bool gpu_direct_energy_snapshot(
    Context &ctx,
    cudaStream_t stream,
    GpuDirectEnergySnapshot &snapshot,
    std::string &reason)
{
    if (!gpu_rk_read_control_scalar_results(
            ctx, stream,
            "cudaMemcpyAsync GPU direct minimizer energy terms device->host",
            snapshot.terms_j.data(), snapshot.terms_j.size(), reason)) {
        return false;
    }
    snapshot.total_energy_j = 0.0;
    const auto add = [&](GpuFinalScalarSlot slot, bool enabled) {
        if (enabled) {
            snapshot.total_energy_j +=
                snapshot.terms_j[static_cast<size_t>(slot)];
        }
    };
    add(GpuFinalScalarSlot::ExchangeEnergy, true);
    add(GpuFinalScalarSlot::DemagEnergy, ctx.demag.enabled);
    add(GpuFinalScalarSlot::ExternalEnergy, ctx.zeeman.has_external_field);
    add(GpuFinalScalarSlot::DriveEnergy, !ctx.zeeman.regional_drives.empty());
    add(GpuFinalScalarSlot::AnisotropyEnergy, ctx.anisotropy.uniaxial_enabled);
    add(GpuFinalScalarSlot::CubicAnisotropyEnergy, ctx.anisotropy.cubic_enabled);
    add(GpuFinalScalarSlot::DmiEnergy, ctx.dmi.interfacial_enabled);
    add(GpuFinalScalarSlot::BulkDmiEnergy, ctx.dmi.bulk_enabled);
    add(GpuFinalScalarSlot::MagnetoelasticEnergy, ctx.magnetoelastic.enabled);
    if (!std::isfinite(snapshot.total_energy_j)) {
        reason = "GPU direct minimizer produced non-finite snapshot energy";
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
    GpuDirectArmijoResult &result,
    std::string &reason)
{
    if (!direct_difference(
            ctx, stream, node_count, block_count, base_m, base_h_demag,
            base, result, reason)) {
        return false;
    }
    result.decision = relaxation::strict_armijo_difference_decision(
        result.difference, armijo_rhs_j);
    result.refinement_attempted =
        result.decision == relaxation::ArmijoDifferenceDecision::Refine;
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
    if (result.decision != relaxation::ArmijoDifferenceDecision::Refine ||
        !ctx.demag.enabled) {
        return true;
    }

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
