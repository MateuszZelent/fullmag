#include "gpu/frequency_domain/modal_augmented_ritz.hpp"

#include "gpu/cuda/frequency_domain/modal_projected_pencil.cuh"
#include "gpu/frequency_domain/modal_augmented_pencil.hpp"
#include "gpu/frequency_domain/modal_augmented_qr.hpp"
#include "gpu/frequency_domain/modal_cudss_shift.hpp"
#include "fullmag_fem_cuda_trace.h"

#include <cusparse.h>
#include <math_constants.h>

#include <algorithm>
#include <array>
#include <utility>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <random>
#include <thread>

#if defined(__linux__)
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace fullmag::fem::frequency_domain::gpu {
namespace {

template <class T>
class DeviceArray {
public:
    DeviceArray() = default;
    DeviceArray(const DeviceArray &) = delete;
    DeviceArray &operator=(const DeviceArray &) = delete;
    ~DeviceArray() { (void)close(); }

    bool close() noexcept
    {
        auto *current = std::exchange(pointer_, nullptr);
        return current == nullptr || cudaFree(current) == cudaSuccess;
    }

    bool allocate(std::size_t count)
    {
        return count > 0 && count <= std::numeric_limits<std::size_t>::max() / sizeof(T) &&
            cudaMalloc(&pointer_, count * sizeof(T)) == cudaSuccess;
    }

    bool upload(const void *source, std::size_t count, cudaStream_t stream,
                AugmentedRitzDeviceMeasurements &measured)
    {
        if (!allocate(count) ||
            cudaMemcpyAsync(pointer_, source, count * sizeof(T), cudaMemcpyHostToDevice, stream) != cudaSuccess) {
            return false;
        }
        ++measured.setup_host_upload_count;
        measured.setup_host_upload_bytes += count * sizeof(T);
        return true;
    }

    bool read(void *destination, std::size_t count) const
    {
        return cudaMemcpy(destination, pointer_, count * sizeof(T), cudaMemcpyDeviceToHost) == cudaSuccess;
    }

    T *get() const noexcept { return pointer_; }

private:
    T *pointer_ = nullptr;
};

class ModalIterationTrace {
public:
    explicit ModalIterationTrace(std::uint64_t vector_bytes)
    {
        const cuda_trace::ModalEpsSolveTraceConfigV1 config{0, vector_bytes};
        started_ = cuda_trace::begin_modal_eps_solve_v1(config, &token_);
#if defined(__linux__)
        if (!started_ && token_.flags == cuda_trace::modal_eps_trace_unavailable) {
            // Keep the default execution independent of a user-visible trace
            // artifact. The tiny sample lives in memory and tagged collection
            // continues after that sample fills. Start only after setup and
            // stop before teardown, so setup allocations are outside this scope.
            const int sample = memfd_create("fullmag-cudss-modal-sample", MFD_CLOEXEC);
            if (sample >= 0) {
                const int status = fullmag_fem_cuda_trace_start_modal_v1(
                    sample, 4096, 120000, &capture_token_);
                ::close(sample);
                if (status == FULLMAG_FEM_OK) {
                    started_ = cuda_trace::begin_modal_eps_solve_v1(config, &token_);
                }
            }
        }
#endif
    }

    ~ModalIterationTrace() { finish(); }

    void finish()
    {
        if (finished_) {
            return;
        }
        finished_ = true;
        if (started_) {
            cuda_trace::end_modal_eps_solve_v1(token_, &report_);
        } else {
            report_.flags = token_.flags;
        }
        if (capture_token_ != 0) {
            fullmag_fem_cuda_trace_stats_v1 stats{};
            if (fullmag_fem_cuda_trace_stop_v1(capture_token_, &stats) != FULLMAG_FEM_OK) {
                report_.flags = cuda_trace::modal_eps_trace_lost;
                report_.counter_coverage = 0;
                report_.native_trace_sha256[0] = '\0';
            }
        }
    }

    const auto &report() const noexcept { return report_; }

private:
    cuda_trace::PhaseTokenV1 token_{};
    cuda_trace::ModalEpsSolveTraceV1 report_{};
    std::uint64_t capture_token_ = 0;
    bool started_ = false;
    bool finished_ = false;
};

cudaError_t await_modal_batch(cudaStream_t stream, const PoissonAirboxEigenBlockProblem &problem)
{
    cudaError_t state = cudaSuccess;
    while ((state = cudaStreamQuery(stream)) == cudaErrorNotReady) {
        if (poisson_airbox_modal_cancel_requested(problem)) {
            return cudaErrorNotReady;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return state;
}

struct ModalCudaContext {
    cudaStream_t stream = nullptr;
    cublasHandle_t blas = nullptr;
    cusolverDnHandle_t solver = nullptr;
    cusparseHandle_t sparse = nullptr;
    DeviceArray<std::byte> blas_workspace;

    bool initialize()
    {
        constexpr std::size_t workspace_bytes = 4 * 1024 * 1024;
        return cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking) == cudaSuccess &&
            cublasCreate(&blas) == CUBLAS_STATUS_SUCCESS &&
            cublasSetStream(blas, stream) == CUBLAS_STATUS_SUCCESS &&
            cublasSetPointerMode(blas, CUBLAS_POINTER_MODE_DEVICE) == CUBLAS_STATUS_SUCCESS &&
            blas_workspace.allocate(workspace_bytes) &&
            cublasSetWorkspace(blas, blas_workspace.get(), workspace_bytes) == CUBLAS_STATUS_SUCCESS &&
            cusolverDnCreate(&solver) == CUSOLVER_STATUS_SUCCESS &&
            cusolverDnSetStream(solver, stream) == CUSOLVER_STATUS_SUCCESS &&
            cusparseCreate(&sparse) == CUSPARSE_STATUS_SUCCESS &&
            cusparseSetStream(sparse, stream) == CUSPARSE_STATUS_SUCCESS &&
            cusparseSetPointerMode(sparse, CUSPARSE_POINTER_MODE_DEVICE) == CUSPARSE_STATUS_SUCCESS;
    }

    ~ModalCudaContext() { (void)close(); }

    bool close() noexcept
    {
        bool ok = !stream || cudaStreamSynchronize(stream) == cudaSuccess;
        if (auto library = std::exchange(sparse, nullptr)) {
            ok = (cusparseDestroy(library) == CUSPARSE_STATUS_SUCCESS) && ok;
        }
        if (auto library = std::exchange(solver, nullptr)) {
            ok = (cusolverDnDestroy(library) == CUSOLVER_STATUS_SUCCESS) && ok;
        }
        if (auto library = std::exchange(blas, nullptr)) {
            ok = (cublasDestroy(library) == CUBLAS_STATUS_SUCCESS) && ok;
        }
        ok = blas_workspace.close() && ok;
        if (auto active_stream = std::exchange(stream, nullptr)) {
            ok = (cudaStreamDestroy(active_stream) == cudaSuccess) && ok;
        }
        return ok;
    }
};

class ModalDeviceCsr {
public:
    ~ModalDeviceCsr() { (void)close(); }

    bool close() noexcept
    {
        auto current = std::exchange(descriptor, nullptr);
        const bool descriptor_closed = current == nullptr || cusparseDestroySpMat(current) == CUSPARSE_STATUS_SUCCESS;
        return descriptor_closed & rows.close() & indices.close() & entries.close();
    }

    bool upload(const PoissonAirboxSharedDomainComplexCsrMatrix &matrix, cudaStream_t stream,
                AugmentedRitzDeviceMeasurements &measured)
    {
        static_assert(sizeof(double2) == sizeof(std::complex<double>));
        return rows.upload(matrix.row_offsets.data(), matrix.row_offsets.size(), stream, measured) &&
            indices.upload(matrix.column_indices.data(), matrix.column_indices.size(), stream, measured) &&
            entries.upload(matrix.values.data(), matrix.values.size(), stream, measured) &&
            cusparseCreateCsr(&descriptor, matrix.row_count, matrix.column_count, matrix.values.size(),
                              rows.get(), indices.get(), entries.get(), CUSPARSE_INDEX_32I, CUSPARSE_INDEX_32I,
                              CUSPARSE_INDEX_BASE_ZERO, CUDA_C_64F) == CUSPARSE_STATUS_SUCCESS;
    }

    cusparseSpMatDescr_t descriptor = nullptr;
    DeviceArray<std::uint32_t> rows, indices;
    DeviceArray<double2> entries;
};

struct DenseBlockView {
    double2 *data;
    int rows;
    int stride;
};

class ModalSpmm {
public:
    ~ModalSpmm() { (void)close(); }

    bool close() noexcept
    {
        const auto destroy = [](cusparseDnMatDescr_t &owner) {
            auto descriptor = std::exchange(owner, nullptr);
            return descriptor == nullptr || cusparseDestroyDnMat(descriptor) == CUSPARSE_STATUS_SUCCESS;
        };
        const bool source_closed = destroy(source_);
        const bool target_closed = destroy(target_);
        return workspace_.close() && source_closed && target_closed;
    }

    bool initialize(cusparseHandle_t sparse, cusparseSpMatDescr_t matrix, int columns, DenseBlockView source,
                    DenseBlockView target, const double2 *alpha, const double2 *beta)
    {
        sparse_ = sparse;
        matrix_ = matrix;
        alpha_ = alpha;
        beta_ = beta;
        std::size_t bytes = 0;
        return cusparseCreateDnMat(&source_, source.rows, columns, source.stride, source.data, CUDA_C_64F,
                                   CUSPARSE_ORDER_COL) == CUSPARSE_STATUS_SUCCESS &&
            cusparseCreateDnMat(&target_, target.rows, columns, target.stride, target.data, CUDA_C_64F,
                                 CUSPARSE_ORDER_COL) == CUSPARSE_STATUS_SUCCESS &&
            cusparseSpMM_bufferSize(sparse_, CUSPARSE_OPERATION_NON_TRANSPOSE, CUSPARSE_OPERATION_NON_TRANSPOSE,
                                    alpha_, matrix_, source_, beta_, target_, CUDA_C_64F,
                                    CUSPARSE_SPMM_ALG_DEFAULT, &bytes) == CUSPARSE_STATUS_SUCCESS &&
            (bytes == 0 || workspace_.allocate(bytes));
    }

    bool apply() const
    {
        return cusparseSpMM(sparse_, CUSPARSE_OPERATION_NON_TRANSPOSE, CUSPARSE_OPERATION_NON_TRANSPOSE,
                            alpha_, matrix_, source_, beta_, target_, CUDA_C_64F, CUSPARSE_SPMM_ALG_DEFAULT,
                            workspace_.get()) == CUSPARSE_STATUS_SUCCESS;
    }

private:
    cusparseHandle_t sparse_ = nullptr;
    cusparseSpMatDescr_t matrix_ = nullptr;
    cusparseDnMatDescr_t source_ = nullptr;
    cusparseDnMatDescr_t target_ = nullptr;
    const double2 *alpha_ = nullptr;
    const double2 *beta_ = nullptr;
    DeviceArray<std::byte> workspace_;
};

bool sample_device_usage(std::uint64_t &bytes) noexcept
{
    std::size_t free = 0, total = 0;
    if (cudaMemGetInfo(&free, &total) != cudaSuccess || free > total) {
        return false;
    }
    bytes = total - free;
    return true;
}

std::optional<PoissonAirboxSharedDomainComplexCsrMatrix> assemble_scaled_gyro(
    const CsrMatrixView &gyro, const std::vector<double> &diagonal, double mass_scale)
{
    if (gyro.values_len == 0 || gyro.values_len > std::numeric_limits<std::int32_t>::max() ||
        !std::isfinite(mass_scale) || mass_scale <= 0.0) {
        return std::nullopt;
    }
    PoissonAirboxSharedDomainComplexCsrMatrix matrix;
    matrix.row_count = gyro.row_count;
    matrix.column_count = gyro.column_count;
    matrix.row_offsets.assign(gyro.row_offsets, gyro.row_offsets + gyro.row_offsets_len);
    matrix.column_indices.assign(gyro.column_indices, gyro.column_indices + gyro.column_indices_len);
    matrix.values.resize(gyro.values_len);
    for (std::size_t row = 0; row < gyro.row_count; ++row) {
        for (auto entry = gyro.row_offsets[row]; entry < gyro.row_offsets[row + 1]; ++entry) {
            const double value = mass_scale * gyro.values[entry] * diagonal[row] *
                diagonal[gyro.column_indices[entry]];
            if (!std::isfinite(value)) {
                return std::nullopt;
            }
            matrix.values[entry] = {0.0, value};
        }
    }
    return matrix;
}

std::optional<PoissonAirboxSharedDomainComplexCsrMatrix> assemble_scaled_gyro(
    const PoissonAirboxSharedDomainComplexCsrMatrix &gyro,
    const std::vector<double> &diagonal,
    double mass_scale)
{
    if (gyro.row_count == 0u || gyro.row_count != gyro.column_count || gyro.values.empty() ||
        gyro.values.size() > std::numeric_limits<std::int32_t>::max() ||
        gyro.row_offsets.size() != gyro.row_count + 1u ||
        gyro.column_indices.size() != gyro.values.size() || diagonal.size() < gyro.row_count ||
        !std::isfinite(mass_scale) || mass_scale <= 0.0) {
        return std::nullopt;
    }
    PoissonAirboxSharedDomainComplexCsrMatrix matrix;
    matrix.row_count = gyro.row_count;
    matrix.column_count = gyro.column_count;
    matrix.row_offsets = gyro.row_offsets;
    matrix.column_indices = gyro.column_indices;
    matrix.values.resize(gyro.values.size());
    for (std::size_t row = 0; row < gyro.row_count; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1u] ||
            matrix.row_offsets[row + 1u] > matrix.values.size()) {
            return std::nullopt;
        }
        for (auto entry = matrix.row_offsets[row]; entry < matrix.row_offsets[row + 1u]; ++entry) {
            const auto index = static_cast<std::size_t>(entry);
            const auto column = matrix.column_indices[index];
            if (column >= gyro.column_count ||
                !std::isfinite(gyro.values[index].real()) || !std::isfinite(gyro.values[index].imag())) {
                return std::nullopt;
            }
            auto value = std::complex<double>(0.0, mass_scale) * gyro.values[index];
            value *= diagonal[row];
            value *= diagonal[column];
            if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
                return std::nullopt;
            }
            matrix.values[index] = value;
        }
    }
    return matrix;
}

__global__ void roundoff_hermitian(int columns, double2 *g, double2 *h)
{
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= columns * columns) {
        return;
    }
    const int row = index % columns;
    const int column = index / columns;
    if (row > column) {
        return;
    }
    const int adjoint = column + row * columns;
    const auto g_mean = make_double2(0.5 * g[index].x + 0.5 * g[adjoint].x,
                                     0.5 * g[index].y - 0.5 * g[adjoint].y);
    const auto h_mean = make_double2(0.5 * h[index].x + 0.5 * h[adjoint].x,
                                     0.5 * h[index].y - 0.5 * h[adjoint].y);
    g[index] = g_mean;
    h[index] = h_mean;
    if (row != column) {
        g[adjoint] = cuConj(g_mean);
        h[adjoint] = cuConj(h_mean);
    }
}

__device__ double square_norm(double2 value)
{
    return value.x * value.x + value.y * value.y;
}

__device__ double2 divide(double2 value, double divisor)
{
    return make_double2(value.x / divisor, value.y / divisor);
}

struct ResidualCsrView {
    const std::uint32_t *rows;
    const std::uint32_t *indices;
    const double2 *values;
};

constexpr int residual_threads = 128;

__global__ void modal_residuals(int q, int dimension, const double *scale, double operator_scale,
                                double potential_row_scale, const double *inverse, const double2 *vectors,
                                ResidualCsrView shifted, ResidualCsrView mass, AugmentedRitzCandidate *output)
{
    const int mode = blockIdx.x;
    const int lane = threadIdx.x;
    const double lambda = 1.0 / inverse[mode];
    const auto *vector = vectors + static_cast<std::size_t>(mode) * dimension;
    double magnetic[4]{}, poisson[3]{};
    for (int row = lane; row < q; row += residual_threads) {
        double2 local{}, demag{}, gyro{};
        for (auto entry = shifted.rows[row]; entry < shifted.rows[row + 1]; ++entry) {
            const auto column = shifted.indices[entry];
            // Only the shifted gyrotropic part is imaginary in the real FEM
            // K0 blocks. Recover the original A_qq and A_qphi terms separately.
            const auto value = cuCmul(make_double2(shifted.values[entry].x, 0.0), vector[column]);
            if (column < static_cast<std::uint32_t>(q)) {
                local = cuCadd(local, value);
            } else {
                demag = cuCadd(demag, value);
            }
        }
        for (auto entry = mass.rows[row]; entry < mass.rows[row + 1]; ++entry) {
            gyro = cuCadd(gyro, cuCmul(mass.values[entry], vector[mass.indices[entry]]));
        }
        const double row_scale = operator_scale * scale[row];
        local = divide(local, row_scale);
        demag = divide(demag, row_scale);
        gyro = cuCmul(divide(gyro, row_scale), make_double2(lambda, 0.0));
        magnetic[0] += square_norm(cuCsub(cuCadd(local, demag), gyro));
        magnetic[1] += square_norm(local);
        magnetic[2] += square_norm(demag);
        magnetic[3] += square_norm(gyro);
    }
    for (int row = q + lane; row < dimension; row += residual_threads) {
        double2 source{}, potential{};
        for (auto entry = shifted.rows[row]; entry < shifted.rows[row + 1]; ++entry) {
            const auto column = shifted.indices[entry];
            const auto value = cuCmul(shifted.values[entry], vector[column]);
            if (column < static_cast<std::uint32_t>(q)) {
                source = cuCadd(source, value);
            } else {
                potential = cuCadd(potential, value);
            }
        }
        const double row_scale = potential_row_scale * scale[row];
        source = divide(source, row_scale);
        potential = divide(potential, row_scale);
        poisson[0] += square_norm(cuCadd(source, potential));
        poisson[1] += square_norm(source);
        poisson[2] += square_norm(potential);
    }
    __shared__ double sums[7][residual_threads];
    for (int i = 0; i < 4; ++i) {
        sums[i][lane] = magnetic[i];
    }
    for (int i = 0; i < 3; ++i) {
        sums[i + 4][lane] = poisson[i];
    }
    __syncthreads();
    for (int stride = residual_threads / 2; stride > 0; stride /= 2) {
        if (lane < stride) {
            for (int i = 0; i < 7; ++i) {
                sums[i][lane] += sums[i][lane + stride];
            }
        }
        __syncthreads();
    }
    if (lane == 0) {
        const double q_l2 = sqrt(sums[0][0]);
        const double phi_l2 = sqrt(sums[4][0]);
        const double q_norm = sqrt(sums[1][0]) + sqrt(sums[2][0]) + sqrt(sums[3][0]) + 1.0e-30;
        const double phi_norm = sqrt(sums[5][0]) + sqrt(sums[6][0]) + 1.0e-30;
        const double q_residual = isfinite(q_norm) ? q_l2 / q_norm : CUDART_INF;
        const double phi_residual = isfinite(phi_norm) ? phi_l2 / phi_norm : CUDART_INF;
        output[mode] = {inverse[mode], q_residual, phi_residual, q_l2, phi_l2};
    }
}

__global__ void floquet_modal_residuals(int q, int dimension, const double *scale, double operator_scale,
                                        double shift, double potential_row_scale,
                                        const double *inverse, const double2 *vectors,
                                        ResidualCsrView shifted, ResidualCsrView mass,
                                        AugmentedRitzCandidate *output)
{
    const int mode = blockIdx.x;
    const int lane = threadIdx.x;
    const double lambda_scaled = 1.0 / inverse[mode];
    const auto *vector = vectors + static_cast<std::size_t>(mode) * dimension;
    double magnetic[4]{}, poisson[3]{};
    for (int row = lane; row < q; row += residual_threads) {
        double2 shifted_stiffness{}, demag{}, gyro{};
        for (auto entry = shifted.rows[row]; entry < shifted.rows[row + 1]; ++entry) {
            const auto column = shifted.indices[entry];
            const auto value = cuCmul(shifted.values[entry], vector[column]);
            if (column < static_cast<std::uint32_t>(q)) {
                shifted_stiffness = cuCadd(shifted_stiffness, value);
            } else {
                demag = cuCadd(demag, value);
            }
        }
        for (auto entry = mass.rows[row]; entry < mass.rows[row + 1]; ++entry) {
            gyro = cuCadd(gyro, cuCmul(mass.values[entry], vector[mass.indices[entry]]));
        }
        // H_sigma + shift*(i mass_scale B) restores operator_scale*A_qq
        // before the original eigenvalue term is applied. Keep every complex
        // component from the Floquet assembly in all three contributions.
        const auto local = divide(cuCadd(shifted_stiffness, cuCmul(make_double2(shift, 0.0), gyro)),
                                  operator_scale * scale[row]);
        const auto coupling = divide(demag, operator_scale * scale[row]);
        const auto gyro_term = cuCmul(
            divide(gyro, operator_scale * scale[row]), make_double2(lambda_scaled, 0.0));
        magnetic[0] += square_norm(cuCsub(cuCadd(local, coupling), gyro_term));
        magnetic[1] += square_norm(local);
        magnetic[2] += square_norm(coupling);
        magnetic[3] += square_norm(gyro_term);
    }
    for (int row = q + lane; row < dimension; row += residual_threads) {
        double2 source{}, potential{};
        for (auto entry = shifted.rows[row]; entry < shifted.rows[row + 1]; ++entry) {
            const auto column = shifted.indices[entry];
            const auto value = cuCmul(shifted.values[entry], vector[column]);
            if (column < static_cast<std::uint32_t>(q)) {
                source = cuCadd(source, value);
            } else {
                potential = cuCadd(potential, value);
            }
        }
        const double row_scale = potential_row_scale * scale[row];
        source = divide(source, row_scale);
        potential = divide(potential, row_scale);
        poisson[0] += square_norm(cuCadd(source, potential));
        poisson[1] += square_norm(source);
        poisson[2] += square_norm(potential);
    }
    __shared__ double sums[7][residual_threads];
    for (int i = 0; i < 4; ++i) {
        sums[i][lane] = magnetic[i];
    }
    for (int i = 0; i < 3; ++i) {
        sums[i + 4][lane] = poisson[i];
    }
    __syncthreads();
    for (int stride = residual_threads / 2; stride > 0; stride /= 2) {
        if (lane < stride) {
            for (int i = 0; i < 7; ++i) {
                sums[i][lane] += sums[i][lane + stride];
            }
        }
        __syncthreads();
    }
    if (lane == 0) {
        const double q_l2 = sqrt(sums[0][0]);
        const double phi_l2 = sqrt(sums[4][0]);
        const double q_norm = sqrt(sums[1][0]) + sqrt(sums[2][0]) + sqrt(sums[3][0]) + 1.0e-30;
        const double phi_norm = sqrt(sums[5][0]) + sqrt(sums[6][0]) + 1.0e-30;
        const double q_residual = isfinite(q_norm) ? q_l2 / q_norm : CUDART_INF;
        const double phi_residual = isfinite(phi_norm) ? phi_l2 / phi_norm : CUDART_INF;
        output[mode] = {inverse[mode], q_residual, phi_residual, q_l2, phi_l2};
    }
}

} // namespace

static std::optional<AugmentedRitzBlock> solve_augmented_ritz_impl(
    const PoissonAirboxEigenBlockProblem &problem,
    const FloquetAirboxAugmentedPencilView *floquet_blocks,
    double operator_scale, double mass_scale, double shift, double mu0, int columns,
    const char **failure)
{
    if (!failure) {
        return std::nullopt;
    }
    *failure = nullptr;
    const auto fail = [&](const char *reason) -> std::optional<AugmentedRitzBlock> {
        *failure = reason;
        return std::nullopt;
    };
    const std::uint64_t q_dofs = floquet_blocks != nullptr
        ? floquet_blocks->a_qq.row_count
        : problem.q_dof_count;
    const std::uint64_t phi_dofs = floquet_blocks != nullptr
        ? floquet_blocks->p.row_count
        : problem.phi_dof_count;
    if (columns < 1 || columns > max_projected_pencil_dimension ||
        q_dofs == 0u || phi_dofs == 0u ||
        q_dofs > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ||
        phi_dofs > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) - q_dofs ||
        static_cast<std::uint64_t>(columns) > q_dofs ||
        (floquet_blocks != nullptr &&
         (problem.q_dof_count != q_dofs || problem.phi_dof_count != phi_dofs)) ||
        problem.max_outer_iterations == 0 ||
        problem.max_outer_iterations >= std::numeric_limits<int>::max() / 2 ||
        !std::isfinite(mass_scale) || mass_scale <= 0.0 || !std::isfinite(shift)) {
        return fail("cudss_ritz_invalid_configuration");
    }
    auto pencil = floquet_blocks != nullptr
        ? assemble_floquet_airbox_augmented_pencil(*floquet_blocks, operator_scale, shift * mass_scale, mu0)
        : assemble_open_airbox_augmented_pencil(problem, operator_scale, shift * mass_scale, mu0);
    if (!pencil) {
        return fail("cudss_ritz_invalid_augmented_pencil");
    }
    const auto gyro = floquet_blocks != nullptr
        ? assemble_scaled_gyro(floquet_blocks->b_qq, pencil->equilibration, mass_scale)
        : assemble_scaled_gyro(problem.B_qq, pencil->equilibration, mass_scale);
    if (!gyro) {
        return fail("cudss_ritz_invalid_gyrotropic_mass");
    }
    const int q = static_cast<int>(q_dofs);
    const int n = static_cast<int>(pencil->complex_csr.row_count);
    const auto kb = static_cast<std::size_t>(columns);
    const auto sweeps = static_cast<int>(problem.max_outer_iterations);
    const auto cancelled = [&] {
        return problem.cancel_requested && problem.cancel_requested(problem.cancel_user_data) != 0;
    };
    if (cancelled()) {
        return fail("cudss_ritz_cancelled");
    }
    AugmentedRitzDeviceMeasurements measured;
    measured.memory_sampled = sample_device_usage(measured.memory_at_setup_bytes);
    ModalCudaContext cuda;
    if (!cuda.initialize()) {
        return fail("cudss_ritz_cuda_context_failed");
    }
    auto factor = CudssModalShift::create(*pencil, columns, cuda.stream, failure);
    if (!factor || !factor->prepare_device_replay(failure)) {
        return std::nullopt;
    }
    // The factor accepted three explicit CSR uploads at its input boundary.
    measured.setup_host_upload_count = 3;
    measured.setup_host_upload_bytes =
        pencil->complex_csr.row_offsets.size() * sizeof(std::uint32_t) +
        pencil->complex_csr.column_indices.size() * sizeof(std::uint32_t) +
        pencil->complex_csr.values.size() * sizeof(double2);
    measured.qualified_graph_nodes = factor->device_replay_nodes();
    DeviceArray<double> diagonal, inverse;
    DeviceArray<ProjectedPencilStatus> projected_status;
    DeviceArray<AugmentedRitzCandidate> residuals;
    DeviceArray<double2> basis, lift, stiffness_q, gyro_q, constants;
    DeviceArray<double2> projected_g, projected_h, work_g, work_h, coefficients;
    DeviceArray<double2> mode_vectors;
    if (!basis.allocate(q * kb) || !lift.allocate(n * kb) ||
        !stiffness_q.allocate(n * kb) || !gyro_q.allocate(q * kb) ||
        !projected_g.allocate(kb * kb) || !projected_h.allocate(kb * kb) ||
        !work_g.allocate(kb * kb) || !work_h.allocate(kb * kb) || !coefficients.allocate(kb * kb) ||
        !mode_vectors.allocate(n * kb) ||
        !inverse.allocate(kb) || !residuals.allocate(kb) || !projected_status.allocate(1) ||
        !diagonal.upload(pencil->equilibration.data(), n, cuda.stream, measured)) {
        return fail("cudss_ritz_device_buffers_failed");
    }
    const std::array<double2, 3> scalars{{{1.0, 0.0}, {0.0, 0.0}, {shift, 0.0}}};
    if (!constants.upload(scalars.data(), scalars.size(), cuda.stream, measured)) {
        return fail("cudss_ritz_device_scalars_failed");
    }
    const double2 *one = constants.get(), *zero = one + 1, *theta = one + 2;

    std::vector<double2> seed(q * kb);
    std::mt19937_64 generator(8006);
    const auto sample = [&] { return 2.0 * static_cast<double>(generator() >> 11) * 0x1.0p-53 - 1.0; };
    for (auto &entry : seed) {
        entry = {sample(), sample()};
    }
    if (cudaMemcpyAsync(basis.get(), seed.data(), seed.size() * sizeof(double2),
                        cudaMemcpyHostToDevice, cuda.stream) != cudaSuccess ||
        cudaStreamSynchronize(cuda.stream) != cudaSuccess) {
        return fail("cudss_ritz_seed_upload_failed");
    }

    ++measured.setup_host_upload_count;
    measured.setup_host_upload_bytes += seed.size() * sizeof(double2);

    ModalDeviceCsr shifted_matrix, mass_matrix;
    ModalSpmm build_rhs, apply_shifted, add_shift_back, apply_gyro;
    const DenseBlockView basis_view{basis.get(), q, q};
    if (!shifted_matrix.upload(pencil->complex_csr, cuda.stream, measured) ||
        !mass_matrix.upload(*gyro, cuda.stream, measured) ||
        !build_rhs.initialize(cuda.sparse, mass_matrix.descriptor, columns, basis_view,
                              {factor->rhs(), q, n}, one, zero) ||
        !apply_shifted.initialize(cuda.sparse, shifted_matrix.descriptor, columns, {lift.get(), n, n},
                                   {stiffness_q.get(), n, n}, one, zero) ||
        !add_shift_back.initialize(cuda.sparse, mass_matrix.descriptor, columns, basis_view,
                                   {stiffness_q.get(), q, n}, theta, one) ||
        !apply_gyro.initialize(cuda.sparse, mass_matrix.descriptor, columns, basis_view,
                              {gyro_q.get(), q, q}, one, zero)) {
        return fail("cudss_ritz_sparse_apply_setup_failed");
    }
    auto qr = AugmentedModalQr::create(q, n - q, columns, sweeps + 1, basis.get(), cuda.solver, cuda.blas, cuda.stream);
    if (!qr || cudaStreamSynchronize(cuda.stream) != cudaSuccess) {
        return fail("cudss_ritz_iteration_setup_failed");
    }
    // Normalize the uploaded seed while the CUDA handles are still in
    // setup. This also prepares the vendor QR and sparse multiplication
    // for the repeated solves on this stream.
    if (!qr->enqueue(nullptr) || !build_rhs.apply() || cudaStreamSynchronize(cuda.stream) != cudaSuccess) {
        return fail("cudss_ritz_initial_action_failed");
    }
    measured.memory_sampled =
        sample_device_usage(measured.memory_before_iteration_bytes) && measured.memory_sampled;
    ModalIterationTrace trace(static_cast<std::uint64_t>(n) * sizeof(double2));
    const auto iteration_start = std::chrono::steady_clock::now();
    auto last_progress = iteration_start;
    for (int sweep = 1; sweep <= sweeps; ++sweep) {
        if (cancelled()) {
            return fail("cudss_ritz_cancelled");
        }
        const bool last = sweep == sweeps;
        if (!build_rhs.apply()) {
            return fail("cudss_ritz_block_rhs_failed");
        }
        if (!factor->enqueue_device_replay()) {
            return fail("cudss_ritz_device_replay_failed");
        }
        if (!qr->enqueue(factor->solution(), last ? lift.get() : nullptr, last ? one : nullptr)) {
            return fail("cudss_ritz_block_qr_failed");
        }
        // Bound the amount of submitted work ahead of a cancellation request.
        if (sweep % 4 == 0 || last) {
            if (await_modal_batch(cuda.stream, problem) != cudaSuccess) {
                return fail(cancelled() ? "cudss_ritz_cancelled" : "cudss_ritz_block_sweep_execution_failed");
            }
            const auto now = std::chrono::steady_clock::now();
            if (now - last_progress >= std::chrono::milliseconds(250) || last) {
                auto progress = poisson_airbox_modal_progress_with_elapsed(
                    problem, std::chrono::duration<double>(now - iteration_start).count());
                poisson_airbox_modal_emit_progress(
                    progress, "eigensolve_block_iteration", "production_gpu", sweep, columns, 0u, 0u,
                    std::numeric_limits<double>::quiet_NaN());
                last_progress = now;
            }
        }
    }
    if (cancelled()) {
        return fail("cudss_ritz_cancelled");
    }
    if (!apply_shifted.apply() || !add_shift_back.apply() || !apply_gyro.apply()) {
        return fail("cudss_ritz_projected_actions_failed");
    }
    const auto project = [&](const double2 *applied, int stride, double2 *target) {
        return cublasZgemm(cuda.blas, CUBLAS_OP_C, CUBLAS_OP_N, columns, columns, q, one,
                           basis.get(), q, applied, stride, zero, target, columns) == CUBLAS_STATUS_SUCCESS;
    };
    if (!project(gyro_q.get(), q, projected_g.get()) || !project(stiffness_q.get(), n, projected_h.get())) {
        return fail("cudss_ritz_projection_failed");
    }
    constexpr int symmetrize_threads = 128;
    roundoff_hermitian<<<(columns * columns + symmetrize_threads - 1) / symmetrize_threads,
                         symmetrize_threads, 0, cuda.stream>>>(columns, projected_g.get(), projected_h.get());
    if (cudaGetLastError() != cudaSuccess ||
        launch_projected_pencil(columns, projected_g.get(), projected_h.get(), work_g.get(), work_h.get(),
                                coefficients.get(), inverse.get(), projected_status.get(), cuda.stream) != cudaSuccess) {
        return fail("cudss_ritz_projected_eigensolve_launch_failed");
    }
    if (cublasZgemm(cuda.blas, CUBLAS_OP_N, CUBLAS_OP_N, n, columns, columns, one,
                    lift.get(), n, coefficients.get(), columns, zero, mode_vectors.get(), n) !=
        CUBLAS_STATUS_SUCCESS) {
        return fail("cudss_ritz_modal_reconstruction_failed");
    }
    if (floquet_blocks != nullptr) {
        floquet_modal_residuals<<<columns, residual_threads, 0, cuda.stream>>>(
            q, n, diagonal.get(), operator_scale, shift, pencil->potential_row_scale,
            inverse.get(), mode_vectors.get(),
            {shifted_matrix.rows.get(), shifted_matrix.indices.get(), shifted_matrix.entries.get()},
            {mass_matrix.rows.get(), mass_matrix.indices.get(), mass_matrix.entries.get()}, residuals.get());
    } else {
        modal_residuals<<<columns, residual_threads, 0, cuda.stream>>>(
            q, n, diagonal.get(), operator_scale, pencil->potential_row_scale, inverse.get(), mode_vectors.get(),
            {shifted_matrix.rows.get(), shifted_matrix.indices.get(), shifted_matrix.entries.get()},
            {mass_matrix.rows.get(), mass_matrix.indices.get(), mass_matrix.entries.get()}, residuals.get());
    }
    if (cudaGetLastError() != cudaSuccess || await_modal_batch(cuda.stream, problem) != cudaSuccess) {
        return fail(cancelled() ? "cudss_ritz_cancelled" : "cudss_ritz_residual_execution_failed");
    }
    trace.finish();
    measured.first_export_ns = cuda_trace::host_activity_timestamp_ns();
    if (!qr->complete()) {
        return fail("cudss_ritz_qr_status_failed");
    }
    ProjectedPencilStatus status{};
    if (!projected_status.read(&status, 1)) {
        return fail("cudss_ritz_projected_status_readback_failed");
    }
    switch (status) {
    case ProjectedPencilStatus::converged:
        break;
    case ProjectedPencilStatus::invalid_pencil:
        return fail("cudss_ritz_projected_pencil_invalid");
    case ProjectedPencilStatus::not_positive_definite:
        return fail("cudss_ritz_projected_stiffness_not_positive_definite");
    case ProjectedPencilStatus::iteration_limit:
        return fail("cudss_ritz_projected_eigensolve_iteration_limit");
    default:
        return fail("cudss_ritz_projected_eigensolve_status_unknown");
    }
    AugmentedRitzBlock result;
    result.negative_shift_inertia = factor->negative_inertia();
    result.native_trace = trace.report();
    result.candidates.resize(kb);
    result.vectors.resize(n * kb);
    if (!residuals.read(result.candidates.data(), kb) || !mode_vectors.read(result.vectors.data(), n * kb)) {
        return fail("cudss_ritz_terminal_readback_failed");
    }
    measured.last_export_ns = cuda_trace::host_activity_timestamp_ns();
    // QR status, projection status, modal residuals and the complete vector block.
    measured.vector_export_count = 4;
    measured.vector_export_bytes = 2u * (static_cast<std::uint64_t>(sweeps) + 1u) * sizeof(int) +
        sizeof(status) + kb * sizeof(AugmentedRitzCandidate) + n * kb * sizeof(double2);
    bool closed = true;
    const auto close = [&](auto &...objects) {
        ((closed = objects.close() && closed), ...);
    };
    close(*qr, build_rhs, apply_shifted, add_shift_back, apply_gyro,
          shifted_matrix, mass_matrix, diagonal, inverse, projected_status, residuals,
          basis, lift, stiffness_q, gyro_q, constants, projected_g, projected_h,
          work_g, work_h, coefficients, mode_vectors, *factor, cuda);
    if (!closed) {
        return fail("cudss_ritz_resource_release_failed");
    }
    measured.checked_release = true;
    measured.memory_sampled =
        sample_device_usage(measured.memory_after_release_bytes) && measured.memory_sampled;
    result.measurements = measured;
    for (std::size_t column = 0; column < kb; ++column) {
        for (int row = 0; row < n; ++row) {
            result.vectors[column * n + row] *= pencil->equilibration[row];
        }
    }
    return result;
}

std::optional<AugmentedRitzBlock> solve_open_airbox_augmented_ritz(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale,
    double mass_scale, double shift, double mu0, int columns, const char **failure)
{
    return solve_augmented_ritz_impl(
        problem, nullptr, operator_scale, mass_scale, shift, mu0, columns, failure);
}

std::optional<AugmentedRitzBlock> solve_floquet_airbox_augmented_ritz(
    const PoissonAirboxEigenBlockProblem &controls,
    const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale,
    double mass_scale,
    double shift,
    double mu0,
    int columns,
    const char **failure)
{
    return solve_augmented_ritz_impl(
        controls, &blocks, operator_scale, mass_scale, shift, mu0, columns, failure);
}

} // namespace fullmag::fem::frequency_domain::gpu
