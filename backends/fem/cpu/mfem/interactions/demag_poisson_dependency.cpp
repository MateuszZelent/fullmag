/*
 * Poisson demag dependency source contract.
 *
 * This source owns the content key and readiness guard for the CPU
 * Poisson/Airbox operator. It does not assemble the operator, solve Poisson,
 * recover H_demag, compute energy, or own frozen-field policy.
 */

#include "cpu/mfem/interactions/demag_poisson_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cstddef>
#include <cstdint>
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
    for (std::size_t index = 0; index < count * sizeof(T); ++index) {
        state ^= static_cast<std::uint64_t>(bytes[index]);
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
    hash_scalar(state, ctx.mesh.n_boundary_faces);
    hash_vector(state, ctx.mesh.cell_types);
    hash_vector(state, ctx.mesh.cell_offsets);
    hash_vector(state, ctx.mesh.cell_nodes);
    hash_vector(state, ctx.mesh.cell_global_ordinals);
    hash_vector(state, ctx.mesh.cell_markers);
    hash_vector(state, ctx.mesh.facet_types);
    hash_vector(state, ctx.mesh.facet_roles);
    hash_vector(state, ctx.mesh.facet_offsets);
    hash_vector(state, ctx.mesh.facet_nodes);
    hash_vector(state, ctx.mesh.facet_global_ordinals);
    hash_vector(state, ctx.mesh.facet_markers);

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

std::uint64_t hash_material_membership(const Context &ctx)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_vector(state, ctx.mesh.magnetic_element_mask);
    hash_vector(state, ctx.mesh.magnetic_node_mask);
    hash_scalar(state, ctx.material_fields.material.saturation_magnetisation);
    hash_vector(state, ctx.material_fields.Ms_field);
    hash_vector(state, ctx.material_fields.Ms_element_field);
    return state;
}

std::uint64_t hash_boundary_data(const Context &ctx, const mfem::Mesh &mesh)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_scalar(state, ctx.poisson_demag.boundary_marker);
    hash_scalar(state, ctx.poisson_demag.robin_beta_mode);
    hash_scalar(state, ctx.poisson_demag.robin_beta_factor);
    hash_scalar(state, ctx.poisson_demag.robin_effective_beta);
    hash_vector(state, ctx.mesh.facet_markers);
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

std::uint64_t hash_realization_data(const Context &ctx)
{
    std::uint64_t state = kFnvOffsetBasis;
    hash_scalar(state, ctx.demag.enabled);
    hash_scalar(state, ctx.demag.realization);
    hash_scalar(state, ctx.poisson_demag.potential_order);
    hash_scalar(state, ctx.poisson_demag.gpu_demag_mode);
    return state;
}

std::uint64_t hash_solver_policy(const Context &ctx)
{
    std::uint64_t state = kFnvOffsetBasis;
    const auto &solver = ctx.demag.solver;
    hash_scalar(state, solver.solver);
    hash_scalar(state, solver.preconditioner);
    hash_scalar(state, solver.relative_tolerance);
    hash_scalar(state, solver.has_absolute_tolerance);
    hash_scalar(state, solver.absolute_tolerance);
    hash_scalar(state, solver.max_iterations);
    hash_scalar(state, solver.print_level);

    const auto &amg = ctx.demag.amg_policy;
    hash_scalar(state, amg.relax_type);
    hash_scalar(state, amg.coarsening);
    hash_scalar(state, amg.interpolation);
    hash_scalar(state, amg.aggressive_coarsening);
    hash_scalar(state, amg.strength_threshold);
    hash_scalar(state, amg.strength_threshold_is_set);
    hash_scalar(state, amg.max_levels);
    hash_scalar(state, amg.max_levels_is_set);
    return state;
}

PoissonOperatorDependencyKey make_poisson_operator_dependency_key_impl(
    const Context &ctx,
    const mfem::Mesh &mesh,
    bool use_device)
{
    PoissonOperatorDependencyKey key;
    key.mesh_topology_revision = hash_mesh_topology(ctx, mesh);
    key.mesh_geometry_revision = hash_mesh_geometry(ctx, mesh);
    key.potential_order = static_cast<std::uint32_t>(
        std::max(0, ctx.poisson_demag.potential_order));
    key.material_membership_revision = hash_material_membership(ctx);
    key.boundary_revision = hash_boundary_data(ctx, mesh);
    key.periodic_revision = hash_periodic_data(ctx);
    key.realization_revision = hash_realization_data(ctx);
    key.solver_policy_revision = hash_solver_policy(ctx);
    key.device_mode = use_device ? 1u : 0u;
    key.device_index = static_cast<std::int32_t>(ctx.mfem_context.selected_device_index);
    return key;
}

} // namespace

PoissonOperatorDependencyKey make_poisson_operator_dependency_key(
    const Context &ctx,
    const mfem::Mesh &mesh,
    bool use_device)
{
    return make_poisson_operator_dependency_key_impl(ctx, mesh, use_device);
}

bool demag_poisson_operator_dependencies_current(
    Context &ctx,
    std::string &error)
{
    const bool is_airbox =
        ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET ||
        ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    if (!is_airbox) {
        return true;
    }
    if (!ctx.poisson_demag.ready) {
        if (ctx.poisson_demag.operator_lifecycle.setup_count == 0u) {
            return true;
        }
        error =
            "Poisson demag operator is unavailable after dependency invalidation; "
            "setup must be rebuilt before apply";
        return false;
    }
    if (!ctx.poisson_demag.operator_lifecycle.setup_complete) {
        error = "Poisson demag operator lifecycle is incomplete; setup must be rebuilt";
        return false;
    }
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    if (mesh == nullptr) {
        error = "Poisson demag dependency check requires an MFEM mesh";
        return false;
    }

    const auto current_key = make_poisson_operator_dependency_key(
        ctx, *mesh, mfem::Device::IsEnabled());
    if (current_key == ctx.poisson_demag.operator_lifecycle.active_key) {
        return true;
    }

    ++ctx.poisson_demag.operator_lifecycle.invalidation_count;
    ctx.poisson_demag.operator_lifecycle.setup_complete = false;
    ctx.poisson_demag.ready = false;
    ctx.demag.cache_valid = false;
    ctx.demag.cached_xyz.clear();
    ctx.demag.cached_visual_xyz.clear();
    destroy_demag_poisson_hypre_workspace(ctx);
    destroy_demag_periodic_poisson_reduction(ctx);
    error =
        "Poisson demag operator dependencies changed; setup must be rebuilt "
        "before apply";
    return false;
}

#else

PoissonOperatorDependencyKey make_poisson_operator_dependency_key(
    const Context &ctx,
    const mfem::Mesh &mesh,
    bool use_device)
{
    (void)ctx;
    (void)mesh;
    (void)use_device;
    return {};
}

bool demag_poisson_operator_dependencies_current(
    Context &ctx,
    std::string &error)
{
    (void)ctx;
    error.clear();
    return true;
}

#endif

} // namespace fullmag::fem
