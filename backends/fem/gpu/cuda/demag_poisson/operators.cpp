/*
 * GPU CUDA Poisson demag operator workspace source contract.
 *
 * This source owns construction and device upload/destruction of the strict GPU
 * Poisson demag P1-state/resolved-potential-order RHS CSR, P1-state recovery
 * CSR, and essential potential true DOF lists. Periodic reduction remains
 * P1/P1. It does not own Hypre solver policy, lifecycle publication,
 * RK-stage orchestration, local interaction kernels, or C ABI entrypoints.
 */

#include "gpu/cuda/demag_poisson/operators.hpp"

#include "context.hpp"
#include "core/fem_material_runtime.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <map>
#include <sstream>
#include <string>
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

int signed_dof_index(int dof)
{
    return dof >= 0 ? dof : -1 - dof;
}

double signed_dof_sign(int dof)
{
    return dof >= 0 ? 1.0 : -1.0;
}

double scalar_ms_value(const Context &ctx, uint32_t node)
{
    return scalar_field_value(
        ctx.material_fields.Ms_field,
        static_cast<size_t>(node),
        ctx.material_fields.material.saturation_magnetisation);
}

#if FULLMAG_HAS_MFEM_STACK
uint64_t periodic_scalar_row_count(const Context &ctx)
{
    return ctx.mesh.periodic_reduced_node.empty()
        ? ctx.mesh.n_nodes
        : ctx.mesh.periodic_reduced_node_count;
}

uint32_t periodic_scalar_column(const Context &ctx, uint32_t node)
{
    if (ctx.mesh.periodic_reduced_node.empty()) {
        return node;
    }
    return ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
}

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
    uint32_t maximum_canonical_marker = 0u;
    bool has_canonical_air = ctx.mesh.cell_markers.empty();
    for (const uint32_t marker : ctx.mesh.cell_markers) {
        maximum_canonical_marker = std::max(maximum_canonical_marker, marker);
        has_canonical_air = has_canonical_air || marker == 0u;
    }
    if (has_canonical_air &&
        maximum_canonical_marker >=
            static_cast<uint32_t>(std::numeric_limits<int>::max())) {
        error = "strict FEM GPU demag ctx/MFEM cannot map canonical air marker";
        return false;
    }
    const uint32_t mfem_air_attribute = has_canonical_air
        ? maximum_canonical_marker + 1u
        : 1u;

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
        const uint32_t expected_mfem_attribute = canonical_marker == 0u
            ? mfem_air_attribute
            : canonical_marker;
        if (expected_mfem_attribute !=
            static_cast<uint32_t>(mesh.GetAttribute(element))) {
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
    fnv1a_integral_vector(hash, workspace.ess_tdofs);

    std::ostringstream encoded;
    encoded << "fnv1a64:" << std::hex << std::setfill('0') << std::setw(16) << hash;
    fingerprint = encoded.str();
    return true;
}
#endif

} // namespace

#if FULLMAG_HAS_MFEM_STACK
bool build_mixed_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
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
    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        error = "strict FEM GPU demag does not support Fredkin-Koehler FEM/BEM demag";
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

    workspace.rhs.rows = rhs_rows;
    workspace.recovery_x.rows = state_rows;
    workspace.recovery_y.rows = state_rows;
    workspace.recovery_z.rows = state_rows;
    workspace.rhs.row_offsets.assign(static_cast<size_t>(rhs_rows) + 1u, 0u);
    workspace.recovery_x.row_offsets.assign(static_cast<size_t>(state_rows) + 1u, 0u);
    workspace.recovery_y.row_offsets.assign(static_cast<size_t>(state_rows) + 1u, 0u);
    workspace.recovery_z.row_offsets.assign(static_cast<size_t>(state_rows) + 1u, 0u);

    using Triple = std::array<double, 3>;
    std::vector<std::map<uint32_t, Triple>> rhs_entries(static_cast<size_t>(rhs_rows));
    std::vector<std::map<uint32_t, double>> rec_x(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> rec_y(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> rec_z(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> visual_x(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> visual_y(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> visual_z(static_cast<size_t>(state_rows));
    std::vector<double> recovery_weight(static_cast<size_t>(state_rows), 0.0);
    std::vector<double> visual_weight(static_cast<size_t>(state_rows), 0.0);
    std::vector<bool> magnetic_state_node(static_cast<size_t>(state_rows), false);

    auto add_finite = [&](double &accumulator, double contribution, const char *label) {
        if (!std::isfinite(contribution)) {
            error = std::string("strict FEM GPU demag found a non-finite ") + label;
            return false;
        }
        accumulator += contribution;
        if (!std::isfinite(accumulator)) {
            error = std::string("strict FEM GPU demag accumulated a non-finite ") + label;
            return false;
        }
        return true;
    };

    mfem::Array<int> potential_dofs;
    mfem::Array<int> state_dofs;
    mfem::DenseMatrix potential_dshape;
    mfem::Vector state_shape;
    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        const mfem::FiniteElement *potential_fe = potential_fes->GetFE(elem);
        const mfem::FiniteElement *state_fe = state_fes->GetFE(elem);
        if (potential_fe == nullptr || potential_fe->GetOrder() != expected_potential_order) {
            error = periodic_node_class_reduction
                ? "strict FEM GPU periodic demag found a non-P1 element in the potential FE space"
                : "strict FEM GPU nonperiodic demag found an element whose order differs from the resolved potential order";
            return false;
        }
        if (state_fe == nullptr || state_fe->GetOrder() != 1) {
            error = "strict FEM GPU demag requires P1 state elements";
            return false;
        }
        potential_fes->GetElementDofs(elem, potential_dofs);
        state_fes->GetElementDofs(elem, state_dofs);
        const int potential_ndof = potential_dofs.Size();
        const int state_ndof = state_dofs.Size();
        if (potential_ndof <= 0 || state_ndof <= 0) {
            error = "strict FEM GPU demag found an element without scalar DOFs";
            return false;
        }

        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        if (T == nullptr) {
            error = "strict FEM GPU demag found a null element transformation";
            return false;
        }
        std::vector<uint32_t> potential_true_dofs(static_cast<size_t>(potential_ndof));
        std::vector<double> potential_signs(static_cast<size_t>(potential_ndof));
        for (int i = 0; i < potential_ndof; ++i) {
            const int gdof = signed_dof_index(potential_dofs[i]);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= potential_rows) {
                error = "strict FEM GPU demag found an out-of-range potential DOF";
                return false;
            }
            potential_true_dofs[static_cast<size_t>(i)] = static_cast<uint32_t>(gdof);
            potential_signs[static_cast<size_t>(i)] = signed_dof_sign(potential_dofs[i]);
        }
        std::vector<uint32_t> state_nodes(static_cast<size_t>(state_ndof));
        std::vector<double> state_signs(static_cast<size_t>(state_ndof));
        for (int i = 0; i < state_ndof; ++i) {
            const int gdof = signed_dof_index(state_dofs[i]);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= state_rows) {
                error = "strict FEM GPU demag found an out-of-range P1 state DOF";
                return false;
            }
            state_nodes[static_cast<size_t>(i)] = static_cast<uint32_t>(gdof);
            state_signs[static_cast<size_t>(i)] = signed_dof_sign(state_dofs[i]);
        }

        const bool magnetic_element = ctx.mesh.magnetic_element_mask.empty() ||
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] != 0u;
        const mfem::IntegrationRule &ir =
            // Match MFEM's DomainLFGradIntegrator default exactly.  Its
            // implementation requests IntRules(geom, 2 * test_order);
            // using a higher order here changes the non-affine pyramid
            // quadrature result and breaks CPU/GPU operator parity.
            mfem::IntRules.Get(
                potential_fe->GetGeomType(),
                2 * potential_fe->GetOrder());
        state_shape.SetSize(state_ndof);
        potential_dshape.SetSize(potential_ndof, 3);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double jacobian_weight = T->Weight();
            if (!std::isfinite(jacobian_weight) || jacobian_weight <= 0.0) {
                error = "strict FEM GPU demag found a non-positive element Jacobian weight";
                return false;
            }
            const double w = ip.weight * jacobian_weight;
            if (!std::isfinite(w)) {
                error = "strict FEM GPU demag found a non-finite resolved-order quadrature weight";
                return false;
            }
            state_fe->CalcShape(ip, state_shape);
            potential_fe->CalcPhysDShape(*T, potential_dshape);

            double ms = ctx.material_fields.material.saturation_magnetisation;
            if (!ctx.material_fields.Ms_field.empty()) {
                ms = 0.0;
                for (int k = 0; k < state_ndof; ++k) {
                    ms += state_shape(k) * scalar_ms_value(
                        ctx, state_nodes[static_cast<size_t>(k)]);
                }
            }

            for (int i = 0; i < state_ndof; ++i) {
                const uint32_t node_i = state_nodes[static_cast<size_t>(i)];
                const double projection_weight = state_shape(i) * w;
                if (!add_finite(
                        visual_weight[static_cast<size_t>(node_i)],
                        projection_weight,
                        "visual recovery weight")) {
                    return false;
                }
                if (magnetic_element) {
                    magnetic_state_node[static_cast<size_t>(node_i)] = true;
                    if (!add_finite(
                            recovery_weight[static_cast<size_t>(node_i)],
                            projection_weight,
                            "magnetic recovery weight")) {
                        return false;
                    }
                }
            }

            if (magnetic_element) {
                for (int i = 0; i < potential_ndof; ++i) {
                    const uint32_t potential_dof = potential_true_dofs[static_cast<size_t>(i)];
                    const uint32_t row = periodic_node_class_reduction
                        ? periodic_scalar_column(ctx, potential_dof)
                        : potential_dof;
                    for (int k = 0; k < state_ndof; ++k) {
                        Triple &entry = rhs_entries[static_cast<size_t>(row)]
                            [state_nodes[static_cast<size_t>(k)]];
                        const double coeff = potential_signs[static_cast<size_t>(i)] *
                            state_signs[static_cast<size_t>(k)] * ms * state_shape(k) * w;
                        if (!add_finite(
                                entry[0],
                                coeff * potential_dshape(i, 0),
                                "RHS x value") ||
                            !add_finite(
                                entry[1],
                                coeff * potential_dshape(i, 1),
                                "RHS y value") ||
                            !add_finite(
                                entry[2],
                                coeff * potential_dshape(i, 2),
                                "RHS z value")) {
                            return false;
                        }
                    }
                }
            }
            for (int i = 0; i < state_ndof; ++i) {
                const uint32_t row = state_nodes[static_cast<size_t>(i)];
                const double projection_weight = state_shape(i) * w;
                for (int k = 0; k < potential_ndof; ++k) {
                    const uint32_t scalar_col = periodic_node_class_reduction
                        ? periodic_scalar_column(ctx, potential_true_dofs[static_cast<size_t>(k)])
                        : potential_true_dofs[static_cast<size_t>(k)];
                    const double signed_weight = projection_weight *
                        potential_signs[static_cast<size_t>(k)];
                    if (!add_finite(
                            visual_x[static_cast<size_t>(row)][scalar_col],
                            -signed_weight * potential_dshape(k, 0),
                            "visual recovery x value") ||
                        !add_finite(
                            visual_y[static_cast<size_t>(row)][scalar_col],
                            -signed_weight * potential_dshape(k, 1),
                            "visual recovery y value") ||
                        !add_finite(
                            visual_z[static_cast<size_t>(row)][scalar_col],
                            -signed_weight * potential_dshape(k, 2),
                            "visual recovery z value")) {
                        return false;
                    }
                    if (magnetic_element) {
                        if (!add_finite(
                                rec_x[static_cast<size_t>(row)][scalar_col],
                                -signed_weight * potential_dshape(k, 0),
                                "magnetic recovery x value") ||
                            !add_finite(
                                rec_y[static_cast<size_t>(row)][scalar_col],
                                -signed_weight * potential_dshape(k, 1),
                                "magnetic recovery y value") ||
                            !add_finite(
                                rec_z[static_cast<size_t>(row)][scalar_col],
                                -signed_weight * potential_dshape(k, 2),
                                "magnetic recovery z value")) {
                            return false;
                        }
                    }
                }
            }
        }
    }

    for (size_t node = 0; node < visual_weight.size(); ++node) {
        if (!std::isfinite(visual_weight[node]) || visual_weight[node] <= 0.0) {
            error = "strict FEM GPU demag requires finite positive visual recovery weight for every P1 state node";
            return false;
        }
        if (magnetic_state_node[node] &&
            (!std::isfinite(recovery_weight[node]) || recovery_weight[node] <= 0.0)) {
            error = "strict FEM GPU demag requires finite positive magnetic recovery weight for every magnetic P1 state node";
            return false;
        }
    }

    auto normalize_recovery = [&](std::vector<std::map<uint32_t, double>> &values,
                                  const std::vector<double> &weights,
                                  const char *label) {
        for (size_t row = 0; row < values.size(); ++row) {
            if (!std::isfinite(weights[row])) {
                error = std::string("strict FEM GPU demag found a non-finite ") + label + " weight";
                return false;
            }
            if (weights[row] <= 0.0) {
                values[row].clear();
                continue;
            }
            for (auto &[column, value] : values[row]) {
                (void)column;
                value /= weights[row];
                if (!std::isfinite(value)) {
                    error = std::string("strict FEM GPU demag found a non-finite normalized ") + label;
                    return false;
                }
            }
        }
        return true;
    };
    if (!normalize_recovery(rec_x, recovery_weight, "magnetic recovery x value") ||
        !normalize_recovery(rec_y, recovery_weight, "magnetic recovery y value") ||
        !normalize_recovery(rec_z, recovery_weight, "magnetic recovery z value") ||
        !normalize_recovery(visual_x, visual_weight, "visual recovery x value") ||
        !normalize_recovery(visual_y, visual_weight, "visual recovery y value") ||
        !normalize_recovery(visual_z, visual_weight, "visual recovery z value")) {
        return false;
    }

    uint64_t rhs_nnz = 0;
    uint64_t rec_nnz = 0;
    for (uint64_t row = 0; row < rhs_rows; ++row) {
        rhs_nnz += rhs_entries[static_cast<size_t>(row)].size();
        if (rhs_nnz > std::numeric_limits<uint32_t>::max()) {
            error = "strict FEM GPU demag CSR operator exceeds 32-bit index capacity";
            return false;
        }
        workspace.rhs.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rhs_nnz);
    }
    for (uint64_t row = 0; row < state_rows; ++row) {
        rec_nnz += rec_x[static_cast<size_t>(row)].size();
        if (rec_nnz > std::numeric_limits<uint32_t>::max()) {
            error = "strict FEM GPU demag recovery CSR operator exceeds 32-bit index capacity";
            return false;
        }
        workspace.recovery_x.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
        workspace.recovery_y.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
        workspace.recovery_z.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
    }
    workspace.rhs.nnz = rhs_nnz;
    workspace.recovery_x.nnz = rec_nnz;
    workspace.recovery_y.nnz = rec_nnz;
    workspace.recovery_z.nnz = rec_nnz;
    workspace.visual_recovery_x.rows = state_rows;
    workspace.visual_recovery_y.rows = state_rows;
    workspace.visual_recovery_z.rows = state_rows;

    workspace.rhs.col_indices.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_x.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_y.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_z.reserve(static_cast<size_t>(rhs_nnz));
    for (uint64_t row = 0; row < rhs_rows; ++row) {
        for (const auto &entry : rhs_entries[static_cast<size_t>(row)]) {
            workspace.rhs.col_indices.push_back(entry.first);
            workspace.rhs.values_x.push_back(entry.second[0]);
            workspace.rhs.values_y.push_back(entry.second[1]);
            workspace.rhs.values_z.push_back(entry.second[2]);
        }
    }

    auto fill_recovery = [&](const std::vector<std::map<uint32_t, double>> &rows_in,
                             DeviceCsrScalar &op,
                             const char *label) {
        op.col_indices.reserve(static_cast<size_t>(op.nnz));
        op.values.reserve(static_cast<size_t>(op.nnz));
        op.row_offsets.assign(rows_in.size() + 1u, 0u);
        uint64_t nnz = 0;
        for (size_t row = 0; row < rows_in.size(); ++row) {
            nnz += rows_in[row].size();
            if (nnz > std::numeric_limits<uint32_t>::max()) {
                error = std::string(label) + " exceeds 32-bit CSR capacity";
                return false;
            }
            op.row_offsets[row + 1u] = static_cast<uint32_t>(nnz);
        }
        op.nnz = nnz;
        for (const auto &row_entries : rows_in) {
            for (const auto &entry : row_entries) {
                op.col_indices.push_back(entry.first);
                op.values.push_back(entry.second);
            }
        }
        return true;
    };
    if (!fill_recovery(rec_x, workspace.recovery_x, "demag recovery x") ||
        !fill_recovery(rec_y, workspace.recovery_y, "demag recovery y") ||
        !fill_recovery(rec_z, workspace.recovery_z, "demag recovery z") ||
        !fill_recovery(visual_x, workspace.visual_recovery_x, "demag visual recovery x") ||
        !fill_recovery(visual_y, workspace.visual_recovery_y, "demag visual recovery y") ||
        !fill_recovery(visual_z, workspace.visual_recovery_z, "demag visual recovery z")) {
        return false;
    }

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
    return true;
}
#else
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

void destroy_demag_poisson_operators(GpuDemagPoissonWorkspace &workspace)
{
#if FULLMAG_HAS_CUDA_RUNTIME
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
