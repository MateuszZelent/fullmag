#include "gpu/cuda/frequency_domain/modal_projected_pencil.cuh"

#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

namespace {

namespace gpu = fullmag::fem::frequency_domain::gpu;
using Complex = std::complex<double>;
using Matrix = std::vector<Complex>;

void check(bool pass, const char *message)
{
    if (!pass) {
        std::fprintf(stderr, "GPU projected pencil: %s\n", message);
        std::exit(1);
    }
}

void check_cuda(cudaError_t status)
{
    check(status == cudaSuccess, cudaGetErrorString(status));
}

template <class T>
class DeviceBuffer {
public:
    explicit DeviceBuffer(std::size_t count)
    {
        check_cuda(cudaMalloc(reinterpret_cast<void **>(&data), count * sizeof(T)));
    }

    ~DeviceBuffer() { cudaFree(data); }
    DeviceBuffer(const DeviceBuffer &) = delete;
    DeviceBuffer &operator=(const DeviceBuffer &) = delete;
    T *data = nullptr;
};

Matrix multiply(const Matrix &a, const Matrix &b, int n, bool adjoint_b = false)
{
    Matrix output(n * n);
    for (int j = 0; j < n; ++j) {
        for (int k = 0; k < n; ++k) {
            const Complex coefficient = adjoint_b ? std::conj(b[j + n * k]) : b[k + n * j];
            for (int i = 0; i < n; ++i) {
                output[i + n * j] += a[i + n * k] * coefficient;
            }
        }
    }
    return output;
}

std::vector<double2> as_double2(const Matrix &input)
{
    std::vector<double2> result;
    result.reserve(input.size());
    for (const Complex value : input) {
        result.push_back(make_double2(value.real(), value.imag()));
    }
    return result;
}

void verify(const Matrix &a, const Matrix &b, const std::vector<double> &expected,
            gpu::ProjectedPencilStatus expected_status = gpu::ProjectedPencilStatus::converged)
{
    const int n = static_cast<int>(expected.size());
    const std::size_t extent = static_cast<std::size_t>(n) * n;
    const auto input_a = as_double2(a);
    const auto input_b = as_double2(b);
    DeviceBuffer<double2> a_dev(extent), b_dev(extent), work_a(extent), work_b(extent), x_dev(extent);
    DeviceBuffer<double> values_dev(n);
    DeviceBuffer<gpu::ProjectedPencilStatus> status_dev(1);
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
    check_cuda(cudaMemcpyAsync(a_dev.data, input_a.data(), extent * sizeof(double2),
                               cudaMemcpyHostToDevice, stream));
    check_cuda(cudaMemcpyAsync(b_dev.data, input_b.data(), extent * sizeof(double2),
                               cudaMemcpyHostToDevice, stream));
    // Verify that a warmed call can be inserted into a device-only iteration.
    check_cuda(gpu::launch_projected_pencil(
        n, a_dev.data, b_dev.data, work_a.data, work_b.data,
        x_dev.data, values_dev.data, status_dev.data, stream));
    check_cuda(cudaMemsetAsync(status_dev.data, 0xff, sizeof(gpu::ProjectedPencilStatus), stream));
    check_cuda(cudaStreamSynchronize(stream));
    check_cuda(cudaStreamBeginCapture(stream, cudaStreamCaptureModeThreadLocal));
    check_cuda(gpu::launch_projected_pencil(
        n, a_dev.data, b_dev.data, work_a.data, work_b.data,
        x_dev.data, values_dev.data, status_dev.data, stream));
    cudaGraph_t graph = nullptr;
    check_cuda(cudaStreamEndCapture(stream, &graph));
    cudaGraphNode_t node = nullptr;
    std::size_t nodes = 0;
    check_cuda(cudaGraphGetNodes(graph, nullptr, &nodes));
    check(nodes == 1, "projection must capture one CUDA graph node");
    check_cuda(cudaGraphGetNodes(graph, &node, &nodes));
    check(node != nullptr, "missing captured CUDA graph node");
    cudaGraphNodeType type = cudaGraphNodeTypeEmpty;
    check_cuda(cudaGraphNodeGetType(node, &type));
    check(type == cudaGraphNodeTypeKernel, "projection graph must contain only a kernel");
    cudaGraphExec_t executable = nullptr;
    check_cuda(cudaGraphInstantiate(&executable, graph, 0));
    check_cuda(cudaGraphLaunch(executable, stream));
    check_cuda(cudaStreamSynchronize(stream));
    check_cuda(cudaGraphExecDestroy(executable));
    check_cuda(cudaGraphDestroy(graph));
    check_cuda(cudaStreamDestroy(stream));
    gpu::ProjectedPencilStatus status{};
    check_cuda(cudaMemcpy(&status, status_dev.data, sizeof(status), cudaMemcpyDeviceToHost));
    check(status == expected_status, "unexpected device eigenproblem status");
    if (status != gpu::ProjectedPencilStatus::converged) {
        return;
    }

    std::vector<double2> output(extent);
    std::vector<double> values(n);
    check_cuda(cudaMemcpy(output.data(), x_dev.data, extent * sizeof(double2), cudaMemcpyDeviceToHost));
    check_cuda(cudaMemcpy(values.data(), values_dev.data, n * sizeof(double), cudaMemcpyDeviceToHost));
    Matrix x(extent);
    for (std::size_t i = 0; i < extent; ++i) {
        x[i] = Complex(output[i].x, output[i].y);
    }
    const Matrix ax = multiply(a, x, n);
    const Matrix bx = multiply(b, x, n);
    double max_error = 0.0;
    double max_backward_error = 0.0;
    double max_b_orthogonality_error = 0.0;
    double a_norm2 = 0.0;
    double b_norm2 = 0.0;
    double reference_scale = 0.0;
    for (int i = 0; i < n; ++i) {
        reference_scale = std::max(reference_scale, std::abs(expected[i]));
    }
    if (reference_scale == 0.0) {
        reference_scale = 1.0;
    }
    for (std::size_t i = 0; i < extent; ++i) {
        a_norm2 += std::norm(a[i]);
        b_norm2 += std::norm(b[i]);
    }
    for (int j = 0; j < n; ++j) {
        check(std::isfinite(values[j]) && (j == 0 || values[j - 1] <= values[j]),
              "eigenvalues must be finite and ordered");
        max_error = std::max(max_error, std::abs(values[j] - expected[j]) / reference_scale);
        double residual2 = 0.0;
        double x_norm2 = 0.0;
        for (int i = 0; i < n; ++i) {
            check(std::isfinite(x[i + n * j].real()) && std::isfinite(x[i + n * j].imag()),
                  "eigenvectors must be finite");
            residual2 += std::norm(ax[i + n * j] - values[j] * bx[i + n * j]);
            x_norm2 += std::norm(x[i + n * j]);
        }
        const double denominator = std::sqrt(x_norm2) * (std::sqrt(a_norm2) + std::abs(values[j]) * std::sqrt(b_norm2));
        check(denominator > 0.0 || residual2 == 0.0, "invalid original-pencil residual");
        if (denominator > 0.0) {
            max_backward_error = std::max(max_backward_error, std::sqrt(residual2) / denominator);
        }
        for (int k = 0; k < n; ++k) {
            Complex overlap{};
            for (int i = 0; i < n; ++i) {
                overlap += std::conj(x[i + n * k]) * bx[i + n * j];
            }
            max_b_orthogonality_error = std::max(max_b_orthogonality_error,
                std::abs(overlap - Complex(j == k ? 1.0 : 0.0)));
        }
    }
    std::fprintf(stderr, "GPU projected pencil n=%d eigenvalue_error=%.3e residual=%.3e b_orthogonality=%.3e\n",
                 n, max_error, max_backward_error, max_b_orthogonality_error);
    check(max_error <= 1.0e-12 && max_backward_error <= 1.0e-12 && max_b_orthogonality_error <= 1.0e-12,
          "generalized eigensystem failed independent original-pencil checks");
}

void verify_synthetic(int n)
{
    std::vector<double> values(n);
    Matrix l(n * n), unitary(n * n);
    for (int j = 0; j < n; ++j) {
        values[j] = j < 3 ? -1.0 : static_cast<double>(j - 4) / n;
        l[j + n * j] = 0.6 + static_cast<double>(j) / n;
        for (int i = j + 1; i < n; ++i) {
            l[i + n * j] = Complex(std::sin(i + j), std::cos(i - j)) / (5.0 * n);
        }
        for (int i = 0; i < n; ++i) {
            unitary[i + n * j] = std::polar(1.0 / std::sqrt(n), 6.283185307179586 * i * j / n);
        }
    }
    const Matrix rotated = multiply(l, unitary, n);
    Matrix weighted = rotated;
    for (int j = 0; j < n; ++j) {
        for (int i = 0; i < n; ++i) {
            weighted[i + n * j] *= values[j];
        }
    }
    verify(multiply(weighted, rotated, n, true), multiply(l, l, n, true), values);
}

void verify_physical(const char *input_path)
{
    std::ifstream input(input_path);
    int n = 0;
    input >> n;
    check(input.good() && n >= 1 && n <= gpu::max_projected_pencil_dimension, "invalid physical fixture dimension");
    Matrix a(n * n), b(n * n);
    for (auto *matrix : {&a, &b}) {
        for (auto &value : *matrix) {
            double real = 0.0, imag = 0.0;
            input >> real >> imag;
            value = Complex(real, imag);
        }
    }
    std::vector<double> values(n);
    for (auto &value : values) {
        input >> value;
    }
    check(!input.fail(), "short physical fixture");
    verify(a, b, values);
}

} // namespace

void verify_gpu_projected_pencil()
{
    for (const int dimension : {1, 2, 11, 40, 65}) {
        verify_synthetic(dimension);
    }
    verify(Matrix(1), Matrix{1.0}, {0.0});
    verify(Matrix{1.0, 0.0, 0.0, 1.0}, Matrix{1.0, 0.0, 0.0, -1.0}, {0.0, 0.0},
           gpu::ProjectedPencilStatus::not_positive_definite);
    if (const char *path = std::getenv("FULLMAG_GPU_PROJECTED_PENCIL_INPUT")) {
        verify_physical(path);
    }
}
