/*
 * multilayer_batch_contract.hpp - backend-local D-07 stage accounting.
 *
 * The contract is intentionally independent of CUDA so it can be checked by
 * native source/plan tests without a GPU.  The CUDA launcher owns the actual
 * counter instance in Context and must match these expected warm-refresh
 * counts for the device-resident identity lane.
 */

#ifndef FULLMAG_FDM_MULTILAYER_BATCH_CONTRACT_HPP
#define FULLMAG_FDM_MULTILAYER_BATCH_CONTRACT_HPP

#include <cstdint>

namespace fullmag {
namespace fdm {

struct MultilayerBatchCounts {
    uint64_t layer_count = 0;
    uint64_t forward_fft_count = 0;
    uint64_t inverse_fft_count = 0;
    uint64_t pair_accumulation_count = 0;
    uint64_t h2d_count = 0;
    uint64_t d2h_count = 0;
};

inline constexpr MultilayerBatchCounts expected_multilayer_batch_counts(
    uint64_t layer_count)
{
    return MultilayerBatchCounts{
        layer_count,
        layer_count,
        layer_count,
        layer_count * layer_count,
        0,
        0,
    };
}

struct MultilayerDemagStageCounters {
    uint64_t layer_count = 0;
    uint64_t refresh_count = 0;
    uint64_t forward_fft_count = 0;
    uint64_t inverse_fft_count = 0;
    uint64_t pair_accumulation_count = 0;
    uint64_t h2d_count = 0;
    uint64_t d2h_count = 0;

    void begin_refresh(uint64_t layers)
    {
        layer_count = layers;
        refresh_count = 1;
        forward_fft_count = 0;
        inverse_fft_count = 0;
        pair_accumulation_count = 0;
        h2d_count = 0;
        d2h_count = 0;
    }

    void note_forward_fft() { ++forward_fft_count; }
    void note_inverse_fft() { ++inverse_fft_count; }
    void note_pair_accumulation() { ++pair_accumulation_count; }

    bool matches(const MultilayerBatchCounts &expected) const
    {
        return layer_count == expected.layer_count &&
            forward_fft_count == expected.forward_fft_count &&
            inverse_fft_count == expected.inverse_fft_count &&
            pair_accumulation_count == expected.pair_accumulation_count &&
            h2d_count == expected.h2d_count &&
            d2h_count == expected.d2h_count;
    }
};

} // namespace fdm
} // namespace fullmag

#endif
