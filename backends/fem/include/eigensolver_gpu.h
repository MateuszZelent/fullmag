#ifndef FULLMAG_FEM_EIGENSOLVER_GPU_H
#define FULLMAG_FEM_EIGENSOLVER_GPU_H

#include <cuda_runtime.h>
#include <cusolverDn.h>

extern "C" {

/**
 * @brief Query the required workspace size for the eigensolver.
 *
 * @param handle cusolverDn handle.
 * @param n Matrix dimension.
 * @param lwork Output pointer to workspace size.
 */
int fullmag_eigensolver_syevd_gpu_bufferSize(
    cusolverDnHandle_t handle,
    int n,
    int* lwork);

/**
 * @brief Optimized GPU dense symmetric eigensolver.
 *
 * @param handle cusolverDn handle.
 * @param n Matrix dimension.
 * @param d_A Pointer to input matrix in device memory.
 * @param d_W Pointer to output eigenvalues in device memory.
 * @param d_work Pointer to workspace in device memory.
 * @param lwork Workspace size.
 * @param devInfo Pointer to error code in device memory.
 */
int fullmag_eigensolver_syevd_gpu(
    cusolverDnHandle_t handle,
    int n,
    double* d_A,
    double* d_W,
    double* d_work,
    int lwork,
    int* devInfo);

}

#endif // FULLMAG_FEM_EIGENSOLVER_GPU_H
