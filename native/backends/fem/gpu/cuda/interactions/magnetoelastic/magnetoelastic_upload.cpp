/*
 * GPU CUDA magnetoelastic upload source contract.
 *
 * Keeps prescribed-strain upload ownership in the CUDA magnetoelastic module
 * instead of FemGpuState lifecycle code.
 */

#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.hpp"

#include <limits>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}
#endif

} // namespace

bool gpu_magnetoelastic_upload_strain(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuMagnetoelasticDeviceState &magnetoelastic,
    const double *strain_voigt,
    uint64_t strain_len,
    TransferAudit &audit,
    std::string &error)
{
    magnetoelastic.strain_voigt_len = 0;
    magnetoelastic.strain_uploaded = false;
    if (!lifecycle.allocated) {
        return true;
    }
    const uint64_t expected_len = lifecycle.node_count * 6ull;
    if (strain_voigt == nullptr || strain_len != expected_len) {
        error = "FemGpuState magnetoelastic strain upload requires 6 Voigt values per node";
        return false;
    }
    if (magnetoelastic.strain_voigt == nullptr) {
        error = "FemGpuState magnetoelastic strain upload requires allocated device buffer";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    if (strain_len > std::numeric_limits<size_t>::max() / sizeof(double)) {
        error = "FemGpuState magnetoelastic strain buffer is too large for upload";
        return false;
    }
    const size_t bytes = static_cast<size_t>(strain_len) * sizeof(double);
    if (!cuda_ok(cudaMemcpy(magnetoelastic.strain_voigt, strain_voigt, bytes, cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState magnetoelastic.strain_voigt host->device", error)) {
        return false;
    }
    record_host_to_device(audit, static_cast<uint64_t>(bytes));
    magnetoelastic.strain_voigt_len = strain_len;
    magnetoelastic.strain_uploaded = true;
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

} // namespace fullmag::fem
