/* Device-resident CUDA contracts for the Fredkin-Koehler BEM apply. */

#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"

#include <cstdio>
#include <cstdlib>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

#if FULLMAG_HAS_CUDA_RUNTIME
template <typename T>
T *upload(const std::vector<T> &values) {
    T *device = nullptr;
    check(
        cudaMalloc(reinterpret_cast<void **>(&device), values.size() * sizeof(T)) == cudaSuccess,
        "CUDA test allocation");
    check(
        cudaMemcpy(device, values.data(), values.size() * sizeof(T), cudaMemcpyHostToDevice) ==
            cudaSuccess,
        "CUDA test upload");
    return device;
}

void device_bem_apply_is_device_resident() {
    const std::vector<uint32_t> near_offsets = {0u, 1u, 2u};
    const std::vector<uint32_t> near_columns = {0u, 1u};
    const std::vector<double> near_values = {2.0, 3.0};
    const std::vector<fullmag::fem::HierarchicalDemagBemFarBlock> far_blocks = {
        {0u, 2u, 0u, 2u, 1u, 0u, 0u},
    };
    const std::vector<double> far_u = {1.0, 2.0};
    const std::vector<double> far_v = {4.0, 5.0};
    const std::vector<uint32_t> permutation = {0u, 1u};
    const std::vector<uint32_t> boundary_tdofs = {3u, 5u};
    const std::vector<double> u1_full = {0.0, 0.0, 0.0, 1.0, 0.0, 2.0};

    uint32_t *d_near_offsets = upload(near_offsets);
    uint32_t *d_near_columns = upload(near_columns);
    double *d_near_values = upload(near_values);
    auto *d_far_blocks = upload(far_blocks);
    double *d_far_u = upload(far_u);
    double *d_far_v = upload(far_v);
    uint32_t *d_permutation = upload(permutation);
    uint32_t *d_boundary_tdofs = upload(boundary_tdofs);
    double *d_u1_full = upload(u1_full);
    double *d_output = nullptr;
    check(cudaMalloc(reinterpret_cast<void **>(&d_output), 2u * sizeof(double)) == cudaSuccess,
          "CUDA test output allocation");

    fullmag::fem::fullmag_cuda_fem_bem_apply(
        d_near_offsets,
        d_near_columns,
        d_near_values,
        d_far_blocks,
        d_far_u,
        d_far_v,
        d_permutation,
        d_boundary_tdofs,
        d_u1_full,
        d_output,
        2,
        1,
        1,
        nullptr);
    check(cudaGetLastError() == cudaSuccess, "CUDA BEM apply launch");
    check(cudaDeviceSynchronize() == cudaSuccess, "CUDA BEM apply synchronization");
    std::vector<double> output(2u, 0.0);
    check(cudaMemcpy(output.data(), d_output, 2u * sizeof(double), cudaMemcpyDeviceToHost) ==
              cudaSuccess,
          "CUDA BEM apply readback");
    check(output[0] == 16.0 && output[1] == 34.0,
          "CUDA BEM apply matches near plus low-rank reference");

    cudaFree(d_near_offsets);
    cudaFree(d_near_columns);
    cudaFree(d_near_values);
    cudaFree(d_far_blocks);
    cudaFree(d_far_u);
    cudaFree(d_far_v);
    cudaFree(d_permutation);
    cudaFree(d_boundary_tdofs);
    cudaFree(d_u1_full);
    cudaFree(d_output);
}
#endif

} // namespace

int main() {
#if FULLMAG_HAS_CUDA_RUNTIME
    device_bem_apply_is_device_resident();
#endif
    return 0;
}
