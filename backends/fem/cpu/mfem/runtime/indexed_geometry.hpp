#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {
struct Context;

// Cold actual MFEM node/cell projection. Caller must hold exclusive ownership
// of an immutable terminal Context. Successful chunks are fully checked;
// failed chunk contents are unusable and must be discarded by the caller.
// no field transfer, physics evaluation or layout/solver policy lives here.
#if FULLMAG_HAS_MFEM_STACK
bool collect_live_node_geometry_chunk(
    const Context &ctx, std::uint64_t expected_total_nodes,
    std::uint64_t expected_total_cells, std::uint64_t first_node,
    std::uint64_t node_count, std::vector<double> &chunk, std::string &error);
bool collect_live_cell_geometry_chunk(
    const Context &ctx, std::uint64_t expected_total_nodes,
    std::uint64_t expected_total_cells, std::uint64_t first_cell,
    std::uint64_t cell_count, std::vector<std::uint32_t> &chunk, std::string &error);
#endif
} // namespace fullmag::fem
