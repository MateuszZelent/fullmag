#pragma once

#include <cuda_runtime.h>

namespace fullmag::fem::gpu_relax_dd {

struct Value {
    double hi;
    double lo;
};

__device__ __forceinline__ Value two_sum(double a, double b)
{
    const double hi = a + b;
    const double b_virtual = hi - a;
    const double lo = (a - (hi - b_virtual)) + (b - b_virtual);
    return {hi, lo};
}

__device__ __forceinline__ Value two_diff(double a, double b)
{
    const double hi = a - b;
    const double b_virtual = a - hi;
    const double lo = (a - (hi + b_virtual)) + (b_virtual - b);
    return {hi, lo};
}

__device__ __forceinline__ Value two_product(double a, double b)
{
    const double hi = a * b;
    return {hi, fma(a, b, -hi)};
}

__device__ __forceinline__ Value add(Value a, Value b)
{
    const Value sum = two_sum(a.hi, b.hi);
    const Value correction = two_sum(sum.lo, a.lo + b.lo);
    const Value normalized = two_sum(sum.hi, correction.hi);
    return {normalized.hi, normalized.lo + correction.lo};
}

__device__ __forceinline__ Value subtract(Value a, Value b)
{
    return add(a, {-b.hi, -b.lo});
}

__device__ __forceinline__ Value multiply(Value a, Value b)
{
    const Value product = two_product(a.hi, b.hi);
    const double correction =
        product.lo + a.hi * b.lo + a.lo * b.hi + a.lo * b.lo;
    return two_sum(product.hi, correction);
}

__device__ __forceinline__ Value scale(Value value, double factor)
{
    return multiply(value, {factor, 0.0});
}

__device__ __forceinline__ Value dot3(
    double ax,
    double ay,
    double az,
    double bx,
    double by,
    double bz)
{
    return add(
        add(two_product(ax, bx), two_product(ay, by)),
        two_product(az, bz));
}

__device__ __forceinline__ double rounded(Value value)
{
    return value.hi + value.lo;
}

__device__ __forceinline__ double magnitude(Value value)
{
    return fabs(value.hi) + fabs(value.lo);
}

} // namespace fullmag::fem::gpu_relax_dd
