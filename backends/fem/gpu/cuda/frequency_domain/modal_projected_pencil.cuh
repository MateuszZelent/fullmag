#pragma once

#include <cuComplex.h>
#include <cuda_runtime.h>

#include <cfloat>

namespace fullmag::fem::frequency_domain::gpu {

// This bound is on the Ritz projection, independent of the FEM operator size.
inline constexpr int max_projected_pencil_dimension = 96;

enum class ProjectedPencilStatus : int {
    converged,
    invalid_pencil,
    not_positive_definite,
    iteration_limit,
};

namespace projected_pencil_detail {

constexpr int block_size = 256;
constexpr int max_sweeps = 24;

__device__ inline int player_at(int position, int round, int cycle)
{
    return position == 0 ? 0 : 1 + (position - 1 + cycle - round) % cycle;
}

__device__ inline double2 scale(double2 z, double factor)
{
    return make_double2(z.x * factor, z.y * factor);
}

__device__ inline double abs2(double2 z)
{
    return z.x * z.x + z.y * z.y;
}

__device__ inline double component_max(double2 z)
{
    return fmax(fabs(z.x), fabs(z.y));
}

__device__ inline bool finite(double2 z)
{
    return isfinite(z.x) && isfinite(z.y);
}

// Each k iteration completes a full row update before the next row is used.
__device__ inline void forward_solve(const double2 *l, double2 *rhs, int n)
{
    const int lane = threadIdx.x;
    for (int k = 0; k < n; ++k) {
        for (int j = lane; j < n; j += blockDim.x) {
            rhs[k + j * n] = scale(rhs[k + j * n], 1.0 / l[k + k * n].x);
        }
        __syncthreads();
        for (int item = lane; item < n * n; item += blockDim.x) {
            const int i = item % n;
            const int j = item / n;
            if (i > k) {
                rhs[item] = cuCsub(rhs[item], cuCmul(l[i + k * n], rhs[k + j * n]));
            }
        }
        __syncthreads();
    }
}

static __global__ void solve(int n, const double2 *a, const double2 *b, double2 *m, double2 *l,
                             double2 *vectors, double *values, ProjectedPencilStatus *status)
{
    const int lane = threadIdx.x;
    const int extent = n * n;
    __shared__ double reduction_a[block_size];
    __shared__ double reduction_b[block_size];
    __shared__ double cosine[max_projected_pencil_dimension / 2];
    __shared__ double2 sine[max_projected_pencil_dimension / 2];
    __shared__ int order[max_projected_pencil_dimension];
    __shared__ int invalid;
    __shared__ int rotated;
    if (lane == 0) {
        invalid = 0;
        *status = ProjectedPencilStatus::invalid_pencil;
    }
    __syncthreads();

    double a_max = 0.0;
    double b_max = 0.0;
    for (int item = lane; item < extent; item += blockDim.x) {
        if (!finite(a[item]) || !finite(b[item])) {
            atomicExch(&invalid, 1);
        }
        a_max = fmax(a_max, component_max(a[item]));
        b_max = fmax(b_max, component_max(b[item]));
    }
    reduction_a[lane] = a_max;
    reduction_b[lane] = b_max;
    __syncthreads();
    for (int step = block_size / 2; step > 0; step /= 2) {
        if (lane < step) {
            reduction_a[lane] = fmax(reduction_a[lane], reduction_a[lane + step]);
            reduction_b[lane] = fmax(reduction_b[lane], reduction_b[lane + step]);
        }
        __syncthreads();
    }
    if (invalid) {
        return;
    }
    const double a_scale = reduction_a[0] > 0.0 ? reduction_a[0] : 1.0;
    const double b_scale = reduction_b[0];
    if (!(b_scale > 0.0)) {
        if (lane == 0) {
            *status = ProjectedPencilStatus::not_positive_definite;
        }
        return;
    }
    __syncthreads();
    for (int item = lane; item < extent; item += blockDim.x) {
        const int transpose = (item % n) * n + item / n;
        const double2 ax = make_double2(a[item].x / a_scale, a[item].y / a_scale);
        const double2 az = make_double2(a[transpose].x / a_scale, -a[transpose].y / a_scale);
        const double2 bx = make_double2(b[item].x / b_scale, b[item].y / b_scale);
        const double2 bz = make_double2(b[transpose].x / b_scale, -b[transpose].y / b_scale);
        if (fmax(component_max(cuCsub(ax, az)), component_max(cuCsub(bx, bz))) > 64.0 * DBL_EPSILON) {
            atomicExch(&invalid, 1);
        }
        m[item] = scale(cuCadd(ax, az), 0.5);
        l[item] = scale(cuCadd(bx, bz), 0.5);
    }
    __syncthreads();
    if (invalid) {
        return;
    }

    __syncthreads();
    // Factor B = L L*, storing L in the lower triangle of the work buffer.
    for (int k = 0; k < n; ++k) {
        if (lane == 0) {
            const double pivot = l[k + k * n].x;
            invalid = !(pivot > 0.0) || !isfinite(pivot);
            l[k + k * n] = make_double2(sqrt(pivot), 0.0);
        }
        __syncthreads();
        if (invalid) {
            if (lane == 0) {
                *status = ProjectedPencilStatus::not_positive_definite;
            }
            return;
        }
        for (int i = k + 1 + lane; i < n; i += blockDim.x) {
            l[i + k * n] = scale(l[i + k * n], 1.0 / l[k + k * n].x);
        }
        __syncthreads();
        for (int item = lane; item < extent; item += blockDim.x) {
            const int i = item % n;
            const int j = item / n;
            if (i >= j && j > k) {
                l[item] = cuCsub(l[item], cuCmul(l[i + k * n], cuConj(l[j + k * n])));
            }
        }
        __syncthreads();
    }

    // L^-1 A L^-*, using the eigenvector output as transpose scratch here.
    forward_solve(l, m, n);
    for (int item = lane; item < extent; item += blockDim.x) {
        vectors[item] = cuConj(m[(item % n) * n + item / n]);
    }
    __syncthreads();
    forward_solve(l, vectors, n);
    double frobenius2 = 0.0;
    for (int item = lane; item < extent; item += blockDim.x) {
        const int transpose = (item % n) * n + item / n;
        m[item] = scale(cuCadd(vectors[item], cuConj(vectors[transpose])), 0.5);
        frobenius2 += abs2(m[item]);
    }
    reduction_a[lane] = frobenius2;
    __syncthreads();
    for (int step = block_size / 2; step > 0; step /= 2) {
        if (lane < step) {
            reduction_a[lane] += reduction_a[lane + step];
        }
        __syncthreads();
    }
    const double initial_norm2 = reduction_a[0];
    if (!isfinite(initial_norm2)) {
        return;
    }
    const double threshold = DBL_EPSILON * sqrt(initial_norm2) / n;
    for (int item = lane; item < extent; item += blockDim.x) {
        vectors[item] = make_double2(item % (n + 1) == 0 ? 1.0 : 0.0, 0.0);
    }
    __syncthreads();

    const int players = n + n % 2;
    const int cycle = players - 1;
    for (int sweep = 0; sweep < max_sweeps; ++sweep) {
        if (lane == 0) {
            rotated = 0;
        }
        __syncthreads();
        for (int round = 0; round < cycle; ++round) {
            if (lane < players / 2) {
                const int p = player_at(lane, round, cycle);
                const int q = player_at(cycle - lane, round, cycle);
                cosine[lane] = 1.0;
                sine[lane] = make_double2(0.0, 0.0);
                if (p < n && q < n) {
                    const double2 coupling = m[p + q * n];
                    const double magnitude = hypot(coupling.x, coupling.y);
                    if (magnitude > threshold) {
                        const double half_gap = 0.5 * (m[q + q * n].x - m[p + p * n].x);
                        const double tangent = copysign(magnitude / (fabs(half_gap) + hypot(half_gap, magnitude)), half_gap);
                        cosine[lane] = 1.0 / hypot(1.0, tangent);
                        sine[lane] = scale(make_double2(coupling.x / magnitude, coupling.y / magnitude),
                                           cosine[lane] * tangent);
                        atomicExch(&rotated, 1);
                    }
                }
            }
            __syncthreads();
            for (int item = lane; item < n * (players / 2); item += blockDim.x) {
                const int j = item % n;
                const int pair = item / n;
                const int p = player_at(pair, round, cycle);
                const int q = player_at(cycle - pair, round, cycle);
                const double c = cosine[pair];
                const double2 s = sine[pair];
                if (p < n && q < n && (s.x != 0.0 || s.y != 0.0)) {
                    const double2 left = m[j + p * n], right = m[j + q * n];
                    m[j + p * n] = cuCsub(scale(left, c), cuCmul(cuConj(s), right));
                    m[j + q * n] = cuCadd(cuCmul(s, left), scale(right, c));
                    const double2 x_left = vectors[j + p * n], x_right = vectors[j + q * n];
                    vectors[j + p * n] = cuCsub(scale(x_left, c), cuCmul(cuConj(s), x_right));
                    vectors[j + q * n] = cuCadd(cuCmul(s, x_left), scale(x_right, c));
                }
            }
            __syncthreads();
            for (int item = lane; item < n * (players / 2); item += blockDim.x) {
                const int j = item % n;
                const int pair = item / n;
                const int p = player_at(pair, round, cycle);
                const int q = player_at(cycle - pair, round, cycle);
                const double c = cosine[pair];
                const double2 s = sine[pair];
                if (p < n && q < n && (s.x != 0.0 || s.y != 0.0)) {
                    const double2 top = m[p + j * n], bottom = m[q + j * n];
                    m[p + j * n] = j == q ? make_double2(0.0, 0.0) : cuCsub(scale(top, c), cuCmul(s, bottom));
                    m[q + j * n] = j == p ? make_double2(0.0, 0.0) : cuCadd(cuCmul(cuConj(s), top), scale(bottom, c));
                }
            }
            __syncthreads();
        }
        const bool sweep_converged = rotated == 0;
        __syncthreads();
        if (sweep_converged) {
            break;
        }
    }

    double off2 = 0.0;
    for (int item = lane; item < extent; item += blockDim.x) {
        if (item % (n + 1) != 0) {
            off2 += abs2(m[item]);
        }
    }
    reduction_a[lane] = off2;
    __syncthreads();
    for (int step = block_size / 2; step > 0; step /= 2) {
        if (lane < step) {
            reduction_a[lane] += reduction_a[lane + step];
        }
        __syncthreads();
    }
    if (!(reduction_a[0] <= 1.0e-24 * initial_norm2)) {
        if (lane == 0) {
            *status = ProjectedPencilStatus::iteration_limit;
        }
        return;
    }

    if (lane == 0) {
        for (int j = 0; j < n; ++j) {
            int i = j;
            const double value = m[j * (n + 1)].x;
            while (i > 0 && value < m[order[i - 1] * (n + 1)].x) {
                order[i] = order[i - 1];
                --i;
            }
            order[i] = j;
        }
    }
    __syncthreads();
    if (lane < n) {
        const double normalized = m[order[lane] * (n + 1)].x;
        int a_exponent = 0, b_exponent = 0;
        const double a_fraction = frexp(a_scale, &a_exponent);
        const double b_fraction = frexp(b_scale, &b_exponent);
        values[lane] = scalbn(normalized * (a_fraction / b_fraction), a_exponent - b_exponent);
        if (!isfinite(values[lane])) {
            atomicExch(&invalid, 1);
        }
    }
    __syncthreads();
    for (int item = lane; item < extent; item += blockDim.x) {
        m[item] = vectors[item % n + order[item / n] * n];
    }
    __syncthreads();
    for (int k = n - 1; k >= 0; --k) {
        if (lane < n) {
            m[k + lane * n] = scale(m[k + lane * n], 1.0 / l[k + k * n].x);
        }
        __syncthreads();
        for (int item = lane; item < extent; item += blockDim.x) {
            const int i = item % n;
            const int j = item / n;
            if (i < k) {
                m[item] = cuCsub(m[item], cuCmul(cuConj(l[k + i * n]), m[k + j * n]));
            }
        }
        __syncthreads();
    }
    for (int item = lane; item < extent; item += blockDim.x) {
        vectors[item] = scale(m[item], 1.0 / sqrt(b_scale));
        if (!finite(vectors[item])) {
            atomicExch(&invalid, 1);
        }
    }
    __syncthreads();
    if (lane == 0 && !invalid) {
        *status = ProjectedPencilStatus::converged;
    }
}

} // namespace projected_pencil_detail

// All pointers are distinct device allocations. The matrices use column-major
// storage. The caller owns buffers and the stream, and checks status on device.
inline cudaError_t launch_projected_pencil(
    int n, const double2 *a, const double2 *b, double2 *work_a, double2 *work_b,
    double2 *vectors, double *values, ProjectedPencilStatus *status, cudaStream_t stream)
{
    if (n < 1 || n > max_projected_pencil_dimension || !a || !b || !work_a || !work_b ||
        !vectors || !values || !status) {
        return cudaErrorInvalidValue;
    }
    projected_pencil_detail::solve<<<1, projected_pencil_detail::block_size, 0, stream>>>(
        n, a, b, work_a, work_b, vectors, values, status);
    return cudaGetLastError();
}

} // namespace fullmag::fem::frequency_domain::gpu
