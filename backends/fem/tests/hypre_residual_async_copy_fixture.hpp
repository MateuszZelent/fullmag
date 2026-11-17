#pragma once

#include <cstdio>

namespace fullmag::fem::test {

struct HypreResidualAsyncCopySnapshot {
    bool available = false;
    unsigned long long count = 0;
    unsigned long long bytes = 0;
};

} // namespace fullmag::fem::test

#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME && defined(MFEM_USE_MPI) && !defined(_WIN32)

#include <HYPRE_utilities.h>
#include <_hypre_seq_mv.h>
#include <_hypre_utilities.h>
#include <cuda_runtime.h>

#include <array>
#include <cstddef>
#include <cstring>

extern "C" unsigned long long hypre_FullmagResidualAsyncCopyCount() __attribute__((weak));
extern "C" unsigned long long hypre_FullmagResidualAsyncCopyBytes() __attribute__((weak));
extern "C" HYPRE_Int hypre_FullmagResidualCopyAsyncDevice(
    HYPRE_Int count, HYPRE_Complex *src, HYPRE_Complex *dst) __attribute__((weak));

namespace fullmag::fem::test {

inline HypreResidualAsyncCopySnapshot capture_hypre_residual_async_copies(
    void (*check)(bool, const char *))
{
    const bool has_count = hypre_FullmagResidualAsyncCopyCount != nullptr;
    const bool has_bytes = hypre_FullmagResidualAsyncCopyBytes != nullptr;
    const bool has_bridge = hypre_FullmagResidualCopyAsyncDevice != nullptr;
    check(has_count == has_bytes,
          "HYPRE residual copy patch exposes both process counters or neither");
    check(has_count == has_bridge,
          "HYPRE residual copy counters and C-to-CUDA bridge are present together");
    if (!has_count) {
        return {};
    }
    return {true, hypre_FullmagResidualAsyncCopyCount(),
            hypre_FullmagResidualAsyncCopyBytes()};
}

inline hypre_CSRMatrix *make_residual_copy_matrix(
    HYPRE_MemoryLocation memory_location,
    void (*check)(bool, const char *))
{
    auto *matrix = hypre_CSRMatrixCreate(2, 2, 4);
    check(matrix != nullptr, "HYPRE residual-copy CSR matrix is allocated");
    check(hypre_CSRMatrixInitialize_v2(matrix, 0, memory_location) == 0,
          "HYPRE residual-copy CSR arrays are initialized at the requested location");

    const std::array<HYPRE_Int, 3> row_offsets{0, 2, 4};
    const std::array<HYPRE_Int, 4> columns{0, 1, 0, 1};
    const std::array<HYPRE_Complex, 4> values{2.0, -1.0, 3.0, 4.0};
    if (memory_location == HYPRE_MEMORY_DEVICE) {
        check(cudaMemcpy(hypre_CSRMatrixI(matrix), row_offsets.data(), sizeof(row_offsets),
                         cudaMemcpyHostToDevice) == cudaSuccess,
              "HYPRE residual-copy device CSR row offsets are initialized");
        check(cudaMemcpy(hypre_CSRMatrixJ(matrix), columns.data(), sizeof(columns),
                         cudaMemcpyHostToDevice) == cudaSuccess,
              "HYPRE residual-copy device CSR columns are initialized");
        check(cudaMemcpy(hypre_CSRMatrixData(matrix), values.data(), sizeof(values),
                         cudaMemcpyHostToDevice) == cudaSuccess,
              "HYPRE residual-copy device CSR values are initialized");
    } else {
        std::memcpy(hypre_CSRMatrixI(matrix), row_offsets.data(), sizeof(row_offsets));
        std::memcpy(hypre_CSRMatrixJ(matrix), columns.data(), sizeof(columns));
        std::memcpy(hypre_CSRMatrixData(matrix), values.data(), sizeof(values));
    }
    return matrix;
}

inline hypre_Vector *make_residual_copy_vector(
    HYPRE_Int size,
    HYPRE_Int num_vectors,
    HYPRE_Int storage_method,
    HYPRE_MemoryLocation memory_location,
    void (*check)(bool, const char *))
{
    auto *vector = num_vectors == 1
        ? hypre_SeqVectorCreate(size)
        : hypre_SeqMultiVectorCreate(size, num_vectors);
    check(vector != nullptr, "HYPRE residual-copy vector is allocated");
    hypre_VectorMultiVecStorageMethod(vector) = storage_method;
    check(hypre_SeqVectorInitialize_v2(vector, memory_location) == 0,
          "HYPRE residual-copy vector is initialized at the requested location");
    return vector;
}

inline void write_residual_copy_vector(
    hypre_Vector *vector,
    const HYPRE_Complex *values,
    std::size_t count,
    void (*check)(bool, const char *))
{
    if (hypre_VectorMemoryLocation(vector) == HYPRE_MEMORY_DEVICE) {
        check(cudaMemcpy(hypre_VectorData(vector), values, count * sizeof(HYPRE_Complex),
                         cudaMemcpyHostToDevice) == cudaSuccess,
              "HYPRE residual-copy device vector input is initialized");
    } else {
        std::memcpy(hypre_VectorData(vector), values, count * sizeof(HYPRE_Complex));
    }
}

inline void read_residual_copy_vector(
    hypre_Vector *vector,
    HYPRE_Complex *values,
    std::size_t count,
    void (*check)(bool, const char *))
{
    if (hypre_VectorMemoryLocation(vector) == HYPRE_MEMORY_DEVICE) {
        check(cudaDeviceSynchronize() == cudaSuccess,
              "HYPRE residual-copy device computation completes before result inspection");
        check(cudaMemcpy(values, hypre_VectorData(vector), count * sizeof(HYPRE_Complex),
                         cudaMemcpyDeviceToHost) == cudaSuccess,
              "HYPRE residual-copy device vector result is readable");
    } else {
        std::memcpy(values, hypre_VectorData(vector), count * sizeof(HYPRE_Complex));
    }
}

inline void run_hypre_residual_async_copy_host_fallback_fixture(
    void (*check)(bool, const char *))
{
    const auto before = capture_hypre_residual_async_copies(check);
    if (!before.available) {
        std::fprintf(stderr,
                     "hypre_residual_async_copy_host_fallback_not_verified: patch symbols absent\n");
        return;
    }

    auto *matrix = make_residual_copy_matrix(HYPRE_MEMORY_HOST, check);
    auto *x = make_residual_copy_vector(2, 1, 0, HYPRE_MEMORY_HOST, check);
    auto *b = make_residual_copy_vector(2, 1, 0, HYPRE_MEMORY_HOST, check);
    auto *y = make_residual_copy_vector(2, 1, 0, HYPRE_MEMORY_HOST, check);
    const std::array<HYPRE_Complex, 2> x_values{5.0, 7.0};
    const std::array<HYPRE_Complex, 2> b_values{11.0, 13.0};
    const std::array<HYPRE_Complex, 2> y_values{0.0, 0.0};
    const std::array<HYPRE_Complex, 2> expected{14.0, 56.0};
    std::array<HYPRE_Complex, 2> actual{};
    write_residual_copy_vector(x, x_values.data(), x_values.size(), check);
    write_residual_copy_vector(b, b_values.data(), b_values.size(), check);
    write_residual_copy_vector(y, y_values.data(), y_values.size(), check);

    check(hypre_CSRMatrixMatvecOutOfPlace(1.0, matrix, x, 1.0, b, y, 0) == 0,
          "HYPRE host out-of-place CSR matvec succeeds");
    read_residual_copy_vector(y, actual.data(), actual.size(), check);
    check(std::memcmp(actual.data(), expected.data(), sizeof(expected)) == 0,
          "HYPRE host out-of-place CSR matvec preserves exact result");
    const auto after = capture_hypre_residual_async_copies(check);
    check(after.count == before.count && after.bytes == before.bytes,
          "HYPRE host execution remains outside the residual device-copy fastpath");

    hypre_SeqVectorDestroy(y);
    hypre_SeqVectorDestroy(b);
    hypre_SeqVectorDestroy(x);
    hypre_CSRMatrixDestroy(matrix);
}

// DOC-ANCHOR: hypre-residual-copy-native-device-fixture
inline void run_hypre_residual_async_copy_device_fixture(
    void (*check)(bool, const char *))
{
#if defined(HYPRE_USING_CUDA) && !defined(HYPRE_MIXED_PRECISION)
    int device_count = 0;
    const cudaError_t device_status = cudaGetDeviceCount(&device_count);
    if (device_status != cudaSuccess || device_count <= 0) {
        std::fprintf(stderr,
                     "hypre_residual_async_copy_device_not_verified: CUDA device unavailable (%s)\n",
                     cudaGetErrorString(device_status));
        return;
    }
    if (hypre_GetActualMemLocation(HYPRE_MEMORY_DEVICE) != hypre_MEMORY_DEVICE) {
        std::fprintf(stderr,
                     "hypre_residual_async_copy_device_not_verified: HYPRE memory model is not device-only\n");
        return;
    }

    const auto before = capture_hypre_residual_async_copies(check);
    if (!before.available) {
        std::fprintf(stderr,
                     "hypre_residual_async_copy_device_not_verified: patch symbols absent\n");
        return;
    }
    check(HYPRE_GetError() == 0,
          "HYPRE residual-copy device fixture starts with a clean library error stack");

    auto *matrix = make_residual_copy_matrix(HYPRE_MEMORY_DEVICE, check);
    auto *x = make_residual_copy_vector(2, 1, 0, HYPRE_MEMORY_DEVICE, check);
    auto *b = make_residual_copy_vector(2, 1, 0, HYPRE_MEMORY_DEVICE, check);
    auto *y = make_residual_copy_vector(2, 1, 0, HYPRE_MEMORY_DEVICE, check);
    const std::array<HYPRE_Complex, 2> x_values{5.0, 7.0};
    const std::array<HYPRE_Complex, 2> b_values{11.0, 13.0};
    const std::array<HYPRE_Complex, 2> y_values{0.0, 0.0};
    const std::array<HYPRE_Complex, 2> expected{14.0, 56.0};
    std::array<HYPRE_Complex, 2> actual{};
    write_residual_copy_vector(x, x_values.data(), x_values.size(), check);
    write_residual_copy_vector(b, b_values.data(), b_values.size(), check);
    write_residual_copy_vector(y, y_values.data(), y_values.size(), check);

    check(hypre_CSRMatrixMatvecDevice(0, 1.0, matrix, x, 1.0, b, y, 0) == 0,
          "HYPRE device out-of-place CSR matvec succeeds");
    read_residual_copy_vector(y, actual.data(), actual.size(), check);
    check(std::memcmp(actual.data(), expected.data(), sizeof(expected)) == 0,
          "HYPRE device out-of-place CSR matvec is byte-exact");
    const auto after_device = capture_hypre_residual_async_copies(check);
    check(after_device.count == before.count + 1 &&
              after_device.bytes == before.bytes + sizeof(HYPRE_Complex) * expected.size(),
          "real HYPRE device out-of-place matvec hits the residual stream-copy patch once");

    write_residual_copy_vector(b, b_values.data(), b_values.size(), check);
    const auto before_alias = capture_hypre_residual_async_copies(check);
    check(hypre_CSRMatrixMatvecDevice(0, 1.0, matrix, x, 1.0, b, b, 0) == 0,
          "HYPRE device in-place matvec alias succeeds");
    read_residual_copy_vector(b, actual.data(), actual.size(), check);
    check(std::memcmp(actual.data(), expected.data(), sizeof(expected)) == 0,
          "HYPRE device in-place matvec alias preserves exact result");
    const auto after_alias = capture_hypre_residual_async_copies(check);
    check(after_alias.count == before_alias.count && after_alias.bytes == before_alias.bytes,
          "HYPRE device self-alias remains a no-copy path");

    auto *x_multi = make_residual_copy_vector(2, 2, 1, HYPRE_MEMORY_DEVICE, check);
    auto *b_multi = make_residual_copy_vector(2, 2, 1, HYPRE_MEMORY_DEVICE, check);
    auto *y_multi = make_residual_copy_vector(2, 2, 1, HYPRE_MEMORY_DEVICE, check);
    check(hypre_VectorMultiVecStorageMethod(b_multi) == 1 &&
              hypre_VectorIndexStride(b_multi) == 2 &&
              hypre_VectorVectorStride(b_multi) == 1 &&
              hypre_VectorMultiVecStorageMethod(y_multi) == 1 &&
              hypre_VectorIndexStride(y_multi) == 2 &&
              hypre_VectorVectorStride(y_multi) == 1,
          "HYPRE noncanonical fixture uses a valid interleaved multivector layout");
    const std::array<HYPRE_Complex, 4> x_multi_values{1.0, 3.0, 2.0, 4.0};
    const std::array<HYPRE_Complex, 4> b_multi_values{10.0, 30.0, 20.0, 40.0};
    const std::array<HYPRE_Complex, 4> y_multi_values{0.0, 0.0, 0.0, 0.0};
    const std::array<HYPRE_Complex, 4> expected_multi{10.0, 32.0, 31.0, 65.0};
    std::array<HYPRE_Complex, 4> actual_multi{};
    write_residual_copy_vector(x_multi, x_multi_values.data(), x_multi_values.size(), check);
    write_residual_copy_vector(b_multi, b_multi_values.data(), b_multi_values.size(), check);
    write_residual_copy_vector(y_multi, y_multi_values.data(), y_multi_values.size(), check);
    const auto before_multi = capture_hypre_residual_async_copies(check);
    check(hypre_CSRMatrixMatvecDevice(0, 1.0, matrix, x_multi, 1.0,
                                      b_multi, y_multi, 0) == 0,
          "HYPRE valid interleaved multivector device matvec succeeds");
    read_residual_copy_vector(y_multi, actual_multi.data(), actual_multi.size(), check);
    check(std::memcmp(actual_multi.data(), expected_multi.data(), sizeof(expected_multi)) == 0,
          "HYPRE valid interleaved multivector preserves exact result");
    const auto after_multi = capture_hypre_residual_async_copies(check);
    check(after_multi.count == before_multi.count && after_multi.bytes == before_multi.bytes,
          "HYPRE noncanonical multivector layout remains on the original copy path");

    const auto before_rejected = capture_hypre_residual_async_copies(check);
    check(HYPRE_GetError() == 0 && cudaGetLastError() == cudaSuccess,
          "HYPRE residual-copy rejection case starts with clean error state");
    check(hypre_FullmagResidualCopyAsyncDevice(1, hypre_VectorData(x), nullptr) != 0,
          "HYPRE residual-copy bridge rejects a null destination at submission");
    check(HYPRE_GetError() == HYPRE_ERROR_GENERIC,
          "rejected HYPRE residual-copy submission preserves sticky generic error");
    const auto after_rejected = capture_hypre_residual_async_copies(check);
    check(after_rejected.count == before_rejected.count &&
              after_rejected.bytes == before_rejected.bytes,
          "rejected HYPRE residual-copy submission is not counted as successful");
    const cudaError_t rejected_cuda_status = cudaGetLastError();
    check(rejected_cuda_status == cudaSuccess || rejected_cuda_status == cudaErrorInvalidValue,
          "null-destination submission rejection does not leave a device execution fault");
    check(HYPRE_ClearError(HYPRE_ERROR_GENERIC) == 0 && HYPRE_GetError() == 0,
          "HYPRE residual-copy fixture clears only its expected generic error");

    hypre_SeqVectorDestroy(y_multi);
    hypre_SeqVectorDestroy(b_multi);
    hypre_SeqVectorDestroy(x_multi);
    hypre_SeqVectorDestroy(y);
    hypre_SeqVectorDestroy(b);
    hypre_SeqVectorDestroy(x);
    hypre_CSRMatrixDestroy(matrix);
#else
    (void) check;
    std::fprintf(stderr,
                 "hypre_residual_async_copy_device_not_verified: HYPRE CUDA double build unavailable\n");
#endif
}

} // namespace fullmag::fem::test

#else

namespace fullmag::fem::test {

inline HypreResidualAsyncCopySnapshot capture_hypre_residual_async_copies(
    void (*)(bool, const char *))
{
    return {};
}

inline void run_hypre_residual_async_copy_host_fallback_fixture(
    void (*)(bool, const char *))
{
    std::fprintf(stderr,
                 "hypre_residual_async_copy_host_fallback_not_verified: native HYPRE stack unavailable\n");
}

inline void run_hypre_residual_async_copy_device_fixture(
    void (*)(bool, const char *))
{
    std::fprintf(stderr,
                 "hypre_residual_async_copy_device_not_verified: native CUDA HYPRE stack unavailable\n");
}

} // namespace fullmag::fem::test

#endif

namespace fullmag::fem::test {

inline void run_hypre_residual_async_copy_contract(
    void (*check)(bool, const char *))
{
    run_hypre_residual_async_copy_host_fallback_fixture(check);
    run_hypre_residual_async_copy_device_fixture(check);
}

} // namespace fullmag::fem::test
