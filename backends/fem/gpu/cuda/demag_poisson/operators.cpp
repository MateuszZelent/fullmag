/*
 * GPU CUDA Poisson demag operator workspace source contract.
 *
 * This source owns construction and device upload/destruction of the strict GPU
 * Poisson demag P1-state/resolved-potential-order RHS CSR, P1-state recovery
 * CSR, and essential potential true DOF lists. Periodic reduction remains
 * P1/P1. It validates inputs and dispatches the element-loop assembly to
 * mixed_operator_assembly_csr.cpp (default, nonperiodic) or
 * mixed_operator_assembly_maps.cpp (periodic, or the
 * FULLMAG_FEM_DEMAG_OPERATOR_BUILD=maps A/B reference). It does not own Hypre
 * solver policy, lifecycle publication, RK-stage orchestration, local
 * interaction kernels, or C ABI entrypoints.
 */

#include "gpu/cuda/demag_poisson/operators.hpp"

#include "context.hpp"
#include "core/fem_material_runtime.hpp"
#include "fem_common.hpp"
#include "fem_memory_trace.hpp"
#include "gpu/cuda/demag_poisson/mixed_operator_assembly.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace fullmag::fem {

namespace {

constexpr std::string_view kMixedP1ResolvedDemagQuadraturePolicy =
    "mixed_p1_state_resolved_potential_demag_operator.v3:int_rules_2p";
constexpr std::string_view kPeriodicP1DemagQuadraturePolicy =
    "periodic_p1_node_class_demag_operator.v1:int_rules_3";

void fnv1a_byte(uint64_t &hash, uint8_t value)
{
    hash ^= value;
    hash *= 1099511628211ull;
}

void fnv1a_u64(uint64_t &hash, uint64_t value)
{
    for (unsigned shift = 0; shift < 64; shift += 8) {
        fnv1a_byte(hash, static_cast<uint8_t>((value >> shift) & 0xffu));
    }
}

void fnv1a_string(uint64_t &hash, std::string_view value)
{
    fnv1a_u64(hash, value.size());
    for (const unsigned char byte : value) {
        fnv1a_byte(hash, byte);
    }
}

template <typename T>
void fnv1a_integral_vector(uint64_t &hash, const std::vector<T> &values)
{
    fnv1a_u64(hash, values.size());
    for (const T value : values) {
        fnv1a_u64(hash, static_cast<uint64_t>(value));
    }
}

bool canonical_double_bits(
    double value,
    uint64_t &bits,
    const char *label,
    std::string &error)
{
    if (!std::isfinite(value)) {
        error = std::string("mixed GPU demag fingerprint rejects non-finite ") + label;
        return false;
    }
    if (value == 0.0) {
        bits = 0u;
        return true;
    }
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    return true;
}

bool fnv1a_double(
    uint64_t &hash,
    double value,
    const char *label,
    std::string &error)
{
    uint64_t bits = 0u;
    if (!canonical_double_bits(value, bits, label, error)) {
        return false;
    }
    fnv1a_u64(hash, bits);
    return true;
}

bool fnv1a_double_vector(
    uint64_t &hash,
    const std::vector<double> &values,
    const char *label,
    std::string &error)
{
    fnv1a_u64(hash, values.size());
    for (const double value : values) {
        if (!fnv1a_double(hash, value, label, error)) {
            return false;
        }
    }
    return true;
}

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

template <typename T>
bool upload_device_array(
    T *&dst,
    const std::vector<T> &src,
    uint64_t &device_bytes,
    const char *name,
    std::string &error)
{
    dst = nullptr;
    if (src.empty()) {
        return true;
    }
    if (src.size() > std::numeric_limits<size_t>::max() / sizeof(T)) {
        error = std::string(name) + " is too large for device allocation";
        return false;
    }
    const size_t bytes = src.size() * sizeof(T);
    if (!cuda_ok(cudaMalloc(reinterpret_cast<void **>(&dst), bytes), name, error)) {
        dst = nullptr;
        return false;
    }
    if (!cuda_ok(cudaMemcpy(dst, src.data(), bytes, cudaMemcpyHostToDevice), name, error)) {
        cudaFree(dst);
        dst = nullptr;
        return false;
    }
    device_bytes += static_cast<uint64_t>(bytes);
    return true;
}

template <typename T>
void free_device_array(T *&ptr)
{
    if (ptr != nullptr) {
        cudaFree(ptr);
        ptr = nullptr;
    }
}

bool upload_triple(DeviceCsrTriple &op, uint64_t &device_bytes, std::string &error)
{
    return upload_device_array(op.d_row_offsets, op.row_offsets, device_bytes, "cudaMalloc/upload demag RHS row offsets", error) &&
           upload_device_array(op.d_col_indices, op.col_indices, device_bytes, "cudaMalloc/upload demag RHS column indices", error) &&
           upload_device_array(op.d_values_x, op.values_x, device_bytes, "cudaMalloc/upload demag RHS x values", error) &&
           upload_device_array(op.d_values_y, op.values_y, device_bytes, "cudaMalloc/upload demag RHS y values", error) &&
           upload_device_array(op.d_values_z, op.values_z, device_bytes, "cudaMalloc/upload demag RHS z values", error);
}

bool upload_scalar(DeviceCsrScalar &op, uint64_t &device_bytes, const char *label, std::string &error)
{
    return upload_device_array(op.d_row_offsets, op.row_offsets, device_bytes, label, error) &&
           upload_device_array(op.d_col_indices, op.col_indices, device_bytes, label, error) &&
           upload_device_array(op.d_values, op.values, device_bytes, label, error);
}

void destroy_triple(DeviceCsrTriple &op)
{
    free_device_array(op.d_row_offsets);
    free_device_array(op.d_col_indices);
    free_device_array(op.d_values_x);
    free_device_array(op.d_values_y);
    free_device_array(op.d_values_z);
}

void destroy_scalar(DeviceCsrScalar &op)
{
    free_device_array(op.d_row_offsets);
    free_device_array(op.d_col_indices);
    free_device_array(op.d_values);
}
#endif

uint64_t csr_pattern_digest(const DeviceCsrScalar &op)
{
    uint64_t hash = 14695981039346656037ull;
    fnv1a_u64(hash, kFemCompactMarkerMapRevision);
    fnv1a_string(hash, "fullmag.fem.gpu.demag.recovery.csr-pattern.v1");
    fnv1a_u64(hash, op.rows);
    fnv1a_u64(hash, op.nnz);
    fnv1a_integral_vector(hash, op.row_offsets);
    fnv1a_integral_vector(hash, op.col_indices);
    return hash;
}

bool csr_pattern_equal(
    const DeviceCsrScalar &lhs,
    const DeviceCsrScalar &rhs)
{
    return lhs.rows == rhs.rows &&
        lhs.nnz == rhs.nnz &&
        lhs.row_offsets == rhs.row_offsets &&
        lhs.col_indices == rhs.col_indices;
}

bool shared_xyz_csr_pattern(
    const DeviceCsrScalar &x,
    const DeviceCsrScalar &y,
    const DeviceCsrScalar &z)
{
    const uint64_t digest = csr_pattern_digest(x);
    if (digest != csr_pattern_digest(y) || digest != csr_pattern_digest(z)) {
        return false;
    }
    // A digest is only a setup-time fast reject.  Never select the fused
    // kernel without the exact row-offset/column-index comparison.
    return csr_pattern_equal(x, y) && csr_pattern_equal(x, z);
}

#if FULLMAG_HAS_MFEM_STACK
// Shared with the element-loop assembly sources.
using demag_operator_assembly::periodic_scalar_column;
using demag_operator_assembly::periodic_scalar_row_count;

bool copy_sparse_matrix_to_device_csr(
    const mfem::SparseMatrix &matrix,
    uint64_t rows,
    DeviceCsrScalar &op,
    const char *label,
    std::string &error)
{
    if (matrix.Height() != static_cast<int>(rows) ||
        matrix.Width() != static_cast<int>(rows)) {
        error = std::string(label) + " shape does not match scalar potential DOFs";
        return false;
    }
    const int *row_offsets = matrix.GetI();
    const int *col_indices = matrix.GetJ();
    const double *values = matrix.GetData();
    if (row_offsets == nullptr) {
        error = std::string(label) + " CSR row offsets are null";
        return false;
    }
    const int nnz = row_offsets[static_cast<int>(rows)];
    if (nnz < 0 || static_cast<uint64_t>(nnz) > std::numeric_limits<uint32_t>::max()) {
        error = std::string(label) + " exceeds 32-bit CSR capacity";
        return false;
    }
    if (nnz > 0 && (col_indices == nullptr || values == nullptr)) {
        error = std::string(label) + " CSR data are null";
        return false;
    }
    op.rows = rows;
    op.nnz = static_cast<uint64_t>(nnz);
    op.row_offsets.resize(static_cast<size_t>(rows) + 1u);
    for (uint64_t row = 0; row <= rows; ++row) {
        const int offset = row_offsets[static_cast<int>(row)];
        if (offset < 0 || static_cast<uint64_t>(offset) > static_cast<uint64_t>(nnz)) {
            error = std::string(label) + " row offset is invalid";
            return false;
        }
        op.row_offsets[static_cast<size_t>(row)] = static_cast<uint32_t>(offset);
    }
    op.col_indices.resize(static_cast<size_t>(nnz));
    op.values.resize(static_cast<size_t>(nnz));
    for (int entry = 0; entry < nnz; ++entry) {
        if (col_indices[entry] < 0 || static_cast<uint64_t>(col_indices[entry]) >= rows) {
            error = std::string(label) + " column index is invalid";
            return false;
        }
        op.col_indices[static_cast<size_t>(entry)] =
            static_cast<uint32_t>(col_indices[entry]);
        op.values[static_cast<size_t>(entry)] = values[entry];
    }
    return true;
}

bool reduce_sparse_matrix_by_periodic_classes(
    const mfem::SparseMatrix &matrix,
    const Context &ctx,
    DeviceCsrScalar &op,
    const char *label,
    std::string &error)
{
    const uint64_t full_rows = ctx.mesh.n_nodes;
    const uint64_t reduced_rows = periodic_scalar_row_count(ctx);
    if (matrix.Height() != static_cast<int>(full_rows) ||
        matrix.Width() != static_cast<int>(full_rows)) {
        error = std::string(label) + " full matrix shape does not match mesh nodes";
        return false;
    }
    if (reduced_rows == 0 || reduced_rows > std::numeric_limits<uint32_t>::max()) {
        error = std::string(label) + " periodic reduced row count is invalid";
        return false;
    }

    std::vector<std::vector<std::pair<uint32_t, double>>> rows(
        static_cast<size_t>(reduced_rows));
    mfem::Array<int> cols;
    mfem::Vector vals;
    for (uint64_t row = 0; row < full_rows; ++row) {
        const uint32_t reduced_row =
            periodic_scalar_column(ctx, static_cast<uint32_t>(row));
        matrix.GetRow(static_cast<int>(row), cols, vals);
        for (int k = 0; k < cols.Size(); ++k) {
            if (cols[k] < 0 || static_cast<uint64_t>(cols[k]) >= full_rows) {
                error = std::string(label) + " full matrix column index is invalid";
                return false;
            }
            const uint32_t col = static_cast<uint32_t>(cols[k]);
            const uint32_t reduced_col = periodic_scalar_column(ctx, col);
            rows[static_cast<size_t>(reduced_row)].push_back({reduced_col, vals[k]});
        }
    }

    uint64_t nnz = 0;
    op.rows = reduced_rows;
    op.row_offsets.assign(static_cast<size_t>(reduced_rows) + 1u, 0u);
    for (uint64_t row = 0; row < reduced_rows; ++row) {
        nnz += rows[static_cast<size_t>(row)].size();
        if (nnz > std::numeric_limits<uint32_t>::max()) {
            error = std::string(label) + " periodic reduced CSR exceeds 32-bit capacity";
            return false;
        }
        op.row_offsets[static_cast<size_t>(row) + 1u] = static_cast<uint32_t>(nnz);
    }
    op.nnz = nnz;
    op.col_indices.reserve(static_cast<size_t>(nnz));
    op.values.reserve(static_cast<size_t>(nnz));
    for (const auto &row_entries : rows) {
        for (const auto &entry : row_entries) {
            op.col_indices.push_back(entry.first);
            op.values.push_back(entry.second);
        }
    }
    return true;
}

uint32_t p1_cell_type_for_geometry(mfem::Geometry::Type geometry)
{
    switch (geometry) {
    case mfem::Geometry::TETRAHEDRON:
        return FULLMAG_FEM_CELL_TET4;
    case mfem::Geometry::PRISM:
        return FULLMAG_FEM_CELL_PRISM6;
    case mfem::Geometry::PYRAMID:
        return FULLMAG_FEM_CELL_PYRAMID5;
    default:
        return 0u;
    }
}

bool validate_ctx_mfem_operator_mesh(
    const Context &ctx,
    const mfem::Mesh &mesh,
    std::string &error)
{
    if (mesh.SpaceDimension() != 3 ||
        mesh.GetNV() != static_cast<int>(ctx.mesh.n_nodes) ||
        mesh.GetNE() != static_cast<int>(ctx.mesh.n_elements)) {
        error = "strict FEM GPU demag ctx/MFEM mesh extent divergence";
        return false;
    }
    if (ctx.mesh.nodes_xyz.size() != 3u * static_cast<size_t>(ctx.mesh.n_nodes)) {
        error = "strict FEM GPU demag ctx/MFEM coordinate extent divergence";
        return false;
    }
    for (int node = 0; node < mesh.GetNV(); ++node) {
        const double *mfem_vertex = mesh.GetVertex(node);
        for (int component = 0; component < 3; ++component) {
            uint64_t ctx_bits = 0u;
            uint64_t mfem_bits = 0u;
            if (!canonical_double_bits(
                    ctx.mesh.nodes_xyz[3u * static_cast<size_t>(node) +
                                       static_cast<size_t>(component)],
                    ctx_bits,
                    "ctx mesh coordinate",
                    error) ||
                !canonical_double_bits(
                    mfem_vertex[component],
                    mfem_bits,
                    "MFEM mesh coordinate",
                    error)) {
                return false;
            }
            if (ctx_bits != mfem_bits) {
                error = "strict FEM GPU demag ctx/MFEM coordinate divergence";
                return false;
            }
        }
    }

    if (ctx.mesh.cell_types.size() != static_cast<size_t>(mesh.GetNE()) ||
        ctx.mesh.cell_offsets.size() != static_cast<size_t>(mesh.GetNE()) + 1u ||
        ctx.mesh.cell_offsets.front() != 0u ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size()) {
        error = "strict FEM GPU demag ctx/MFEM typed connectivity extent divergence";
        return false;
    }
    for (int element = 0; element < mesh.GetNE(); ++element) {
        if (ctx.mesh.cell_types[static_cast<size_t>(element)] !=
            p1_cell_type_for_geometry(mesh.GetElementGeometry(element))) {
            error = "strict FEM GPU demag ctx/MFEM cell-family divergence";
            return false;
        }
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        const uint32_t begin = ctx.mesh.cell_offsets[static_cast<size_t>(element)];
        const uint32_t end = ctx.mesh.cell_offsets[static_cast<size_t>(element) + 1u];
        if (end - begin != static_cast<uint32_t>(vertices.Size())) {
            error = "strict FEM GPU demag ctx/MFEM connectivity arity divergence";
            return false;
        }
        for (int local = 0; local < vertices.Size(); ++local) {
            if (ctx.mesh.cell_nodes[static_cast<size_t>(begin) +
                                    static_cast<size_t>(local)] !=
                static_cast<uint32_t>(vertices[local])) {
                error = "strict FEM GPU demag ctx/MFEM connectivity divergence";
                return false;
            }
        }
        if (!ctx.mesh.cell_markers.empty() &&
            ctx.mesh.cell_markers.size() != static_cast<size_t>(mesh.GetNE())) {
            error = "strict FEM GPU demag ctx/MFEM cell-marker extent divergence";
            return false;
        }
        const uint32_t canonical_marker = ctx.mesh.cell_markers.empty()
            ? 1u
            : ctx.mesh.cell_markers[static_cast<size_t>(element)];
        const int expected_mfem_attribute = ctx.mfem_context.marker_maps.domain.attribute(canonical_marker);
        if (expected_mfem_attribute == 0 || expected_mfem_attribute != mesh.GetAttribute(element)) {
            error = "strict FEM GPU demag ctx/MFEM cell-marker divergence";
            return false;
        }
    }
    return true;
}

bool fnv1a_device_csr_scalar(
    uint64_t &hash,
    const DeviceCsrScalar &op,
    const char *label,
    std::string &error)
{
    fnv1a_u64(hash, op.rows);
    fnv1a_u64(hash, op.nnz);
    fnv1a_integral_vector(hash, op.row_offsets);
    fnv1a_integral_vector(hash, op.col_indices);
    return fnv1a_double_vector(hash, op.values, label, error);
}

bool fnv1a_device_csr_triple(
    uint64_t &hash,
    const DeviceCsrTriple &op,
    const char *label,
    std::string &error)
{
    fnv1a_u64(hash, op.rows);
    fnv1a_u64(hash, op.nnz);
    fnv1a_integral_vector(hash, op.row_offsets);
    fnv1a_integral_vector(hash, op.col_indices);
    return fnv1a_double_vector(hash, op.values_x, label, error) &&
           fnv1a_double_vector(hash, op.values_y, label, error) &&
           fnv1a_double_vector(hash, op.values_z, label, error);
}

bool fnv1a_mfem_sparse_matrix(
    uint64_t &hash,
    const mfem::SparseMatrix &matrix,
    std::string &error)
{
    const int height = matrix.Height();
    const int width = matrix.Width();
    const int *rows = matrix.GetI();
    if (height < 0 || width < 0 || rows == nullptr || rows[height] < 0) {
        error = "mixed GPU demag fingerprint received invalid Poisson CSR";
        return false;
    }
    const int nnz = rows[height];
    const int *columns = matrix.GetJ();
    const double *values = matrix.GetData();
    if (nnz > 0 && (columns == nullptr || values == nullptr)) {
        error = "mixed GPU demag fingerprint received incomplete Poisson CSR";
        return false;
    }
    fnv1a_u64(hash, static_cast<uint64_t>(height));
    fnv1a_u64(hash, static_cast<uint64_t>(width));
    fnv1a_u64(hash, static_cast<uint64_t>(nnz));
    for (int row = 0; row <= height; ++row) {
        fnv1a_u64(hash, static_cast<uint64_t>(rows[row]));
    }
    for (int entry = 0; entry < nnz; ++entry) {
        fnv1a_u64(hash, static_cast<uint64_t>(columns[entry]));
        if (!fnv1a_double(hash, values[entry], "Poisson matrix value", error)) {
            return false;
        }
    }
    return true;
}

bool build_mixed_demag_operator_fingerprint(
    const Context &ctx,
    const GpuDemagPoissonWorkspace &workspace,
    std::string_view quadrature_policy,
    std::string &fingerprint,
    std::string &error)
{
    uint64_t hash = 14695981039346656037ull;
    fnv1a_string(hash, "fullmag.fem.gpu.demag.mixed_p1_state_potential.operator.v3");
    fnv1a_string(hash, quadrature_policy);
    fnv1a_u64(hash, ctx.base_plan.fe_order);
    fnv1a_u64(hash, ctx.mesh.n_nodes);
    fnv1a_u64(hash, ctx.mesh.n_elements);
    fnv1a_u64(hash, ctx.mesh.n_boundary_faces);
    if (!fnv1a_double_vector(
            hash, ctx.mesh.nodes_xyz, "mesh coordinate", error)) {
        return false;
    }
    fnv1a_integral_vector(hash, ctx.mesh.cell_types);
    fnv1a_integral_vector(hash, ctx.mesh.cell_offsets);
    fnv1a_integral_vector(hash, ctx.mesh.cell_nodes);
    fnv1a_integral_vector(hash, ctx.mesh.cell_markers);
    fnv1a_integral_vector(hash, ctx.mesh.facet_types);
    fnv1a_integral_vector(hash, ctx.mesh.facet_roles);
    fnv1a_integral_vector(hash, ctx.mesh.facet_offsets);
    fnv1a_integral_vector(hash, ctx.mesh.facet_nodes);
    fnv1a_integral_vector(hash, ctx.mesh.facet_markers);
    fnv1a_integral_vector(hash, ctx.mesh.magnetic_element_mask);
    fnv1a_integral_vector(hash, ctx.mesh.periodic_node_pairs);
    fnv1a_integral_vector(hash, ctx.mesh.periodic_reduced_node);
    fnv1a_integral_vector(hash, ctx.mesh.periodic_representative_nodes);
    fnv1a_u64(hash, ctx.mesh.periodic_reduced_node_count);
    std::vector<uint32_t> periodic_boundary_markers(
        ctx.mesh.periodic_boundary_marker_set.begin(),
        ctx.mesh.periodic_boundary_marker_set.end());
    std::sort(periodic_boundary_markers.begin(), periodic_boundary_markers.end());
    fnv1a_integral_vector(hash, periodic_boundary_markers);

    fnv1a_u64(hash, static_cast<uint64_t>(ctx.demag.realization));
    fnv1a_u64(hash, static_cast<uint64_t>(ctx.poisson_demag.boundary_marker));
    fnv1a_u64(hash, static_cast<uint64_t>(ctx.poisson_demag.robin_beta_mode));
    if (!fnv1a_double(
            hash,
            ctx.poisson_demag.robin_beta_factor,
            "Robin beta factor",
            error) ||
        !fnv1a_double(
            hash,
            ctx.poisson_demag.robin_effective_beta,
            "effective Robin beta",
            error)) {
        return false;
    }
    fnv1a_integral_vector(hash, ctx.poisson_demag.ess_tdof_list);

    fnv1a_string(
        hash,
        ctx.material_fields.Ms_field.empty() ? "uniform-Ms" : "nodal-P1-Ms");
    if (!fnv1a_double(
            hash,
            ctx.material_fields.material.saturation_magnetisation,
            "uniform Ms",
            error) ||
        !fnv1a_double_vector(
            hash,
            ctx.material_fields.Ms_field,
            "nodal Ms",
            error)) {
        return false;
    }

    const auto *poisson_matrix = static_cast<const mfem::SparseMatrix *>(
        ctx.poisson_demag.periodic_reduced_ready
            ? ctx.poisson_demag.periodic_matrix
            : ctx.poisson_demag.poisson_bc_op);
    if (poisson_matrix == nullptr) {
        error = "mixed GPU demag fingerprint requires the final Poisson operator";
        return false;
    }
    if (!fnv1a_mfem_sparse_matrix(hash, *poisson_matrix, error) ||
        !fnv1a_device_csr_triple(hash, workspace.rhs, "RHS CSR value", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.recovery_x, "physical recovery x", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.recovery_y, "physical recovery y", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.recovery_z, "physical recovery z", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.visual_recovery_x, "visual recovery x", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.visual_recovery_y, "visual recovery y", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.visual_recovery_z, "visual recovery z", error) ||
        !fnv1a_device_csr_scalar(hash, workspace.robin_boundary_mass, "Robin boundary mass", error)) {
        return false;
    }
    fnv1a_u64(hash, workspace.recovery_xyz_pattern_digest);
    fnv1a_u64(hash, workspace.visual_recovery_xyz_pattern_digest);
    fnv1a_integral_vector(hash, workspace.ess_tdofs);

    std::ostringstream encoded;
    encoded << "fnv1a64:" << std::hex << std::setfill('0') << std::setw(16) << hash;
    fingerprint = encoded.str();
    return true;
}

// A/B diagnostic only. Unlike the provenance fingerprint, which maps -0.0 to
// +0.0, this digest covers the raw bytes, so equal digests mean
// byte-identical host arrays.
template <typename T>
void raw_digest_vector(uint64_t &hash, const std::vector<T> &values)
{
    fnv1a_u64(hash, values.size());
    const auto *bytes = reinterpret_cast<const unsigned char *>(values.data());
    for (size_t index = 0; index < values.size() * sizeof(T); ++index) {
        fnv1a_byte(hash, bytes[index]);
    }
}

void raw_digest_scalar_csr(uint64_t &hash, const DeviceCsrScalar &op)
{
    fnv1a_u64(hash, op.rows);
    fnv1a_u64(hash, op.nnz);
    raw_digest_vector(hash, op.row_offsets);
    raw_digest_vector(hash, op.col_indices);
    raw_digest_vector(hash, op.values);
}

uint64_t raw_operator_digest(const GpuDemagPoissonWorkspace &workspace)
{
    uint64_t hash = 14695981039346656037ull;
    fnv1a_u64(hash, workspace.rhs.rows);
    fnv1a_u64(hash, workspace.rhs.nnz);
    raw_digest_vector(hash, workspace.rhs.row_offsets);
    raw_digest_vector(hash, workspace.rhs.col_indices);
    raw_digest_vector(hash, workspace.rhs.values_x);
    raw_digest_vector(hash, workspace.rhs.values_y);
    raw_digest_vector(hash, workspace.rhs.values_z);
    raw_digest_scalar_csr(hash, workspace.recovery_x);
    raw_digest_scalar_csr(hash, workspace.recovery_y);
    raw_digest_scalar_csr(hash, workspace.recovery_z);
    raw_digest_scalar_csr(hash, workspace.visual_recovery_x);
    raw_digest_scalar_csr(hash, workspace.visual_recovery_y);
    raw_digest_scalar_csr(hash, workspace.visual_recovery_z);
    raw_digest_scalar_csr(hash, workspace.robin_boundary_mass);
    raw_digest_vector(hash, workspace.ess_tdofs);
    fnv1a_u64(hash, static_cast<uint64_t>(workspace.recovery_mode));
    fnv1a_u64(hash, static_cast<uint64_t>(workspace.visual_recovery_mode));
    fnv1a_u64(hash, workspace.recovery_xyz_pattern_digest);
    fnv1a_u64(hash, workspace.visual_recovery_xyz_pattern_digest);
    return hash;
}

// Printed only when FULLMAG_FEM_DEMAG_OPERATOR_BUILD is set or the memory
// trace is on, so default runs stay silent.
void report_operator_build_if_requested(
    const GpuDemagPoissonWorkspace &workspace,
    GpuDemagOperatorBuildPath requested_path,
    bool use_row_maps,
    bool periodic_node_class_reduction)
{
    const char *raw = std::getenv(kDemagOperatorBuildEnv);
    if ((raw == nullptr || *raw == '\0') && fem_memory_trace_level() == 0) {
        return;
    }
    std::fprintf(
        stderr,
        "[fullmag_fem] demag operator build: requested=%s path=%s periodic=%d "
        "rhs_rows=%llu rhs_nnz=%llu recovery_nnz=%llu visual_nnz=%llu robin_nnz=%llu "
        "recovery_mode=%u visual_mode=%u fingerprint=%s raw_fnv1a64=%016llx\n",
        requested_path == GpuDemagOperatorBuildPath::RowMaps ? "maps" : "csr",
        use_row_maps ? "maps" : "csr",
        periodic_node_class_reduction ? 1 : 0,
        static_cast<unsigned long long>(workspace.rhs.rows),
        static_cast<unsigned long long>(workspace.rhs.nnz),
        static_cast<unsigned long long>(workspace.recovery_x.nnz),
        static_cast<unsigned long long>(workspace.visual_recovery_x.nnz),
        static_cast<unsigned long long>(workspace.robin_boundary_mass.nnz),
        static_cast<unsigned>(workspace.recovery_mode),
        static_cast<unsigned>(workspace.visual_recovery_mode),
        workspace.operator_fingerprint.c_str(),
        static_cast<unsigned long long>(raw_operator_digest(workspace)));
    std::fflush(stderr);
}
#endif

} // namespace

bool resolve_gpu_demag_operator_build_path(
    const char *env_value,
    GpuDemagOperatorBuildPath &path,
    std::string &error)
{
    path = GpuDemagOperatorBuildPath::Csr;
    if (env_value == nullptr || *env_value == '\0' || std::strcmp(env_value, "csr") == 0) {
        return true;
    }
    if (std::strcmp(env_value, "maps") == 0) {
        path = GpuDemagOperatorBuildPath::RowMaps;
        return true;
    }
    error = std::string(kDemagOperatorBuildEnv) + " must be 'csr' or 'maps', got '" +
        env_value + "'";
    return false;
}

#if FULLMAG_HAS_MFEM_STACK
bool build_mixed_demag_operators_with_path(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    GpuDemagOperatorBuildPath requested_path,
    std::string &error)
{
    auto *potential_fes =
        static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
    auto *state_fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    if (potential_fes == nullptr || state_fes == nullptr || mesh == nullptr) {
        error = "GPU Poisson demag requires initialized MFEM mesh, P1 state FE space, and potential FE space";
        return false;
    }
    if (!validate_ctx_mfem_operator_mesh(ctx, *mesh, error)) {
        return false;
    }
    const bool periodic_node_class_reduction =
        !ctx.mesh.periodic_node_pairs.empty() ||
        ctx.poisson_demag.periodic_reduced_ready;
    const int expected_potential_order =
        static_cast<int>(ctx.poisson_demag.potential_order);
    if (expected_potential_order <= 0) {
        error = "strict FEM GPU demag requires a resolved positive potential order";
        return false;
    }
    if (state_fes->GetVSize() != state_fes->GetTrueVSize() ||
        state_fes->GetTrueVSize() != static_cast<int>(ctx.mesh.n_nodes) ||
        state_fes->GetTrueVSize() <= 0) {
        error = "strict FEM GPU demag requires unconstrained serial P1 state true DOFs to match mesh nodes";
        return false;
    }
    if (potential_fes->GetVSize() != potential_fes->GetTrueVSize() ||
        potential_fes->GetTrueVSize() <= 0) {
        error = "strict FEM GPU demag requires unconstrained serial potential true DOFs";
        return false;
    }
    if (!ctx.material_fields.Ms_element_field.empty() ||
        (ctx.material_fields.runtime &&
         ctx.material_fields.runtime->has_elementwise_ms())) {
        error = "strict FEM GPU mixed-P1 demag does not support elementwise-DG0 Ms";
        return false;
    }

    const uint64_t state_rows = static_cast<uint64_t>(state_fes->GetTrueVSize());
    const uint64_t potential_rows = static_cast<uint64_t>(potential_fes->GetTrueVSize());
    if (state_rows > static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
        potential_rows > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "strict FEM GPU demag scalar spaces exceed supported index capacity";
        return false;
    }
    if (periodic_node_class_reduction) {
        if (potential_rows != state_rows) {
            error = "strict FEM GPU periodic demag only supports P1 node-class potential reduction";
            return false;
        }
        if (ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(state_rows) ||
            ctx.mesh.periodic_reduced_node_count == 0u) {
            error = "strict FEM GPU periodic demag requires a valid P1 periodic reduced-node map";
            return false;
        }
        for (const uint32_t reduced_node : ctx.mesh.periodic_reduced_node) {
            if (reduced_node >= ctx.mesh.periodic_reduced_node_count) {
                error = "strict FEM GPU periodic demag has an out-of-range P1 reduced-node index";
                return false;
            }
        }
    }
    const uint64_t rhs_rows = periodic_node_class_reduction
        ? periodic_scalar_row_count(ctx)
        : potential_rows;
    if (rhs_rows == 0 || rhs_rows > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        error = "strict FEM GPU demag scalar RHS space is invalid";
        return false;
    }
    if (!ctx.mesh.magnetic_element_mask.empty() &&
        ctx.mesh.magnetic_element_mask.size() != static_cast<size_t>(mesh->GetNE())) {
        error = "strict FEM GPU demag magnetic-element mask size mismatch";
        return false;
    }

    // Periodic node-class merging stays on the row-map assembly (P1/P1).
    const bool use_row_maps = periodic_node_class_reduction ||
        requested_path == GpuDemagOperatorBuildPath::RowMaps;
    fem_memory_trace_stat(
        "gpu_demag:operator_assembly", "row_maps", use_row_maps ? 1u : 0u);
    demag_operator_assembly::MixedDemagAssemblyInput assembly_input;
    assembly_input.ctx = &ctx;
    assembly_input.mesh = mesh;
    assembly_input.potential_fes = potential_fes;
    assembly_input.state_fes = state_fes;
    assembly_input.periodic_node_class_reduction = periodic_node_class_reduction;
    assembly_input.expected_potential_order = expected_potential_order;
    assembly_input.state_rows = state_rows;
    assembly_input.potential_rows = potential_rows;
    assembly_input.rhs_rows = rhs_rows;
    const bool assembled = use_row_maps
        ? demag_operator_assembly::assemble_mixed_demag_operators_with_row_maps(
              assembly_input, workspace, error)
        : demag_operator_assembly::assemble_mixed_demag_operators_with_csr(
              assembly_input, workspace, error);
    if (!assembled) {
        return false;
    }
    workspace.host_arrays_released = false;
    fem_memory_trace_phase("gpu_demag:csr_filled");

    workspace.recovery_mode = shared_xyz_csr_pattern(
        workspace.recovery_x,
        workspace.recovery_y,
        workspace.recovery_z)
        ? GpuDemagRecoveryMode::SharedPatternFusedXyz
        : GpuDemagRecoveryMode::SplitCsr;
    workspace.recovery_xyz_pattern_digest = csr_pattern_digest(workspace.recovery_x);
    workspace.visual_recovery_mode = shared_xyz_csr_pattern(
        workspace.visual_recovery_x,
        workspace.visual_recovery_y,
        workspace.visual_recovery_z)
        ? GpuDemagRecoveryMode::SharedPatternFusedXyz
        : GpuDemagRecoveryMode::SplitCsr;
    workspace.visual_recovery_xyz_pattern_digest =
        csr_pattern_digest(workspace.visual_recovery_x);

    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN &&
        ctx.poisson_demag.robin_effective_beta > 0.0 &&
        ctx.poisson_demag.robin_boundary_mass != nullptr) {
        auto *bdr_mass =
            static_cast<mfem::BilinearForm *>(ctx.poisson_demag.robin_boundary_mass);
        const mfem::SparseMatrix &matrix = bdr_mass->SpMat();
        const char *label = "strict FEM GPU demag Robin boundary mass";
        if (!periodic_node_class_reduction) {
            if (!copy_sparse_matrix_to_device_csr(
                    matrix,
                    potential_rows,
                    workspace.robin_boundary_mass,
                    label,
                    error)) {
                return false;
            }
        } else if (!reduce_sparse_matrix_by_periodic_classes(
                matrix,
                ctx,
                workspace.robin_boundary_mass,
                label,
                error)) {
            return false;
        }
    }

    workspace.ess_tdofs.clear();
    workspace.ess_tdofs.reserve(ctx.poisson_demag.ess_tdof_list.size());
    for (const int tdof : ctx.poisson_demag.ess_tdof_list) {
        if (tdof >= 0 && static_cast<uint64_t>(tdof) < potential_rows) {
            workspace.ess_tdofs.push_back(
                periodic_node_class_reduction
                    ? periodic_scalar_column(ctx, static_cast<uint32_t>(tdof))
                    : static_cast<uint32_t>(tdof));
        } else {
            error = "strict FEM GPU demag has an out-of-range essential potential true DOF";
            return false;
        }
    }
    if (!build_mixed_demag_operator_fingerprint(
            ctx,
            workspace,
            periodic_node_class_reduction
                ? kPeriodicP1DemagQuadraturePolicy
                : kMixedP1ResolvedDemagQuadraturePolicy,
            workspace.operator_fingerprint,
            error)) {
        return false;
    }
    workspace.operator_build_count += 1u;
    report_operator_build_if_requested(
        workspace, requested_path, use_row_maps, periodic_node_class_reduction);
    return true;
}

bool build_mixed_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
    GpuDemagOperatorBuildPath requested_path = GpuDemagOperatorBuildPath::Csr;
    if (!resolve_gpu_demag_operator_build_path(
            std::getenv(kDemagOperatorBuildEnv), requested_path, error)) {
        return false;
    }
    return build_mixed_demag_operators_with_path(ctx, workspace, requested_path, error);
}
#else
bool build_mixed_demag_operators_with_path(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    GpuDemagOperatorBuildPath requested_path,
    std::string &error)
{
    (void)ctx;
    (void)workspace;
    (void)requested_path;
    error = "strict FEM GPU demag requires MFEM stack support";
    return false;
}

bool build_mixed_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
    (void)ctx;
    (void)workspace;
    error = "strict FEM GPU demag requires MFEM stack support";
    return false;
}
#endif

bool build_p1_demag_operators(Context &ctx, GpuDemagPoissonWorkspace &workspace, std::string &error)
{
    return build_mixed_demag_operators(ctx, workspace, error);
}

bool upload_demag_poisson_operators(
    GpuDemagPoissonWorkspace &workspace,
    uint64_t &device_bytes,
    std::string &error)
{
    if (workspace.host_arrays_released) {
        error = "GPU Poisson demag operators cannot be uploaded again after their host "
            "copies were released; rebuild the operator workspace";
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (!upload_triple(workspace.rhs, device_bytes, error) ||
        !upload_scalar(workspace.recovery_x, device_bytes, "cudaMalloc/upload demag recovery x CSR", error) ||
        !upload_scalar(workspace.recovery_y, device_bytes, "cudaMalloc/upload demag recovery y CSR", error) ||
        !upload_scalar(workspace.recovery_z, device_bytes, "cudaMalloc/upload demag recovery z CSR", error) ||
        !upload_scalar(workspace.visual_recovery_x, device_bytes, "cudaMalloc/upload demag visual recovery x CSR", error) ||
        !upload_scalar(workspace.visual_recovery_y, device_bytes, "cudaMalloc/upload demag visual recovery y CSR", error) ||
        !upload_scalar(workspace.visual_recovery_z, device_bytes, "cudaMalloc/upload demag visual recovery z CSR", error) ||
        !upload_scalar(workspace.robin_boundary_mass, device_bytes, "cudaMalloc/upload demag Robin boundary mass CSR", error) ||
        !upload_device_array(
            workspace.d_ess_tdofs,
            workspace.ess_tdofs,
            device_bytes,
            "cudaMalloc/upload demag essential tdofs",
            error)) {
        destroy_demag_poisson_operators(workspace);
        return false;
    }
    workspace.operator_upload_count += 1u;
    return true;
#else
    (void)workspace;
    (void)device_bytes;
    error = "strict FEM GPU demag operator upload requires CUDA runtime support";
    return false;
#endif
}

uint64_t release_demag_poisson_operator_host_arrays(GpuDemagPoissonWorkspace &workspace)
{
    uint64_t released_bytes = 0;
    const auto release = [&released_bytes](auto &values) {
        using Values = std::decay_t<decltype(values)>;
        released_bytes += static_cast<uint64_t>(values.capacity()) *
            sizeof(typename Values::value_type);
        Values().swap(values);
    };
    release(workspace.rhs.row_offsets);
    release(workspace.rhs.col_indices);
    release(workspace.rhs.values_x);
    release(workspace.rhs.values_y);
    release(workspace.rhs.values_z);
    for (DeviceCsrScalar *op : {&workspace.recovery_x,
                                &workspace.recovery_y,
                                &workspace.recovery_z,
                                &workspace.visual_recovery_x,
                                &workspace.visual_recovery_y,
                                &workspace.visual_recovery_z,
                                &workspace.robin_boundary_mass}) {
        release(op->row_offsets);
        release(op->col_indices);
        release(op->values);
    }
    workspace.host_arrays_released = true;
    return released_bytes;
}

void destroy_demag_poisson_operators(GpuDemagPoissonWorkspace &workspace)
{
    // The cuDSS handle is bound to the HYPRE stream; release it first.
    workspace.direct_solver.reset();
#if FULLMAG_HAS_CUDA_RUNTIME
    fullmag_cuda_demag_validation_scratch_destroy(workspace.validation_scratch);
    destroy_hypre_stream_interop(workspace.stream_interop);
    destroy_triple(workspace.rhs);
    destroy_scalar(workspace.recovery_x);
    destroy_scalar(workspace.recovery_y);
    destroy_scalar(workspace.recovery_z);
    destroy_scalar(workspace.visual_recovery_x);
    destroy_scalar(workspace.visual_recovery_y);
    destroy_scalar(workspace.visual_recovery_z);
    destroy_scalar(workspace.robin_boundary_mass);
    free_device_array(workspace.d_ess_tdofs);
#else
    (void)workspace;
#endif
    workspace.operator_fingerprint.clear();
    workspace.operator_build_count = 0;
    workspace.operator_upload_count = 0;
    workspace.recovery_xyz_pattern_digest = 0;
    workspace.recovery_mode = GpuDemagRecoveryMode::SplitCsr;
    workspace.visual_recovery_xyz_pattern_digest = 0;
    workspace.visual_recovery_mode = GpuDemagRecoveryMode::SplitCsr;
    workspace.device_bytes = 0;
    workspace.ready = false;
}

GpuDemagPoissonWorkspace *workspace_ptr(const Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    return static_cast<GpuDemagPoissonWorkspace *>(ctx.poisson_demag.gpu_workspace);
#else
    (void)ctx;
    return nullptr;
#endif
}

} // namespace fullmag::fem
