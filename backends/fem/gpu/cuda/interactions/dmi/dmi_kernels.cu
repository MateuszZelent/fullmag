// ── GPU CUDA DMI kernels source contract ──────────────────────────────
// This source owns interfacial and bulk DMI weak-residual CUDA wrappers. It
// does not own RK orchestration, Context construction, material upload, exchange,
// demag, STT, thermal, magnetoelastic, or C ABI entrypoints.

#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"

#include <cmath>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

static __device__ double dmi_atomic_add_double(double *address, double value)
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

static __device__ bool dmi_tetra_gradients_device(
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

__global__ void dmi_element_residual_kernel(
    const double *__restrict__ nodes_xyz,
    const uint32_t *__restrict__ elements,
    const uint8_t *__restrict__ magnetic_element_mask,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ d_field,
    double *__restrict__ residual_x,
    double *__restrict__ residual_y,
    double *__restrict__ residual_z,
    double *__restrict__ energy_out,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count)
{
    const int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= element_count) {
        return;
    }
    if (magnetic_element_mask != nullptr && magnetic_element_mask[e] == 0u) {
        return;
    }
    const size_t ebase = static_cast<size_t>(e) * 4u;
    const uint32_t nodes[4] = {
        elements[ebase + 0u],
        elements[ebase + 1u],
        elements[ebase + 2u],
        elements[ebase + 3u],
    };
    double grads[4][3];
    double volume = 0.0;
    if (!dmi_tetra_gradients_device(nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume)) {
        return;
    }
    double elem_d = uniform_d;
    if (use_d_field && d_field != nullptr) {
        elem_d = 0.0;
        for (int local = 0; local < 4; ++local) {
            elem_d += d_field[nodes[local]];
        }
        elem_d *= 0.25;
    }
    if (elem_d == 0.0) {
        return;
    }

    double grad_m[3][3] = {};
    double m_q[3] = {};
    for (int local = 0; local < 4; ++local) {
        const uint32_t node = nodes[local];
        const double m[3] = {mx[node], my[node], mz[node]};
        for (int comp = 0; comp < 3; ++comp) {
            m_q[comp] += 0.25 * m[comp];
            grad_m[comp][0] += m[comp] * grads[local][0];
            grad_m[comp][1] += m[comp] * grads[local][1];
            grad_m[comp][2] += m[comp] * grads[local][2];
        }
    }

    const double weight = volume;
    const double div_m = grad_m[0][0] + grad_m[1][1] + grad_m[2][2];
    const double curl_m[3] = {
        grad_m[2][1] - grad_m[1][2],
        grad_m[0][2] - grad_m[2][0],
        grad_m[1][0] - grad_m[0][1],
    };
    const double grad_m_dot_n[3] = {
        nx * grad_m[0][0] + ny * grad_m[1][0] + nz * grad_m[2][0],
        nx * grad_m[0][1] + ny * grad_m[1][1] + nz * grad_m[2][1],
        nx * grad_m[0][2] + ny * grad_m[1][2] + nz * grad_m[2][2],
    };
    const double m_dot_n = m_q[0] * nx + m_q[1] * ny + m_q[2] * nz;
    for (int local = 0; local < 4; ++local) {
        const uint32_t node = nodes[local];
        const double shape = 0.25;
        const double *grad_shape = grads[local];
        double residual[3] = {};
        if (bulk_mode) {
            residual[0] = elem_d * weight *
                (shape * curl_m[0] + m_q[1] * grad_shape[2] - m_q[2] * grad_shape[1]);
            residual[1] = elem_d * weight *
                (shape * curl_m[1] - m_q[0] * grad_shape[2] + m_q[2] * grad_shape[0]);
            residual[2] = elem_d * weight *
                (shape * curl_m[2] + m_q[0] * grad_shape[1] - m_q[1] * grad_shape[0]);
        } else {
            for (int comp = 0; comp < 3; ++comp) {
                const double n_comp = comp == 0 ? nx : (comp == 1 ? ny : nz);
                const double dw_dm = elem_d * (n_comp * div_m - grad_m_dot_n[comp]);
                double grad_action = 0.0;
                for (int dir = 0; dir < 3; ++dir) {
                    const double delta = comp == dir ? 1.0 : 0.0;
                    const double m_dir = dir == 0 ? m_q[0] : (dir == 1 ? m_q[1] : m_q[2]);
                    const double dw_dg = elem_d * (m_dot_n * delta - n_comp * m_dir);
                    grad_action += dw_dg * grad_shape[dir];
                }
                residual[comp] = weight * (shape * dw_dm + grad_action);
            }
        }
        dmi_atomic_add_double(&residual_x[node], residual[0]);
        dmi_atomic_add_double(&residual_y[node], residual[1]);
        dmi_atomic_add_double(&residual_z[node], residual[2]);
    }

    double energy = 0.0;
    if (bulk_mode) {
        energy = elem_d *
            (m_q[0] * curl_m[0] + m_q[1] * curl_m[1] + m_q[2] * curl_m[2]) *
            weight;
    } else {
        const double m_grad_mn =
            m_q[0] * grad_m_dot_n[0] +
            m_q[1] * grad_m_dot_n[1] +
            m_q[2] * grad_m_dot_n[2];
        energy = elem_d * (m_dot_n * div_m - m_grad_mn) * weight;
    }
    if (energy_out != nullptr) {
        dmi_atomic_add_double(energy_out, energy);
    }
}

__global__ void dmi_project_field_kernel(
    const double *__restrict__ residual_x,
    const double *__restrict__ residual_y,
    const double *__restrict__ residual_z,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_dmi_x,
    double *__restrict__ h_dmi_y,
    double *__restrict__ h_dmi_z,
    double uniform_ms,
    int node_count)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    constexpr double kTinyDevice = 1.0e-300;
    const int node = blockIdx.x * blockDim.x + threadIdx.x;
    if (node >= node_count) {
        return;
    }
    h_dmi_x[node] = 0.0;
    h_dmi_y[node] = 0.0;
    h_dmi_z[node] = 0.0;
    if (magnetic_node_mask != nullptr && magnetic_node_mask[node] == 0u) {
        return;
    }
    const double mass = lumped_mass[node];
    const double ms_i = ms != nullptr ? ms[node] : uniform_ms;
    if (mass > 0.0 && ms_i > 0.0) {
        const double inv_projection_mass = -1.0 / (kMu0 * ms_i * mass + kTinyDevice);
        h_dmi_x[node] = residual_x[node] * inv_projection_mass;
        h_dmi_y[node] = residual_y[node] * inv_projection_mass;
        h_dmi_z[node] = residual_z[node] * inv_projection_mass;
    }
}

void fullmag_cuda_dmi_field_energy(
    const double *nodes_xyz,
    const uint32_t *elements,
    const uint8_t *magnetic_element_mask,
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *d_field,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *residual_x,
    double *residual_y,
    double *residual_z,
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_out,
    double uniform_ms,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count,
    int node_count,
    cudaStream_t stream)
{
    if (node_count <= 0) {
        return;
    }
    const size_t node_bytes = static_cast<size_t>(node_count) * sizeof(double);
    cudaMemsetAsync(residual_x, 0, node_bytes, stream);
    cudaMemsetAsync(residual_y, 0, node_bytes, stream);
    cudaMemsetAsync(residual_z, 0, node_bytes, stream);
    if (energy_out != nullptr) {
        cudaMemsetAsync(energy_out, 0, sizeof(double), stream);
    }

    if (element_count > 0) {
        const int element_blocks = (element_count + kBlockSize - 1) / kBlockSize;
        dmi_element_residual_kernel<<<element_blocks, kBlockSize, 0, stream>>>(
            nodes_xyz,
            elements,
            magnetic_element_mask,
            mx,
            my,
            mz,
            ms,
            d_field,
            residual_x,
            residual_y,
            residual_z,
            energy_out,
            uniform_d,
            nx,
            ny,
            nz,
            use_d_field,
            bulk_mode,
            element_count);
    }

    const int node_blocks = (node_count + kBlockSize - 1) / kBlockSize;
    dmi_project_field_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
        residual_x,
        residual_y,
        residual_z,
        ms,
        lumped_mass,
        magnetic_node_mask,
        h_dmi_x,
        h_dmi_y,
        h_dmi_z,
        uniform_ms,
        node_count);
}

} // namespace fullmag::fem
