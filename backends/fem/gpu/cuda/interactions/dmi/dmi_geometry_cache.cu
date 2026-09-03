/*
 * GPU CUDA DMI geometry cache implementation.
 *
 * Implements precomputation and caching of tetrahedral shape gradients and
 * volumes on the device to avoid repeated geometric evaluations during RK stages.
 */
#include "gpu/cuda/interactions/dmi/dmi_geometry_cache.hpp"
#include "gpu/cuda/interactions/dmi/dmi_tetra_math.cuh"

#include <cuda_runtime.h>
#include <algorithm>
#include <limits>
#include <utility>
#include <vector>

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME

namespace {

constexpr int kBlockSize = 256;

bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

__global__ void dmi_precompute_geometry_kernel(
    const double *__restrict__ nodes_xyz,
    const uint32_t *__restrict__ elements,
    const uint8_t *__restrict__ magnetic_element_mask,
    double *__restrict__ out_grads,
    double *__restrict__ out_volume,
    uint8_t *__restrict__ out_valid_mask,
    unsigned long long *__restrict__ d_degenerate_count,
    unsigned long long *__restrict__ d_nonfinite_count,
    int element_count,
    int node_count)
{
    const int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= element_count) {
        return;
    }

    if (magnetic_element_mask != nullptr && magnetic_element_mask[e] == 0u) {
        out_valid_mask[e] = 0u;
        out_volume[e] = 0.0;
        for (int i = 0; i < 12; ++i) {
            out_grads[static_cast<size_t>(e) * 12u + static_cast<size_t>(i)] = 0.0;
        }
        return;
    }

    const size_t ebase = static_cast<size_t>(e) * 4u;
    const uint32_t nodes[4] = {
        elements[ebase + 0u],
        elements[ebase + 1u],
        elements[ebase + 2u],
        elements[ebase + 3u],
    };

    bool valid_nodes = true;
    for (int local = 0; local < 4; ++local) {
        valid_nodes = valid_nodes && (nodes[local] < static_cast<uint32_t>(node_count));
    }
    if (!valid_nodes) {
        out_valid_mask[e] = 0u;
        out_volume[e] = 0.0;
        for (int i = 0; i < 12; ++i) {
            out_grads[static_cast<size_t>(e) * 12u + static_cast<size_t>(i)] = 0.0;
        }
        if (d_degenerate_count != nullptr) {
            atomicAdd(d_degenerate_count, 1ull);
        }
        return;
    }

    double grads[4][3];
    double volume = 0.0;
    bool nonfinite_geometry = false;
    if (!dmi_tetra_gradients_device(
            nodes_xyz, nodes[0], nodes[1], nodes[2], nodes[3], grads, volume,
            nullptr, nullptr, &nonfinite_geometry)) {
        out_valid_mask[e] = 0u;
        out_volume[e] = 0.0;
        for (int i = 0; i < 12; ++i) {
            out_grads[static_cast<size_t>(e) * 12u + static_cast<size_t>(i)] = 0.0;
        }
        if (nonfinite_geometry) {
            if (d_nonfinite_count != nullptr) {
                atomicAdd(d_nonfinite_count, 1ull);
            }
        } else {
            if (d_degenerate_count != nullptr) {
                atomicAdd(d_degenerate_count, 1ull);
            }
        }
        return;
    }

    out_valid_mask[e] = 1u;
    out_volume[e] = volume;
    for (int l = 0; l < 4; ++l) {
        for (int d = 0; d < 3; ++d) {
            out_grads[static_cast<size_t>(e) * 12u + static_cast<size_t>(l * 3 + d)] = grads[l][d];
        }
    }
}

} // namespace

DmiGeometryCache::~DmiGeometryCache()
{
    release();
}

DmiGeometryCache::DmiGeometryCache(DmiGeometryCache &&other) noexcept
    : d_grads_(other.d_grads_),
      d_volume_(other.d_volume_),
      d_valid_mask_(other.d_valid_mask_),
      d_color_offsets_(other.d_color_offsets_),
      d_colored_elements_(other.d_colored_elements_),
      h_color_offsets_(std::move(other.h_color_offsets_)),
      element_count_(other.element_count_),
      node_count_(other.node_count_),
      num_colors_(other.num_colors_),
      is_built_(other.is_built_),
      mesh_version_(other.mesh_version_),
      build_count_(other.build_count_),
      apply_count_(other.apply_count_),
      degenerate_tet_count_(other.degenerate_tet_count_),
      nonfinite_count_(other.nonfinite_count_),
      accumulation_mode_(other.accumulation_mode_)
{
    other.d_grads_ = nullptr;
    other.d_volume_ = nullptr;
    other.d_valid_mask_ = nullptr;
    other.d_color_offsets_ = nullptr;
    other.d_colored_elements_ = nullptr;
    other.element_count_ = 0;
    other.node_count_ = 0;
    other.num_colors_ = 0;
    other.is_built_ = false;
    other.mesh_version_ = 0;
    other.build_count_ = 0;
    other.apply_count_ = 0;
    other.degenerate_tet_count_ = 0;
    other.nonfinite_count_ = 0;
}

DmiGeometryCache &DmiGeometryCache::operator=(DmiGeometryCache &&other) noexcept
{
    if (this != &other) {
        release();
        d_grads_ = other.d_grads_;
        d_volume_ = other.d_volume_;
        d_valid_mask_ = other.d_valid_mask_;
        d_color_offsets_ = other.d_color_offsets_;
        d_colored_elements_ = other.d_colored_elements_;
        h_color_offsets_ = std::move(other.h_color_offsets_);
        element_count_ = other.element_count_;
        node_count_ = other.node_count_;
        num_colors_ = other.num_colors_;
        is_built_ = other.is_built_;
        mesh_version_ = other.mesh_version_;
        build_count_ = other.build_count_;
        apply_count_ = other.apply_count_;
        degenerate_tet_count_ = other.degenerate_tet_count_;
        nonfinite_count_ = other.nonfinite_count_;
        accumulation_mode_ = other.accumulation_mode_;

        other.d_grads_ = nullptr;
        other.d_volume_ = nullptr;
        other.d_valid_mask_ = nullptr;
        other.d_color_offsets_ = nullptr;
        other.d_colored_elements_ = nullptr;
        other.element_count_ = 0;
        other.node_count_ = 0;
        other.num_colors_ = 0;
        other.is_built_ = false;
        other.mesh_version_ = 0;
        other.build_count_ = 0;
        other.apply_count_ = 0;
        other.degenerate_tet_count_ = 0;
        other.nonfinite_count_ = 0;
    }
    return *this;
}

void DmiGeometryCache::release() noexcept
{
    if (d_grads_ != nullptr) {
        cudaFree(d_grads_);
        d_grads_ = nullptr;
    }
    if (d_volume_ != nullptr) {
        cudaFree(d_volume_);
        d_volume_ = nullptr;
    }
    if (d_valid_mask_ != nullptr) {
        cudaFree(d_valid_mask_);
        d_valid_mask_ = nullptr;
    }
    if (d_color_offsets_ != nullptr) {
        cudaFree(d_color_offsets_);
        d_color_offsets_ = nullptr;
    }
    if (d_colored_elements_ != nullptr) {
        cudaFree(d_colored_elements_);
        d_colored_elements_ = nullptr;
    }
    h_color_offsets_.clear();
    element_count_ = 0;
    node_count_ = 0;
    num_colors_ = 0;
    is_built_ = false;
    mesh_version_ = 0;
    degenerate_tet_count_ = 0;
    nonfinite_count_ = 0;
}

bool DmiGeometryCache::build(
    const double *nodes_xyz,
    const std::uint32_t *elements,
    const std::uint8_t *magnetic_element_mask,
    int element_count,
    int node_count,
    cudaStream_t stream,
    std::string &error,
    std::uint64_t mesh_version)
{
    if (nodes_xyz == nullptr || elements == nullptr || element_count <= 0 || node_count <= 0) {
        error = "invalid parameters for DmiGeometryCache::build";
        return false;
    }

    if (is_built_ && mesh_version_ == mesh_version && element_count_ == element_count && node_count_ == node_count) {
        return true;
    }

    if (element_count_ != element_count) {
        release();
        const size_t grads_bytes = static_cast<size_t>(element_count) * 12u * sizeof(double);
        const size_t volume_bytes = static_cast<size_t>(element_count) * sizeof(double);
        const size_t mask_bytes = static_cast<size_t>(element_count) * sizeof(std::uint8_t);

        if (!cuda_ok(cudaMalloc(reinterpret_cast<void **>(&d_grads_), grads_bytes), "cudaMalloc d_grads_", error) ||
            !cuda_ok(cudaMalloc(reinterpret_cast<void **>(&d_volume_), volume_bytes), "cudaMalloc d_volume_", error) ||
            !cuda_ok(cudaMalloc(reinterpret_cast<void **>(&d_valid_mask_), mask_bytes), "cudaMalloc d_valid_mask_", error)) {
            release();
            return false;
        }
    }

    element_count_ = element_count;
    node_count_ = node_count;

    unsigned long long *d_counters = nullptr;
    if (!cuda_ok(cudaMalloc(reinterpret_cast<void **>(&d_counters), 2 * sizeof(unsigned long long)), "cudaMalloc d_counters", error) ||
        !cuda_ok(cudaMemsetAsync(d_counters, 0, 2 * sizeof(unsigned long long), stream), "cudaMemsetAsync d_counters", error)) {
        if (d_counters != nullptr) cudaFree(d_counters);
        return false;
    }

    const int blocks = (element_count + kBlockSize - 1) / kBlockSize;
    dmi_precompute_geometry_kernel<<<blocks, kBlockSize, 0, stream>>>(
        nodes_xyz,
        elements,
        magnetic_element_mask,
        d_grads_,
        d_volume_,
        d_valid_mask_,
        d_counters + 0,
        d_counters + 1,
        element_count,
        node_count);

    if (!cuda_ok(cudaGetLastError(), "launch dmi_precompute_geometry_kernel", error)) {
        cudaFree(d_counters);
        return false;
    }

    unsigned long long h_counters[2] = {0ull, 0ull};
    if (!cuda_ok(cudaMemcpyAsync(h_counters, d_counters, 2 * sizeof(unsigned long long), cudaMemcpyDeviceToHost, stream), "cudaMemcpyAsync d_counters", error) ||
        !cuda_ok(cudaStreamSynchronize(stream), "cudaStreamSynchronize geometry cache build", error)) {
        cudaFree(d_counters);
        return false;
    }

    cudaFree(d_counters);
    degenerate_tet_count_ = h_counters[0];
    nonfinite_count_ = h_counters[1];

    // Compute element coloring for contention-free residual accumulation
    std::vector<std::uint32_t> h_elements(static_cast<size_t>(element_count) * 4u);
    if (cudaMemcpy(h_elements.data(), elements, h_elements.size() * sizeof(std::uint32_t), cudaMemcpyDefault) == cudaSuccess) {
        std::vector<std::vector<std::uint32_t>> v2e(static_cast<size_t>(node_count));
        for (int e = 0; e < element_count; ++e) {
            for (int k = 0; k < 4; ++k) {
                const uint32_t v = h_elements[static_cast<size_t>(e) * 4u + static_cast<size_t>(k)];
                if (v < static_cast<uint32_t>(node_count)) {
                    v2e[v].push_back(static_cast<uint32_t>(e));
                }
            }
        }
        std::vector<int> colors(static_cast<size_t>(element_count), -1);
        std::vector<bool> forbidden;
        int max_color = 0;
        for (int e = 0; e < element_count; ++e) {
            for (int k = 0; k < 4; ++k) {
                const uint32_t v = h_elements[static_cast<size_t>(e) * 4u + static_cast<size_t>(k)];
                if (v < static_cast<uint32_t>(node_count)) {
                    for (uint32_t nbr : v2e[v]) {
                        if (nbr != static_cast<uint32_t>(e) && colors[nbr] >= 0) {
                            const int c = colors[nbr];
                            if (c >= static_cast<int>(forbidden.size())) {
                                forbidden.resize(static_cast<size_t>(c + 1), false);
                            }
                            forbidden[static_cast<size_t>(c)] = true;
                        }
                    }
                }
            }
            int assigned = 0;
            while (assigned < static_cast<int>(forbidden.size()) && forbidden[static_cast<size_t>(assigned)]) {
                ++assigned;
            }
            colors[static_cast<size_t>(e)] = assigned;
            if (assigned > max_color) max_color = assigned;
            std::fill(forbidden.begin(), forbidden.end(), false);
        }
        const int num_colors = max_color + 1;
        std::vector<std::vector<std::uint32_t>> groups(static_cast<size_t>(num_colors));
        for (int e = 0; e < element_count; ++e) {
            groups[static_cast<size_t>(colors[static_cast<size_t>(e)])].push_back(static_cast<uint32_t>(e));
        }
        std::vector<std::uint32_t> h_color_offsets(static_cast<size_t>(num_colors + 1), 0u);
        std::vector<std::uint32_t> h_colored_elements(static_cast<size_t>(element_count));
        uint32_t running = 0;
        for (int c = 0; c < num_colors; ++c) {
            h_color_offsets[static_cast<size_t>(c)] = running;
            std::copy(groups[static_cast<size_t>(c)].begin(), groups[static_cast<size_t>(c)].end(), h_colored_elements.begin() + running);
            running += static_cast<uint32_t>(groups[static_cast<size_t>(c)].size());
        }
        h_color_offsets[static_cast<size_t>(num_colors)] = running;

        if (d_color_offsets_ != nullptr) cudaFree(d_color_offsets_);
        if (d_colored_elements_ != nullptr) cudaFree(d_colored_elements_);
        d_color_offsets_ = nullptr;
        d_colored_elements_ = nullptr;

        accumulation_mode_ = DmiAccumulationMode::AtomicAdd;
        if (num_colors <= 32) {
            cudaError_t err_off = cudaMalloc(reinterpret_cast<void **>(&d_color_offsets_), static_cast<size_t>(num_colors + 1) * sizeof(std::uint32_t));
            cudaError_t err_elem = cudaMalloc(reinterpret_cast<void **>(&d_colored_elements_), static_cast<size_t>(element_count) * sizeof(std::uint32_t));
            if (err_off != cudaSuccess || err_elem != cudaSuccess) {
                if (d_color_offsets_ != nullptr) { cudaFree(d_color_offsets_); d_color_offsets_ = nullptr; }
                if (d_colored_elements_ != nullptr) { cudaFree(d_colored_elements_); d_colored_elements_ = nullptr; }
                error = "cudaMalloc for DMI coloring offsets/elements failed";
                return false;
            }
            cudaError_t cpy_off = cudaMemcpyAsync(d_color_offsets_, h_color_offsets.data(), static_cast<size_t>(num_colors + 1) * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream);
            cudaError_t cpy_elem = cudaMemcpyAsync(d_colored_elements_, h_colored_elements.data(), static_cast<size_t>(element_count) * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream);
            if (cpy_off == cudaSuccess && cpy_elem == cudaSuccess) {
                num_colors_ = num_colors;
                h_color_offsets_ = std::move(h_color_offsets);
                // Default accumulation mode remains AtomicAdd; coloring is not promoted without qualification
                accumulation_mode_ = DmiAccumulationMode::AtomicAdd;
            } else {
                if (d_color_offsets_ != nullptr) { cudaFree(d_color_offsets_); d_color_offsets_ = nullptr; }
                if (d_colored_elements_ != nullptr) { cudaFree(d_colored_elements_); d_colored_elements_ = nullptr; }
                error = "cudaMemcpyAsync for DMI coloring offsets/elements failed";
                return false;
            }
        }
    }

    mesh_version_ = mesh_version;
    is_built_ = true;
    ++build_count_;
    error.clear();
    return true;
}

#endif

} // namespace fullmag::fem
