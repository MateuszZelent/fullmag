#ifndef FULLMAG_HYPRE_RESIDUAL_STREAM_COPY_HPP
#define FULLMAG_HYPRE_RESIDUAL_STREAM_COPY_HPP

#include "_hypre_utilities.hpp"

#if defined(HYPRE_USING_CUDA) && !defined(HYPRE_MIXED_PRECISION)
#include <atomic>
#include <cstddef>
#include <cuda_runtime.h>
#include <limits>

namespace
{
std::atomic<unsigned long long> hypre_fullmag_residual_async_copy_count{0};
std::atomic<unsigned long long> hypre_fullmag_residual_async_copy_bytes{0};
}

extern "C"
__attribute__((visibility("default")))
HYPRE_Int hypre_FullmagResidualCopyAsyncDevice(HYPRE_Int count,
                                               HYPRE_Complex *src,
                                               HYPRE_Complex *dst)
{
   if (count <= 0 ||
       static_cast<unsigned long long>(count) >
       std::numeric_limits<std::size_t>::max() / sizeof(HYPRE_Complex))
   {
      hypre_error_w_msg(HYPRE_ERROR_GENERIC, "invalid HYPRE residual-copy size");
      return 1;
   }

   const std::size_t bytes = static_cast<std::size_t>(count) * sizeof(HYPRE_Complex);
   const cudaError_t status = cudaMemcpyAsync(dst, src, bytes,
                                             cudaMemcpyDeviceToDevice,
                                             hypre_HandleComputeStream(hypre_handle()));
   if (status != cudaSuccess)
   {
      hypre_error_w_msg(HYPRE_ERROR_GENERIC, cudaGetErrorString(status));
      return 1;
   }

   hypre_fullmag_residual_async_copy_count.fetch_add(1, std::memory_order_relaxed);
   hypre_fullmag_residual_async_copy_bytes.fetch_add(
      static_cast<unsigned long long>(bytes), std::memory_order_relaxed);
   return 0;
}

extern "C"
__attribute__((visibility("default")))
unsigned long long hypre_FullmagResidualAsyncCopyCount(void)
{
   return hypre_fullmag_residual_async_copy_count.load(std::memory_order_relaxed);
}

extern "C"
__attribute__((visibility("default")))
unsigned long long hypre_FullmagResidualAsyncCopyBytes(void)
{
   return hypre_fullmag_residual_async_copy_bytes.load(std::memory_order_relaxed);
}
#endif

#endif
