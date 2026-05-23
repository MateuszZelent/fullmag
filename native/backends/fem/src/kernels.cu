// ── S11: Fused CUDA kernels for LLG integration ───────────────────────
// Provides GPU-resident kernels for:
//   - LLG RHS (cross-product + damping + block-max reduction)
//   - Vector normalization
//   - Effective field accumulation (h_eff = h_ex + h_demag + h_ext)
// All kernels operate on SoA (Structure-of-Arrays) layout:
// separate contiguous arrays for x, y, z components.

#include "kernels.h"

#include <cfloat>
#include <cub/cub.cuh>

namespace fullmag::fem {

__device__ double atomic_add_double(double *address, double value)
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

void fullmag_cuda_upload_aos_to_soa(
    const double *aos_xyz,
    double *x,
    double *y,
    double *z,
    int N,
    cudaStream_t stream)
{
    if (N <= 0) {
        return;
    }
    cudaMemcpy2DAsync(
        x,
        sizeof(double),
        aos_xyz + 0,
        3u * sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyHostToDevice,
        stream);
    cudaMemcpy2DAsync(
        y,
        sizeof(double),
        aos_xyz + 1,
        3u * sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyHostToDevice,
        stream);
    cudaMemcpy2DAsync(
        z,
        sizeof(double),
        aos_xyz + 2,
        3u * sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyHostToDevice,
        stream);
}

void fullmag_cuda_download_soa_to_aos(
    const double *x,
    const double *y,
    const double *z,
    double *aos_xyz,
    int N,
    cudaStream_t stream)
{
    if (N <= 0) {
        return;
    }
    cudaMemcpy2DAsync(
        aos_xyz + 0,
        3u * sizeof(double),
        x,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyDeviceToHost,
        stream);
    cudaMemcpy2DAsync(
        aos_xyz + 1,
        3u * sizeof(double),
        y,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyDeviceToHost,
        stream);
    cudaMemcpy2DAsync(
        aos_xyz + 2,
        3u * sizeof(double),
        z,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyDeviceToHost,
        stream);
}

// ── LLG RHS fused kernel ──────────────────────────────────────────────
// Computes dm/dt = -γ̄ (m×H + α m×(m×H)) per node.
// Also stores per-block max |dm/dt| for later device-side reduction.

__global__ void llg_rhs_fused_kernel(
    const double *__restrict__ mx, const double *__restrict__ my, const double *__restrict__ mz,
    const double *__restrict__ hx, const double *__restrict__ hy, const double *__restrict__ hz,
    double *__restrict__ dmx, double *__restrict__ dmy, double *__restrict__ dmz,
    double *__restrict__ block_max_rhs,
    const double *__restrict__ alpha_field,
    double gamma, double uniform_alpha,
    bool use_alpha_field,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;

    double local_norm = 0.0;

    if (i < N) {
        const double lmx = mx[i], lmy = my[i], lmz = mz[i];
        const double lhx = hx[i], lhy = hy[i], lhz = hz[i];
        const double alpha = use_alpha_field ? alpha_field[i] : uniform_alpha;
        const double gamma_bar = gamma / (1.0 + alpha * alpha);

        // p = m × H
        const double px = lmy * lhz - lmz * lhy;
        const double py = lmz * lhx - lmx * lhz;
        const double pz = lmx * lhy - lmy * lhx;

        // d = m × p = m × (m × H)
        const double dx = lmy * pz - lmz * py;
        const double dy = lmz * px - lmx * pz;
        const double dz = lmx * py - lmy * px;

        const double rx = -gamma_bar * (px + alpha * dx);
        const double ry = -gamma_bar * (py + alpha * dy);
        const double rz = -gamma_bar * (pz + alpha * dz);

        dmx[i] = rx;
        dmy[i] = ry;
        dmz[i] = rz;

        local_norm = sqrt(rx * rx + ry * ry + rz * rz);
    }

    // Block-level max reduction using CUB
    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    double block_max = BlockReduce(temp_storage).Reduce(local_norm, cub::Max());

    if (threadIdx.x == 0 && block_max_rhs != nullptr) {
        block_max_rhs[blockIdx.x] = block_max;
    }
}

__global__ void slonczewski_stt_rhs_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ dmx,
    double *__restrict__ dmy,
    double *__restrict__ dmz,
    double *__restrict__ block_max_rhs,
    double current_density_mag,
    double current_sign,
    double free_layer_thickness,
    double degree,
    double lambda,
    double epsilon_prime,
    double px,
    double py,
    double pz,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    constexpr double kHbar = 1.054571817e-34;
    constexpr double kElectronCharge = 1.60217662e-19;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double rhs_norm = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        if (current_density_mag > 0.0 && free_layer_thickness > 0.0 && ms_i > 0.0) {
            const double lmx = mx[i], lmy = my[i], lmz = mz[i];
            const double lambda_sq = lambda * lambda;
            const double m_dot_p = lmx * px + lmy * py + lmz * pz;
            const double denominator = (lambda_sq + 1.0) + (lambda_sq - 1.0) * m_dot_p;
            const double g = denominator != 0.0 ? (degree * lambda_sq) / denominator : 0.0;
            const double beta_stt =
                ((current_sign * current_density_mag * kHbar) /
                 (2.0 * kElectronCharge * kMu0 * ms_i * free_layer_thickness)) *
                g;

            const double mxp_x = lmy * pz - lmz * py;
            const double mxp_y = lmz * px - lmx * pz;
            const double mxp_z = lmx * py - lmy * px;
            const double mxmxp_x = lmy * mxp_z - lmz * mxp_y;
            const double mxmxp_y = lmz * mxp_x - lmx * mxp_z;
            const double mxmxp_z = lmx * mxp_y - lmy * mxp_x;

            dmx[i] += beta_stt * (mxmxp_x + epsilon_prime * mxp_x);
            dmy[i] += beta_stt * (mxmxp_y + epsilon_prime * mxp_y);
            dmz[i] += beta_stt * (mxmxp_z + epsilon_prime * mxp_z);
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

__device__ bool tetra_gradients_device(
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
    grads[2][0] = -(d2x * d3z - d2z * d3x) * inv_det;
    grads[3][0] =  (d2x * d3y - d2y * d3x) * inv_det;
    grads[1][1] = -(d1y * d3z - d1z * d3y) * inv_det;
    grads[2][1] =  (d1x * d3z - d1z * d3x) * inv_det;
    grads[3][1] = -(d1x * d3y - d1y * d3x) * inv_det;
    grads[1][2] =  (d1y * d2z - d1z * d2y) * inv_det;
    grads[2][2] = -(d1x * d2z - d1z * d2x) * inv_det;
    grads[3][2] =  (d1x * d2y - d1y * d2x) * inv_det;
    for (int dir = 0; dir < 3; ++dir) {
        grads[0][dir] = -(grads[1][dir] + grads[2][dir] + grads[3][dir]);
    }
    return true;
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
    double *__restrict__ work_x,
    double *__restrict__ work_y,
    double *__restrict__ work_z,
    double *__restrict__ node_weight,
    double current_x,
    double current_y,
    double current_z,
    double degree,
    double beta,
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
    if (!tetra_gradients_device(nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume)) {
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
        const double c_x = lmy * dm_z - lmz * dm_y;
        const double c_y = lmz * dm_x - lmx * dm_z;
        const double c_z = lmx * dm_y - lmy * dm_x;
        const double dc_x = lmy * c_z - lmz * c_y;
        const double dc_y = lmz * c_x - lmx * c_z;
        const double dc_z = lmx * c_y - lmy * c_x;
        atomic_add_double(&work_x[node], nodal_weight * (-dc_x - beta * c_x));
        atomic_add_double(&work_y[node], nodal_weight * (-dc_y - beta * c_y));
        atomic_add_double(&work_z[node], nodal_weight * (-dc_z - beta * c_z));
        atomic_add_double(&node_weight[node], nodal_weight);
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
    if (!tetra_gradients_device(nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume)) {
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
        atomic_add_double(&residual_x[node], residual[0]);
        atomic_add_double(&residual_y[node], residual[1]);
        atomic_add_double(&residual_z[node], residual[2]);
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
        atomic_add_double(energy_out, energy);
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

// ── Normalize unit vectors ────────────────────────────────────────────
__global__ void normalize_unit_vectors_kernel(
    double *__restrict__ mx, double *__restrict__ my, double *__restrict__ mz,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        const double x = mx[i], y = my[i], z = mz[i];
        const double norm = sqrt(x * x + y * y + z * z);
        if (norm > 0.0) {
            const double inv = 1.0 / norm;
            mx[i] = x * inv;
            my[i] = y * inv;
            mz[i] = z * inv;
        }
    }
}

// ── Effective field accumulation ──────────────────────────────────────
// h_eff = h_ex + h_demag + h_ext (component-wise, SOA layout)
__global__ void accumulate_heff_kernel(
    const double *__restrict__ h_ex,
    const double *__restrict__ h_demag,
    const double *__restrict__ h_ext,
    double *__restrict__ h_eff,
    int N,
    bool has_ext)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        double val = h_ex[i] + h_demag[i];
        if (has_ext) {
            val += h_ext[i];
        }
        h_eff[i] = val;
    }
}

__global__ void legacy_sparse_exchange_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ m_component,
    const double *__restrict__ ms,
    const double *__restrict__ inv_lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_component,
    int rows)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_component[row] = 0.0;
        return;
    }

    const double ms_i = ms[row];
    const double inv_mass = inv_lumped_mass[row];
    if (ms_i <= 0.0 || inv_mass <= 0.0) {
        h_component[row] = 0.0;
        return;
    }

    double km = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        km += csr_values[cursor] * m_component[csr_col_indices[cursor]];
    }
    h_component[row] = -(2.0 / (kMu0 * ms_i)) * km * inv_mass;
}

__global__ void legacy_sparse_exchange_energy_blocks_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ block_sums,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (row < rows) {
        double kmx = 0.0;
        double kmy = 0.0;
        double kmz = 0.0;
        const uint32_t begin = csr_row_offsets[row];
        const uint32_t end = csr_row_offsets[row + 1];
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            const uint32_t col = csr_col_indices[cursor];
            const double value = csr_values[cursor];
            kmx += value * mx[col];
            kmy += value * my[col];
            kmz += value * mz[col];
        }
        local = mx[row] * kmx + my[row] * kmy + mz[row] * kmz;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void demag_rhs_csr_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values_x,
    const double *__restrict__ csr_values_y,
    const double *__restrict__ csr_values_z,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ rhs,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }

    double value = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        const uint32_t col = csr_col_indices[cursor];
        value +=
            csr_values_x[cursor] * mx[col] +
            csr_values_y[cursor] * my[col] +
            csr_values_z[cursor] * mz[col];
    }
    rhs[row] = value;
}

__global__ void demag_recovery_csr_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ u,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_component,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_component[row] = 0.0;
        return;
    }

    double value = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        value += csr_values[cursor] * u[csr_col_indices[cursor]];
    }
    h_component[row] = value;
}

__global__ void zero_indexed_values_kernel(
    double *__restrict__ values,
    const uint32_t *__restrict__ indices,
    int count)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < count) {
        values[indices[i]] = 0.0;
    }
}

__global__ void demag_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ h_demag_x,
    const double *__restrict__ h_demag_y,
    const double *__restrict__ h_demag_z,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ block_sums,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double mdoth =
            mx[i] * h_demag_x[i] +
            my[i] * h_demag_y[i] +
            mz[i] * h_demag_z[i];
        local = -0.5 * kMu0 * ms[i] * mdoth * lumped_mass[i];
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void external_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ h_ext_x,
    const double *__restrict__ h_ext_y,
    const double *__restrict__ h_ext_z,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ block_sums,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double mdoth =
            mx[i] * h_ext_x[i] +
            my[i] * h_ext_y[i] +
            mz[i] * h_ext_z[i];
        local = -kMu0 * ms[i] * mdoth * lumped_mass[i];
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void uniaxial_anisotropy_field_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ ku,
    const double *__restrict__ ku2,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_ani_x,
    double *__restrict__ h_ani_y,
    double *__restrict__ h_ani_z,
    double *__restrict__ block_sums,
    double uniform_ku,
    double uniform_ku2,
    double axis_x,
    double axis_y,
    double axis_z,
    bool use_ku_field,
    bool use_ku2_field,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double ku_i = use_ku_field ? ku[i] : uniform_ku;
        const double ku2_i = use_ku2_field ? ku2[i] : uniform_ku2;
        const double m_dot_u = mx[i] * axis_x + my[i] * axis_y + mz[i] * axis_z;
        const double m_dot_u2 = m_dot_u * m_dot_u;
        double hx = 0.0;
        double hy = 0.0;
        double hz = 0.0;
        if (ms_i > 0.0) {
            const double prefactor = 2.0 * ku_i / (kMu0 * ms_i);
            const double prefactor2 = 4.0 * ku2_i / (kMu0 * ms_i);
            const double coeff = prefactor * m_dot_u + prefactor2 * m_dot_u * m_dot_u2;
            hx = coeff * axis_x;
            hy = coeff * axis_y;
            hz = coeff * axis_z;
        }
        h_ani_x[i] = hx;
        h_ani_y[i] = hy;
        h_ani_z[i] = hz;
        local = (-ku_i * m_dot_u2 - ku2_i * m_dot_u2 * m_dot_u2) * lumped_mass[i];
    } else if (i < N) {
        h_ani_x[i] = 0.0;
        h_ani_y[i] = 0.0;
        h_ani_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void cubic_anisotropy_field_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ kc1,
    const double *__restrict__ kc2,
    const double *__restrict__ kc3,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_cubic_x,
    double *__restrict__ h_cubic_y,
    double *__restrict__ h_cubic_z,
    double *__restrict__ block_sums,
    double uniform_kc1,
    double uniform_kc2,
    double uniform_kc3,
    double c1x,
    double c1y,
    double c1z,
    double c2x,
    double c2y,
    double c2z,
    bool use_kc1_field,
    bool use_kc2_field,
    bool use_kc3_field,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const double c3x = c1y * c2z - c1z * c2y;
    const double c3y = c1z * c2x - c1x * c2z;
    const double c3z = c1x * c2y - c1y * c2x;
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double kc1_i = use_kc1_field ? kc1[i] : uniform_kc1;
        const double kc2_i = use_kc2_field ? kc2[i] : uniform_kc2;
        const double kc3_i = use_kc3_field ? kc3[i] : uniform_kc3;
        const double m1 = mx[i] * c1x + my[i] * c1y + mz[i] * c1z;
        const double m2 = mx[i] * c2x + my[i] * c2y + mz[i] * c2z;
        const double m3 = mx[i] * c3x + my[i] * c3y + mz[i] * c3z;
        const double m1sq = m1 * m1;
        const double m2sq = m2 * m2;
        const double m3sq = m3 * m3;
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

        double hx = 0.0;
        double hy = 0.0;
        double hz = 0.0;
        if (ms_i > 0.0) {
            const double inv_mu0_ms = 1.0 / (kMu0 * ms_i);
            const double pf1 = -2.0 * kc1_i * inv_mu0_ms;
            const double pf2 = -2.0 * kc2_i * inv_mu0_ms;
            const double pf3 = -4.0 * kc3_i * inv_mu0_ms;
            double g1 = pf1 * m1 * (m2sq + m3sq);
            double g2 = pf1 * m2 * (m1sq + m3sq);
            double g3 = pf1 * m3 * (m1sq + m2sq);
            if (kc2_i != 0.0) {
                g1 += pf2 * m1 * m2sq * m3sq;
                g2 += pf2 * m1sq * m2 * m3sq;
                g3 += pf2 * m1sq * m2sq * m3;
            }
            if (kc3_i != 0.0) {
                g1 += pf3 * sigma * m1 * (m2sq + m3sq);
                g2 += pf3 * sigma * m2 * (m1sq + m3sq);
                g3 += pf3 * sigma * m3 * (m1sq + m2sq);
            }
            hx = g1 * c1x + g2 * c2x + g3 * c3x;
            hy = g1 * c1y + g2 * c2y + g3 * c3y;
            hz = g1 * c1z + g2 * c2z + g3 * c3z;
        }
        h_cubic_x[i] = hx;
        h_cubic_y[i] = hy;
        h_cubic_z[i] = hz;
        local =
            (kc1_i * sigma + kc2_i * m1sq * m2sq * m3sq + kc3_i * sigma * sigma) *
            lumped_mass[i];
    } else if (i < N) {
        h_cubic_x[i] = 0.0;
        h_cubic_y[i] = 0.0;
        h_cubic_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void magnetoelastic_field_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    const double *__restrict__ per_node_strain_voigt,
    double *__restrict__ h_mel_x,
    double *__restrict__ h_mel_y,
    double *__restrict__ h_mel_z,
    double *__restrict__ block_sums,
    double b1,
    double b2,
    double e11,
    double e22,
    double e33,
    double e23,
    double e13,
    double e12,
    bool use_per_node_strain,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double lmx = mx[i];
        const double lmy = my[i];
        const double lmz = mz[i];
        if (use_per_node_strain) {
            const double *eps = per_node_strain_voigt + static_cast<size_t>(i) * 6u;
            e11 = eps[0];
            e22 = eps[1];
            e33 = eps[2];
            e23 = eps[3] * 0.5;
            e13 = eps[4] * 0.5;
            e12 = eps[5] * 0.5;
        }
        double hx = 0.0;
        double hy = 0.0;
        double hz = 0.0;
        if (ms_i > 0.0) {
            const double inv_mu0_ms = -1.0 / (kMu0 * ms_i);
            hx = inv_mu0_ms * (2.0 * b1 * lmx * e11 + 2.0 * b2 * (lmy * e12 + lmz * e13));
            hy = inv_mu0_ms * (2.0 * b1 * lmy * e22 + 2.0 * b2 * (lmx * e12 + lmz * e23));
            hz = inv_mu0_ms * (2.0 * b1 * lmz * e33 + 2.0 * b2 * (lmx * e13 + lmy * e23));
        }
        h_mel_x[i] = hx;
        h_mel_y[i] = hy;
        h_mel_z[i] = hz;
        const double energy_density =
            b1 * (lmx * lmx * e11 + lmy * lmy * e22 + lmz * lmz * e33) +
            2.0 * b2 * (lmx * lmy * e12 + lmx * lmz * e13 + lmy * lmz * e23);
        local = energy_density * lumped_mass[i];
    } else if (i < N) {
        h_mel_x[i] = 0.0;
        h_mel_y[i] = 0.0;
        h_mel_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void add_field_inplace_kernel(
    const double *__restrict__ h_add,
    double *__restrict__ h_accum,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        h_accum[i] += h_add[i];
    }
}

__global__ void add_scaled_field_inplace_kernel(
    const double *__restrict__ h_add,
    double *__restrict__ h_accum,
    double scale,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        h_accum[i] += scale * h_add[i];
    }
}

__device__ uint64_t splitmix64_next(uint64_t x)
{
    x += 0x9e3779b97f4a7c15ull;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
    return x ^ (x >> 31);
}

__device__ double uniform_open01(uint64_t x)
{
    constexpr double kInv53 = 1.0 / 9007199254740992.0;
    const uint64_t mantissa = (splitmix64_next(x) >> 11) | 1ull;
    return static_cast<double>(mantissa) * kInv53;
}

__device__ double deterministic_normal(uint64_t seed, uint64_t node, uint64_t component, uint64_t step_index)
{
    constexpr double kTwoPi = 6.283185307179586476925286766559;
    const uint64_t base =
        seed ^
        (node * 0x9e3779b97f4a7c15ull) ^
        (component * 0xbf58476d1ce4e5b9ull) ^
        (step_index * 0x94d049bb133111ebull);
    const double u1 = uniform_open01(base);
    const double u2 = uniform_open01(base ^ 0xd2b74407b1ce6e93ull);
    return sqrt(-2.0 * log(u1)) * cos(kTwoPi * u2);
}

__global__ void thermal_field_blocks_kernel(
    const double *__restrict__ ms,
    const double *__restrict__ alpha,
    const double *__restrict__ node_volumes,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_therm_x,
    double *__restrict__ h_therm_y,
    double *__restrict__ h_therm_z,
    double *__restrict__ block_max_sigma,
    double gamma_red,
    double uniform_alpha,
    double temperature,
    double dt_seconds,
    uint64_t seed,
    uint64_t step_index,
    bool use_alpha_field,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    constexpr double kBoltzmann = 1.380649e-23;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double sigma = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double alpha_i = use_alpha_field ? alpha[i] : uniform_alpha;
        const double volume_i = node_volumes[i];
        if (temperature > 0.0 && dt_seconds > 0.0 && gamma_red > 0.0 &&
            ms_i > 0.0 && alpha_i > 0.0 && volume_i > 0.0 && seed != 0ull) {
            const double gamma0_i = gamma_red * (1.0 + alpha_i * alpha_i);
            sigma = sqrt(
                2.0 * alpha_i * kBoltzmann * temperature /
                (gamma0_i * kMu0 * ms_i * volume_i * dt_seconds));
            const uint64_t node = static_cast<uint64_t>(i);
            h_therm_x[i] = deterministic_normal(seed, node, 0ull, step_index) * sigma;
            h_therm_y[i] = deterministic_normal(seed, node, 1ull, step_index) * sigma;
            h_therm_z[i] = deterministic_normal(seed, node, 2ull, step_index) * sigma;
        } else {
            h_therm_x[i] = 0.0;
            h_therm_y[i] = 0.0;
            h_therm_z[i] = 0.0;
        }
    } else if (i < N) {
        h_therm_x[i] = 0.0;
        h_therm_y[i] = 0.0;
        h_therm_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_max = BlockReduce(temp_storage).Reduce(sigma, cub::Max());
    if (threadIdx.x == 0 && block_max_sigma != nullptr) {
        block_max_sigma[blockIdx.x] = block_max;
    }
}

__global__ void field_metric_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ hx,
    const double *__restrict__ hy,
    const double *__restrict__ hz,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ block_max_h,
    double *__restrict__ block_max_torque,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double h_norm = 0.0;
    double torque_norm = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double lhx = hx[i], lhy = hy[i], lhz = hz[i];
        h_norm = sqrt(lhx * lhx + lhy * lhy + lhz * lhz);

        const double lmx = mx[i], lmy = my[i], lmz = mz[i];
        const double tx = lmy * lhz - lmz * lhy;
        const double ty = lmz * lhx - lmx * lhz;
        const double tz = lmx * lhy - lmy * lhx;
        torque_norm = sqrt(tx * tx + ty * ty + tz * tz);
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage h_temp_storage;
    const double h_block = BlockReduce(h_temp_storage).Reduce(h_norm, cub::Max());
    __syncthreads();
    __shared__ typename BlockReduce::TempStorage torque_temp_storage;
    const double torque_block =
        BlockReduce(torque_temp_storage).Reduce(torque_norm, cub::Max());
    if (threadIdx.x == 0) {
        block_max_h[blockIdx.x] = h_block;
        block_max_torque[blockIdx.x] = torque_block;
    }
}

__global__ void magnetization_sum_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ block_sum_x,
    double *__restrict__ block_sum_y,
    double *__restrict__ block_sum_z,
    double *__restrict__ block_count,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_x = 0.0;
    double local_y = 0.0;
    double local_z = 0.0;
    double local_count = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        local_x = mx[i];
        local_y = my[i];
        local_z = mz[i];
        const bool nonzero =
            fabs(local_x) > 1e-18 || fabs(local_y) > 1e-18 || fabs(local_z) > 1e-18;
        local_count = nonzero ? 1.0 : 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage x_temp_storage;
    __shared__ typename BlockReduce::TempStorage y_temp_storage;
    __shared__ typename BlockReduce::TempStorage z_temp_storage;
    __shared__ typename BlockReduce::TempStorage count_temp_storage;
    const double x_sum = BlockReduce(x_temp_storage).Sum(local_x);
    const double y_sum = BlockReduce(y_temp_storage).Sum(local_y);
    const double z_sum = BlockReduce(z_temp_storage).Sum(local_z);
    const double count_sum = BlockReduce(count_temp_storage).Sum(local_count);
    if (threadIdx.x == 0) {
        block_sum_x[blockIdx.x] = x_sum;
        block_sum_y[blockIdx.x] = y_sum;
        block_sum_z[blockIdx.x] = z_sum;
        block_count[blockIdx.x] = count_sum;
    }
}

__global__ void adaptive_error_norm_blocks_kernel(
    const double *__restrict__ old_mx, const double *__restrict__ old_my, const double *__restrict__ old_mz,
    const double *__restrict__ new_mx, const double *__restrict__ new_my, const double *__restrict__ new_mz,
    const double *__restrict__ k0x, const double *__restrict__ k0y, const double *__restrict__ k0z,
    const double *__restrict__ k1x, const double *__restrict__ k1y, const double *__restrict__ k1z,
    const double *__restrict__ k2x, const double *__restrict__ k2y, const double *__restrict__ k2z,
    const double *__restrict__ k3x, const double *__restrict__ k3y, const double *__restrict__ k3z,
    const double *__restrict__ k4x, const double *__restrict__ k4y, const double *__restrict__ k4z,
    const double *__restrict__ k5x, const double *__restrict__ k5y, const double *__restrict__ k5z,
    const double *__restrict__ k6x, const double *__restrict__ k6y, const double *__restrict__ k6z,
    double b_hi0, double b_hi1, double b_hi2, double b_hi3,
    double b_hi4, double b_hi5, double b_hi6,
    double b_lo0, double b_lo1, double b_lo2, double b_lo3,
    double b_lo4, double b_lo5, double b_lo6,
    double dt, double adaptive_atol, double adaptive_rtol,
    double *__restrict__ block_max_scaled_error,
    int stages,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_max = 0.0;
    if (i < N) {
        const double c0 = stages > 0 ? b_hi0 - b_lo0 : 0.0;
        const double c1 = stages > 1 ? b_hi1 - b_lo1 : 0.0;
        const double c2 = stages > 2 ? b_hi2 - b_lo2 : 0.0;
        const double c3 = stages > 3 ? b_hi3 - b_lo3 : 0.0;
        const double c4 = stages > 4 ? b_hi4 - b_lo4 : 0.0;
        const double c5 = stages > 5 ? b_hi5 - b_lo5 : 0.0;
        const double c6 = stages > 6 ? b_hi6 - b_lo6 : 0.0;

        double err_x = c0 * k0x[i];
        double err_y = c0 * k0y[i];
        double err_z = c0 * k0z[i];
        if (stages > 1) {
            err_x += c1 * k1x[i];
            err_y += c1 * k1y[i];
            err_z += c1 * k1z[i];
        }
        if (stages > 2) {
            err_x += c2 * k2x[i];
            err_y += c2 * k2y[i];
            err_z += c2 * k2z[i];
        }
        if (stages > 3) {
            err_x += c3 * k3x[i];
            err_y += c3 * k3y[i];
            err_z += c3 * k3z[i];
        }
        if (stages > 4) {
            err_x += c4 * k4x[i];
            err_y += c4 * k4y[i];
            err_z += c4 * k4z[i];
        }
        if (stages > 5) {
            err_x += c5 * k5x[i];
            err_y += c5 * k5y[i];
            err_z += c5 * k5z[i];
        }
        if (stages > 6) {
            err_x += c6 * k6x[i];
            err_y += c6 * k6y[i];
            err_z += c6 * k6z[i];
        }
        err_x *= dt;
        err_y *= dt;
        err_z *= dt;

        const double scale_x = adaptive_atol + adaptive_rtol * fmax(fabs(old_mx[i]), fabs(new_mx[i]));
        const double scale_y = adaptive_atol + adaptive_rtol * fmax(fabs(old_my[i]), fabs(new_my[i]));
        const double scale_z = adaptive_atol + adaptive_rtol * fmax(fabs(old_mz[i]), fabs(new_mz[i]));
        const double scaled_x = scale_x > 0.0 ? fabs(err_x) / scale_x : 0.0;
        const double scaled_y = scale_y > 0.0 ? fabs(err_y) / scale_y : 0.0;
        const double scaled_z = scale_z > 0.0 ? fabs(err_z) / scale_z : 0.0;
        local_max = fmax(scaled_x, fmax(scaled_y, scaled_z));
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_max = BlockReduce(temp_storage).Reduce(local_max, cub::Max());
    if (threadIdx.x == 0) {
        block_max_scaled_error[blockIdx.x] = block_max;
    }
}

// ── C interface implementations ───────────────────────────────────────

static constexpr int kBlockSize = 256;

void fullmag_cuda_llg_rhs_fused(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    double *dmx, double *dmy, double *dmz,
    double *block_max_rhs,
    const double *alpha_field,
    double gamma, double alpha,
    bool use_alpha_field,
    int N, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    llg_rhs_fused_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, hx, hy, hz, dmx, dmy, dmz,
        block_max_rhs, alpha_field, gamma, alpha, use_alpha_field, N);
}

void fullmag_cuda_add_slonczewski_stt_rhs(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const uint8_t *magnetic_node_mask,
    double *dmx,
    double *dmy,
    double *dmz,
    double *block_max_rhs,
    double current_density_mag,
    double current_sign,
    double free_layer_thickness,
    double degree,
    double lambda,
    double epsilon_prime,
    double px,
    double py,
    double pz,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    slonczewski_stt_rhs_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        magnetic_node_mask,
        dmx,
        dmy,
        dmz,
        block_max_rhs,
        current_density_mag,
        current_sign,
        free_layer_thickness,
        degree,
        lambda,
        epsilon_prime,
        px,
        py,
        pz,
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
        work_x,
        work_y,
        work_z,
        node_weight,
        current_x,
        current_y,
        current_z,
        degree,
        beta,
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

void fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    int N, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    normalize_unit_vectors_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, N);
}

void fullmag_cuda_accumulate_heff(
    const double *h_ex, const double *h_demag, const double *h_ext,
    double *h_eff,
    int N, bool has_ext, cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    accumulate_heff_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_ex, h_demag, h_ext, h_eff, N, has_ext);
}

void fullmag_cuda_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *m_component,
    const double *ms,
    const double *inv_lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    legacy_sparse_exchange_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        m_component,
        ms,
        inv_lumped_mass,
        magnetic_node_mask,
        h_component,
        rows);
}

void fullmag_cuda_legacy_sparse_exchange_energy_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *mx,
    const double *my,
    const double *mz,
    double *block_sums,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    legacy_sparse_exchange_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        mx,
        my,
        mz,
        block_sums,
        rows);
}

void fullmag_cuda_demag_rhs_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values_x,
    const double *csr_values_y,
    const double *csr_values_z,
    const double *mx,
    const double *my,
    const double *mz,
    double *rhs,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_rhs_csr_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values_x,
        csr_values_y,
        csr_values_z,
        mx,
        my,
        mz,
        rhs,
        rows);
}

void fullmag_cuda_demag_recovery_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *u,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_recovery_csr_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        u,
        magnetic_node_mask,
        h_component,
        rows);
}

void fullmag_cuda_zero_indexed_values(
    double *values,
    const uint32_t *indices,
    int count,
    cudaStream_t stream)
{
    if (count <= 0) {
        return;
    }
    const int num_blocks = (count + kBlockSize - 1) / kBlockSize;
    zero_indexed_values_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        values,
        indices,
        count);
}

void fullmag_cuda_demag_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *h_demag_x,
    const double *h_demag_y,
    const double *h_demag_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_sums,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    demag_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        h_demag_x,
        h_demag_y,
        h_demag_z,
        ms,
        lumped_mass,
        magnetic_node_mask,
        block_sums,
        N);
}

void fullmag_cuda_external_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *h_ext_x,
    const double *h_ext_y,
    const double *h_ext_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_sums,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    external_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        h_ext_x,
        h_ext_y,
        h_ext_z,
        ms,
        lumped_mass,
        magnetic_node_mask,
        block_sums,
        N);
}

void fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *ku,
    const double *ku2,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_ani_x,
    double *h_ani_y,
    double *h_ani_z,
    double *block_sums,
    double uniform_ku,
    double uniform_ku2,
    double axis_x,
    double axis_y,
    double axis_z,
    bool use_ku_field,
    bool use_ku2_field,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    uniaxial_anisotropy_field_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        ku,
        ku2,
        lumped_mass,
        magnetic_node_mask,
        h_ani_x,
        h_ani_y,
        h_ani_z,
        block_sums,
        uniform_ku,
        uniform_ku2,
        axis_x,
        axis_y,
        axis_z,
        use_ku_field,
        use_ku2_field,
        N);
}

void fullmag_cuda_cubic_anisotropy_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *kc1,
    const double *kc2,
    const double *kc3,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_cubic_x,
    double *h_cubic_y,
    double *h_cubic_z,
    double *block_sums,
    double uniform_kc1,
    double uniform_kc2,
    double uniform_kc3,
    double c1x,
    double c1y,
    double c1z,
    double c2x,
    double c2y,
    double c2z,
    bool use_kc1_field,
    bool use_kc2_field,
    bool use_kc3_field,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    cubic_anisotropy_field_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        kc1,
        kc2,
        kc3,
        lumped_mass,
        magnetic_node_mask,
        h_cubic_x,
        h_cubic_y,
        h_cubic_z,
        block_sums,
        uniform_kc1,
        uniform_kc2,
        uniform_kc3,
        c1x,
        c1y,
        c1z,
        c2x,
        c2y,
        c2z,
        use_kc1_field,
        use_kc2_field,
        use_kc3_field,
        N);
}

void fullmag_cuda_magnetoelastic_field_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    const double *per_node_strain_voigt,
    double *h_mel_x,
    double *h_mel_y,
    double *h_mel_z,
    double *block_sums,
    double b1,
    double b2,
    double e11,
    double e22,
    double e33,
    double e23,
    double e13,
    double e12,
    bool use_per_node_strain,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    magnetoelastic_field_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        ms,
        lumped_mass,
        magnetic_node_mask,
        per_node_strain_voigt,
        h_mel_x,
        h_mel_y,
        h_mel_z,
        block_sums,
        b1,
        b2,
        e11,
        e22,
        e33,
        e23,
        e13,
        e12,
        use_per_node_strain,
        N);
}

void fullmag_cuda_add_field_inplace(
    const double *h_add,
    double *h_accum,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    add_field_inplace_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_add,
        h_accum,
        N);
}

void fullmag_cuda_add_scaled_field_inplace(
    const double *h_add,
    double *h_accum,
    double scale,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    add_scaled_field_inplace_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        h_add,
        h_accum,
        scale,
        N);
}

void fullmag_cuda_thermal_field_blocks(
    const double *ms,
    const double *alpha,
    const double *node_volumes,
    const uint8_t *magnetic_node_mask,
    double *h_therm_x,
    double *h_therm_y,
    double *h_therm_z,
    double *block_max_sigma,
    double gamma_red,
    double uniform_alpha,
    double temperature,
    double dt_seconds,
    uint64_t seed,
    uint64_t step_index,
    bool use_alpha_field,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    thermal_field_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        ms,
        alpha,
        node_volumes,
        magnetic_node_mask,
        h_therm_x,
        h_therm_y,
        h_therm_z,
        block_max_sigma,
        gamma_red,
        uniform_alpha,
        temperature,
        dt_seconds,
        seed,
        step_index,
        use_alpha_field,
        N);
}

void fullmag_cuda_field_metric_blocks(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    const uint8_t *magnetic_node_mask,
    double *block_max_h,
    double *block_max_torque,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    field_metric_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        hx,
        hy,
        hz,
        magnetic_node_mask,
        block_max_h,
        block_max_torque,
        N);
}

void fullmag_cuda_magnetization_sum_blocks(
    const double *mx, const double *my, const double *mz,
    const uint8_t *magnetic_node_mask,
    double *block_sum_x,
    double *block_sum_y,
    double *block_sum_z,
    double *block_count,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    magnetization_sum_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        magnetic_node_mask,
        block_sum_x,
        block_sum_y,
        block_sum_z,
        block_count,
        N);
}

void fullmag_cuda_adaptive_error_norm_blocks(
    const double *old_mx, const double *old_my, const double *old_mz,
    const double *new_mx, const double *new_my, const double *new_mz,
    const double *k0x, const double *k0y, const double *k0z,
    const double *k1x, const double *k1y, const double *k1z,
    const double *k2x, const double *k2y, const double *k2z,
    const double *k3x, const double *k3y, const double *k3z,
    const double *k4x, const double *k4y, const double *k4z,
    const double *k5x, const double *k5y, const double *k5z,
    const double *k6x, const double *k6y, const double *k6z,
    double b_hi0, double b_hi1, double b_hi2, double b_hi3,
    double b_hi4, double b_hi5, double b_hi6,
    double b_lo0, double b_lo1, double b_lo2, double b_lo3,
    double b_lo4, double b_lo5, double b_lo6,
    double dt, double adaptive_atol, double adaptive_rtol,
    double *block_max_scaled_error,
    int stages,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    adaptive_error_norm_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        old_mx, old_my, old_mz,
        new_mx, new_my, new_mz,
        k0x, k0y, k0z,
        k1x, k1y, k1z,
        k2x, k2y, k2z,
        k3x, k3y, k3z,
        k4x, k4y, k4z,
        k5x, k5y, k5z,
        k6x, k6y, k6z,
        b_hi0, b_hi1, b_hi2, b_hi3, b_hi4, b_hi5, b_hi6,
        b_lo0, b_lo1, b_lo2, b_lo3, b_lo4, b_lo5, b_lo6,
        dt, adaptive_atol, adaptive_rtol,
        block_max_scaled_error,
        stages,
        N);
}

void fullmag_cuda_device_max(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream)
{
    if (temp_storage == nullptr) {
        cub::DeviceReduce::Max(nullptr, temp_storage_bytes, data, result, N, stream);
        return;
    }
    cub::DeviceReduce::Max(temp_storage, temp_storage_bytes, data, result, N, stream);
}

void fullmag_cuda_device_sum(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream)
{
    if (temp_storage == nullptr) {
        cub::DeviceReduce::Sum(nullptr, temp_storage_bytes, data, result, N, stream);
        return;
    }
    cub::DeviceReduce::Sum(temp_storage, temp_storage_bytes, data, result, N, stream);
}

} // namespace fullmag::fem
