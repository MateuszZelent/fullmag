/*
 * Device-resident CSR apply plan.
 *
 * The plan deliberately owns setup-time work: CSR shape inspection, bounded
 * candidate timing, cuSPARSE descriptors, and persistent dense scratch for
 * the three-column path.  The hot apply path only updates descriptor values
 * and enqueues kernels on the caller's stream.
 */

#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <new>
#include <sstream>
#include <utility>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#ifndef FULLMAG_HAS_CUSPARSE
#define FULLMAG_HAS_CUSPARSE 0
#endif
#if FULLMAG_HAS_CUSPARSE
#include <cusparse.h>
#endif
#endif

namespace fullmag::fem {

namespace {

constexpr std::size_t kVariantCount = 5u;
constexpr int kBenchmarkRepetitions = 2;

std::size_t variant_index(SparseApplyVariant variant) noexcept
{
    return static_cast<std::size_t>(variant);
}

bool is_known_variant(SparseApplyVariant variant) noexcept
{
    return variant_index(variant) < kVariantCount;
}

#if FULLMAG_HAS_CUDA_RUNTIME

bool cuda_ok(cudaError_t status, const char *operation, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(status);
    return false;
}

#if FULLMAG_HAS_CUSPARSE

bool cusparse_ok(
    cusparseStatus_t status,
    const char *operation,
    std::string &error)
{
    if (status == CUSPARSE_STATUS_SUCCESS) {
        return true;
    }
    error = std::string(operation) + " failed with cuSPARSE status " +
        std::to_string(static_cast<int>(status));
    return false;
}

#endif

#endif

} // namespace

const char *sparse_apply_variant_name(SparseApplyVariant variant) noexcept
{
    switch (variant) {
    case SparseApplyVariant::ScalarRow: return "scalar_row";
    case SparseApplyVariant::Subwarp: return "subwarp";
    case SparseApplyVariant::Warp: return "warp";
    case SparseApplyVariant::CusparseSpmv: return "cusparse_spmv";
    case SparseApplyVariant::CusparseSpmm3: return "cusparse_spmm3";
    }
    return "unsupported";
}

std::uint32_t sparse_apply_variant_id(SparseApplyVariant variant) noexcept
{
    return is_known_variant(variant)
        ? static_cast<std::uint32_t>(variant_index(variant) + 1u)
        : 0u;
}

struct SparseApplyPlan::Impl {
    SparseApplyCsrDeviceView csr{};
    SparseApplyVariant selected = SparseApplyVariant::ScalarRow;
    std::array<bool, kVariantCount> supported{};
    std::uint64_t setup_count = 0;
    std::uint64_t apply_count = 0;
    bool configured = false;
    std::string provenance;

#if FULLMAG_HAS_CUDA_RUNTIME
    double *scratch_input = nullptr;
    double *scratch_output = nullptr;
    std::size_t scratch_input_count = 0;
    std::size_t scratch_output_count = 0;
#if FULLMAG_HAS_CUSPARSE
    cusparseHandle_t handle = nullptr;
    cusparseSpMatDescr_t matrix = nullptr;
    std::array<cusparseDnVecDescr_t, 3> spmv_input{};
    std::array<cusparseDnVecDescr_t, 3> spmv_output{};
    cusparseDnMatDescr_t spmm_input = nullptr;
    cusparseDnMatDescr_t spmm_output = nullptr;
    void *spmv_buffer = nullptr;
    std::size_t spmv_buffer_bytes = 0;
    void *spmm_buffer = nullptr;
    std::size_t spmm_buffer_bytes = 0;
#endif

    void release_cuda_state() noexcept;

#if FULLMAG_HAS_CUSPARSE
    bool apply_spmv(
        const SparseApplyXyzDeviceView &vectors,
        FullmagSparseApplyStream stream,
        std::string &error);

    bool apply_spmm3(
        const SparseApplyXyzDeviceView &vectors,
        FullmagSparseApplyStream stream,
        std::string &error);
#endif

    bool benchmark_variant(
        SparseApplyVariant variant,
        FullmagSparseApplyStream stream,
        float &elapsed_ms,
        std::string &error);
#endif
};

#if FULLMAG_HAS_CUDA_RUNTIME

void SparseApplyPlan::Impl::release_cuda_state() noexcept
{
#if FULLMAG_HAS_CUSPARSE
    for (auto &descriptor : spmv_input) {
        if (descriptor != nullptr) {
            cusparseDestroyDnVec(descriptor);
            descriptor = nullptr;
        }
    }
    for (auto &descriptor : spmv_output) {
        if (descriptor != nullptr) {
            cusparseDestroyDnVec(descriptor);
            descriptor = nullptr;
        }
    }
    if (spmm_input != nullptr) {
        cusparseDestroyDnMat(spmm_input);
        spmm_input = nullptr;
    }
    if (spmm_output != nullptr) {
        cusparseDestroyDnMat(spmm_output);
        spmm_output = nullptr;
    }
    if (matrix != nullptr) {
        cusparseDestroySpMat(matrix);
        matrix = nullptr;
    }
    if (handle != nullptr) {
        cusparseDestroy(handle);
        handle = nullptr;
    }
    if (spmm_buffer != nullptr) {
        cudaFree(spmm_buffer);
        spmm_buffer = nullptr;
    }
    if (spmv_buffer != nullptr) {
        cudaFree(spmv_buffer);
        spmv_buffer = nullptr;
    }
    spmm_buffer_bytes = 0;
    spmv_buffer_bytes = 0;
#endif
    if (scratch_output != nullptr) {
        cudaFree(scratch_output);
        scratch_output = nullptr;
    }
    if (scratch_input != nullptr) {
        cudaFree(scratch_input);
        scratch_input = nullptr;
    }
    scratch_input_count = 0;
    scratch_output_count = 0;
}

#if FULLMAG_HAS_CUSPARSE

bool SparseApplyPlan::Impl::apply_spmv(
    const SparseApplyXyzDeviceView &vectors,
    FullmagSparseApplyStream stream,
    std::string &error)
{
    if (!cusparse_ok(
            cusparseSetStream(handle, stream),
            "cusparseSetStream",
            error)) {
        return false;
    }
    const double alpha = 1.0;
    const double beta = 0.0;
    const std::array<const double *, 3> inputs{vectors.x, vectors.y, vectors.z};
    const std::array<double *, 3> outputs{vectors.out_x, vectors.out_y, vectors.out_z};
    for (std::size_t component = 0; component < inputs.size(); ++component) {
        if (!cusparse_ok(
                cusparseDnVecSetValues(
                    spmv_input[component],
                    const_cast<double *>(inputs[component])),
                "cusparseDnVecSetValues(input)",
                error) ||
            !cusparse_ok(
                cusparseDnVecSetValues(spmv_output[component], outputs[component]),
                "cusparseDnVecSetValues(output)",
                error)) {
            return false;
        }
        if (!cusparse_ok(
                cusparseSpMV(
                    handle,
                    CUSPARSE_OPERATION_NON_TRANSPOSE,
                    &alpha,
                    matrix,
                    spmv_input[component],
                    &beta,
                    spmv_output[component],
                    CUDA_R_64F,
                    CUSPARSE_SPMV_ALG_DEFAULT,
                    spmv_buffer),
                "cusparseSpMV",
                error)) {
            return false;
        }
    }
    if (vectors.active_mask != nullptr) {
        if (!sparse_apply_detail::launch_mask_xyz(
                vectors.out_x,
                vectors.out_y,
                vectors.out_z,
                static_cast<int>(csr.rows),
                stream,
                vectors.active_mask)) {
            error = "sparse apply mask launch failed";
            return false;
        }
    }
    return true;
}

bool SparseApplyPlan::Impl::apply_spmm3(
    const SparseApplyXyzDeviceView &vectors,
    FullmagSparseApplyStream stream,
    std::string &error)
{
    if (!sparse_apply_detail::launch_pack_xyz(
            vectors.x,
            vectors.y,
            vectors.z,
            scratch_input,
            static_cast<int>(csr.cols),
            stream)) {
        error = "sparse apply XYZ pack rejected parameters";
        return false;
    }
    if (!cuda_ok(cudaGetLastError(), "sparse apply XYZ pack enqueue", error)) {
        return false;
    }
    if (!cusparse_ok(
            cusparseSetStream(handle, stream),
            "cusparseSetStream",
            error)) {
        return false;
    }
    const double alpha = 1.0;
    const double beta = 0.0;
    if (!cusparse_ok(
            cusparseSpMM(
                handle,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                &alpha,
                matrix,
                spmm_input,
                &beta,
                spmm_output,
                CUDA_R_64F,
                CUSPARSE_SPMM_ALG_DEFAULT,
                spmm_buffer),
            "cusparseSpMM",
            error)) {
        return false;
    }
    if (!sparse_apply_detail::launch_unpack_xyz(
            scratch_output,
            vectors.out_x,
            vectors.out_y,
            vectors.out_z,
            static_cast<int>(csr.rows),
            stream,
            vectors.active_mask)) {
        error = "sparse apply XYZ unpack rejected parameters";
        return false;
    }
    return cuda_ok(cudaGetLastError(), "sparse apply XYZ unpack enqueue", error);
}

#endif

bool SparseApplyPlan::Impl::benchmark_variant(
    SparseApplyVariant variant,
    FullmagSparseApplyStream stream,
    float &elapsed_ms,
    std::string &error)
{
    cudaEvent_t start = nullptr;
    cudaEvent_t stop = nullptr;
    if (!cuda_ok(
            cudaEventCreateWithFlags(&start, cudaEventDefault),
            "cudaEventCreate(start)",
            error) ||
        !cuda_ok(
            cudaEventCreateWithFlags(&stop, cudaEventDefault),
            "cudaEventCreate(stop)",
            error)) {
        if (start != nullptr) cudaEventDestroy(start);
        if (stop != nullptr) cudaEventDestroy(stop);
        return false;
    }

    const int rows = static_cast<int>(csr.rows);
    const int cols = static_cast<int>(csr.cols);
    const SparseApplyXyzDeviceView scratch_vectors{
        scratch_input,
        scratch_input + cols,
        scratch_input + 2 * cols,
        scratch_output,
        scratch_output + rows,
        scratch_output + 2 * rows,
        nullptr,
    };
    auto enqueue = [&]() {
        switch (variant) {
        case SparseApplyVariant::ScalarRow:
        case SparseApplyVariant::Subwarp:
        case SparseApplyVariant::Warp:
            return sparse_apply_detail::launch_xyz_csr(
                csr.row_offsets,
                csr.col_indices,
                csr.values,
                scratch_vectors.x,
                scratch_vectors.y,
                scratch_vectors.z,
                scratch_vectors.out_x,
                scratch_vectors.out_y,
                scratch_vectors.out_z,
                rows,
                variant,
                stream,
                scratch_vectors.active_mask);
#if FULLMAG_HAS_CUSPARSE
        case SparseApplyVariant::CusparseSpmv:
            return apply_spmv(scratch_vectors, stream, error);
        case SparseApplyVariant::CusparseSpmm3:
            return apply_spmm3(scratch_vectors, stream, error);
#else
        case SparseApplyVariant::CusparseSpmv:
        case SparseApplyVariant::CusparseSpmm3:
            error = "cuSPARSE support is not compiled into the FEM GPU runtime";
            return false;
#endif
        }
        error = "unsupported sparse apply benchmark variant";
        return false;
    };

    for (int i = 0; i < 1; ++i) {
        if (!enqueue() || !cuda_ok(cudaGetLastError(), "sparse apply warmup", error)) {
            cudaEventDestroy(start);
            cudaEventDestroy(stop);
            return false;
        }
    }
    if (!cuda_ok(cudaStreamSynchronize(stream), "sparse apply warmup synchronize", error)) {
        cudaEventDestroy(start);
        cudaEventDestroy(stop);
        return false;
    }

    float total_ms = 0.0f;
    for (int i = 0; i < kBenchmarkRepetitions; ++i) {
        if (!cuda_ok(cudaEventRecord(start, stream), "cudaEventRecord(start)", error) ||
            !enqueue() ||
            !cuda_ok(cudaGetLastError(), "sparse apply benchmark enqueue", error) ||
            !cuda_ok(cudaEventRecord(stop, stream), "cudaEventRecord(stop)", error) ||
            !cuda_ok(cudaEventSynchronize(stop), "cudaEventSynchronize(stop)", error) ||
            !cuda_ok(cudaEventElapsedTime(&elapsed_ms, start, stop), "cudaEventElapsedTime", error)) {
            cudaEventDestroy(start);
            cudaEventDestroy(stop);
            return false;
        }
        total_ms += elapsed_ms;
    }
    elapsed_ms = total_ms / static_cast<float>(kBenchmarkRepetitions);
    cudaEventDestroy(start);
    cudaEventDestroy(stop);
    return true;
}

#endif

SparseApplyPlan::SparseApplyPlan() noexcept
    : impl_(new (std::nothrow) Impl())
{
}

SparseApplyPlan::SparseApplyPlan(SparseApplyPlan &&other) noexcept
    : impl_(other.impl_)
{
    other.impl_ = nullptr;
}

SparseApplyPlan &SparseApplyPlan::operator=(SparseApplyPlan &&other) noexcept
{
    if (this != &other) {
        reset();
        impl_ = other.impl_;
        other.impl_ = nullptr;
    }
    return *this;
}

SparseApplyPlan::~SparseApplyPlan()
{
    reset();
}

void SparseApplyPlan::reset() noexcept
{
    if (impl_ == nullptr) {
        return;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    impl_->release_cuda_state();
#endif
    delete impl_;
    impl_ = nullptr;
}

bool SparseApplyPlan::setup(
    const SparseApplyCsrDeviceView &csr,
    FullmagSparseApplyStream stream,
    std::string &error,
    bool allow_cusparse)
{
    if (impl_ == nullptr) {
        error = "sparse apply plan allocation failed";
        return false;
    }
    if (impl_->configured) {
        error = "sparse apply plan setup may only run once per plan";
        return false;
    }
    impl_->supported.fill(false);
    impl_->provenance.clear();
    impl_->apply_count = 0u;
    if (csr.row_offsets == nullptr || csr.col_indices == nullptr || csr.values == nullptr ||
        csr.rows == 0u || csr.cols == 0u || csr.rows > static_cast<std::uint32_t>(std::numeric_limits<int>::max()) ||
        csr.cols > static_cast<std::uint32_t>(std::numeric_limits<int>::max())) {
        error = "sparse apply CSR device view has invalid dimensions or pointers";
        return false;
    }

#if !FULLMAG_HAS_CUDA_RUNTIME
    (void)csr;
    (void)stream;
    error = "sparse apply plan requires CUDA runtime support";
    return false;
#else
    impl_->csr = csr;
    std::vector<std::uint32_t> host_row_offsets(static_cast<std::size_t>(csr.rows) + 1u);
    if (!cuda_ok(
            cudaMemcpy(
                host_row_offsets.data(),
                csr.row_offsets,
                host_row_offsets.size() * sizeof(std::uint32_t),
                cudaMemcpyDeviceToHost),
            "copy sparse CSR row offsets for setup",
            error)) {
        return false;
    }
    for (std::size_t row = 0; row < csr.rows; ++row) {
        if (host_row_offsets[row] > host_row_offsets[row + 1u]) {
            error = "sparse apply CSR row offsets are not monotonic";
            return false;
        }
    }
    if (host_row_offsets.front() != 0u) {
        error = "sparse apply CSR row offsets must start at zero";
        return false;
    }
    const std::uint32_t nnz = host_row_offsets.back();
    if (nnz == 0u) {
        error = "sparse apply CSR must contain at least one nonzero";
        return false;
    }
    std::vector<std::uint32_t> host_col_indices(static_cast<std::size_t>(nnz));
    if (!cuda_ok(
            cudaMemcpy(
                host_col_indices.data(),
                csr.col_indices,
                host_col_indices.size() * sizeof(std::uint32_t),
                cudaMemcpyDeviceToHost),
            "copy sparse CSR column indices for setup",
            error)) {
        return false;
    }
    for (const std::uint32_t column : host_col_indices) {
        if (column >= csr.cols) {
            error = "sparse apply CSR column index exceeds the operator dimensions";
            return false;
        }
    }

    if (csr.cols > std::numeric_limits<std::size_t>::max() / 3u ||
        csr.rows > std::numeric_limits<std::size_t>::max() / 3u) {
        error = "sparse apply scratch dimensions overflow";
        return false;
    }
    impl_->scratch_input_count = static_cast<std::size_t>(csr.cols) * 3u;
    impl_->scratch_output_count = static_cast<std::size_t>(csr.rows) * 3u;
    if (!cuda_ok(
            cudaMalloc(
                reinterpret_cast<void **>(&impl_->scratch_input),
                impl_->scratch_input_count * sizeof(double)),
            "cudaMalloc sparse apply input scratch",
            error) ||
        !cuda_ok(
            cudaMalloc(
                reinterpret_cast<void **>(&impl_->scratch_output),
                impl_->scratch_output_count * sizeof(double)),
            "cudaMalloc sparse apply output scratch",
            error) ||
        !cuda_ok(
            cudaMemsetAsync(
                impl_->scratch_input,
                0,
                impl_->scratch_input_count * sizeof(double),
                stream),
            "cudaMemsetAsync sparse apply input scratch",
            error) ||
        !cuda_ok(
            cudaMemsetAsync(
                impl_->scratch_output,
                0,
                impl_->scratch_output_count * sizeof(double),
                stream),
            "cudaMemsetAsync sparse apply output scratch",
            error) ||
        !cuda_ok(cudaStreamSynchronize(stream), "synchronize sparse apply setup scratch", error)) {
        impl_->release_cuda_state();
        return false;
    }

    impl_->supported[variant_index(SparseApplyVariant::ScalarRow)] = true;
    impl_->supported[variant_index(SparseApplyVariant::Subwarp)] = true;
    impl_->supported[variant_index(SparseApplyVariant::Warp)] = true;

#if FULLMAG_HAS_CUSPARSE
    if (allow_cusparse) {
    std::string cusparse_error;
    bool cusparse_ready =
        cusparse_ok(cusparseCreate(&impl_->handle), "cusparseCreate", cusparse_error) &&
        cusparse_ok(cusparseSetStream(impl_->handle, stream), "cusparseSetStream", cusparse_error) &&
        cusparse_ok(
            cusparseCreateCsr(
                &impl_->matrix,
                csr.rows,
                csr.cols,
                nnz,
                const_cast<std::uint32_t *>(csr.row_offsets),
                const_cast<std::uint32_t *>(csr.col_indices),
                const_cast<double *>(csr.values),
                CUSPARSE_INDEX_32I,
                CUSPARSE_INDEX_32I,
                CUSPARSE_INDEX_BASE_ZERO,
                CUDA_R_64F),
            "cusparseCreateCsr",
            cusparse_error);
    const std::array<double *, 3> input_scratch{
        impl_->scratch_input,
        impl_->scratch_input + csr.cols,
        impl_->scratch_input + 2u * csr.cols};
    const std::array<double *, 3> output_scratch{
        impl_->scratch_output,
        impl_->scratch_output + csr.rows,
        impl_->scratch_output + 2u * csr.rows};
    if (cusparse_ready) {
        for (std::size_t component = 0; component < 3u; ++component) {
            cusparse_ready =
                cusparse_ok(
                    cusparseCreateDnVec(
                        &impl_->spmv_input[component],
                        csr.cols,
                        input_scratch[component],
                        CUDA_R_64F),
                    "cusparseCreateDnVec(input)",
                    cusparse_error) &&
                cusparse_ok(
                    cusparseCreateDnVec(
                        &impl_->spmv_output[component],
                        csr.rows,
                        output_scratch[component],
                        CUDA_R_64F),
                    "cusparseCreateDnVec(output)",
                    cusparse_error);
        }
    }
    if (cusparse_ready) {
        cusparse_ready =
            cusparse_ok(
                cusparseCreateDnMat(
                    &impl_->spmm_input,
                    csr.cols,
                    3,
                    csr.cols,
                    impl_->scratch_input,
                    CUDA_R_64F,
                    CUSPARSE_ORDER_COL),
                "cusparseCreateDnMat(input)",
                cusparse_error) &&
            cusparse_ok(
                cusparseCreateDnMat(
                    &impl_->spmm_output,
                    csr.rows,
                    3,
                    csr.rows,
                    impl_->scratch_output,
                    CUDA_R_64F,
                    CUSPARSE_ORDER_COL),
                "cusparseCreateDnMat(output)",
                cusparse_error);
    }
    const double alpha = 1.0;
    const double beta = 0.0;
    if (cusparse_ready) {
        cusparse_ready = cusparse_ok(
            cusparseSpMV_bufferSize(
                impl_->handle,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                &alpha,
                impl_->matrix,
                impl_->spmv_input[0],
                &beta,
                impl_->spmv_output[0],
                CUDA_R_64F,
                CUSPARSE_SPMV_ALG_DEFAULT,
                &impl_->spmv_buffer_bytes),
            "cusparseSpMV_bufferSize",
            cusparse_error);
    }
    if (cusparse_ready) {
        cusparse_ready = cusparse_ok(
            cusparseSpMM_bufferSize(
                impl_->handle,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                &alpha,
                impl_->matrix,
                impl_->spmm_input,
                &beta,
                impl_->spmm_output,
                CUDA_R_64F,
                CUSPARSE_SPMM_ALG_DEFAULT,
                &impl_->spmm_buffer_bytes),
            "cusparseSpMM_bufferSize",
            cusparse_error);
    }
    if (cusparse_ready && impl_->spmv_buffer_bytes > 0u) {
        cusparse_ready = cuda_ok(
            cudaMalloc(&impl_->spmv_buffer, impl_->spmv_buffer_bytes),
            "cudaMalloc cuSPARSE SpMV buffer",
            cusparse_error);
    }
    if (cusparse_ready && impl_->spmm_buffer_bytes > 0u) {
        cusparse_ready = cuda_ok(
            cudaMalloc(&impl_->spmm_buffer, impl_->spmm_buffer_bytes),
            "cudaMalloc cuSPARSE SpMM buffer",
            cusparse_error);
    }
    if (cusparse_ready) {
        cusparse_ready = cusparse_ok(
            cusparseSpMV_preprocess(
                impl_->handle,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                &alpha,
                impl_->matrix,
                impl_->spmv_input[0],
                &beta,
                impl_->spmv_output[0],
                CUDA_R_64F,
                CUSPARSE_SPMV_ALG_DEFAULT,
                impl_->spmv_buffer),
            "cusparseSpMV_preprocess",
            cusparse_error);
    }
    if (cusparse_ready) {
        cusparse_ready = cusparse_ok(
            cusparseSpMM_preprocess(
                impl_->handle,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                CUSPARSE_OPERATION_NON_TRANSPOSE,
                &alpha,
                impl_->matrix,
                impl_->spmm_input,
                &beta,
                impl_->spmm_output,
                CUDA_R_64F,
                CUSPARSE_SPMM_ALG_DEFAULT,
                impl_->spmm_buffer),
            "cusparseSpMM_preprocess",
            cusparse_error);
    }
    if (cusparse_ready) {
        impl_->supported[variant_index(SparseApplyVariant::CusparseSpmv)] = true;
        impl_->supported[variant_index(SparseApplyVariant::CusparseSpmm3)] = true;
    } else {
        // The custom CUDA variants remain valid.  The unavailable library
        // variants are kept explicitly unsupported and fail closed when
        // selected by a caller.
        impl_->release_cuda_state();
        impl_->csr = csr;
        impl_->scratch_input_count = static_cast<std::size_t>(csr.cols) * 3u;
        impl_->scratch_output_count = static_cast<std::size_t>(csr.rows) * 3u;
        if (!cuda_ok(
                cudaMalloc(
                    reinterpret_cast<void **>(&impl_->scratch_input),
                    impl_->scratch_input_count * sizeof(double)),
                "cudaMalloc sparse apply input scratch after cuSPARSE failure",
                error) ||
            !cuda_ok(
                cudaMalloc(
                    reinterpret_cast<void **>(&impl_->scratch_output),
                    impl_->scratch_output_count * sizeof(double)),
                "cudaMalloc sparse apply output scratch after cuSPARSE failure",
                error)) {
            impl_->release_cuda_state();
            return false;
        }
        if (!cuda_ok(
                cudaMemset(impl_->scratch_input, 0, impl_->scratch_input_count * sizeof(double)),
                "cudaMemset sparse apply input scratch after cuSPARSE failure",
                error) ||
            !cuda_ok(
                cudaMemset(impl_->scratch_output, 0, impl_->scratch_output_count * sizeof(double)),
                "cudaMemset sparse apply output scratch after cuSPARSE failure",
                error)) {
            impl_->release_cuda_state();
            return false;
        }
        impl_->supported[variant_index(SparseApplyVariant::ScalarRow)] = true;
        impl_->supported[variant_index(SparseApplyVariant::Subwarp)] = true;
        impl_->supported[variant_index(SparseApplyVariant::Warp)] = true;
    }
    }
#else
    (void)allow_cusparse;
#endif

    SparseApplyVariant best_variant = SparseApplyVariant::ScalarRow;
    float best_ms = std::numeric_limits<float>::infinity();
    std::ostringstream benchmark_provenance;
    benchmark_provenance << "fullmag.fem.sparse_apply.v1;setup_benchmark_repetitions="
                         << kBenchmarkRepetitions << ";candidates=";
    bool have_benchmark = false;
    for (std::size_t index = 0; index < kVariantCount; ++index) {
        if (!impl_->supported[index]) {
            continue;
        }
        const auto variant = static_cast<SparseApplyVariant>(index);
        float elapsed_ms = 0.0f;
        std::string candidate_error;
        if (!impl_->benchmark_variant(variant, stream, elapsed_ms, candidate_error)) {
#if FULLMAG_HAS_CUSPARSE
            if (variant == SparseApplyVariant::CusparseSpmv ||
                variant == SparseApplyVariant::CusparseSpmm3) {
                impl_->supported[index] = false;
                continue;
            }
#endif
            impl_->release_cuda_state();
            error = "sparse apply setup benchmark failed for " +
                std::string(sparse_apply_variant_name(variant)) + ": " + candidate_error;
            return false;
        }
        if (have_benchmark) {
            benchmark_provenance << ',';
        }
        benchmark_provenance << sparse_apply_variant_name(variant) << '=' << elapsed_ms << "ms";
        if (!have_benchmark || elapsed_ms < best_ms) {
            have_benchmark = true;
            best_ms = elapsed_ms;
            best_variant = variant;
        }
    }
    if (!have_benchmark) {
        impl_->release_cuda_state();
        error = "sparse apply setup found no supported CUDA variant";
        return false;
    }
    impl_->selected = best_variant;
    impl_->configured = true;
    impl_->setup_count = 1u;
    benchmark_provenance << ";selected_id=" << sparse_apply_variant_id(best_variant)
                         << ";selected=" << sparse_apply_variant_name(best_variant);
    impl_->provenance = benchmark_provenance.str();
    error.clear();
    return true;
#endif
}

bool SparseApplyPlan::apply_xyz(
    const SparseApplyXyzDeviceView &vectors,
    FullmagSparseApplyStream stream,
    std::string &error)
{
    if (impl_ == nullptr || !impl_->configured) {
        error = "sparse apply plan must be configured before apply";
        return false;
    }
    if (vectors.x == nullptr || vectors.y == nullptr || vectors.z == nullptr ||
        vectors.out_x == nullptr || vectors.out_y == nullptr || vectors.out_z == nullptr) {
        error = "sparse apply XYZ device view has null vectors";
        return false;
    }
#if !FULLMAG_HAS_CUDA_RUNTIME
    (void)stream;
    error = "sparse apply plan requires CUDA runtime support";
    return false;
#else
    const SparseApplyVariant variant = impl_->selected;
    switch (variant) {
    case SparseApplyVariant::ScalarRow:
    case SparseApplyVariant::Subwarp:
    case SparseApplyVariant::Warp:
        if (!sparse_apply_detail::launch_xyz_csr(
                impl_->csr.row_offsets,
                impl_->csr.col_indices,
                impl_->csr.values,
                vectors.x,
                vectors.y,
                vectors.z,
                vectors.out_x,
                vectors.out_y,
                vectors.out_z,
                static_cast<int>(impl_->csr.rows),
                variant,
                stream,
                vectors.active_mask) ||
            !cuda_ok(cudaGetLastError(), "sparse apply custom kernel enqueue", error)) {
            if (error.empty()) {
                error = "selected sparse custom variant rejected the device view";
            }
            return false;
        }
        break;
    case SparseApplyVariant::CusparseSpmv:
#if FULLMAG_HAS_CUSPARSE
        if (!impl_->apply_spmv(vectors, stream, error)) {
            return false;
        }
#else
        error = "selected cuSPARSE SpMV variant is unavailable in this build";
        return false;
#endif
        break;
    case SparseApplyVariant::CusparseSpmm3:
#if FULLMAG_HAS_CUSPARSE
        if (!impl_->apply_spmm3(vectors, stream, error)) {
            return false;
        }
#else
        error = "selected cuSPARSE SpMM3 variant is unavailable in this build";
        return false;
#endif
        break;
    }
    impl_->apply_count += 1u;
    error.clear();
    return true;
#endif
}

bool SparseApplyPlan::force_variant_for_test(SparseApplyVariant variant, std::string &error)
{
    if (impl_ == nullptr || !impl_->configured) {
        error = "sparse apply plan must be configured before forcing a variant";
        return false;
    }
    if (!is_known_variant(variant)) {
        error = "unknown sparse apply variant";
        return false;
    }
    if (!impl_->supported[variant_index(variant)]) {
        error = "requested sparse apply variant is unavailable in this runtime: " +
            std::string(sparse_apply_variant_name(variant));
        return false;
    }
    impl_->selected = variant;
    impl_->provenance += ";forced_for_test=";
    impl_->provenance += sparse_apply_variant_name(variant);
    error.clear();
    return true;
}

SparseApplyVariant SparseApplyPlan::selected_variant() const noexcept
{
    return impl_ == nullptr ? SparseApplyVariant::ScalarRow : impl_->selected;
}

const char *SparseApplyPlan::selected_variant_name() const noexcept
{
    return sparse_apply_variant_name(selected_variant());
}

std::uint32_t SparseApplyPlan::selected_variant_id() const noexcept
{
    return sparse_apply_variant_id(selected_variant());
}

const char *SparseApplyPlan::selection_provenance() const noexcept
{
    return impl_ == nullptr ? "" : impl_->provenance.c_str();
}

std::uint64_t SparseApplyPlan::setup_count() const noexcept
{
    return impl_ == nullptr ? 0u : impl_->setup_count;
}

std::uint64_t SparseApplyPlan::apply_count() const noexcept
{
    return impl_ == nullptr ? 0u : impl_->apply_count;
}

} // namespace fullmag::fem
