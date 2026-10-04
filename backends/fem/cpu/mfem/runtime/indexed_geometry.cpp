/* Cold live MFEM indexed geometry snapshots; no field computation or solver policy. */
#include "cpu/mfem/runtime/indexed_geometry.hpp"
#if FULLMAG_HAS_MFEM_STACK
#include "context.hpp"
#include <mfem.hpp>
#include <cmath>
#include <cstring>
#include <limits>
namespace fullmag::fem {
namespace {
constexpr std::uint64_t kMaxLiveGeometryNodes = 4ull * 1024ull * 1024ull;
constexpr std::uint64_t kMaxLiveGeometryCells = 4ull * 1024ull * 1024ull;
constexpr std::uint64_t kMaxLiveGeometryChunk = 4096ull;
constexpr std::uint64_t kLiveCellRecordWidth = 9ull;
bool cell_type_arity(std::uint32_t cell_type, std::uint32_t &arity)
{
    switch (cell_type) {
    case FULLMAG_FEM_CELL_TET4:
        arity = 4u;
        return true;
    case FULLMAG_FEM_CELL_PRISM6:
        arity = 6u;
        return true;
    case FULLMAG_FEM_CELL_PYRAMID5:
        arity = 5u;
        return true;
    case FULLMAG_FEM_CELL_HEX8:
        arity = 8u;
        return true;
    default:
        arity = 0u;
        return false;
    }
}

bool mfem_geometry_cell_type(
    mfem::Geometry::Type geometry,
    std::uint32_t &cell_type,
    std::uint32_t &arity)
{
    switch (geometry) {
    case mfem::Geometry::TETRAHEDRON:
        cell_type = FULLMAG_FEM_CELL_TET4;
        arity = 4u;
        return true;
    case mfem::Geometry::PRISM:
        cell_type = FULLMAG_FEM_CELL_PRISM6;
        arity = 6u;
        return true;
    case mfem::Geometry::PYRAMID:
        cell_type = FULLMAG_FEM_CELL_PYRAMID5;
        arity = 5u;
        return true;
    case mfem::Geometry::CUBE:
        cell_type = FULLMAG_FEM_CELL_HEX8;
        arity = 8u;
        return true;
    default:
        cell_type = 0u;
        arity = 0u;
        return false;
    }
}

bool same_double_bits(double first, double second)
{
    std::uint64_t first_bits = 0u;
    std::uint64_t second_bits = 0u;
    static_assert(sizeof(first_bits) == sizeof(first), "FEM geometry requires IEEE-754 binary64");
    static_assert(std::numeric_limits<double>::is_iec559 &&
        std::numeric_limits<double>::digits == 53, "FEM geometry requires IEEE-754 binary64");
    std::memcpy(&first_bits, &first, sizeof(first_bits));
    std::memcpy(&second_bits, &second, sizeof(second_bits));
    return first_bits == second_bits;
}


bool validate_live_geometry_context(
    const fullmag::fem::Context &ctx,
    std::uint64_t expected_total_nodes,
    std::uint64_t expected_total_cells,
    std::string &error)
{
    if (expected_total_nodes == 0u || expected_total_nodes > kMaxLiveGeometryNodes ||
        expected_total_cells == 0u || expected_total_cells > kMaxLiveGeometryCells ||
        expected_total_nodes > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ||
        expected_total_cells > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        error = "live MFEM geometry requires positive bounded node and cell extents";
        return false;
    }
    if (ctx.base_plan.fe_order != 1u) {
        error = "live MFEM geometry requires scalar H1 P1 magnetization space";
        return false;
    }
    if (!ctx.mfem_context.ready || ctx.mfem_context.mesh == nullptr ||
        ctx.mfem_context.fes == nullptr) {
        error = "live MFEM geometry requires a ready mesh and finite element space";
        return false;
    }

    mfem::Mesh *mesh = ctx.mfem_context.mesh;
    mfem::FiniteElementSpace *fes = ctx.mfem_context.fes;
    if (fes->GetMesh() != mesh || mesh->Dimension() != 3 || mesh->SpaceDimension() != 3 ||
        fes->GetVDim() != 1 ||
        static_cast<std::uint64_t>(mesh->GetNV()) != expected_total_nodes ||
        static_cast<std::uint64_t>(mesh->GetNE()) != expected_total_cells ||
        static_cast<std::uint64_t>(fes->GetNDofs()) != expected_total_nodes) {
        error = "live MFEM geometry is not the bounded scalar P1 context mesh";
        return false;
    }
    if (ctx.mesh.n_nodes != expected_total_nodes ||
        ctx.mesh.n_elements != expected_total_cells ||
        ctx.mesh.nodes_xyz.size() != expected_total_nodes * 3u ||
        ctx.mesh.cell_types.size() != expected_total_cells ||
        ctx.mesh.cell_offsets.size() != expected_total_cells + 1u ||
        ctx.mesh.cell_offsets.empty() || ctx.mesh.cell_offsets.front() != 0u ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size() ||
        ctx.mesh.cell_nodes.size() > static_cast<std::size_t>(std::numeric_limits<std::uint32_t>::max())) {
        error = "live MFEM geometry canonical Context arrays have invalid extents";
        return false;
    }
    return true;
}

bool validate_live_geometry_range(
    std::uint64_t total,
    std::uint64_t first,
    std::uint64_t count,
    const char *label,
    std::string &error)
{
    if (count == 0u || count > kMaxLiveGeometryChunk || first > total ||
        count > total - first) {
        error = std::string("live MFEM geometry ") + label + " range is invalid or exceeds the chunk bound";
        return false;
    }
    return true;
}

} // namespace

bool collect_live_node_geometry_chunk(
    const fullmag::fem::Context &ctx,
    std::uint64_t expected_total_nodes,
    std::uint64_t expected_total_cells,
    std::uint64_t first_node,
    std::uint64_t node_count,
    std::vector<double> &chunk,
    std::string &error)
{
    chunk.clear();
    error.clear();
    if (!validate_live_geometry_context(ctx, expected_total_nodes, expected_total_cells, error) ||
        !validate_live_geometry_range(
            expected_total_nodes, first_node, node_count, "node", error)) {
        return false;
    }
    chunk.reserve(static_cast<std::size_t>(node_count) * 3u);
    mfem::FiniteElementSpace *fes = ctx.mfem_context.fes;
    mfem::Mesh *mesh = ctx.mfem_context.mesh;
    mfem::Array<int> vertex_dofs;
    for (std::uint64_t offset = 0u; offset < node_count; ++offset) {
        const std::uint64_t node = first_node + offset;
        fes->GetVertexDofs(static_cast<int>(node), vertex_dofs);
        if (vertex_dofs.Size() != 1 || vertex_dofs[0] != static_cast<int>(node)) {
            error = "live MFEM vertex DOF ordering differs from canonical node ordering";
            return false;
        }
        const double *actual = mesh->GetVertex(static_cast<int>(node));
        if (actual == nullptr) {
            error = "live MFEM mesh returned a null vertex coordinate pointer";
            return false;
        }
        for (std::uint32_t axis = 0u; axis < 3u; ++axis) {
            const double expected = ctx.mesh.nodes_xyz[3u * static_cast<std::size_t>(node) + axis];
            if (!std::isfinite(expected) || !std::isfinite(actual[axis]) ||
                !same_double_bits(expected, actual[axis])) {
                error = "live MFEM vertex coordinates differ bit-for-bit from canonical Context";
                return false;
            }
            chunk.push_back(actual[axis]);
        }
    }
    return true;
}

bool collect_live_cell_geometry_chunk(
    const fullmag::fem::Context &ctx,
    std::uint64_t expected_total_nodes,
    std::uint64_t expected_total_cells,
    std::uint64_t first_cell,
    std::uint64_t cell_count,
    std::vector<std::uint32_t> &chunk,
    std::string &error)
{
    chunk.clear();
    error.clear();
    if (!validate_live_geometry_context(ctx, expected_total_nodes, expected_total_cells, error) ||
        !validate_live_geometry_range(
            expected_total_cells, first_cell, cell_count, "cell", error)) {
        return false;
    }
    chunk.reserve(static_cast<std::size_t>(cell_count) * kLiveCellRecordWidth);
    mfem::Mesh *mesh = ctx.mfem_context.mesh;
    mfem::Array<int> vertices;
    for (std::uint64_t offset = 0u; offset < cell_count; ++offset) {
        const std::size_t cell = static_cast<std::size_t>(first_cell + offset);
        const std::uint32_t expected_type = ctx.mesh.cell_types[cell];
        std::uint32_t expected_arity = 0u;
        if (!cell_type_arity(expected_type, expected_arity)) {
            error = "live MFEM geometry encountered an unsupported canonical cell type";
            return false;
        }
        const std::uint32_t start = ctx.mesh.cell_offsets[cell];
        const std::uint32_t end = ctx.mesh.cell_offsets[cell + 1u];
        if (end < start || end - start != expected_arity ||
            static_cast<std::size_t>(end) > ctx.mesh.cell_nodes.size()) {
            error = "live MFEM geometry canonical cell offsets are invalid";
            return false;
        }

        std::uint32_t actual_type = 0u;
        std::uint32_t actual_arity = 0u;
        if (!mfem_geometry_cell_type(
                mesh->GetElementGeometry(static_cast<int>(cell)), actual_type, actual_arity) ||
            actual_type != expected_type || actual_arity != expected_arity) {
            error = "live MFEM element geometry differs from canonical cell type";
            return false;
        }
        mesh->GetElementVertices(static_cast<int>(cell), vertices);
        if (vertices.Size() != static_cast<int>(expected_arity)) {
            error = "live MFEM element arity differs from canonical cell connectivity";
            return false;
        }

        chunk.push_back(actual_type);
        for (std::uint32_t slot = 0u; slot < 8u; ++slot) {
            if (slot >= expected_arity) {
                chunk.push_back(0u);
                continue;
            }
            const int actual_node = vertices[static_cast<int>(slot)];
            const std::uint32_t expected_node =
                ctx.mesh.cell_nodes[static_cast<std::size_t>(start) + slot];
            if (actual_node < 0 || static_cast<std::uint64_t>(actual_node) >= expected_total_nodes ||
                actual_node != static_cast<int>(expected_node)) {
                error = "live MFEM element vertex connectivity differs from canonical Context";
                return false;
            }
            chunk.push_back(static_cast<std::uint32_t>(actual_node));
        }
    }
    return true;
}

} // namespace fullmag::fem
#endif
