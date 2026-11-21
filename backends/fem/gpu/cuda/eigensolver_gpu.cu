#include "eigensolver_gpu.h"
#include <cusolverDn.h>

int fullmag_eigensolver_syevd_gpu_bufferSize(
    cusolverDnHandle_t handle,
    int n,
    int* lwork) {
    
    cusolverStatus_t status = cusolverDnDsyevd_bufferSize(
        handle,
        CUSOLVER_EIG_MODE_VECTOR,
        CUBLAS_FILL_MODE_LOWER,
        n,
        nullptr, // d_A not needed for buffer size
        n,
        nullptr, // d_W not needed for buffer size
        lwork);

    if (status != CUSOLVER_STATUS_SUCCESS) {
        return 1;
    }

    return 0;
}

int fullmag_eigensolver_syevd_gpu(
    cusolverDnHandle_t handle,
    int n,
    double* d_A,
    double* d_W,
    double* d_work,
    int lwork,
    int* devInfo) {

    cusolverStatus_t status = cusolverDnDsyevd(
        handle,
        CUSOLVER_EIG_MODE_VECTOR,
        CUBLAS_FILL_MODE_LOWER,
        n,
        d_A,
        n,
        d_W,
        d_work,
        lwork,
        devInfo);

    if (status != CUSOLVER_STATUS_SUCCESS) {
        return 1;
    }

    return 0;
}
