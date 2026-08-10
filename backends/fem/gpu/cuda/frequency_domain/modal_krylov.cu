#include "frequency_domain/modal_gpu_krylov.hpp"

#include "frequency_domain/checked_extent.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <new>
#include <string>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

constexpr unsigned int kBlockSize = 256;
constexpr std::uint32_t kMaxGpuModalModes = 32;
constexpr std::uint64_t kMaxGpuModalDofs = 1ull << 27;
constexpr std::uint64_t kDenseDeviceSolveDofs = 64u;
constexpr double kDiagonalTolerance = 1.0e-14;
constexpr double kBreakdownTolerance = 1.0e-28;
constexpr int kModalStatusConverged = 1 << 0;
constexpr int kModalStatusBreakdown = 1 << 1;
constexpr int kModalStatusNonFinite = 1 << 2;
constexpr int kModalStatusLinearLimit = 1 << 3;
// A finite BiCGStab omega denominator can collapse when the intermediate
// s-vector is already in the requested tolerance.  Keep that state alive
// until the post-update residual is checked instead of misclassifying a
// happy breakdown as a numerical failure.
constexpr int kModalStatusHappyBreakdown = 1 << 4;

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
    return denominator > 0.0 ?
        make_complex(
            (a.real * b.real + a.imag * b.imag) / denominator,
            (a.imag * b.real - a.real * b.imag) / denominator) :
        make_complex(0.0, 0.0);
}

__host__ __device__ GpuComplex complex_conj(GpuComplex value)
{
    return make_complex(value.real, -value.imag);
}

__host__ __device__ double complex_abs2(GpuComplex value)
{
    return value.real * value.real + value.imag * value.imag;
}

__host__ __device__ bool complex_is_finite(GpuComplex value)
{
    return isfinite(value.real) && isfinite(value.imag);
}

__device__ bool modal_status_stopped(const int *status)
{
    return status != nullptr &&
        ((*status & (kModalStatusConverged | kModalStatusBreakdown |
                     kModalStatusNonFinite | kModalStatusLinearLimit)) != 0);
}

struct DeviceCsr {
    std::uint32_t *row_offsets = nullptr;
    std::uint32_t *column_indices = nullptr;
    double *values = nullptr;
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
};

struct DeviceModalMetrics {
    double lambda_real = 0.0;
    double lambda_imag = 0.0;
    double residual_relative = 0.0;
    double q_norm = 0.0;
    double denominator_abs = 0.0;
    double gauge_constraint_abs = 0.0;
    double magnetic_block_backward_error = 0.0;
    double poisson_block_backward_error = 0.0;
    double gauge_constraint_backward_error = 0.0;
};

__device__ GpuComplex csr_row_dot(
    DeviceCsr matrix,
    std::uint64_t row,
    const GpuComplex *x,
    std::uint64_t offset)
{
    GpuComplex value = make_complex(0.0, 0.0);
    for (std::uint32_t entry = matrix.row_offsets[row];
         entry < matrix.row_offsets[row + 1u];
         ++entry) {
        value = value + x[offset + matrix.column_indices[entry]] * matrix.values[entry];
    }
    return value;
}

__global__ void apply_shifted_kernel(
    std::uint64_t nq,
    std::uint64_t np,
    bool gauge,
    GpuComplex sigma,
    DeviceCsr a_qq,
    DeviceCsr a_qphi,
    DeviceCsr a_phiq,
    DeviceCsr a_phiphi,
    DeviceCsr b_qq,
    const double *phi_mean_weights,
    const GpuComplex *x,
    GpuComplex *y,
    int *status)
{
    const std::uint64_t row =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const std::uint64_t total = nq + np + (gauge ? 1u : 0u);
    if (row >= total || modal_status_stopped(status)) {
        return;
    }
    GpuComplex value = make_complex(0.0, 0.0);
    if (row < nq) {
        value = value + csr_row_dot(a_qq, row, x, 0u);
        value = value + csr_row_dot(a_qphi, row, x, nq);
        value = value - sigma * csr_row_dot(b_qq, row, x, 0u);
    } else if (row < nq + np) {
        const std::uint64_t phi_row = row - nq;
        value = value + csr_row_dot(a_phiq, phi_row, x, 0u);
        value = value + csr_row_dot(a_phiphi, phi_row, x, nq);
        if (gauge) {
            value = value + x[nq + np] * phi_mean_weights[phi_row];
        }
    } else {
        for (std::uint64_t phi_row = 0; phi_row < np; ++phi_row) {
            value = value + x[nq + phi_row] * phi_mean_weights[phi_row];
        }
    }
    y[row] = value;
    if (!complex_is_finite(value)) {
        atomicOr(status, kModalStatusNonFinite);
    }
}

__global__ void apply_mass_kernel(
    std::uint64_t nq,
    std::uint64_t np,
    bool gauge,
    DeviceCsr b_qq,
    const GpuComplex *x,
    GpuComplex *y)
{
    const std::uint64_t row =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const std::uint64_t total = nq + np + (gauge ? 1u : 0u);
    if (row >= total) {
        return;
    }
    y[row] = row < nq ? csr_row_dot(b_qq, row, x, 0u) : make_complex(0.0, 0.0);
}

__global__ void fill_shifted_dense_kernel(
    std::uint64_t nq,
    std::uint64_t np,
    bool gauge,
    GpuComplex sigma,
    DeviceCsr a_qq,
    DeviceCsr a_qphi,
    DeviceCsr a_phiq,
    DeviceCsr a_phiphi,
    DeviceCsr b_qq,
    const double *phi_mean_weights,
    GpuComplex *dense)
{
    const std::uint64_t total = nq + np + (gauge ? 1u : 0u);
    const std::uint64_t entry =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (entry >= total * total) {
        return;
    }
    const std::uint64_t row = entry / total;
    const std::uint64_t column = entry % total;
    GpuComplex value = make_complex(0.0, 0.0);
    if (row < nq) {
        for (std::uint32_t index = a_qq.row_offsets[row];
             index < a_qq.row_offsets[row + 1u];
             ++index) {
            if (a_qq.column_indices[index] == column) {
                value = value + make_complex(a_qq.values[index], 0.0);
            }
        }
        for (std::uint32_t index = b_qq.row_offsets[row];
             index < b_qq.row_offsets[row + 1u];
             ++index) {
            if (b_qq.column_indices[index] == column) {
                value = value - sigma * make_complex(b_qq.values[index], 0.0);
            }
        }
        if (column >= nq && column < nq + np) {
            const std::uint64_t phi_column = column - nq;
            for (std::uint32_t index = a_qphi.row_offsets[row];
                 index < a_qphi.row_offsets[row + 1u];
                 ++index) {
                if (a_qphi.column_indices[index] == phi_column) {
                    value = value + make_complex(a_qphi.values[index], 0.0);
                }
            }
        }
    } else if (row < nq + np) {
        const std::uint64_t phi_row = row - nq;
        if (column < nq) {
            for (std::uint32_t index = a_phiq.row_offsets[phi_row];
                 index < a_phiq.row_offsets[phi_row + 1u];
                 ++index) {
                if (a_phiq.column_indices[index] == column) {
                    value = value + make_complex(a_phiq.values[index], 0.0);
                }
            }
        } else if (column < nq + np) {
            const std::uint64_t phi_column = column - nq;
            for (std::uint32_t index = a_phiphi.row_offsets[phi_row];
                 index < a_phiphi.row_offsets[phi_row + 1u];
                 ++index) {
                if (a_phiphi.column_indices[index] == phi_column) {
                    value = value + make_complex(a_phiphi.values[index], 0.0);
                }
            }
        } else if (gauge) {
            value = make_complex(phi_mean_weights[phi_row], 0.0);
        }
    } else if (gauge && column >= nq && column < nq + np) {
        value = make_complex(phi_mean_weights[column - nq], 0.0);
    }
    dense[entry] = value;
}

__global__ void copy_dense_matrix_kernel(
    std::uint64_t entries,
    const GpuComplex *source,
    GpuComplex *destination)
{
    const std::uint64_t entry =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (entry < entries) {
        destination[entry] = source[entry];
    }
}

__global__ void dense_shifted_solve_kernel(
    std::uint64_t total,
    GpuComplex *matrix,
    const GpuComplex *rhs,
    GpuComplex *solution,
    int *status)
{
    if (blockIdx.x != 0 || threadIdx.x != 0) {
        return;
    }
    for (std::uint64_t row = 0; row < total; ++row) {
        solution[row] = rhs[row];
    }
    for (std::uint64_t pivot = 0; pivot < total; ++pivot) {
        std::uint64_t pivot_row = pivot;
        double pivot_norm = complex_abs2(matrix[pivot * total + pivot]);
        for (std::uint64_t row = pivot + 1u; row < total; ++row) {
            const double candidate = complex_abs2(matrix[row * total + pivot]);
            if (candidate > pivot_norm) {
                pivot_norm = candidate;
                pivot_row = row;
            }
        }
        if (!std::isfinite(pivot_norm) || pivot_norm <= kBreakdownTolerance) {
            atomicOr(status, kModalStatusBreakdown);
            return;
        }
        if (pivot_row != pivot) {
            for (std::uint64_t column = pivot; column < total; ++column) {
                const GpuComplex temporary = matrix[pivot * total + column];
                matrix[pivot * total + column] = matrix[pivot_row * total + column];
                matrix[pivot_row * total + column] = temporary;
            }
            const GpuComplex temporary = solution[pivot];
            solution[pivot] = solution[pivot_row];
            solution[pivot_row] = temporary;
        }
        const GpuComplex diagonal = matrix[pivot * total + pivot];
        for (std::uint64_t row = pivot + 1u; row < total; ++row) {
            const GpuComplex factor = matrix[row * total + pivot] / diagonal;
            matrix[row * total + pivot] = make_complex(0.0, 0.0);
            for (std::uint64_t column = pivot + 1u; column < total; ++column) {
                matrix[row * total + column] =
                    matrix[row * total + column] - factor * matrix[pivot * total + column];
            }
            solution[row] = solution[row] - factor * solution[pivot];
        }
    }
    for (std::int64_t row = static_cast<std::int64_t>(total) - 1; row >= 0; --row) {
        GpuComplex value = solution[static_cast<std::uint64_t>(row)];
        for (std::uint64_t column = static_cast<std::uint64_t>(row) + 1u;
             column < total;
             ++column) {
            value = value - matrix[static_cast<std::uint64_t>(row) * total + column] * solution[column];
        }
        solution[static_cast<std::uint64_t>(row)] =
            value / matrix[static_cast<std::uint64_t>(row) * total + static_cast<std::uint64_t>(row)];
        if (!complex_is_finite(solution[static_cast<std::uint64_t>(row)])) {
            atomicOr(status, kModalStatusNonFinite);
            return;
        }
    }
}

__global__ void compute_shifted_residual_kernel(
    std::uint64_t total,
    const GpuComplex *matrix,
    const GpuComplex *rhs,
    const GpuComplex *solution,
    GpuComplex *residual,
    int *status)
{
    const std::uint64_t row =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (row >= total || modal_status_stopped(status)) {
        return;
    }
    GpuComplex value = rhs[row];
    for (std::uint64_t column = 0; column < total; ++column) {
        value = value - matrix[row * total + column] * solution[column];
    }
    residual[row] = value;
    if (!complex_is_finite(value)) {
        atomicOr(status, kModalStatusNonFinite);
    }
}

__global__ void fill_vector_kernel(
    std::uint64_t total,
    GpuComplex value,
    GpuComplex *x)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        x[index] = value;
    }
}

__global__ void copy_vector_kernel(
    std::uint64_t total,
    const GpuComplex *source,
    GpuComplex *destination)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        destination[index] = source[index];
    }
}

__global__ void initialize_bicgstab_shadow_kernel(
    std::uint64_t total,
    const GpuComplex *source,
    std::uint32_t seed,
    GpuComplex *shadow)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total) {
        return;
    }
    const double real = static_cast<double>((index * 29u + seed * 13u) % 101u) / 101.0 - 0.5;
    const double imag = static_cast<double>((index * 43u + seed * 17u + 7u) % 107u) / 107.0 - 0.5;
    shadow[index] = source[index] + make_complex(1.0e-3 * real, 1.0e-3 * imag);
}

__global__ void complex_dot_kernel(
    std::uint64_t total,
    const GpuComplex *left,
    const GpuComplex *right,
    GpuComplex *out,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        if (modal_status_stopped(status)) {
            return;
        }
        if (!complex_is_finite(left[index]) || !complex_is_finite(right[index])) {
            atomicOr(status, kModalStatusNonFinite);
            return;
        }
        const GpuComplex value = complex_conj(left[index]) * right[index];
        if (!complex_is_finite(value)) {
            atomicOr(status, kModalStatusNonFinite);
            return;
        }
        atomicAdd(&out->real, value.real);
        atomicAdd(&out->imag, value.imag);
    }
}

__device__ double csr_real_entry(DeviceCsr matrix, std::uint64_t row, std::uint64_t column)
{
    if (row >= matrix.rows || column >= matrix.columns) {
        return 0.0;
    }
    for (std::uint32_t entry = matrix.row_offsets[row];
         entry < matrix.row_offsets[row + 1u];
         ++entry) {
        if (matrix.column_indices[entry] == column) {
            return matrix.values[entry];
        }
    }
    return 0.0;
}

__device__ GpuComplex shifted_q_entry(
    DeviceCsr a_qq,
    DeviceCsr b_qq,
    std::uint64_t row,
    std::uint64_t column,
    GpuComplex sigma)
{
    const double a = csr_real_entry(a_qq, row, column);
    const double b = csr_real_entry(b_qq, row, column);
    return make_complex(a - sigma.real * b, -sigma.imag * b);
}

// The magnetic tangent is stored interleaved by node/component.  A local
// 2x2 block-Jacobi preconditioner retains the gyrotropic pair coupling that
// diagonal Jacobi discards and is still fully device-resident.  Scalar
// potential rows use their assembled diagonal; the mean-zero row is an
// identity preconditioner.
__global__ void block_jacobi_precondition_kernel(
    std::uint64_t nq,
    std::uint64_t np,
    bool gauge,
    GpuComplex sigma,
    DeviceCsr a_qq,
    DeviceCsr b_qq,
    DeviceCsr a_phiphi,
    const GpuComplex *rhs,
    GpuComplex *out,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const std::uint64_t total = nq + np + (gauge ? 1u : 0u);
    if (index >= total || modal_status_stopped(status)) {
        return;
    }
    if (index < nq) {
        if ((index & 1u) != 0u || index + 1u >= nq) {
            return;
        }
        const std::uint64_t odd = index + 1u;
        const GpuComplex m00 = shifted_q_entry(a_qq, b_qq, index, index, sigma);
        const GpuComplex m01 = shifted_q_entry(a_qq, b_qq, index, odd, sigma);
        const GpuComplex m10 = shifted_q_entry(a_qq, b_qq, odd, index, sigma);
        const GpuComplex m11 = shifted_q_entry(a_qq, b_qq, odd, odd, sigma);
        const GpuComplex determinant = m00 * m11 - m01 * m10;
        if (!complex_is_finite(determinant) ||
            complex_abs2(determinant) <= kBreakdownTolerance) {
            atomicOr(status, kModalStatusBreakdown);
            return;
        }
        out[index] = (m11 * rhs[index] - m01 * rhs[odd]) / determinant;
        out[odd] = (make_complex(-m10.real, -m10.imag) * rhs[index] +
                    m00 * rhs[odd]) / determinant;
        if (!complex_is_finite(out[index]) || !complex_is_finite(out[odd])) {
            atomicOr(status, kModalStatusNonFinite);
        }
        return;
    }
    if (index < nq + np) {
        const std::uint64_t phi_row = index - nq;
        const double diagonal = csr_real_entry(a_phiphi, phi_row, phi_row);
        if (!std::isfinite(diagonal) || std::abs(diagonal) <= kDiagonalTolerance) {
            atomicOr(status, kModalStatusBreakdown);
            return;
        }
        out[index] = rhs[index] / make_complex(diagonal, 0.0);
        if (!complex_is_finite(out[index])) {
            atomicOr(status, kModalStatusNonFinite);
        }
        return;
    }
    out[index] = rhs[index];
}

__global__ void initialize_bicgstab_scalars_kernel(
    GpuComplex *rho_old,
    GpuComplex *alpha,
    GpuComplex *omega)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        *rho_old = make_complex(1.0, 0.0);
        *alpha = make_complex(1.0, 0.0);
        *omega = make_complex(1.0, 0.0);
    }
}

__global__ void bicgstab_update_p_kernel(
    std::uint64_t total,
    const GpuComplex *rho,
    const GpuComplex *rho_old,
    const GpuComplex *alpha,
    const GpuComplex *omega,
    const GpuComplex *r,
    const GpuComplex *v,
    GpuComplex *p,
    int *status)
{
    if (modal_status_stopped(status)) {
        return;
    }
    const GpuComplex rho_value = *rho;
    const GpuComplex rho_old_value = *rho_old;
    const GpuComplex omega_value = *omega;
    const GpuComplex alpha_value = *alpha;
    if (!complex_is_finite(rho_value) || !complex_is_finite(rho_old_value) ||
        !complex_is_finite(omega_value) || !complex_is_finite(alpha_value)) {
        atomicOr(status, kModalStatusNonFinite);
        return;
    }
    if (complex_abs2(rho_old_value) <= kBreakdownTolerance ||
        complex_abs2(omega_value) <= kBreakdownTolerance) {
        atomicOr(status, kModalStatusBreakdown);
        return;
    }
    const GpuComplex beta = (rho_value / rho_old_value) * (alpha_value / omega_value);
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        p[index] = r[index] + beta * (p[index] - *omega * v[index]);
        if (!complex_is_finite(p[index])) {
            atomicOr(status, kModalStatusNonFinite);
        }
    }
}

__global__ void bicgstab_update_alpha_kernel(
    const GpuComplex *rho,
    const GpuComplex *denominator,
    GpuComplex *alpha,
    int *status)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        if (modal_status_stopped(status)) {
            return;
        }
        if (!complex_is_finite(*rho) || !complex_is_finite(*denominator)) {
            atomicOr(status, kModalStatusNonFinite);
            return;
        }
        if (complex_abs2(*denominator) <= kBreakdownTolerance) {
            atomicOr(status, kModalStatusBreakdown);
            return;
        }
        *alpha = *rho / *denominator;
        if (!complex_is_finite(*alpha)) {
            atomicOr(status, kModalStatusNonFinite);
        }
    }
}

__global__ void bicgstab_update_s_kernel(
    std::uint64_t total,
    const GpuComplex *r,
    const GpuComplex *v,
    const GpuComplex *alpha,
    GpuComplex *s,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        if (modal_status_stopped(status)) {
            return;
        }
        s[index] = r[index] - *alpha * v[index];
        if (!complex_is_finite(s[index])) {
            atomicOr(status, kModalStatusNonFinite);
        }
    }
}

__global__ void bicgstab_update_omega_kernel(
    const GpuComplex *numerator,
    const GpuComplex *denominator,
    GpuComplex *omega,
    int *status)
{
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        if (modal_status_stopped(status)) {
            return;
        }
        if (!complex_is_finite(*numerator) || !complex_is_finite(*denominator)) {
            atomicOr(status, kModalStatusBreakdown | kModalStatusNonFinite);
            return;
        }
        if (complex_abs2(*denominator) <= kBreakdownTolerance) {
            *omega = make_complex(0.0, 0.0);
            atomicOr(status, kModalStatusHappyBreakdown);
            return;
        }
        *omega = *numerator / *denominator;
        if (!complex_is_finite(*omega)) {
            atomicOr(status, kModalStatusNonFinite);
        }
    }
}

__global__ void bicgstab_update_solution_kernel(
    std::uint64_t total,
    const GpuComplex *alpha,
    const GpuComplex *omega,
    const GpuComplex *phat,
    const GpuComplex *shat,
    const GpuComplex *s,
    const GpuComplex *t,
    const GpuComplex *rho,
    GpuComplex *solution,
    GpuComplex *r,
    GpuComplex *rho_old,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        if (modal_status_stopped(status)) {
            return;
        }
        solution[index] = solution[index] + *alpha * phat[index] + *omega * shat[index];
        r[index] = s[index] - *omega * t[index];
        if (!complex_is_finite(solution[index]) || !complex_is_finite(r[index])) {
            atomicOr(status, kModalStatusNonFinite);
        }
    }
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        *rho_old = *rho;
    }
}

__global__ void initialise_vector_kernel(
    std::uint64_t nq,
    std::uint64_t total,
    std::uint32_t seed,
    GpuComplex *x)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total) {
        return;
    }
    if (index < nq) {
        const double a = static_cast<double>((index * 37u + seed * 11u) % 97u) / 97.0;
        const double b = static_cast<double>((index * 17u + seed * 7u + 13u) % 89u) / 89.0;
        x[index] = make_complex(a - 0.5, b - 0.5);
    } else {
        x[index] = make_complex(0.0, 0.0);
    }
}

__global__ void norm_q_kernel(
    std::uint64_t nq,
    const GpuComplex *x,
    double *out_norm_squared)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= nq) {
        return;
    }
    atomicAdd(out_norm_squared, complex_abs2(x[index]));
}

__global__ void norm_complex_vector_kernel(
    std::uint64_t total,
    const GpuComplex *x,
    double *out_norm_squared,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total || modal_status_stopped(status)) {
        return;
    }
    if (!complex_is_finite(x[index])) {
        atomicOr(status, kModalStatusNonFinite);
        return;
    }
    atomicAdd(out_norm_squared, complex_abs2(x[index]));
}

__global__ void update_linear_convergence_kernel(
    const double *residual_norm_squared,
    const double *rhs_norm_squared,
    double relative_tolerance,
    std::uint32_t iteration,
    std::uint32_t max_iterations,
    int *status)
{
    if (blockIdx.x != 0 || threadIdx.x != 0 || modal_status_stopped(status)) {
        return;
    }
    const double residual = *residual_norm_squared;
    const double rhs = *rhs_norm_squared;
    if (!std::isfinite(residual) || !std::isfinite(rhs) || residual < 0.0 || rhs < 0.0) {
        atomicOr(status, kModalStatusNonFinite);
        return;
    }
    const double scale = std::sqrt(rhs > 1.0e-300 ? rhs : 1.0e-300);
    if (std::sqrt(residual) <= relative_tolerance * scale) {
        atomicOr(status, kModalStatusConverged);
    } else if (iteration + 1u >= max_iterations) {
        atomicOr(status, kModalStatusLinearLimit);
    }
}

__global__ void restart_bicgstab_after_happy_breakdown_kernel(
    std::uint64_t total,
    const GpuComplex *r,
    GpuComplex *rhat,
    GpuComplex *p,
    GpuComplex *v,
    GpuComplex *rho_old,
    GpuComplex *alpha,
    GpuComplex *omega,
    bool include_happy_breakdown,
    int *status)
{
    const int current_status = *status;
    const bool restart =
        ((current_status & kModalStatusBreakdown) != 0 ||
         (include_happy_breakdown &&
          (current_status & kModalStatusHappyBreakdown) != 0)) &&
        (current_status & (kModalStatusConverged | kModalStatusLinearLimit |
                           kModalStatusNonFinite)) == 0;
    if (!restart) {
        return;
    }
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        rhat[index] = r[index];
        p[index] = make_complex(0.0, 0.0);
        v[index] = make_complex(0.0, 0.0);
    }
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        *rho_old = make_complex(1.0, 0.0);
        *alpha = make_complex(1.0, 0.0);
        *omega = make_complex(1.0, 0.0);
        *status = 0;
    }
}

__global__ void scale_vector_by_q_norm_kernel(
    std::uint64_t total,
    const double *norm_squared,
    GpuComplex *x)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total) {
        return;
    }
    const double norm = sqrt(*norm_squared);
    if (norm > 0.0 && isfinite(norm)) {
        x[index] = x[index] * (1.0 / norm);
    }
}

__global__ void subtract_locked_kernel(
    std::uint64_t total,
    std::uint32_t locked_count,
    const GpuComplex *coefficients,
    const GpuComplex *locked,
    GpuComplex *x)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total) {
        return;
    }
    GpuComplex value = x[index];
    for (std::uint32_t mode = 0; mode < locked_count; ++mode) {
        value = value - locked[static_cast<std::uint64_t>(mode) * total + index] *
            coefficients[mode];
    }
    x[index] = value;
}

__global__ void subtract_basis_component_kernel(
    std::uint64_t total,
    const GpuComplex *coefficient,
    const GpuComplex *basis,
    GpuComplex *x,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total || modal_status_stopped(status)) {
        return;
    }
    x[index] = x[index] - *coefficient * basis[index];
    if (!complex_is_finite(x[index])) {
        atomicOr(status, kModalStatusNonFinite);
    }
}

__global__ void combine_basis_kernel(
    std::uint64_t total,
    std::uint32_t basis_count,
    const GpuComplex *coefficients,
    const GpuComplex *basis,
    GpuComplex *x,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= total || modal_status_stopped(status)) {
        return;
    }
    GpuComplex value = make_complex(0.0, 0.0);
    for (std::uint32_t column = 0; column < basis_count; ++column) {
        value = value + basis[static_cast<std::uint64_t>(column) * total + index] *
            coefficients[column];
    }
    x[index] = value;
    if (!complex_is_finite(value)) {
        atomicOr(status, kModalStatusNonFinite);
    }
}

__global__ void compute_locked_coefficients_kernel(
    std::uint64_t total,
    std::uint32_t locked_count,
    const GpuComplex *locked,
    const GpuComplex *x,
    GpuComplex *coefficients)
{
    const std::uint32_t mode = blockIdx.x;
    if (mode >= locked_count) {
        return;
    }
        const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.y) * blockDim.x + threadIdx.x;
    if (index >= total) {
        return;
    }
    const GpuComplex value = complex_conj(
        locked[static_cast<std::uint64_t>(mode) * total + index]) * x[index];
    atomicAdd(&coefficients[mode].real, value.real);
    atomicAdd(&coefficients[mode].imag, value.imag);
}

__global__ void final_metrics_kernel(
    std::uint64_t nq,
    std::uint64_t np,
    std::uint64_t total,
    bool gauge,
    const double *phi_mean_weights,
    DeviceCsr a_qq,
    DeviceCsr a_qphi,
    DeviceCsr a_phiq,
    DeviceCsr a_phiphi,
    DeviceCsr b_qq,
    const GpuComplex *x,
    const GpuComplex *ax,
    const GpuComplex *bx,
    DeviceModalMetrics *out)
{
    if (blockIdx.x != 0 || threadIdx.x != 0) {
        return;
    }
    GpuComplex numerator = make_complex(0.0, 0.0);
    GpuComplex denominator = make_complex(0.0, 0.0);
    double q_norm_squared = 0.0;
    double residual_squared = 0.0;
    double ax_norm_squared = 0.0;
    double bx_norm_squared = 0.0;
    GpuComplex gauge_residual = make_complex(0.0, 0.0);
    double q_residual_squared = 0.0;
    double q_aqq_squared = 0.0;
    double q_aqphi_squared = 0.0;
    double q_bqq_squared = 0.0;
    double phi_residual_squared = 0.0;
    double phi_phiq_squared = 0.0;
    double phi_phiphi_squared = 0.0;
    double phi_norm_squared = 0.0;
    double weight_norm_squared = 0.0;
    for (std::uint64_t index = 0; index < total; ++index) {
        numerator = numerator + complex_conj(x[index]) * ax[index];
        denominator = denominator + complex_conj(x[index]) * bx[index];
        ax_norm_squared += complex_abs2(ax[index]);
        bx_norm_squared += complex_abs2(bx[index]);
        if (index < nq) {
            q_norm_squared += complex_abs2(x[index]);
        } else if (gauge && index < nq + np) {
            gauge_residual = gauge_residual +
                x[index] * phi_mean_weights[index - nq];
        }
    }
    const GpuComplex lambda = numerator / denominator;
    for (std::uint64_t row = 0; row < nq; ++row) {
        const GpuComplex aqq = csr_row_dot(a_qq, row, x, 0u);
        const GpuComplex aqphi = csr_row_dot(a_qphi, row, x, nq);
        const GpuComplex bqq = csr_row_dot(b_qq, row, x, 0u);
        const GpuComplex residual = aqq + aqphi - lambda * bqq;
        q_residual_squared += complex_abs2(residual);
        q_aqq_squared += complex_abs2(aqq);
        q_aqphi_squared += complex_abs2(aqphi);
        q_bqq_squared += complex_abs2(bqq);
    }
    for (std::uint64_t row = 0; row < np; ++row) {
        const GpuComplex phiq = csr_row_dot(a_phiq, row, x, 0u);
        const GpuComplex phiphi = csr_row_dot(a_phiphi, row, x, nq);
        const GpuComplex gauge_term = gauge ?
            x[nq + np] * phi_mean_weights[row] : make_complex(0.0, 0.0);
        const GpuComplex residual = phiq + phiphi + gauge_term;
        phi_residual_squared += complex_abs2(residual);
        phi_phiq_squared += complex_abs2(phiq);
        phi_phiphi_squared += complex_abs2(phiphi);
        phi_norm_squared += complex_abs2(x[nq + row]);
        if (gauge) {
            weight_norm_squared += phi_mean_weights[row] * phi_mean_weights[row];
        }
    }
    for (std::uint64_t index = 0; index < total; ++index) {
        const GpuComplex residual = ax[index] - lambda * bx[index];
        residual_squared += complex_abs2(residual);
    }
    const double denominator_norm = std::sqrt(complex_abs2(denominator));
    const double scale = std::sqrt(ax_norm_squared) +
        std::sqrt(complex_abs2(lambda)) * std::sqrt(bx_norm_squared) + 1.0e-300;
    const double q_scale = std::sqrt(q_aqq_squared) +
        std::sqrt(q_aqphi_squared) + std::sqrt(complex_abs2(lambda)) *
        std::sqrt(q_bqq_squared) + 1.0e-30;
    const double phi_scale = std::sqrt(phi_phiq_squared) +
        std::sqrt(phi_phiphi_squared) +
        (gauge ? std::sqrt(weight_norm_squared) * std::sqrt(complex_abs2(x[nq + np])) : 0.0) +
        1.0e-30;
    const double gauge_scale = std::sqrt(weight_norm_squared) *
        std::sqrt(phi_norm_squared) + 1.0e-30;
    out->lambda_real = lambda.real;
    out->lambda_imag = lambda.imag;
    out->residual_relative = std::sqrt(residual_squared) / scale;
    out->q_norm = std::sqrt(q_norm_squared);
    out->denominator_abs = denominator_norm;
    out->gauge_constraint_abs = std::sqrt(complex_abs2(gauge_residual));
    out->magnetic_block_backward_error = std::sqrt(q_residual_squared) / q_scale;
    out->poisson_block_backward_error = std::sqrt(phi_residual_squared) / phi_scale;
    out->gauge_constraint_backward_error = gauge ?
        std::sqrt(complex_abs2(gauge_residual)) / gauge_scale : 0.0;
    out->residual_relative = fmax(
        out->magnetic_block_backward_error,
        fmax(out->poisson_block_backward_error, out->gauge_constraint_backward_error));
}

void copy_error(char *destination, std::size_t size, const char *message) noexcept
{
    if (destination == nullptr || size == 0) {
        return;
    }
    std::strncpy(destination, message != nullptr ? message : "", size - 1u);
    destination[size - 1u] = '\0';
}

bool cuda_ok(cudaError_t status, char *error_message, unsigned long long error_len)
{
    if (status == cudaSuccess) {
        return true;
    }
    if (error_message != nullptr && error_len > 0u) {
        std::snprintf(
            error_message,
            static_cast<std::size_t>(error_len),
            "CUDA modal K0 operation failed: %s",
            cudaGetErrorString(status));
    }
    return false;
}

bool cuda_device_available(char *error_message, unsigned long long error_len)
{
    int device_count = 0;
    const cudaError_t status = cudaGetDeviceCount(&device_count);
    if (status != cudaSuccess) {
        if (error_message != nullptr && error_len > 0u) {
            std::snprintf(
                error_message,
                static_cast<std::size_t>(error_len),
                "CUDA modal K0 runtime unavailable: %s",
                cudaGetErrorString(status));
        }
        // Clear the sticky runtime error so a subsequent managed call can
        // report its own device state rather than inheriting this probe.
        cudaGetLastError();
        return false;
    }
    if (device_count <= 0) {
        copy_error(
            error_message,
            static_cast<std::size_t>(error_len),
            "CUDA modal K0 runtime unavailable: no CUDA device is present");
        return false;
    }
    return true;
}

template <typename T>
bool allocate_device(T **out, std::uint64_t count, char *error_message, unsigned long long error_len)
{
    *out = nullptr;
    if (count == 0u) {
        return true;
    }
    std::size_t bytes = 0;
    if (fd::checked_bytes_limited(
            count,
            sizeof(T),
            fd::kMaxFrequencyDomainWorkspaceBytes,
            bytes) != fd::CheckedExtentStatus::ok) {
        copy_error(error_message, static_cast<std::size_t>(error_len), "GPU modal K0 allocation exceeds the workspace limit");
        return false;
    }
    return cuda_ok(cudaMalloc(out, bytes), error_message, error_len);
}

template <typename T>
bool copy_to_device(T **out, const T *source, std::uint64_t count, char *error_message, unsigned long long error_len)
{
    if (source == nullptr && count != 0u) {
        copy_error(error_message, static_cast<std::size_t>(error_len), "GPU modal K0 CSR input is null");
        return false;
    }
    if (!allocate_device(out, count, error_message, error_len)) {
        return false;
    }
    if (count == 0u) {
        return true;
    }
    std::size_t bytes = 0;
    if (fd::checked_bytes_limited(
            count,
            sizeof(T),
            fd::kMaxFrequencyDomainWorkspaceBytes,
            bytes) != fd::CheckedExtentStatus::ok) {
        return false;
    }
    return cuda_ok(cudaMemcpy(*out, source, bytes, cudaMemcpyHostToDevice), error_message, error_len);
}

void destroy_csr(DeviceCsr *matrix) noexcept
{
    if (matrix == nullptr) {
        return;
    }
    cudaFree(matrix->row_offsets);
    cudaFree(matrix->column_indices);
    cudaFree(matrix->values);
    *matrix = DeviceCsr{};
}

bool upload_csr(const fd::CsrMatrixView &source, DeviceCsr *destination, char *error_message, unsigned long long error_len)
{
    if (destination == nullptr || source.row_count == 0u || source.column_count == 0u ||
        source.row_offsets == nullptr || source.row_offsets_len != source.row_count + 1u ||
        (source.values_len > 0u &&
         (source.column_indices == nullptr || source.values == nullptr)) ||
        source.column_indices_len != source.values_len ||
        source.row_offsets[source.row_count] != source.values_len ||
        source.values_len > std::numeric_limits<std::uint32_t>::max()) {
        copy_error(error_message, static_cast<std::size_t>(error_len), "GPU modal K0 CSR descriptor is invalid");
        return false;
    }
    for (std::uint64_t row = 0; row < source.row_count; ++row) {
        if (source.row_offsets[row] > source.row_offsets[row + 1u]) {
            copy_error(error_message, static_cast<std::size_t>(error_len), "GPU modal K0 CSR row offsets are not monotone");
            return false;
        }
    }
    destination->rows = source.row_count;
    destination->columns = source.column_count;
    return copy_to_device(
               &destination->row_offsets,
               source.row_offsets,
               source.row_offsets_len,
               error_message,
               error_len) &&
        copy_to_device(
            &destination->column_indices,
            source.column_indices,
            source.column_indices_len,
            error_message,
            error_len) &&
        copy_to_device(
            &destination->values,
            source.values,
            source.values_len,
            error_message,
            error_len);
}

bool has_string(const char *value, const char *expected) noexcept
{
    return value != nullptr && expected != nullptr && std::strcmp(value, expected) == 0;
}

bool finite_valid_csr(
    const fd::CsrMatrixView &matrix,
    std::uint64_t rows,
    std::uint64_t columns)
{
    if (matrix.row_count != rows || matrix.column_count != columns ||
        matrix.row_offsets == nullptr || matrix.row_offsets_len != rows + 1u ||
        matrix.column_indices_len != matrix.values_len ||
        matrix.row_offsets[0] != 0u ||
        matrix.row_offsets[rows] != matrix.values_len ||
        matrix.values_len > std::numeric_limits<std::uint32_t>::max()) {
        return false;
    }
    if (matrix.values_len > 0u &&
        (matrix.column_indices == nullptr || matrix.values == nullptr)) {
        return false;
    }
    for (std::uint64_t row = 0; row < rows; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (matrix.column_indices[entry] >= columns ||
            !std::isfinite(matrix.values[entry])) {
            return false;
        }
    }
    return true;
}

using HostComplex = std::complex<double>;

bool host_qr_decompose(
    const std::vector<HostComplex> &matrix,
    std::size_t dimension,
    std::vector<HostComplex> *q,
    std::vector<HostComplex> *r)
{
    if (q == nullptr || r == nullptr || matrix.size() != dimension * dimension) {
        return false;
    }
    q->assign(dimension * dimension, HostComplex{});
    r->assign(dimension * dimension, HostComplex{});
    std::vector<HostComplex> column(dimension);
    for (std::size_t j = 0; j < dimension; ++j) {
        for (std::size_t row = 0; row < dimension; ++row) {
            column[row] = matrix[row * dimension + j];
        }
        for (std::size_t i = 0; i < j; ++i) {
            HostComplex projection{};
            for (std::size_t row = 0; row < dimension; ++row) {
                projection += std::conj((*q)[row * dimension + i]) * column[row];
            }
            (*r)[i * dimension + j] = projection;
            for (std::size_t row = 0; row < dimension; ++row) {
                column[row] -= projection * (*q)[row * dimension + i];
            }
        }
        double norm_squared = 0.0;
        for (const HostComplex value : column) {
            norm_squared += std::norm(value);
        }
        const double norm = std::sqrt(norm_squared);
        if (!std::isfinite(norm) || norm <= 1.0e-14) {
            return false;
        }
        (*r)[j * dimension + j] = HostComplex(norm, 0.0);
        for (std::size_t row = 0; row < dimension; ++row) {
            (*q)[row * dimension + j] = column[row] / norm;
        }
    }
    return true;
}

std::vector<HostComplex> host_hessenberg_eigenvalues(
    const std::vector<HostComplex> &hessenberg,
    std::size_t dimension)
{
    if (dimension == 0u || hessenberg.size() != dimension * dimension) {
        return {};
    }
    std::vector<HostComplex> matrix = hessenberg;
    double matrix_norm = 0.0;
    for (const HostComplex value : matrix) {
        matrix_norm += std::norm(value);
    }
    const double convergence_tolerance =
        1.0e-11 * (std::sqrt(matrix_norm) + 1.0);
    constexpr std::size_t kMaxQrIterations = 2048u;
    for (std::size_t iteration = 0; iteration < kMaxQrIterations; ++iteration) {
        double lower_norm = 0.0;
        for (std::size_t row = 1u; row < dimension; ++row) {
            for (std::size_t column = 0u; column < row; ++column) {
                lower_norm += std::norm(matrix[row * dimension + column]);
            }
        }
        if (std::sqrt(lower_norm) <= convergence_tolerance) {
            break;
        }
        const HostComplex shift = matrix[(dimension - 1u) * dimension + dimension - 1u];
        std::vector<HostComplex> shifted = matrix;
        for (std::size_t index = 0u; index < dimension; ++index) {
            shifted[index * dimension + index] -= shift;
        }
        std::vector<HostComplex> q;
        std::vector<HostComplex> r;
        if (!host_qr_decompose(shifted, dimension, &q, &r)) {
            break;
        }
        std::vector<HostComplex> updated(dimension * dimension, HostComplex{});
        for (std::size_t row = 0u; row < dimension; ++row) {
            for (std::size_t column = 0u; column < dimension; ++column) {
                HostComplex value{};
                for (std::size_t index = 0u; index < dimension; ++index) {
                    value += r[row * dimension + index] * q[index * dimension + column];
                }
                updated[row * dimension + column] = value;
            }
        }
        for (std::size_t index = 0u; index < dimension; ++index) {
            updated[index * dimension + index] += shift;
        }
        matrix.swap(updated);
    }
    std::vector<HostComplex> eigenvalues(dimension);
    for (std::size_t index = 0u; index < dimension; ++index) {
        eigenvalues[index] = matrix[index * dimension + index];
    }
    return eigenvalues;
}

bool host_eigenvector_for_value(
    const std::vector<HostComplex> &matrix,
    std::size_t dimension,
    HostComplex eigenvalue,
    std::vector<HostComplex> *out_vector)
{
    if (out_vector == nullptr || matrix.size() != dimension * dimension || dimension == 0u) {
        return false;
    }
    std::vector<HostComplex> reduced = matrix;
    for (std::size_t index = 0u; index < dimension; ++index) {
        reduced[index * dimension + index] -= eigenvalue;
    }
    std::vector<std::size_t> pivot_columns;
    std::vector<std::size_t> pivot_rows;
    std::vector<bool> used_rows(dimension, false);
    const double tolerance = 1.0e-7 * (std::abs(eigenvalue) + 1.0);
    for (std::size_t column = 0u; column < dimension; ++column) {
        std::size_t best_row = dimension;
        double best_norm = tolerance;
        for (std::size_t row = 0u; row < dimension; ++row) {
            if (used_rows[row]) {
                continue;
            }
            const double candidate = std::abs(reduced[row * dimension + column]);
            if (candidate > best_norm) {
                best_norm = candidate;
                best_row = row;
            }
        }
        if (best_row == dimension) {
            continue;
        }
        used_rows[best_row] = true;
        pivot_columns.push_back(column);
        pivot_rows.push_back(best_row);
        const HostComplex pivot = reduced[best_row * dimension + column];
        for (std::size_t other_row = 0u; other_row < dimension; ++other_row) {
            if (other_row == best_row) {
                continue;
            }
            const HostComplex factor = reduced[other_row * dimension + column] / pivot;
            for (std::size_t other_column = column; other_column < dimension; ++other_column) {
                reduced[other_row * dimension + other_column] -=
                    factor * reduced[best_row * dimension + other_column];
            }
        }
    }
    std::size_t free_column = dimension;
    for (std::size_t column = 0u; column < dimension; ++column) {
        if (std::find(pivot_columns.begin(), pivot_columns.end(), column) == pivot_columns.end()) {
            free_column = column;
            break;
        }
    }
    if (free_column == dimension) {
        if (pivot_columns.empty()) {
            return false;
        }
        free_column = pivot_columns.back();
        pivot_columns.pop_back();
        pivot_rows.pop_back();
    }
    out_vector->assign(dimension, HostComplex{});
    (*out_vector)[free_column] = HostComplex(1.0, 0.0);
    for (std::size_t index = pivot_columns.size(); index-- > 0u;) {
        const std::size_t column = pivot_columns[index];
        const std::size_t row = pivot_rows[index];
        HostComplex value{};
        for (std::size_t other_column = column + 1u; other_column < dimension; ++other_column) {
            value += reduced[row * dimension + other_column] * (*out_vector)[other_column];
        }
        const HostComplex diagonal = reduced[row * dimension + column];
        if (std::abs(diagonal) <= tolerance) {
            return false;
        }
        (*out_vector)[column] = -value / diagonal;
    }
    double norm_squared = 0.0;
    for (const HostComplex value : *out_vector) {
        norm_squared += std::norm(value);
    }
    const double norm = std::sqrt(norm_squared);
    if (!std::isfinite(norm) || norm <= 1.0e-14) {
        return false;
    }
    for (HostComplex &value : *out_vector) {
        value /= norm;
    }
    return true;
}

void write_gpu_diagnostics(
    const fd::PoissonAirboxEigenBlockProblem &problem,
    const fd::PoissonAirboxModalEigenResult &result,
    const char *status,
    const char *reason,
    std::uint64_t operator_apply_count,
    std::uint64_t outer_iterations,
    std::uint64_t linear_iterations,
    std::uint64_t setup_h2d_transfer_count,
    std::uint64_t linear_control_d2h_transfer_count,
    std::uint64_t final_d2h_transfer_count,
    fd::PoissonAirboxModalEigenResult *out) noexcept
{
    if (out == nullptr) {
        return;
    }
    const bool small_device_lu =
        result.q_dof_count + result.phi_dof_count +
        (has_string(problem.gauge_policy, "mean_zero_augmented") ? 1u : 0u) <=
        kDenseDeviceSolveDofs;
    const bool dense_action = small_device_lu;
    // This adapter keeps the sparse operator, shifted action and full vectors
    // on the device, but its projected Hessenberg/Ritz extraction is still
    // host-side.  It is therefore a bounded validation lane, not the
    // production `gpu_modal_device_krylov` claim.  The managed production GPU
    // lane is the PETSc/SLEPc CUDA adapter in modal_petsc_slepc.cpp.
    const bool production_implication = false;
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_modal_eigen_gpu.v1\","
        "\"status\":\"%s\","
        "\"reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_adapter\":\"k0_poisson_airbox_gpu_modal_device_krylov\","
        "\"execution_lane\":\"validation_gpu_operator_host_krylov\","
        "\"requested_execution\":\"production_gpu\","
        "\"resolved_execution\":\"production_gpu\","
        "\"operator_family\":\"full_coupled_poisson_airbox_modal_pencil\","
        "\"spectral_transform\":\"complex_shift_invert\","
        "\"target_representation\":\"sigma=i*omega_target\","
        "\"assembly_kind\":\"%s\","
        "\"outer_boundary_kind\":\"%s\","
        "\"phasor_convention\":\"exp_plus_i_omega_t\","
        "\"eigenvalue_convention\":\"lambda_imag_positive_frequency\","
        "\"production_implication\":%s,"
        "\"validation_only\":%s,"
        "\"target_frequency_hz\":%.17g,"
        "\"target_kind\":\"%s\","
        "\"frequency_min_hz\":%.17g,"
        "\"frequency_max_hz\":%.17g,"
        "\"target_omega_rad_s\":%.17g,"
        "\"residual_tolerance\":%.17g,"
        "\"inner_linear_tolerance\":%.17g,"
        "\"demag_kind\":\"%s\","
        "\"gauge_policy\":\"%s\","
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"accepted_mode_count\":%u,"
        "\"persistent_solver_context\":false,"
        "\"persistent_context_verified\":false,"
        "\"gpu_device_resident_modal_eigensolver\":false,"
        "\"operator_storage\":\"device_csr\","
        "\"krylov_vector_location\":\"device\","
        "\"linear_solver\":\"%s\","
        "\"modal_iteration_method\":\"%s\","
        "\"ritz_state_location\":\"%s\","
        "\"host_ritz_extraction\":%s,"
        "\"scalable_selected_spectrum\":false,"
        "\"preconditioner\":\"shifted_2x2_block_jacobi\","
        "\"operator_buffer_location\":\"device\","
        "\"preconditioner_buffer_location\":\"device\","
        "\"cpu_fallback\":\"disabled\","
        "\"fallback_used\":false,"
        "\"setup_h2d_transfer_count\":%llu,"
        "\"final_d2h_transfer_count\":%llu,"
        "\"per_iteration_h2d_transfer_count\":0,"
        "\"per_iteration_d2h_transfer_count\":0,"
        "\"per_iteration_transfer_telemetry_measured\":false,"
        "\"hot_loop_telemetry_measured\":false,"
        "\"linear_control_d2h_transfer_count\":%llu,"
        "\"operator_apply_count\":%llu,"
        "\"outer_iteration_count\":%llu,"
        "\"linear_iteration_count\":%llu,"
        "\"last_lambda_real\":%.17g,"
        "\"last_lambda_imag\":%.17g,"
        "\"last_residual_relative\":%.17g,"
        "\"magnetic_block_backward_error\":%.17g,"
        "\"poisson_block_backward_error\":%.17g,"
        "\"gauge_constraint_backward_error\":%.17g,"
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"full_residual_certified\":%s"
        "}",
        status != nullptr ? status : "unknown",
        reason != nullptr ? reason : "",
        problem.assembly_kind != nullptr ? problem.assembly_kind : "",
        problem.outer_boundary_kind != nullptr ? problem.outer_boundary_kind : "",
        production_implication ? "true" : "false",
        production_implication ? "false" : "true",
        problem.target_frequency_hz,
        problem.target_kind != nullptr ? problem.target_kind : "",
        problem.frequency_min_hz,
        problem.frequency_max_hz,
        problem.target_frequency_hz * 2.0 * 3.14159265358979323846264338327950288,
        problem.residual_tolerance,
        std::max(1.0e-12, std::min(1.0e-6, problem.residual_tolerance * 0.5)),
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        result.accepted_mode_count,
        small_device_lu ? "device_dense_lu_small" :
            (dense_action ? "device_dense_lu_arnoldi_action" : "device_bicgstab"),
        small_device_lu ? "device_dense_validation" : "arnoldi_ritz",
        small_device_lu ? "device_dense" : "host_small_projected",
        small_device_lu ? "false" : "true",
        static_cast<unsigned long long>(setup_h2d_transfer_count),
        static_cast<unsigned long long>(final_d2h_transfer_count),
        static_cast<unsigned long long>(linear_control_d2h_transfer_count),
        static_cast<unsigned long long>(operator_apply_count),
        static_cast<unsigned long long>(outer_iterations),
        static_cast<unsigned long long>(linear_iterations),
        result.eigenvalue_real,
        result.eigenvalue_imag,
        result.eigen_residual_relative,
        result.magnetic_block_backward_error,
        result.poisson_block_backward_error,
        result.gauge_constraint_backward_error,
        result.poisson_constraint_relative_residual,
        result.full_residual_certified ? "true" : "false");
}

bool cuda_modal_problem_supported(
    const fd::PoissonAirboxEigenBlockProblem &problem,
    fd::PoissonAirboxModalEigenResult *result,
    const char **failure_reason)
{
    if (result == nullptr) {
        return false;
    }
    if (failure_reason != nullptr) {
        *failure_reason = "gpu_modal_device_krylov_scope_mismatch";
    }
    result->q_dof_count = problem.q_dof_count;
    result->phi_dof_count = problem.phi_dof_count;
    result->augmented_dof_count = problem.q_dof_count + problem.phi_dof_count;
    if (has_string(problem.gauge_policy, "mean_zero_augmented")) {
        result->augmented_dof_count += 1u;
    }
    result->magnetic_pair_count = problem.magnetic_pair_count;
    result->airbox_pair_count = problem.airbox_pair_count;
    result->expected_reference_frequency_hz = problem.expected_reference_frequency_hz;
    const bool robin = has_string(problem.outer_boundary_kind, "poisson_robin");
    const bool dirichlet = has_string(problem.outer_boundary_kind, "poisson_dirichlet");
    const bool pure_neumann = has_string(problem.outer_boundary_kind, "pure_neumann");
    const bool gauge = has_string(problem.gauge_policy, "mean_zero_augmented");
    const bool no_gauge = has_string(problem.gauge_policy, "none");
    const bool gauge_reason_matches =
        (pure_neumann && has_string(problem.gauge_reason, "pure_neumann_nullspace")) ||
        ((robin || dirichlet) && has_string(problem.gauge_reason, "coercive_outer_boundary"));
    const bool valid_boundary_gauge =
        ((robin || dirichlet) && no_gauge &&
         (!robin || (std::isfinite(problem.robin_beta) && problem.robin_beta > 0.0))) ||
        (pure_neumann && gauge && problem.phi_mean_weights != nullptr &&
         problem.phi_mean_weights_count == problem.phi_dof_count);
    const bool nearest_target = has_string(problem.target_kind, "nearest_frequency");
    const bool window_target = has_string(problem.target_kind, "frequency_window");
    const bool valid_target =
        (nearest_target && std::isfinite(problem.target_frequency_hz) &&
         problem.target_frequency_hz > 0.0) ||
        (window_target && std::isfinite(problem.frequency_min_hz) &&
         std::isfinite(problem.frequency_max_hz) &&
         problem.frequency_min_hz >= 0.0 &&
         problem.frequency_max_hz > problem.frequency_min_hz &&
         std::isfinite(problem.target_frequency_hz) &&
         problem.target_frequency_hz >= problem.frequency_min_hz &&
         problem.target_frequency_hz <= problem.frequency_max_hz);
    const bool valid_requested_count = problem.requested_mode_count > 0u &&
        problem.requested_mode_count <= kMaxGpuModalModes;
    const bool valid_iteration_budgets = problem.max_outer_iterations > 0u &&
        problem.max_linear_iterations > 0u;
    if (!has_string(problem.assembly_kind, "mfem_weak_form_shared_domain") ||
        !has_string(problem.demag_kind, "periodic_airbox_k0") ||
        !has_string(problem.phasor_convention, "exp_plus_i_omega_t") ||
        !has_string(problem.eigenvalue_convention, "lambda_imag_positive_frequency") ||
        !has_string(problem.periodic_mesh_certificate_schema, "periodic_mesh_certificate.v6") ||
        !valid_boundary_gauge ||
        !gauge_reason_matches ||
        problem.q_dof_count < 2u || (problem.q_dof_count & 1u) != 0u ||
        problem.phi_dof_count == 0u ||
        problem.magnetic_pair_count == 0u || problem.airbox_pair_count == 0u ||
        problem.q_dof_count + problem.phi_dof_count > kMaxGpuModalDofs ||
        !valid_requested_count || !valid_target || !valid_iteration_budgets ||
        !std::isfinite(problem.residual_tolerance) || problem.residual_tolerance <= 0.0) {
        copy_error(
            result->error_message,
            sizeof(result->error_message),
            "GPU modal K0 requires a shared-domain P1 descriptor with boundary-consistent gauge provenance and a valid nearest-frequency or frequency-window target");
        if (failure_reason != nullptr) {
            *failure_reason = !valid_requested_count
                ? "gpu_k0_requested_mode_count_invalid"
                : !valid_target
                    ? "gpu_k0_target_invalid"
                    : !valid_iteration_budgets
                        ? "gpu_k0_iteration_budget_invalid"
                        : "gpu_modal_device_krylov_scope_mismatch";
        }
        return false;
    }
    if (gauge) {
        long double weight_sum = 0.0L;
        for (std::uint64_t index = 0; index < problem.phi_mean_weights_count; ++index) {
            const double weight = problem.phi_mean_weights[index];
            if (!std::isfinite(weight) || !(weight > 0.0)) {
                copy_error(
                    result->error_message,
                    sizeof(result->error_message),
                    "GPU modal K0 mean-zero gauge weights must be finite and positive");
                if (failure_reason != nullptr) {
                    *failure_reason = "gpu_k0_gauge_weights_invalid";
                }
                return false;
            }
            weight_sum += static_cast<long double>(weight);
        }
        if (std::abs(static_cast<double>(weight_sum - 1.0L)) > 1.0e-10) {
            copy_error(
                result->error_message,
                sizeof(result->error_message),
                "GPU modal K0 mean-zero gauge weights must sum to one");
            if (failure_reason != nullptr) {
                *failure_reason = "gpu_k0_gauge_weights_invalid";
            }
            return false;
        }
    }
    if (!finite_valid_csr(problem.A_qq, problem.q_dof_count, problem.q_dof_count) ||
        !finite_valid_csr(problem.A_qphi, problem.q_dof_count, problem.phi_dof_count) ||
        !finite_valid_csr(problem.A_phiq, problem.phi_dof_count, problem.q_dof_count) ||
        !finite_valid_csr(problem.A_phiphi, problem.phi_dof_count, problem.phi_dof_count) ||
        !finite_valid_csr(problem.B_qq, problem.q_dof_count, problem.q_dof_count)) {
        copy_error(
            result->error_message,
            sizeof(result->error_message),
            "GPU modal K0 requires finite in-range CSR blocks with matching dimensions");
        if (failure_reason != nullptr) {
            *failure_reason = "gpu_k0_csr_invalid";
        }
        return false;
    }
    return true;
}

} // namespace

namespace fullmag::fem::frequency_domain {

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_device_krylov(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxModalEigenResult{};
    char runtime_error[256]{};
    if (!cuda_device_available(runtime_error, sizeof(runtime_error))) {
        out_result->status = FrequencyDomainStatus::unavailable;
        copy_error(out_result->error_message, sizeof(out_result->error_message), runtime_error);
        write_gpu_diagnostics(
            problem,
            *out_result,
            "unavailable",
            "cuda_runtime_unavailable",
            0u,
            0u,
            0u,
            0u,
            0u,
            0u,
            out_result);
        return out_result->status;
    }
    const char *validation_failure_reason = "gpu_modal_device_krylov_scope_mismatch";
    if (!cuda_modal_problem_supported(problem, out_result, &validation_failure_reason)) {
        write_gpu_diagnostics(
            problem,
            *out_result,
            "validation_error",
            validation_failure_reason,
            0u,
            0u,
            0u,
            0u,
            0u,
            0u,
            out_result);
        out_result->status = FrequencyDomainStatus::validation_error;
        return out_result->status;
    }

    const std::uint64_t nq = problem.q_dof_count;
    const std::uint64_t np = problem.phi_dof_count;
    const bool gauge = has_string(problem.gauge_policy, "mean_zero_augmented");
    const std::uint64_t total = nq + np + (gauge ? 1u : 0u);
    const bool dense_device_workspace = total <= kDenseDeviceSolveDofs;
    // Dense factorization is reserved for the tiny validation lane.  Larger
    // modal problems must exercise the persistent device Krylov action so the
    // selected-spectrum diagnostics cannot be promoted by a bounded dense
    // substitute.
    const bool dense_action_workspace = dense_device_workspace;
    const std::uint64_t dense_entries = total * total;
    const unsigned int blocks = static_cast<unsigned int>((total + kBlockSize - 1u) / kBlockSize);
    const std::uint32_t mode_count = std::max<std::uint32_t>(1u, problem.requested_mode_count);
    const std::uint32_t linear_iterations = std::max<std::uint32_t>(64u, problem.max_linear_iterations);
    const std::uint32_t outer_iterations = std::max<std::uint32_t>(
        128u,
        std::max<std::uint32_t>(8u, problem.max_outer_iterations));
    const double linear_tolerance = std::max(
        1.0e-12,
        std::min(1.0e-6, problem.residual_tolerance * 0.5));
    const double target_omega =
        problem.target_frequency_hz * 2.0 * 3.14159265358979323846264338327950288;
    const GpuComplex sigma = make_complex(0.0, target_omega);

    DeviceCsr a_qq{}, a_qphi{}, a_phiq{}, a_phiphi{}, b_qq{};
    double *d_phi_mean_weights = nullptr;
    double *d_norm_squared = nullptr;
    double *d_rhs_norm_squared = nullptr;
    double *d_residual_norm_squared = nullptr;
    int *d_status = nullptr;
    GpuComplex *d_x = nullptr;
    GpuComplex *d_rhs = nullptr;
    GpuComplex *d_iter_a = nullptr;
    GpuComplex *d_r = nullptr;
    GpuComplex *d_rhat = nullptr;
    GpuComplex *d_p = nullptr;
    GpuComplex *d_phat = nullptr;
    GpuComplex *d_v = nullptr;
    GpuComplex *d_s = nullptr;
    GpuComplex *d_shat = nullptr;
    GpuComplex *d_t = nullptr;
    GpuComplex *d_rho = nullptr;
    GpuComplex *d_rho_old = nullptr;
    GpuComplex *d_alpha = nullptr;
    GpuComplex *d_omega = nullptr;
    GpuComplex *d_dot_1 = nullptr;
    GpuComplex *d_dot_2 = nullptr;
    GpuComplex *d_ax = nullptr;
    GpuComplex *d_bx = nullptr;
    GpuComplex *d_dense_matrix = nullptr;
    GpuComplex *d_dense_work = nullptr;
    GpuComplex *d_locked = nullptr;
    GpuComplex *d_coefficients = nullptr;
    DeviceModalMetrics *d_metrics = nullptr;
    GpuComplex *d_arnoldi_basis = nullptr;
    GpuComplex *d_arnoldi_hessenberg = nullptr;
    GpuComplex *d_arnoldi_coefficients = nullptr;
    GpuComplex *d_ritz = nullptr;
    const std::uint32_t arnoldi_dimension = std::min<std::uint32_t>(
        24u,
        std::max<std::uint32_t>(8u, mode_count * 2u + 4u));
    char error_message[256]{};
    bool ok =
        upload_csr(problem.A_qq, &a_qq, error_message, sizeof(error_message)) &&
        upload_csr(problem.A_qphi, &a_qphi, error_message, sizeof(error_message)) &&
        upload_csr(problem.A_phiq, &a_phiq, error_message, sizeof(error_message)) &&
        upload_csr(problem.A_phiphi, &a_phiphi, error_message, sizeof(error_message)) &&
        upload_csr(problem.B_qq, &b_qq, error_message, sizeof(error_message));

    ok = ok &&
        allocate_device(&d_phi_mean_weights, gauge ? np : 0u, error_message, sizeof(error_message)) &&
        allocate_device(&d_norm_squared, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_rhs_norm_squared, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_residual_norm_squared, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_status, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_x, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_rhs, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_iter_a, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_r, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_rhat, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_p, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_phat, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_v, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_s, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_shat, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_t, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_rho, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_rho_old, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_alpha, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_omega, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_dot_1, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_dot_2, 1u, error_message, sizeof(error_message)) &&
        allocate_device(&d_ax, total, error_message, sizeof(error_message)) &&
        allocate_device(&d_bx, total, error_message, sizeof(error_message)) &&
        (!dense_action_workspace ||
         (allocate_device(&d_dense_matrix, dense_entries, error_message, sizeof(error_message)) &&
          allocate_device(&d_dense_work, dense_entries, error_message, sizeof(error_message)))) &&
        allocate_device(&d_locked, static_cast<std::uint64_t>(mode_count) * total, error_message, sizeof(error_message)) &&
        allocate_device(&d_coefficients, mode_count, error_message, sizeof(error_message)) &&
        allocate_device(&d_metrics, 1u, error_message, sizeof(error_message)) &&
        (dense_device_workspace ||
         (allocate_device(
              &d_arnoldi_basis,
              static_cast<std::uint64_t>(arnoldi_dimension + 1u) * total,
              error_message,
              sizeof(error_message)) &&
          allocate_device(
              &d_arnoldi_hessenberg,
              static_cast<std::uint64_t>(arnoldi_dimension + 1u) * arnoldi_dimension,
              error_message,
              sizeof(error_message)) &&
          allocate_device(
              &d_arnoldi_coefficients,
              arnoldi_dimension,
              error_message,
              sizeof(error_message)) &&
          allocate_device(&d_ritz, total, error_message, sizeof(error_message))));
    if (ok) {
        if (gauge) {
            ok = cuda_ok(
                cudaMemcpy(
                    d_phi_mean_weights,
                    problem.phi_mean_weights,
                    sizeof(double) * np,
                    cudaMemcpyHostToDevice),
                error_message,
                sizeof(error_message));
        }
        if (ok && dense_action_workspace) {
            const unsigned int dense_blocks = static_cast<unsigned int>(
                (dense_entries + kBlockSize - 1u) / kBlockSize);
            fill_shifted_dense_kernel<<<dense_blocks, kBlockSize>>>(
                nq,
                np,
                gauge,
                sigma,
                a_qq,
                a_qphi,
                a_phiq,
                a_phiphi,
                b_qq,
                d_phi_mean_weights,
                d_dense_matrix);
            ok = cuda_ok(cudaGetLastError(), error_message, sizeof(error_message));
        }
    }

    std::uint64_t operator_apply_count = 0u;
    std::uint64_t total_linear_iterations = 0u;
    std::uint64_t total_outer_iterations = 0u;
    const std::uint64_t setup_h2d_transfer_count = 15u + (gauge ? 1u : 0u);
    std::uint64_t linear_control_d2h_transfer_count = 0u;
    bool cancellation_observed = false;
    auto cancellation_requested = [&]() noexcept {
        if (!fd::poisson_airbox_modal_cancel_requested(problem)) {
            return false;
        }
        cancellation_observed = true;
        copy_error(
            error_message,
            sizeof(error_message),
            "GPU modal K0 device Krylov solve was cancelled");
        return true;
    };
    std::vector<DeviceModalMetrics> host_metrics(static_cast<std::size_t>(mode_count));
    std::uint32_t completed_mode_count = 0u;
    if (ok && !dense_device_workspace) {
        auto apply_shifted_inverse = [&](const GpuComplex *input,
                                         GpuComplex *output,
                                         std::uint32_t seed) -> bool {
            if (cancellation_requested()) {
                return false;
            }
            cudaMemset(d_status, 0, sizeof(int));
            apply_mass_kernel<<<blocks, kBlockSize>>>(nq, np, gauge, b_qq, input, d_rhs);
            fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), output);
            copy_vector_kernel<<<blocks, kBlockSize>>>(total, d_rhs, d_r);
            cudaMemset(d_rhs_norm_squared, 0, sizeof(double));
            norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                total,
                d_rhs,
                d_rhs_norm_squared,
                d_status);
            if (dense_action_workspace) {
                const unsigned int dense_blocks = static_cast<unsigned int>(
                    (dense_entries + kBlockSize - 1u) / kBlockSize);
                copy_dense_matrix_kernel<<<dense_blocks, kBlockSize>>>(
                    dense_entries,
                    d_dense_matrix,
                    d_dense_work);
                dense_shifted_solve_kernel<<<1, 1>>>(
                    total,
                    d_dense_work,
                    d_rhs,
                    output,
                    d_status);
                compute_shifted_residual_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_dense_matrix,
                    d_rhs,
                    output,
                    d_r,
                    d_status);
                cudaMemset(d_residual_norm_squared, 0, sizeof(double));
                norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_r,
                    d_residual_norm_squared,
                    d_status);
                update_linear_convergence_kernel<<<1, 1>>>(
                    d_residual_norm_squared,
                    d_rhs_norm_squared,
                    linear_tolerance,
                    0u,
                    1u,
                    d_status);
                ++operator_apply_count;
                ++total_linear_iterations;
                int direct_status = 0;
                if (!cuda_ok(
                        cudaMemcpy(
                            &direct_status,
                            d_status,
                            sizeof(direct_status),
                            cudaMemcpyDeviceToHost),
                        error_message,
                        sizeof(error_message))) {
                    return false;
                }
                ++linear_control_d2h_transfer_count;
                if ((direct_status & kModalStatusConverged) == 0 ||
                    (direct_status & (kModalStatusBreakdown | kModalStatusNonFinite |
                                      kModalStatusLinearLimit)) != 0) {
                    std::snprintf(
                        error_message,
                        sizeof(error_message),
                        "GPU modal K0 dense Arnoldi shift solve failed (status=0x%x)",
                        direct_status);
                    return false;
                }
                return true;
            }
            initialize_bicgstab_shadow_kernel<<<blocks, kBlockSize>>>(
                total,
                d_r,
                seed,
                d_rhat);
            fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_p);
            fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_v);
            initialize_bicgstab_scalars_kernel<<<1, 1>>>(d_rho_old, d_alpha, d_omega);
            for (std::uint32_t linear = 0;
                 linear < linear_iterations && !cancellation_observed;
                 ++linear) {
                if (cancellation_requested()) {
                    break;
                }
                cudaMemset(d_rho, 0, sizeof(GpuComplex));
                complex_dot_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_rhat,
                    d_r,
                    d_rho,
                    d_status);
                bicgstab_update_p_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_rho,
                    d_rho_old,
                    d_alpha,
                    d_omega,
                    d_r,
                    d_v,
                    d_p,
                    d_status);
                block_jacobi_precondition_kernel<<<blocks, kBlockSize>>>(
                    nq,
                    np,
                    gauge,
                    sigma,
                    a_qq,
                    b_qq,
                    a_phiphi,
                    d_p,
                    d_phat,
                    d_status);
                apply_shifted_kernel<<<blocks, kBlockSize>>>(
                    nq,
                    np,
                    gauge,
                    sigma,
                    a_qq,
                    a_qphi,
                    a_phiq,
                    a_phiphi,
                    b_qq,
                    d_phi_mean_weights,
                    d_phat,
                    d_v,
                    d_status);
                ++operator_apply_count;
                cudaMemset(d_dot_2, 0, sizeof(GpuComplex));
                complex_dot_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_rhat,
                    d_v,
                    d_dot_2,
                    d_status);
                bicgstab_update_alpha_kernel<<<1, 1>>>(
                    d_rho,
                    d_dot_2,
                    d_alpha,
                    d_status);
                bicgstab_update_s_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_r,
                    d_v,
                    d_alpha,
                    d_s,
                    d_status);
                block_jacobi_precondition_kernel<<<blocks, kBlockSize>>>(
                    nq,
                    np,
                    gauge,
                    sigma,
                    a_qq,
                    b_qq,
                    a_phiphi,
                    d_s,
                    d_shat,
                    d_status);
                apply_shifted_kernel<<<blocks, kBlockSize>>>(
                    nq,
                    np,
                    gauge,
                    sigma,
                    a_qq,
                    a_qphi,
                    a_phiq,
                    a_phiphi,
                    b_qq,
                    d_phi_mean_weights,
                    d_shat,
                    d_t,
                    d_status);
                ++operator_apply_count;
                cudaMemset(d_dot_1, 0, sizeof(GpuComplex));
                cudaMemset(d_dot_2, 0, sizeof(GpuComplex));
                complex_dot_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_t,
                    d_s,
                    d_dot_1,
                    d_status);
                complex_dot_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_t,
                    d_t,
                    d_dot_2,
                    d_status);
                bicgstab_update_omega_kernel<<<1, 1>>>(
                    d_dot_1,
                    d_dot_2,
                    d_omega,
                    d_status);
                bicgstab_update_solution_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_alpha,
                    d_omega,
                    d_phat,
                    d_shat,
                    d_s,
                    d_t,
                    d_rho,
                    output,
                    d_r,
                    d_rho_old,
                    d_status);
                restart_bicgstab_after_happy_breakdown_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_r,
                    d_rhat,
                    d_p,
                    d_v,
                    d_rho_old,
                    d_alpha,
                    d_omega,
                    false,
                    d_status);
                cudaMemset(d_residual_norm_squared, 0, sizeof(double));
                norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_r,
                    d_residual_norm_squared,
                    d_status);
                update_linear_convergence_kernel<<<1, 1>>>(
                    d_residual_norm_squared,
                    d_rhs_norm_squared,
                    linear_tolerance,
                    linear,
                    linear_iterations,
                    d_status);
                restart_bicgstab_after_happy_breakdown_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_r,
                    d_rhat,
                    d_p,
                    d_v,
                    d_rho_old,
                    d_alpha,
                    d_omega,
                    true,
                    d_status);
                ++total_linear_iterations;
            }
            if (cancellation_observed) {
                return false;
            }
            int linear_status = 0;
            if (!cuda_ok(
                    cudaMemcpy(
                        &linear_status,
                        d_status,
                        sizeof(linear_status),
                        cudaMemcpyDeviceToHost),
                    error_message,
                    sizeof(error_message))) {
                return false;
            }
            ++linear_control_d2h_transfer_count;
            if ((linear_status & kModalStatusConverged) == 0 ||
                (linear_status & (kModalStatusBreakdown | kModalStatusNonFinite |
                                  kModalStatusLinearLimit)) != 0) {
                double final_residual_norm_squared = 0.0;
                double rhs_norm_squared = 0.0;
                cudaMemcpy(
                    &final_residual_norm_squared,
                    d_residual_norm_squared,
                    sizeof(final_residual_norm_squared),
                    cudaMemcpyDeviceToHost);
                cudaMemcpy(
                    &rhs_norm_squared,
                    d_rhs_norm_squared,
                    sizeof(rhs_norm_squared),
                    cudaMemcpyDeviceToHost);
                const double final_relative_residual =
                    rhs_norm_squared > 1.0e-300
                        ? std::sqrt(std::max(0.0, final_residual_norm_squared) /
                                    rhs_norm_squared)
                        : std::sqrt(std::max(0.0, final_residual_norm_squared));
                std::snprintf(
                    error_message,
                    sizeof(error_message),
                    "GPU modal K0 shifted Arnoldi solve did not converge (status=0x%x, residual=%.3e, tolerance=%.3e, max_iterations=%u)",
                    linear_status,
                    final_relative_residual,
                    linear_tolerance,
                    linear_iterations);
                return false;
            }
            return cuda_ok(cudaGetLastError(), error_message, sizeof(error_message));
        };

        const std::uint64_t hessenberg_stride =
            static_cast<std::uint64_t>(arnoldi_dimension) + 1u;
        const std::uint32_t max_cycles = std::max<std::uint32_t>(
            1u,
            (outer_iterations + arnoldi_dimension - 1u) / arnoldi_dimension);
        for (std::uint32_t cycle = 0u;
             cycle < max_cycles && ok && !cancellation_observed &&
                 completed_mode_count < mode_count;
             ++cycle) {
            if (cancellation_requested()) {
                ok = false;
                break;
            }
            cudaMemset(
                d_arnoldi_hessenberg,
                0,
                sizeof(GpuComplex) *
                    static_cast<std::size_t>(arnoldi_dimension + 1u) *
                    static_cast<std::size_t>(arnoldi_dimension));
            initialise_vector_kernel<<<blocks, kBlockSize>>>(
                nq,
                total,
                cycle * 131u + completed_mode_count + 17u,
                d_x);
            if (completed_mode_count > 0u) {
                cudaMemset(d_coefficients, 0, sizeof(GpuComplex) * mode_count);
                const unsigned int total_blocks = static_cast<unsigned int>(
                    (total + kBlockSize - 1u) / kBlockSize);
                compute_locked_coefficients_kernel<<<
                    dim3(completed_mode_count, total_blocks, 1u),
                    kBlockSize>>>(
                    total,
                    completed_mode_count,
                    d_locked,
                    d_x,
                    d_coefficients);
                subtract_locked_kernel<<<blocks, kBlockSize>>>(
                    total,
                    completed_mode_count,
                    d_coefficients,
                    d_locked,
                    d_x);
            }
            cudaMemset(d_status, 0, sizeof(int));
            cudaMemset(d_norm_squared, 0, sizeof(double));
            norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                total,
                d_x,
                d_norm_squared,
                d_status);
            scale_vector_by_q_norm_kernel<<<blocks, kBlockSize>>>(
                total,
                d_norm_squared,
                d_x);
            copy_vector_kernel<<<blocks, kBlockSize>>>(
                total,
                d_x,
                d_arnoldi_basis);
            std::uint32_t basis_count = 0u;
            for (std::uint32_t column = 0u;
                 column < arnoldi_dimension && ok && !cancellation_observed;
                 ++column) {
                if (cancellation_requested()) {
                    ok = false;
                    break;
                }
                ++total_outer_iterations;
                if (!apply_shifted_inverse(
                        d_arnoldi_basis + static_cast<std::uint64_t>(column) * total,
                        d_iter_a,
                        cycle * 977u + column + 1u)) {
                    ok = false;
                    break;
                }
                cudaMemset(d_status, 0, sizeof(int));
                for (std::uint32_t row = 0u;
                     row <= column && !cancellation_observed;
                     ++row) {
                    if (cancellation_requested()) {
                        ok = false;
                        break;
                    }
                    cudaMemset(d_dot_1, 0, sizeof(GpuComplex));
                    complex_dot_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_arnoldi_basis + static_cast<std::uint64_t>(row) * total,
                        d_iter_a,
                        d_dot_1,
                        d_status);
                    if (!cuda_ok(
                            cudaMemcpy(
                                d_arnoldi_hessenberg +
                                    static_cast<std::uint64_t>(row) * hessenberg_stride + column,
                                d_dot_1,
                                sizeof(GpuComplex),
                                cudaMemcpyDeviceToDevice),
                            error_message,
                            sizeof(error_message))) {
                        ok = false;
                        break;
                    }
                    subtract_basis_component_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_dot_1,
                        d_arnoldi_basis + static_cast<std::uint64_t>(row) * total,
                        d_iter_a,
                        d_status);
                }
                cudaMemset(d_norm_squared, 0, sizeof(double));
                norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_iter_a,
                    d_norm_squared,
                    d_status);
                double norm_squared = 0.0;
                if (!cuda_ok(
                        cudaMemcpy(
                            &norm_squared,
                            d_norm_squared,
                            sizeof(norm_squared),
                            cudaMemcpyDeviceToHost),
                        error_message,
                        sizeof(error_message))) {
                    ok = false;
                    break;
                }
                ++linear_control_d2h_transfer_count;
                if (!std::isfinite(norm_squared) || norm_squared <= 1.0e-24) {
                    basis_count = column + 1u;
                    break;
                }
                scale_vector_by_q_norm_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_norm_squared,
                    d_iter_a);
                copy_vector_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_iter_a,
                    d_arnoldi_basis + static_cast<std::uint64_t>(column + 1u) * total);
                basis_count = column + 1u;
            }
            if (!ok || basis_count == 0u) {
                continue;
            }
            const std::size_t hessenberg_entries =
                static_cast<std::size_t>(basis_count) * basis_count;
            std::vector<GpuComplex> hessenberg_device(
                static_cast<std::size_t>(basis_count + 1u) * basis_count);
            if (!cuda_ok(
                    cudaMemcpy(
                        hessenberg_device.data(),
                        d_arnoldi_hessenberg,
                        sizeof(GpuComplex) * hessenberg_device.size(),
                        cudaMemcpyDeviceToHost),
                    error_message,
                    sizeof(error_message))) {
                ok = false;
                break;
            }
            ++linear_control_d2h_transfer_count;
            std::vector<HostComplex> hessenberg(hessenberg_entries, HostComplex{});
            for (std::uint32_t row = 0u; row < basis_count; ++row) {
                for (std::uint32_t column = 0u;
                     column < basis_count && !cancellation_observed;
                     ++column) {
                    if (cancellation_requested()) {
                        ok = false;
                        break;
                    }
                    const GpuComplex value = hessenberg_device[
                        static_cast<std::size_t>(row) * hessenberg_stride + column];
                    hessenberg[static_cast<std::size_t>(row) * basis_count + column] =
                        HostComplex(value.real, value.imag);
                }
            }
            std::vector<HostComplex> eigenvalues = host_hessenberg_eigenvalues(
                hessenberg,
                basis_count);
            std::vector<std::size_t> candidate_indices(eigenvalues.size());
            for (std::size_t index = 0u; index < candidate_indices.size(); ++index) {
                candidate_indices[index] = index;
            }
            std::sort(
                candidate_indices.begin(),
                candidate_indices.end(),
                [&](std::size_t left, std::size_t right) {
                    const HostComplex left_lambda =
                        std::abs(eigenvalues[left]) > 1.0e-14 ?
                        HostComplex(0.0, target_omega) + HostComplex(1.0, 0.0) / eigenvalues[left] :
                        HostComplex(0.0, std::numeric_limits<double>::infinity());
                    const HostComplex right_lambda =
                        std::abs(eigenvalues[right]) > 1.0e-14 ?
                        HostComplex(0.0, target_omega) + HostComplex(1.0, 0.0) / eigenvalues[right] :
                        HostComplex(0.0, std::numeric_limits<double>::infinity());
                    return std::abs(left_lambda - HostComplex(0.0, target_omega)) <
                        std::abs(right_lambda - HostComplex(0.0, target_omega));
                });
            for (const std::size_t candidate_index : candidate_indices) {
                if (completed_mode_count >= mode_count) {
                    break;
                }
                const HostComplex mu = eigenvalues[candidate_index];
                if (!std::isfinite(mu.real()) || !std::isfinite(mu.imag()) ||
                    std::abs(mu) <= 1.0e-14) {
                    continue;
                }
                const HostComplex lambda =
                    HostComplex(0.0, target_omega) + HostComplex(1.0, 0.0) / mu;
                if (!std::isfinite(lambda.real()) || !std::isfinite(lambda.imag()) ||
                    lambda.imag() <= 0.0) {
                    continue;
                }
                bool duplicate = false;
                for (std::uint32_t previous = 0u; previous < completed_mode_count; ++previous) {
                    if (std::abs(lambda.imag() - host_metrics[previous].lambda_imag) <=
                        1.0e-7 * std::max(1.0, std::abs(lambda.imag()))) {
                        duplicate = true;
                        break;
                    }
                }
                if (duplicate) {
                    continue;
                }
                std::vector<HostComplex> coefficients;
                if (!host_eigenvector_for_value(
                        hessenberg,
                        basis_count,
                        mu,
                        &coefficients)) {
                    continue;
                }
                std::vector<GpuComplex> device_coefficients(basis_count);
                for (std::uint32_t index = 0u; index < basis_count; ++index) {
                    device_coefficients[index] = make_complex(
                        coefficients[index].real(),
                        coefficients[index].imag());
                }
                if (!cuda_ok(
                        cudaMemcpy(
                            d_arnoldi_coefficients,
                            device_coefficients.data(),
                            sizeof(GpuComplex) * device_coefficients.size(),
                            cudaMemcpyHostToDevice),
                        error_message,
                        sizeof(error_message))) {
                    ok = false;
                    break;
                }
                cudaMemset(d_status, 0, sizeof(int));
                combine_basis_kernel<<<blocks, kBlockSize>>>(
                    total,
                    basis_count,
                    d_arnoldi_coefficients,
                    d_arnoldi_basis,
                    d_ritz,
                    d_status);
                cudaMemset(d_norm_squared, 0, sizeof(double));
                norm_q_kernel<<<
                    static_cast<unsigned int>((nq + kBlockSize - 1u) / kBlockSize),
                    kBlockSize>>>(nq, d_ritz, d_norm_squared);
                scale_vector_by_q_norm_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_norm_squared,
                    d_ritz);
                for (std::uint32_t refinement = 0u;
                     refinement < 32u && !cancellation_observed;
                     ++refinement) {
                    if (cancellation_requested()) {
                        ok = false;
                        break;
                    }
                    ++total_outer_iterations;
                    if (!apply_shifted_inverse(
                            d_ritz,
                            d_iter_a,
                            cycle * 4099u + static_cast<std::uint32_t>(candidate_index) + refinement + 1u)) {
                        ok = false;
                        break;
                    }
                    copy_vector_kernel<<<blocks, kBlockSize>>>(total, d_iter_a, d_ritz);
                    cudaMemset(d_norm_squared, 0, sizeof(double));
                    norm_q_kernel<<<
                        static_cast<unsigned int>((nq + kBlockSize - 1u) / kBlockSize),
                        kBlockSize>>>(nq, d_ritz, d_norm_squared);
                    scale_vector_by_q_norm_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_norm_squared,
                        d_ritz);
                }
                if (!ok) {
                    break;
                }
                apply_shifted_kernel<<<blocks, kBlockSize>>>(
                    nq,
                    np,
                    gauge,
                    make_complex(0.0, 0.0),
                    a_qq,
                    a_qphi,
                    a_phiq,
                    a_phiphi,
                    b_qq,
                    d_phi_mean_weights,
                    d_ritz,
                    d_ax,
                    nullptr);
                apply_mass_kernel<<<blocks, kBlockSize>>>(nq, np, gauge, b_qq, d_ritz, d_bx);
                final_metrics_kernel<<<1, 1>>>(
                    nq,
                    np,
                    total,
                    gauge,
                    d_phi_mean_weights,
                    a_qq,
                    a_qphi,
                    a_phiq,
                    a_phiphi,
                    b_qq,
                    d_ritz,
                    d_ax,
                    d_bx,
                    d_metrics);
                DeviceModalMetrics metrics{};
                if (!cuda_ok(
                        cudaMemcpy(
                            &metrics,
                            d_metrics,
                            sizeof(metrics),
                            cudaMemcpyDeviceToHost),
                        error_message,
                        sizeof(error_message))) {
                    ok = false;
                    break;
                }
                ++linear_control_d2h_transfer_count;
                if (!std::isfinite(metrics.lambda_imag) || metrics.lambda_imag <= 0.0 ||
                    !std::isfinite(metrics.residual_relative) ||
                    metrics.residual_relative > problem.residual_tolerance) {
                    continue;
                }
                host_metrics[completed_mode_count] = metrics;
                if (!cuda_ok(
                        cudaMemcpy(
                            d_locked + static_cast<std::uint64_t>(completed_mode_count) * total,
                            d_ritz,
                            sizeof(GpuComplex) * total,
                            cudaMemcpyDeviceToDevice),
                        error_message,
                        sizeof(error_message))) {
                    ok = false;
                    break;
                }
                ++completed_mode_count;
            }
        }
    } else if (ok) {
        for (std::uint32_t mode = 0;
             mode < mode_count && ok && !cancellation_observed;
             ++mode) {
            if (cancellation_requested()) {
                ok = false;
                break;
            }
            initialise_vector_kernel<<<blocks, kBlockSize>>>(nq, total, mode + 17u, d_x);
            ok = cuda_ok(cudaGetLastError(), error_message, sizeof(error_message));
            if (!ok) {
                break;
            }
            if (mode > 0u) {
                cudaMemset(d_coefficients, 0, sizeof(GpuComplex) * mode_count);
                const unsigned int total_blocks = static_cast<unsigned int>((total + kBlockSize - 1u) / kBlockSize);
                compute_locked_coefficients_kernel<<<dim3(mode, total_blocks, 1u), kBlockSize>>>(
                    total, mode, d_locked, d_x, d_coefficients);
                subtract_locked_kernel<<<blocks, kBlockSize>>>(
                    total, mode, d_coefficients, d_locked, d_x);
            }
            cudaMemset(d_norm_squared, 0, sizeof(double));
            norm_q_kernel<<<static_cast<unsigned int>((nq + kBlockSize - 1u) / kBlockSize), kBlockSize>>>(
                nq, d_x, d_norm_squared);
            scale_vector_by_q_norm_kernel<<<blocks, kBlockSize>>>(
                total, d_norm_squared, d_x);

            for (std::uint32_t outer = 0;
                 outer < outer_iterations && ok && !cancellation_observed;
                 ++outer) {
                if (cancellation_requested()) {
                    ok = false;
                    break;
                }
                ++total_outer_iterations;
                cudaMemset(d_status, 0, sizeof(int));
                cudaMemset(d_rhs, 0, sizeof(GpuComplex) * total);
                apply_mass_kernel<<<blocks, kBlockSize>>>(nq, np, gauge, b_qq, d_x, d_rhs);
                fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_iter_a);
                copy_vector_kernel<<<blocks, kBlockSize>>>(total, d_rhs, d_r);
                cudaMemset(d_rhs_norm_squared, 0, sizeof(double));
                norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_rhs,
                    d_rhs_norm_squared,
                    d_status);
                if (dense_device_workspace) {
                    const unsigned int dense_blocks = static_cast<unsigned int>(
                        (dense_entries + kBlockSize - 1u) / kBlockSize);
                    copy_dense_matrix_kernel<<<dense_blocks, kBlockSize>>>(
                        dense_entries,
                        d_dense_matrix,
                        d_dense_work);
                    dense_shifted_solve_kernel<<<1, 1>>>(
                        total,
                        d_dense_work,
                        d_rhs,
                        d_iter_a,
                        d_status);
                    compute_shifted_residual_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_dense_matrix,
                        d_rhs,
                        d_iter_a,
                        d_r,
                        d_status);
                    cudaMemset(d_residual_norm_squared, 0, sizeof(double));
                    norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_r,
                        d_residual_norm_squared,
                        d_status);
                    update_linear_convergence_kernel<<<1, 1>>>(
                        d_residual_norm_squared,
                        d_rhs_norm_squared,
                        linear_tolerance,
                        0u,
                        1u,
                        d_status);
                    ++operator_apply_count;
                    ++total_linear_iterations;
                } else {
                initialize_bicgstab_shadow_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_r,
                    mode * 131u + outer + 1u,
                    d_rhat);
                fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_p);
                fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_v);
                initialize_bicgstab_scalars_kernel<<<1, 1>>>(d_rho_old, d_alpha, d_omega);
                for (std::uint32_t linear = 0;
                     linear < linear_iterations && !cancellation_observed;
                     ++linear) {
                    if (cancellation_requested()) {
                        ok = false;
                        break;
                    }
                    cudaMemset(d_rho, 0, sizeof(GpuComplex));
                    complex_dot_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_rhat,
                        d_r,
                        d_rho,
                        d_status);
                    bicgstab_update_p_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_rho,
                        d_rho_old,
                        d_alpha,
                        d_omega,
                        d_r,
                        d_v,
                        d_p,
                        d_status);
                    block_jacobi_precondition_kernel<<<blocks, kBlockSize>>>(
                        nq,
                        np,
                        gauge,
                        sigma,
                        a_qq,
                        b_qq,
                        a_phiphi,
                        d_p,
                        d_phat,
                        d_status);
                    apply_shifted_kernel<<<blocks, kBlockSize>>>(
                        nq,
                        np,
                        gauge,
                        sigma,
                        a_qq,
                        a_qphi,
                        a_phiq,
                        a_phiphi,
                        b_qq,
                        d_phi_mean_weights,
                        d_phat,
                        d_v,
                        d_status);
                    ++operator_apply_count;
                    cudaMemset(d_dot_2, 0, sizeof(GpuComplex));
                    complex_dot_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_rhat,
                        d_v,
                        d_dot_2,
                        d_status);
                    bicgstab_update_alpha_kernel<<<1, 1>>>(
                        d_rho,
                        d_dot_2,
                        d_alpha,
                        d_status);
                    bicgstab_update_s_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_r,
                        d_v,
                        d_alpha,
                        d_s,
                        d_status);
                    block_jacobi_precondition_kernel<<<blocks, kBlockSize>>>(
                        nq,
                        np,
                        gauge,
                        sigma,
                        a_qq,
                        b_qq,
                        a_phiphi,
                        d_s,
                        d_shat,
                        d_status);
                    apply_shifted_kernel<<<blocks, kBlockSize>>>(
                        nq,
                        np,
                        gauge,
                        sigma,
                        a_qq,
                        a_qphi,
                        a_phiq,
                        a_phiphi,
                        b_qq,
                        d_phi_mean_weights,
                        d_shat,
                        d_t,
                        d_status);
                    ++operator_apply_count;
                    cudaMemset(d_dot_1, 0, sizeof(GpuComplex));
                    cudaMemset(d_dot_2, 0, sizeof(GpuComplex));
                    complex_dot_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_t,
                        d_s,
                        d_dot_1,
                        d_status);
                    complex_dot_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_t,
                        d_t,
                        d_dot_2,
                        d_status);
                    bicgstab_update_omega_kernel<<<1, 1>>>(
                        d_dot_1,
                        d_dot_2,
                        d_omega,
                        d_status);
                    bicgstab_update_solution_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_alpha,
                        d_omega,
                        d_phat,
                        d_shat,
                        d_s,
                        d_t,
                        d_rho,
                        d_iter_a,
                        d_r,
                        d_rho_old,
                        d_status);
                    restart_bicgstab_after_happy_breakdown_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_r,
                        d_rhat,
                        d_p,
                        d_v,
                        d_rho_old,
                        d_alpha,
                        d_omega,
                        false,
                        d_status);
                    cudaMemset(d_residual_norm_squared, 0, sizeof(double));
                    norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_r,
                        d_residual_norm_squared,
                        d_status);
                    update_linear_convergence_kernel<<<1, 1>>>(
                        d_residual_norm_squared,
                        d_rhs_norm_squared,
                        linear_tolerance,
                        linear,
                        linear_iterations,
                        d_status);
                    restart_bicgstab_after_happy_breakdown_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_r,
                        d_rhat,
                        d_p,
                        d_v,
                        d_rho_old,
                        d_alpha,
                        d_omega,
                        true,
                        d_status);
                    ++total_linear_iterations;
                }
                }
                int linear_status = 0;
                ok = cuda_ok(
                    cudaMemcpy(
                        &linear_status,
                        d_status,
                        sizeof(linear_status),
                        cudaMemcpyDeviceToHost),
                    error_message,
                    sizeof(error_message));
                ++linear_control_d2h_transfer_count;
                if (!ok) {
                    break;
                }
                if ((linear_status & kModalStatusConverged) == 0 ||
                    (linear_status & (kModalStatusBreakdown | kModalStatusNonFinite |
                                      kModalStatusLinearLimit)) != 0) {
                    std::snprintf(
                        error_message,
                        sizeof(error_message),
                        "GPU modal K0 shifted linear solve did not converge (status=0x%x, tolerance=%.3e, max_iterations=%u)",
                        linear_status,
                        linear_tolerance,
                        linear_iterations);
                    ok = false;
                    break;
                }
                copy_vector_kernel<<<blocks, kBlockSize>>>(total, d_iter_a, d_x);
                cudaMemset(d_norm_squared, 0, sizeof(double));
                norm_q_kernel<<<static_cast<unsigned int>((nq + kBlockSize - 1u) / kBlockSize), kBlockSize>>>(
                    nq, d_x, d_norm_squared);
                scale_vector_by_q_norm_kernel<<<blocks, kBlockSize>>>(
                    total, d_norm_squared, d_x);
            }

            apply_shifted_kernel<<<blocks, kBlockSize>>>(
                nq,
                np,
                gauge,
                make_complex(0.0, 0.0),
                a_qq,
                a_qphi,
                a_phiq,
                a_phiphi,
                b_qq,
                d_phi_mean_weights,
                d_x,
                d_ax,
                nullptr);
            apply_mass_kernel<<<blocks, kBlockSize>>>(nq, np, gauge, b_qq, d_x, d_bx);
            final_metrics_kernel<<<1, 1>>>(
                nq,
                np,
                total,
                gauge,
                d_phi_mean_weights,
                a_qq,
                a_qphi,
                a_phiq,
                a_phiphi,
                b_qq,
                d_x,
                d_ax,
                d_bx,
                d_metrics);
            ok = cuda_ok(cudaGetLastError(), error_message, sizeof(error_message)) &&
                cuda_ok(cudaDeviceSynchronize(), error_message, sizeof(error_message));
            if (!ok) {
                break;
            }
            DeviceModalMetrics metrics{};
            ok = cuda_ok(
                cudaMemcpy(&metrics, d_metrics, sizeof(metrics), cudaMemcpyDeviceToHost),
                error_message,
                sizeof(error_message));
            if (!ok) {
                break;
            }
            host_metrics[mode] = metrics;
            completed_mode_count = mode + 1u;
            if (!std::isfinite(metrics.lambda_imag) ||
                metrics.lambda_imag <= 0.0 ||
                !std::isfinite(metrics.residual_relative) ||
                metrics.residual_relative > problem.residual_tolerance) {
                out_result->eigenvalue_real = metrics.lambda_real;
                out_result->eigenvalue_imag = metrics.lambda_imag;
                out_result->eigen_residual_relative = metrics.residual_relative;
                out_result->full_residual_reconstruction_relative_error = metrics.residual_relative;
                std::snprintf(
                    error_message,
                    sizeof(error_message),
                    "GPU modal K0 device Krylov failed certification (lambda=%+.6e%+.6ei residual=%.6e)",
                    metrics.lambda_real,
                    metrics.lambda_imag,
                    metrics.residual_relative);
                ok = false;
                break;
            }
            ok = cuda_ok(cudaMemcpy(
                d_locked + static_cast<std::uint64_t>(mode) * total,
                d_x,
                sizeof(GpuComplex) * total,
                cudaMemcpyDeviceToDevice),
                error_message,
                sizeof(error_message));
        }
    }

    std::vector<GpuComplex> host_locked;
    std::uint64_t final_d2h_transfer_count = 0u;
    if (ok && cancellation_requested()) {
        ok = false;
    }
    if (ok && completed_mode_count == mode_count) {
        host_locked.resize(static_cast<std::size_t>(mode_count) * static_cast<std::size_t>(total));
        ok = cuda_ok(
            cudaMemcpy(
                host_locked.data(),
                d_locked,
                sizeof(GpuComplex) * host_locked.size(),
                cudaMemcpyDeviceToHost),
            error_message,
            sizeof(error_message));
        if (ok) {
            final_d2h_transfer_count = 1u + completed_mode_count;
            for (std::uint32_t mode = 0; mode < completed_mode_count; ++mode) {
                const DeviceModalMetrics &metrics = host_metrics[mode];
                const double frequency_hz = metrics.lambda_imag /
                    (2.0 * 3.14159265358979323846264338327950288);
                if (has_string(problem.target_kind, "frequency_window") &&
                    (frequency_hz < problem.frequency_min_hz ||
                     frequency_hz > problem.frequency_max_hz)) {
                    continue;
                }
                fd::PoissonAirboxModalEigenResult::AcceptedMode accepted{};
                accepted.eigenpair_index = mode;
                accepted.eigenvalue_real = metrics.lambda_real;
                accepted.eigenvalue_imag = metrics.lambda_imag;
                accepted.omega_rad_s = metrics.lambda_imag;
                accepted.frequency_hz = frequency_hz;
                accepted.relative_residual = metrics.residual_relative;
                accepted.full_residual_reconstruction_relative_error = metrics.residual_relative;
                accepted.magnetic_block_backward_error = metrics.magnetic_block_backward_error;
                accepted.poisson_block_backward_error = metrics.poisson_block_backward_error;
                accepted.gauge_constraint_backward_error =
                    metrics.gauge_constraint_backward_error;
                accepted.gauge_mean_abs = metrics.gauge_constraint_abs;
                accepted.full_vector.reserve(static_cast<std::size_t>(total));
                const GpuComplex *mode_vector =
                    host_locked.data() + static_cast<std::size_t>(mode) * static_cast<std::size_t>(total);
                for (std::uint64_t index = 0; index < total; ++index) {
                    accepted.full_vector.emplace_back(mode_vector[index].real, mode_vector[index].imag);
                }
                out_result->accepted_modes.push_back(std::move(accepted));
            }
        }
    }

    destroy_csr(&a_qq);
    destroy_csr(&a_qphi);
    destroy_csr(&a_phiq);
    destroy_csr(&a_phiphi);
    destroy_csr(&b_qq);
    cudaFree(d_phi_mean_weights);
    cudaFree(d_norm_squared);
    cudaFree(d_rhs_norm_squared);
    cudaFree(d_residual_norm_squared);
    cudaFree(d_status);
    cudaFree(d_x);
    cudaFree(d_rhs);
    cudaFree(d_iter_a);
    cudaFree(d_r);
    cudaFree(d_rhat);
    cudaFree(d_p);
    cudaFree(d_phat);
    cudaFree(d_v);
    cudaFree(d_s);
    cudaFree(d_shat);
    cudaFree(d_t);
    cudaFree(d_rho);
    cudaFree(d_rho_old);
    cudaFree(d_alpha);
    cudaFree(d_omega);
    cudaFree(d_dot_1);
    cudaFree(d_dot_2);
    cudaFree(d_ax);
    cudaFree(d_bx);
    cudaFree(d_dense_matrix);
    cudaFree(d_dense_work);
    cudaFree(d_locked);
    cudaFree(d_coefficients);
    cudaFree(d_metrics);
    cudaFree(d_arnoldi_basis);
    cudaFree(d_arnoldi_hessenberg);
    cudaFree(d_arnoldi_coefficients);
    cudaFree(d_ritz);

    if (!ok || out_result->accepted_modes.empty()) {
        out_result->status = cancellation_observed
            ? FrequencyDomainStatus::interrupted
            : FrequencyDomainStatus::solve_error;
        copy_error(
            out_result->error_message,
            sizeof(out_result->error_message),
            error_message[0] != '\0' ? error_message : "GPU modal K0 device Krylov solve failed");
        write_gpu_diagnostics(
            problem,
            *out_result,
            cancellation_observed ? "interrupted" : "solve_error",
            cancellation_observed
                ? "cancel_requested"
                : "gpu_modal_device_krylov_failed",
            operator_apply_count,
            total_outer_iterations,
            total_linear_iterations,
            setup_h2d_transfer_count,
            linear_control_d2h_transfer_count,
            final_d2h_transfer_count,
            out_result);
        return out_result->status;
    }

    const auto &selected = out_result->accepted_modes.front();
    out_result->status = FrequencyDomainStatus::ok;
    out_result->accepted_mode_count = static_cast<std::uint32_t>(out_result->accepted_modes.size());
    out_result->converged_eigenpair_count = completed_mode_count;
    out_result->selected_eigenpair_index = selected.eigenpair_index;
    out_result->eigenvalue_real = selected.eigenvalue_real;
    out_result->eigenvalue_imag = selected.eigenvalue_imag;
    out_result->omega_rad_s = selected.omega_rad_s;
    out_result->frequency_hz = selected.frequency_hz;
    out_result->eigen_residual_relative = selected.relative_residual;
    out_result->full_residual_reconstruction_relative_error = selected.relative_residual;
    out_result->magnetic_block_backward_error = selected.magnetic_block_backward_error;
    out_result->poisson_block_backward_error = selected.poisson_block_backward_error;
    out_result->poisson_constraint_relative_residual = selected.poisson_block_backward_error;
    out_result->gauge_constraint_backward_error = selected.gauge_constraint_backward_error;
    out_result->gauge_mean_abs = selected.gauge_mean_abs;
    out_result->outer_iterations = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(total_outer_iterations, std::numeric_limits<std::uint32_t>::max()));
    out_result->gauge_augmented = gauge;
    out_result->positive_frequency_branch_found = true;
    out_result->full_residual_certified = selected.relative_residual <= problem.residual_tolerance;
    out_result->reference_frequency_certified = true;
    write_gpu_diagnostics(problem, *out_result, "ok", "", operator_apply_count, total_outer_iterations, total_linear_iterations, setup_h2d_transfer_count, linear_control_d2h_transfer_count, final_d2h_transfer_count, out_result);
    return out_result->status;
}

} // namespace fullmag::fem::frequency_domain
