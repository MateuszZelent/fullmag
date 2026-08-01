/*
 * Version-pinned CUDA stream interop for strict FEM GPU Hypre demag.
 *
 * This owner borrows the exact HYPRE compute stream and owns only the CUDA
 * events used to order Fullmag producers and consumers around Hypre Mult.
 */
#pragma once

#include <cstdint>
#include <string>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME
struct HypreStreamInterop {
    cudaStream_t hypre_stream = nullptr;
    cudaEvent_t fullmag_ready = nullptr;
    cudaEvent_t hypre_done = nullptr;
    cudaEvent_t hypre_validation_done = nullptr;
    uint64_t event_wait_count = 0;
    uint64_t global_sync_count = 0;
    bool ready = false;
};

bool initialize_hypre_stream_interop(
    HypreStreamInterop &interop,
    std::string &error);

bool hypre_wait_for_fullmag(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error);

bool fullmag_wait_for_hypre(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error);

bool mfem_default_stream_wait_for_hypre_validation(
    HypreStreamInterop &interop,
    std::string &error);

void destroy_hypre_stream_interop(HypreStreamInterop &interop) noexcept;
#endif

} // namespace fullmag::fem
