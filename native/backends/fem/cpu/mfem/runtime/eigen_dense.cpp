/*
 * Dense generalized eigensolver runtime source contract.
 *
 * This source owns descriptor validation, unavailable-path reason strings, and
 * optional CUDA/cuSolverDN dispatch for dense generalized FEM eigenproblems.
 * It does not own exported C ABI entrypoint plumbing, backend handles, Context
 * construction, MFEM lifecycle, interaction physics, or time integration.
 */

#include "cpu/mfem/runtime/eigen_dense.hpp"

#include <cstdio>

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && defined(FULLMAG_HAS_CUSOLVER)
#include <cuda_runtime.h>
#include <cusolverDn.h>
#endif

namespace fullmag::fem {

namespace {

void eigen_dense_set_reason(fullmag_fem_eigen_dense_desc *desc, const char *msg) {
    if (desc != nullptr && desc->out_reason != nullptr && desc->reason_len > 0) {
        std::snprintf(desc->out_reason, static_cast<size_t>(desc->reason_len), "%s", msg);
    }
}

} // namespace

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && defined(FULLMAG_HAS_CUSOLVER)

int solve_dense_generalized_eigenproblem(fullmag_fem_eigen_dense_desc *desc) {
    if (desc == nullptr) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    const uint32_t n = desc->n;
    const uint32_t ne = desc->n_eigenvalues;
    if (n == 0 || ne == 0 || ne > n) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: invalid dimensions (n=0 or n_eigenvalues>n)");
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (desc->k_lower_col_major == nullptr || desc->m_lower_col_major == nullptr ||
        desc->out_eigenvalues == nullptr || desc->out_eigenvectors == nullptr) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: null pointer in descriptor");
        return FULLMAG_FEM_ERR_INVALID;
    }

    cusolverDnHandle_t solver_handle = nullptr;
    cusolverStatus_t status = cusolverDnCreate(&solver_handle);
    if (status != CUSOLVER_STATUS_SUCCESS) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cusolverDnCreate failed");
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    // cusolverDnDsygvd operates on full column-major matrices, using the lower triangle.
    const size_t mat_bytes = static_cast<size_t>(n) * static_cast<size_t>(n) * sizeof(double);
    double *d_K = nullptr;
    double *d_M = nullptr;
    double *d_W = nullptr;
    cudaError_t cerr;
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_K), mat_bytes);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc K failed");
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_M), mat_bytes);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc M failed");
        cudaFree(d_K);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_W), static_cast<size_t>(n) * sizeof(double));
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc W failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    cerr = cudaMemcpy(d_K, desc->k_lower_col_major, mat_bytes, cudaMemcpyHostToDevice);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy K host->device failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    cerr = cudaMemcpy(d_M, desc->m_lower_col_major, mat_bytes, cudaMemcpyHostToDevice);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy M host->device failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    int lwork = 0;
    status = cusolverDnDsygvd_bufferSize(
        solver_handle,
        CUSOLVER_EIG_TYPE_1,
        CUSOLVER_EIG_MODE_VECTOR,
        CUBLAS_FILL_MODE_LOWER,
        static_cast<int>(n),
        d_K,
        static_cast<int>(n),
        d_M,
        static_cast<int>(n),
        d_W,
        &lwork);
    if (status != CUSOLVER_STATUS_SUCCESS) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cusolverDnDsygvd_bufferSize failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    double *d_work = nullptr;
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_work), static_cast<size_t>(lwork) * sizeof(double));
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc work failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    int *d_info = nullptr;
    cerr = cudaMalloc(reinterpret_cast<void **>(&d_info), sizeof(int));
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMalloc info failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cudaFree(d_work);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    status = cusolverDnDsygvd(
        solver_handle,
        CUSOLVER_EIG_TYPE_1,
        CUSOLVER_EIG_MODE_VECTOR,
        CUBLAS_FILL_MODE_LOWER,
        static_cast<int>(n),
        d_K,
        static_cast<int>(n),
        d_M,
        static_cast<int>(n),
        d_W,
        d_work,
        lwork,
        d_info);

    int h_info = 0;
    cudaMemcpy(&h_info, d_info, sizeof(int), cudaMemcpyDeviceToHost);
    cudaFree(d_info);
    cudaFree(d_work);

    if (status != CUSOLVER_STATUS_SUCCESS || h_info != 0) {
        char buf[128];
        std::snprintf(
            buf,
            sizeof(buf),
            "fullmag_fem_eigen_dense: cusolverDnDsygvd failed (status=%d, info=%d)",
            static_cast<int>(status),
            h_info);
        eigen_dense_set_reason(desc, buf);
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    cerr = cudaMemcpy(
        desc->out_eigenvalues,
        d_W,
        static_cast<size_t>(ne) * sizeof(double),
        cudaMemcpyDeviceToHost);
    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy eigenvalues device->host failed");
        cudaFree(d_K);
        cudaFree(d_M);
        cudaFree(d_W);
        cusolverDnDestroy(solver_handle);
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    cerr = cudaMemcpy(
        desc->out_eigenvectors,
        d_K,
        static_cast<size_t>(n) * static_cast<size_t>(ne) * sizeof(double),
        cudaMemcpyDeviceToHost);

    cudaFree(d_K);
    cudaFree(d_M);
    cudaFree(d_W);
    cusolverDnDestroy(solver_handle);

    if (cerr != cudaSuccess) {
        eigen_dense_set_reason(desc, "fullmag_fem_eigen_dense: cudaMemcpy eigenvectors device->host failed");
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    if (desc->out_reason != nullptr && desc->reason_len > 0) {
        std::snprintf(
            desc->out_reason,
            static_cast<size_t>(desc->reason_len),
            "fullmag_fem_eigen_dense: solved %ux%u in cuSolverDN (Dsygvd)",
            n,
            n);
    }
    return FULLMAG_FEM_OK;
}

#else

int solve_dense_generalized_eigenproblem(fullmag_fem_eigen_dense_desc *desc) {
    static const char *kMsg =
        "fullmag_fem_eigen_dense: GPU dense eigensolver unavailable - "
        "rebuild with CUDA runtime and cuSolver support "
        "(FULLMAG_HAS_CUDA_RUNTIME + FULLMAG_HAS_CUSOLVER)";
    eigen_dense_set_reason(desc, kMsg);
    return FULLMAG_FEM_ERR_UNAVAILABLE;
}

#endif

} // namespace fullmag::fem
