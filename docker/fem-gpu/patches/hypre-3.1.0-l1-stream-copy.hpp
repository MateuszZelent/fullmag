#ifndef FULLMAG_HYPRE_L1_STREAM_COPY_HPP
#define FULLMAG_HYPRE_L1_STREAM_COPY_HPP

#include "_hypre_parcsr_ls.h"
#include "_hypre_utilities.hpp"

#if defined(HYPRE_USING_CUDA) && !defined(HYPRE_MIXED_PRECISION)
#include <atomic>
#include <cuda_runtime.h>

namespace
{
std::atomic<unsigned long long> hypre_fullmag_relax7_async_copy_count{0};
std::atomic<unsigned long long> hypre_fullmag_relax7_async_copy_bytes{0};
}

extern "C"
HYPRE_Int hypre_BoomerAMGRelax7CopyAsyncDevice(HYPRE_Int count,
                                               HYPRE_Complex *src,
                                               HYPRE_Complex *dst)
{
   const cudaError_t status = cudaMemcpyAsync(dst, src,
                                             static_cast<unsigned long long>(count) *
                                             static_cast<unsigned long long>(sizeof(HYPRE_Complex)),
                                             cudaMemcpyDeviceToDevice,
                                             hypre_HandleComputeStream(hypre_handle()));
   if (status != cudaSuccess)
   {
      hypre_error_w_msg(HYPRE_ERROR_GENERIC, cudaGetErrorString(status));
      return 1;
   }
   hypre_fullmag_relax7_async_copy_count.fetch_add(1, std::memory_order_relaxed);
   hypre_fullmag_relax7_async_copy_bytes.fetch_add(
      static_cast<unsigned long long>(count) *
      static_cast<unsigned long long>(sizeof(HYPRE_Complex)), std::memory_order_relaxed);
   return 0;
}

extern "C"
__attribute__((visibility("default")))
unsigned long long hypre_FullmagRelax7AsyncCopyCount(void)
{
   return hypre_fullmag_relax7_async_copy_count.load(std::memory_order_relaxed);
}

extern "C"
__attribute__((visibility("default")))
unsigned long long hypre_FullmagRelax7AsyncCopyBytes(void)
{
   return hypre_fullmag_relax7_async_copy_bytes.load(std::memory_order_relaxed);
}
#endif

#endif
