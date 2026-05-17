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
            ctx.m_xyz,
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

    const uint64_t expected_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (out_len != expected_len) {
        error = "output field length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const std::vector<double> *source = nullptr;
    switch (observable) {
        case FULLMAG_FEM_OBSERVABLE_M:
            source = &ctx.m_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EX:
            source = &ctx.h_ex_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DEMAG:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.h_demag_visual_xyz.empty() &&
                      ctx.h_demag_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.h_demag_visual_xyz
                         : &ctx.h_demag_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EXT:
            source = &ctx.h_ext_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EFF:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.h_eff_visual_xyz.empty() &&
                      ctx.h_eff_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.h_eff_visual_xyz
                         : &ctx.h_eff_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_ANI:
            source = &ctx.h_ani_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI:
            source = &ctx.h_dmi_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_MEL:
            source = &ctx.h_mel_xyz;
            break;
        // F-12 fix: added observables for cubic anisotropy, bulk DMI, Oersted, thermal
        case FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC:
            source = &ctx.h_cubic_ani_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI_BULK:
            source = &ctx.h_bulk_dmi_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_OE:
            source = &ctx.h_oe_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_THERM:
            source = &ctx.h_therm_xyz;
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

    const uint64_t expected_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (len != expected_len) {
        error = "input magnetization length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    ctx.m_xyz.assign(m_xyz, m_xyz + static_cast<size_t>(len));
    if (ctx.gpu_state.allocated) {
        if (!gpu_state_upload_magnetization_aos(
                ctx.gpu_state,
                ctx.m_xyz.data(),
                static_cast<uint64_t>(ctx.m_xyz.size()),
                ctx.transfer_audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    } else {
        record_host_to_device(ctx.transfer_audit, sizeof(double) * len);
    }
    ctx.stepper.fsal_valid = false;
    ctx.prev_error_norm = 1.0;
    ctx.demag_cache_valid = false;
    ctx.demag_last_refresh_time = -1.0;

#if FULLMAG_HAS_MFEM_STACK
    // FND-004 fix: delegate H_eff assembly to compute_effective_fields_for_magnetization
    // so that all terms (exchange, demag, external, anisotropy, cubic anisotropy,
    // interfacial DMI, bulk DMI, Oersted, magnetoelastic) are included after upload.
    // Thermal noise is intentionally excluded because it is refreshed in the RHS path.
    {
        std::string heff_error;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                ctx.h_ex_xyz,
                ctx.h_demag_xyz,
                ctx.h_eff_xyz,
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
    if (!ctx.enable_exchange) {
        fill_zero_vector_field(ctx.h_ex_xyz, ctx.n_nodes);
    }
    if (!ctx.enable_demag) {
        fill_zero_vector_field(ctx.h_demag_xyz, ctx.n_nodes);
    }
    // Non-MFEM fallback: compose H_eff from available cached fields.
    if (ctx.has_external_field) {
        ctx.h_eff_xyz = ctx.h_ext_xyz;
        for (size_t i = 0; i < ctx.h_eff_xyz.size(); ++i) {
            ctx.h_eff_xyz[i] += ctx.h_ex_xyz[i] + ctx.h_demag_xyz[i];
        }
    } else {
        ctx.h_eff_xyz = ctx.h_ex_xyz;
        for (size_t i = 0; i < ctx.h_eff_xyz.size(); ++i) {
            ctx.h_eff_xyz[i] += ctx.h_demag_xyz[i];
        }
    }
#endif

    // Thermal noise is refreshed in the RHS/effective-field path, not on upload.
    ctx.thermal_sigma = 0.0;
    std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
    ctx.last_thermal_refresh_time = -1.0;
    ctx.last_thermal_refresh_dt = -1.0;

    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.h_ex_xyz.data(),
            ctx.h_demag_xyz.data(),
            ctx.h_ext_xyz.data(),
            ctx.h_eff_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.h_ani_xyz.data(),
            ctx.h_cubic_ani_xyz.data(),
            ctx.h_dmi_xyz.data(),
            ctx.h_bulk_dmi_xyz.data(),
            ctx.h_oe_xyz.data(),
            ctx.h_therm_xyz.data(),
            ctx.h_mel_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    return FULLMAG_FEM_OK;
}

} // namespace fullmag::fem
