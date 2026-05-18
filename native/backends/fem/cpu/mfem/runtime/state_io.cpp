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
#include "gpu_state.hpp"
#include "transfer_audit.hpp"

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace fullmag::fem {

bool context_sync_gpu_magnetization_to_host(Context &ctx, std::string &error)
{
    if (!ctx.gpu_state.allocated ||
        ctx.gpu_state.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        ctx.gpu_state.host_state != FemGpuSyncState::HostStale) {
        return true;
    }
    if (!gpu_state_download_magnetization_aos(
            ctx.gpu_state,
            ctx.state.m_xyz,
            ctx.transfer_audit,
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

    const uint64_t expected_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (out_len != expected_len) {
        error = "output field length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
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
        case FULLMAG_FEM_OBSERVABLE_H_EFF:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.effective_field.h_visual_xyz.empty() &&
                      ctx.effective_field.h_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.effective_field.h_visual_xyz
                         : &ctx.effective_field.h_xyz;
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
    record_device_to_host(ctx.transfer_audit, bytes);
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

    ctx.state.m_xyz.assign(m_xyz, m_xyz + static_cast<size_t>(len));
    if (ctx.gpu_state.allocated) {
        if (!gpu_state_upload_magnetization_aos(
                ctx.gpu_state,
                ctx.state.m_xyz.data(),
                static_cast<uint64_t>(ctx.state.m_xyz.size()),
                ctx.transfer_audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    } else {
        record_host_to_device(ctx.transfer_audit, sizeof(double) * len);
    }
    ctx.stepper.fsal_valid = false;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.demag.cache_valid = false;
    ctx.demag.last_refresh_time = -1.0;

#if FULLMAG_HAS_MFEM_STACK
    // FND-004 fix: delegate H_eff assembly to compute_effective_fields_for_magnetization
    // so that all terms (exchange, demag, external, anisotropy, cubic anisotropy,
    // interfacial DMI, bulk DMI, Oersted, magnetoelastic) are included after upload.
    // Thermal noise is intentionally excluded because it is refreshed in the RHS path.
    {
        std::string heff_error;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.state.m_xyz,
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

    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.exchange.h_xyz.data(),
            ctx.demag.h_xyz.data(),
            ctx.zeeman.h_ext_xyz.data(),
            ctx.effective_field.h_xyz.data(),
            static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.anisotropy.h_uniaxial_xyz.data(),
            ctx.anisotropy.h_cubic_xyz.data(),
            ctx.dmi.h_interfacial_xyz.data(),
            ctx.dmi.h_bulk_xyz.data(),
            ctx.oersted.h_xyz.data(),
            ctx.thermal_brown.h_xyz.data(),
            ctx.magnetoelastic.h_xyz.data(),
            static_cast<uint64_t>(ctx.effective_field.h_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    return FULLMAG_FEM_OK;
}

} // namespace fullmag::fem
