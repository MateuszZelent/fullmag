#include "frequency_domain/operator_terms.hpp"

#include <cuda_runtime.h>

#include <cstdio>
#include <cstring>

namespace fd = fullmag::fem::frequency_domain;

namespace {

constexpr int kBlockSize = 256;

__device__ double dot3_device(const double a[3], const double b[3])
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

__device__ double frequency_domain_atomic_add_double(double *address, double value)
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

__global__ void zero_tangent_kernel(double *values, unsigned long long count)
{
    const unsigned long long index =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < count) {
        values[index] = 0.0;
    }
}

__global__ void exchange_kernel(
    const fd::TangentOperatorEdgeBlock *edges,
    unsigned long long edge_count,
    const double *tangent_in,
    double *effective_tangent)
{
    const unsigned long long edge_index =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (edge_index >= edge_count) {
        return;
    }
    const fd::TangentOperatorEdgeBlock edge = edges[edge_index];
    for (unsigned long long component = 0; component < 2; ++component) {
        const unsigned long long dof_i = edge.node_i * 2 + component;
        const unsigned long long dof_j = edge.node_j * 2 + component;
        const double delta = edge.stiffness * (tangent_in[dof_i] - tangent_in[dof_j]);
        frequency_domain_atomic_add_double(&effective_tangent[dof_i], delta);
        frequency_domain_atomic_add_double(&effective_tangent[dof_j], -delta);
    }
}

__global__ void local_precession_mass_kernel(
    const fd::TangentFrameNode *nodes,
    unsigned long long node_count,
    const double *tangent_in,
    const double *alpha_per_node,
    double alpha,
    double gamma0,
    int zeeman_enabled,
    const double h_ext[3],
    int uniaxial_anisotropy_enabled,
    const double anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    double *effective_tangent,
    double *out_stiffness,
    double *out_mass)
{
    const unsigned long long node_index =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (node_index >= node_count) {
        return;
    }

    const fd::TangentFrameNode node = nodes[node_index];
    const unsigned long long dof0 = node_index * 2;
    const unsigned long long dof1 = dof0 + 1;
    const double q0 = tangent_in[dof0];
    const double q1 = tangent_in[dof1];
    double h0 = effective_tangent[dof0];
    double h1 = effective_tangent[dof1];

    if (zeeman_enabled) {
        const double h_parallel = dot3_device(h_ext, node.m);
        h0 += -h_parallel * q0;
        h1 += -h_parallel * q1;
    }

    if (uniaxial_anisotropy_enabled) {
        const double u0 = dot3_device(anisotropy_axis, node.e1);
        const double u1 = dot3_device(anisotropy_axis, node.e2);
        const double projected = u0 * q0 + u1 * q1;
        h0 += uniaxial_anisotropy_field_a_per_m * u0 * projected;
        h1 += uniaxial_anisotropy_field_a_per_m * u1 * projected;
    }

    out_stiffness[dof0] = gamma0 * h1;
    out_stiffness[dof1] = -gamma0 * h0;

    const double node_alpha = alpha_per_node == nullptr ? alpha : alpha_per_node[node_index];
    out_mass[dof0] = q0 + node_alpha * q1;
    out_mass[dof1] = q1 - node_alpha * q0;
}

bool cuda_success(cudaError_t status, const char *operation, char *error_message, unsigned long long error_message_len)
{
    if (status == cudaSuccess) {
        return true;
    }
    if (error_message != nullptr && error_message_len > 0) {
        std::snprintf(
            error_message,
            static_cast<std::size_t>(error_message_len),
            "%s failed: %s",
            operation,
            cudaGetErrorString(status));
    }
    return false;
}

template <typename T>
bool allocate_and_copy(
    T **device_ptr,
    const T *host_ptr,
    unsigned long long count,
    const char *name,
    char *error_message,
    unsigned long long error_message_len)
{
    *device_ptr = nullptr;
    if (count == 0) {
        return true;
    }
    if (host_ptr == nullptr) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "missing %s host buffer",
                name);
        }
        return false;
    }
    if (!cuda_success(cudaMalloc(device_ptr, sizeof(T) * count), "cudaMalloc frequency-domain buffer", error_message, error_message_len)) {
        return false;
    }
    return cuda_success(
        cudaMemcpy(*device_ptr, host_ptr, sizeof(T) * count, cudaMemcpyHostToDevice),
        "cudaMemcpy frequency-domain host-to-device",
        error_message,
        error_message_len);
}

} // namespace

extern "C" int fullmag_fem_frequency_domain_apply_mfem_gpu_operator(
    unsigned long long node_count,
    unsigned long long tangent_dof_count,
    const fd::TangentFrameNode *nodes,
    int exchange_enabled,
    const fd::TangentOperatorEdgeBlock *exchange_edges,
    unsigned long long exchange_edge_count,
    int zeeman_enabled,
    const double h_ext_a_per_m[3],
    int uniaxial_anisotropy_enabled,
    const double uniaxial_anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    const double *alpha_per_node,
    double alpha,
    double gamma0,
    const double *tangent_in,
    double *out_stiffness,
    double *out_mass,
    char *error_message,
    unsigned long long error_message_len)
{
    if (node_count == 0 ||
        tangent_dof_count != node_count * 2 ||
        nodes == nullptr ||
        tangent_in == nullptr ||
        out_stiffness == nullptr ||
        out_mass == nullptr ||
        (exchange_enabled && (exchange_edges == nullptr || exchange_edge_count == 0)) ||
        (zeeman_enabled && h_ext_a_per_m == nullptr) ||
        (uniaxial_anisotropy_enabled && uniaxial_anisotropy_axis == nullptr)) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid production GPU frequency-domain operator buffers");
        }
        return 1;
    }

    fd::TangentFrameNode *d_nodes = nullptr;
    fd::TangentOperatorEdgeBlock *d_edges = nullptr;
    double *d_tangent_in = nullptr;
    double *d_effective = nullptr;
    double *d_stiffness = nullptr;
    double *d_mass = nullptr;
    double *d_alpha_per_node = nullptr;
    double *d_h_ext = nullptr;
    double *d_anisotropy_axis = nullptr;

    bool ok =
        allocate_and_copy(&d_nodes, nodes, node_count, "tangent frame", error_message, error_message_len) &&
        allocate_and_copy(&d_edges, exchange_edges, exchange_enabled ? exchange_edge_count : 0, "exchange edges", error_message, error_message_len) &&
        allocate_and_copy(&d_tangent_in, tangent_in, tangent_dof_count, "tangent input", error_message, error_message_len) &&
        allocate_and_copy(&d_alpha_per_node, alpha_per_node, alpha_per_node == nullptr ? 0 : node_count, "alpha field", error_message, error_message_len) &&
        allocate_and_copy(&d_h_ext, h_ext_a_per_m, zeeman_enabled ? 3 : 0, "Zeeman field", error_message, error_message_len) &&
        allocate_and_copy(&d_anisotropy_axis, uniaxial_anisotropy_axis, uniaxial_anisotropy_enabled ? 3 : 0, "anisotropy axis", error_message, error_message_len);
    ok = ok &&
        cuda_success(cudaMalloc(&d_effective, sizeof(double) * tangent_dof_count), "cudaMalloc effective tangent", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_stiffness, sizeof(double) * tangent_dof_count), "cudaMalloc stiffness tangent", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_mass, sizeof(double) * tangent_dof_count), "cudaMalloc mass tangent", error_message, error_message_len);

    if (ok) {
        const int dof_blocks = static_cast<int>((tangent_dof_count + kBlockSize - 1) / kBlockSize);
        zero_tangent_kernel<<<dof_blocks, kBlockSize>>>(d_effective, tangent_dof_count);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain zero tangent", error_message, error_message_len);
    }
    if (ok && exchange_enabled) {
        const int edge_blocks = static_cast<int>((exchange_edge_count + kBlockSize - 1) / kBlockSize);
        exchange_kernel<<<edge_blocks, kBlockSize>>>(
            d_edges,
            exchange_edge_count,
            d_tangent_in,
            d_effective);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain exchange operator", error_message, error_message_len);
    }
    if (ok) {
        const int node_blocks = static_cast<int>((node_count + kBlockSize - 1) / kBlockSize);
        local_precession_mass_kernel<<<node_blocks, kBlockSize>>>(
            d_nodes,
            node_count,
            d_tangent_in,
            d_alpha_per_node,
            alpha,
            gamma0,
            zeeman_enabled,
            d_h_ext,
            uniaxial_anisotropy_enabled,
            d_anisotropy_axis,
            uniaxial_anisotropy_field_a_per_m,
            d_effective,
            d_stiffness,
            d_mass);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain local/precession/mass operator", error_message, error_message_len) &&
            cuda_success(cudaDeviceSynchronize(), "synchronize frequency-domain GPU operator", error_message, error_message_len);
    }
    if (ok) {
        ok =
            cuda_success(
                cudaMemcpy(out_stiffness, d_stiffness, sizeof(double) * tangent_dof_count, cudaMemcpyDeviceToHost),
                "cudaMemcpy frequency-domain stiffness device-to-host",
                error_message,
                error_message_len) &&
            cuda_success(
                cudaMemcpy(out_mass, d_mass, sizeof(double) * tangent_dof_count, cudaMemcpyDeviceToHost),
                "cudaMemcpy frequency-domain mass device-to-host",
                error_message,
                error_message_len);
    }

    cudaFree(d_nodes);
    cudaFree(d_edges);
    cudaFree(d_tangent_in);
    cudaFree(d_effective);
    cudaFree(d_stiffness);
    cudaFree(d_mass);
    cudaFree(d_alpha_per_node);
    cudaFree(d_h_ext);
    cudaFree(d_anisotropy_axis);
    return ok ? 0 : 1;
}
