// ── GPU CUDA STT kernels source contract ──────────────────────────────
// This source owns Slonczewski CPP and Zhang-Li CIP spin-transfer torque CUDA
// wrappers. It does not own RK orchestration, Context construction, plan import,
// exchange, demag, DMI, thermal, magnetoelastic, or C ABI entrypoints.

#include "gpu/cuda/interactions/stt/stt_kernels.hpp"

#include <cmath>
#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

static __device__ double stt_atomic_add_double(double *address, double value)
{
#if __CUDA_ARCH__ < 600
    auto *address_as_ull = reinterpret_cast<unsigned long long int *>(address);
    unsigned long long int old = *address_as_ull;
    unsigned long long int assumed = 0u;
    do {
        assumed = old;
        old = atomicCAS(
            address_as_ull,
            assumed,
            __double_as_longlong(value + __longlong_as_double(assumed)));
    } while (assumed != old);
    return __longlong_as_double(old);
#else
    return atomicAdd(address, value);
#endif
}

static __device__ bool stt_tetra_gradients_device(
    const double *nodes_xyz,
    uint32_t n0,
    uint32_t n1,
    uint32_t n2,
    uint32_t n3,
    double grads[4][3],
    double &volume)
{
    constexpr double kGeomEpsDevice = 1.0e-30;
    const double p0x = nodes_xyz[static_cast<size_t>(n0) * 3u + 0u];
    const double p0y = nodes_xyz[static_cast<size_t>(n0) * 3u + 1u];
    const double p0z = nodes_xyz[static_cast<size_t>(n0) * 3u + 2u];
    const double d1x = nodes_xyz[static_cast<size_t>(n1) * 3u + 0u] - p0x;
    const double d1y = nodes_xyz[static_cast<size_t>(n1) * 3u + 1u] - p0y;
    const double d1z = nodes_xyz[static_cast<size_t>(n1) * 3u + 2u] - p0z;
    const double d2x = nodes_xyz[static_cast<size_t>(n2) * 3u + 0u] - p0x;
    const double d2y = nodes_xyz[static_cast<size_t>(n2) * 3u + 1u] - p0y;
    const double d2z = nodes_xyz[static_cast<size_t>(n2) * 3u + 2u] - p0z;
    const double d3x = nodes_xyz[static_cast<size_t>(n3) * 3u + 0u] - p0x;
    const double d3y = nodes_xyz[static_cast<size_t>(n3) * 3u + 1u] - p0y;
    const double d3z = nodes_xyz[static_cast<size_t>(n3) * 3u + 2u] - p0z;

    const double c23x = d2y * d3z - d2z * d3y;
    const double c23y = d2z * d3x - d2x * d3z;
    const double c23z = d2x * d3y - d2y * d3x;
    const double det = d1x * c23x + d1y * c23y + d1z * c23z;
    if (!(fabs(det) > kGeomEpsDevice) || !isfinite(det)) {
        volume = 0.0;
        return false;
    }
    volume = fabs(det) / 6.0;
    const double inv_det = 1.0 / det;
    grads[1][0] =  (d2y * d3z - d2z * d3y) * inv_det;
    grads[1][1] = -(d2x * d3z - d2z * d3x) * inv_det;
    grads[1][2] =  (d2x * d3y - d2y * d3x) * inv_det;
    grads[2][0] = -(d1y * d3z - d1z * d3y) * inv_det;
    grads[2][1] =  (d1x * d3z - d1z * d3x) * inv_det;
    grads[2][2] = -(d1x * d3y - d1y * d3x) * inv_det;
    grads[3][0] =  (d1y * d2z - d1z * d2y) * inv_det;
    grads[3][1] = -(d1x * d2z - d1z * d2x) * inv_det;
    grads[3][2] =  (d1x * d2y - d1y * d2x) * inv_det;
    for (int dir = 0; dir < 3; ++dir) {
        grads[0][dir] = -(grads[1][dir] + grads[2][dir] + grads[3][dir]);
    }
    return true;
}

__global__ void slonczewski_stt_rhs_kernel(
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
    double current_density_x,
    double current_density_y,
    double current_density_z,
    double current_sign,
    double gamma_mu0,
    double uniform_alpha,
    double free_layer_thickness,
    double degree,
    double lambda,
    double epsilon_prime,
    double px,
    double py,
    double pz,
    double stack_normal_x,
    double stack_normal_y,
    double stack_normal_z,
    uint32_t formula_version,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    constexpr double kHbar = 1.054571817e-34;
    constexpr double kLegacyElectronCharge = 1.60217662e-19;
    constexpr double kExactElectronCharge = 1.602176634e-19;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double rhs_norm = 0.0;
    if (i < N &&
        (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u) &&
        (active_node_mask == nullptr || active_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double current_density_mag = sqrt(
            current_density_x * current_density_x +
            current_density_y * current_density_y +
            current_density_z * current_density_z);
        const bool canonical_v2 =
            formula_version == FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2;
        const double signed_current = canonical_v2
            ? current_density_x * stack_normal_x +
                current_density_y * stack_normal_y +
                current_density_z * stack_normal_z
            : current_sign * current_density_mag;
        if (signed_current != 0.0 && free_layer_thickness > 0.0 && ms_i > 0.0) {
            const double alpha_i = alpha != nullptr ? alpha[i] : uniform_alpha;
            const double lmx = mx[i], lmy = my[i], lmz = mz[i];
            const double lambda_sq = lambda * lambda;
            const double m_dot_p = lmx * px + lmy * py + lmz * pz;
            const double denominator = (lambda_sq + 1.0) + (lambda_sq - 1.0) * m_dot_p;
            const double g = denominator != 0.0 ? (degree * lambda_sq) / denominator : 0.0;
            const double prefactor =
                (signed_current * kHbar * gamma_mu0) /
                ((canonical_v2 ? 1.0 : 2.0) *
                 (canonical_v2 ? kExactElectronCharge : kLegacyElectronCharge) *
                 kMu0 * ms_i * free_layer_thickness);
            const double inv_gilbert = 1.0 / (1.0 + alpha_i * alpha_i);
            const double damping_like = canonical_v2
                ? prefactor * (g + alpha_i * epsilon_prime) * inv_gilbert
                : prefactor * g * (1.0 + alpha_i * epsilon_prime) * inv_gilbert;
            const double field_like = canonical_v2
                ? prefactor * (epsilon_prime - alpha_i * g) * inv_gilbert
                : prefactor * g * (epsilon_prime - alpha_i) * inv_gilbert;

            const double mxp_x = lmy * pz - lmz * py;
            const double mxp_y = lmz * px - lmx * pz;
            const double mxp_z = lmx * py - lmy * px;
            const double mxmxp_x = lmy * mxp_z - lmz * mxp_y;
            const double mxmxp_y = lmz * mxp_x - lmx * mxp_z;
            const double mxmxp_z = lmx * mxp_y - lmy * mxp_x;

            dmx[i] += damping_like * mxmxp_x + field_like * mxp_x;
            dmy[i] += damping_like * mxmxp_y + field_like * mxp_y;
            dmz[i] += damping_like * mxmxp_z + field_like * mxp_z;
        }
        rhs_norm = sqrt(dmx[i] * dmx[i] + dmy[i] * dmy[i] + dmz[i] * dmz[i]);
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_max = BlockReduce(temp_storage).Reduce(rhs_norm, cub::Max());
    if (threadIdx.x == 0 && block_max_rhs != nullptr) {
        block_max_rhs[blockIdx.x] = block_max;
    }
}

__global__ void clear_zhang_li_workspace_kernel(
    double *work_x,
    double *work_y,
    double *work_z,
    double *node_weight,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        work_x[i] = 0.0;
        work_y[i] = 0.0;
        work_z[i] = 0.0;
        node_weight[i] = 0.0;
    }
}

__global__ void zhang_li_element_rhs_kernel(
    const double *__restrict__ nodes_xyz,
    const uint32_t *__restrict__ elements,
    const uint8_t *__restrict__ magnetic_element_mask,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ alpha,
    double *__restrict__ work_x,
    double *__restrict__ work_y,
    double *__restrict__ work_z,
    double *__restrict__ node_weight,
    double current_x,
    double current_y,
    double current_z,
    double degree,
    double beta,
    double uniform_alpha,
    int element_count)
{
    constexpr double kMuB = 9.274009994e-24;
    constexpr double kElectronCharge = 1.60217662e-19;

    const int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= element_count || (magnetic_element_mask != nullptr && magnetic_element_mask[e] == 0u)) {
        return;
    }
    const size_t base = static_cast<size_t>(e) * 4u;
    const uint32_t nodes[4] = {
        elements[base + 0u],
        elements[base + 1u],
        elements[base + 2u],
        elements[base + 3u],
    };
    double grads[4][3];
    double volume = 0.0;
    if (!stt_tetra_gradients_device(nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume)) {
        return;
    }
    double elem_ms = 0.0;
    for (int local = 0; local < 4; ++local) {
        elem_ms += ms[nodes[local]];
    }
    elem_ms *= 0.25;
    if (!(elem_ms > 0.0)) {
        return;
    }
    const double drift_prefactor =
        (degree * kMuB) / (kElectronCharge * elem_ms * (1.0 + beta * beta));
    const double ux = current_x * drift_prefactor;
    const double uy = current_y * drift_prefactor;
    const double uz = current_z * drift_prefactor;

    double grad_m[3][3] = {};
    for (int local = 0; local < 4; ++local) {
        const uint32_t node = nodes[local];
        const double m[3] = {mx[node], my[node], mz[node]};
        for (int component = 0; component < 3; ++component) {
            grad_m[component][0] += m[component] * grads[local][0];
            grad_m[component][1] += m[component] * grads[local][1];
            grad_m[component][2] += m[component] * grads[local][2];
        }
    }
    const double dm_x = ux * grad_m[0][0] + uy * grad_m[0][1] + uz * grad_m[0][2];
    const double dm_y = ux * grad_m[1][0] + uy * grad_m[1][1] + uz * grad_m[1][2];
    const double dm_z = ux * grad_m[2][0] + uy * grad_m[2][1] + uz * grad_m[2][2];
    const double nodal_weight = volume * 0.25;
    for (int local = 0; local < 4; ++local) {
        const uint32_t node = nodes[local];
        const double lmx = mx[node];
        const double lmy = my[node];
        const double lmz = mz[node];
        const double alpha_i = alpha != nullptr ? alpha[node] : uniform_alpha;
        const double c_x = lmy * dm_z - lmz * dm_y;
        const double c_y = lmz * dm_x - lmx * dm_z;
        const double c_z = lmx * dm_y - lmy * dm_x;
        const double dc_x = lmy * c_z - lmz * c_y;
        const double dc_y = lmz * c_x - lmx * c_z;
        const double dc_z = lmx * c_y - lmy * c_x;
        const double inv_gilbert = 1.0 / (1.0 + alpha_i * alpha_i);
        const double adiabatic_scale = (1.0 + alpha_i * beta) * inv_gilbert;
        const double cross_scale = (alpha_i - beta) * inv_gilbert;
        stt_atomic_add_double(
            &work_x[node],
            nodal_weight * (adiabatic_scale * (-dc_x) + cross_scale * c_x));
        stt_atomic_add_double(
            &work_y[node],
            nodal_weight * (adiabatic_scale * (-dc_y) + cross_scale * c_y));
        stt_atomic_add_double(
            &work_z[node],
            nodal_weight * (adiabatic_scale * (-dc_z) + cross_scale * c_z));
        stt_atomic_add_double(&node_weight[node], nodal_weight);
    }
}

__global__ void zhang_li_normalize_add_rhs_kernel(
    const uint8_t *__restrict__ magnetic_node_mask,
    const double *__restrict__ work_x,
    const double *__restrict__ work_y,
    const double *__restrict__ work_z,
    const double *__restrict__ node_weight,
    double *__restrict__ dmx,
    double *__restrict__ dmy,
    double *__restrict__ dmz,
    double *__restrict__ block_max_rhs,
    int N)
{
    constexpr double kGeomEpsDevice = 1.0e-30;
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double rhs_norm = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double weight = node_weight[i];
        if (weight > kGeomEpsDevice) {
            const double inv_weight = 1.0 / weight;
            dmx[i] += work_x[i] * inv_weight;
            dmy[i] += work_y[i] * inv_weight;
            dmz[i] += work_z[i] * inv_weight;
        }
        rhs_norm = sqrt(dmx[i] * dmx[i] + dmy[i] * dmy[i] + dmz[i] * dmz[i]);
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_max = BlockReduce(temp_storage).Reduce(rhs_norm, cub::Max());
    if (threadIdx.x == 0 && block_max_rhs != nullptr) {
        block_max_rhs[blockIdx.x] = block_max;
    }
}

void fullmag_cuda_add_slonczewski_stt_rhs(
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
    double current_density_x,
    double current_density_y,
    double current_density_z,
    double current_sign,
    double gamma_mu0,
    double uniform_alpha,
    double free_layer_thickness,
    double degree,
    double lambda,
    double epsilon_prime,
    double px,
    double py,
    double pz,
    double stack_normal_x,
    double stack_normal_y,
    double stack_normal_z,
    uint32_t formula_version,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    slonczewski_stt_rhs_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
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
        current_density_x,
        current_density_y,
        current_density_z,
        current_sign,
        gamma_mu0,
        uniform_alpha,
        free_layer_thickness,
        degree,
        lambda,
        epsilon_prime,
        px,
        py,
        pz,
        stack_normal_x,
        stack_normal_y,
        stack_normal_z,
        formula_version,
        N);
}

void fullmag_cuda_add_zhang_li_stt_rhs(
    const double *nodes_xyz,
    const uint32_t *elements,
    const uint8_t *magnetic_element_mask,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *alpha,
    const uint8_t *magnetic_node_mask,
    double *work_x,
    double *work_y,
    double *work_z,
    double *node_weight,
    double *dmx,
    double *dmy,
    double *dmz,
    double *block_max_rhs,
    double current_x,
    double current_y,
    double current_z,
    double degree,
    double beta,
    double uniform_alpha,
    int element_count,
    int node_count,
    cudaStream_t stream)
{
    const int node_blocks = (node_count + kBlockSize - 1) / kBlockSize;
    clear_zhang_li_workspace_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
        work_x,
        work_y,
        work_z,
        node_weight,
        node_count);
    const int element_blocks = (element_count + kBlockSize - 1) / kBlockSize;
    zhang_li_element_rhs_kernel<<<element_blocks, kBlockSize, 0, stream>>>(
        nodes_xyz,
        elements,
        magnetic_element_mask,
        mx,
        my,
        mz,
        ms,
        alpha,
        work_x,
        work_y,
        work_z,
        node_weight,
        current_x,
        current_y,
        current_z,
        degree,
        beta,
        uniform_alpha,
        element_count);
    zhang_li_normalize_add_rhs_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
        magnetic_node_mask,
        work_x,
        work_y,
        work_z,
        node_weight,
        dmx,
        dmy,
        dmz,
        block_max_rhs,
        node_count);
}

} // namespace fullmag::fem
