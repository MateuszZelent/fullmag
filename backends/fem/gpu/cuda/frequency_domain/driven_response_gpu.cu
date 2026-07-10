#include "cpu/frequency_domain/mfem_dmi_operator.hpp"
#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "frequency_domain/checked_extent.hpp"
#include "frequency_domain/operator_terms.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <new>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

constexpr int kBlockSize = 256;
constexpr unsigned long long kMaxModalShiftInvertDenseDofs = 64;

struct GpuComplex {
    double real;
    double imag;
};

__host__ __device__ GpuComplex make_complex(double real, double imag)
{
    return GpuComplex{real, imag};
}

__host__ __device__ GpuComplex operator+(GpuComplex a, GpuComplex b)
{
    return make_complex(a.real + b.real, a.imag + b.imag);
}

__host__ __device__ GpuComplex operator-(GpuComplex a, GpuComplex b)
{
    return make_complex(a.real - b.real, a.imag - b.imag);
}

__host__ __device__ GpuComplex operator*(GpuComplex a, GpuComplex b)
{
    return make_complex(
        a.real * b.real - a.imag * b.imag,
        a.real * b.imag + a.imag * b.real);
}

__host__ __device__ GpuComplex operator*(GpuComplex a, double b)
{
    return make_complex(a.real * b, a.imag * b);
}

__host__ __device__ GpuComplex operator/(GpuComplex a, GpuComplex b)
{
    const double denominator = b.real * b.real + b.imag * b.imag;
    return make_complex(
        (a.real * b.real + a.imag * b.imag) / denominator,
        (a.imag * b.real - a.real * b.imag) / denominator);
}

__host__ __device__ double complex_abs2(GpuComplex value)
{
    return value.real * value.real + value.imag * value.imag;
}

__host__ __device__ GpuComplex complex_conj(GpuComplex value)
{
    return make_complex(value.real, -value.imag);
}

__host__ __device__ double complex_abs(GpuComplex value)
{
    return sqrt(complex_abs2(value));
}

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

__global__ void modal_shift_invert_dense_solve_kernel(
    GpuComplex *matrix,
    GpuComplex *rhs,
    GpuComplex *solution,
    unsigned long long total_dof_count,
    int *status)
{
    if (threadIdx.x != 0 || blockIdx.x != 0) {
        return;
    }
    if (total_dof_count == 0 || total_dof_count > kMaxModalShiftInvertDenseDofs) {
        *status = 2;
        return;
    }
    constexpr double kPivotTolerance = 1.0e-300;
    for (unsigned long long column = 0; column < total_dof_count; ++column) {
        unsigned long long pivot_row = column;
        double pivot_norm = complex_abs2(matrix[column * total_dof_count + column]);
        for (unsigned long long row = column + 1; row < total_dof_count; ++row) {
            const double candidate_norm = complex_abs2(matrix[row * total_dof_count + column]);
            if (candidate_norm > pivot_norm) {
                pivot_norm = candidate_norm;
                pivot_row = row;
            }
        }
        if (!(pivot_norm > kPivotTolerance)) {
            *status = 1;
            return;
        }
        if (pivot_row != column) {
            for (unsigned long long col = 0; col < total_dof_count; ++col) {
                const GpuComplex tmp = matrix[column * total_dof_count + col];
                matrix[column * total_dof_count + col] =
                    matrix[pivot_row * total_dof_count + col];
                matrix[pivot_row * total_dof_count + col] = tmp;
            }
            const GpuComplex tmp_rhs = rhs[column];
            rhs[column] = rhs[pivot_row];
            rhs[pivot_row] = tmp_rhs;
        }
        for (unsigned long long row = column + 1; row < total_dof_count; ++row) {
            const GpuComplex factor =
                matrix[row * total_dof_count + column] /
                matrix[column * total_dof_count + column];
            matrix[row * total_dof_count + column] = make_complex(0.0, 0.0);
            for (unsigned long long col = column + 1; col < total_dof_count; ++col) {
                matrix[row * total_dof_count + col] =
                    matrix[row * total_dof_count + col] -
                    factor * matrix[column * total_dof_count + col];
            }
            rhs[row] = rhs[row] - factor * rhs[column];
        }
    }
    for (unsigned long long reverse = 0; reverse < total_dof_count; ++reverse) {
        const unsigned long long row = total_dof_count - 1 - reverse;
        GpuComplex value = rhs[row];
        for (unsigned long long column = row + 1; column < total_dof_count; ++column) {
            value = value - matrix[row * total_dof_count + column] * solution[column];
        }
        solution[row] = value / matrix[row * total_dof_count + row];
    }
    *status = 0;
}

__device__ GpuComplex device_dot_conj_matvec(
    const GpuComplex *matrix,
    const GpuComplex *x,
    const GpuComplex *left,
    unsigned long long total)
{
    GpuComplex result = make_complex(0.0, 0.0);
    for (unsigned long long row = 0; row < total; ++row) {
        GpuComplex y = make_complex(0.0, 0.0);
        for (unsigned long long column = 0; column < total; ++column) {
            y = y + matrix[row * total + column] * x[column];
        }
        result = result + complex_conj(left[row]) * y;
    }
    return result;
}

__device__ double device_matvec_l2_norm(
    const GpuComplex *matrix,
    const GpuComplex *x,
    unsigned long long total)
{
    double sum = 0.0;
    for (unsigned long long row = 0; row < total; ++row) {
        GpuComplex y = make_complex(0.0, 0.0);
        for (unsigned long long column = 0; column < total; ++column) {
            y = y + matrix[row * total + column] * x[column];
        }
        sum += complex_abs2(y);
    }
    return sqrt(sum);
}

__device__ GpuComplex device_csr_row_dot(
    const std::uint32_t *row_offsets,
    const std::uint32_t *column_indices,
    const double *values,
    unsigned long long row,
    const GpuComplex *x,
    unsigned long long x_offset)
{
    GpuComplex result = make_complex(0.0, 0.0);
    for (std::uint32_t entry = row_offsets[row]; entry < row_offsets[row + 1]; ++entry) {
        result = result + x[x_offset + column_indices[entry]] * values[entry];
    }
    return result;
}

__global__ void modal_poisson_airbox_descriptor_apply_kernel(
    unsigned long long nq,
    unsigned long long np,
    const GpuComplex *x,
    GpuComplex *y,
    const std::uint32_t *a_qq_row_offsets,
    const std::uint32_t *a_qq_column_indices,
    const double *a_qq_values,
    const std::uint32_t *a_qphi_row_offsets,
    const std::uint32_t *a_qphi_column_indices,
    const double *a_qphi_values,
    const std::uint32_t *a_phiq_row_offsets,
    const std::uint32_t *a_phiq_column_indices,
    const double *a_phiq_values,
    const std::uint32_t *a_phiphi_row_offsets,
    const std::uint32_t *a_phiphi_column_indices,
    const double *a_phiphi_values,
    const double *phi_mean_weights)
{
    const unsigned long long total = nq + np + 1ull;
    const unsigned long long row =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (row >= total) {
        return;
    }

    GpuComplex value = make_complex(0.0, 0.0);
    if (row < nq) {
        value = value +
            device_csr_row_dot(
                a_qq_row_offsets,
                a_qq_column_indices,
                a_qq_values,
                row,
                x,
                0);
        value = value +
            device_csr_row_dot(
                a_qphi_row_offsets,
                a_qphi_column_indices,
                a_qphi_values,
                row,
                x,
                nq);
    } else if (row < nq + np) {
        const unsigned long long phi_row = row - nq;
        value = value +
            device_csr_row_dot(
                a_phiq_row_offsets,
                a_phiq_column_indices,
                a_phiq_values,
                phi_row,
                x,
                0);
        value = value +
            device_csr_row_dot(
                a_phiphi_row_offsets,
                a_phiphi_column_indices,
                a_phiphi_values,
                phi_row,
                x,
                nq);
        value = value + x[nq + np] * phi_mean_weights[phi_row];
    } else {
        for (unsigned long long phi_row = 0; phi_row < np; ++phi_row) {
            value = value + x[nq + phi_row] * phi_mean_weights[phi_row];
        }
    }
    y[row] = value;
}

__global__ void modal_poisson_airbox_shifted_descriptor_apply_kernel(
    unsigned long long nq,
    unsigned long long np,
    GpuComplex sigma,
    const GpuComplex *x,
    GpuComplex *y,
    const std::uint32_t *a_qq_row_offsets,
    const std::uint32_t *a_qq_column_indices,
    const double *a_qq_values,
    const std::uint32_t *a_qphi_row_offsets,
    const std::uint32_t *a_qphi_column_indices,
    const double *a_qphi_values,
    const std::uint32_t *a_phiq_row_offsets,
    const std::uint32_t *a_phiq_column_indices,
    const double *a_phiq_values,
    const std::uint32_t *a_phiphi_row_offsets,
    const std::uint32_t *a_phiphi_column_indices,
    const double *a_phiphi_values,
    const std::uint32_t *b_qq_row_offsets,
    const std::uint32_t *b_qq_column_indices,
    const double *b_qq_values,
    const double *phi_mean_weights)
{
    const unsigned long long total = nq + np + 1ull;
    const unsigned long long row =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (row >= total) {
        return;
    }

    GpuComplex value = make_complex(0.0, 0.0);
    if (row < nq) {
        value = value +
            device_csr_row_dot(
                a_qq_row_offsets,
                a_qq_column_indices,
                a_qq_values,
                row,
                x,
                0);
        value = value +
            device_csr_row_dot(
                a_qphi_row_offsets,
                a_qphi_column_indices,
                a_qphi_values,
                row,
                x,
                nq);
        const GpuComplex bx =
            device_csr_row_dot(
                b_qq_row_offsets,
                b_qq_column_indices,
                b_qq_values,
                row,
                x,
                0);
        value = value - sigma * bx;
    } else if (row < nq + np) {
        const unsigned long long phi_row = row - nq;
        value = value +
            device_csr_row_dot(
                a_phiq_row_offsets,
                a_phiq_column_indices,
                a_phiq_values,
                phi_row,
                x,
                0);
        value = value +
            device_csr_row_dot(
                a_phiphi_row_offsets,
                a_phiphi_column_indices,
                a_phiphi_values,
                phi_row,
                x,
                nq);
        value = value + x[nq + np] * phi_mean_weights[phi_row];
    } else {
        for (unsigned long long phi_row = 0; phi_row < np; ++phi_row) {
            value = value + x[nq + phi_row] * phi_mean_weights[phi_row];
        }
    }
    y[row] = value;
}

__global__ void modal_poisson_airbox_dense_eigensolver_kernel(
    const GpuComplex *a_matrix,
    const GpuComplex *b_matrix,
    const GpuComplex *shifted_matrix,
    unsigned long long total_dof_count,
    unsigned long long q_dof_count,
    unsigned int max_iterations,
    GpuComplex *out_x,
    double *out_lambda_real,
    double *out_lambda_imag,
    double *out_frequency_hz,
    double *out_relative_residual,
    int *status)
{
    if (threadIdx.x != 0 || blockIdx.x != 0) {
        return;
    }
    if (total_dof_count == 0 ||
        total_dof_count > kMaxModalShiftInvertDenseDofs ||
        q_dof_count == 0 ||
        q_dof_count > total_dof_count ||
        max_iterations == 0) {
        *status = 2;
        return;
    }

    constexpr double kPivotTolerance = 1.0e-300;
    constexpr double kTwoPiDevice = 6.283185307179586476925286766559;
    GpuComplex q[kMaxModalShiftInvertDenseDofs]{};
    GpuComplex rhs[kMaxModalShiftInvertDenseDofs]{};
    GpuComplex solution[kMaxModalShiftInvertDenseDofs]{};
    GpuComplex work[kMaxModalShiftInvertDenseDofs * kMaxModalShiftInvertDenseDofs]{};

    q[0] = make_complex(1.0, 0.25);
    if (q_dof_count > 1) {
        q[1] = make_complex(-0.5, 0.75);
    }
    double q_norm2 = 0.0;
    for (unsigned long long row = 0; row < q_dof_count; ++row) {
        q_norm2 += complex_abs2(q[row]);
    }
    const double inv_initial_norm = 1.0 / sqrt(q_norm2);
    for (unsigned long long row = 0; row < q_dof_count; ++row) {
        q[row] = q[row] * inv_initial_norm;
    }

    for (unsigned int iteration = 0; iteration < max_iterations; ++iteration) {
        for (unsigned long long index = 0; index < total_dof_count; ++index) {
            rhs[index] = make_complex(0.0, 0.0);
            solution[index] = make_complex(0.0, 0.0);
        }
        for (unsigned long long row = 0; row < total_dof_count; ++row) {
            GpuComplex value = make_complex(0.0, 0.0);
            for (unsigned long long column = 0; column < q_dof_count; ++column) {
                value = value + b_matrix[row * total_dof_count + column] * q[column];
            }
            rhs[row] = value;
        }
        for (unsigned long long index = 0; index < total_dof_count * total_dof_count; ++index) {
            work[index] = shifted_matrix[index];
        }

        for (unsigned long long column = 0; column < total_dof_count; ++column) {
            unsigned long long pivot_row = column;
            double pivot_norm = complex_abs2(work[column * total_dof_count + column]);
            for (unsigned long long row = column + 1; row < total_dof_count; ++row) {
                const double candidate_norm =
                    complex_abs2(work[row * total_dof_count + column]);
                if (candidate_norm > pivot_norm) {
                    pivot_norm = candidate_norm;
                    pivot_row = row;
                }
            }
            if (!(pivot_norm > kPivotTolerance)) {
                *status = 1;
                return;
            }
            if (pivot_row != column) {
                for (unsigned long long col = 0; col < total_dof_count; ++col) {
                    const GpuComplex tmp = work[column * total_dof_count + col];
                    work[column * total_dof_count + col] =
                        work[pivot_row * total_dof_count + col];
                    work[pivot_row * total_dof_count + col] = tmp;
                }
                const GpuComplex tmp_rhs = rhs[column];
                rhs[column] = rhs[pivot_row];
                rhs[pivot_row] = tmp_rhs;
            }
            for (unsigned long long row = column + 1; row < total_dof_count; ++row) {
                const GpuComplex factor =
                    work[row * total_dof_count + column] /
                    work[column * total_dof_count + column];
                work[row * total_dof_count + column] = make_complex(0.0, 0.0);
                for (unsigned long long col = column + 1; col < total_dof_count; ++col) {
                    work[row * total_dof_count + col] =
                        work[row * total_dof_count + col] -
                        factor * work[column * total_dof_count + col];
                }
                rhs[row] = rhs[row] - factor * rhs[column];
            }
        }
        for (unsigned long long reverse = 0; reverse < total_dof_count; ++reverse) {
            const unsigned long long row = total_dof_count - 1 - reverse;
            GpuComplex value = rhs[row];
            for (unsigned long long column = row + 1; column < total_dof_count; ++column) {
                value = value - work[row * total_dof_count + column] * solution[column];
            }
            solution[row] = value / work[row * total_dof_count + row];
        }

        double solution_q_norm2 = 0.0;
        for (unsigned long long row = 0; row < q_dof_count; ++row) {
            solution_q_norm2 += complex_abs2(solution[row]);
        }
        if (!(solution_q_norm2 > 0.0)) {
            *status = 3;
            return;
        }
        const double inv_q_norm = 1.0 / sqrt(solution_q_norm2);
        for (unsigned long long row = 0; row < total_dof_count; ++row) {
            solution[row] = solution[row] * inv_q_norm;
        }
        for (unsigned long long row = 0; row < q_dof_count; ++row) {
            q[row] = solution[row];
        }
    }

    const GpuComplex numerator =
        device_dot_conj_matvec(a_matrix, solution, solution, total_dof_count);
    const GpuComplex denominator =
        device_dot_conj_matvec(b_matrix, solution, solution, total_dof_count);
    if (!(complex_abs2(denominator) > kPivotTolerance)) {
        *status = 4;
        return;
    }
    const GpuComplex lambda = numerator / denominator;
    double residual_sum = 0.0;
    for (unsigned long long row = 0; row < total_dof_count; ++row) {
        GpuComplex ax = make_complex(0.0, 0.0);
        GpuComplex bx = make_complex(0.0, 0.0);
        for (unsigned long long column = 0; column < total_dof_count; ++column) {
            ax = ax + a_matrix[row * total_dof_count + column] * solution[column];
            bx = bx + b_matrix[row * total_dof_count + column] * solution[column];
        }
        const GpuComplex r = ax - lambda * bx;
        residual_sum += complex_abs2(r);
    }
    const double ax_norm = device_matvec_l2_norm(a_matrix, solution, total_dof_count);
    const double bx_norm = device_matvec_l2_norm(b_matrix, solution, total_dof_count);
    const double relative_residual =
        sqrt(residual_sum) /
        (ax_norm + complex_abs(lambda) * bx_norm + 1.0e-300);

    for (unsigned long long row = 0; row < total_dof_count; ++row) {
        out_x[row] = solution[row];
    }
    *out_lambda_real = lambda.real;
    *out_lambda_imag = lambda.imag;
    *out_frequency_hz = lambda.imag / kTwoPiDevice;
    *out_relative_residual = relative_residual;
    *status = 0;
}

__global__ void exchange_kernel(
    const fd::TangentFrameNode *nodes,
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
    const unsigned long long i0 = edge.node_i * 2;
    const unsigned long long j0 = edge.node_j * 2;
    const double qi0 = tangent_in[i0];
    const double qi1 = tangent_in[i0 + 1];
    const double qj0 = tangent_in[j0];
    const double qj1 = tangent_in[j0 + 1];
    const fd::TangentFrameNode node_i = nodes[edge.node_i];
    const fd::TangentFrameNode node_j = nodes[edge.node_j];
    const double r00 = dot3_device(node_i.e1, node_j.e1);
    const double r01 = dot3_device(node_i.e1, node_j.e2);
    const double r10 = dot3_device(node_i.e2, node_j.e1);
    const double r11 = dot3_device(node_i.e2, node_j.e2);
    const double ti_from_j0 = r00 * qj0 + r01 * qj1;
    const double ti_from_j1 = r10 * qj0 + r11 * qj1;
    const double tj_from_i0 = r00 * qi0 + r10 * qi1;
    const double tj_from_i1 = r01 * qi0 + r11 * qi1;
    frequency_domain_atomic_add_double(
        &effective_tangent[i0],
        edge.stiffness * (qi0 - ti_from_j0));
    frequency_domain_atomic_add_double(
        &effective_tangent[i0 + 1],
        edge.stiffness * (qi1 - ti_from_j1));
    frequency_domain_atomic_add_double(
        &effective_tangent[j0],
        edge.stiffness * (qj0 - tj_from_i0));
    frequency_domain_atomic_add_double(
        &effective_tangent[j0 + 1],
        edge.stiffness * (qj1 - tj_from_i1));
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

bool csr_shape_valid(const fd::CsrMatrixView &matrix, unsigned long long rows, unsigned long long columns)
{
    return matrix.row_count == rows &&
        matrix.column_count == columns &&
        matrix.row_offsets != nullptr &&
        matrix.row_offsets_len == rows + 1 &&
        matrix.column_indices != nullptr &&
        matrix.values != nullptr &&
        matrix.column_indices_len == matrix.values_len;
}

bool modal_shift_problem_valid(const fd::PoissonAirboxEigenBlockProblem &problem)
{
    const unsigned long long nq = problem.q_dof_count;
    const unsigned long long np = problem.phi_dof_count;
    return nq > 0 &&
        np > 0 &&
        nq + np + 1 <= kMaxModalShiftInvertDenseDofs &&
        csr_shape_valid(problem.A_qq, nq, nq) &&
        csr_shape_valid(problem.A_qphi, nq, np) &&
        csr_shape_valid(problem.A_phiq, np, nq) &&
        csr_shape_valid(problem.A_phiphi, np, np) &&
        csr_shape_valid(problem.B_qq, nq, nq) &&
        problem.phi_mean_weights != nullptr &&
        problem.phi_mean_weights_count == np;
}

void add_csr_to_modal_dense(
    const fd::CsrMatrixView &matrix,
    unsigned long long row_offset,
    unsigned long long column_offset,
    std::vector<GpuComplex> &dense,
    unsigned long long total)
{
    for (unsigned long long row = 0; row < matrix.row_count; ++row) {
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1];
             ++entry) {
            dense[(row_offset + row) * total + column_offset + matrix.column_indices[entry]].real +=
                matrix.values[entry];
        }
    }
}

std::vector<GpuComplex> modal_dense_matvec(
    const std::vector<GpuComplex> &matrix,
    unsigned long long total,
    const std::vector<GpuComplex> &x)
{
    std::vector<GpuComplex> y(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    for (unsigned long long row = 0; row < total; ++row) {
        GpuComplex value = make_complex(0.0, 0.0);
        for (unsigned long long column = 0; column < total; ++column) {
            value = value + matrix[row * total + column] * x[column];
        }
        y[row] = value;
    }
    return y;
}

double modal_complex_l2_norm(const std::vector<GpuComplex> &values)
{
    double sum = 0.0;
    for (const GpuComplex value : values) {
        sum += complex_abs2(value);
    }
    return std::sqrt(sum);
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
    std::size_t byte_count = 0;
    const fd::CheckedExtentStatus extent_status = fd::checked_bytes_limited(
        count,
        sizeof(T),
        fd::kMaxFrequencyDomainWorkspaceBytes,
        byte_count);
    if (extent_status != fd::CheckedExtentStatus::ok) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                extent_status == fd::CheckedExtentStatus::arithmetic_overflow ?
                    "frequency-domain %s byte count overflows" :
                    "frequency-domain %s exceeds configured workspace limit",
                name);
        }
        return false;
    }
    if (!cuda_success(cudaMalloc(device_ptr, byte_count), "cudaMalloc frequency-domain buffer", error_message, error_message_len)) {
        return false;
    }
    return cuda_success(
        cudaMemcpy(*device_ptr, host_ptr, byte_count, cudaMemcpyHostToDevice),
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
    std::size_t byte_count = 0;
    const fd::CheckedExtentStatus extent_status = fd::checked_bytes_limited(
        count,
        sizeof(T),
        fd::kMaxFrequencyDomainWorkspaceBytes,
        byte_count);
    if (extent_status != fd::CheckedExtentStatus::ok) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                extent_status == fd::CheckedExtentStatus::arithmetic_overflow ?
                    "%s byte count overflows" :
                    "%s exceeds configured workspace limit",
                name);
        }
        return false;
    }
    if (!cuda_success(cudaMalloc(device_ptr, byte_count), name, error_message, error_message_len)) {
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
    std::uint64_t expected_tangent_dof_count = 0;
    std::size_t tangent_bytes = 0;
    std::uint32_t dof_blocks = 0;
    std::uint32_t node_blocks = 0;
    std::uint32_t edge_blocks = 0;
    const bool extents_valid =
        fd::checked_mul_u64(node_count, 2, expected_tangent_dof_count) &&
        fd::checked_bytes_limited(
            tangent_dof_count,
            sizeof(double),
            fd::kMaxFrequencyDomainWorkspaceBytes,
            tangent_bytes) == fd::CheckedExtentStatus::ok &&
        fd::checked_cuda_grid_u32(
            tangent_dof_count,
            kBlockSize,
            fd::kMaxFrequencyDomainCudaGridBlocks,
            dof_blocks) == fd::CheckedExtentStatus::ok &&
        fd::checked_cuda_grid_u32(
            node_count,
            kBlockSize,
            fd::kMaxFrequencyDomainCudaGridBlocks,
            node_blocks) == fd::CheckedExtentStatus::ok &&
        (!exchange_enabled ||
         fd::checked_cuda_grid_u32(
             exchange_edge_count,
             kBlockSize,
             fd::kMaxFrequencyDomainCudaGridBlocks,
             edge_blocks) == fd::CheckedExtentStatus::ok);
    if (node_count == 0 ||
        !extents_valid ||
        tangent_dof_count != expected_tangent_dof_count ||
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
        allocate_device_buffer(&d_effective, tangent_dof_count, "cudaMalloc effective tangent", error_message, error_message_len) &&
        allocate_device_buffer(&d_stiffness, tangent_dof_count, "cudaMalloc stiffness tangent", error_message, error_message_len) &&
        allocate_device_buffer(&d_mass, tangent_dof_count, "cudaMalloc mass tangent", error_message, error_message_len);

    if (ok) {
        zero_tangent_kernel<<<dof_blocks, kBlockSize>>>(d_effective, tangent_dof_count);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain zero tangent", error_message, error_message_len);
    }
    if (ok && exchange_enabled) {
        exchange_kernel<<<edge_blocks, kBlockSize>>>(
            d_nodes,
            d_edges,
            exchange_edge_count,
            d_tangent_in,
            d_effective);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain exchange operator", error_message, error_message_len);
    }
    if (ok) {
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
                cudaMemcpy(out_stiffness, d_stiffness, tangent_bytes, cudaMemcpyDeviceToHost),
                "cudaMemcpy frequency-domain stiffness device-to-host",
                error_message,
                error_message_len) &&
            cuda_success(
                cudaMemcpy(out_mass, d_mass, tangent_bytes, cudaMemcpyDeviceToHost),
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
    std::uint64_t expected_tangent_dof_count = 0;
    std::uint64_t dmi_full_dof_count = 0;
    std::size_t node_bytes = 0;
    std::size_t tangent_bytes = 0;
    std::size_t exchange_bytes = 0;
    std::size_t dmi_element_bytes = 0;
    std::size_t dmi_node_bytes = 0;
    const bool extents_valid =
        fd::checked_mul_u64(node_count, 2, expected_tangent_dof_count) &&
        fd::checked_bytes_limited(
            node_count,
            sizeof(fd::TangentFrameNode),
            fd::kMaxFrequencyDomainWorkspaceBytes,
            node_bytes) == fd::CheckedExtentStatus::ok &&
        fd::checked_bytes_limited(
            tangent_dof_count,
            sizeof(double),
            fd::kMaxFrequencyDomainWorkspaceBytes,
            tangent_bytes) == fd::CheckedExtentStatus::ok &&
        (!exchange_enabled ||
         fd::checked_bytes_limited(
             exchange_edge_count,
             sizeof(fd::TangentOperatorEdgeBlock),
             fd::kMaxFrequencyDomainWorkspaceBytes,
             exchange_bytes) == fd::CheckedExtentStatus::ok) &&
        (!dmi_enabled ||
         (fd::checked_mul_u64(node_count, 3, dmi_full_dof_count) &&
          fd::checked_bytes_limited(
              dmi_element_count,
              sizeof(fd::MfemDmiElementTangentData),
              fd::kMaxFrequencyDomainWorkspaceBytes,
              dmi_element_bytes) == fd::CheckedExtentStatus::ok &&
          fd::checked_bytes_limited(
              node_count,
              sizeof(double),
              fd::kMaxFrequencyDomainWorkspaceBytes,
              dmi_node_bytes) == fd::CheckedExtentStatus::ok));
    if (node_count == 0 ||
        !extents_valid ||
        tangent_dof_count != expected_tangent_dof_count ||
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
        allocate_device_buffer(&context->d_dmi_delta_xyz, dmi_enabled ? dmi_full_dof_count : 0, "cudaMalloc frequency-domain DMI delta", error_message, error_message_len) &&
        allocate_device_buffer(&context->d_dmi_residual_xyz, dmi_enabled ? dmi_full_dof_count : 0, "cudaMalloc frequency-domain DMI residual", error_message, error_message_len);
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

    std::size_t tangent_bytes = 0;
    std::uint64_t full_dof_count = 0;
    std::uint32_t dof_blocks = 0;
    std::uint32_t node_blocks = 0;
    std::uint32_t edge_blocks = 0;
    std::uint32_t full_dof_blocks = 0;
    std::uint32_t element_blocks = 0;
    const bool extents_valid =
        fd::checked_bytes_limited(
            context->tangent_dof_count,
            sizeof(double),
            fd::kMaxFrequencyDomainWorkspaceBytes,
            tangent_bytes) == fd::CheckedExtentStatus::ok &&
        fd::checked_cuda_grid_u32(
            context->tangent_dof_count,
            kBlockSize,
            fd::kMaxFrequencyDomainCudaGridBlocks,
            dof_blocks) == fd::CheckedExtentStatus::ok &&
        fd::checked_cuda_grid_u32(
            context->node_count,
            kBlockSize,
            fd::kMaxFrequencyDomainCudaGridBlocks,
            node_blocks) == fd::CheckedExtentStatus::ok &&
        (!context->exchange_enabled ||
         fd::checked_cuda_grid_u32(
             context->exchange_edge_count,
             kBlockSize,
             fd::kMaxFrequencyDomainCudaGridBlocks,
             edge_blocks) == fd::CheckedExtentStatus::ok) &&
        (!context->dmi_enabled ||
         (fd::checked_mul_u64(context->node_count, 3, full_dof_count) &&
          fd::checked_cuda_grid_u32(
              full_dof_count,
              kBlockSize,
              fd::kMaxFrequencyDomainCudaGridBlocks,
              full_dof_blocks) == fd::CheckedExtentStatus::ok &&
          fd::checked_cuda_grid_u32(
              context->dmi_element_count,
              kBlockSize,
              fd::kMaxFrequencyDomainCudaGridBlocks,
              element_blocks) == fd::CheckedExtentStatus::ok));
    if (!extents_valid) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "production GPU frequency-domain context extent is invalid");
        }
        return 1;
    }

    bool ok = cuda_success(
        cudaMemcpy(
            context->d_tangent_in,
            tangent_in,
            tangent_bytes,
            cudaMemcpyHostToDevice),
        "cudaMemcpy frequency-domain tangent input host-to-device",
        error_message,
        error_message_len);
    if (ok && demag_tangent != nullptr) {
        ok = cuda_success(
            cudaMemcpy(
                context->d_demag_tangent,
                demag_tangent,
                tangent_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy frequency-domain demag tangent host-to-device",
            error_message,
            error_message_len);
    }
    if (ok) {
        zero_tangent_kernel<<<dof_blocks, kBlockSize>>>(context->d_effective, context->tangent_dof_count);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain zero tangent", error_message, error_message_len);
    }
    if (ok && context->exchange_enabled) {
        exchange_kernel<<<edge_blocks, kBlockSize>>>(
            context->d_nodes,
            context->d_edges,
            context->exchange_edge_count,
            context->d_tangent_in,
            context->d_effective);
        ok = cuda_success(cudaGetLastError(), "launch frequency-domain exchange operator", error_message, error_message_len);
    }
    if (ok && context->dmi_enabled) {
        zero_tangent_kernel<<<full_dof_blocks, kBlockSize>>>(
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
                cudaMemcpy(out_stiffness, context->d_stiffness, tangent_bytes, cudaMemcpyDeviceToHost),
                "cudaMemcpy frequency-domain stiffness device-to-host",
                error_message,
                error_message_len) &&
            cuda_success(
                cudaMemcpy(out_mass, context->d_mass, tangent_bytes, cudaMemcpyDeviceToHost),
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

extern "C" int fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_descriptor(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    const double *x_real,
    const double *x_imag,
    unsigned long long x_count,
    double *out_y_real,
    double *out_y_imag,
    unsigned long long out_y_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len)
{
    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        diagnostics_json[0] = '\0';
    }
    if (problem == nullptr ||
        !modal_shift_problem_valid(*problem) ||
        x_real == nullptr ||
        out_y_real == nullptr ||
        out_y_imag == nullptr) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid GPU-G5b modal Poisson-airbox descriptor apply inputs");
        }
        return 1;
    }

    const unsigned long long nq = problem->q_dof_count;
    const unsigned long long np = problem->phi_dof_count;
    const unsigned long long total = nq + np + 1ull;
    if (x_count != total || out_y_count != total) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "GPU-G5b descriptor apply requires full augmented vector length");
        }
        return 1;
    }

    std::vector<GpuComplex> x(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    for (unsigned long long index = 0; index < total; ++index) {
        const double real = x_real[index];
        const double imag = x_imag == nullptr ? 0.0 : x_imag[index];
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            if (error_message != nullptr && error_message_len > 0) {
                std::snprintf(
                    error_message,
                    static_cast<std::size_t>(error_message_len),
                    "GPU-G5b descriptor apply input vector must be finite");
            }
            return 1;
        }
        x[index] = make_complex(real, imag);
    }

    GpuComplex *d_x = nullptr;
    GpuComplex *d_y = nullptr;
    std::uint32_t *d_a_qq_rows = nullptr;
    std::uint32_t *d_a_qq_columns = nullptr;
    double *d_a_qq_values = nullptr;
    std::uint32_t *d_a_qphi_rows = nullptr;
    std::uint32_t *d_a_qphi_columns = nullptr;
    double *d_a_qphi_values = nullptr;
    std::uint32_t *d_a_phiq_rows = nullptr;
    std::uint32_t *d_a_phiq_columns = nullptr;
    double *d_a_phiq_values = nullptr;
    std::uint32_t *d_a_phiphi_rows = nullptr;
    std::uint32_t *d_a_phiphi_columns = nullptr;
    double *d_a_phiphi_values = nullptr;
    double *d_phi_mean_weights = nullptr;

    bool ok =
        allocate_and_copy(&d_x, x.data(), total, "GPU-G5b descriptor input", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_y, sizeof(GpuComplex) * total), "cudaMalloc GPU-G5b descriptor output", error_message, error_message_len) &&
        cuda_success(cudaMemset(d_y, 0, sizeof(GpuComplex) * total), "cudaMemset GPU-G5b descriptor output", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qq_rows, problem->A_qq.row_offsets, problem->A_qq.row_offsets_len, "GPU-G5b A_qq row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qq_columns, problem->A_qq.column_indices, problem->A_qq.column_indices_len, "GPU-G5b A_qq columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qq_values, problem->A_qq.values, problem->A_qq.values_len, "GPU-G5b A_qq values", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qphi_rows, problem->A_qphi.row_offsets, problem->A_qphi.row_offsets_len, "GPU-G5b A_qphi row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qphi_columns, problem->A_qphi.column_indices, problem->A_qphi.column_indices_len, "GPU-G5b A_qphi columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qphi_values, problem->A_qphi.values, problem->A_qphi.values_len, "GPU-G5b A_qphi values", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiq_rows, problem->A_phiq.row_offsets, problem->A_phiq.row_offsets_len, "GPU-G5b A_phiq row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiq_columns, problem->A_phiq.column_indices, problem->A_phiq.column_indices_len, "GPU-G5b A_phiq columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiq_values, problem->A_phiq.values, problem->A_phiq.values_len, "GPU-G5b A_phiq values", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiphi_rows, problem->A_phiphi.row_offsets, problem->A_phiphi.row_offsets_len, "GPU-G5b A_phiphi row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiphi_columns, problem->A_phiphi.column_indices, problem->A_phiphi.column_indices_len, "GPU-G5b A_phiphi columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiphi_values, problem->A_phiphi.values, problem->A_phiphi.values_len, "GPU-G5b A_phiphi values", error_message, error_message_len) &&
        allocate_and_copy(&d_phi_mean_weights, problem->phi_mean_weights, problem->phi_mean_weights_count, "GPU-G5b phi mean weights", error_message, error_message_len);

    if (ok) {
        const unsigned int blocks =
            static_cast<unsigned int>((total + kBlockSize - 1ull) / kBlockSize);
        modal_poisson_airbox_descriptor_apply_kernel<<<blocks, kBlockSize>>>(
            nq,
            np,
            d_x,
            d_y,
            d_a_qq_rows,
            d_a_qq_columns,
            d_a_qq_values,
            d_a_qphi_rows,
            d_a_qphi_columns,
            d_a_qphi_values,
            d_a_phiq_rows,
            d_a_phiq_columns,
            d_a_phiq_values,
            d_a_phiphi_rows,
            d_a_phiphi_columns,
            d_a_phiphi_values,
            d_phi_mean_weights);
        ok = cuda_success(cudaGetLastError(), "launch GPU-G5b descriptor apply", error_message, error_message_len) &&
            cuda_success(cudaDeviceSynchronize(), "synchronize GPU-G5b descriptor apply", error_message, error_message_len);
    }

    std::vector<GpuComplex> y(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    if (ok) {
        ok = cuda_success(
            cudaMemcpy(y.data(), d_y, sizeof(GpuComplex) * total, cudaMemcpyDeviceToHost),
            "cudaMemcpy GPU-G5b descriptor output D2H",
            error_message,
            error_message_len);
    }

    cudaFree(d_x);
    cudaFree(d_y);
    cudaFree(d_a_qq_rows);
    cudaFree(d_a_qq_columns);
    cudaFree(d_a_qq_values);
    cudaFree(d_a_qphi_rows);
    cudaFree(d_a_qphi_columns);
    cudaFree(d_a_qphi_values);
    cudaFree(d_a_phiq_rows);
    cudaFree(d_a_phiq_columns);
    cudaFree(d_a_phiq_values);
    cudaFree(d_a_phiphi_rows);
    cudaFree(d_a_phiphi_columns);
    cudaFree(d_a_phiphi_values);
    cudaFree(d_phi_mean_weights);

    if (!ok) {
        return 1;
    }

    for (unsigned long long index = 0; index < total; ++index) {
        out_y_real[index] = y[index].real;
        out_y_imag[index] = y[index].imag;
    }
    const double input_norm = modal_complex_l2_norm(x);
    const double output_norm = modal_complex_l2_norm(y);

    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        std::snprintf(
            diagnostics_json,
            static_cast<std::size_t>(diagnostics_json_len),
            "{"
            "\"schema_version\":\"gpu_modal_poisson_airbox_descriptor_apply.v1\","
            "\"status\":\"ok\","
            "\"study_product\":\"modal_eigen\","
            "\"lane\":\"gpu_poisson_airbox_k0\","
            "\"execution_lane\":\"gpu_device_modal_descriptor_apply_contract\","
            "\"solver_family\":\"modal_eigen\","
            "\"operator_family\":\"full_coupled_poisson_airbox_modal_pencil\","
            "\"algebraic_action\":\"A*x\","
            "\"matrix_format\":\"csr_device_apply\","
            "\"demag_kind\":\"%s\","
            "\"gauge_policy\":\"%s\","
            "\"phasor_convention\":\"%s\","
            "\"eigenvalue_convention\":\"%s\","
            "\"frequency_response_proxy\":false,"
            "\"gpu_device_resident_operator_apply\":true,"
            "\"cpu_fallback\":\"disabled\","
            "\"fallback_used\":false,"
            "\"setup_h2d_count\":14,"
            "\"result_d2h_count\":1,"
            "\"per_iteration_h2d_count\":0,"
            "\"per_iteration_d2h_count\":0,"
            "\"q_dof_count\":%llu,"
            "\"phi_dof_count\":%llu,"
            "\"augmented_dof_count\":%llu,"
            "\"metrics\":{"
            "\"input_l2_norm\":%.17g,"
            "\"output_l2_norm\":%.17g"
            "}"
            "}",
            problem->demag_kind != nullptr ? problem->demag_kind : "",
            problem->gauge_policy != nullptr ? problem->gauge_policy : "",
            problem->phasor_convention != nullptr ? problem->phasor_convention : "",
            problem->eigenvalue_convention != nullptr ? problem->eigenvalue_convention : "",
            static_cast<unsigned long long>(nq),
            static_cast<unsigned long long>(np),
            static_cast<unsigned long long>(total),
            input_norm,
            output_norm);
    }
    return 0;
}

extern "C" int fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_shifted_descriptor(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    const double *x_real,
    const double *x_imag,
    unsigned long long x_count,
    double *out_y_real,
    double *out_y_imag,
    unsigned long long out_y_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len)
{
    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        diagnostics_json[0] = '\0';
    }
    if (problem == nullptr ||
        !modal_shift_problem_valid(*problem) ||
        x_real == nullptr ||
        out_y_real == nullptr ||
        out_y_imag == nullptr ||
        !std::isfinite(sigma_real) ||
        !std::isfinite(sigma_imag)) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid GPU-G5c modal Poisson-airbox shifted descriptor apply inputs");
        }
        return 1;
    }

    const unsigned long long nq = problem->q_dof_count;
    const unsigned long long np = problem->phi_dof_count;
    const unsigned long long total = nq + np + 1ull;
    if (x_count != total || out_y_count != total) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "GPU-G5c shifted descriptor apply requires full augmented vector length");
        }
        return 1;
    }

    std::vector<GpuComplex> x(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    for (unsigned long long index = 0; index < total; ++index) {
        const double real = x_real[index];
        const double imag = x_imag == nullptr ? 0.0 : x_imag[index];
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            if (error_message != nullptr && error_message_len > 0) {
                std::snprintf(
                    error_message,
                    static_cast<std::size_t>(error_message_len),
                    "GPU-G5c shifted descriptor apply input vector must be finite");
            }
            return 1;
        }
        x[index] = make_complex(real, imag);
    }

    GpuComplex *d_x = nullptr;
    GpuComplex *d_y = nullptr;
    std::uint32_t *d_a_qq_rows = nullptr;
    std::uint32_t *d_a_qq_columns = nullptr;
    double *d_a_qq_values = nullptr;
    std::uint32_t *d_a_qphi_rows = nullptr;
    std::uint32_t *d_a_qphi_columns = nullptr;
    double *d_a_qphi_values = nullptr;
    std::uint32_t *d_a_phiq_rows = nullptr;
    std::uint32_t *d_a_phiq_columns = nullptr;
    double *d_a_phiq_values = nullptr;
    std::uint32_t *d_a_phiphi_rows = nullptr;
    std::uint32_t *d_a_phiphi_columns = nullptr;
    double *d_a_phiphi_values = nullptr;
    std::uint32_t *d_b_qq_rows = nullptr;
    std::uint32_t *d_b_qq_columns = nullptr;
    double *d_b_qq_values = nullptr;
    double *d_phi_mean_weights = nullptr;

    bool ok =
        allocate_and_copy(&d_x, x.data(), total, "GPU-G5c shifted descriptor input", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_y, sizeof(GpuComplex) * total), "cudaMalloc GPU-G5c shifted descriptor output", error_message, error_message_len) &&
        cuda_success(cudaMemset(d_y, 0, sizeof(GpuComplex) * total), "cudaMemset GPU-G5c shifted descriptor output", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qq_rows, problem->A_qq.row_offsets, problem->A_qq.row_offsets_len, "GPU-G5c A_qq row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qq_columns, problem->A_qq.column_indices, problem->A_qq.column_indices_len, "GPU-G5c A_qq columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qq_values, problem->A_qq.values, problem->A_qq.values_len, "GPU-G5c A_qq values", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qphi_rows, problem->A_qphi.row_offsets, problem->A_qphi.row_offsets_len, "GPU-G5c A_qphi row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qphi_columns, problem->A_qphi.column_indices, problem->A_qphi.column_indices_len, "GPU-G5c A_qphi columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_qphi_values, problem->A_qphi.values, problem->A_qphi.values_len, "GPU-G5c A_qphi values", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiq_rows, problem->A_phiq.row_offsets, problem->A_phiq.row_offsets_len, "GPU-G5c A_phiq row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiq_columns, problem->A_phiq.column_indices, problem->A_phiq.column_indices_len, "GPU-G5c A_phiq columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiq_values, problem->A_phiq.values, problem->A_phiq.values_len, "GPU-G5c A_phiq values", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiphi_rows, problem->A_phiphi.row_offsets, problem->A_phiphi.row_offsets_len, "GPU-G5c A_phiphi row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiphi_columns, problem->A_phiphi.column_indices, problem->A_phiphi.column_indices_len, "GPU-G5c A_phiphi columns", error_message, error_message_len) &&
        allocate_and_copy(&d_a_phiphi_values, problem->A_phiphi.values, problem->A_phiphi.values_len, "GPU-G5c A_phiphi values", error_message, error_message_len) &&
        allocate_and_copy(&d_b_qq_rows, problem->B_qq.row_offsets, problem->B_qq.row_offsets_len, "GPU-G5c B_qq row offsets", error_message, error_message_len) &&
        allocate_and_copy(&d_b_qq_columns, problem->B_qq.column_indices, problem->B_qq.column_indices_len, "GPU-G5c B_qq columns", error_message, error_message_len) &&
        allocate_and_copy(&d_b_qq_values, problem->B_qq.values, problem->B_qq.values_len, "GPU-G5c B_qq values", error_message, error_message_len) &&
        allocate_and_copy(&d_phi_mean_weights, problem->phi_mean_weights, problem->phi_mean_weights_count, "GPU-G5c phi mean weights", error_message, error_message_len);

    if (ok) {
        const unsigned int blocks =
            static_cast<unsigned int>((total + kBlockSize - 1ull) / kBlockSize);
        modal_poisson_airbox_shifted_descriptor_apply_kernel<<<blocks, kBlockSize>>>(
            nq,
            np,
            make_complex(sigma_real, sigma_imag),
            d_x,
            d_y,
            d_a_qq_rows,
            d_a_qq_columns,
            d_a_qq_values,
            d_a_qphi_rows,
            d_a_qphi_columns,
            d_a_qphi_values,
            d_a_phiq_rows,
            d_a_phiq_columns,
            d_a_phiq_values,
            d_a_phiphi_rows,
            d_a_phiphi_columns,
            d_a_phiphi_values,
            d_b_qq_rows,
            d_b_qq_columns,
            d_b_qq_values,
            d_phi_mean_weights);
        ok = cuda_success(cudaGetLastError(), "launch GPU-G5c shifted descriptor apply", error_message, error_message_len) &&
            cuda_success(cudaDeviceSynchronize(), "synchronize GPU-G5c shifted descriptor apply", error_message, error_message_len);
    }

    std::vector<GpuComplex> y(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    if (ok) {
        ok = cuda_success(
            cudaMemcpy(y.data(), d_y, sizeof(GpuComplex) * total, cudaMemcpyDeviceToHost),
            "cudaMemcpy GPU-G5c shifted descriptor output D2H",
            error_message,
            error_message_len);
    }

    cudaFree(d_x);
    cudaFree(d_y);
    cudaFree(d_a_qq_rows);
    cudaFree(d_a_qq_columns);
    cudaFree(d_a_qq_values);
    cudaFree(d_a_qphi_rows);
    cudaFree(d_a_qphi_columns);
    cudaFree(d_a_qphi_values);
    cudaFree(d_a_phiq_rows);
    cudaFree(d_a_phiq_columns);
    cudaFree(d_a_phiq_values);
    cudaFree(d_a_phiphi_rows);
    cudaFree(d_a_phiphi_columns);
    cudaFree(d_a_phiphi_values);
    cudaFree(d_b_qq_rows);
    cudaFree(d_b_qq_columns);
    cudaFree(d_b_qq_values);
    cudaFree(d_phi_mean_weights);

    if (!ok) {
        return 1;
    }

    for (unsigned long long index = 0; index < total; ++index) {
        out_y_real[index] = y[index].real;
        out_y_imag[index] = y[index].imag;
    }
    const double input_norm = modal_complex_l2_norm(x);
    const double output_norm = modal_complex_l2_norm(y);

    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        std::snprintf(
            diagnostics_json,
            static_cast<std::size_t>(diagnostics_json_len),
            "{"
            "\"schema_version\":\"gpu_modal_poisson_airbox_shifted_descriptor_apply.v1\","
            "\"status\":\"ok\","
            "\"study_product\":\"modal_eigen\","
            "\"lane\":\"gpu_poisson_airbox_k0\","
            "\"execution_lane\":\"gpu_device_modal_shifted_descriptor_apply_contract\","
            "\"solver_family\":\"modal_eigen\","
            "\"operator_family\":\"full_coupled_poisson_airbox_modal_pencil\","
            "\"algebraic_action\":\"(A - sigma B)*x\","
            "\"matrix_format\":\"csr_device_shifted_apply\","
            "\"demag_kind\":\"%s\","
            "\"gauge_policy\":\"%s\","
            "\"phasor_convention\":\"%s\","
            "\"eigenvalue_convention\":\"%s\","
            "\"spectral_transform\":\"shift_invert\","
            "\"frequency_response_proxy\":false,"
            "\"gpu_device_resident_shifted_operator_apply\":true,"
            "\"cpu_fallback\":\"disabled\","
            "\"fallback_used\":false,"
            "\"setup_h2d_count\":17,"
            "\"result_d2h_count\":1,"
            "\"per_iteration_h2d_count\":0,"
            "\"per_iteration_d2h_count\":0,"
            "\"q_dof_count\":%llu,"
            "\"phi_dof_count\":%llu,"
            "\"augmented_dof_count\":%llu,"
            "\"sigma\":{\"real\":%.17g,\"imag\":%.17g},"
            "\"metrics\":{"
            "\"input_l2_norm\":%.17g,"
            "\"output_l2_norm\":%.17g"
            "}"
            "}",
            problem->demag_kind != nullptr ? problem->demag_kind : "",
            problem->gauge_policy != nullptr ? problem->gauge_policy : "",
            problem->phasor_convention != nullptr ? problem->phasor_convention : "",
            problem->eigenvalue_convention != nullptr ? problem->eigenvalue_convention : "",
            static_cast<unsigned long long>(nq),
            static_cast<unsigned long long>(np),
            static_cast<unsigned long long>(total),
            sigma_real,
            sigma_imag,
            input_norm,
            output_norm);
    }
    return 0;
}

extern "C" int fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    const double *v_q_real,
    const double *v_q_imag,
    unsigned long long v_q_count,
    double *out_q_real,
    double *out_q_imag,
    unsigned long long out_q_count,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len)
{
    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        diagnostics_json[0] = '\0';
    }
    if (problem == nullptr ||
        !modal_shift_problem_valid(*problem) ||
        v_q_real == nullptr ||
        out_q_real == nullptr ||
        out_q_imag == nullptr ||
        v_q_count != problem->q_dof_count ||
        out_q_count != problem->q_dof_count ||
        !std::isfinite(sigma_real) ||
        !std::isfinite(sigma_imag)) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid PA-G3f GPU modal shift-invert action inputs");
        }
        return 1;
    }

    const unsigned long long nq = problem->q_dof_count;
    const unsigned long long np = problem->phi_dof_count;
    const unsigned long long total = nq + np + 1;
    const GpuComplex sigma = make_complex(sigma_real, sigma_imag);

    std::vector<GpuComplex> matrix(
        static_cast<std::size_t>(total * total),
        make_complex(0.0, 0.0));
    add_csr_to_modal_dense(problem->A_qq, 0, 0, matrix, total);
    add_csr_to_modal_dense(problem->A_qphi, 0, nq, matrix, total);
    add_csr_to_modal_dense(problem->A_phiq, nq, 0, matrix, total);
    add_csr_to_modal_dense(problem->A_phiphi, nq, nq, matrix, total);
    for (unsigned long long row = 0; row < np; ++row) {
        matrix[(nq + row) * total + nq + np].real += problem->phi_mean_weights[row];
        matrix[(nq + np) * total + nq + row].real += problem->phi_mean_weights[row];
    }
    for (unsigned long long row = 0; row < problem->B_qq.row_count; ++row) {
        for (std::uint32_t entry = problem->B_qq.row_offsets[row];
             entry < problem->B_qq.row_offsets[row + 1];
             ++entry) {
            matrix[row * total + problem->B_qq.column_indices[entry]] =
                matrix[row * total + problem->B_qq.column_indices[entry]] -
                sigma * problem->B_qq.values[entry];
        }
    }

    std::vector<GpuComplex> rhs(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    for (unsigned long long row = 0; row < problem->B_qq.row_count; ++row) {
        GpuComplex value = make_complex(0.0, 0.0);
        for (std::uint32_t entry = problem->B_qq.row_offsets[row];
             entry < problem->B_qq.row_offsets[row + 1];
             ++entry) {
            const unsigned long long column = problem->B_qq.column_indices[entry];
            const double input_real = v_q_real[column];
            const double input_imag = v_q_imag == nullptr ? 0.0 : v_q_imag[column];
            if (!std::isfinite(input_real) || !std::isfinite(input_imag)) {
                if (error_message != nullptr && error_message_len > 0) {
                    std::snprintf(
                        error_message,
                        static_cast<std::size_t>(error_message_len),
                        "PA-G3f GPU modal shift-invert input vector must be finite");
                }
                return 1;
            }
            value = value + make_complex(input_real, input_imag) * problem->B_qq.values[entry];
        }
        rhs[row] = value;
    }
    const double rhs_norm = modal_complex_l2_norm(rhs);

    GpuComplex *d_matrix = nullptr;
    GpuComplex *d_rhs = nullptr;
    GpuComplex *d_solution = nullptr;
    int *d_status = nullptr;
    bool ok =
        cuda_success(cudaMalloc(&d_matrix, sizeof(GpuComplex) * matrix.size()), "cudaMalloc PA-G3f matrix", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_rhs, sizeof(GpuComplex) * rhs.size()), "cudaMalloc PA-G3f rhs", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_solution, sizeof(GpuComplex) * rhs.size()), "cudaMalloc PA-G3f solution", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_status, sizeof(int)), "cudaMalloc PA-G3f status", error_message, error_message_len) &&
        cuda_success(cudaMemcpy(d_matrix, matrix.data(), sizeof(GpuComplex) * matrix.size(), cudaMemcpyHostToDevice), "cudaMemcpy PA-G3f matrix H2D", error_message, error_message_len) &&
        cuda_success(cudaMemcpy(d_rhs, rhs.data(), sizeof(GpuComplex) * rhs.size(), cudaMemcpyHostToDevice), "cudaMemcpy PA-G3f rhs H2D", error_message, error_message_len) &&
        cuda_success(cudaMemset(d_solution, 0, sizeof(GpuComplex) * rhs.size()), "cudaMemset PA-G3f solution", error_message, error_message_len) &&
        cuda_success(cudaMemset(d_status, 0, sizeof(int)), "cudaMemset PA-G3f status", error_message, error_message_len);

    if (ok) {
        modal_shift_invert_dense_solve_kernel<<<1, 1>>>(d_matrix, d_rhs, d_solution, total, d_status);
        ok = cuda_success(cudaGetLastError(), "launch PA-G3f modal shift-invert solve", error_message, error_message_len) &&
            cuda_success(cudaDeviceSynchronize(), "synchronize PA-G3f modal shift-invert solve", error_message, error_message_len);
    }

    int solver_status = 1;
    std::vector<GpuComplex> solution(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    if (ok) {
        ok =
            cuda_success(cudaMemcpy(&solver_status, d_status, sizeof(int), cudaMemcpyDeviceToHost), "cudaMemcpy PA-G3f status D2H", error_message, error_message_len) &&
            cuda_success(cudaMemcpy(solution.data(), d_solution, sizeof(GpuComplex) * solution.size(), cudaMemcpyDeviceToHost), "cudaMemcpy PA-G3f solution D2H", error_message, error_message_len);
    }

    cudaFree(d_matrix);
    cudaFree(d_rhs);
    cudaFree(d_solution);
    cudaFree(d_status);

    if (!ok) {
        return 1;
    }
    if (solver_status != 0) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "PA-G3f GPU modal shift-invert dense solve failed with status %d",
                solver_status);
        }
        return 1;
    }

    for (unsigned long long row = 0; row < nq; ++row) {
        out_q_real[row] = solution[row].real;
        out_q_imag[row] = solution[row].imag;
    }

    std::vector<GpuComplex> residual = modal_dense_matvec(matrix, total, solution);
    for (unsigned long long row = 0; row < total; ++row) {
        residual[row] = residual[row] - rhs[row];
    }
    const std::vector<GpuComplex> ax = modal_dense_matvec(matrix, total, solution);
    const double residual_relative =
        modal_complex_l2_norm(residual) /
        (rhs_norm + modal_complex_l2_norm(ax) + 1.0e-300);
    std::vector<GpuComplex> q(static_cast<std::size_t>(nq), make_complex(0.0, 0.0));
    for (unsigned long long row = 0; row < nq; ++row) {
        q[row] = solution[row];
    }
    const double output_norm = modal_complex_l2_norm(q);

    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        std::snprintf(
            diagnostics_json,
            static_cast<std::size_t>(diagnostics_json_len),
            "{"
            "\"schema_version\":\"gpu_modal_shift_invert_action.v1\","
            "\"status\":\"ok\","
            "\"study_product\":\"modal_eigen\","
            "\"lane\":\"gpu_poisson_airbox_k0\","
            "\"execution_policy\":\"device\","
            "\"memory_location\":\"device\","
            "\"fallback_used\":false,"
            "\"operator_family\":\"full_modal_shift_invert\","
            "\"algebraic_action\":\"(A - sigma B)^-1 Bv\","
            "\"rhs_family\":\"modal_mass_times_vector\","
            "\"solver_adapter\":\"gpu_device_dense_modal_shift_invert_action_contract\","
            "\"execution_lane\":\"gpu_operator_host_modal_eigen_compatibility\","
            "\"demag_kind\":\"%s\","
            "\"gauge_policy\":\"%s\","
            "\"phasor_convention\":\"%s\","
            "\"eigenvalue_convention\":\"%s\","
            "\"full_modal_shift_invert_claim\":true,"
            "\"frequency_response_proxy\":false,"
            "\"gpu_device_resident_modal_eigensolver\":false,"
            "\"per_iteration_h2d_count\":0,"
            "\"per_iteration_d2h_count\":0,"
            "\"q_dof_count\":%llu,"
            "\"phi_dof_count\":%llu,"
            "\"augmented_dof_count\":%llu,"
            "\"sigma\":{\"real\":%.17g,\"imag\":%.17g},"
            "\"metrics\":{"
            "\"rhs_l2_norm\":%.17g,"
            "\"output_q_l2_norm\":%.17g,"
            "\"shifted_system_relative_residual\":%.17g"
            "}"
            "}",
            problem->demag_kind != nullptr ? problem->demag_kind : "",
            problem->gauge_policy != nullptr ? problem->gauge_policy : "",
            problem->phasor_convention != nullptr ? problem->phasor_convention : "",
            problem->eigenvalue_convention != nullptr ? problem->eigenvalue_convention : "",
            static_cast<unsigned long long>(nq),
            static_cast<unsigned long long>(np),
            static_cast<unsigned long long>(total),
            sigma_real,
            sigma_imag,
            rhs_norm,
            output_norm,
            residual_relative);
    }
    return 0;
}

extern "C" int fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver(
    const fd::PoissonAirboxEigenBlockProblem *problem,
    double sigma_real,
    double sigma_imag,
    unsigned int max_iterations,
    double *out_frequency_hz,
    double *out_relative_residual,
    char *diagnostics_json,
    unsigned long long diagnostics_json_len,
    char *error_message,
    unsigned long long error_message_len)
{
    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        diagnostics_json[0] = '\0';
    }
    if (problem == nullptr ||
        out_frequency_hz == nullptr ||
        out_relative_residual == nullptr ||
        !modal_shift_problem_valid(*problem) ||
        !std::isfinite(sigma_real) ||
        !std::isfinite(sigma_imag) ||
        max_iterations == 0) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "invalid GPU-G5a modal Poisson-airbox eigensolver inputs");
        }
        return 1;
    }

    const unsigned long long nq = problem->q_dof_count;
    const unsigned long long np = problem->phi_dof_count;
    const unsigned long long total = nq + np + 1;
    const GpuComplex sigma = make_complex(sigma_real, sigma_imag);

    std::vector<GpuComplex> a_matrix(
        static_cast<std::size_t>(total * total),
        make_complex(0.0, 0.0));
    std::vector<GpuComplex> b_matrix(
        static_cast<std::size_t>(total * total),
        make_complex(0.0, 0.0));
    add_csr_to_modal_dense(problem->A_qq, 0, 0, a_matrix, total);
    add_csr_to_modal_dense(problem->A_qphi, 0, nq, a_matrix, total);
    add_csr_to_modal_dense(problem->A_phiq, nq, 0, a_matrix, total);
    add_csr_to_modal_dense(problem->A_phiphi, nq, nq, a_matrix, total);
    for (unsigned long long row = 0; row < np; ++row) {
        a_matrix[(nq + row) * total + nq + np].real += problem->phi_mean_weights[row];
        a_matrix[(nq + np) * total + nq + row].real += problem->phi_mean_weights[row];
    }
    add_csr_to_modal_dense(problem->B_qq, 0, 0, b_matrix, total);

    std::vector<GpuComplex> shifted_matrix = a_matrix;
    for (unsigned long long row = 0; row < total; ++row) {
        for (unsigned long long column = 0; column < total; ++column) {
            shifted_matrix[row * total + column] =
                shifted_matrix[row * total + column] -
                sigma * b_matrix[row * total + column];
        }
    }

    GpuComplex *d_a = nullptr;
    GpuComplex *d_b = nullptr;
    GpuComplex *d_shifted = nullptr;
    GpuComplex *d_x = nullptr;
    double *d_lambda_real = nullptr;
    double *d_lambda_imag = nullptr;
    double *d_frequency_hz = nullptr;
    double *d_residual = nullptr;
    int *d_status = nullptr;

    bool ok =
        cuda_success(cudaMalloc(&d_a, sizeof(GpuComplex) * a_matrix.size()), "cudaMalloc GPU-G5a A", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_b, sizeof(GpuComplex) * b_matrix.size()), "cudaMalloc GPU-G5a B", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_shifted, sizeof(GpuComplex) * shifted_matrix.size()), "cudaMalloc GPU-G5a shifted matrix", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_x, sizeof(GpuComplex) * total), "cudaMalloc GPU-G5a eigenvector", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_lambda_real, sizeof(double)), "cudaMalloc GPU-G5a lambda real", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_lambda_imag, sizeof(double)), "cudaMalloc GPU-G5a lambda imag", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_frequency_hz, sizeof(double)), "cudaMalloc GPU-G5a frequency", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_residual, sizeof(double)), "cudaMalloc GPU-G5a residual", error_message, error_message_len) &&
        cuda_success(cudaMalloc(&d_status, sizeof(int)), "cudaMalloc GPU-G5a status", error_message, error_message_len) &&
        cuda_success(cudaMemcpy(d_a, a_matrix.data(), sizeof(GpuComplex) * a_matrix.size(), cudaMemcpyHostToDevice), "cudaMemcpy GPU-G5a A H2D", error_message, error_message_len) &&
        cuda_success(cudaMemcpy(d_b, b_matrix.data(), sizeof(GpuComplex) * b_matrix.size(), cudaMemcpyHostToDevice), "cudaMemcpy GPU-G5a B H2D", error_message, error_message_len) &&
        cuda_success(cudaMemcpy(d_shifted, shifted_matrix.data(), sizeof(GpuComplex) * shifted_matrix.size(), cudaMemcpyHostToDevice), "cudaMemcpy GPU-G5a shifted H2D", error_message, error_message_len) &&
        cuda_success(cudaMemset(d_x, 0, sizeof(GpuComplex) * total), "cudaMemset GPU-G5a eigenvector", error_message, error_message_len) &&
        cuda_success(cudaMemset(d_status, 0, sizeof(int)), "cudaMemset GPU-G5a status", error_message, error_message_len);

    if (ok) {
        modal_poisson_airbox_dense_eigensolver_kernel<<<1, 1>>>(
            d_a,
            d_b,
            d_shifted,
            total,
            nq,
            max_iterations,
            d_x,
            d_lambda_real,
            d_lambda_imag,
            d_frequency_hz,
            d_residual,
            d_status);
        ok = cuda_success(cudaGetLastError(), "launch GPU-G5a modal eigensolver", error_message, error_message_len) &&
            cuda_success(cudaDeviceSynchronize(), "synchronize GPU-G5a modal eigensolver", error_message, error_message_len);
    }

    int solver_status = 1;
    double lambda_real = 0.0;
    double lambda_imag = 0.0;
    double frequency_hz = 0.0;
    double relative_residual = 1.0;
    if (ok) {
        ok =
            cuda_success(cudaMemcpy(&solver_status, d_status, sizeof(int), cudaMemcpyDeviceToHost), "cudaMemcpy GPU-G5a status D2H", error_message, error_message_len) &&
            cuda_success(cudaMemcpy(&lambda_real, d_lambda_real, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpy GPU-G5a lambda real D2H", error_message, error_message_len) &&
            cuda_success(cudaMemcpy(&lambda_imag, d_lambda_imag, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpy GPU-G5a lambda imag D2H", error_message, error_message_len) &&
            cuda_success(cudaMemcpy(&frequency_hz, d_frequency_hz, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpy GPU-G5a frequency D2H", error_message, error_message_len) &&
            cuda_success(cudaMemcpy(&relative_residual, d_residual, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpy GPU-G5a residual D2H", error_message, error_message_len);
    }

    cudaFree(d_a);
    cudaFree(d_b);
    cudaFree(d_shifted);
    cudaFree(d_x);
    cudaFree(d_lambda_real);
    cudaFree(d_lambda_imag);
    cudaFree(d_frequency_hz);
    cudaFree(d_residual);
    cudaFree(d_status);

    if (!ok) {
        return 1;
    }
    if (solver_status != 0) {
        if (error_message != nullptr && error_message_len > 0) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_message_len),
                "GPU-G5a dense modal eigensolver failed with status %d",
                solver_status);
        }
        return 1;
    }

    *out_frequency_hz = frequency_hz;
    *out_relative_residual = relative_residual;
    const double relative_reference_frequency_error =
        problem->expected_reference_frequency_hz > 0.0 ?
        std::abs(frequency_hz - problem->expected_reference_frequency_hz) /
            (std::abs(problem->expected_reference_frequency_hz) + 1.0e-300) :
        0.0;

    if (diagnostics_json != nullptr && diagnostics_json_len > 0) {
        std::snprintf(
            diagnostics_json,
            static_cast<std::size_t>(diagnostics_json_len),
            "{"
            "\"schema_version\":\"gpu_modal_poisson_airbox_eigensolver.v1\","
            "\"status\":\"ok\","
            "\"study_product\":\"modal_eigen\","
            "\"lane\":\"gpu_poisson_airbox_k0_dense_validation\","
            "\"execution_lane\":\"gpu_dense_modal_validation\","
            "\"solver_adapter\":\"gpu_dense_poisson_airbox_modal_dense_validation_contract\","
            "\"solver_family\":\"modal_eigen\","
            "\"solver_library\":\"cuda_dense_inverse_iteration\","
            "\"demag_kind\":\"%s\","
            "\"gauge_policy\":\"%s\","
            "\"phasor_convention\":\"%s\","
            "\"eigenvalue_convention\":\"%s\","
            "\"operator_family\":\"full_coupled_poisson_airbox_modal_pencil\","
            "\"spectral_transform\":\"shift_invert\","
            "\"frequency_response_proxy\":false,"
            "\"operator_storage\":\"device\","
            "\"eigensolver_iteration_location\":\"device\","
            "\"persistent_solver_context\":false,"
            "\"scalable_sparse_or_matrix_free\":false,"
            "\"validation_only\":true,"
            "\"production_modal_claim\":false,"
            "\"gpu_device_resident_modal_eigensolver\":false,"
            "\"cpu_fallback\":\"disabled\","
            "\"fallback_used\":false,"
            "\"per_iteration_h2d_count\":0,"
            "\"per_iteration_d2h_count\":0,"
            "\"q_dof_count\":%llu,"
            "\"phi_dof_count\":%llu,"
            "\"augmented_dof_count\":%llu,"
            "\"max_iterations\":%u,"
            "\"sigma\":{\"real\":%.17g,\"imag\":%.17g},"
            "\"eigenpair\":{"
            "\"eigenvalue_real\":%.17g,"
            "\"eigenvalue_imag\":%.17g,"
            "\"omega_rad_s\":%.17g,"
            "\"frequency_hz\":%.17g"
            "},"
            "\"metrics\":{"
            "\"relative_reference_frequency_error\":%.17g,"
            "\"full_descriptor_relative_residual\":%.17g"
            "}"
            "}",
            problem->demag_kind != nullptr ? problem->demag_kind : "",
            problem->gauge_policy != nullptr ? problem->gauge_policy : "",
            problem->phasor_convention != nullptr ? problem->phasor_convention : "",
            problem->eigenvalue_convention != nullptr ? problem->eigenvalue_convention : "",
            static_cast<unsigned long long>(nq),
            static_cast<unsigned long long>(np),
            static_cast<unsigned long long>(total),
            max_iterations,
            sigma_real,
            sigma_imag,
            lambda_real,
            lambda_imag,
            lambda_imag,
            frequency_hz,
            relative_reference_frequency_error,
            relative_residual);
    }
    return 0;
}
