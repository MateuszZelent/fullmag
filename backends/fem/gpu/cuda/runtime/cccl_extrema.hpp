#pragma once

// CUDA 13's CCCL 3 removed the legacy CUB max/min function objects. The
// documented cuda::maximum/cuda::minimum replacements use fmax/fmin for
// floating-point values, which changes NaN propagation and signed-zero
// selection. These reductions already have observable ordered-comparison
// semantics, so keep that operation in a small local functor that is valid
// with both CCCL 2 and CCCL 3.

namespace fullmag::fem::cuda_compat {

struct legacy_maximum {
    __host__ __device__ constexpr double operator()(
        double lhs, double rhs) const noexcept
    {
        return (rhs > lhs) ? rhs : lhs;
    }
};

struct legacy_minimum {
    __host__ __device__ constexpr double operator()(
        double lhs, double rhs) const noexcept
    {
        return (rhs < lhs) ? rhs : lhs;
    }
};

} // namespace fullmag::fem::cuda_compat
