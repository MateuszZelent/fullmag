/*
 * GPU CUDA field-buffer upload source contract.
 *
 * Keeps host-to-device field-buffer upload details in the CUDA fields module
 * instead of FemGpuState lifecycle code.
 */

#include "gpu/cuda/fields/field_buffer_upload.hpp"

#include "gpu/cuda/transfer/component_transfer.hpp"

namespace fullmag::fem {

bool gpu_field_buffers_upload_effective_fields_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuFieldBufferDeviceState &fields,
    const double *h_ex_xyz,
    const double *h_demag_xyz,
    const double *h_ext_xyz,
    const double *h_eff_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }
    return gpu_component_upload_aos(
               lifecycle, fields.h_ex, h_ex_xyz, len, "h_ex", audit, error) &&
           gpu_component_upload_aos(
               lifecycle, fields.h_demag, h_demag_xyz, len, "h_demag", audit, error) &&
           gpu_component_upload_aos(
               lifecycle, fields.h_ext, h_ext_xyz, len, "h_ext", audit, error) &&
           gpu_component_upload_aos(
               lifecycle, fields.h_eff, h_eff_xyz, len, "h_eff", audit, error);
}

bool gpu_field_buffers_upload_demag_field_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuFieldBufferDeviceState &fields,
    const double *h_demag_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_component_upload_aos(
        lifecycle,
        fields.h_demag,
        h_demag_xyz,
        len,
        "h_demag",
        audit,
        error);
}

bool gpu_field_buffers_upload_local_vector_fields_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuFieldBufferDeviceState &fields,
    const double *h_ani_xyz,
    const double *h_cubic_ani_xyz,
    const double *h_dmi_xyz,
    const double *h_bulk_dmi_xyz,
    const double *h_oe_xyz,
    const double *h_therm_xyz,
    const double *h_mel_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }
    return gpu_component_upload_optional_aos(
               lifecycle, fields.h_ani, h_ani_xyz, len, "h_ani", audit, error) &&
           gpu_component_upload_optional_aos(
               lifecycle, fields.h_cubic_ani, h_cubic_ani_xyz, len, "h_cubic_ani", audit, error) &&
           gpu_component_upload_optional_aos(
               lifecycle, fields.h_dmi, h_dmi_xyz, len, "h_dmi", audit, error) &&
           gpu_component_upload_optional_aos(
               lifecycle, fields.h_bulk_dmi, h_bulk_dmi_xyz, len, "h_bulk_dmi", audit, error) &&
           gpu_component_upload_optional_aos(
               lifecycle, fields.h_oe, h_oe_xyz, len, "h_oe", audit, error) &&
           gpu_component_upload_optional_aos(
               lifecycle, fields.h_therm, h_therm_xyz, len, "h_therm", audit, error) &&
           gpu_component_upload_optional_aos(
               lifecycle, fields.h_mel, h_mel_xyz, len, "h_mel", audit, error);
}

} // namespace fullmag::fem
