#pragma once

#include <cublas_v2.h>
#include <cuda_runtime.h>
#include <cusolverDn.h>

#include <algorithm>
#include <limits>
#include <memory>
#include <vector>

namespace fullmag::fem::frequency_domain::gpu {

// Forms the normalized magnetic basis and, on selected steps, its potential
// lift. The solver and BLAS handles must share the caller-owned stream. BLAS
// uses device pointer mode. Construction and terminal status checks are
// outside the measured iterative region.
class AugmentedModalQr {
public:
    static std::unique_ptr<AugmentedModalQr> create(
        int q_rows, int phi_rows, int columns, int capacity, double2 *basis,
        cusolverDnHandle_t solver, cublasHandle_t blas, cudaStream_t stream)
    {
        if (!stream || !basis || !solver || !blas || q_rows < 1 || phi_rows < 1 ||
            q_rows > std::numeric_limits<int>::max() - phi_rows ||
            columns < 1 || columns > q_rows || capacity < 2 ||
            capacity > std::numeric_limits<int>::max() / 2) {
            return nullptr;
        }
        cudaStream_t solver_stream = nullptr;
        cudaStream_t blas_stream = nullptr;
        cublasPointerMode_t pointer_mode{};
        if (cusolverDnGetStream(solver, &solver_stream) != CUSOLVER_STATUS_SUCCESS ||
            cublasGetStream(blas, &blas_stream) != CUBLAS_STATUS_SUCCESS ||
            cublasGetPointerMode(blas, &pointer_mode) != CUBLAS_STATUS_SUCCESS ||
            solver_stream != stream || blas_stream != stream || pointer_mode != CUBLAS_POINTER_MODE_DEVICE) {
            return nullptr;
        }
        auto qr = std::unique_ptr<AugmentedModalQr>(
            new AugmentedModalQr(q_rows, phi_rows, columns, capacity, basis, solver, blas, stream));
        if (cudaMalloc(&qr->tau_, static_cast<std::size_t>(columns) * sizeof(double2)) != cudaSuccess ||
            cusolverDnZgeqrf_bufferSize(solver, q_rows, columns, basis, q_rows, &qr->geqrf_size_) !=
                CUSOLVER_STATUS_SUCCESS ||
            cusolverDnZungqr_bufferSize(solver, q_rows, columns, columns, basis, q_rows,
                                        qr->tau_, &qr->ungqr_size_) != CUSOLVER_STATUS_SUCCESS) {
            return nullptr;
        }
        const int workspace_size = std::max(qr->geqrf_size_, qr->ungqr_size_);
        if (workspace_size <= 0 ||
            cudaMalloc(&qr->workspace_, static_cast<std::size_t>(workspace_size) * sizeof(double2)) != cudaSuccess ||
            cudaMalloc(&qr->device_status_, static_cast<std::size_t>(2 * capacity) * sizeof(int)) != cudaSuccess ||
            cudaMemsetAsync(qr->device_status_, 0xff, static_cast<std::size_t>(2 * capacity) * sizeof(int), stream) !=
                cudaSuccess) {
            return nullptr;
        }
        return qr;
    }

    ~AugmentedModalQr() { (void)close(); }

    bool close() noexcept
    {
        if (!device_status_ && !workspace_ && !tau_) {
            return true;
        }
        bool released = cudaStreamSynchronize(stream_) == cudaSuccess;
        if (device_status_) {
            released = (cudaFree(device_status_) == cudaSuccess) && released;
            device_status_ = nullptr;
        }
        if (workspace_) {
            released = (cudaFree(workspace_) == cudaSuccess) && released;
            workspace_ = nullptr;
        }
        if (tau_) {
            released = (cudaFree(tau_) == cudaSuccess) && released;
            tau_ = nullptr;
        }
        return released;
    }

    AugmentedModalQr(const AugmentedModalQr &) = delete;
    AugmentedModalQr &operator=(const AugmentedModalQr &) = delete;

    // Pass a null shifted_solution for the already-uploaded initial seed.
    // When requested, lifted_basis must be a separate full-size device buffer.
    bool enqueue(const double2 *shifted_solution, double2 *lifted_basis = nullptr,
                 const double2 *device_one = nullptr)
    {
        const bool lift = lifted_basis != nullptr;
        if (failed_ || next_ >= capacity_ || (next_ == 0) != (shifted_solution == nullptr) ||
            lift != (device_one != nullptr) ||
            (lift && (!shifted_solution || lifted_basis == shifted_solution || lifted_basis == basis_))) {
            return false;
        }

        const std::size_t q_pitch = static_cast<std::size_t>(q_rows_) * sizeof(double2);
        const std::size_t total_pitch = static_cast<std::size_t>(q_rows_ + phi_rows_) * sizeof(double2);
        if ((shifted_solution &&
             cudaMemcpy2DAsync(basis_, q_pitch, shifted_solution, total_pitch,
                               q_pitch, columns_, cudaMemcpyDeviceToDevice, stream_) != cudaSuccess) ||
            cusolverDnZgeqrf(solver_, q_rows_, columns_, basis_, q_rows_, tau_, workspace_,
                            geqrf_size_, device_status_ + 2 * next_) != CUSOLVER_STATUS_SUCCESS) {
            failed_ = true;
            return false;
        }
        if (lift &&
            (cudaMemcpy2DAsync(lifted_basis + q_rows_, total_pitch, shifted_solution + q_rows_, total_pitch,
                               total_pitch - q_pitch, columns_, cudaMemcpyDeviceToDevice, stream_) != cudaSuccess ||
             // For X = Q R the Poisson lift of Q is the old lift times R^-1.
             cublasZtrsm(blas_, CUBLAS_SIDE_RIGHT, CUBLAS_FILL_MODE_UPPER, CUBLAS_OP_N, CUBLAS_DIAG_NON_UNIT,
                         phi_rows_, columns_, device_one, basis_, q_rows_, lifted_basis + q_rows_,
                         q_rows_ + phi_rows_) != CUBLAS_STATUS_SUCCESS)) {
            failed_ = true;
            return false;
        }
        if (cusolverDnZungqr(solver_, q_rows_, columns_, columns_, basis_, q_rows_, tau_, workspace_,
                             ungqr_size_, device_status_ + 2 * next_ + 1) != CUSOLVER_STATUS_SUCCESS ||
            (lift && cudaMemcpy2DAsync(lifted_basis, total_pitch, basis_, q_pitch,
                                      q_pitch, columns_, cudaMemcpyDeviceToDevice, stream_) != cudaSuccess)) {
            failed_ = true;
            return false;
        }
        ++next_;
        return true;
    }

    bool complete()
    {
        const std::size_t submitted = static_cast<std::size_t>(2 * next_);
        if (failed_ || next_ < 2 || cudaStreamSynchronize(stream_) != cudaSuccess ||
            cudaMemcpy(host_status_.data(), device_status_, submitted * sizeof(int),
                       cudaMemcpyDeviceToHost) != cudaSuccess) {
            return false;
        }
        return std::all_of(host_status_.begin(), host_status_.begin() + submitted, [](int status) { return status == 0; });
    }

private:
    AugmentedModalQr(int q_rows, int phi_rows, int columns, int capacity, double2 *basis,
                    cusolverDnHandle_t solver, cublasHandle_t blas, cudaStream_t stream)
        : q_rows_(q_rows), phi_rows_(phi_rows), columns_(columns), capacity_(capacity), basis_(basis),
          solver_(solver), blas_(blas), stream_(stream), host_status_(2 * capacity)
    {
    }

    int q_rows_;
    int phi_rows_;
    int columns_;
    int capacity_;
    double2 *basis_;
    cusolverDnHandle_t solver_;
    cublasHandle_t blas_;
    cudaStream_t stream_;
    std::vector<int> host_status_;
    int next_ = 0;
    int geqrf_size_ = 0;
    int ungqr_size_ = 0;
    bool failed_ = false;
    double2 *tau_ = nullptr;
    double2 *workspace_ = nullptr;
    int *device_status_ = nullptr;
};

} // namespace fullmag::fem::frequency_domain::gpu
