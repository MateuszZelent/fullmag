#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>

namespace fullmag::fem::frequency_domain {

enum class CheckedExtentStatus : std::uint32_t {
    ok = 0,
    arithmetic_overflow = 1,
    policy_limit_exceeded = 2,
    invalid_argument = 3,
};

// These caps bound a single contiguous workspace without narrowing current
// production defaults (restart=8192) or realistic FEM problem sizes.
inline constexpr std::uint64_t kMaxFrequencyDomainKrylovRestartDimension = 8192;
inline constexpr std::uint64_t kMaxFrequencyDomainWorkspaceBytes =
    64ull * 1024ull * 1024ull * 1024ull;
inline constexpr std::uint64_t kMaxFrequencyDomainCudaGridBlocks = 2147483647ull;

constexpr CheckedExtentStatus checked_add_u64_limited(
    std::uint64_t lhs,
    std::uint64_t rhs,
    std::uint64_t limit,
    std::uint64_t &out) noexcept
{
    out = 0;
    if (rhs > std::numeric_limits<std::uint64_t>::max() - lhs) {
        return CheckedExtentStatus::arithmetic_overflow;
    }
    const std::uint64_t value = lhs + rhs;
    if (value > limit) {
        return CheckedExtentStatus::policy_limit_exceeded;
    }
    out = value;
    return CheckedExtentStatus::ok;
}

constexpr CheckedExtentStatus checked_mul_u64_limited(
    std::uint64_t lhs,
    std::uint64_t rhs,
    std::uint64_t limit,
    std::uint64_t &out) noexcept
{
    out = 0;
    if (lhs != 0 && rhs > std::numeric_limits<std::uint64_t>::max() / lhs) {
        return CheckedExtentStatus::arithmetic_overflow;
    }
    const std::uint64_t value = lhs * rhs;
    if (value > limit) {
        return CheckedExtentStatus::policy_limit_exceeded;
    }
    out = value;
    return CheckedExtentStatus::ok;
}

constexpr bool checked_add_u64(
    std::uint64_t lhs,
    std::uint64_t rhs,
    std::uint64_t &out) noexcept
{
    return checked_add_u64_limited(
               lhs,
               rhs,
               std::numeric_limits<std::uint64_t>::max(),
               out) == CheckedExtentStatus::ok;
}

constexpr bool checked_mul_u64(
    std::uint64_t lhs,
    std::uint64_t rhs,
    std::uint64_t &out) noexcept
{
    return checked_mul_u64_limited(
               lhs,
               rhs,
               std::numeric_limits<std::uint64_t>::max(),
               out) == CheckedExtentStatus::ok;
}

constexpr bool checked_to_size_t(
    std::uint64_t value,
    std::size_t &out) noexcept
{
    out = 0;
    if constexpr (sizeof(std::size_t) < sizeof(std::uint64_t)) {
        if (value > std::numeric_limits<std::size_t>::max()) {
            return false;
        }
    }
    out = static_cast<std::size_t>(value);
    return true;
}

constexpr bool checked_bytes(
    std::uint64_t count,
    std::size_t element_size,
    std::size_t &out) noexcept
{
    out = 0;
    std::size_t size_count = 0;
    if (!checked_to_size_t(count, size_count) ||
        (element_size != 0 &&
         size_count > std::numeric_limits<std::size_t>::max() / element_size)) {
        return false;
    }
    out = size_count * element_size;
    return true;
}

constexpr CheckedExtentStatus checked_bytes_limited(
    std::uint64_t count,
    std::size_t element_size,
    std::uint64_t max_bytes,
    std::size_t &out) noexcept
{
    out = 0;
    std::size_t bytes = 0;
    if (!checked_bytes(count, element_size, bytes)) {
        return CheckedExtentStatus::arithmetic_overflow;
    }
    if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
        if (bytes > std::numeric_limits<std::uint64_t>::max()) {
            return CheckedExtentStatus::arithmetic_overflow;
        }
    }
    if (static_cast<std::uint64_t>(bytes) > max_bytes) {
        return CheckedExtentStatus::policy_limit_exceeded;
    }
    out = bytes;
    return CheckedExtentStatus::ok;
}

constexpr bool checked_offset_extent(
    std::uint64_t offset,
    std::uint64_t extent,
    std::uint64_t capacity,
    std::uint64_t &out_end) noexcept
{
    if (!checked_add_u64(offset, extent, out_end) || out_end > capacity) {
        out_end = 0;
        return false;
    }
    return true;
}

constexpr CheckedExtentStatus checked_cuda_grid_u32(
    std::uint64_t work_item_count,
    std::uint32_t threads_per_block,
    std::uint64_t max_grid_blocks,
    std::uint32_t &out_blocks) noexcept
{
    out_blocks = 0;
    if (threads_per_block == 0 || (work_item_count > 0 && max_grid_blocks == 0)) {
        return CheckedExtentStatus::invalid_argument;
    }
    const std::uint64_t blocks = work_item_count / threads_per_block +
        (work_item_count % threads_per_block == 0 ? 0 : 1);
    if (blocks > max_grid_blocks ||
        blocks > std::numeric_limits<std::uint32_t>::max()) {
        return CheckedExtentStatus::policy_limit_exceeded;
    }
    out_blocks = static_cast<std::uint32_t>(blocks);
    return CheckedExtentStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
