/*
 * Exchange operator source contract.
 *
 * This source owns MFEM exchange and mass bilinear-form assembly, magnetic
 * attribute selection, lumped-mass setup, and legacy sparse metadata. It does not compute H_ex, project mass, refresh runtime fields, or upload GPU state.
 */
#include "cpu/mfem/interactions/exchange_operator.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/exchange_legacy_gpu_upload.hpp"
#include "cpu/mfem/interactions/exchange_mass_projection.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

constexpr std::uint64_t kFnvOffsetBasis = 1469598103934665603ull;
constexpr std::uint64_t kFnvPrime = 1099511628211ull;

template <typename T>
void hash_bytes(std::uint64_t &state, const T *values, std::size_t count)
{
    static_assert(std::is_trivially_copyable_v<T>);
    const auto *bytes = reinterpret_cast<const unsigned char *>(values);
    for (std::size_t i = 0; i < count * sizeof(T); ++i) {
        state ^= static_cast<std::uint64_t>(bytes[i]);
        state *= kFnvPrime;
    }
}

template <typename T>
void hash_scalar(std::uint64_t &state, const T &value)
{
    hash_bytes(state, &value, 1u);
}

template <typename T>
void hash_vector(std::uint64_t &state, const std::vector<T> &values)
{
    const std::uint64_t size = static_cast<std::uint64_t>(values.size());
    hash_scalar(state, size);
    if (!values.empty()) {
        hash_bytes(state, values.data(), values.size());
    }
}

std::uint64_t hash_mesh_topology(const Context &ctx, const mfem::Mesh &mesh)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_scalar(state, ctx.mesh.n_nodes);
    hash_scalar(state, ctx.mesh.n_elements);
    hash_vector(state, ctx.mesh.cell_types);
    hash_vector(state, ctx.mesh.cell_offsets);
    hash_vector(state, ctx.mesh.cell_nodes);
    hash_vector(state, ctx.mesh.cell_global_ordinals);
    hash_vector(state, ctx.mesh.cell_markers);
    hash_scalar(state, mesh.GetNV());
    hash_scalar(state, mesh.GetNE());
    for (int element = 0; element < mesh.GetNE(); ++element) {
        hash_scalar(state, mesh.GetElementBaseGeometry(element));
        hash_scalar(state, mesh.GetAttribute(element));
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        hash_scalar(state, vertices.Size());
        for (int vertex = 0; vertex < vertices.Size(); ++vertex) {
            hash_scalar(state, vertices[vertex]);
        }
    }
    return state;
}

std::uint64_t hash_mesh_geometry(const Context &ctx, const mfem::Mesh &mesh)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_vector(state, ctx.mesh.nodes_xyz);
    hash_scalar(state, mesh.GetNV());
    hash_scalar(state, mesh.SpaceDimension());
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        hash_bytes(
            state,
            mesh.GetVertex(vertex),
            static_cast<std::size_t>(mesh.SpaceDimension()));
    }
    return state;
}

std::uint64_t hash_material_coefficients(const Context &ctx)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_scalar(state, ctx.material_fields.material.saturation_magnetisation);
    hash_scalar(state, ctx.material_fields.material.exchange_stiffness);
    hash_vector(state, ctx.material_fields.Ms_field);
    hash_vector(state, ctx.material_fields.Ms_element_field);
    hash_vector(state, ctx.material_fields.A_field);
    hash_vector(state, ctx.material_fields.A_element_field);
    return state;
}

std::uint64_t hash_boundary_data(const Context &ctx, const mfem::Mesh &mesh)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_vector(state, ctx.mesh.magnetic_element_mask);
    hash_vector(state, ctx.mesh.magnetic_node_mask);
    hash_scalar(state, mesh.GetNBE());
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        hash_scalar(state, mesh.GetBdrElementGeometry(boundary));
        hash_scalar(state, mesh.GetBdrElement(boundary)->GetAttribute());
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        hash_scalar(state, vertices.Size());
        for (int vertex = 0; vertex < vertices.Size(); ++vertex) {
            hash_scalar(state, vertices[vertex]);
        }
    }
    return state;
}

std::uint64_t hash_periodic_data(const Context &ctx)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_scalar(state, ctx.mesh.periodic_reduced_node_count);
    hash_vector(state, ctx.mesh.periodic_node_pairs);
    hash_vector(state, ctx.mesh.periodic_reduced_node);
    hash_vector(state, ctx.mesh.periodic_representative_nodes);

    std::vector<std::uint32_t> boundary_markers(
        ctx.mesh.periodic_boundary_marker_set.begin(),
        ctx.mesh.periodic_boundary_marker_set.end());
    std::sort(boundary_markers.begin(), boundary_markers.end());
    hash_vector(state, boundary_markers);
    return state;
}

OperatorDependencyKey make_exchange_operator_dependency_key(
    const Context &ctx,
    const mfem::Mesh &mesh,
    bool use_device)
{
    OperatorDependencyKey key;
    key.mesh_topology_revision = hash_mesh_topology(ctx, mesh);
    key.mesh_geometry_revision = hash_mesh_geometry(ctx, mesh);
    key.fe_order = ctx.base_plan.fe_order;
    key.material_coefficient_revision = hash_material_coefficients(ctx);
    key.boundary_revision = hash_boundary_data(ctx, mesh);
    key.periodic_revision = hash_periodic_data(ctx);
    key.device_mode = use_device ? 1u : 0u;
    key.device_index = static_cast<std::int32_t>(ctx.mfem_context.selected_device_index);
    return key;
}

class ExchangeSetupAttempt final {
public:
    explicit ExchangeSetupAttempt(Context &ctx) : ctx_(ctx) {}

    ~ExchangeSetupAttempt()
    {
        if (!committed_) {
            ++ctx_.exchange.mfem.operator_lifecycle.failed_setup_count;
        }
    }

    void commit() noexcept { committed_ = true; }

private:
    Context &ctx_;
    bool committed_ = false;
};

mfem::SparseMatrix *regularize_sparse_matrix_zero_rows(
    const mfem::SparseMatrix &matrix);

mfem::SparseMatrix *reduce_sparse_matrix_by_periodic_classes(
    const mfem::SparseMatrix &matrix,
    const Context &ctx)
{
    const int n_reduced = static_cast<int>(ctx.mesh.periodic_reduced_node_count);
    if (n_reduced <= 0 || matrix.Height() != static_cast<int>(ctx.mesh.n_nodes) ||
        matrix.Width() != static_cast<int>(ctx.mesh.n_nodes) ||
        ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(ctx.mesh.n_nodes)) {
        throw std::runtime_error("periodic exchange mass reduction has incompatible dimensions");
    }

    auto *reduced = new mfem::SparseMatrix(n_reduced, n_reduced);
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < matrix.Height(); ++row) {
        const int reduced_row = static_cast<int>(
            ctx.mesh.periodic_reduced_node[static_cast<size_t>(row)]);
        if (reduced_row < 0 || reduced_row >= n_reduced) {
            delete reduced;
            throw std::runtime_error("periodic exchange mass map contains an invalid row class");
        }
        matrix.GetRow(row, columns, values);
        for (int entry = 0; entry < columns.Size(); ++entry) {
            const int column = columns[entry];
            if (column < 0 || column >= matrix.Width()) {
                delete reduced;
                throw std::runtime_error(
                    "periodic exchange mass matrix contains an invalid column");
            }
            const int reduced_column = static_cast<int>(
                ctx.mesh.periodic_reduced_node[static_cast<size_t>(column)]);
            if (reduced_column < 0 || reduced_column >= n_reduced) {
                delete reduced;
                throw std::runtime_error(
                    "periodic exchange mass map contains an invalid column class");
            }
            reduced->Add(reduced_row, reduced_column, values[entry]);
        }
    }
    reduced->Finalize();
    auto *regularized = regularize_sparse_matrix_zero_rows(*reduced);
    delete reduced;
    return regularized;
}

mfem::SparseMatrix *regularize_sparse_matrix_zero_rows(
    const mfem::SparseMatrix &matrix)
{
    if (matrix.Height() != matrix.Width()) {
        throw std::runtime_error("exchange mass solve matrix must be square");
    }

    auto *regularized = new mfem::SparseMatrix(matrix.Height(), matrix.Width());
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < matrix.Height(); ++row) {
        matrix.GetRow(row, columns, values);
        bool has_nonzero = false;
        for (int entry = 0; entry < columns.Size(); ++entry) {
            const double value = values[entry];
            regularized->Add(row, columns[entry], value);
            has_nonzero = has_nonzero || value != 0.0;
        }
        if (!has_nonzero) {
            regularized->Add(row, row, 1.0);
        }
    }
    regularized->Finalize();
    return regularized;
}

} // namespace

bool initialize_exchange_operator_mfem(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::Coefficient &a_coeff,
    mfem::Coefficient &ms_coeff,
    std::string &error)
{
    ExchangeSetupAttempt setup_attempt(ctx);
    const bool use_device = mfem::Device::IsEnabled();
    auto exchange_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto mass_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto volume_mass_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto mass_ones = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto mass_lumped = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto inv_lumped_mass = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto exchange_tmp_vec = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto exchange_out_vec = std::make_unique<mfem::Vector>(fes.GetNDofs());
    std::unique_ptr<mfem::SparseMatrix> consistent_mass_matrix;
    std::unique_ptr<mfem::GSSmoother> consistent_mass_preconditioner;
    std::unique_ptr<mfem::CGSolver> consistent_mass_solver;
    std::unique_ptr<mfem::SparseMatrix> periodic_mass_matrix;
    std::unique_ptr<mfem::GSSmoother> periodic_mass_preconditioner;
    std::unique_ptr<mfem::CGSolver> periodic_mass_solver;
    std::unique_ptr<mfem::Vector> periodic_mass_rhs;
    std::unique_ptr<mfem::Vector> periodic_mass_solution;
    std::unique_ptr<mfem::Vector> periodic_mass_residual;
    mass_ones->UseDevice(use_device);
    mass_lumped->UseDevice(use_device);
    inv_lumped_mass->UseDevice(use_device);
    exchange_tmp_vec->UseDevice(use_device);
    exchange_out_vec->UseDevice(use_device);

    const int max_attr = mesh.attributes.Max();
    mfem::Array<int> magnetic_attr_marker(max_attr);
    magnetic_attr_marker = 0;
    for (int e = 0; e < mesh.GetNE(); ++e) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            static_cast<size_t>(e) < ctx.mesh.magnetic_element_mask.size() &&
            ctx.mesh.magnetic_element_mask[e] == 0u) {
            continue;
        }
        const int attr = mesh.GetAttribute(e);
        if (attr >= 1 && attr <= max_attr) {
            magnetic_attr_marker[attr - 1] = 1;
        }
    }

    int n_active_attrs = 0;
    for (int a = 0; a < max_attr; ++a) {
        n_active_attrs += magnetic_attr_marker[a];
    }
    if (ctx.exchange.enabled && n_active_attrs == 0) {
        error = "F-01 validation: enable_exchange=true but no MFEM "
                "attributes are marked as magnetic — exchange/mass "
                "assembly would be empty.  Check element_markers.";
        return false;
    }

    // Partial assembly is the intended end state, but MFEM 4.7 tetrahedral H1
    // can abort in `GetDofToQuad(..., DofToQuad::FULL)` before startup. Use the
    // assembled operator path so FEM can execute through device-backed SpMV.
    exchange_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    exchange_form->AddDomainIntegrator(
        new mfem::DiffusionIntegrator(a_coeff),
        magnetic_attr_marker);
    exchange_form->Assemble();
    exchange_form->Finalize();

    auto &exchange_spmat = exchange_form->SpMat();
    const int exchange_rows = exchange_spmat.Height();
    const int exchange_nnz = exchange_spmat.NumNonZeroElems();
    const int *exchange_row_offsets_raw = exchange_spmat.GetI();
    const int *exchange_columns_raw = exchange_spmat.GetJ();
    double *exchange_values_raw = exchange_spmat.GetData();
    if (exchange_rows <= 0 || exchange_nnz < 0 ||
        exchange_row_offsets_raw == nullptr || exchange_columns_raw == nullptr ||
        exchange_values_raw == nullptr) {
        error = "assembled MFEM exchange CSR is unavailable for graph canonicalization";
        return false;
    }
    std::vector<uint32_t> exchange_row_offsets(
        static_cast<std::size_t>(exchange_rows) + 1u);
    std::vector<uint32_t> exchange_columns(static_cast<std::size_t>(exchange_nnz));
    std::vector<double> exchange_values(
        exchange_values_raw, exchange_values_raw + exchange_nnz);
    for (int i = 0; i <= exchange_rows; ++i) {
        if (exchange_row_offsets_raw[i] < 0) {
            error = "assembled MFEM exchange CSR has a negative row offset";
            return false;
        }
        exchange_row_offsets[static_cast<std::size_t>(i)] =
            static_cast<uint32_t>(exchange_row_offsets_raw[i]);
    }
    for (int p = 0; p < exchange_nnz; ++p) {
        if (exchange_columns_raw[p] < 0 || exchange_columns_raw[p] >= exchange_rows) {
            error = "assembled MFEM exchange CSR has an out-of-range column";
            return false;
        }
        exchange_columns[static_cast<std::size_t>(p)] =
            static_cast<uint32_t>(exchange_columns_raw[p]);
    }
    if (!canonicalize_legacy_exchange_graph_laplacian(
            exchange_row_offsets,
            exchange_columns,
            exchange_values,
            true,
            error)) {
        return false;
    }
    std::copy(exchange_values.begin(), exchange_values.end(), exchange_values_raw);
    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = true;
    ctx.gpu_state.legacy_exchange.legacy_sparse_rows =
        static_cast<uint64_t>(std::max(0, exchange_spmat.Height()));
    ctx.gpu_state.legacy_exchange.legacy_sparse_cols =
        static_cast<uint64_t>(std::max(0, exchange_spmat.Width()));
    ctx.gpu_state.legacy_exchange.legacy_sparse_nnz =
        static_cast<uint64_t>(std::max(0, exchange_spmat.NumNonZeroElems()));

    mass_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    mass_form->AddDomainIntegrator(
        new mfem::MassIntegrator(ms_coeff),
        magnetic_attr_marker);
    mass_form->Assemble();
    mass_form->Finalize();
    volume_mass_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    volume_mass_form->AddDomainIntegrator(
        new mfem::MassIntegrator(),
        magnetic_attr_marker);
    volume_mass_form->Assemble();
    volume_mass_form->Finalize();
    prepare_exchange_mass_lumping(
        *volume_mass_form,
        *mass_ones,
        *mass_lumped,
        *inv_lumped_mass,
        ctx.integration_weights.mfem_lumped_mass,
        use_device);
    if (ctx.integration_weights.mfem_lumped_mass.size() !=
            static_cast<size_t>(fes.GetNDofs()) ||
        std::any_of(
            ctx.integration_weights.mfem_lumped_mass.begin(),
            ctx.integration_weights.mfem_lumped_mass.end(),
            [](double value) { return !std::isfinite(value) || value < 0.0; })) {
        error = "assembled MFEM magnetic volume mass row sums are invalid";
        return false;
    }
    ctx.mesh.node_volumes = ctx.integration_weights.mfem_lumped_mass;
    ctx.gpu_state.legacy_exchange.lumped_mass_ready =
        ctx.integration_weights.mfem_lumped_mass.size() == static_cast<size_t>(fes.GetNDofs());

    const bool has_nonzero_lumped_mass = std::any_of(
        ctx.integration_weights.mfem_lumped_mass.begin(),
        ctx.integration_weights.mfem_lumped_mass.end(),
        [](double value) { return value > 0.0; });
    if (!has_nonzero_lumped_mass) {
        error = "FEM validation: MFEM magnetic volume mass is zero on every "
                "node in the resolved magnetic "
                "domain.  Check element_markers and magnetic region "
                "resolution.";
        return false;
    }

    if (ctx.exchange.mfem.use_consistent_mass) {
        consistent_mass_matrix.reset(
            regularize_sparse_matrix_zero_rows(mass_form->SpMat()));
        consistent_mass_preconditioner =
            std::make_unique<mfem::GSSmoother>(*consistent_mass_matrix);
        consistent_mass_solver = std::make_unique<mfem::CGSolver>();
        consistent_mass_solver->SetRelTol(1e-10);
        consistent_mass_solver->SetAbsTol(0.0);
        consistent_mass_solver->SetMaxIter(200);
        consistent_mass_solver->SetPrintLevel(0);
        consistent_mass_solver->SetPreconditioner(*consistent_mass_preconditioner);
        consistent_mass_solver->SetOperator(*consistent_mass_matrix);

        const bool has_periodic_mass_map =
            ctx.mesh.periodic_reduced_node_count > 0 &&
            ctx.mesh.periodic_reduced_node.size() == static_cast<size_t>(ctx.mesh.n_nodes);
        if (has_periodic_mass_map) {
            periodic_mass_matrix.reset(
                reduce_sparse_matrix_by_periodic_classes(mass_form->SpMat(), ctx));
            periodic_mass_preconditioner =
                std::make_unique<mfem::GSSmoother>(*periodic_mass_matrix);
            periodic_mass_solver = std::make_unique<mfem::CGSolver>();
            periodic_mass_solver->SetRelTol(1e-10);
            periodic_mass_solver->SetAbsTol(0.0);
            periodic_mass_solver->SetMaxIter(std::max(
                200,
                static_cast<int>(ctx.mesh.periodic_reduced_node_count) * 10));
            periodic_mass_solver->SetPrintLevel(0);
            periodic_mass_solver->SetPreconditioner(*periodic_mass_preconditioner);
            periodic_mass_solver->SetOperator(*periodic_mass_matrix);
            periodic_mass_rhs = std::make_unique<mfem::Vector>(
                static_cast<int>(ctx.mesh.periodic_reduced_node_count));
            periodic_mass_solution = std::make_unique<mfem::Vector>(
                static_cast<int>(ctx.mesh.periodic_reduced_node_count));
            periodic_mass_residual = std::make_unique<mfem::Vector>(
                static_cast<int>(ctx.mesh.periodic_reduced_node_count));
            *periodic_mass_solution = 0.0;
            *periodic_mass_residual = 0.0;
        }
    }

    ctx.exchange.mfem.exchange_form = exchange_form.release();
    ctx.exchange.mfem.mass_form = mass_form.release();
    ctx.exchange.mfem.mass_ones = mass_ones.release();
    ctx.exchange.mfem.mass_lumped = mass_lumped.release();
    ctx.exchange.mfem.inv_lumped_mass = inv_lumped_mass.release();
    ctx.exchange.mfem.tmp_vec = exchange_tmp_vec.release();
    ctx.exchange.mfem.out_vec = exchange_out_vec.release();
    ctx.exchange.mfem.consistent_mass_matrix = consistent_mass_matrix.release();
    ctx.exchange.mfem.consistent_mass_preconditioner = consistent_mass_preconditioner.release();
    ctx.exchange.mfem.consistent_mass_solver = consistent_mass_solver.release();
    ctx.exchange.mfem.periodic_mass_matrix = periodic_mass_matrix.release();
    ctx.exchange.mfem.periodic_mass_preconditioner = periodic_mass_preconditioner.release();
    ctx.exchange.mfem.periodic_mass_solver = periodic_mass_solver.release();
    ctx.exchange.mfem.periodic_mass_rhs = periodic_mass_rhs.release();
    ctx.exchange.mfem.periodic_mass_solution = periodic_mass_solution.release();
    ctx.exchange.mfem.periodic_mass_residual = periodic_mass_residual.release();
    ctx.exchange.mfem.periodic_mass_setup_count =
        ctx.exchange.mfem.periodic_mass_matrix != nullptr ? 1u : 0u;
    ctx.exchange.mfem.operator_lifecycle.active_key =
        make_exchange_operator_dependency_key(ctx, mesh, use_device);
    ctx.exchange.mfem.operator_lifecycle.setup_count += 1u;
    ctx.exchange.mfem.operator_lifecycle.setup_complete = true;
    setup_attempt.commit();
    return true;
}
#endif

} // namespace fullmag::fem
