#pragma once

#include <cstdint>

#if FULLMAG_ENABLE_NVTX
#include <nvtx3/nvToolsExt.h>
#endif

namespace fullmag::fem::nvtx {

using RangeId = uint64_t;

#if FULLMAG_ENABLE_NVTX

class ScopedRange final {
public:
    explicit ScopedRange(const char *name) noexcept
    {
        nvtxRangePushA(name);
    }

    ~ScopedRange() noexcept
    {
        nvtxRangePop();
    }

    ScopedRange(const ScopedRange &) = delete;
    ScopedRange &operator=(const ScopedRange &) = delete;
};

inline RangeId start(const char *name) noexcept
{
    return static_cast<RangeId>(nvtxRangeStartA(name));
}

inline void end(RangeId id) noexcept
{
    nvtxRangeEnd(static_cast<nvtxRangeId_t>(id));
}

#else

class ScopedRange final {
public:
    constexpr explicit ScopedRange(const char *) noexcept {}
};

constexpr RangeId start(const char *) noexcept
{
    return 0;
}

constexpr void end(RangeId) noexcept {}

#endif

} // namespace fullmag::fem::nvtx

#define FULLMAG_NVTX_CONCAT_INNER(a, b) a##b
#define FULLMAG_NVTX_CONCAT(a, b) FULLMAG_NVTX_CONCAT_INNER(a, b)
#define FULLMAG_NVTX_RANGE(name) \
    [[maybe_unused]] const ::fullmag::fem::nvtx::ScopedRange \
        FULLMAG_NVTX_CONCAT(fullmag_nvtx_range_, __LINE__){name}
