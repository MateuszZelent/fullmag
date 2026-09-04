// ── GPU CUDA DMI kernels source contract ──────────────────────────────
// This source owns interfacial and bulk DMI weak-residual CUDA wrappers. It
// does not own RK orchestration, Context construction, material upload, exchange,
// demag, STT, thermal, magnetoelastic, or C ABI entrypoints.

#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_geometry_cache.hpp"
#include "gpu/cuda/interactions/dmi/dmi_tetra_math.cuh"

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
    double *__restrict__ energy_partials,
    DmiDiagnostics *__restrict__ diagnostics,
    DmiApplyRequest request,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count,
    int node_count)
{
    __shared__ double block_energy[kBlockSize];
    double thread_energy = 0.0;

    for (int e = blockIdx.x * blockDim.x + threadIdx.x;
         e < element_count;
         e += blockDim.x * gridDim.x) {
        if (magnetic_element_mask != nullptr && magnetic_element_mask[e] == 0u) {
            continue;
        }
        const size_t ebase = static_cast<size_t>(e) * 4u;
        const uint32_t nodes[4] = {
            elements[ebase + 0u],
            elements[ebase + 1u],
            elements[ebase + 2u],
            elements[ebase + 3u],
        };
        bool valid_nodes = true;
        for (int local = 0; local < 4; ++local) {
            valid_nodes = valid_nodes && nodes[local] < static_cast<uint32_t>(node_count);
        }
        if (!valid_nodes) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->degenerate_tet_count),
                1ull);
            continue;
        }

        double grads[4][3];
        double volume = 0.0;
        bool nonfinite_geometry = false;
        if (!dmi_tetra_gradients_device(
                nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume,
                nullptr, nullptr, &nonfinite_geometry)) {
            uint64_t *counter = nonfinite_geometry
                ? &diagnostics->nonfinite_count
                : &diagnostics->degenerate_tet_count;
            atomicAdd(reinterpret_cast<unsigned long long *>(counter), 1ull);
            continue;
        }
        double elem_d = uniform_d;
        if (use_d_field && d_field != nullptr) {
            elem_d = 0.0;
            for (int local = 0; local < 4; ++local) {
                elem_d += d_field[nodes[local]];
            }
            elem_d *= 0.25;
        }
        if (!isfinite(elem_d)) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
        }
        if (elem_d == 0.0) {
            continue;
        }

        double grad_m[3][3] = {};
        double m_q[3] = {};
        bool finite_input = true;
        for (int local = 0; local < 4; ++local) {
            const uint32_t node = nodes[local];
            const double m[3] = {mx[node], my[node], mz[node]};
            for (int comp = 0; comp < 3; ++comp) {
                finite_input = finite_input && isfinite(m[comp]);
                m_q[comp] += 0.25 * m[comp];
                grad_m[comp][0] += m[comp] * grads[local][0];
                grad_m[comp][1] += m[comp] * grads[local][1];
                grad_m[comp][2] += m[comp] * grads[local][2];
            }
        }
        if (!finite_input) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
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

        double element_residual[4][3] = {};
        bool finite_result = true;
        if (request.field) {
            for (int local = 0; local < 4; ++local) {
                const double shape = 0.25;
                const double *grad_shape = grads[local];
                if (bulk_mode) {
                    element_residual[local][0] = elem_d * weight *
                        (shape * curl_m[0] + m_q[1] * grad_shape[2] - m_q[2] * grad_shape[1]);
                    element_residual[local][1] = elem_d * weight *
                        (shape * curl_m[1] - m_q[0] * grad_shape[2] + m_q[2] * grad_shape[0]);
                    element_residual[local][2] = elem_d * weight *
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
                        element_residual[local][comp] = weight * (shape * dw_dm + grad_action);
                    }
                }
                finite_result = finite_result &&
                    isfinite(element_residual[local][0]) &&
                    isfinite(element_residual[local][1]) &&
                    isfinite(element_residual[local][2]);
            }
        }

        double energy = 0.0;
        if (request.energy) {
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
            finite_result = finite_result && isfinite(energy);
        }
        if (!finite_result) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
        }

        if (request.field) {
            for (int local = 0; local < 4; ++local) {
                const uint32_t node = nodes[local];
                dmi_atomic_add_double(&residual_x[node], element_residual[local][0]);
                dmi_atomic_add_double(&residual_y[node], element_residual[local][1]);
                dmi_atomic_add_double(&residual_z[node], element_residual[local][2]);
            }
        }
        if (request.energy) {
            thread_energy += energy;
        }
    }

    if (request.energy) {
        block_energy[threadIdx.x] = thread_energy;
        __syncthreads();
        for (int offset = blockDim.x / 2; offset > 0; offset /= 2) {
            if (threadIdx.x < offset) {
                block_energy[threadIdx.x] += block_energy[threadIdx.x + offset];
            }
            __syncthreads();
        }
        if (threadIdx.x == 0) {
            energy_partials[blockIdx.x] = block_energy[0];
        }
}
}

__global__ void dmi_cached_element_residual_kernel(
    const double *__restrict__ cache_grads,
    const double *__restrict__ cache_volume,
    const uint8_t *__restrict__ cache_valid_mask,
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
    double *__restrict__ energy_partials,
    DmiDiagnostics *__restrict__ diagnostics,
    DmiApplyRequest request,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count,
    int node_count)
{
    __shared__ double block_energy[kBlockSize];
    double thread_energy = 0.0;

    for (int e = blockIdx.x * blockDim.x + threadIdx.x;
         e < element_count;
         e += blockDim.x * gridDim.x) {
        if (magnetic_element_mask != nullptr && magnetic_element_mask[e] == 0u) {
            continue;
        }
        if (cache_valid_mask != nullptr && cache_valid_mask[e] == 0u) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->degenerate_tet_count),
                1ull);
            continue;
        }
        const size_t ebase = static_cast<size_t>(e) * 4u;
        const uint32_t nodes[4] = {
            elements[ebase + 0u],
            elements[ebase + 1u],
            elements[ebase + 2u],
            elements[ebase + 3u],
        };

        const double volume = cache_volume[e];
        double grads[4][3];
        for (int local = 0; local < 4; ++local) {
            for (int dir = 0; dir < 3; ++dir) {
                grads[local][dir] = cache_grads[static_cast<size_t>(e) * 12u + static_cast<size_t>(local * 3 + dir)];
            }
        }

        double elem_d = uniform_d;
        if (use_d_field && d_field != nullptr) {
            elem_d = 0.0;
            for (int local = 0; local < 4; ++local) {
                elem_d += d_field[nodes[local]];
            }
            elem_d *= 0.25;
        }
        if (!isfinite(elem_d)) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
        }
        if (elem_d == 0.0) {
            continue;
        }

        double grad_m[3][3] = {};
        double m_q[3] = {};
        bool finite_input = true;
        for (int local = 0; local < 4; ++local) {
            const uint32_t node = nodes[local];
            const double m[3] = {mx[node], my[node], mz[node]};
            for (int comp = 0; comp < 3; ++comp) {
                finite_input = finite_input && isfinite(m[comp]);
                m_q[comp] += 0.25 * m[comp];
                grad_m[comp][0] += m[comp] * grads[local][0];
                grad_m[comp][1] += m[comp] * grads[local][1];
                grad_m[comp][2] += m[comp] * grads[local][2];
            }
        }
        if (!finite_input) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
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

        double element_residual[4][3] = {};
        bool finite_result = true;
        if (request.field) {
            for (int local = 0; local < 4; ++local) {
                const double shape = 0.25;
                const double *grad_shape = grads[local];
                if (bulk_mode) {
                    element_residual[local][0] = elem_d * weight *
                        (shape * curl_m[0] + m_q[1] * grad_shape[2] - m_q[2] * grad_shape[1]);
                    element_residual[local][1] = elem_d * weight *
                        (shape * curl_m[1] - m_q[0] * grad_shape[2] + m_q[2] * grad_shape[0]);
                    element_residual[local][2] = elem_d * weight *
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
                        element_residual[local][comp] = weight * (shape * dw_dm + grad_action);
                    }
                }
                finite_result = finite_result &&
                    isfinite(element_residual[local][0]) &&
                    isfinite(element_residual[local][1]) &&
                    isfinite(element_residual[local][2]);
            }
        }

        double energy = 0.0;
        if (request.energy) {
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
            finite_result = finite_result && isfinite(energy);
        }
        if (!finite_result) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
        }

        if (request.field) {
            for (int local = 0; local < 4; ++local) {
                const uint32_t node = nodes[local];
                dmi_atomic_add_double(&residual_x[node], element_residual[local][0]);
                dmi_atomic_add_double(&residual_y[node], element_residual[local][1]);
                dmi_atomic_add_double(&residual_z[node], element_residual[local][2]);
            }
        }
        if (request.energy) {
            thread_energy += energy;
        }
    }

    if (request.energy) {
        block_energy[threadIdx.x] = thread_energy;
        __syncthreads();
        for (int offset = blockDim.x / 2; offset > 0; offset /= 2) {
            if (threadIdx.x < offset) {
                block_energy[threadIdx.x] += block_energy[threadIdx.x + offset];
            }
            __syncthreads();
        }
        if (threadIdx.x == 0 && energy_partials != nullptr) {
            energy_partials[blockIdx.x] = block_energy[0];
        }
    }
}

__global__ void dmi_cached_element_residual_colored_kernel(
    const double *__restrict__ cache_grads,
    const double *__restrict__ cache_volume,
    const std::uint8_t *__restrict__ cache_valid_mask,
    const std::uint32_t *__restrict__ elements,
    const std::uint32_t *__restrict__ colored_elements,
    int color_offset,
    int color_count,
    const std::uint8_t *__restrict__ magnetic_element_mask,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ ms,
    const double *__restrict__ d_field,
    double *__restrict__ residual_x,
    double *__restrict__ residual_y,
    double *__restrict__ residual_z,
    double *__restrict__ energy_partials,
    DmiDiagnostics *__restrict__ diagnostics,
    DmiApplyRequest request,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int total_element_count,
    int node_count)
{
    (void)energy_partials;

    for (int idx = blockIdx.x * blockDim.x + threadIdx.x;
         idx < color_count;
         idx += blockDim.x * gridDim.x) {
        const int e = static_cast<int>(colored_elements[color_offset + idx]);
        if (magnetic_element_mask != nullptr && magnetic_element_mask[e] == 0u) {
            continue;
        }
        if (cache_valid_mask != nullptr && cache_valid_mask[e] == 0u) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->degenerate_tet_count),
                1ull);
            continue;
        }
        const size_t ebase = static_cast<size_t>(e) * 4u;
        const uint32_t nodes[4] = {
            elements[ebase + 0u],
            elements[ebase + 1u],
            elements[ebase + 2u],
            elements[ebase + 3u],
        };

        const double volume = cache_volume[e];
        double grads[4][3];
        for (int local = 0; local < 4; ++local) {
            for (int dir = 0; dir < 3; ++dir) {
                grads[local][dir] = cache_grads[static_cast<size_t>(e) * 12u + static_cast<size_t>(local * 3 + dir)];
            }
        }

        double elem_d = uniform_d;
        if (use_d_field && d_field != nullptr) {
            elem_d = 0.0;
            for (int local = 0; local < 4; ++local) {
                elem_d += d_field[nodes[local]];
            }
            elem_d *= 0.25;
        }
        if (!isfinite(elem_d)) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
        }
        if (elem_d == 0.0) {
            continue;
        }

        double grad_m[3][3] = {};
        double m_q[3] = {};
        bool finite_input = true;
        for (int local = 0; local < 4; ++local) {
            const uint32_t node = nodes[local];
            const double m[3] = {mx[node], my[node], mz[node]};
            for (int comp = 0; comp < 3; ++comp) {
                finite_input = finite_input && isfinite(m[comp]);
                m_q[comp] += 0.25 * m[comp];
                grad_m[comp][0] += m[comp] * grads[local][0];
                grad_m[comp][1] += m[comp] * grads[local][1];
                grad_m[comp][2] += m[comp] * grads[local][2];
            }
        }
        if (!finite_input) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
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

        double element_residual[4][3] = {};
        bool finite_result = true;
        if (request.field) {
            for (int local = 0; local < 4; ++local) {
                const double shape = 0.25;
                const double *grad_shape = grads[local];
                if (bulk_mode) {
                    element_residual[local][0] = elem_d * weight *
                        (shape * curl_m[0] + m_q[1] * grad_shape[2] - m_q[2] * grad_shape[1]);
                    element_residual[local][1] = elem_d * weight *
                        (shape * curl_m[1] - m_q[0] * grad_shape[2] + m_q[2] * grad_shape[0]);
                    element_residual[local][2] = elem_d * weight *
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
                        element_residual[local][comp] = weight * (shape * dw_dm + grad_action);
                    }
                }
                finite_result = finite_result &&
                    isfinite(element_residual[local][0]) &&
                    isfinite(element_residual[local][1]) &&
                    isfinite(element_residual[local][2]);
            }
        }

        if (!finite_result) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
            continue;
        }

        if (request.field) {
            for (int local = 0; local < 4; ++local) {
                const uint32_t node = nodes[local];
                dmi_atomic_add_double(&residual_x[node], element_residual[local][0]);
                dmi_atomic_add_double(&residual_y[node], element_residual[local][1]);
                dmi_atomic_add_double(&residual_z[node], element_residual[local][2]);
            }
        }
    }
}

__global__ void dmi_pairwise_sum_in_place(
    const double *__restrict__ input,
    double *__restrict__ output,
    int input_count)
{
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    const int output_count = (input_count + 1) / 2;
    if (index >= output_count) {
        return;
    }
    const int left = 2 * index;
    const int right = left + 1;
    output[index] = input[left] + (right < input_count ? input[right] : 0.0);
}

__global__ void dmi_energy_difference_kernel(
    const double *nodes_xyz, const uint32_t *elements, const uint8_t *magnetic_mask,
    const double *m0x, const double *m0y, const double *m0z,
    const double *m1x, const double *m1y, const double *m1z,
    const double *d_field, double *delta_out, double *absolute_out,
    double uniform_d,
    double nx, double ny, double nz, bool use_d_field, bool bulk_mode, int element_count)
{
    const int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= element_count) return;
    if (magnetic_mask != nullptr && magnetic_mask[e] == 0u) return;
    const size_t base = static_cast<size_t>(e) * 4u;
    const uint32_t nodes[4] = {elements[base], elements[base + 1u], elements[base + 2u], elements[base + 3u]};
    double grads[4][3], gradient_scales[4][3];
    double volume = 0.0, geometry_condition_scale = 1.0;
    if (!dmi_tetra_gradients_device(
            nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume,
            &geometry_condition_scale, gradient_scales)) return;
    double d = uniform_d;
    double abs_d = fabs(uniform_d);
    if (use_d_field && d_field != nullptr) {
        d = 0.25 * (d_field[nodes[0]] + d_field[nodes[1]] + d_field[nodes[2]] + d_field[nodes[3]]);
        abs_d = 0.25 * (fabs(d_field[nodes[0]]) + fabs(d_field[nodes[1]]) + fabs(d_field[nodes[2]]) + fabs(d_field[nodes[3]]));
    }
    double s[3] = {}, q[3] = {}, gs[3][3] = {}, gq[3][3] = {};
    double abs_s[3] = {}, abs_q[3] = {}, abs_gs[3][3] = {}, abs_gq[3][3] = {};
    for (int local = 0; local < 4; ++local) {
        const uint32_t node = nodes[local];
        const double a[3] = {m1x[node] + m0x[node], m1y[node] + m0y[node], m1z[node] + m0z[node]};
        const double b[3] = {m1x[node] - m0x[node], m1y[node] - m0y[node], m1z[node] - m0z[node]};
        for (int c = 0; c < 3; ++c) for (int dir = 0; dir < 3; ++dir) {
            gs[c][dir] += a[c] * grads[local][dir];
            gq[c][dir] += b[c] * grads[local][dir];
            abs_gs[c][dir] += fabs(a[c]) *
                (fabs(grads[local][dir]) + gradient_scales[local][dir]);
            abs_gq[c][dir] += fabs(b[c]) *
                (fabs(grads[local][dir]) + gradient_scales[local][dir]);
        }
        for (int c = 0; c < 3; ++c) {
            s[c] += 0.25 * a[c]; q[c] += 0.25 * b[c];
            abs_s[c] += 0.25 * fabs(a[c]);
            abs_q[c] += 0.25 * fabs(b[c]);
        }
    }
    const double divs = gs[0][0] + gs[1][1] + gs[2][2];
    const double divq = gq[0][0] + gq[1][1] + gq[2][2];
    const double snd = s[0]*nx + s[1]*ny + s[2]*nz;
    const double qnd = q[0]*nx + q[1]*ny + q[2]*nz;
    const double gs_n[3] = {nx*gs[0][0]+ny*gs[1][0]+nz*gs[2][0], nx*gs[0][1]+ny*gs[1][1]+nz*gs[2][1], nx*gs[0][2]+ny*gs[1][2]+nz*gs[2][2]};
    const double gq_n[3] = {nx*gq[0][0]+ny*gq[1][0]+nz*gq[2][0], nx*gq[0][1]+ny*gq[1][1]+nz*gq[2][1], nx*gq[0][2]+ny*gq[1][2]+nz*gq[2][2]};
    const double prefactor = 0.5 * d * volume;
    const double prefactor_scale =
        0.5 * abs_d * fabs(volume) * geometry_condition_scale;
    double delta = 0.0;
    double absolute_delta = 0.0;
    if (bulk_mode) {
        const double curls[3] = {gs[2][1]-gs[1][2], gs[0][2]-gs[2][0], gs[1][0]-gs[0][1]};
        const double curlq[3] = {gq[2][1]-gq[1][2], gq[0][2]-gq[2][0], gq[1][0]-gq[0][1]};
        const double bulk_terms[6] = {
            s[0] * curlq[0],
            s[1] * curlq[1],
            s[2] * curlq[2],
            q[0] * curls[0],
            q[1] * curls[1],
            q[2] * curls[2],
        };
        delta = prefactor *
            (bulk_terms[0] + bulk_terms[1] + bulk_terms[2] +
             bulk_terms[3] + bulk_terms[4] + bulk_terms[5]);
        const double arithmetic_scale =
            abs_s[0] * (abs_gq[2][1] + abs_gq[1][2]) +
            abs_s[1] * (abs_gq[0][2] + abs_gq[2][0]) +
            abs_s[2] * (abs_gq[1][0] + abs_gq[0][1]) +
            abs_q[0] * (abs_gs[2][1] + abs_gs[1][2]) +
            abs_q[1] * (abs_gs[0][2] + abs_gs[2][0]) +
            abs_q[2] * (abs_gs[1][0] + abs_gs[0][1]);
        absolute_delta = prefactor_scale * (arithmetic_scale +
            (fabs(bulk_terms[0]) + fabs(bulk_terms[1]) +
             fabs(bulk_terms[2]) + fabs(bulk_terms[3]) +
             fabs(bulk_terms[4]) + fabs(bulk_terms[5])));
    } else {
        const double interfacial_terms[8] = {
            snd * divq,
            qnd * divs,
            -s[0] * gq_n[0],
            -s[1] * gq_n[1],
            -s[2] * gq_n[2],
            -q[0] * gs_n[0],
            -q[1] * gs_n[1],
            -q[2] * gs_n[2],
        };
        delta = prefactor *
            (interfacial_terms[0] + interfacial_terms[1] +
             interfacial_terms[2] + interfacial_terms[3] +
             interfacial_terms[4] + interfacial_terms[5] +
             interfacial_terms[6] + interfacial_terms[7]);
        const double abs_n[3] = {fabs(nx), fabs(ny), fabs(nz)};
        const double abs_snd = abs_s[0]*abs_n[0] + abs_s[1]*abs_n[1] + abs_s[2]*abs_n[2];
        const double abs_qnd = abs_q[0]*abs_n[0] + abs_q[1]*abs_n[1] + abs_q[2]*abs_n[2];
        const double abs_divs = abs_gs[0][0] + abs_gs[1][1] + abs_gs[2][2];
        const double abs_divq = abs_gq[0][0] + abs_gq[1][1] + abs_gq[2][2];
        double arithmetic_scale = abs_snd * abs_divq + abs_qnd * abs_divs;
        for (int c = 0; c < 3; ++c) for (int dir = 0; dir < 3; ++dir) {
            arithmetic_scale +=
                abs_s[dir] * abs_n[c] * abs_gq[c][dir] +
                abs_q[dir] * abs_n[c] * abs_gs[c][dir];
        }
        absolute_delta = prefactor_scale * (arithmetic_scale +
            (fabs(interfacial_terms[0]) + fabs(interfacial_terms[1]) +
             fabs(interfacial_terms[2]) + fabs(interfacial_terms[3]) +
             fabs(interfacial_terms[4]) + fabs(interfacial_terms[5]) +
             fabs(interfacial_terms[6]) + fabs(interfacial_terms[7])));
    }
    dmi_atomic_add_double(delta_out, delta);
    dmi_atomic_add_double(absolute_out, absolute_delta);
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
    DmiDiagnostics *__restrict__ diagnostics,
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
    if (!isfinite(mass) || !isfinite(ms_i)) {
        atomicAdd(
            reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
            1ull);
        return;
    }
    if (mass > 0.0 && ms_i > 0.0) {
        const double inv_projection_mass = -1.0 / (kMu0 * ms_i * mass + kTinyDevice);
        h_dmi_x[node] = residual_x[node] * inv_projection_mass;
        h_dmi_y[node] = residual_y[node] * inv_projection_mass;
        h_dmi_z[node] = residual_z[node] * inv_projection_mass;
        if (!isfinite(h_dmi_x[node]) || !isfinite(h_dmi_y[node]) ||
            !isfinite(h_dmi_z[node])) {
            atomicAdd(
                reinterpret_cast<unsigned long long *>(&diagnostics->nonfinite_count),
                1ull);
        }
    }
}

__global__ void dmi_fail_closed_kernel(
    double *h_dmi_x,
    double *h_dmi_y,
    double *h_dmi_z,
    double *energy_partials,
    const DmiDiagnostics *diagnostics,
    DmiApplyRequest request,
    int node_count)
{
    if (diagnostics->degenerate_tet_count == 0u && diagnostics->nonfinite_count == 0u) {
        return;
    }
    const int node = blockIdx.x * blockDim.x + threadIdx.x;
    if (request.field && node < node_count) {
        h_dmi_x[node] = nan("");
        h_dmi_y[node] = nan("");
        h_dmi_z[node] = nan("");
    }
    if (request.energy && node == 0) {
        energy_partials[0] = nan("");
    }
}

int dmi_energy_partial_count(int node_count)
{
    return node_count > 0
        ? node_count / kBlockSize + (node_count % kBlockSize != 0)
        : 0;
}

cudaError_t fullmag_cuda_dmi_field_energy(
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
    double *energy_partials,
    DmiDiagnostics *diagnostics,
    DmiApplyRequest request,
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
    if (node_count <= 0 || element_count < 0 || diagnostics == nullptr ||
        (!request.field && !request.energy)) {
        return cudaErrorInvalidValue;
    }
    if ((request.field &&
         (residual_x == nullptr || residual_y == nullptr || residual_z == nullptr ||
          h_dmi_x == nullptr || h_dmi_y == nullptr || h_dmi_z == nullptr ||
          lumped_mass == nullptr)) ||
        (request.energy && energy_partials == nullptr) || nodes_xyz == nullptr ||
        elements == nullptr || mx == nullptr || my == nullptr || mz == nullptr) {
        return cudaErrorInvalidDevicePointer;
    }
    cudaError_t status = cudaMemsetAsync(diagnostics, 0, sizeof(DmiDiagnostics), stream);
    if (status != cudaSuccess) {
        return status;
    }
    if (request.field) {
        const size_t node_bytes = static_cast<size_t>(node_count) * sizeof(double);
        status = cudaMemsetAsync(residual_x, 0, node_bytes, stream);
        if (status != cudaSuccess) {
            return status;
        }
        status = cudaMemsetAsync(residual_y, 0, node_bytes, stream);
        if (status != cudaSuccess) {
            return status;
        }
        status = cudaMemsetAsync(residual_z, 0, node_bytes, stream);
        if (status != cudaSuccess) {
            return status;
        }
    }

    const int node_blocks = dmi_energy_partial_count(node_count);
    if (element_count > 0) {
        dmi_element_residual_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
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
            energy_partials,
            diagnostics,
            request,
            uniform_d,
            nx,
            ny,
            nz,
            use_d_field,
            bulk_mode,
            element_count,
            node_count);
        status = cudaPeekAtLastError();
        if (status != cudaSuccess) {
            return status;
        }
    } else if (request.energy) {
        status = cudaMemsetAsync(
            energy_partials,
            0,
            static_cast<size_t>(node_blocks) * sizeof(double),
            stream);
        if (status != cudaSuccess) {
            return status;
        }
    }

    if (request.field) {
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
            diagnostics,
            uniform_ms,
            node_count);
        status = cudaPeekAtLastError();
        if (status != cudaSuccess) {
            return status;
        }
    }
    dmi_fail_closed_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
        h_dmi_x,
        h_dmi_y,
        h_dmi_z,
        energy_partials,
        diagnostics,
        request,
        node_count);
    return cudaPeekAtLastError();
}

cudaError_t fullmag_cuda_dmi_field_energy_cached(
    const DmiGeometryDeviceView &geometry_cache,
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
    double *energy_partials,
    DmiDiagnostics *diagnostics,
    DmiApplyRequest request,
    double uniform_ms,
    double uniform_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool bulk_mode,
    int element_count,
    int node_count,
    cudaStream_t stream,
    DmiAccumulationMode mode)
{
    if (!request.field && !request.energy) {
        return cudaSuccess;
    }
    if (element_count < 0 || node_count < 0 || diagnostics == nullptr) {
        return cudaErrorInvalidValue;
    }
    if (geometry_cache.grads == nullptr || geometry_cache.volume == nullptr ||
        geometry_cache.valid_mask == nullptr) {
        return cudaErrorInvalidDevicePointer;
    }
    if ((request.field &&
         (residual_x == nullptr || residual_y == nullptr || residual_z == nullptr ||
          h_dmi_x == nullptr || h_dmi_y == nullptr || h_dmi_z == nullptr ||
          lumped_mass == nullptr)) ||
        (request.energy && energy_partials == nullptr) ||
        elements == nullptr || mx == nullptr || my == nullptr || mz == nullptr) {
        return cudaErrorInvalidDevicePointer;
    }
    cudaError_t status = cudaMemsetAsync(diagnostics, 0, sizeof(DmiDiagnostics), stream);
    if (status != cudaSuccess) {
        return status;
    }
    if (request.field) {
        const size_t node_bytes = static_cast<size_t>(node_count) * sizeof(double);
        status = cudaMemsetAsync(residual_x, 0, node_bytes, stream);
        if (status != cudaSuccess) {
            return status;
        }
        status = cudaMemsetAsync(residual_y, 0, node_bytes, stream);
        if (status != cudaSuccess) {
            return status;
        }
        status = cudaMemsetAsync(residual_z, 0, node_bytes, stream);
        if (status != cudaSuccess) {
            return status;
        }
    }

    const int node_blocks = dmi_energy_partial_count(node_count);
    if (element_count > 0) {
        if (request.field && mode == DmiAccumulationMode::Coloring && geometry_cache.num_colors > 0 &&
            geometry_cache.host_color_offsets != nullptr && geometry_cache.colored_elements != nullptr) {
            const DmiApplyRequest field_only_request{true, false};
            for (int c = 0; c < geometry_cache.num_colors; ++c) {
                const uint32_t offset = geometry_cache.host_color_offsets[c];
                const uint32_t count = geometry_cache.host_color_offsets[c + 1] - offset;
                if (count == 0) continue;
                const int blocks = (static_cast<int>(count) + kBlockSize - 1) / kBlockSize;
                dmi_cached_element_residual_colored_kernel<<<blocks, kBlockSize, 0, stream>>>(
                    geometry_cache.grads,
                    geometry_cache.volume,
                    geometry_cache.valid_mask,
                    elements,
                    geometry_cache.colored_elements,
                    static_cast<int>(offset),
                    static_cast<int>(count),
                    magnetic_element_mask,
                    mx,
                    my,
                    mz,
                    ms,
                    d_field,
                    residual_x,
                    residual_y,
                    residual_z,
                    nullptr,
                    diagnostics,
                    field_only_request,
                    uniform_d,
                    nx,
                    ny,
                    nz,
                    use_d_field,
                    bulk_mode,
                    element_count,
                    node_count);
                status = cudaPeekAtLastError();
                if (status != cudaSuccess) {
                    return status;
                }
            }
            if (request.energy) {
                status = cudaMemsetAsync(
                    diagnostics, 0, sizeof(DmiDiagnostics), stream);
                if (status != cudaSuccess) {
                    return status;
                }
                dmi_cached_element_residual_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
                    geometry_cache.grads,
                    geometry_cache.volume,
                    geometry_cache.valid_mask,
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
                    energy_partials,
                    diagnostics,
                    DmiApplyRequest{false, true},
                    uniform_d,
                    nx,
                    ny,
                    nz,
                    use_d_field,
                    bulk_mode,
                    element_count,
                    node_count);
                status = cudaPeekAtLastError();
                if (status != cudaSuccess) {
                    return status;
                }
            }
        } else {
            dmi_cached_element_residual_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
                geometry_cache.grads,
                geometry_cache.volume,
                geometry_cache.valid_mask,
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
                energy_partials,
                diagnostics,
                request,
                uniform_d,
                nx,
                ny,
                nz,
                use_d_field,
                bulk_mode,
                element_count,
                node_count);
            status = cudaPeekAtLastError();
            if (status != cudaSuccess) {
                return status;
            }
        }
    } else if (request.energy) {
        status = cudaMemsetAsync(
            energy_partials,
            0,
            static_cast<size_t>(node_blocks) * sizeof(double),
            stream);
        if (status != cudaSuccess) {
            return status;
        }
    }

    if (request.field) {
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
            diagnostics,
            uniform_ms,
            node_count);
        status = cudaPeekAtLastError();
        if (status != cudaSuccess) {
            return status;
        }
    }
    dmi_fail_closed_kernel<<<node_blocks, kBlockSize, 0, stream>>>(
        h_dmi_x,
        h_dmi_y,
        h_dmi_z,
        energy_partials,
        diagnostics,
        request,
        node_count);
    return cudaPeekAtLastError();
}

cudaError_t fullmag_cuda_dmi_pairwise_sum(
    double *partials,
    double *scratch,
    int partial_count,
    double *result,
    cudaStream_t stream)
{
    if (partials == nullptr || scratch == nullptr || result == nullptr || partial_count <= 0) {
        return cudaErrorInvalidValue;
    }
    const double *input = partials;
    double *output = scratch;
    int input_count = partial_count;
    while (input_count > 1) {
        const int output_count = (input_count + 1) / 2;
        const int blocks = (output_count + kBlockSize - 1) / kBlockSize;
        dmi_pairwise_sum_in_place<<<blocks, kBlockSize, 0, stream>>>(
            input, output, input_count);
        cudaError_t status = cudaPeekAtLastError();
        if (status != cudaSuccess) {
            return status;
        }
        input_count = output_count;
        input = output;
        output = output == scratch ? partials : scratch;
    }
    return cudaMemcpyAsync(result, input, sizeof(double), cudaMemcpyDeviceToDevice, stream);
}

void fullmag_cuda_dmi_energy_difference(
    const double *nodes_xyz, const uint32_t *elements, const uint8_t *magnetic_element_mask,
    const double *m0x, const double *m0y, const double *m0z,
    const double *m1x, const double *m1y, const double *m1z,
    const double *d_field, double *element_delta,
    double *element_absolute_terms,
    double uniform_d, double nx, double ny, double nz,
    bool use_d_field, bool bulk_mode, int element_count, cudaStream_t stream)
{
    dmi_energy_difference_kernel<<<(element_count + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        nodes_xyz, elements, magnetic_element_mask, m0x, m0y, m0z, m1x, m1y, m1z,
        d_field, element_delta, element_absolute_terms, uniform_d,
        nx, ny, nz, use_d_field, bulk_mode, element_count);
}

} // namespace fullmag::fem
