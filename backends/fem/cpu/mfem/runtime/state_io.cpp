/*
 * State I/O runtime source contract.
 *
 * This source owns C ABI magnetization read/write, GPU-host sync around state
 * access, observable field copies, and local cache invalidation on state write. It does not compute fields, advance integrators, own snapshots, or publish step metrics.
 */

#include "cpu/mfem/runtime/state_io.hpp"

#include "context.hpp"
#include "core/fem_field_buffers.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_MFEM_STACK
bool strict_gpu_demag_upload_path(const Context &ctx)
{
    return ctx.gpu_state.device.lifecycle.allocated &&
        ctx.poisson_demag.gpu_demag_mode ==
            FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
}
#endif

const std::vector<double> *effective_field_source(const Context &ctx, uint64_t expected_len)
{
    return (!ctx.effective_field.h_visual_xyz.empty() &&
            ctx.effective_field.h_visual_xyz.size() == static_cast<size_t>(expected_len))
               ? &ctx.effective_field.h_visual_xyz
               : &ctx.effective_field.h_xyz;
}

const std::vector<double> *full_domain_visual_field_source(
    const Context &ctx,
    fullmag_fem_observable observable,
    uint64_t expected_len)
{
    if (observable == FULLMAG_FEM_OBSERVABLE_H_DEMAG &&
        ctx.demag.h_visual_xyz.size() == static_cast<size_t>(expected_len)) {
        return &ctx.demag.h_visual_xyz;
    }
    if (observable == FULLMAG_FEM_OBSERVABLE_H_EFF &&
        ctx.effective_field.h_visual_xyz.size() == static_cast<size_t>(expected_len)) {
        return &ctx.effective_field.h_visual_xyz;
    }
    return nullptr;
}

int copy_torque_observable_f64(
    const Context &ctx,
    double *out_xyz,
    uint64_t out_len,
    std::string &error)
{
    const uint64_t expected_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (ctx.state.m_xyz.size() != static_cast<size_t>(expected_len)) {
        error = "magnetization field has not been computed yet";
        return FULLMAG_FEM_ERR_INVALID;
    }

    std::vector<double> gpu_h_eff;
    const std::vector<double> *h_source = nullptr;
    if (ctx.gpu_state.device.lifecycle.allocated) {
        if (!ctx.gpu_state.device.fields.accepted_observables_valid) {
            error = "GPU accepted-endpoint observable cache is invalid; refresh a snapshot before reading torque";
            return FULLMAG_FEM_ERR_INVALID;
        }
        if (!gpu_state_download_component_aos(
                const_cast<FemGpuState &>(ctx.gpu_state.device),
                ctx.gpu_state.device.fields.h_eff,
                gpu_h_eff,
                const_cast<TransferAudit &>(ctx.transfer_audit.audit),
                "H_eff",
                error)) {
            error = std::string("GPU component download failed: ") + error;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        h_source = &gpu_h_eff;
    } else {
        h_source = effective_field_source(ctx, expected_len);
    }

    if (h_source == nullptr || h_source->size() != static_cast<size_t>(expected_len)) {
        error = "effective field has not been computed yet";
        return FULLMAG_FEM_ERR_INVALID;
    }

    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    const double alpha = ctx.material_fields.material.damping;
    const double scale = -1.0 / (1.0 + alpha * alpha);
    for (uint64_t i = 0; i < ctx.mesh.n_nodes; ++i) {
        const size_t base = static_cast<size_t>(3ull * i);
        const double mx = ctx.state.m_xyz[base + 0];
        const double my = ctx.state.m_xyz[base + 1];
        const double mz = ctx.state.m_xyz[base + 2];
        const double bx = kMu0 * (*h_source)[base + 0];
        const double by = kMu0 * (*h_source)[base + 1];
        const double bz = kMu0 * (*h_source)[base + 2];
        const double mxbx = my * bz - mz * by;
        const double mxby = mz * bx - mx * bz;
        const double mxbz = mx * by - my * bx;
        const double mxmxbx = my * mxbz - mz * mxby;
        const double mxmxby = mz * mxbx - mx * mxbz;
        const double mxmxbz = mx * mxby - my * mxbx;
        out_xyz[base + 0] = scale * (mxbx + alpha * mxmxbx);
        out_xyz[base + 1] = scale * (mxby + alpha * mxmxby);
        out_xyz[base + 2] = scale * (mxbz + alpha * mxmxbz);
    }
    (void)out_len;
    return FULLMAG_FEM_OK;
}

#if FULLMAG_HAS_MFEM_STACK
int copy_demag_phi_observable_f64(
    const Context &ctx,
    double *out,
    uint64_t out_len,
    std::string &error)
{
    if (!ctx.demag.enabled) {
        error = "demag scalar potential requested but demag is disabled";
        return FULLMAG_FEM_ERR_INVALID;
    }
    auto *potential = static_cast<mfem::GridFunction *>(ctx.poisson_demag.gf_potential);
    if (potential == nullptr) {
        error = "demag scalar potential has not been initialized";
        return FULLMAG_FEM_ERR_INVALID;
    }
    const uint64_t expected_len = static_cast<uint64_t>(ctx.mesh.n_nodes);
    if (out_len != expected_len) {
        error = "demag scalar-potential output length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (potential->Size() == static_cast<int>(expected_len)) {
        const double *source = audited_host_read(*potential);
        std::memcpy(out, source, static_cast<size_t>(sizeof(double) * out_len));
    } else {
        // demag_phi is a mesh-vertex observable.  The nonperiodic production
        // solve may use a P2 scalar-potential space with edge DOFs, so export
        // its values at the P1 state/mesh vertices instead of leaking the
        // solver's true-DOF layout through the snapshot ABI.
        mfem::Vector nodal_values;
        potential->GetNodalValues(nodal_values);
        if (nodal_values.Size() != static_cast<int>(expected_len)) {
            error = "demag scalar-potential nodal projection size mismatch: expected " +
                    std::to_string(expected_len) + " but projection has " +
                    std::to_string(nodal_values.Size()) + " values";
            return FULLMAG_FEM_ERR_INVALID;
        }
        std::memcpy(
            out,
            nodal_values.Read(),
            static_cast<size_t>(sizeof(double) * out_len));
    }
    record_device_to_host(ctx.transfer_audit.audit, sizeof(double) * out_len);
    return FULLMAG_FEM_OK;
}
#endif

} // namespace

bool context_sync_gpu_magnetization_to_host(Context &ctx, std::string &error)
{
    if (!ctx.gpu_state.device.lifecycle.allocated ||
        ctx.gpu_state.device.residency.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        ctx.gpu_state.device.residency.host_state != FemGpuSyncState::HostStale) {
        return true;
    }
    if (!gpu_state_download_magnetization_aos(
            ctx.gpu_state.device,
            ctx.state.m_xyz,
            ctx.transfer_audit.audit,
            error)) {
        error = "GPU magnetization readback failed: " + error;
        return false;
    }
    return true;
}

int context_copy_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error)
{
    if (out_xyz == nullptr) {
        error = "output field buffer pointer is null";
        return FULLMAG_FEM_ERR_INVALID;
    }

    if (observable == FULLMAG_FEM_OBSERVABLE_DEMAG_PHI) {
#if FULLMAG_HAS_MFEM_STACK
        return copy_demag_phi_observable_f64(ctx, out_xyz, out_len, error);
#else
        error = "demag scalar potential requires the MFEM stack";
        return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
    }

    const uint64_t expected_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (out_len != expected_len) {
        error = "output field length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    if (observable == FULLMAG_FEM_OBSERVABLE_TORQUE) {
        return copy_torque_observable_f64(ctx, out_xyz, out_len, error);
    }

    if (const auto *visual_source =
            full_domain_visual_field_source(ctx, observable, expected_len)) {
        const uint64_t bytes = sizeof(double) * out_len;
        record_device_to_host(ctx.transfer_audit.audit, bytes);
        std::memcpy(out_xyz, visual_source->data(), static_cast<size_t>(bytes));
        return FULLMAG_FEM_OK;
    }

    if (ctx.gpu_state.device.lifecycle.allocated) {

        const FemGpuComponentField *gpu_field = nullptr;
        const char *label = nullptr;
        switch (observable) {
            case FULLMAG_FEM_OBSERVABLE_H_EX:
                gpu_field = &ctx.gpu_state.device.fields.h_ex;
                label = "H_ex";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_DEMAG:
                gpu_field = &ctx.gpu_state.device.fields.h_demag;
                label = "H_demag";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_EXT:
                gpu_field = &ctx.gpu_state.device.fields.h_ext;
                label = "H_ext";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_DRIVE:
                gpu_field = &ctx.gpu_state.device.fields.h_drive;
                label = "H_drive";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_ANI:
                gpu_field = &ctx.gpu_state.device.fields.h_ani;
                label = "H_ani";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC:
                gpu_field = &ctx.gpu_state.device.fields.h_cubic_ani;
                label = "H_cubic_ani";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_DMI:
                gpu_field = &ctx.gpu_state.device.fields.h_dmi;
                label = "H_dmi";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_DMI_BULK:
                gpu_field = &ctx.gpu_state.device.fields.h_bulk_dmi;
                label = "H_bulk_dmi";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_OE:
                gpu_field = &ctx.gpu_state.device.fields.h_oe;
                label = "H_oe";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_THERM:
                gpu_field = &ctx.gpu_state.device.fields.h_therm;
                label = "H_therm";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_MEL:
                gpu_field = &ctx.gpu_state.device.fields.h_mel;
                label = "H_mel";
                break;
            case FULLMAG_FEM_OBSERVABLE_H_EFF:
                gpu_field = &ctx.gpu_state.device.fields.h_eff;
                label = "H_eff";
                break;
            default:
                break;
        }

        if (gpu_field != nullptr) {
            if (!ctx.gpu_state.device.fields.accepted_observables_valid) {
                error = "GPU accepted-endpoint observable cache is invalid; refresh a snapshot before reading fields";
                return FULLMAG_FEM_ERR_INVALID;
            }
            std::vector<double> tmp;
            if (!gpu_state_download_component_aos(
                    const_cast<FemGpuState &>(ctx.gpu_state.device),
                    *gpu_field,
                    tmp,
                    const_cast<TransferAudit &>(ctx.transfer_audit.audit),
                    label,
                    error)) {
                error = std::string("GPU component download failed: ") + error;
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            if (tmp.size() != static_cast<size_t>(out_len)) {
                error = "GPU component download returned mismatched length";
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            std::memcpy(out_xyz, tmp.data(), static_cast<size_t>(sizeof(double) * out_len));
            return FULLMAG_FEM_OK;
        }
    }

    const std::vector<double> *source = nullptr;
    switch (observable) {
        case FULLMAG_FEM_OBSERVABLE_M:
            source = &ctx.state.m_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EX:
            source = &ctx.exchange.h_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DEMAG:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.demag.h_visual_xyz.empty() &&
                      ctx.demag.h_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.demag.h_visual_xyz
                         : &ctx.demag.h_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EXT:
            source = &ctx.zeeman.h_ext_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DRIVE:
            materialize_regional_field_drive(const_cast<Context &>(ctx), ctx.state.current_time);
            source = &ctx.zeeman.h_drive_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EFF:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = effective_field_source(ctx, expected_len);
            break;
        case FULLMAG_FEM_OBSERVABLE_H_ANI:
            source = &ctx.anisotropy.h_uniaxial_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI:
            source = &ctx.dmi.h_interfacial_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_MEL:
            source = &ctx.magnetoelastic.h_xyz;
            break;
        // F-12 fix: added observables for cubic anisotropy, bulk DMI, Oersted, thermal
        case FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC:
            source = &ctx.anisotropy.h_cubic_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI_BULK:
            source = &ctx.dmi.h_bulk_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_OE:
            materialize_oersted_field(
                const_cast<Context &>(ctx), ctx.state.current_time);
            source = &ctx.oersted.h_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_THERM:
            source = &ctx.thermal_brown.h_xyz;
            break;
        default:
            error = "unsupported FEM observable";
            return FULLMAG_FEM_ERR_INVALID;
    }

    if (source == nullptr || source->size() != static_cast<size_t>(out_len)) {
        // Report an error instead of silently returning zeros when the field
        // has not been computed or has a mismatched size.
        if (source == nullptr || source->empty()) {
            error = "requested field has not been computed yet";
        } else {
            error = "field size mismatch: expected " +
                    std::to_string(out_len) + " but field has " +
                    std::to_string(source->size()) + " elements";
        }
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t bytes = sizeof(double) * out_len;
    record_device_to_host(ctx.transfer_audit.audit, bytes);
    std::memcpy(out_xyz, source->data(), static_cast<size_t>(bytes));
    return FULLMAG_FEM_OK;
}

int context_upload_magnetization_f64(
    Context &ctx,
    const double *m_xyz,
    uint64_t len,
    std::string &error)
{
    if (m_xyz == nullptr) {
        error = "input magnetization pointer is null";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t expected_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (len != expected_len) {
        error = "input magnetization length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    std::vector<double> uploaded_m(m_xyz, m_xyz + static_cast<size_t>(len));
    if (!project_static_periodic_aos_checked(ctx, uploaded_m, error)) {
        error = "upload_magnetization: periodic projection failed: " + error;
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (!normalize_active_magnetization_aos(ctx, uploaded_m, error)) {
        error = "upload_magnetization: " + error;
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (ctx.gpu_state.device.lifecycle.allocated) {
        if (!gpu_state_upload_magnetization_aos(
                ctx.gpu_state.device,
                uploaded_m.data(),
                static_cast<uint64_t>(uploaded_m.size()),
                ctx.transfer_audit.audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    } else {
        record_host_to_device(ctx.transfer_audit.audit, sizeof(double) * len);
    }
    ctx.state.m_xyz = std::move(uploaded_m);
    ctx.relaxation.cached_current_stats_valid = false;
    ctx.stepper.workspace.fsal_valid = false;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.adaptive_dt.has_prev_error_norm = false;
    ctx.demag.cache_valid = false;
    ctx.demag.last_refresh_time = -1.0;

#if FULLMAG_HAS_MFEM_STACK
    if (strict_gpu_demag_upload_path(ctx)) {
        ctx.thermal_brown.sigma = 0.0;
        std::fill(ctx.thermal_brown.h_xyz.begin(), ctx.thermal_brown.h_xyz.end(), 0.0);
        ctx.thermal_brown.last_refresh_time = -1.0;
        ctx.thermal_brown.last_refresh_dt = -1.0;
        return FULLMAG_FEM_OK;
    }

    // FND-004 fix: delegate H_eff assembly to compute_effective_fields_for_magnetization
    // so that all terms (exchange, demag, external, anisotropy, cubic anisotropy,
    // interfacial DMI, bulk DMI, Oersted, magnetoelastic) are included after upload.
    // Thermal noise is intentionally excluded because it is refreshed in the RHS path.
    if (!ctx.mfem_context.ready) {
        if (ctx.exchange.enabled || ctx.demag.enabled || ctx.anisotropy.uniaxial_enabled ||
            ctx.anisotropy.cubic_enabled || ctx.dmi.interfacial_enabled ||
            ctx.dmi.bulk_enabled || ctx.oersted.has_cylinder || ctx.oersted.has_explicit_field ||
            ctx.magnetoelastic.enabled || ctx.stt.zhang_li_enabled ||
            ctx.stt.slonczewski_enabled || ctx.thermal_brown.temperature > 0.0) {
            error = "upload_magnetization: MFEM context is not initialized for enabled field terms";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        fill_zero_vector_field(ctx.exchange.h_xyz, ctx.mesh.n_nodes);
        fill_zero_vector_field(ctx.demag.h_xyz, ctx.mesh.n_nodes);
        if (ctx.zeeman.has_external_field) {
            if (ctx.zeeman.h_ext_xyz.size() != ctx.state.m_xyz.size()) {
                error = "upload_magnetization: external field size mismatch";
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            ctx.effective_field.h_xyz = ctx.zeeman.h_ext_xyz;
        } else {
            fill_zero_vector_field(ctx.effective_field.h_xyz, ctx.mesh.n_nodes);
        }
        if (!ctx.mesh.periodic_reduced_node.empty()) {
            project_static_periodic_aos(ctx, ctx.effective_field.h_xyz);
        }
    } else {
        std::string heff_error;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.state.m_xyz,
                ctx.state.current_time,
                ctx.exchange.h_xyz,
                ctx.demag.h_xyz,
                ctx.effective_field.h_xyz,
                nullptr,   // exchange_energy - not needed on upload
                nullptr,   // demag_energy - not needed on upload
                false,     // allow_interrupt
                nullptr,   // timings
                heff_error)) {
            error = "upload_magnetization: H_eff refresh failed: " + heff_error;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }
#else
    if (!ctx.exchange.enabled) {
        fill_zero_vector_field(ctx.exchange.h_xyz, ctx.mesh.n_nodes);
    }
    if (!ctx.demag.enabled) {
        fill_zero_vector_field(ctx.demag.h_xyz, ctx.mesh.n_nodes);
    }
    // Non-MFEM fallback: compose H_eff from available cached fields.
    if (ctx.zeeman.has_external_field) {
        ctx.effective_field.h_xyz = ctx.zeeman.h_ext_xyz;
        for (size_t i = 0; i < ctx.effective_field.h_xyz.size(); ++i) {
            ctx.effective_field.h_xyz[i] += ctx.exchange.h_xyz[i] + ctx.demag.h_xyz[i];
        }
    } else {
        ctx.effective_field.h_xyz = ctx.exchange.h_xyz;
        for (size_t i = 0; i < ctx.effective_field.h_xyz.size(); ++i) {
            ctx.effective_field.h_xyz[i] += ctx.demag.h_xyz[i];
        }
    }
#endif

    // Thermal noise is refreshed in the RHS/effective-field path, not on upload.
    ctx.thermal_brown.sigma = 0.0;
    std::fill(ctx.thermal_brown.h_xyz.begin(), ctx.thermal_brown.h_xyz.end(), 0.0);
    ctx.thermal_brown.last_refresh_time = -1.0;
    ctx.thermal_brown.last_refresh_dt = -1.0;

    if (ctx.gpu_state.device.lifecycle.allocated) {
        if (!gpu_state_upload_effective_fields_aos(
                ctx.gpu_state.device,
                ctx.exchange.h_xyz.data(),
                ctx.demag.h_xyz.data(),
                ctx.zeeman.h_ext_xyz.data(),
                ctx.effective_field.h_xyz.data(),
                static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
                ctx.transfer_audit.audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        if (!gpu_state_upload_local_vector_fields_aos(
                ctx.gpu_state.device,
                ctx.anisotropy.h_uniaxial_xyz.data(),
                ctx.anisotropy.h_cubic_xyz.data(),
                ctx.dmi.h_interfacial_xyz.data(),
                ctx.dmi.h_bulk_xyz.data(),
                ctx.oersted.h_basis_per_ampere_xyz.data(),
                ctx.oersted.h_xyz.data(),
                ctx.thermal_brown.h_xyz.data(),
                ctx.magnetoelastic.h_xyz.data(),
                static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
                ctx.transfer_audit.audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }

    return FULLMAG_FEM_OK;
}

} // namespace fullmag::fem
