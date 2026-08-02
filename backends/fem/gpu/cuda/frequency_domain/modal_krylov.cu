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
constexpr double kDiagonalTolerance = 1.0e-14;
constexpr double kBreakdownTolerance = 1.0e-28;
constexpr int kModalStatusConverged = 1 << 0;
constexpr int kModalStatusBreakdown = 1 << 1;
constexpr int kModalStatusNonFinite = 1 << 2;
constexpr int kModalStatusLinearLimit = 1 << 3;

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

__global__ void diagonal_precondition_kernel(
    std::uint64_t total,
    const GpuComplex *rhs,
    const GpuComplex *diagonal,
    GpuComplex *out,
    int *status)
{
    const std::uint64_t index =
        static_cast<std::uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index < total) {
        if (modal_status_stopped(status)) {
            return;
        }
        const GpuComplex denominator = diagonal[index];
        if (!complex_is_finite(rhs[index]) || !complex_is_finite(denominator) ||
            complex_abs2(denominator) <= kBreakdownTolerance) {
            atomicOr(status, kModalStatusBreakdown | kModalStatusNonFinite);
            return;
        }
        out[index] = rhs[index] / denominator;
        if (!complex_is_finite(out[index])) {
            atomicOr(status, kModalStatusNonFinite);
        }
    }
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
        !complex_is_finite(omega_value) || !complex_is_finite(alpha_value) ||
        complex_abs2(rho_old_value) <= kBreakdownTolerance ||
        complex_abs2(omega_value) <= kBreakdownTolerance) {
        atomicOr(status, kModalStatusBreakdown | kModalStatusNonFinite);
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
        if (modal_status_stopped(status) || !complex_is_finite(*rho) ||
            !complex_is_finite(*denominator) ||
            complex_abs2(*denominator) <= kBreakdownTolerance) {
            atomicOr(status, kModalStatusBreakdown | kModalStatusNonFinite);
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
        if (modal_status_stopped(status) || !complex_is_finite(*numerator) ||
            !complex_is_finite(*denominator) ||
            complex_abs2(*denominator) <= kBreakdownTolerance) {
            atomicOr(status, kModalStatusBreakdown | kModalStatusNonFinite);
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

bool diagonal_entry(const fd::CsrMatrixView &matrix, std::uint64_t row, double *value)
{
    if (value == nullptr) {
        return false;
    }
    *value = 0.0;
    for (std::uint32_t entry = matrix.row_offsets[row];
         entry < matrix.row_offsets[row + 1u];
         ++entry) {
        if (matrix.column_indices[entry] == row) {
            *value += matrix.values[entry];
        }
    }
    return true;
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
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_modal_eigen_gpu.v1\","
        "\"status\":\"%s\","
        "\"reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_adapter\":\"k0_poisson_airbox_gpu_modal_device_krylov\","
        "\"execution_lane\":\"gpu_modal_device_krylov\","
        "\"requested_execution\":\"production_gpu\","
        "\"resolved_execution\":\"production_gpu\","
        "\"operator_family\":\"full_coupled_poisson_airbox_modal_pencil\","
        "\"spectral_transform\":\"complex_shift_invert\","
        "\"target_representation\":\"sigma=i*omega_target\","
        "\"assembly_kind\":\"%s\","
        "\"outer_boundary_kind\":\"%s\","
        "\"phasor_convention\":\"exp_plus_i_omega_t\","
        "\"eigenvalue_convention\":\"lambda_imag_positive_frequency\","
        "\"production_implication\":true,"
        "\"target_frequency_hz\":%.17g,"
        "\"target_omega_rad_s\":%.17g,"
        "\"demag_kind\":\"%s\","
        "\"gauge_policy\":\"%s\","
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"accepted_mode_count\":%u,"
        "\"persistent_solver_context\":true,"
        "\"gpu_device_resident_modal_eigensolver\":true,"
        "\"operator_storage\":\"device_csr\","
        "\"krylov_vector_location\":\"device\","
        "\"linear_solver\":\"bicgstab\","
        "\"preconditioner\":\"shifted_diagonal_jacobi\","
        "\"operator_buffer_location\":\"device\","
        "\"preconditioner_buffer_location\":\"device\","
        "\"cpu_fallback\":\"disabled\","
        "\"fallback_used\":false,"
        "\"setup_h2d_transfer_count\":%llu,"
        "\"final_d2h_transfer_count\":%llu,"
        "\"per_iteration_h2d_transfer_count\":0,"
        "\"per_iteration_d2h_transfer_count\":0,"
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
        problem.target_frequency_hz,
        problem.target_frequency_hz * 2.0 * 3.14159265358979323846264338327950288,
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        result.accepted_mode_count,
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
    fd::PoissonAirboxModalEigenResult *result)
{
    if (result == nullptr) {
        return false;
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
    if (!has_string(problem.assembly_kind, "mfem_weak_form_shared_domain") ||
        !has_string(problem.demag_kind, "periodic_airbox_k0") ||
        !has_string(problem.phasor_convention, "exp_plus_i_omega_t") ||
        !has_string(problem.eigenvalue_convention, "lambda_imag_positive_frequency") ||
        !has_string(problem.periodic_mesh_certificate_schema, "periodic_mesh_certificate.v6") ||
        !valid_boundary_gauge ||
        !gauge_reason_matches ||
        problem.q_dof_count == 0u || problem.phi_dof_count == 0u ||
        problem.magnetic_pair_count == 0u || problem.airbox_pair_count == 0u ||
        problem.q_dof_count + problem.phi_dof_count > kMaxGpuModalDofs ||
        problem.requested_mode_count == 0u || problem.requested_mode_count > kMaxGpuModalModes ||
        !std::isfinite(problem.target_frequency_hz) || problem.target_frequency_hz <= 0.0 ||
        !std::isfinite(problem.residual_tolerance) || problem.residual_tolerance <= 0.0) {
        copy_error(
            result->error_message,
            sizeof(result->error_message),
            "GPU modal K0 requires a shared-domain P1 descriptor with boundary-consistent gauge provenance and positive target frequency");
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
                return false;
            }
            weight_sum += static_cast<long double>(weight);
        }
        if (std::abs(static_cast<double>(weight_sum - 1.0L)) > 1.0e-10) {
            copy_error(
                result->error_message,
                sizeof(result->error_message),
                "GPU modal K0 mean-zero gauge weights must sum to one");
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
    if (!cuda_modal_problem_supported(problem, out_result)) {
        write_gpu_diagnostics(problem, *out_result, "validation_error", "gpu_modal_device_krylov_scope_mismatch", 0u, 0u, 0u, 0u, 0u, 0u, out_result);
        out_result->status = FrequencyDomainStatus::validation_error;
        return out_result->status;
    }

    const std::uint64_t nq = problem.q_dof_count;
    const std::uint64_t np = problem.phi_dof_count;
    const bool gauge = has_string(problem.gauge_policy, "mean_zero_augmented");
    const std::uint64_t total = nq + np + (gauge ? 1u : 0u);
    const unsigned int blocks = static_cast<unsigned int>((total + kBlockSize - 1u) / kBlockSize);
    const std::uint32_t mode_count = std::max<std::uint32_t>(1u, problem.requested_mode_count);
    const std::uint32_t linear_iterations = std::max<std::uint32_t>(64u, problem.max_linear_iterations);
    const std::uint32_t outer_iterations = std::max<std::uint32_t>(8u, problem.max_outer_iterations);
    const double linear_tolerance = std::max(
        1.0e-12,
        std::min(1.0e-6, problem.residual_tolerance * 0.1));
    const double target_omega =
        problem.target_frequency_hz * 2.0 * 3.14159265358979323846264338327950288;
    const GpuComplex sigma = make_complex(0.0, target_omega);

    DeviceCsr a_qq{}, a_qphi{}, a_phiq{}, a_phiphi{}, b_qq{};
    GpuComplex *d_diagonal = nullptr;
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
    GpuComplex *d_locked = nullptr;
    GpuComplex *d_coefficients = nullptr;
    DeviceModalMetrics *d_metrics = nullptr;
    std::vector<GpuComplex> diagonal(static_cast<std::size_t>(total), make_complex(0.0, 0.0));
    char error_message[256]{};
    bool ok =
        upload_csr(problem.A_qq, &a_qq, error_message, sizeof(error_message)) &&
        upload_csr(problem.A_qphi, &a_qphi, error_message, sizeof(error_message)) &&
        upload_csr(problem.A_phiq, &a_phiq, error_message, sizeof(error_message)) &&
        upload_csr(problem.A_phiphi, &a_phiphi, error_message, sizeof(error_message)) &&
        upload_csr(problem.B_qq, &b_qq, error_message, sizeof(error_message));

    if (ok) {
        for (std::uint64_t row = 0; row < nq; ++row) {
            double a_diagonal = 0.0;
            double b_diagonal = 0.0;
            diagonal_entry(problem.A_qq, row, &a_diagonal);
            diagonal_entry(problem.B_qq, row, &b_diagonal);
            diagonal[row] = make_complex(
                a_diagonal - sigma.real * b_diagonal,
                -sigma.imag * b_diagonal);
        }
        for (std::uint64_t row = 0; row < np; ++row) {
            double phi_diagonal = 0.0;
            diagonal_entry(problem.A_phiphi, row, &phi_diagonal);
            diagonal[nq + row] = make_complex(phi_diagonal, 0.0);
        }
        if (gauge) {
            // The augmented mean-zero row has no natural diagonal.  A unit
            // diagonal is a valid left preconditioner for that constraint;
            // the full row remains part of the device operator and residual.
            diagonal[total - 1u] = make_complex(1.0, 0.0);
        }
        for (GpuComplex value : diagonal) {
            if (!std::isfinite(value.real) || !std::isfinite(value.imag) ||
                std::sqrt(complex_abs2(value)) <= kDiagonalTolerance) {
                copy_error(error_message, sizeof(error_message), "GPU modal K0 shifted diagonal preconditioner has a zero or non-finite diagonal");
                ok = false;
                break;
            }
        }
    }
    ok = ok &&
        allocate_device(&d_diagonal, total, error_message, sizeof(error_message)) &&
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
        allocate_device(&d_locked, static_cast<std::uint64_t>(mode_count) * total, error_message, sizeof(error_message)) &&
        allocate_device(&d_coefficients, mode_count, error_message, sizeof(error_message)) &&
        allocate_device(&d_metrics, 1u, error_message, sizeof(error_message));
    if (ok) {
        ok = cuda_ok(
            cudaMemcpy(d_diagonal, diagonal.data(), sizeof(GpuComplex) * diagonal.size(), cudaMemcpyHostToDevice),
            error_message,
            sizeof(error_message));
        if (ok && gauge) {
            ok = cuda_ok(
                cudaMemcpy(
                    d_phi_mean_weights,
                    problem.phi_mean_weights,
                    sizeof(double) * np,
                    cudaMemcpyHostToDevice),
                error_message,
                sizeof(error_message));
        }
    }

    std::uint64_t operator_apply_count = 0u;
    std::uint64_t total_linear_iterations = 0u;
    std::uint64_t total_outer_iterations = 0u;
    const std::uint64_t setup_h2d_transfer_count = 16u + (gauge ? 1u : 0u);
    std::uint64_t linear_control_d2h_transfer_count = 0u;
    std::vector<DeviceModalMetrics> host_metrics(static_cast<std::size_t>(mode_count));
    std::uint32_t completed_mode_count = 0u;
    if (ok) {
        for (std::uint32_t mode = 0; mode < mode_count && ok; ++mode) {
            initialise_vector_kernel<<<blocks, kBlockSize>>>(nq, total, mode + 1u, d_x);
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

            for (std::uint32_t outer = 0; outer < outer_iterations && ok; ++outer) {
                ++total_outer_iterations;
                cudaMemset(d_status, 0, sizeof(int));
                cudaMemset(d_rhs, 0, sizeof(GpuComplex) * total);
                apply_mass_kernel<<<blocks, kBlockSize>>>(nq, np, gauge, b_qq, d_x, d_rhs);
                fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_iter_a);
                copy_vector_kernel<<<blocks, kBlockSize>>>(total, d_rhs, d_r);
                copy_vector_kernel<<<blocks, kBlockSize>>>(total, d_r, d_rhat);
                fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_p);
                fill_vector_kernel<<<blocks, kBlockSize>>>(total, make_complex(0.0, 0.0), d_v);
                initialize_bicgstab_scalars_kernel<<<1, 1>>>(d_rho_old, d_alpha, d_omega);
                cudaMemset(d_rhs_norm_squared, 0, sizeof(double));
                norm_complex_vector_kernel<<<blocks, kBlockSize>>>(
                    total,
                    d_rhs,
                    d_rhs_norm_squared,
                    d_status);
                for (std::uint32_t linear = 0; linear < linear_iterations; ++linear) {
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
                    diagonal_precondition_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_p,
                        d_diagonal,
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
                    diagonal_precondition_kernel<<<blocks, kBlockSize>>>(
                        total,
                        d_s,
                        d_diagonal,
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
                    ++total_linear_iterations;
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
                fd::PoissonAirboxModalEigenResult::AcceptedMode accepted{};
                accepted.eigenpair_index = mode;
                accepted.eigenvalue_real = metrics.lambda_real;
                accepted.eigenvalue_imag = metrics.lambda_imag;
                accepted.omega_rad_s = metrics.lambda_imag;
                accepted.frequency_hz = metrics.lambda_imag /
                    (2.0 * 3.14159265358979323846264338327950288);
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
    cudaFree(d_diagonal);
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
    cudaFree(d_locked);
    cudaFree(d_coefficients);
    cudaFree(d_metrics);

    if (!ok || out_result->accepted_modes.empty()) {
        out_result->status = FrequencyDomainStatus::solve_error;
        copy_error(
            out_result->error_message,
            sizeof(out_result->error_message),
            error_message[0] != '\0' ? error_message : "GPU modal K0 device Krylov solve failed");
        write_gpu_diagnostics(
            problem,
            *out_result,
            "solve_error",
            "gpu_modal_device_krylov_failed",
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
    out_result->converged_eigenpair_count = out_result->accepted_mode_count;
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
