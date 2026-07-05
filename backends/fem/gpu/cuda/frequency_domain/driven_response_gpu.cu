#include "cpu/frequency_domain/mfem_dmi_operator.hpp"
#include "frequency_domain/operator_terms.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <new>

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
    const double *demag_tangent,
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

    if (demag_tangent != nullptr) {
        h0 += demag_tangent[dof0];
        h1 += demag_tangent[dof1];
    }

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

__global__ void lift_tangent_to_full_kernel(
    const fd::TangentFrameNode *nodes,
    const double *tangent_in,
    double *delta_xyz,
    unsigned long long node_count)
{
    const unsigned long long node_index =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (node_index >= node_count) {
        return;
    }
    const fd::TangentFrameNode node = nodes[node_index];
    const unsigned long long dof0 = node_index * 2;
    const double q0 = tangent_in[dof0];
    const double q1 = tangent_in[dof0 + 1];
    const unsigned long long full0 = node_index * 3;
    for (int comp = 0; comp < 3; ++comp) {
        delta_xyz[full0 + static_cast<unsigned long long>(comp)] =
            q0 * node.e1[comp] + q1 * node.e2[comp];
    }
}

__device__ bool dmi_element_kind_supported_device(fd::MfemDmiInteractionKind kind)
{
    return kind == fd::MfemDmiInteractionKind::interfacial ||
        kind == fd::MfemDmiInteractionKind::bulk;
}

__global__ void dmi_element_tangent_kernel(
    const fd::MfemDmiElementTangentData *elements,
    unsigned long long element_count,
    unsigned long long node_count,
    const double *delta_xyz,
    double *residual_xyz)
{
    const unsigned long long element_index =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (element_index >= element_count) {
        return;
    }
    const fd::MfemDmiElementTangentData element = elements[element_index];
    if (!dmi_element_kind_supported_device(element.kind) ||
        !isfinite(element.weight) ||
        !isfinite(element.d) ||
        element.weight == 0.0 ||
        element.d == 0.0) {
        return;
    }

    double delta_q[3] = {};
    double grad_delta[3][3] = {};
    for (int local_node = 0; local_node < 4; ++local_node) {
        const unsigned int node_index = element.node_indices[local_node];
        if (static_cast<unsigned long long>(node_index) >= node_count) {
            return;
        }
        const double *delta = delta_xyz + static_cast<unsigned long long>(node_index) * 3ull;
        const double shape = element.shape[local_node];
        if (!isfinite(shape)) {
            return;
        }
        for (int comp = 0; comp < 3; ++comp) {
            delta_q[comp] += shape * delta[comp];
            for (int dir = 0; dir < 3; ++dir) {
                const double grad_shape = element.grad_shape[local_node][dir];
                if (!isfinite(grad_shape)) {
                    return;
                }
                grad_delta[comp][dir] += delta[comp] * grad_shape;
            }
        }
    }

    const double div_delta =
        grad_delta[0][0] + grad_delta[1][1] + grad_delta[2][2];
    const double curl_delta[3] = {
        grad_delta[2][1] - grad_delta[1][2],
        grad_delta[0][2] - grad_delta[2][0],
        grad_delta[1][0] - grad_delta[0][1],
    };
    const double normal[3] = {
        element.normal[0],
        element.normal[1],
        element.normal[2],
    };
    const double grad_delta_dot_n[3] = {
        normal[0] * grad_delta[0][0] + normal[1] * grad_delta[1][0] + normal[2] * grad_delta[2][0],
        normal[0] * grad_delta[0][1] + normal[1] * grad_delta[1][1] + normal[2] * grad_delta[2][1],
        normal[0] * grad_delta[0][2] + normal[1] * grad_delta[1][2] + normal[2] * grad_delta[2][2],
    };
    const double delta_dot_n =
        delta_q[0] * normal[0] + delta_q[1] * normal[1] + delta_q[2] * normal[2];

    for (int local_node = 0; local_node < 4; ++local_node) {
        const unsigned int node_index = element.node_indices[local_node];
        const double shape = element.shape[local_node];
        const double *grad_shape = element.grad_shape[local_node];
        double residual[3] = {};
        if (element.kind == fd::MfemDmiInteractionKind::bulk) {
            residual[0] = element.d * element.weight *
                (shape * curl_delta[0] + delta_q[1] * grad_shape[2] - delta_q[2] * grad_shape[1]);
            residual[1] = element.d * element.weight *
                (shape * curl_delta[1] - delta_q[0] * grad_shape[2] + delta_q[2] * grad_shape[0]);
            residual[2] = element.d * element.weight *
                (shape * curl_delta[2] + delta_q[0] * grad_shape[1] - delta_q[1] * grad_shape[0]);
        } else {
            for (int comp = 0; comp < 3; ++comp) {
                const double n_comp = normal[comp];
                const double dw_dm = element.d * (n_comp * div_delta - grad_delta_dot_n[comp]);
                double grad_action = 0.0;
                for (int dir = 0; dir < 3; ++dir) {
                    const double delta = comp == dir ? 1.0 : 0.0;
                    const double delta_dir = delta_q[dir];
                    const double dw_dg =
                        element.d * (delta_dot_n * delta - n_comp * delta_dir);
                    grad_action += dw_dg * grad_shape[dir];
                }
                residual[comp] = element.weight * (shape * dw_dm + grad_action);
            }
        }
        double *out = residual_xyz + static_cast<unsigned long long>(node_index) * 3ull;
        frequency_domain_atomic_add_double(&out[0], residual[0]);
        frequency_domain_atomic_add_double(&out[1], residual[1]);
        frequency_domain_atomic_add_double(&out[2], residual[2]);
    }
}

__global__ void dmi_project_to_tangent_kernel(
    const fd::TangentFrameNode *nodes,
    const double *residual_xyz,
    const double *lumped_mass,
    const double *ms_field,
    double uniform_ms,
    double *effective_tangent,
    unsigned long long node_count)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    constexpr double kTinyDevice = 1.0e-300;
    const unsigned long long node_index =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (node_index >= node_count) {
        return;
    }
    const double mass = lumped_mass[node_index];
    const double ms_i = ms_field == nullptr ? uniform_ms : ms_field[node_index];
    if (!(mass > 0.0) || !(ms_i > 0.0)) {
        return;
    }
    const double inv_projection_mass = -1.0 / (kMu0 * ms_i * mass + kTinyDevice);
    const double *residual = residual_xyz + node_index * 3ull;
    const double field[3] = {
        residual[0] * inv_projection_mass,
        residual[1] * inv_projection_mass,
        residual[2] * inv_projection_mass,
    };
    const fd::TangentFrameNode node = nodes[node_index];
    const unsigned long long dof0 = node_index * 2ull;
    effective_tangent[dof0] += dot3_device(field, node.e1);
    effective_tangent[dof0 + 1ull] += dot3_device(field, node.e2);
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

template <typename T>
bool allocate_device_buffer(
    T **device_ptr,
    unsigned long long count,
    const char *name,
    char *error_message,
    unsigned long long error_message_len)
{
    *device_ptr = nullptr;
    if (count == 0) {
        return true;
    }
    if (!cuda_success(cudaMalloc(device_ptr, sizeof(T) * count), name, error_message, error_message_len)) {
        return false;
    }
    return true;
}

struct FrequencyDomainGpuOperatorContext {
    unsigned long long node_count = 0;
    unsigned long long tangent_dof_count = 0;
    unsigned long long exchange_edge_count = 0;
    int exchange_enabled = 0;
    int zeeman_enabled = 0;
    int uniaxial_anisotropy_enabled = 0;
    double uniaxial_anisotropy_field_a_per_m = 0.0;
    double alpha = 0.0;
    double gamma0 = 0.0;
    int dmi_enabled = 0;
    unsigned long long dmi_element_count = 0;
    double dmi_uniform_ms = 0.0;
    fd::TangentFrameNode *d_nodes = nullptr;
    fd::TangentOperatorEdgeBlock *d_edges = nullptr;
    fd::MfemDmiElementTangentData *d_dmi_elements = nullptr;
    double *d_tangent_in = nullptr;
    double *d_effective = nullptr;
    double *d_stiffness = nullptr;
    double *d_mass = nullptr;
    double *d_alpha_per_node = nullptr;
    double *d_demag_tangent = nullptr;
    double *d_h_ext = nullptr;
    double *d_anisotropy_axis = nullptr;
    double *d_dmi_lumped_mass = nullptr;
    double *d_dmi_ms_field = nullptr;
    double *d_dmi_delta_xyz = nullptr;
    double *d_dmi_residual_xyz = nullptr;
};

void destroy_context(FrequencyDomainGpuOperatorContext *context)
{
    if (context == nullptr) {
        return;
    }
    cudaFree(context->d_nodes);
    cudaFree(context->d_edges);
    cudaFree(context->d_dmi_elements);
    cudaFree(context->d_tangent_in);
    cudaFree(context->d_effective);
    cudaFree(context->d_stiffness);
    cudaFree(context->d_mass);
    cudaFree(context->d_alpha_per_node);
    cudaFree(context->d_demag_tangent);
    cudaFree(context->d_h_ext);
    cudaFree(context->d_anisotropy_axis);
    cudaFree(context->d_dmi_lumped_mass);
    cudaFree(context->d_dmi_ms_field);
    cudaFree(context->d_dmi_delta_xyz);
    cudaFree(context->d_dmi_residual_xyz);
    delete context;
}

bool validate_dmi_context_inputs(
    unsigned long long node_count,
    int dmi_enabled,
    const fd::MfemDmiElementTangentData *dmi_elements,
    unsigned long long dmi_element_count,
    const double *dmi_lumped_mass,
    const double *dmi_ms_field,
    double dmi_uniform_ms,
    char *error_message,
    unsigned long long error_message_len)
{
    if (!dmi_enabled) {
        return true;
    }
    if (dmi_elements == nullptr || dmi_element_count == 0 || dmi_lumped_mass == nullptr) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "DMI GPU frequency-domain operator requires element data and lumped mass");
        }
        return false;
    }
    if (!(dmi_uniform_ms > 0.0) || !std::isfinite(dmi_uniform_ms)) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "DMI GPU frequency-domain operator requires positive uniform Ms");
        }
        return false;
    }
    if (dmi_ms_field != nullptr) {
        for (unsigned long long node_index = 0; node_index < node_count; ++node_index) {
            if (!std::isfinite(dmi_ms_field[node_index]) || dmi_ms_field[node_index] <= 0.0) {
                if (error_message != nullptr && error_message_len > 0) {
                    std::snprintf(
                        error_message,
                        static_cast<std::size_t>(error_message_len),
                        "DMI GPU frequency-domain operator requires positive nodal Ms");
                }
                return false;
            }
        }
    }
    for (unsigned long long element_index = 0; element_index < dmi_element_count; ++element_index) {
        const fd::MfemDmiElementTangentData &element = dmi_elements[element_index];
        if (element.kind != fd::MfemDmiInteractionKind::interfacial &&
            element.kind != fd::MfemDmiInteractionKind::bulk) {
            if (error_message != nullptr && error_message_len > 0) {
                std::snprintf(
                    error_message,
                    static_cast<std::size_t>(error_message_len),
                    "DMI GPU frequency-domain operator requires supported DMI element kind");
            }
            return false;
        }
        if (!std::isfinite(element.weight) || !std::isfinite(element.d)) {
            if (error_message != nullptr && error_message_len > 0) {
                std::snprintf(
                    error_message,
                    static_cast<std::size_t>(error_message_len),
                    "DMI GPU frequency-domain operator requires finite DMI coefficients");
            }
            return false;
        }
        for (int local_node = 0; local_node < 4; ++local_node) {
            if (static_cast<unsigned long long>(element.node_indices[local_node]) >= node_count ||
                !std::isfinite(element.shape[local_node])) {
                if (error_message != nullptr && error_message_len > 0) {
                    std::snprintf(
                        error_message,
                        static_cast<std::size_t>(error_message_len),
                        "DMI GPU frequency-domain operator has invalid element topology");
                }
                return false;
            }
            for (int dir = 0; dir < 3; ++dir) {
                if (!std::isfinite(element.grad_shape[local_node][dir])) {
                    if (error_message != nullptr && error_message_len > 0) {
                        std::snprintf(
                            error_message,
                            static_cast<std::size_t>(error_message_len),
                            "DMI GPU frequency-domain operator requires finite element gradients");
                    }
                    return false;
                }
            }
        }
        if (element.kind == fd::MfemDmiInteractionKind::interfacial &&
            (!std::isfinite(element.normal[0]) ||
             !std::isfinite(element.normal[1]) ||
             !std::isfinite(element.normal[2]))) {
            if (error_message != nullptr && error_message_len > 0) {
                std::snprintf(
                    error_message,
                    static_cast<std::size_t>(error_message_len),
                    "DMI GPU frequency-domain operator requires finite interface normal");
            }
            return false;
        }
    }
    return true;
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
    const double *demag_tangent,
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
    double *d_demag_tangent = nullptr;
    double *d_h_ext = nullptr;
    double *d_anisotropy_axis = nullptr;

    bool ok =
        allocate_and_copy(&d_nodes, nodes, node_count, "tangent frame", error_message, error_message_len) &&
        allocate_and_copy(&d_edges, exchange_edges, exchange_enabled ? exchange_edge_count : 0, "exchange edges", error_message, error_message_len) &&
        allocate_and_copy(&d_tangent_in, tangent_in, tangent_dof_count, "tangent input", error_message, error_message_len) &&
        allocate_and_copy(&d_alpha_per_node, alpha_per_node, alpha_per_node == nullptr ? 0 : node_count, "alpha field", error_message, error_message_len) &&
        allocate_and_copy(&d_demag_tangent, demag_tangent, demag_tangent == nullptr ? 0 : tangent_dof_count, "demag tangent", error_message, error_message_len) &&
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
            d_demag_tangent,
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
    cudaFree(d_demag_tangent);
    cudaFree(d_h_ext);
    cudaFree(d_anisotropy_axis);
    return ok ? 0 : 1;
}

extern "C" int fullmag_fem_frequency_domain_create_mfem_gpu_operator_context(
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
    int dmi_enabled,
    const fd::MfemDmiElementTangentData *dmi_elements,
    unsigned long long dmi_element_count,
    const double *dmi_lumped_mass,
    const double *dmi_ms_field,
    double dmi_uniform_ms,
    double alpha,
    double gamma0,
    void **out_context,
    char *error_message,
    unsigned long long error_message_len)
{
    if (out_context == nullptr) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "missing production GPU frequency-domain context output");
        }
        return 1;
    }
    *out_context = nullptr;
    if (node_count == 0 ||
        tangent_dof_count != node_count * 2 ||
        nodes == nullptr ||
        (exchange_enabled && (exchange_edges == nullptr || exchange_edge_count == 0)) ||
        (zeeman_enabled && h_ext_a_per_m == nullptr) ||
        (uniaxial_anisotropy_enabled && uniaxial_anisotropy_axis == nullptr)) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid production GPU frequency-domain operator context inputs");
        }
        return 1;
    }
    if (!validate_dmi_context_inputs(
            node_count,
            dmi_enabled,
            dmi_elements,
            dmi_element_count,
            dmi_lumped_mass,
            dmi_ms_field,
            dmi_uniform_ms,
            error_message,
            error_message_len)) {
        return 1;
    }

    auto *context = new (std::nothrow) FrequencyDomainGpuOperatorContext();
    if (context == nullptr) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "failed to allocate production GPU frequency-domain operator context");
        }
        return 1;
    }
    context->node_count = node_count;
    context->tangent_dof_count = tangent_dof_count;
    context->exchange_edge_count = exchange_edge_count;
    context->exchange_enabled = exchange_enabled;
    context->zeeman_enabled = zeeman_enabled;
    context->uniaxial_anisotropy_enabled = uniaxial_anisotropy_enabled;
    context->uniaxial_anisotropy_field_a_per_m = uniaxial_anisotropy_field_a_per_m;
    context->alpha = alpha;
    context->gamma0 = gamma0;
    context->dmi_enabled = dmi_enabled;
    context->dmi_element_count = dmi_enabled ? dmi_element_count : 0;
    context->dmi_uniform_ms = dmi_uniform_ms;

    bool ok =
        allocate_and_copy(&context->d_nodes, nodes, node_count, "tangent frame", error_message, error_message_len) &&
        allocate_and_copy(&context->d_edges, exchange_edges, exchange_enabled ? exchange_edge_count : 0, "exchange edges", error_message, error_message_len) &&
        allocate_and_copy(&context->d_dmi_elements, dmi_elements, context->dmi_element_count, "DMI elements", error_message, error_message_len) &&
        allocate_and_copy(&context->d_alpha_per_node, alpha_per_node, alpha_per_node == nullptr ? 0 : node_count, "alpha field", error_message, error_message_len) &&
        allocate_and_copy(&context->d_h_ext, h_ext_a_per_m, zeeman_enabled ? 3 : 0, "Zeeman field", error_message, error_message_len) &&
        allocate_and_copy(&context->d_anisotropy_axis, uniaxial_anisotropy_axis, uniaxial_anisotropy_enabled ? 3 : 0, "anisotropy axis", error_message, error_message_len) &&
        allocate_and_copy(&context->d_dmi_lumped_mass, dmi_lumped_mass, dmi_enabled ? node_count : 0, "DMI lumped mass", error_message, error_message_len) &&
        allocate_and_copy(&context->d_dmi_ms_field, dmi_ms_field, dmi_enabled && dmi_ms_field != nullptr ? node_count : 0, "DMI Ms field", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_tangent_in, tangent_dof_count, "cudaMalloc frequency-domain tangent input", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_effective, tangent_dof_count, "cudaMalloc frequency-domain effective tangent", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_stiffness, tangent_dof_count, "cudaMalloc frequency-domain stiffness tangent", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_mass, tangent_dof_count, "cudaMalloc frequency-domain mass tangent", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_demag_tangent, tangent_dof_count, "cudaMalloc frequency-domain demag tangent", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_dmi_delta_xyz, dmi_enabled ? node_count * 3ull : 0, "cudaMalloc frequency-domain DMI delta", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_dmi_residual_xyz, dmi_enabled ? node_count * 3ull : 0, "cudaMalloc frequency-domain DMI residual", error_message, error_message_len);
    if (!ok) {
        destroy_context(context);
        return 1;
    }

    *out_context = context;
    return 0;
}

extern "C" int fullmag_fem_frequency_domain_apply_mfem_gpu_operator_context(
    void *opaque_context,
    const double *demag_tangent,
    const double *tangent_in,
    double *out_stiffness,
    double *out_mass,
    char *error_message,
    unsigned long long error_message_len)
{
    auto *context = static_cast<FrequencyDomainGpuOperatorContext *>(opaque_context);
    if (context == nullptr ||
        tangent_in == nullptr ||
        out_stiffness == nullptr ||
        out_mass == nullptr) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid production GPU frequency-domain context apply buffers");
        }
        return 1;
    }

    bool ok = cuda_success(
        cudaMemcpy(
            context->d_tangent_in,
            tangent_in,
            sizeof(double) * context->tangent_dof_count,
            cudaMemcpyHostToDevice),
        "cudaMemcpy frequency-domain tangent input host-to-device",
        error_message,
        error_message_len);
    if (ok && demag_tangent != nullptr) {
        ok = cuda_success(
            cudaMemcpy(
                context->d_demag_tangent,
                demag_tangent,
                sizeof(double) * context->tangent_dof_count,
                cudaMemcpyHostToDevice),
            "cudaMemcpy frequency-domain demag tangent host-to-device",
            error_message,
            error_message_len);
    }
    if (ok) {
        const int dof_blocks = static_cast<int>((context->tangent_dof_count + kBlockSize - 1) / kBlockSize);
        zero_tangent_kernel<<<dof_blocks, kBlockSize>>>(context->d_effective, context->tangent_dof_count);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain zero tangent", error_message, error_message_len);
    }
    if (ok && context->exchange_enabled) {
        const int edge_blocks = static_cast<int>((context->exchange_edge_count + kBlockSize - 1) / kBlockSize);
        exchange_kernel<<<edge_blocks, kBlockSize>>>(
            context->d_edges,
            context->exchange_edge_count,
            context->d_tangent_in,
            context->d_effective);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain exchange operator", error_message, error_message_len);
    }
    if (ok && context->dmi_enabled) {
        const int node_blocks = static_cast<int>((context->node_count + kBlockSize - 1) / kBlockSize);
        const unsigned long long full_dof_count = context->node_count * 3ull;
        zero_tangent_kernel<<<static_cast<int>((full_dof_count + kBlockSize - 1) / kBlockSize), kBlockSize>>>(
            context->d_dmi_residual_xyz,
            full_dof_count);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain DMI residual zero", error_message, error_message_len);
        if (ok) {
            lift_tangent_to_full_kernel<<<node_blocks, kBlockSize>>>(
                context->d_nodes,
                context->d_tangent_in,
                context->d_dmi_delta_xyz,
                context->node_count);
            ok = cuda_success(cudaGetLastError(), "launch frequency-domain DMI tangent lift", error_message, error_message_len);
        }
        if (ok) {
            const int element_blocks = static_cast<int>((context->dmi_element_count + kBlockSize - 1) / kBlockSize);
            dmi_element_tangent_kernel<<<element_blocks, kBlockSize>>>(
                context->d_dmi_elements,
                context->dmi_element_count,
                context->node_count,
                context->d_dmi_delta_xyz,
                context->d_dmi_residual_xyz);
            ok = cuda_success(cudaGetLastError(), "launch frequency-domain DMI tangent operator", error_message, error_message_len);
        }
        if (ok) {
            dmi_project_to_tangent_kernel<<<node_blocks, kBlockSize>>>(
                context->d_nodes,
                context->d_dmi_residual_xyz,
                context->d_dmi_lumped_mass,
                context->d_dmi_ms_field,
                context->dmi_uniform_ms,
                context->d_effective,
                context->node_count);
            ok = cuda_success(cudaGetLastError(), "launch frequency-domain DMI tangent projection", error_message, error_message_len);
        }
    }
    if (ok) {
        const int node_blocks = static_cast<int>((context->node_count + kBlockSize - 1) / kBlockSize);
        local_precession_mass_kernel<<<node_blocks, kBlockSize>>>(
            context->d_nodes,
            context->node_count,
            context->d_tangent_in,
            context->d_alpha_per_node,
            demag_tangent == nullptr ? nullptr : context->d_demag_tangent,
            context->alpha,
            context->gamma0,
            context->zeeman_enabled,
            context->d_h_ext,
            context->uniaxial_anisotropy_enabled,
            context->d_anisotropy_axis,
            context->uniaxial_anisotropy_field_a_per_m,
            context->d_effective,
            context->d_stiffness,
            context->d_mass);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain local/precession/mass operator", error_message, error_message_len) &&
            cuda_success(cudaDeviceSynchronize(), "synchronize frequency-domain GPU operator", error_message, error_message_len);
    }
    if (ok) {
        ok =
            cuda_success(
                cudaMemcpy(out_stiffness, context->d_stiffness, sizeof(double) * context->tangent_dof_count, cudaMemcpyDeviceToHost),
                "cudaMemcpy frequency-domain stiffness device-to-host",
                error_message,
                error_message_len) &&
            cuda_success(
                cudaMemcpy(out_mass, context->d_mass, sizeof(double) * context->tangent_dof_count, cudaMemcpyDeviceToHost),
                "cudaMemcpy frequency-domain mass device-to-host",
                error_message,
                error_message_len);
    }
    return ok ? 0 : 1;
}

extern "C" void fullmag_fem_frequency_domain_destroy_mfem_gpu_operator_context(
    void *opaque_context)
{
    destroy_context(static_cast<FrequencyDomainGpuOperatorContext *>(opaque_context));
}
