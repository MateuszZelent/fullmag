#pragma once

/*
 * GPU CUDA sparse CSR DMI operator module header.
 *
 * Declares MFEM-backed assembly of skew-symmetric edge-vector DMI CSR data
 * (tet4, prism6, mixed), optional periodic class reduction, and GPU upload/free.
 */

#include "gpu/cuda/interactions/dmi/dmi_csr_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

struct GpuDmiCsrHostData {
    uint32_t rows = 0;
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> dx;
    std::vector<double> dy;
    std::vector<double> dz;

    bool has_periodic_reduced = false;
    uint32_t periodic_reduced_rows = 0;
    std::vector<uint32_t> periodic_reduced_row_offsets;
    std::vector<uint32_t> periodic_reduced_col_indices;
    std::vector<double> periodic_reduced_dx;
    std::vector<double> periodic_reduced_dy;
    std::vector<double> periodic_reduced_dz;
    std::vector<double> periodic_reduced_mass;
};

bool build_gpu_dmi_csr_from_mfem(
    const Context &ctx,
    bool bulk_mode,
    GpuDmiCsrHostData &out,
    std::string &error);

bool gpu_dmi_csr_upload_channel(
    FemGpuLifecycleDeviceState &lifecycle,
    GpuDmiCsrChannelDeviceState &channel,
    const GpuDmiCsrHostData &host_data,
    TransferAudit &audit,
    std::string &error);

void gpu_dmi_csr_free(
    FemGpuLifecycleDeviceState &lifecycle,
    FemGpuDmiCsrDeviceState &state);

bool context_upload_mfem_dmi_to_gpu_state(
    Context &ctx,
    std::string &error);

} // namespace fullmag::fem
