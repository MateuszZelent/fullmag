/* Executed CUDA contract for guarded RK vector normalization. */

#include "gpu/cuda/fields/vector_field_kernels.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_cuda(cudaError_t status, const char *message)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}

template <typename T>
T *device_value(T value)
{
    T *device = nullptr;
    check_cuda(cudaMalloc(&device, sizeof(T)), "cudaMalloc guard fixture");
    check_cuda(
        cudaMemcpy(device, &value, sizeof(T), cudaMemcpyHostToDevice),
        "cudaMemcpy guard fixture H2D");
    return device;
}

double host_value(double *device)
{
    double value = 0.0;
    check_cuda(
        cudaMemcpy(&value, device, sizeof(value), cudaMemcpyDeviceToHost),
        "cudaMemcpy guard fixture D2H");
    return value;
}

void active_invalid_vectors_fail_without_repair()
{
    for (double invalid : {
             0.0,
             std::numeric_limits<double>::denorm_min(),
             std::numeric_limits<double>::quiet_NaN(),
             std::numeric_limits<double>::infinity(),
         }) {
        double *mx = device_value(invalid);
        double *my = device_value(0.0);
        double *mz = device_value(0.0);
        uint8_t *mask = device_value<uint8_t>(1u);
        double *flag = device_value(0.0);
        std::string reason;

        check(
            !fullmag::fem::fullmag_cuda_normalize_vectors(
                mx, my, mz, mask, flag, 1, nullptr, reason),
            "active invalid CUDA RK vector must fail closed");
        check(!reason.empty(), "CUDA RK guard failure must carry a reason");
        const double after = host_value(mx);
        if (std::isnan(invalid)) {
            check(std::isnan(after), "NaN CUDA RK vector must not be repaired");
        } else {
            check(after == invalid, "invalid CUDA RK vector must not be mutated");
        }

        cudaFree(mx);
        cudaFree(my);
        cudaFree(mz);
        cudaFree(mask);
        cudaFree(flag);
    }
}

void inactive_airbox_vector_is_ignored()
{
    double *mx = device_value(std::numeric_limits<double>::quiet_NaN());
    double *my = device_value(0.0);
    double *mz = device_value(0.0);
    uint8_t *mask = device_value<uint8_t>(0u);
    double *flag = device_value(0.0);
    std::string reason;
    check(
        fullmag::fem::fullmag_cuda_normalize_vectors(
            mx, my, mz, mask, flag, 1, nullptr, reason),
        "inactive airbox CUDA vector must be ignored");
    check(std::isnan(host_value(mx)), "inactive airbox vector must remain untouched");
    cudaFree(mx);
    cudaFree(my);
    cudaFree(mz);
    cudaFree(mask);
    cudaFree(flag);
}

void valid_active_vector_is_normalized()
{
    double *mx = device_value(3.0);
    double *my = device_value(4.0);
    double *mz = device_value(0.0);
    uint8_t *mask = device_value<uint8_t>(1u);
    double *flag = device_value(0.0);
    std::string reason;
    check(
        fullmag::fem::fullmag_cuda_normalize_vectors(
            mx, my, mz, mask, flag, 1, nullptr, reason),
        reason.c_str());
    check(std::abs(host_value(mx) - 0.6) < 1.0e-15, "CUDA normalized x");
    check(std::abs(host_value(my) - 0.8) < 1.0e-15, "CUDA normalized y");
    cudaFree(mx);
    cudaFree(my);
    cudaFree(mz);
    cudaFree(mask);
    cudaFree(flag);
}

} // namespace

int main()
{
    active_invalid_vectors_fail_without_repair();
    inactive_airbox_vector_is_ignored();
    valid_active_vector_is_normalized();
    std::printf("FEM CUDA RK guard contract PASS\n");
    return 0;
}
