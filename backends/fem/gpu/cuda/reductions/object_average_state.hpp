#pragma once

#include <array>
#include <cstdint>
#include <cstddef>
#include <vector>
#include <string>

namespace fullmag::fem {

// Four LRU payloads, each bounded by max(N,E) records and selector indices.
// One shared exact dependency snapshot and preparation buffer are O(N+E).
// Duplicate-heavy selectors beyond max(N,E) retain bounded streaming scratch.
inline constexpr size_t kObjectAverageCacheEntries = 4;
inline constexpr size_t kObjectAverageChunkRecords = 4096;

struct GpuObjectAverageRecord {
    uint32_t nodes[4]{};
    uint32_t count = 0;
    double weight = 0.0;
};
static_assert(sizeof(GpuObjectAverageRecord) == 32);
struct GpuObjectAverageCacheEntry {
    std::vector<GpuObjectAverageRecord> records;
    std::vector<uint32_t> selector;
    bool element_set = false;
    void *device_records = nullptr;
    uint64_t node_count = 0;
    uint64_t last_use = 0;
    size_t device_capacity = 0;
    bool dg0 = false;
    bool valid = false;
};

struct GpuObjectAverageState {
    std::array<GpuObjectAverageCacheEntry, kObjectAverageCacheEntries> entries;
    std::vector<GpuObjectAverageRecord> preparation;
    std::vector<GpuObjectAverageRecord> chunk;
    std::vector<uint8_t> membership;
    // Effective nodal weights (invalid/nonpositive becomes zero), or ordered
    // DG0 active ordinals and their exact topology/weight dependencies.
    std::vector<double> dependency_weights;
    std::vector<uint64_t> dependency_ordinals;
    std::vector<GpuObjectAverageRecord> dependency_records;
    bool dependencies_valid = false;
    bool dependencies_dg0 = false;
    uint64_t membership_node_count = 0;
    uint64_t membership_element_count = 0;
    void *device_chunk = nullptr;
    double *result = nullptr; // four totals plus four chunk sums
    size_t preparation_limit = 0;
    size_t chunk_limit = 0;
    uint64_t device_bytes = 0;
    uint64_t sequence = 0;
    uint64_t record_generation_passes = 0;
    uint64_t cache_hits = 0;
    uint64_t cache_misses = 0;
    bool allocated = false;
};

bool gpu_object_average_allocate(
    GpuObjectAverageState &state, uint64_t node_count,
    uint64_t &device_bytes, uint64_t &reduction_workspace_bytes, std::string &error);
void gpu_object_average_free(GpuObjectAverageState &state);

} // namespace fullmag::fem
