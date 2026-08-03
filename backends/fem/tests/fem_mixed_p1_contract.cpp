/*
 * fem_mixed_p1_contract.cpp - direct MFEM mixed-topology mesh contract.
 */

#include "core/fem_mesh.hpp"
#include "core/fem_material_fields.hpp"
#include "core/fem_material_runtime.hpp"
#include "core/fem_field_buffers.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"
#include "cpu/mfem/interactions/zeeman_uniform_field.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/backend_lifecycle.hpp"
#include "cpu/mfem/runtime/backend_step.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"
#include "gpu/cuda/relaxation/direct_energy_increment.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <mfem.hpp>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <numeric>
#include <sstream>
#include <string>
#include <vector>

namespace {

using fullmag::fem::FemMeshRuntimeState;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

FemMeshRuntimeState make_mesh(
    std::vector<double> nodes,
    std::vector<uint32_t> cell_types,
    std::vector<uint32_t> cell_offsets,
    std::vector<uint32_t> cell_nodes,
    std::vector<uint32_t> cell_markers)
{
    FemMeshRuntimeState source{};
    source.n_nodes = static_cast<uint32_t>(nodes.size() / 3u);
    source.n_elements = static_cast<uint32_t>(cell_types.size());
    source.nodes_xyz = std::move(nodes);
    source.cell_types = std::move(cell_types);
    source.cell_offsets = std::move(cell_offsets);
    source.cell_nodes = std::move(cell_nodes);
    source.cell_markers = std::move(cell_markers);
    return source;
}

std::unique_ptr<mfem::Mesh> build(const FemMeshRuntimeState &source)
{
    std::unique_ptr<mfem::Mesh> mesh;
    std::string error;
    check(fullmag::fem::build_mfem_mesh(source, mesh, error), error.c_str());
    check(mesh != nullptr, "successful mixed MFEM build must return a mesh");
    return mesh;
}

bool close_volume(double actual, double expected)
{
    const double scale = std::max(std::abs(actual), std::abs(expected));
    return std::abs(actual - expected) <=
        256.0 * std::numeric_limits<double>::epsilon() * scale;
}

bool component_pointers_are_null(const fullmag::fem::FemGpuComponentField &field)
{
    return field.x == nullptr && field.y == nullptr && field.z == nullptr;
}

bool all_gpu_state_owned_pointers_are_null(const fullmag::fem::FemGpuState &gpu)
{
    if (!component_pointers_are_null(gpu.magnetization.m) ||
        !component_pointers_are_null(gpu.demag_poisson.poisson_gradient) ||
        !component_pointers_are_null(gpu.local_interactions.vector) ||
        !component_pointers_are_null(gpu.relaxation.projected_gradient_accepted_h_eff) ||
        !component_pointers_are_null(gpu.relaxation.nonlinear_cg_direction) ||
        !component_pointers_are_null(gpu.relaxation.nonlinear_cg_direction_backup)) {
        return false;
    }
    for (const auto *field : {
             &gpu.fields.h_ex, &gpu.fields.h_demag, &gpu.fields.h_ext,
             &gpu.fields.h_drive, &gpu.fields.h_ani, &gpu.fields.h_cubic_ani,
             &gpu.fields.h_dmi, &gpu.fields.h_bulk_dmi, &gpu.fields.h_oe_basis_per_ampere,
             &gpu.fields.h_oe, &gpu.fields.h_therm, &gpu.fields.h_mel,
             &gpu.fields.h_eff, &gpu.fields.regional_drive_basis,
             &gpu.rk.m_backup, &gpu.rk.m_stage, &gpu.rk.error,
             &gpu.rk.transaction_m, &gpu.rk.transaction_k0,
             &gpu.rk.transaction_h_ex, &gpu.rk.transaction_h_demag,
             &gpu.rk.transaction_h_drive, &gpu.rk.transaction_h_ani,
             &gpu.rk.transaction_h_cubic_ani, &gpu.rk.transaction_h_dmi,
             &gpu.rk.transaction_h_bulk_dmi, &gpu.rk.transaction_h_oe,
             &gpu.rk.transaction_h_therm, &gpu.rk.transaction_h_mel,
             &gpu.rk.transaction_h_eff,
         }) {
        if (!component_pointers_are_null(*field)) {
            return false;
        }
    }
    for (const auto &stage : gpu.rk.k) {
        if (!component_pointers_are_null(stage)) {
            return false;
        }
    }
    return gpu.demag_poisson.poisson_rhs == nullptr &&
        gpu.demag_poisson.poisson_solution == nullptr &&
        gpu.demag_poisson.poisson_solution_full == nullptr &&
        gpu.legacy_exchange.csr_row_offsets == nullptr &&
        gpu.legacy_exchange.csr_col_indices == nullptr &&
        gpu.legacy_exchange.csr_values == nullptr &&
        gpu.fields.regional_drive_descs == nullptr &&
        gpu.fields.regional_drive_point_times == nullptr &&
        gpu.fields.regional_drive_point_values == nullptr &&
        gpu.rk.transaction_poisson_solution == nullptr &&
        gpu.rk.transaction_poisson_solution_full == nullptr &&
        gpu.local_interactions.node_weight == nullptr &&
        gpu.magnetoelastic.strain_voigt == nullptr &&
        gpu.materials.ms == nullptr && gpu.materials.a == nullptr &&
        gpu.materials.alpha == nullptr && gpu.materials.ku == nullptr &&
        gpu.materials.ku2 == nullptr && gpu.materials.anisotropy_axis_x == nullptr &&
        gpu.materials.anisotropy_axis_y == nullptr &&
        gpu.materials.anisotropy_axis_z == nullptr && gpu.materials.dind == nullptr &&
        gpu.materials.dbulk == nullptr && gpu.materials.kc1 == nullptr &&
        gpu.materials.kc2 == nullptr && gpu.materials.kc3 == nullptr &&
        gpu.mesh_geometry.nodes_xyz == nullptr && gpu.mesh_geometry.elements == nullptr &&
        gpu.mesh_geometry.magnetic_element_mask == nullptr &&
        gpu.mesh_metrics.node_volumes == nullptr && gpu.mesh_metrics.lumped_mass == nullptr &&
        gpu.mesh_metrics.inv_lumped_mass == nullptr &&
        gpu.mesh_regions.magnetic_node_mask == nullptr &&
        gpu.mesh_regions.periodic_reduced_node == nullptr &&
        gpu.mesh_regions.periodic_representative_nodes == nullptr &&
        gpu.reductions.scalar_workspace == nullptr && gpu.reductions.scalar_result == nullptr &&
        gpu.reductions.host_scalar_result == nullptr && gpu.reductions.temp_storage == nullptr;
}

void expect_reject(const FemMeshRuntimeState &source, const char *needle)
{
    std::unique_ptr<mfem::Mesh> mesh;
    std::string error;
    check(!fullmag::fem::build_mfem_mesh(source, mesh, error),
          "malformed mixed MFEM mesh must be rejected");
    check(mesh == nullptr, "rejected mixed MFEM build must not publish a mesh");
    check(error.find(needle) != std::string::npos, error.c_str());
}

void check_identity_vertices(mfem::Mesh &mesh, int element, const std::vector<int> &expected)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    check(vertices.Size() == static_cast<int>(expected.size()),
          "MFEM element arity must match canonical arity");
    for (int i = 0; i < vertices.Size(); ++i) {
        check(vertices[i] == expected[static_cast<size_t>(i)],
              "Fullmag-to-MFEM vertex permutation must be the audited identity table");
    }
}

std::vector<int> sorted_vertices(mfem::Array<int> vertices)
{
    std::vector<int> result(vertices.begin(), vertices.end());
    std::sort(result.begin(), result.end());
    return result;
}

void check_mfem_face_table(
    mfem::Mesh &mesh,
    int element,
    uint32_t type,
    const std::vector<uint32_t> &connectivity,
    bool require_boundary_order = true,
    bool require_nonzero_orientation = false)
{
    fullmag::fem::ElementTopology topology{};
    check(fullmag::fem::element_topology(type, topology),
          "canonical element topology must exist for every native family");
    mfem::Array<int> face_ids;
    mfem::Array<int> face_orientations;
    mesh.GetElementFaces(element, face_ids, face_orientations);
    check(face_ids.Size() == topology.faces.entity_count,
          "MFEM local face count must match canonical element_topology");
    check(face_orientations.Size() == face_ids.Size(),
          "MFEM must report one element-relative orientation per local face");
    bool saw_nonzero_orientation = false;
    for (int face = 0; face < face_ids.Size(); ++face) {
        const uint8_t start = topology.faces.offsets[face];
        const uint8_t end = topology.faces.offsets[face + 1];
        std::vector<int> expected;
        for (uint8_t node = start; node < end; ++node) {
            expected.push_back(static_cast<int>(connectivity[topology.faces.nodes[node]]));
        }
        mfem::Array<int> actual;
        mesh.GetFaceVertices(face_ids[face], actual);
        check(actual.Size() == static_cast<int>(end - start),
              "MFEM local face arity must match canonical face geometry");
        auto expected_set = expected;
        std::sort(expected_set.begin(), expected_set.end());
        check(sorted_vertices(actual) == expected_set,
              "MFEM local face ordinal must identify the corresponding canonical face");
        check(mesh.GetFaceGeometry(face_ids[face]) ==
                  ((end - start) == 3 ? mfem::Geometry::TRIANGLE : mfem::Geometry::SQUARE),
              "MFEM face geometry must agree with canonical local face arity");
        std::vector<int> reconstructed;
        const int orientation = face_orientations[face];
        saw_nonzero_orientation = saw_nonzero_orientation || orientation != 0;
        if ((end - start) == 3) {
            check(orientation >= 0 && orientation < 6,
                  "MFEM triangle face orientation must index the triangle orientation table");
            const int inverse =
                mfem::Geometry::Constants<mfem::Geometry::TRIANGLE>::InvOrient[orientation];
            const int *permutation =
                mfem::Geometry::Constants<mfem::Geometry::TRIANGLE>::Orient[inverse];
            for (int node = 0; node < 3; ++node) {
                reconstructed.push_back(actual[permutation[node]]);
            }
        } else {
            check(orientation >= 0 && orientation < 8,
                  "MFEM quadrilateral face orientation must index the square orientation table");
            const int inverse =
                mfem::Geometry::Constants<mfem::Geometry::SQUARE>::InvOrient[orientation];
            const int *permutation =
                mfem::Geometry::Constants<mfem::Geometry::SQUARE>::Orient[inverse];
            for (int node = 0; node < 4; ++node) {
                reconstructed.push_back(actual[permutation[node]]);
            }
        }
        if (reconstructed != expected) {
            std::fprintf(stderr,
                         "orientation mismatch: type=%u element=%d face=%d orientation=%d expected=",
                         type, element, face, orientation);
            for (int vertex : expected) std::fprintf(stderr, "%d,", vertex);
            std::fprintf(stderr, " actual=");
            for (int vertex : actual) std::fprintf(stderr, "%d,", vertex);
            std::fprintf(stderr, " reconstructed=");
            for (int vertex : reconstructed) std::fprintf(stderr, "%d,", vertex);
            std::fprintf(stderr, "\n");
        }
        check(reconstructed == expected,
              "MFEM face orientation must reconstruct canonical element-local face order");

        if (!require_boundary_order) continue;
        bool found_boundary = false;
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            mfem::Array<int> boundary_vertices;
            mesh.GetBdrElementVertices(boundary, boundary_vertices);
            if (sorted_vertices(boundary_vertices) != expected_set) continue;
            found_boundary = true;
            check(std::vector<int>(boundary_vertices.begin(), boundary_vertices.end()) == expected,
                  "MFEM boundary face order must preserve canonical owner orientation");
            break;
        }
        check(found_boundary,
              "every one-cell canonical face must be represented by an MFEM boundary face");
    }
    check(!require_nonzero_orientation || saw_nonzero_orientation,
          "connected second-side element must exercise a nonzero MFEM face orientation");
}

void single_element_families_preserve_geometry_dofs_vertices_and_attributes()
{
    struct Case {
        uint32_t type;
        mfem::Geometry::Type geometry;
        std::vector<double> nodes;
        std::vector<uint32_t> connectivity;
        int attribute;
    };
    const std::vector<Case> cases{
        {FULLMAG_FEM_CELL_TET4, mfem::Geometry::TETRAHEDRON,
         {0,0,0, 1,0,0, 0,1,0, 0,0,1}, {0,1,2,3}, 2},
        {FULLMAG_FEM_CELL_PRISM6, mfem::Geometry::PRISM,
         {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1}, {0,1,2,3,4,5}, 3},
        {FULLMAG_FEM_CELL_PYRAMID5, mfem::Geometry::PYRAMID,
         {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0.5,0.5,1}, {0,1,2,3,4}, 4},
        {FULLMAG_FEM_CELL_HEX8, mfem::Geometry::CUBE,
         {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1},
         {0,1,2,3,4,5,6,7}, 5},
    };

    for (const auto &item : cases) {
        std::vector<uint32_t> offsets{0u, static_cast<uint32_t>(item.connectivity.size())};
        auto source = make_mesh(item.nodes, {item.type}, offsets, item.connectivity,
                                {static_cast<uint32_t>(item.attribute)});
        auto mesh = build(source);
        check(mesh->GetNV() == static_cast<int>(source.n_nodes),
              "MFEM mesh must preserve canonical vertex count");
        check(mesh->GetNE() == 1, "single canonical cell must remain one MFEM element");
        check(mesh->GetElementGeometry(0) == item.geometry,
              "canonical cell family must map to its native MFEM geometry");
        check(mesh->GetAttribute(0) == item.attribute,
              "positive canonical cell marker must remain the MFEM attribute");
        std::vector<int> expected;
        for (uint32_t node : item.connectivity) expected.push_back(static_cast<int>(node));
        check_identity_vertices(*mesh, 0, expected);
        check_mfem_face_table(*mesh, 0, item.type, item.connectivity);
        mfem::H1_FECollection fec(1, 3);
        mfem::FiniteElementSpace fes(mesh.get(), &fec);
        check(fes.GetNDofs() == static_cast<int>(source.n_nodes),
              "mixed MFEM H1 P1 space must have one DOF per canonical node");
        check(mesh->CheckElementOrientation(false) == 0,
              "canonical positive element order must remain positive in MFEM");
    }
}

void legal_int_max_marker_without_air_is_preserved()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1},
        {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3},
        {static_cast<uint32_t>(std::numeric_limits<int>::max())});
    auto mesh = build(source);
    check(mesh->GetAttribute(0) == std::numeric_limits<int>::max(),
          "legal INT_MAX material marker must not require or compute an air attribute");
}

void zero_marker_uses_an_unoccupied_positive_air_attribute()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1,
         2,0,0, 3,0,0, 2,1,0, 2,0,1},
        {FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4},
        {0,4,8}, {0,1,2,3, 4,5,6,7}, {2,0});
    auto mesh = build(source);
    check(mesh->GetAttribute(0) == 2,
          "non-zero canonical marker must remain unchanged");
    check(mesh->GetAttribute(1) == 3,
          "air attribute must not collide with an existing positive marker");
}

FemMeshRuntimeState conforming_prism_pyramid_tet()
{
    return make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1,
         0.5,-1,0.5, 1.5,-1,0.5},
        {FULLMAG_FEM_CELL_PRISM6, FULLMAG_FEM_CELL_PYRAMID5, FULLMAG_FEM_CELL_TET4},
        {0,6,11,15},
        {0,1,2,3,4,5, 0,1,4,3,6, 1,4,6,7},
        {7,0,0});
}

void initialize_uniform_material(fullmag::fem::Context &ctx)
{
    ctx.base_plan.fe_order = 1u;
    ctx.exchange.enabled = true;
    ctx.material_fields.material.saturation_magnetisation = 8.0e5;
    ctx.material_fields.material.exchange_stiffness = 13.0e-12;
    ctx.material_fields.material.damping = 0.02;
    ctx.material_fields.material.gyromagnetic_ratio = 2.211e5;
    ctx.state.m_xyz.assign(3u * static_cast<size_t>(ctx.mesh.n_nodes), 0.0);
    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        ctx.state.m_xyz[3u * static_cast<size_t>(node)] = 1.0;
    }
    const char *requested_device = std::getenv("FULLMAG_MIXED_P1_ROLLBACK_DEVICE");
    ctx.mfem_device.device_string_override =
        requested_device == nullptr || *requested_device == '\0' ? "cpu" : requested_device;
}

void initialize_mfem_and_check_magnetic_volume(
    fullmag::fem::Context &ctx,
    double expected_volume)
{
    std::string error;
    check(fullmag::fem::initialize_material_runtime(ctx, error), error.c_str());
    check(!ctx.material_fields.runtime.has_value(),
          "uniform or nodal-P1 material must bypass the tetrahedral DG0 adapter");
    check(fullmag::fem::context_initialize_mfem(ctx, error), error.c_str());
    const auto &weights = ctx.integration_weights.mfem_lumped_mass;
    check(weights.size() == ctx.mesh.n_nodes,
          "MFEM magnetic mass row sums must publish one weight per P1 node");
    double sum = 0.0;
    for (size_t node = 0; node < weights.size(); ++node) {
        const double weight = weights[node];
        check(std::isfinite(weight) && weight >= 0.0,
              "MFEM magnetic mass row sums must be finite and non-negative");
        if (!ctx.mesh.magnetic_node_mask.empty() &&
            ctx.mesh.magnetic_node_mask[node] == 0u) {
            check(weight == 0.0,
                  "air-only P1 nodes must have zero magnetic mass weight");
        }
        sum += weight;
    }
    check(close_volume(sum, expected_volume),
          "MFEM magnetic mass row sums must conserve magnetic volume");
    check(ctx.mesh.node_volumes == weights,
          "compatibility node volumes must be synchronized from MFEM mass row sums");
}

std::vector<double> independent_magnetic_mass_row_sums(
    const FemMeshRuntimeState &source,
    const std::vector<uint8_t> &magnetic_element_mask)
{
    auto mesh = build(source);
    mfem::H1_FECollection fec(1, mesh->Dimension());
    mfem::FiniteElementSpace fes(mesh.get(), &fec);
    mfem::Array<int> magnetic_attributes(mesh->attributes.Max());
    magnetic_attributes = 0;
    for (int element = 0; element < mesh->GetNE(); ++element) {
        if (magnetic_element_mask[static_cast<size_t>(element)] == 0u) continue;
        magnetic_attributes[mesh->GetAttribute(element) - 1] = 1;
    }

    mfem::BilinearForm mass(&fes);
    mass.SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    mass.AddDomainIntegrator(new mfem::MassIntegrator(), magnetic_attributes);
    mass.Assemble();
    mass.Finalize();
    mfem::Vector ones(fes.GetNDofs());
    mfem::Vector row_sums(fes.GetNDofs());
    ones = 1.0;
    mass.Mult(ones, row_sums);
    const double *row_sums_host = row_sums.HostRead();
    return std::vector<double>(row_sums_host, row_sums_host + row_sums.Size());
}

void distorted_prism_mass_weights_match_independent_mfem_oracle()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0,
         0,0,1.00, 1,0,1.50, 0,1,0.80},
        {FULLMAG_FEM_CELL_PRISM6}, {0,6}, {0,1,2,3,4,5}, {7});
    const std::vector<uint8_t> magnetic_elements{1};
    const auto oracle = independent_magnetic_mass_row_sums(source, magnetic_elements);
    check(oracle.size() == 6u,
          "independent MFEM prism mass oracle must publish all six row sums");
    const double pre_initialize_oracle_volume =
        std::accumulate(oracle.begin(), oracle.end(), 0.0);
    const auto [minimum, maximum] = std::minmax_element(oracle.begin(), oracle.end());
    check(*maximum - *minimum > 1.0e-6 * pre_initialize_oracle_volume,
          "distorted prism oracle must distinguish MFEM row sums from volume over arity");

    fullmag::fem::Context ctx{};
    ctx.mesh = std::move(source);
    ctx.mesh.magnetic_element_mask = magnetic_elements;
    ctx.mesh.magnetic_node_mask = {1,1,1,1,1,1};
    initialize_uniform_material(ctx);
    std::string error;
    const bool material_ready = fullmag::fem::initialize_material_runtime(ctx, error);
    check(material_ready, error.c_str());
    const bool mfem_ready = fullmag::fem::context_initialize_mfem(ctx, error);
    check(mfem_ready, error.c_str());
    const auto &actual = ctx.integration_weights.mfem_lumped_mass;
    check(actual.size() == oracle.size(),
          "production and independent MFEM mass vectors must have the same extent");
    check(ctx.mesh.node_volumes == actual,
          "distorted-prism compatibility node volumes must mirror canonical MFEM row sums");
    for (size_t node = 0; node < actual.size(); ++node) {
        const double scale = std::max({1.0, std::abs(actual[node]), std::abs(oracle[node])});
        if (std::abs(actual[node] - oracle[node]) >
            1024.0 * std::numeric_limits<double>::epsilon() * scale) {
            std::fprintf(stderr,
                         "distorted prism mass mismatch node=%zu actual=%.17g oracle=%.17g\n",
                         node, actual[node], oracle[node]);
        }
        check(std::abs(actual[node] - oracle[node]) <=
                  1024.0 * std::numeric_limits<double>::epsilon() * scale,
              "production distorted-prism weights must match independent MassIntegrator times one");
    }
    check(close_volume(
              std::accumulate(actual.begin(), actual.end(), 0.0),
              std::accumulate(oracle.begin(), oracle.end(), 0.0)),
          "production distorted-prism row sums must conserve the independent MFEM volume");
    fullmag::fem::context_destroy_mfem(ctx);
}

void mfem_mass_weights_cover_tet_prism_and_mixed_magnetic_domains()
{
    struct Case {
        FemMeshRuntimeState mesh;
        std::vector<uint8_t> magnetic_elements;
        std::vector<uint8_t> magnetic_nodes;
        double volume;
    };
    std::vector<Case> cases;
    cases.push_back({
        make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1},
            {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {7}),
        {1}, {1,1,1,1}, 1.0 / 6.0});
    cases.push_back({
        make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1},
            {FULLMAG_FEM_CELL_PRISM6}, {0,6}, {0,1,2,3,4,5}, {7}),
        {1}, {1,1,1,1,1,1}, 0.5});
    cases.push_back({
        conforming_prism_pyramid_tet(),
        {1,0,0}, {1,1,1,1,1,1,0,0}, 0.5});

    for (auto &item : cases) {
        fullmag::fem::Context ctx{};
        ctx.mesh = std::move(item.mesh);
        ctx.mesh.magnetic_element_mask = std::move(item.magnetic_elements);
        ctx.mesh.magnetic_node_mask = std::move(item.magnetic_nodes);
        initialize_uniform_material(ctx);
        initialize_mfem_and_check_magnetic_volume(ctx, item.volume);
        const auto average = fullmag::fem::average_magnetization_components(ctx);
        check(close_volume(average[0], 1.0) && close_volume(average[1], 0.0) &&
                  close_volume(average[2], 0.0),
              "uniform Ms average magnetization must use MFEM magnetic mass weights");
        fullmag::fem::context_destroy_mfem(ctx);
    }
}

void mixed_core_measure_over_arity_is_not_published_as_runtime_node_volume()
{
    fullmag::fem::Context ctx{};
    ctx.mesh = conforming_prism_pyramid_tet();
    ctx.mesh.magnetic_element_mask = {1,0,0};
    fullmag::fem::compute_node_volumes(ctx);
    check(ctx.mesh.node_volumes.empty(),
          "mixed topology must wait for generic MFEM mass row sums instead of measure over arity");
}

void check_nodal_mfem_coefficient(
    fullmag::fem::Context &ctx,
    const std::vector<double> &payload,
    void *grid_function_handle,
    void *coefficient_handle,
    const char *name)
{
    auto &mesh = *static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    auto &fes = *static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    auto &field = *static_cast<mfem::GridFunction *>(grid_function_handle);
    auto &coefficient = *static_cast<mfem::Coefficient *>(coefficient_handle);
    check(dynamic_cast<mfem::GridFunctionCoefficient *>(&coefficient) != nullptr,
          "nodal-P1 material must be realized as an MFEM GridFunctionCoefficient");
    check(field.Size() == static_cast<int>(payload.size()),
          "MFEM nodal material GridFunction must preserve payload extent");
    for (int node = 0; node < field.Size(); ++node) {
        check(field[node] == payload[static_cast<size_t>(node)], name);
    }

    mfem::Array<int> dofs;
    fes.GetElementDofs(0, dofs);
    const mfem::FiniteElement &element = *fes.GetFE(0);
    mfem::Vector shape(element.GetDof());
    mfem::ElementTransformation &transformation = *mesh.GetElementTransformation(0);
    const mfem::IntegrationRule &rule = mfem::IntRules.Get(mfem::Geometry::PRISM, 4);
    for (int point = 0; point < rule.GetNPoints(); ++point) {
        const mfem::IntegrationPoint &integration_point = rule.IntPoint(point);
        element.CalcShape(integration_point, shape);
        double expected = 0.0;
        for (int local = 0; local < dofs.Size(); ++local) {
            check(dofs[local] >= 0,
                  "scalar H1 P1 material coefficient must use unsigned vertex DOFs");
            expected += payload[static_cast<size_t>(dofs[local])] * shape[local];
        }
        transformation.SetIntPoint(&integration_point);
        const double actual = coefficient.Eval(transformation, integration_point);
        const double scale = std::max({1.0, std::abs(actual), std::abs(expected)});
        check(std::abs(actual - expected) <=
                  512.0 * std::numeric_limits<double>::epsilon() * scale,
              name);
    }
}

void mixed_nodal_ms_and_a_follow_validated_mfem_realization()
{
    fullmag::fem::Context ctx{};
    ctx.mesh = conforming_prism_pyramid_tet();
    ctx.mesh.magnetic_element_mask = {1,0,0};
    ctx.mesh.magnetic_node_mask = {1,1,1,1,1,1,0,0};
    initialize_uniform_material(ctx);
    ctx.material_fields.Ms_field = {1,2,3,4,5,6,101,103};
    ctx.material_fields.A_field = {
        11e-12, 12e-12, 13e-12, 14e-12, 15e-12, 16e-12, 91e-12, 93e-12};
    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        ctx.state.m_xyz[base + 0u] = node < 3u ? 1.0 : 0.0;
        ctx.state.m_xyz[base + 1u] = node >= 3u && node < 6u ? 1.0 : 0.0;
    }
    std::string error;
    const bool material_valid = fullmag::fem::validate_material_fields(ctx, error);
    check(material_valid, error.c_str());
    initialize_mfem_and_check_magnetic_volume(ctx, 0.5);
    check_nodal_mfem_coefficient(
        ctx,
        ctx.material_fields.Ms_field,
        ctx.mfem_context.gf_ms,
        ctx.mfem_context.ms_coeff,
        "validated nodal Ms payload must survive its MFEM realization");
    check_nodal_mfem_coefficient(
        ctx,
        ctx.material_fields.A_field,
        ctx.mfem_context.gf_a,
        ctx.mfem_context.a_coeff,
        "validated nodal A payload must survive its MFEM realization");
    const auto average = fullmag::fem::average_magnetization_components(ctx);
    check(close_volume(average[0], 2.0 / 7.0) &&
              close_volume(average[1], 5.0 / 7.0) && close_volume(average[2], 0.0),
          "nodal Ms average magnetization must use Ms times MFEM magnetic mass weights");
    fullmag::fem::context_destroy_mfem(ctx);
}

void mixed_element_dg0_material_rejects_without_tetrahedral_realization()
{
    for (bool use_ms : {false, true}) {
        fullmag::fem::Context ctx{};
        ctx.mesh = conforming_prism_pyramid_tet();
        ctx.mesh.magnetic_element_mask = {1,0,0};
        initialize_uniform_material(ctx);
        if (use_ms) {
            ctx.material_fields.Ms_element_field = {8.0e5, 0.0, 0.0};
        } else {
            ctx.material_fields.A_element_field = {13.0e-12, 0.0, 0.0};
        }
        std::string error;
        check(!fullmag::fem::initialize_material_runtime(ctx, error),
              "mixed element-DG0 material must fail before tetrahedral realization");
        check(error.find("element-DG0") != std::string::npos &&
                  error.find("non-tetrahedral") != std::string::npos &&
                  error.find(use_ms ? "Ms_element_field" : "A_element_field") !=
                      std::string::npos,
              "mixed DG0 rejection must name coefficient location and topology restriction");
        check(!ctx.material_fields.runtime.has_value(),
              "rejected mixed DG0 material must not publish a truncated tetra runtime");
    }
}

int common_dof_count(mfem::FiniteElementSpace &fes, int first, int second)
{
    mfem::Array<int> a;
    mfem::Array<int> b;
    fes.GetElementDofs(first, a);
    fes.GetElementDofs(second, b);
    int count = 0;
    for (int i = 0; i < a.Size(); ++i) {
        for (int j = 0; j < b.Size(); ++j) {
            if (a[i] == b[j]) ++count;
        }
    }
    return count;
}

void check_linear_interface_values(
    const FemMeshRuntimeState &source,
    mfem::FiniteElementSpace &fes,
    const std::vector<uint32_t> &nodes)
{
    mfem::GridFunction field(&fes);
    mfem::FunctionCoefficient linear([](const mfem::Vector &x) {
        return x[0] + 2.0 * x[1] - 3.0 * x[2];
    });
    field.ProjectCoefficient(linear);
    for (uint32_t node : nodes) {
        mfem::Array<int> dofs;
        fes.GetVertexDofs(static_cast<int>(node), dofs);
        check(dofs.Size() == 1,
              "H1 P1 interface vertex must own exactly one global scalar DOF");
        const size_t offset = 3u * static_cast<size_t>(node);
        const double expected = source.nodes_xyz[offset] +
            2.0 * source.nodes_xyz[offset + 1u] -
            3.0 * source.nodes_xyz[offset + 2u];
        check(std::abs(field[dofs[0]] - expected) < 1.0e-12,
              "linear GridFunction value must be continuous at shared interface DOF");
    }
}

void conforming_mixed_domain_shares_faces_and_h1_dofs()
{
    const auto source = conforming_prism_pyramid_tet();
    auto mesh = build(source);
    check(mesh->GetNE() == 3, "mixed domain must preserve canonical cell ordinals");
    check(mesh->GetNFaces() == 12,
          "shared prism-pyramid and pyramid-tet faces must not be duplicated");
    check(mesh->GetNBE() == 10,
          "legacy facet-free descriptor must generate only one-owner faces");
    check(mesh->GetElementGeometry(0) == mfem::Geometry::PRISM &&
          mesh->GetElementGeometry(1) == mfem::Geometry::PYRAMID &&
          mesh->GetElementGeometry(2) == mfem::Geometry::TETRAHEDRON,
          "mixed MFEM element ordering must follow canonical cell ordinals");

    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(mesh.get(), &fec);
    check(fes.GetNDofs() == static_cast<int>(source.n_nodes),
          "conforming mixed H1 P1 domain must have one DOF per global node");
    check(common_dof_count(fes, 0, 1) == 4,
          "prism-pyramid quad interface must share four H1 DOFs");
    check(common_dof_count(fes, 1, 2) == 3,
          "pyramid-tet triangle interface must share three H1 DOFs");
    check_mfem_face_table(*mesh, 0, FULLMAG_FEM_CELL_PRISM6, {0,1,2,3,4,5}, false);
    check_mfem_face_table(*mesh, 1, FULLMAG_FEM_CELL_PYRAMID5, {0,1,4,3,6}, false, true);
    check_mfem_face_table(*mesh, 2, FULLMAG_FEM_CELL_TET4, {1,4,6,7}, false, true);
    check_linear_interface_values(source, fes, {0,1,3,4});
    check_linear_interface_values(source, fes, {1,4,6});
}

struct RecoveryResult {
    std::vector<double> magnetic;
    std::vector<double> visual;
};

RecoveryResult recover_p1_potential(
    const FemMeshRuntimeState &source,
    const std::vector<uint8_t> &magnetic_elements,
    const std::vector<uint8_t> &magnetic_nodes,
    const std::vector<double> &nodal_potential)
{
    auto mesh = build(source);
    mfem::H1_FECollection fec(1, mesh->Dimension());
    mfem::FiniteElementSpace fes(mesh.get(), &fec);
    check(nodal_potential.size() == static_cast<size_t>(fes.GetNDofs()),
          "recovery fixture must provide one scalar potential per P1 DOF");

    fullmag::fem::Context ctx{};
    ctx.mesh = source;
    ctx.mesh.magnetic_element_mask = magnetic_elements;
    ctx.mesh.magnetic_node_mask = magnetic_nodes;
    ctx.mfem_context.mesh = mesh.get();
    ctx.mfem_context.fes = &fes;
    ctx.integration_weights.mfem_lumped_mass.assign(source.n_nodes, 1.0);

    mfem::GridFunction potential_grid(&fes);
    double *potential_host = potential_grid.HostWrite();
    for (int dof = 0; dof < fes.GetNDofs(); ++dof) {
        potential_host[dof] = nodal_potential[static_cast<size_t>(dof)];
    }
    mfem::Vector potential;
    potential_grid.GetTrueDofs(potential);

    std::string error;
    check(fullmag::fem::initialize_demag_poisson_recovery_workspace(ctx, fes, error),
          error.c_str());
    RecoveryResult result;
    double energy = 0.0;
    uint64_t energy_wall_time_ns = 0;
    const std::vector<double> zero_magnetization(3u * source.n_nodes, 0.0);
    check(fullmag::fem::recover_demag_poisson_field(
              ctx,
              potential,
              result.magnetic,
              energy,
              zero_magnetization,
              &energy_wall_time_ns,
              error),
          error.c_str());
    result.visual = ctx.demag.h_visual_xyz;
    check(energy == 0.0, "zero magnetization must keep mixed recovery energy at zero");
    fullmag::fem::destroy_demag_poisson_recovery_workspace(ctx);
    return result;
}

std::vector<double> nodal_linear_potential(const FemMeshRuntimeState &source)
{
    std::vector<double> values(source.n_nodes, 0.0);
    for (uint32_t node = 0; node < source.n_nodes; ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        values[node] = source.nodes_xyz[base] + 2.0 * source.nodes_xyz[base + 1u] -
            3.0 * source.nodes_xyz[base + 2u];
    }
    return values;
}

void manufactured_linear_potential_recovers_on_tet_prism_and_pyramid()
{
    const std::vector<FemMeshRuntimeState> cases{
        make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1},
            {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {7}),
        make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1},
            {FULLMAG_FEM_CELL_PRISM6}, {0,6}, {0,1,2,3,4,5}, {7}),
        make_mesh(
            {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0.5,0.5,1},
            {FULLMAG_FEM_CELL_PYRAMID5}, {0,5}, {0,1,2,3,4}, {7}),
    };

    for (const auto &source : cases) {
        const auto recovered = recover_p1_potential(
            source,
            {1u},
            std::vector<uint8_t>(source.n_nodes, 1u),
            nodal_linear_potential(source));
        for (uint32_t node = 0; node < source.n_nodes; ++node) {
            const size_t base = 3u * static_cast<size_t>(node);
            check(std::abs(recovered.magnetic[base] + 1.0) < 1.0e-12 &&
                      std::abs(recovered.magnetic[base + 1u] + 2.0) < 1.0e-12 &&
                      std::abs(recovered.magnetic[base + 2u] - 3.0) < 1.0e-12,
                  "manufactured P1 recovery must equal -grad(x+2y-3z)");
            check(std::abs(recovered.visual[base] + 1.0) < 1.0e-12 &&
                      std::abs(recovered.visual[base + 1u] + 2.0) < 1.0e-12 &&
                      std::abs(recovered.visual[base + 2u] - 3.0) < 1.0e-12,
                  "single-cell full-domain visualization must equal manufactured recovery");
        }
    }
}

void mixed_recovery_excludes_air_from_magnetic_interface_nodes()
{
    const auto source = conforming_prism_pyramid_tet();
    std::vector<double> potential(source.n_nodes, 0.0);
    for (uint32_t node = 0; node < 6u; ++node) {
        potential[node] = source.nodes_xyz[3u * static_cast<size_t>(node)];
    }
    potential[6] = 10.0;
    potential[7] = -4.0;

    const auto magnetic_only = recover_p1_potential(
        source,
        {1u, 0u, 0u},
        {1u,1u,1u,1u,1u,1u,0u,0u},
        potential);
    for (uint32_t node = 0; node < 6u; ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        check(std::abs(magnetic_only.magnetic[base] + 1.0) < 1.0e-12 &&
                  std::abs(magnetic_only.magnetic[base + 1u]) < 1.0e-12 &&
                  std::abs(magnetic_only.magnetic[base + 2u]) < 1.0e-12,
              "magnetic recovery must exclude air gradients at shared interface nodes");
    }

    const auto all_domain = recover_p1_potential(
        source,
        {1u, 1u, 1u},
        std::vector<uint8_t>(source.n_nodes, 1u),
        potential);
    bool visual_includes_air = false;
    for (uint32_t node : {0u, 1u, 3u, 4u}) {
        const size_t base = 3u * static_cast<size_t>(node);
        for (size_t component = 0; component < 3u; ++component) {
            check(std::abs(magnetic_only.visual[base + component] -
                           all_domain.magnetic[base + component]) < 1.0e-12,
                  "full-domain visualization must include the same cells as all-domain recovery");
            visual_includes_air = visual_includes_air ||
                std::abs(magnetic_only.visual[base + component] -
                         magnetic_only.magnetic[base + component]) > 1.0e-8;
        }
    }
    check(visual_includes_air,
          "full-domain visualization must retain an observable air-gradient contribution");
}

RecoveryResult recover_manufactured_on_mesh(mfem::Mesh &mesh, int recover_threads)
{
    mfem::H1_FECollection fec(1, mesh.Dimension());
    mfem::FiniteElementSpace fes(&mesh, &fec);
    fullmag::fem::Context ctx{};
    ctx.mfem_context.mesh = &mesh;
    ctx.mfem_context.fes = &fes;
    ctx.mesh.n_nodes = static_cast<uint32_t>(fes.GetNDofs());
    ctx.cpu_threads.effective_omp_threads = recover_threads;
    ctx.integration_weights.mfem_lumped_mass.assign(ctx.mesh.n_nodes, 1.0);

    mfem::GridFunction potential_grid(&fes);
    mfem::FunctionCoefficient potential_function(
        [](const mfem::Vector &x) { return x[0] + 2.0 * x[1] - 3.0 * x[2]; });
    potential_grid.ProjectCoefficient(potential_function);
    mfem::Vector potential;
    potential_grid.GetTrueDofs(potential);

    std::string error;
    check(fullmag::fem::initialize_demag_poisson_recovery_workspace(ctx, fes, error),
          error.c_str());
    RecoveryResult result;
    double energy = 0.0;
    uint64_t energy_wall_time_ns = 0;
    const std::vector<double> zero_magnetization(3u * ctx.mesh.n_nodes, 0.0);
    check(fullmag::fem::recover_demag_poisson_field(
              ctx,
              potential,
              result.magnetic,
              energy,
              zero_magnetization,
              &energy_wall_time_ns,
              error),
          error.c_str());
    result.visual = ctx.demag.h_visual_xyz;
    fullmag::fem::destroy_demag_poisson_recovery_workspace(ctx);
    return result;
}

void parallel_recovery_matches_serial_with_caller_owned_transformations()
{
#ifdef _OPENMP
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        10, 10, 4, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    check(mesh.GetNE() >= 2000,
          "parallel recovery fixture must cross the production OpenMP threshold");
    const auto serial = recover_manufactured_on_mesh(mesh, 1);
    const auto parallel = recover_manufactured_on_mesh(mesh, 4);
    check(serial.magnetic.size() == parallel.magnetic.size(),
          "serial and parallel recovery must publish the same field extent");
    for (size_t value = 0; value < serial.magnetic.size(); ++value) {
        check(std::abs(serial.magnetic[value] - parallel.magnetic[value]) < 1.0e-12,
              "parallel recovery must match serial recovery with thread-local transformations");
        check(std::abs(serial.visual[value] - parallel.visual[value]) < 1.0e-12,
              "parallel visual recovery must match serial full-domain recovery");
    }
#endif
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(static_cast<bool>(input), "mixed recovery source contract must be readable");
    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

void recovery_source_uses_tet_geometry_and_signed_certified_quadrature()
{
    const std::filesystem::path this_file(__FILE__);
    const auto root = this_file.parent_path().parent_path();
    const std::string recovery = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_poisson_recovery.cpp");
    check(recovery.find("fe->GetGeomType() == mfem::Geometry::TETRAHEDRON") !=
              std::string::npos,
          "P1 demag fast path must be selected by tetrahedron geometry");
    check(recovery.find("std::abs(shape(i))") == std::string::npos,
          "generic demag recovery must retain the signed P1 shape value");
    check(recovery.find("std::abs(T->Weight())") == std::string::npos,
          "demag recovery must not hide an inverted Jacobian with abs");
    check(recovery.find("mesh->GetElementTransformation(elem);") == std::string::npos,
          "parallel demag recovery must not reuse the mesh-owned element transformation");
    check(recovery.find("mesh->GetElementTransformation(elem, &transformation);") !=
              std::string::npos,
          "parallel demag recovery must fill a caller-owned element transformation");
}

void inverted_family_permutations_fail_closed()
{
    struct Case {
        uint32_t type;
        std::vector<double> nodes;
        std::vector<uint32_t> connectivity;
    };
    const std::vector<Case> cases{
        {FULLMAG_FEM_CELL_TET4,
         {0,0,0, 1,0,0, 0,1,0, 0,0,1}, {0,2,1,3}},
        {FULLMAG_FEM_CELL_PRISM6,
         {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1}, {0,2,1,3,5,4}},
        {FULLMAG_FEM_CELL_PYRAMID5,
         {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0.5,0.5,1}, {0,3,2,1,4}},
        {FULLMAG_FEM_CELL_HEX8,
         {0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1},
         {1,0,3,2,5,4,7,6}},
    };
    for (const auto &item : cases) {
        auto source = make_mesh(
            item.nodes,
            {item.type},
            {0u, static_cast<uint32_t>(item.connectivity.size())},
            item.connectivity,
            {1});
        expect_reject(source, "inverted element");
    }
}

FemMeshRuntimeState typed_prism_pyramid_boundary()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1, 0.5,-1,0.5},
        {FULLMAG_FEM_CELL_PRISM6, FULLMAG_FEM_CELL_PYRAMID5},
        {0,6,11}, {0,1,2,3,4,5, 0,1,4,3,6}, {7,0});
    source.facet_types = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_QUAD4, FULLMAG_FEM_FACET_QUAD4,
        FULLMAG_FEM_FACET_QUAD4,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3};
    source.facet_roles = {
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    source.facet_offsets = {0,3,6,10,14,18,21,24,27,30};
    source.facet_nodes = {
        0,1,2, 3,4,5, 0,1,4,3, 1,2,5,4, 2,0,3,5,
        0,1,6, 1,4,6, 4,3,6, 3,0,6};
    source.facet_markers = {77,12,20,13,14,15,16,17,0};
    source.n_boundary_faces = static_cast<uint32_t>(source.facet_types.size());
    return source;
}

void typed_boundary_uses_owner_orientation_roles_and_attributes()
{
    const auto source = typed_prism_pyramid_boundary();
    auto mesh = build(source);
    check(mesh->GetNBE() == 8,
          "material interface must not become an MFEM boundary element");
    int triangles = 0;
    int quads = 0;
    bool found_periodic = false;
    std::vector<int> boundary_attributes;
    for (int boundary = 0; boundary < mesh->GetNBE(); ++boundary) {
        const auto geometry = mesh->GetBdrElementGeometry(boundary);
        triangles += geometry == mfem::Geometry::TRIANGLE ? 1 : 0;
        quads += geometry == mfem::Geometry::SQUARE ? 1 : 0;
        int owner = -1;
        int info = -1;
        mesh->GetBdrElementAdjacentElement(boundary, owner, info);
        check(owner >= 0 && owner < mesh->GetNE(),
              "every canonical exterior/seam facet must keep its sole owner");
        boundary_attributes.push_back(mesh->GetBdrAttribute(boundary));
        if (mesh->GetBdrAttribute(boundary) == 77) {
            found_periodic = true;
            mfem::Array<int> vertices;
            mesh->GetBdrElementVertices(boundary, vertices);
            check(vertices.Size() == 3 && vertices[0] == 0 && vertices[1] == 2 && vertices[2] == 1,
                  "boundary orientation must come from the owner face, not reversed input winding");
        }
        check(mesh->GetBdrAttribute(boundary) != 20,
              "material-interface marker must not leak into MFEM boundary attributes");
    }
    check(triangles == 6 && quads == 2,
          "typed boundary must preserve native tri3 and quad4 geometries");
    check(found_periodic, "periodic seam must remain an attributed MFEM boundary element");
    std::sort(boundary_attributes.begin(), boundary_attributes.end());
    check(boundary_attributes == std::vector<int>({1,12,13,14,15,16,17,77}),
          "boundary markers must be preserved, with zero mapped to positive attribute one");
}

void all_tet_periodic_seam_remains_an_attributed_boundary()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1},
        {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {1});
    source.facet_types = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3};
    source.facet_roles = {
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    source.facet_offsets = {0,3,6,9,12};
    source.facet_nodes = {0,1,2, 0,1,3, 1,2,3, 2,0,3};
    source.facet_markers = {91,2,3,4};
    source.n_boundary_faces = 4;

    auto mesh = build(source);
    check(mesh->GetNBE() == 4,
          "all-tet typed boundary must keep all one-owner faces");
    bool found_periodic = false;
    for (int boundary = 0; boundary < mesh->GetNBE(); ++boundary) {
        found_periodic = found_periodic || mesh->GetBdrAttribute(boundary) == 91;
    }
    check(found_periodic,
          "all-tet periodic seam marker must remain available to Robin-boundary exclusion");
}

void malformed_face_ownership_and_marker_inputs_fail_closed()
{
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_roles[2] = FULLMAG_FEM_FACET_ROLE_EXTERIOR;
        expect_reject(source, "exterior facet must have exactly one owner");
    }
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_roles[0] = FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE;
        expect_reject(source, "material-interface facet must have exactly two owners");
    }
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_types.push_back(source.facet_types[0]);
        source.facet_roles.push_back(source.facet_roles[0]);
        source.facet_nodes.insert(source.facet_nodes.end(), {0,2,1});
        source.facet_offsets.push_back(static_cast<uint32_t>(source.facet_nodes.size()));
        source.facet_markers.push_back(78);
        source.n_boundary_faces += 1u;
        expect_reject(source, "duplicate input facet");
    }
    {
        auto source = typed_prism_pyramid_boundary();
        source.facet_nodes[0] = 0;
        source.facet_nodes[1] = 1;
        source.facet_nodes[2] = 5;
        expect_reject(source, "input facet has no volume-cell owner");
    }
    {
        auto source = make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,0,-1, 0,0,2},
            {FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4},
            {0,4,8,12}, {0,1,2,3, 0,2,1,4, 0,1,2,5}, {1,1,1});
        expect_reject(source, "non-manifold face has more than two owners");
    }
    {
        auto source = make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1},
            {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3},
            {static_cast<uint32_t>(std::numeric_limits<int>::max()) + 1u});
        expect_reject(source, "cell marker exceeds positive MFEM attribute range");
    }
    {
        auto source = make_mesh(
            {0,0,0, 1,0,0, 0,1,0, 0,0,1},
            {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {1});
        source.facet_types = {FULLMAG_FEM_FACET_TRI3};
        source.facet_roles = {FULLMAG_FEM_FACET_ROLE_EXTERIOR};
        source.facet_offsets = {0,3};
        source.facet_nodes = {0,2,1};
        source.facet_markers = {1};
        source.n_boundary_faces = 1;
        for (int attempt = 0; attempt < 16; ++attempt) {
            expect_reject(source, "typed facet list is incomplete");
        }
    }
}

void repeated_incomplete_facets_fail_before_runtime_publication()
{
    auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1},
        {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {1});
    source.facet_types = {FULLMAG_FEM_FACET_TRI3};
    source.facet_roles = {FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    source.facet_offsets = {0,3};
    source.facet_nodes = {0,2,1};
    source.facet_markers = {1};
    source.n_boundary_faces = 1;

    for (int attempt = 0; attempt < 16; ++attempt) {
        fullmag::fem::Context context{};
        context.mesh = source;
        std::string error;
        check(!fullmag::fem::context_initialize_mfem(context, error),
              "repeated incomplete-facet context initialization must fail closed");
        check(error.find("typed facet list is incomplete") != std::string::npos,
              error.c_str());
        check(context.mfem_context.mesh == nullptr &&
                  context.mfem_context.fec == nullptr &&
                  context.mfem_context.fes == nullptr &&
                  context.gpu_state.cuda.compute_stream == nullptr &&
                  context.gpu_state.cuda.io_stream == nullptr &&
                  context.gpu_state.cuda.compute_event == nullptr,
              "failed context initialization must not publish MFEM or CUDA resources");
    }
}

void repeated_post_device_fes_failure_rolls_back_runtime_state()
{
    const auto source = make_mesh(
        {0,0,0, 1,0,0, 0,1,0, 0,0,1},
        {FULLMAG_FEM_CELL_TET4}, {0,4}, {0,1,2,3}, {1});
    const char *requested_device = std::getenv("FULLMAG_MIXED_P1_ROLLBACK_DEVICE");
    const std::string rollback_device = requested_device == nullptr || *requested_device == '\0'
        ? "cpu" : requested_device;
    check(rollback_device == "cpu" || rollback_device == "cuda",
          "FULLMAG_MIXED_P1_ROLLBACK_DEVICE must be cpu or cuda");
    const bool use_cuda = rollback_device == "cuda";
#if FULLMAG_HAS_CUDA_RUNTIME
    if (use_cuda) {
        int device_count = 0;
        check(cudaGetDeviceCount(&device_count) == cudaSuccess && device_count > 0,
              "explicit CUDA rollback lane requires an available CUDA device");
    }
#else
    check(!use_cuda,
          "explicit CUDA rollback lane requires a backend compiled with CUDA runtime support");
#endif

    for (int attempt = 0; attempt < 16; ++attempt) {
        fullmag::fem::Context context{};
        context.mesh = source;
        context.base_plan.fe_order = 2;
        context.mfem_device.device_string_override = use_cuda ? "cuda" : "cpu";
        context.mfem_device.gpu_device_index = use_cuda ? 0 : -1;
        std::string error;
        check(!fullmag::fem::context_initialize_mfem(context, error),
              "P2 FES/node mismatch must fail after MFEM device and local FES allocation");
        check(error.find("DOF count does not match node count") != std::string::npos,
              error.c_str());
        check(mfem::Device::IsConfigured(),
              "failed context teardown must preserve the process-global MFEM Device");
        check(!context.mfem_context.ready && !context.exchange.mfem.ready &&
                  context.mfem_context.selected_device_index == -1 &&
                  context.mfem_context.device == nullptr &&
                  context.mfem_context.mesh == nullptr &&
                  context.mfem_context.fec == nullptr &&
                  context.mfem_context.fes == nullptr &&
                  context.mfem_context.gf_mx == nullptr &&
                  context.mfem_context.a_coeff == nullptr &&
                  context.gpu_state.cuda.compute_stream == nullptr &&
                  context.gpu_state.cuda.io_stream == nullptr &&
                  context.gpu_state.cuda.compute_event == nullptr,
              "post-device/FES failure must roll back MFEM/CUDA handles and device metadata");
    }
}

void post_allocation_gpu_bootstrap_failure_rolls_back_every_owner()
{
    const char *requested_device = std::getenv("FULLMAG_MIXED_P1_ROLLBACK_DEVICE");
    if (requested_device == nullptr || std::string(requested_device) != "cuda") {
        return;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    fullmag::fem::Context context{};
    context.mesh = conforming_prism_pyramid_tet();
    context.mesh.magnetic_element_mask = {1u, 0u, 0u};
    context.mesh.magnetic_node_mask = {1u, 1u, 1u, 1u, 1u, 1u, 0u, 0u};
    initialize_uniform_material(context);
    context.dmi.interfacial_enabled = true;

    std::string error;
    check(fullmag::fem::initialize_material_runtime(context, error), error.c_str());
    check(fullmag::fem::context_initialize_mfem(context, error), error.c_str());
    fullmag::fem::context_populate_device_info(context);
    check(context.mfem_context.ready && context.mfem_context.mesh != nullptr &&
              context.mfem_context.fes != nullptr &&
              context.exchange.mfem.exchange_form != nullptr &&
              context.exchange.mfem.mass_form != nullptr,
          "rollback injection requires allocated MFEM exchange resources");
    check(context.mfem_device.device_info_cache.is_gpu_enabled != 0,
          "rollback injection requires a real MFEM CUDA device");

    error.clear();
    check(!fullmag::fem::initialize_context_gpu_state(context, error),
          "mixed connectivity must fail the DMI tetrahedral geometry upload after allocation");
    check(error.find("requires tetrahedral element connectivity") != std::string::npos,
          error.c_str());
    check(context.transfer_audit.audit.counters.h2d_bytes > 0,
          "post-allocation rollback fixture must execute real CUDA uploads before failure");
    check(!context.gpu_state.device.lifecycle.initialized &&
              !context.gpu_state.device.lifecycle.allocated &&
              context.gpu_state.device.lifecycle.device_bytes == 0 &&
              context.gpu_state.device.lifecycle.reduction_workspace_bytes == 0,
          "failed GPU bootstrap must reset FemGpuState lifecycle and byte accounting");
    check(all_gpu_state_owned_pointers_are_null(context.gpu_state.device),
          "failed GPU bootstrap must null every FemGpuState-owned allocation");
    check(!context.mfem_context.ready && !context.exchange.mfem.ready &&
              context.mfem_context.mesh == nullptr && context.mfem_context.fec == nullptr &&
              context.mfem_context.fes == nullptr && context.mfem_context.gf_mx == nullptr &&
              context.mfem_context.gf_my == nullptr && context.mfem_context.gf_mz == nullptr &&
              context.mfem_context.gf_a == nullptr && context.mfem_context.gf_ms == nullptr &&
              context.exchange.mfem.exchange_form == nullptr &&
              context.exchange.mfem.mass_form == nullptr &&
              context.gpu_state.cuda.snapshot_pool == nullptr &&
              context.gpu_state.cuda.compute_stream == nullptr &&
              context.gpu_state.cuda.io_stream == nullptr &&
              context.gpu_state.cuda.compute_event == nullptr,
          "failed GPU bootstrap must release MFEM, snapshot, stream, and event resources");
#endif
}

struct MixedGpuRuntimeFixture {
    fullmag::fem::Context context{};

    ~MixedGpuRuntimeFixture()
    {
        fullmag::fem::destroy_backend_runtime(context);
    }
};

std::unique_ptr<MixedGpuRuntimeFixture> initialize_mixed_gpu_runtime(
    fullmag_fem_integrator integrator,
    bool enable_device_hypre_demag)
{
    auto fixture = std::make_unique<MixedGpuRuntimeFixture>();
    auto &context = fixture->context;
    context.mesh = conforming_prism_pyramid_tet();
    context.mesh.magnetic_element_mask = {1u, 0u, 0u};
    context.mesh.magnetic_node_mask = {1u, 1u, 1u, 1u, 1u, 1u, 0u, 0u};
    initialize_uniform_material(context);
    context.base_plan.integrator = integrator;
    context.base_plan.dt_seconds = 1.0e-15;
    context.base_plan.precession_enabled = false;
    context.mfem_device.device_string_override = "cuda";
    context.mfem_device.gpu_device_index = 0;
    context.demag.enabled = enable_device_hypre_demag;
    if (enable_device_hypre_demag) {
        context.demag.realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
        context.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
        context.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
        context.demag.solver.relative_tolerance = 1.0e-12;
        context.demag.solver.max_iterations = 500;
        context.poisson_demag.boundary_marker = 1;
        context.poisson_demag.gpu_demag_mode =
            FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    }

    for (uint32_t node = 0; node < context.mesh.n_nodes; ++node) {
        const double y = node < 6u ? 0.12 * static_cast<double>(node + 1u) : 0.0;
        const double z = node < 6u ? -0.04 * static_cast<double>(node % 3u) : 0.0;
        const double norm = std::sqrt(1.0 + y * y + z * z);
        const size_t base = 3u * static_cast<size_t>(node);
        context.state.m_xyz[base] = 1.0 / norm;
        context.state.m_xyz[base + 1u] = y / norm;
        context.state.m_xyz[base + 2u] = z / norm;
    }

    fullmag::fem::initialize_uniform_zeeman_field(context);
    fullmag::fem::initialize_context_field_buffers(context);
    std::string error;
    if (!fullmag::fem::initialize_material_runtime(context, error)) {
        std::fprintf(stderr, "mixed GPU material runtime initialization failed: %s\n",
                     error.c_str());
        std::exit(1);
    }
    if (!fullmag::fem::context_initialize_mfem(context, error)) {
        std::fprintf(stderr, "mixed GPU MFEM initialization failed: %s\n", error.c_str());
        std::exit(1);
    }
    if (!fullmag::fem::initialize_demag_runtime(context, error)) {
        std::fprintf(stderr, "mixed GPU demag runtime initialization failed: %s\n",
                     error.c_str());
        std::exit(1);
    }
    fullmag::fem::context_populate_device_info(context);
    if (!fullmag::fem::initialize_context_gpu_state(context, error)) {
        std::fprintf(stderr, "mixed GPU state initialization failed: %s\n", error.c_str());
        std::exit(1);
    }
    check(context.gpu_state.device.lifecycle.allocated,
          "mixed relaxation fixture requires allocated CUDA state");
    check(!context.gpu_state.device.mesh_geometry.uploaded &&
              context.gpu_state.device.mesh_geometry.nodes_xyz == nullptr &&
              context.gpu_state.device.mesh_geometry.elements == nullptr &&
              context.gpu_state.device.mesh_geometry.magnetic_element_mask == nullptr,
          "exchange-only mixed relaxation must not upload flat tetrahedral geometry");
    check(context.gpu_state.device.legacy_exchange.uploaded,
          "exchange-only mixed relaxation requires assembled MFEM CSR on CUDA");
    if (enable_device_hypre_demag) {
        check(fullmag::fem::gpu_demag_poisson_ready(context),
              "mixed relaxation with demag requires a ready device-Hypre workspace");
        check(std::string(fullmag::fem::gpu_demag_poisson_operator_mode(context)) ==
                  "device_hypre_poisson" &&
                  std::string(fullmag::fem::gpu_demag_poisson_hypre_policy(context)) ==
                  "device",
              "mixed relaxation demag must resolve to device-Hypre execution");
        const auto *workspace = fullmag::fem::workspace_ptr(context);
        check(workspace != nullptr && workspace->operator_build_count == 1u &&
                  workspace->operator_upload_count == 1u &&
                  workspace->solver_setup_count == 1u,
              "mixed relaxation demag must build, upload, and set up its operator once");
    }
    context.transfer_audit.audit.assert_no_hot_loop_host_sync = true;
    context.transfer_audit.audit.assert_no_hot_loop_compute_sync = true;
    return fixture;
}

enum class RelaxationTransferBudget {
    ExplicitRk,
    ProjectedGradientBb,
    NonlinearCg,
};

void check_relaxation_hot_loop_delta(
    const fullmag_fem_transfer_audit &before,
    const fullmag_fem_transfer_audit &after,
    RelaxationTransferBudget budget,
    const char *algorithm)
{
    const auto delta = [](uint64_t after_value, uint64_t before_value) {
        return after_value - before_value;
    };
    const uint64_t h2d_bytes =
        delta(after.hot_loop_h2d_bytes, before.hot_loop_h2d_bytes);
    const uint64_t d2h_bytes =
        delta(after.hot_loop_d2h_bytes, before.hot_loop_d2h_bytes);
    const uint64_t host_syncs =
        delta(after.hot_loop_host_sync_count, before.hot_loop_host_sync_count);
    const uint64_t control_bytes = delta(
        after.hot_loop_control_scalar_d2h_bytes,
        before.hot_loop_control_scalar_d2h_bytes);
    const uint64_t control_syncs = delta(
        after.hot_loop_control_scalar_host_sync_count,
        before.hot_loop_control_scalar_host_sync_count);
    const uint64_t max_control_syncs =
        budget == RelaxationTransferBudget::ProjectedGradientBb ? 4u :
        budget == RelaxationTransferBudget::NonlinearCg ? 3u : 0u;
    const uint64_t max_control_bytes = max_control_syncs *
        static_cast<uint64_t>(fullmag::fem::FEM_GPU_SCALAR_RESULT_SLOTS) *
        sizeof(double);
    const bool exact_zero_bulk =
        delta(after.hot_loop_exchange_h2d_bytes,
              before.hot_loop_exchange_h2d_bytes) == 0u &&
        delta(after.hot_loop_exchange_d2h_bytes,
              before.hot_loop_exchange_d2h_bytes) == 0u &&
        delta(after.hot_loop_exchange_host_sync_count,
              before.hot_loop_exchange_host_sync_count) == 0u &&
        delta(after.hot_loop_compute_h2d_bytes,
              before.hot_loop_compute_h2d_bytes) == 0u &&
        delta(after.hot_loop_compute_d2h_bytes,
              before.hot_loop_compute_d2h_bytes) == 0u &&
        delta(after.hot_loop_compute_host_sync_count,
              before.hot_loop_compute_host_sync_count) == 0u &&
        h2d_bytes == 0u && d2h_bytes == control_bytes &&
        host_syncs == control_syncs;
    const bool bounded_control_scalars =
        control_syncs <= max_control_syncs &&
        control_bytes <= max_control_bytes &&
        control_bytes % sizeof(double) == 0u &&
        ((control_syncs == 0u) == (control_bytes == 0u));
    if (!(exact_zero_bulk && bounded_control_scalars)) {
        std::fprintf(
            stderr,
            "mixed GPU relaxation transfer delta failed for %s: "
            "h2d=%llu d2h=%llu syncs=%llu control_bytes=%llu "
            "control_syncs=%llu budget_syncs=%llu budget_bytes=%llu\n",
            algorithm,
            static_cast<unsigned long long>(h2d_bytes),
            static_cast<unsigned long long>(d2h_bytes),
            static_cast<unsigned long long>(host_syncs),
            static_cast<unsigned long long>(control_bytes),
            static_cast<unsigned long long>(control_syncs),
            static_cast<unsigned long long>(max_control_syncs),
            static_cast<unsigned long long>(max_control_bytes));
        std::exit(1);
    }
    std::printf(
        "PASS: mixed GPU transfer budget %s: h2d=%llu d2h=%llu "
        "control_syncs=%llu control_bytes=%llu\n",
        algorithm,
        static_cast<unsigned long long>(h2d_bytes),
        static_cast<unsigned long long>(d2h_bytes),
        static_cast<unsigned long long>(control_syncs),
        static_cast<unsigned long long>(control_bytes));
}

double current_device_total_energy(fullmag::fem::Context &context)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    auto &gpu = context.gpu_state.device;
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(
        context.gpu_state.cuda.compute_stream);
    const int nodes = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = (nodes + 255) / 256;
    std::string error;
    check(fullmag::fem::gpu_relax_compute_effective_field_and_energy_terms(
              context, stream, nodes, blocks, error),
          error.c_str());
    fullmag::fem::GpuDirectEnergySnapshot snapshot{};
    check(fullmag::fem::gpu_direct_energy_snapshot(
              context, stream, snapshot, error),
          error.c_str());
    check(std::isfinite(snapshot.total_energy_j),
          "mixed GPU current direct-energy snapshot must be finite");
    return snapshot.total_energy_j;
#else
    (void)context;
    return 0.0;
#endif
}

void check_accepted_armijo_proof(
    const fullmag::fem::Context &context,
    double previous_energy_j,
    double published_energy_j,
    const char *algorithm)
{
    const auto &proof = context.relaxation.accepted_energy_proof;
    const bool finite = proof.available &&
        std::isfinite(proof.delta_j) &&
        std::isfinite(proof.roundoff_bound_j) &&
        std::isfinite(proof.delta_upper_j) &&
        std::isfinite(proof.armijo_rhs_j) &&
        std::isfinite(previous_energy_j) &&
        std::isfinite(published_energy_j);
    const double reconstructed_upper =
        proof.delta_j + proof.roundoff_bound_j;
    const double upper_scale = std::max({
        1.0e-300,
        std::abs(proof.delta_upper_j),
        std::abs(reconstructed_upper)});
    const double published_increment = published_energy_j - previous_energy_j;
    const double increment_scale = std::max({
        1.0e-300,
        std::abs(previous_energy_j),
        std::abs(published_energy_j),
        std::abs(proof.delta_j)});
    const double floating_slack =
        64.0 * std::numeric_limits<double>::epsilon() * increment_scale;
    const bool valid = finite && proof.roundoff_bound_j >= 0.0 &&
        std::abs(proof.delta_upper_j - reconstructed_upper) <=
            8.0 * std::numeric_limits<double>::epsilon() * upper_scale &&
        proof.delta_upper_j <= proof.armijo_rhs_j &&
        proof.armijo_rhs_j <= 0.0 &&
        std::abs(published_increment - proof.delta_j) <=
            proof.roundoff_bound_j + floating_slack;
    if (!valid) {
        std::fprintf(
            stderr,
            "mixed GPU Armijo proof failed for %s: previous=%.17g published=%.17g "
            "increment=%.17g delta=%.17g roundoff=%.17g upper=%.17g rhs=%.17g\n",
            algorithm,
            previous_energy_j,
            published_energy_j,
            published_increment,
            proof.delta_j,
            proof.roundoff_bound_j,
            proof.delta_upper_j,
            proof.armijo_rhs_j);
        std::exit(1);
    }
}

void check_device_magnetization_is_finite_unit_and_changed(
    fullmag::fem::Context &context,
    const std::vector<double> &initial,
    const char *algorithm)
{
    std::vector<double> current;
    std::string error;
    check(fullmag::fem::gpu_state_download_magnetization_aos(
              context.gpu_state.device,
              current,
              context.transfer_audit.audit,
              error),
          error.c_str());
    check(current.size() == initial.size(),
          "mixed GPU relaxation magnetization extent must remain stable");
    double max_change = 0.0;
    double max_norm_defect = 0.0;
    for (uint32_t node = 0; node < context.mesh.n_nodes; ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        const double mx = current[base];
        const double my = current[base + 1u];
        const double mz = current[base + 2u];
        check(std::isfinite(mx) && std::isfinite(my) && std::isfinite(mz),
              "mixed GPU relaxation magnetization must remain finite");
        if (context.mesh.magnetic_node_mask[node] != 0u) {
            const double norm = std::sqrt(mx * mx + my * my + mz * mz);
            max_norm_defect = std::max(max_norm_defect, std::abs(norm - 1.0));
            for (size_t component = 0; component < 3u; ++component) {
                max_change = std::max(
                    max_change,
                    std::abs(current[base + component] - initial[base + component]));
            }
        }
    }
    if (!(max_norm_defect <= 5.0e-12 && max_change > 0.0)) {
        std::fprintf(
            stderr,
            "mixed GPU relaxation state check failed for %s: norm_defect=%.17g max_change=%.17g\n",
            algorithm,
            max_norm_defect,
            max_change);
        std::exit(1);
    }
}

void check_device_hypre_demag_operator_is_reused(
    const fullmag::fem::Context &context,
    const char *algorithm)
{
    const auto *workspace = fullmag::fem::workspace_ptr(context);
    if (!(workspace != nullptr && !workspace->operator_fingerprint.empty() &&
          workspace->operator_build_count == 1u &&
          workspace->operator_upload_count == 1u &&
          workspace->solver_setup_count == 1u &&
          workspace->fresh_zero_guess_count + workspace->warm_start_count > 0u)) {
        std::fprintf(stderr, "mixed GPU demag reuse check failed for %s\n", algorithm);
        std::exit(1);
    }
}

void mixed_p1_gpu_direct_minimizers_use_device_armijo_without_tet_geometry()
{
    const char *requested_device = std::getenv("FULLMAG_MIXED_P1_ROLLBACK_DEVICE");
    if (requested_device == nullptr || std::string(requested_device) != "cuda") {
        return;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    const struct {
        fullmag_fem_relax_algorithm algorithm;
        const char *name;
    } cases[] = {
        {FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, "projected_gradient_bb"},
        {FULLMAG_FEM_RELAX_NONLINEAR_CG, "nonlinear_cg"},
    };
    for (const bool enable_device_hypre_demag : {false, true}) {
        for (const auto &item : cases) {
            auto fixture = initialize_mixed_gpu_runtime(
                FULLMAG_FEM_INTEGRATOR_HEUN, enable_device_hypre_demag);
            auto &context = fixture->context;
            const std::string case_name = std::string(item.name) +
                (enable_device_hypre_demag ? "/device_hypre" : "/exchange_only");
            const auto initial = context.state.m_xyz;
            double previous_energy_j = current_device_total_energy(context);
            const uint32_t accepted_step_count =
                item.algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG ? 2u : 1u;
            auto *const persistent_direction =
                context.gpu_state.device.relaxation.nonlinear_cg_direction.x;
            for (uint32_t accepted_step = 0; accepted_step < accepted_step_count;
                 ++accepted_step) {
                const std::string step_name = case_name + "/step_" +
                    std::to_string(accepted_step + 1u);
                if (item.algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG &&
                    accepted_step == 1u) {
                    check(context.gpu_state.device.relaxation.nonlinear_cg_direction_valid &&
                              context.relaxation.accepted_steps == 1u &&
                              context.gpu_state.device.relaxation.accepted_evaluation.valid &&
                              context.gpu_state.device.relaxation.nonlinear_cg_direction.x ==
                                  persistent_direction,
                          "mixed GPU nonlinear-CG second step must reuse persistent PR+ state");
                }
                const auto before = fullmag::fem::transfer_audit_snapshot(
                    context.transfer_audit.audit);
                fullmag_fem_step_stats stats{};
                std::string error;
                const int status = fullmag::fem::run_backend_relaxation_step(
                    context, item.algorithm, stats, error);
                if (status != FULLMAG_FEM_OK) {
                    std::fprintf(stderr, "%s step %u failed: %s\n",
                                 case_name.c_str(), accepted_step + 1u, error.c_str());
                }
                check(status == FULLMAG_FEM_OK,
                      "mixed GPU direct minimizer must execute on assembled operators");
                const auto after = fullmag::fem::transfer_audit_snapshot(
                    context.transfer_audit.audit);
                check_relaxation_hot_loop_delta(
                    before,
                    after,
                    item.algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB
                        ? RelaxationTransferBudget::ProjectedGradientBb
                        : RelaxationTransferBudget::NonlinearCg,
                    step_name.c_str());
                check(std::isfinite(stats.total_energy_joules) &&
                          std::isfinite(stats.max_torque_Apm),
                      "mixed GPU direct minimizer must publish finite energy and torque");
                check(stats.step == accepted_step + 1u &&
                          stats.time_seconds == 0.0 && stats.dt_seconds == 0.0,
                      "mixed GPU direct minimizer must accept the expected non-time step");
                check_accepted_armijo_proof(
                    context, previous_energy_j, stats.total_energy_joules,
                    step_name.c_str());
                check(context.gpu_state.device.residency.source_of_truth ==
                          FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
                      "mixed GPU direct minimizer must leave the device authoritative");
                check_device_magnetization_is_finite_unit_and_changed(
                    context, initial, case_name.c_str());
                if (item.algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG) {
                    check(context.gpu_state.device.relaxation.nonlinear_cg_direction_valid &&
                              context.gpu_state.device.relaxation.nonlinear_cg_direction.x ==
                                  persistent_direction &&
                              context.relaxation.accepted_steps == accepted_step + 1u,
                          "mixed GPU nonlinear-CG must preserve accepted PR+ direction state");
                    if (accepted_step == 1u) {
                        check(context.gpu_state.device.relaxation
                                      .accepted_evaluation_cache_hits_current_step > 0u,
                              "mixed GPU nonlinear-CG second step must consume the accepted endpoint cache");
                    }
                }
                previous_energy_j = stats.total_energy_joules;
                if (enable_device_hypre_demag) {
                    check_device_hypre_demag_operator_is_reused(
                        context, case_name.c_str());
                }
            }
        }
    }
#endif
}

void mixed_p1_gpu_llg_overdamped_runs_every_explicit_rk_without_tet_geometry()
{
    const char *requested_device = std::getenv("FULLMAG_MIXED_P1_ROLLBACK_DEVICE");
    if (requested_device == nullptr || std::string(requested_device) != "cuda") {
        return;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    const struct {
        fullmag_fem_integrator integrator;
        const char *name;
    } cases[] = {
        {FULLMAG_FEM_INTEGRATOR_HEUN, "heun"},
        {FULLMAG_FEM_INTEGRATOR_RK4, "rk4"},
        {FULLMAG_FEM_INTEGRATOR_RK23_BS, "rk23"},
        {FULLMAG_FEM_INTEGRATOR_RK45_DP54, "rk45"},
    };
    for (const bool enable_device_hypre_demag : {false, true}) {
        for (const auto &item : cases) {
            auto fixture = initialize_mixed_gpu_runtime(
                item.integrator, enable_device_hypre_demag);
            auto &context = fixture->context;
            const std::string case_name = std::string(item.name) +
                (enable_device_hypre_demag ? "/device_hypre" : "/exchange_only");
            const auto initial = context.state.m_xyz;
            const auto before =
                fullmag::fem::transfer_audit_snapshot(context.transfer_audit.audit);
            fullmag_fem_step_stats stats{};
            std::string error;
            const int status = fullmag::fem::run_backend_step(
                context, context.base_plan.dt_seconds, stats, error);
            if (status != FULLMAG_FEM_OK) {
                std::fprintf(stderr, "llg_overdamped/%s mixed GPU step failed: %s\n",
                             case_name.c_str(), error.c_str());
            }
            check(status == FULLMAG_FEM_OK,
                  "mixed GPU pure-damping explicit RK must execute on assembled operators");
            const auto after =
                fullmag::fem::transfer_audit_snapshot(context.transfer_audit.audit);
            check_relaxation_hot_loop_delta(
                before,
                after,
                RelaxationTransferBudget::ExplicitRk,
                case_name.c_str());
            check(std::isfinite(stats.total_energy_joules) &&
                      std::isfinite(stats.max_torque_Apm) &&
                      stats.step == 1u && stats.time_seconds > 0.0 &&
                      stats.dt_seconds > 0.0,
                  "mixed GPU pure-damping explicit RK must accept one finite physical-time step");
            check(context.gpu_state.device.residency.source_of_truth ==
                      FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
                  "mixed GPU explicit RK must leave the device authoritative");
            check_device_magnetization_is_finite_unit_and_changed(
                context, initial, case_name.c_str());
            if (enable_device_hypre_demag) {
                check_device_hypre_demag_operator_is_reused(
                    context, case_name.c_str());
            }
        }
    }
#endif
}

} // namespace

int main()
{
    single_element_families_preserve_geometry_dofs_vertices_and_attributes();
    zero_marker_uses_an_unoccupied_positive_air_attribute();
    legal_int_max_marker_without_air_is_preserved();
    conforming_mixed_domain_shares_faces_and_h1_dofs();
    manufactured_linear_potential_recovers_on_tet_prism_and_pyramid();
    mixed_recovery_excludes_air_from_magnetic_interface_nodes();
    parallel_recovery_matches_serial_with_caller_owned_transformations();
    recovery_source_uses_tet_geometry_and_signed_certified_quadrature();
    inverted_family_permutations_fail_closed();
    typed_boundary_uses_owner_orientation_roles_and_attributes();
    all_tet_periodic_seam_remains_an_attributed_boundary();
    malformed_face_ownership_and_marker_inputs_fail_closed();
    repeated_incomplete_facets_fail_before_runtime_publication();
    repeated_post_device_fes_failure_rolls_back_runtime_state();
    post_allocation_gpu_bootstrap_failure_rolls_back_every_owner();
    mixed_p1_gpu_direct_minimizers_use_device_armijo_without_tet_geometry();
    mixed_p1_gpu_llg_overdamped_runs_every_explicit_rk_without_tet_geometry();
    mfem_mass_weights_cover_tet_prism_and_mixed_magnetic_domains();
    distorted_prism_mass_weights_match_independent_mfem_oracle();
    mixed_core_measure_over_arity_is_not_published_as_runtime_node_volume();
    mixed_nodal_ms_and_a_follow_validated_mfem_realization();
    mixed_element_dg0_material_rejects_without_tetrahedral_realization();
    return 0;
}

#else

int main()
{
    return 0;
}

#endif
