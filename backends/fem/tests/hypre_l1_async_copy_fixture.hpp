#pragma once

// This optional private HYPRE diagnostic is absent from older dependency
// images. It never changes the Fullmag C ABI or selects a solver realization.
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME && defined(MFEM_USE_MPI) && !defined(_WIN32)
extern "C" unsigned long long hypre_FullmagRelax7AsyncCopyCount() __attribute__((weak));
extern "C" unsigned long long hypre_FullmagRelax7AsyncCopyBytes() __attribute__((weak));
extern "C" HYPRE_Int hypre_BoomerAMGRelax7CopyAsyncDevice(
    HYPRE_Int count, HYPRE_Complex *src, HYPRE_Complex *dst) __attribute__((weak));

namespace fullmag::fem::test {

struct HypreL1AsyncCopySnapshot {
    bool available = false;
    unsigned long long count = 0;
    unsigned long long bytes = 0;
};

inline HypreL1AsyncCopySnapshot capture_hypre_l1_async_copies(
    void (*check)(bool, const char *)) {
    const bool has_count = hypre_FullmagRelax7AsyncCopyCount != nullptr;
    const bool has_bytes = hypre_FullmagRelax7AsyncCopyBytes != nullptr;
    check(has_count == has_bytes,
          "HYPRE L1 copy patch exposes both process counters or neither");
    if (!has_count) return {};
    check(hypre_BoomerAMGRelax7CopyAsyncDevice != nullptr,
          "HYPRE L1 copy counters require the actual C-to-CUDA bridge");
    return {true, hypre_FullmagRelax7AsyncCopyCount(), hypre_FullmagRelax7AsyncCopyBytes()};
}

// Bracket the real production CG/AMG field computation, not a direct call to
// the bridge. This proves that its narrow vector-layout predicate was used.
inline void require_hypre_l1_async_copy_production_hit(
    const HypreL1AsyncCopySnapshot &before,
    void (*check)(bool, const char *)) {
    const auto after = capture_hypre_l1_async_copies(check);
    check(before.available == after.available,
          "HYPRE L1 copy diagnostic availability is stable across a solve");
    if (!before.available) {
        std::fprintf(stderr,
            "hypre_l1_async_copy_not_verified: older unpatched HYPRE dependency\n");
        return;
    }
    check(after.count > before.count && after.bytes > before.bytes,
          "real production CG/AMG must use the patched stream-ordered L1 copy");
    const auto count = after.count - before.count;
    const auto bytes = after.bytes - before.bytes;
    check(count <= bytes / sizeof(HYPRE_Complex) && bytes % sizeof(HYPRE_Complex) == 0,
          "HYPRE L1 successful-copy byte accounting matches typed nonempty vectors");
    std::fprintf(stderr, "hypre_l1_async_copy_production_hit count=%llu bytes=%llu\n",
                 count, bytes);
}

inline void hypre_l1_async_copy_submission_error_contract(
    HYPRE_Complex *valid_device_source,
    void (*check)(bool, const char *)) {
    const auto before = capture_hypre_l1_async_copies(check);
    if (!before.available) return;
    check(valid_device_source != nullptr && HYPRE_GetError() == 0,
          "HYPRE L1 error regression starts with valid source and clean library status");
    check(cudaGetLastError() == cudaSuccess,
          "HYPRE L1 error regression starts with clean CUDA status");
    // A null destination for a nonzero, valid device source fails submission;
    // no invalid-address device kernel is launched by this test.
    check(hypre_BoomerAMGRelax7CopyAsyncDevice(1, valid_device_source, nullptr) != 0,
          "HYPRE L1 bridge reports a rejected CUDA copy submission");
    check(HYPRE_GetError() == HYPRE_ERROR_GENERIC,
          "HYPRE L1 bridge preserves the exact expected sticky generic error");
    const auto after = capture_hypre_l1_async_copies(check);
    check(after.count == before.count && after.bytes == before.bytes,
          "rejected HYPRE L1 submission is never counted as a successful copy");
    const auto cuda_status = cudaGetLastError();
    check(cuda_status == cudaSuccess || cuda_status == cudaErrorInvalidValue,
          "HYPRE L1 argument rejection does not leave a device execution fault");
    check(HYPRE_ClearError(HYPRE_ERROR_GENERIC) == 0 && HYPRE_GetError() == 0,
          "HYPRE L1 regression consumes only its proven expected error");
    std::fprintf(stderr, "hypre_l1_async_copy_submission_error_rejected\n");
}

} // namespace fullmag::fem::test
#endif
