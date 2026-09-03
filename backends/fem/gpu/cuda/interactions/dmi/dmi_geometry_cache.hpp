/*
 * GPU CUDA DMI geometry cache module header.
 *
 * Owns persistent, immutable tetrahedral geometry data (gradients, volumes,
 * and degenerate/nonfinite validity masks) for linear tetrahedra. Avoids
 * recomputing determinants, cross products, and conditioning on every RK stage.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

enum class DmiAccumulationMode : std::uint32_t {
    AtomicAdd = 0,
    Coloring = 1,
};

struct DmiGeometryDeviceView {
    const double *grads = nullptr;       // [element_count * 4 * 3]
    const double *volume = nullptr;      // [element_count]
    const std::uint8_t *valid_mask = nullptr; // [element_count]
    int element_count = 0;
    int node_count = 0;
    int num_colors = 0;
    const std::uint32_t *color_offsets = nullptr;   // [num_colors + 1]
    const std::uint32_t *host_color_offsets = nullptr; // [num_colors + 1]
    const std::uint32_t *colored_elements = nullptr; // [element_count]
};

class DmiGeometryCache {
public:
    DmiGeometryCache() noexcept = default;
    ~DmiGeometryCache();

    DmiGeometryCache(const DmiGeometryCache &) = delete;
    DmiGeometryCache &operator=(const DmiGeometryCache &) = delete;
    DmiGeometryCache(DmiGeometryCache &&other) noexcept;
    DmiGeometryCache &operator=(DmiGeometryCache &&other) noexcept;

    bool build(
        const double *nodes_xyz,
        const std::uint32_t *elements,
        const std::uint8_t *magnetic_element_mask,
        int element_count,
        int node_count,
        cudaStream_t stream,
        std::string &error,
        std::uint64_t mesh_version = 0);

    void release() noexcept;

    DmiGeometryDeviceView device_view() const noexcept {
        return DmiGeometryDeviceView{
            d_grads_,
            d_volume_,
            d_valid_mask_,
            element_count_,
            node_count_,
            num_colors_,
            d_color_offsets_,
            h_color_offsets_.empty() ? nullptr : h_color_offsets_.data(),
            d_colored_elements_
        };
    }

    bool is_built() const noexcept { return is_built_; }
    std::uint64_t mesh_version() const noexcept { return mesh_version_; }
    std::uint64_t build_count() const noexcept { return build_count_; }
    std::uint64_t apply_count() const noexcept { return apply_count_; }
    void record_apply() noexcept { ++apply_count_; }
    std::uint64_t degenerate_tet_count() const noexcept { return degenerate_tet_count_; }
    std::uint64_t nonfinite_count() const noexcept { return nonfinite_count_; }
    int element_count() const noexcept { return element_count_; }
    int node_count() const noexcept { return node_count_; }
    int num_colors() const noexcept { return num_colors_; }

    DmiAccumulationMode accumulation_mode() const noexcept { return accumulation_mode_; }
    void set_accumulation_mode(DmiAccumulationMode mode) noexcept { accumulation_mode_ = mode; }

private:
    double *d_grads_ = nullptr;
    double *d_volume_ = nullptr;
    std::uint8_t *d_valid_mask_ = nullptr;
    std::uint32_t *d_color_offsets_ = nullptr;
    std::uint32_t *d_colored_elements_ = nullptr;
    std::vector<std::uint32_t> h_color_offsets_;
    int element_count_ = 0;
    int node_count_ = 0;
    int num_colors_ = 0;
    bool is_built_ = false;
    std::uint64_t mesh_version_ = 0;
    std::uint64_t build_count_ = 0;
    std::uint64_t apply_count_ = 0;
    std::uint64_t degenerate_tet_count_ = 0;
    std::uint64_t nonfinite_count_ = 0;
    DmiAccumulationMode accumulation_mode_ = DmiAccumulationMode::AtomicAdd;
};

} // namespace fullmag::fem
#endif
