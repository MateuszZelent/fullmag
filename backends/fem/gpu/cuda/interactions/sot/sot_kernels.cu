// GPU CUDA prescribed-SOT kernel source contract.
// This source owns only the local prescribed_sot.fullmag.v1 algebra.

#include "gpu/cuda/interactions/sot/sot_kernels.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;
constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
constexpr double kHbar = 1.054571817e-34;
constexpr double kExactElectronCharge = 1.602176634e-19;

__global__ void prescribed_sot_rhs_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ alpha,
    const uint8_t *__restrict__ magnetic_node_mask,
    const uint8_t *__restrict__ active_node_mask,
    double *__restrict__ dmx,
    double *__restrict__ dmy,
    double *__restrict__ dmz,
    double *__restrict__ block_max_rhs,
    double current_density_am2,
    double xi_dl,
    double xi_fl,
    double envelope_value,
    double gamma0,
    double thickness,
    double sigma_x,
    double sigma_y,
    double sigma_z,
    int node_count)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double rhs_norm = 0.0;
    if (i < node_count) {
        if ((magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u) &&
            (active_node_mask == nullptr || active_node_mask[i] != 0u)) {
            const double ms_i = ms[i];
            const double alpha_i = alpha != nullptr ? alpha[i] : 0.0;
            const double sigma_norm = sqrt(
                sigma_x * sigma_x + sigma_y * sigma_y + sigma_z * sigma_z);
            if (isfinite(ms_i) && ms_i > 0.0 && isfinite(alpha_i) &&
                isfinite(sigma_norm) && sigma_norm > 1.0e-30 &&
                isfinite(thickness) && thickness > 0.0) {
                const double sx = sigma_x / sigma_norm;
                const double sy = sigma_y / sigma_norm;
                const double sz = sigma_z / sigma_norm;
                const double gamma_e = gamma0 / kMu0;
                const double omega_base = gamma_e * kHbar *
                    (current_density_am2 * envelope_value) /
                    (2.0 * kExactElectronCharge * ms_i * thickness);
                const double omega_dl = omega_base * xi_dl;
                const double omega_fl = omega_base * xi_fl;
                const double inv_gilbert = 1.0 / (1.0 + alpha_i * alpha_i);
                const double damping_like =
                    (omega_dl - alpha_i * omega_fl) * inv_gilbert;
                const double field_like =
                    (omega_fl + alpha_i * omega_dl) * inv_gilbert;
                const double lmx = mx[i];
                const double lmy = my[i];
                const double lmz = mz[i];
                const double mxs_x = lmy * sz - lmz * sy;
                const double mxs_y = lmz * sx - lmx * sz;
                const double mxs_z = lmx * sy - lmy * sx;
                const double mxmxs_x = lmy * mxs_z - lmz * mxs_y;
                const double mxmxs_y = lmz * mxs_x - lmx * mxs_z;
                const double mxmxs_z = lmx * mxs_y - lmy * mxs_x;

                dmx[i] += -damping_like * mxmxs_x + field_like * mxs_x;
                dmy[i] += -damping_like * mxmxs_y + field_like * mxs_y;
                dmz[i] += -damping_like * mxmxs_z + field_like * mxs_z;
            }
        }
        rhs_norm = sqrt(dmx[i] * dmx[i] + dmy[i] * dmy[i] + dmz[i] * dmz[i]);
    }

    typedef cub::BlockReduce<double, kBlockSize> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_max = BlockReduce(temp_storage).Reduce(rhs_norm, cub::Max());
    if (threadIdx.x == 0 && block_max_rhs != nullptr) {
        block_max_rhs[blockIdx.x] = block_max;
    }
}

} // namespace

void fullmag_cuda_add_prescribed_sot_rhs(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *alpha,
    const uint8_t *magnetic_node_mask,
    const uint8_t *active_node_mask,
    double *dmx,
    double *dmy,
    double *dmz,
    double *block_max_rhs,
    double current_density_am2,
    double xi_dl,
    double xi_fl,
    double envelope_value,
    double gamma0,
    double thickness,
    double sigma_x,
    double sigma_y,
    double sigma_z,
    int node_count,
    cudaStream_t stream)
{
    if (node_count <= 0) {
        return;
    }
    const int num_blocks = (node_count + kBlockSize - 1) / kBlockSize;
    prescribed_sot_rhs_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        alpha,
        magnetic_node_mask,
        active_node_mask,
        dmx,
        dmy,
        dmz,
        block_max_rhs,
        current_density_am2,
        xi_dl,
        xi_fl,
        envelope_value,
        gamma0,
        thickness,
        sigma_x,
        sigma_y,
        sigma_z,
        node_count);
}

} // namespace fullmag::fem
