/*
 * demag_fem_bem_contract.cpp - body-only FEM/BEM demag helper contracts.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "fullmag_fem.h"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <cmath>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_near(double actual, double expected, double tol, const char *msg) {
    if (std::fabs(actual - expected) > tol) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g\n",
            msg,
            expected,
            actual);
        std::exit(1);
    }
}

#if FULLMAG_HAS_MFEM_STACK
void fem_bem_rejects_one_iteration_candidate_without_publishing_it() {
    fullmag::fem::Context ctx;
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_JACOBI;
    ctx.demag.solver.relative_tolerance = 1.0e-14;
    ctx.demag.solver.has_absolute_tolerance = 0;
    ctx.demag.solver.absolute_tolerance = 0.0;
    ctx.demag.solver.max_iterations = 1;
    ctx.demag.solver.print_level = 0;

    mfem::SparseMatrix op(8, 8);
    for (int i = 0; i < 8; ++i) {
        op.Add(i, i, 3.0 + static_cast<double>(i));
        if (i + 1 < 8) {
            op.Add(i, i + 1, -1.0);
            op.Add(i + 1, i, -1.0);
        }
    }
    op.Finalize();
    mfem::Vector rhs(8);
    mfem::Vector solution(8);
    for (int i = 0; i < 8; ++i) {
        rhs(i) = 1.0 + static_cast<double>(i % 3);
        solution(i) = 17.0 + static_cast<double>(i);
    }
    const mfem::Vector original(solution);
    int iterations = -1;
    double residual = -1.0;
    fullmag::fem::FemBemHypreCache *cache = nullptr;
    std::string error;
    setenv("FULLMAG_FEM_FEM_BEM_LINEAR_SOLVER", "hypre", 1);
    const bool ok = fullmag::fem::solve_demag_fem_bem_sparse_system(
        ctx, op, rhs, solution, iterations, residual, cache, error);
    unsetenv("FULLMAG_FEM_FEM_BEM_LINEAR_SOLVER");
    check(!ok, "FEM/BEM Hypre demag must reject a nonconverged one-iteration solve");
    for (int i = 0; i < solution.Size(); ++i) {
        check(solution(i) == original(i),
              "failed FEM/BEM demag must not publish the candidate solution");
    }
    check(error.find("solver_kind=") != std::string::npos, "FEM/BEM failure includes solver kind");
    check(error.find("iterations=1") != std::string::npos, "FEM/BEM failure includes iterations");
    check(error.find("residual=") != std::string::npos, "FEM/BEM failure includes residual");
    check(error.find("relative_tolerance=") != std::string::npos,
          "FEM/BEM failure includes tolerance");
    check(error.find("max_iterations=1") != std::string::npos,
          "FEM/BEM failure includes maximum iterations");
    fullmag::fem::destroy_fem_bem_hypre_cache(cache);
}

void fem_bem_neumann_rhs_zeros_every_gauge_dof() {
    mfem::Vector source(5);
    for (int i = 0; i < source.Size(); ++i) {
        source(i) = 10.0 + static_cast<double>(i);
    }
    mfem::Vector neumann;
    std::string error;
    const std::vector<int> gauges = {1, 3};
    check(
        fullmag::fem::prepare_demag_fem_bem_neumann_rhs(
            source,
            gauges,
            neumann,
            error),
        error.c_str());
    for (int i = 0; i < neumann.Size(); ++i) {
        const double expected = (i == 1 || i == 3) ? 0.0 : source(i);
        check_near(neumann(i), expected, 0.0, "all Neumann gauge DOFs are zeroed");
    }
}

void fem_bem_neumann_rhs_rejects_invalid_gauge_lists() {
    mfem::Vector source(3);
    source = 1.0;
    const std::vector<std::vector<int>> invalid_gauges = {
        {},
        {3},
        {2, 1},
        {1, 1},
    };
    for (const auto &gauges : invalid_gauges) {
        mfem::Vector neumann;
        std::string error;
        check(
            !fullmag::fem::prepare_demag_fem_bem_neumann_rhs(
                source,
                gauges,
                neumann,
                error),
            "invalid FEM/BEM gauge list must be rejected");
        check(!error.empty(), "invalid FEM/BEM gauge list must explain the error");
    }
}

void fem_bem_workspace_pins_one_gauge_per_disconnected_component() {
    mfem::Mesh mesh(3, 8, 2, 0, 3);
    const double vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {3.0, 0.0, 0.0}, {4.0, 0.0, 0.0},
        {3.0, 1.0, 0.0}, {3.0, 0.0, 1.0},
    };
    for (const auto &vertex : vertices) {
        mesh.AddVertex(vertex);
    }
    int first_tet[] = {0, 1, 2, 3};
    int second_tet[] = {4, 5, 6, 7};
    mesh.AddTet(first_tet, 1);
    mesh.AddTet(second_tet, 1);
    mesh.FinalizeTetMesh(1, 0, true);

    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);
    fullmag::fem::Context ctx;
    ctx.base_plan.fe_order = 1u;
    ctx.mfem_context.mesh = &mesh;
    ctx.mfem_context.fes = &fes;
    ctx.mesh.n_nodes = static_cast<uint32_t>(mesh.GetNV());
    ctx.mesh.n_elements = static_cast<uint32_t>(mesh.GetNE());
    ctx.mesh.nodes_xyz.reserve(static_cast<size_t>(mesh.GetNV()) * 3u);
    for (int node = 0; node < mesh.GetNV(); ++node) {
        const double *vertex = mesh.GetVertex(node);
        ctx.mesh.nodes_xyz.insert(ctx.mesh.nodes_xyz.end(), vertex, vertex + 3);
    }
    ctx.mesh.cell_types = {
        FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_TET4,
    };
    ctx.mesh.cell_offsets = {0u};
    ctx.mesh.cell_global_ordinals = {0u, 1u};
    ctx.mesh.cell_markers = {1u, 1u};
    ctx.mesh.magnetic_element_mask = {1u, 1u};
    ctx.mesh.magnetic_node_mask.assign(static_cast<size_t>(mesh.GetNV()), 1u);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices_for_element;
        mesh.GetElementVertices(element, vertices_for_element);
        for (int node : vertices_for_element) {
            ctx.mesh.cell_nodes.push_back(static_cast<uint32_t>(node));
        }
        ctx.mesh.cell_offsets.push_back(
            static_cast<uint32_t>(ctx.mesh.cell_nodes.size()));
    }

    std::string error;
    check(
        fullmag::fem::initialize_demag_fem_bem_workspace(ctx, error),
        error.c_str());
    auto *workspace = fullmag::fem::demag_fem_bem_workspace(ctx);
    check(workspace != nullptr, "disconnected FEM/BEM workspace must be published");
    check(
        workspace->neumann_gauge_tdofs.size() == 2u,
        "each disconnected magnetic component must receive one Neumann gauge");
    check(
        workspace->neumann_gauge_tdofs[0] != workspace->neumann_gauge_tdofs[1],
        "disconnected magnetic components must receive distinct gauge DOFs");
    fullmag::fem::context_destroy_demag_fem_bem(ctx);
}
#endif

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void unit_tet_context(fullmag::fem::Context &ctx) {
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.mesh.cell_nodes = {0, 1, 2, 3};
    ctx.mesh.cell_types = {FULLMAG_FEM_CELL_TET4};
    ctx.mesh.cell_offsets = {0, 4};
    ctx.mesh.cell_global_ordinals = {0};
    ctx.mesh.cell_markers = {1};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.magnetic_node_mask = {1, 1, 1, 1};
    const std::vector<std::array<uint32_t, 3>> facets = {
        {{0, 2, 1}},
        {{0, 1, 3}},
        {{0, 3, 2}},
        {{1, 2, 3}},
    };
    ctx.mesh.n_boundary_faces = static_cast<uint32_t>(facets.size());
    ctx.mesh.facet_offsets = {0};
    for (size_t i = 0; i < facets.size(); ++i) {
        ctx.mesh.facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
        ctx.mesh.facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR);
        ctx.mesh.facet_global_ordinals.push_back(static_cast<uint64_t>(i));
        ctx.mesh.facet_markers.push_back(1);
        for (uint32_t node : facets[i]) {
            ctx.mesh.facet_nodes.push_back(node);
        }
        ctx.mesh.facet_offsets.push_back(static_cast<uint32_t>(ctx.mesh.facet_nodes.size()));
    }
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.integration_weights.mfem_lumped_mass = {1.0, 1.0, 1.0, 1.0};
}

void set_tet_facets(
    fullmag::fem::Context &ctx,
    const std::vector<std::array<uint32_t, 3>> &facets)
{
    ctx.mesh.n_boundary_faces = static_cast<uint32_t>(facets.size());
    ctx.mesh.facet_types.clear();
    ctx.mesh.facet_roles.clear();
    ctx.mesh.facet_offsets = {0};
    ctx.mesh.facet_nodes.clear();
    ctx.mesh.facet_global_ordinals.clear();
    ctx.mesh.facet_markers.clear();
    for (size_t i = 0; i < facets.size(); ++i) {
        ctx.mesh.facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
        ctx.mesh.facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR);
        ctx.mesh.facet_global_ordinals.push_back(static_cast<uint64_t>(i));
        ctx.mesh.facet_markers.push_back(1);
        for (uint32_t node : facets[i]) {
            ctx.mesh.facet_nodes.push_back(node);
        }
        ctx.mesh.facet_offsets.push_back(static_cast<uint32_t>(ctx.mesh.facet_nodes.size()));
    }
}

void boundary_surface_extracts_closed_body_only_tet() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;

    check(
        fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        error.c_str());
    check(surface.boundary_nodes.size() == 4, "boundary node count");
    check(surface.triangles.size() == 4, "boundary triangle count");
    check(surface.unit_normals.size() == 4, "boundary normal count");
    check(surface.triangle_areas.size() == 4, "boundary area count");

    for (size_t face = 0; face < surface.triangles.size(); ++face) {
        check(surface.triangle_areas[face] > 0.0, "boundary triangle area positive");
        const auto n = surface.unit_normals[face];
        check_near(
            std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]),
            1.0,
            1e-12,
            "boundary normal unit length");
    }
}

void boundary_surface_rejects_incomplete_explicit_facets() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    set_tet_facets(ctx, {{{0, 2, 1}}});
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;

    check(
        !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        "incomplete explicit FEM/BEM boundary must be rejected");
    check(error.find("complete") != std::string::npos ||
              error.find("missing") != std::string::npos,
          "incomplete explicit boundary error is descriptive");
}

void boundary_surface_rejects_duplicate_explicit_facets() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    set_tet_facets(ctx, {{{0, 2, 1}, {0, 2, 1}, {0, 1, 3}, {0, 3, 2}, {1, 2, 3}}});
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;

    check(
        !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        "duplicate explicit FEM/BEM boundary must be rejected");
    check(error.find("duplicate") != std::string::npos,
          "duplicate explicit boundary error is descriptive");
}

void boundary_surface_rejects_internal_explicit_facet() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 5;
    ctx.mesh.n_elements = 2;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, -1.0,
    };
    ctx.mesh.cell_types = {FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    ctx.mesh.cell_offsets = {0u, 4u, 8u};
    ctx.mesh.cell_nodes = {
        0u, 1u, 2u, 3u,
        0u, 1u, 2u, 4u,
    };
    ctx.mesh.cell_global_ordinals = {0u, 1u};
    ctx.mesh.cell_markers = {1u, 1u};
    ctx.mesh.magnetic_element_mask = {1u, 1u};
    set_tet_facets(ctx, {{{0u, 1u, 2u}}});

    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(
        !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        "an explicit interior FEM/BEM facet must be rejected");
    check(error.find("interior") != std::string::npos ||
              error.find("nonmanifold") != std::string::npos,
          "interior explicit boundary error is descriptive");
}

void boundary_surface_rejects_extra_explicit_facet() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    ctx.mesh.n_nodes = 5;
    ctx.mesh.nodes_xyz.insert(ctx.mesh.nodes_xyz.end(), {2.0, 2.0, 2.0});
    ctx.mesh.magnetic_node_mask.push_back(0u);
    set_tet_facets(
        ctx,
        {{
            {0u, 2u, 1u},
            {0u, 1u, 3u},
            {0u, 3u, 2u},
            {1u, 2u, 3u},
            {0u, 1u, 4u},
        }});

    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(
        !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        "an extra explicit FEM/BEM facet must be rejected");
    check(error.find("not owned") != std::string::npos ||
              error.find("extra") != std::string::npos,
          "extra explicit boundary error is descriptive");
}

void boundary_surface_rejects_inconsistent_mesh_buffers() {
    for (int variant = 0; variant < 4; ++variant) {
        fullmag::fem::Context ctx;
        unit_tet_context(ctx);
        if (variant == 0) {
            ctx.mesh.cell_types.clear();
        } else if (variant == 1) {
            ctx.mesh.cell_offsets = {0u};
        } else if (variant == 2) {
            ctx.mesh.cell_nodes.pop_back();
        } else {
            ctx.mesh.magnetic_element_mask = {1u, 1u};
        }
        fullmag::fem::DemagBoundarySurface surface;
        std::string error;
        check(
            !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
            "inconsistent FEM/BEM mesh buffers must be rejected");
        check(!error.empty(), "inconsistent FEM/BEM mesh buffers must explain the error");
    }
}

void boundary_surface_rejects_bad_geometry() {
    fullmag::fem::Context nonfinite;
    unit_tet_context(nonfinite);
    nonfinite.mesh.nodes_xyz[0] = std::numeric_limits<double>::quiet_NaN();
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(
        !fullmag::fem::build_demag_boundary_surface(nonfinite, surface, error),
        "non-finite FEM/BEM geometry must be rejected");

    fullmag::fem::Context degenerate;
    unit_tet_context(degenerate);
    degenerate.mesh.nodes_xyz[11] = 0.0;
    fullmag::fem::DemagBoundarySurface degenerate_surface;
    error.clear();
    check(
        !fullmag::fem::build_demag_boundary_surface(degenerate, degenerate_surface, error),
        "degenerate FEM/BEM geometry must be rejected");
}

void boundary_surface_accepts_complete_permuted_reversed_facets() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    set_tet_facets(ctx, {{{1, 3, 2}, {3, 1, 0}, {2, 0, 3}, {1, 0, 2}}});
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;

    check(
        fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        error.c_str());
    check(surface.triangles.size() == 4, "permuted/reversed complete boundary triangle count");
}

void boundary_surface_rejects_nonmanifold_volume_faces() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 6;
    ctx.mesh.n_elements = 3;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, -1.0,
        0.0, 0.0, 2.0,
    };
    ctx.mesh.cell_types = {
        FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_TET4,
    };
    ctx.mesh.cell_offsets = {0, 4, 8, 12};
    ctx.mesh.cell_nodes = {
        0, 1, 2, 3,
        0, 1, 2, 4,
        0, 1, 2, 5,
    };
    ctx.mesh.cell_global_ordinals = {0, 1, 2};
    ctx.mesh.cell_markers = {1, 1, 1};
    ctx.mesh.magnetic_element_mask = {1, 1, 1};

    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(
        !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        "a volume face with three active owners must be rejected");
    check(error.find("nonmanifold") != std::string::npos,
          "nonmanifold volume error is descriptive");
}

void boundary_surface_rejects_non_tet_active_topology() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    ctx.mesh.cell_types = {FULLMAG_FEM_CELL_PRISM6};
    ctx.mesh.cell_offsets = {0, 6};
    ctx.mesh.cell_nodes = {0, 1, 2, 3, 0, 1};
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;

    check(
        !fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        "active non-tet topology must be rejected by FEM/BEM");
    check(error.find("TET4") != std::string::npos ||
              error.find("tetra") != std::string::npos,
          "non-tet topology error is descriptive");
}

void boundary_surface_is_scale_invariant() {
    for (double factor : {1.0e-100, 1.0e100}) {
        fullmag::fem::Context ctx;
        unit_tet_context(ctx);
        for (double &coordinate : ctx.mesh.nodes_xyz) {
            coordinate *= factor;
        }
        fullmag::fem::DemagBoundarySurface surface;
        std::string error;
        check(
            fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
            error.c_str());
        for (size_t face = 0; face < surface.triangles.size(); ++face) {
            const auto normal = surface.unit_normals[face];
            check(std::isfinite(surface.triangle_areas[face]) &&
                      surface.triangle_areas[face] > 0.0,
                  "scaled boundary triangle area remains finite and positive");
            check(std::isfinite(normal[0]) && std::isfinite(normal[1]) &&
                      std::isfinite(normal[2]),
                  "scaled boundary normal remains finite");
            check_near(
                std::hypot(std::hypot(normal[0], normal[1]), normal[2]),
                1.0,
                1e-12,
                "scaled boundary normal remains unit length");
        }
    }
}

void dense_bem_operator_is_finite_and_has_constant_sanity() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(fullmag::fem::build_demag_boundary_surface(ctx, surface, error), error.c_str());

    fullmag::fem::DenseDemagBemOperator op;
    check(op.build(ctx, surface, error), error.c_str());
    check(op.size() == 4, "dense BEM operator size");
    check(op.matrix_row_major().size() == 16, "dense BEM matrix entries");
    for (double entry : op.matrix_row_major()) {
        check(std::isfinite(entry), "dense BEM entry finite");
    }

    std::vector<double> input(op.size(), -1.0);
    std::vector<double> output;
    check(op.apply(input, output, error), error.c_str());
    check(output.size() == input.size(), "dense BEM output size");
    double sum = 0.0;
    for (double value : output) {
        check(std::isfinite(value), "dense BEM output finite");
        sum += value;
    }
    check_near(sum, static_cast<double>(op.size()), 5e-3 * op.size(), "dense BEM constant sanity");
}

void dense_bem_rejects_boundary_limit_before_allocation() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(fullmag::fem::build_demag_boundary_surface(ctx, surface, error), error.c_str());

    fullmag::fem::DenseDemagBemOperator op(3u);
    check(
        !op.build(ctx, surface, error),
        "dense BEM must reject a boundary larger than its configured limit");
    check(error.find("max_boundary_nodes") != std::string::npos,
          "dense BEM limit error names the configured limit");
}

void hierarchical_bem_matches_dense_reference_and_is_deterministic() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(fullmag::fem::build_demag_boundary_surface(ctx, surface, error), error.c_str());

    fullmag::fem::DenseDemagBemOperator dense;
    check(dense.build(ctx, surface, error), error.c_str());

    fullmag::fem::HierarchicalDemagBemOptions options;
    options.admissibility_eta = 0.5;
    options.leaf_size = 1;
    options.max_rank = 8;
    options.relative_tolerance = 1e-12;
    options.max_memory_bytes = 1u << 20;

    fullmag::fem::HierarchicalDemagBemOperator hierarchical;
    check(hierarchical.build(ctx, surface, options, error), error.c_str());
    check(hierarchical.size() == dense.size(), "hierarchical BEM operator size");
    check(hierarchical.near_block_count() > 0u, "hierarchical BEM has near blocks");
    check(hierarchical.far_block_count() > 0u, "hierarchical BEM has far blocks");
    check(hierarchical.max_rank_observed() > 0u, "hierarchical BEM records far rank");
    check(std::isfinite(hierarchical.relative_error_estimate()),
          "hierarchical BEM reports a finite error estimate");
    check(hierarchical.mode() == std::string("hierarchical_h2"),
          "hierarchical BEM exposes its resolved operator mode");
    check(
        hierarchical.fingerprint().rfind("sha256:", 0) == 0 &&
            hierarchical.fingerprint().size() == 71u,
        "hierarchical BEM publishes a canonical SHA-256 fingerprint");

    const std::vector<double> input = {0.25, -0.5, 1.0, 2.0};
    std::vector<double> dense_output;
    std::vector<double> hierarchical_output(hierarchical.size(), 0.0);
    check(dense.apply(input, dense_output, error), error.c_str());
    check(hierarchical.apply(input, hierarchical_output, error), error.c_str());
    check(hierarchical_output.size() == dense_output.size(),
          "hierarchical BEM output size");
    for (size_t i = 0; i < dense_output.size(); ++i) {
        check_near(hierarchical_output[i], dense_output[i], 1e-10,
                   "hierarchical BEM matches dense reference");
    }

    fullmag::fem::HierarchicalDemagBemOperator second;
    check(second.build(ctx, surface, options, error), error.c_str());
    check(second.fingerprint() == hierarchical.fingerprint(),
          "hierarchical BEM build is deterministic");
    check(second.near_block_count() == hierarchical.near_block_count(),
          "hierarchical BEM near block partition is deterministic");
    check(second.far_block_count() == hierarchical.far_block_count(),
          "hierarchical BEM far block partition is deterministic");
}

void hierarchical_bem_rejects_invalid_budget_before_build() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(fullmag::fem::build_demag_boundary_surface(ctx, surface, error), error.c_str());

    fullmag::fem::HierarchicalDemagBemOptions options;
    options.max_memory_bytes = 1u;
    fullmag::fem::HierarchicalDemagBemOperator operator_instance;
    check(!operator_instance.build(ctx, surface, options, error),
          "hierarchical BEM must reject an impossible memory budget");
    check(error.find("memory") != std::string::npos ||
              error.find("budget") != std::string::npos,
          "hierarchical BEM budget error is descriptive");
}

void fem_bem_energy_matches_demag_energy_contract() {
    fullmag::fem::Context ctx;
    unit_tet_context(ctx);
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    const std::vector<double> h = {
        -2.0, 0.0, 0.0,
        -2.0, 0.0, 0.0,
        -2.0, 0.0, 0.0,
        -2.0, 0.0, 0.0,
    };
    const double expected = fullmag::fem::demag_poisson_energy_from_field(ctx, m, h);
    check_near(
        fullmag::fem::demag_fem_bem_energy_from_field(ctx, m, h),
        expected,
        std::abs(expected) * 1e-12,
        "FEM/BEM energy sign follows demag contract");
}

void fem_bem_energy_is_owned_by_energy_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_energy.cpp");
    const std::string energy_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_energy.hpp");

    check(
        fem_bem.find("double demag_fem_bem_energy_from_field(") == std::string::npos,
        "FEM/BEM energy wrapper must not be defined in demag_fem_bem.cpp");
    check(
        energy.find("double demag_fem_bem_energy_from_field(") != std::string::npos,
        "FEM/BEM energy wrapper must be defined in demag_fem_bem_energy.cpp");
    check(
        energy.find("return demag_poisson_energy_from_field(ctx, m_xyz, h_demag_xyz, energy_threads);") !=
            std::string::npos,
        "FEM/BEM energy wrapper must directly delegate to the shared Poisson energy owner");
    check(
        energy_header.find("Compute demag energy for a FEM/BEM recovered field") !=
            std::string::npos,
        "FEM/BEM energy header must document its contract");
}

void fem_bem_aggregate_header_documents_submodule_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.hpp");

    check(
        aggregate_header.find("does not define surface extraction") != std::string::npos,
        "FEM/BEM aggregate header must document its non-owning surface boundary");
    check(
        aggregate_header.find("BEM operator assembly") != std::string::npos,
        "FEM/BEM aggregate header must document its non-owning operator boundary");
    check(
        aggregate_header.find("solves, potential transfer, recovery, energy, or telemetry") !=
            std::string::npos,
        "FEM/BEM aggregate header must document its non-owning boundary");
    check(
        aggregate_header.find("demag_fem_bem_surface.*") != std::string::npos,
        "FEM/BEM aggregate header must name the surface owner");
    check(
        aggregate_header.find("demag_fem_bem_solve.*") != std::string::npos,
        "FEM/BEM aggregate header must name the solve owner");
    check(
        aggregate_header.find("demag_fem_bem_energy.*") != std::string::npos,
        "FEM/BEM aggregate header must name the energy owner");
}

void fem_bem_leaf_headers_document_submodule_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string surface_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_surface.hpp");
    const std::string operator_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_operator.hpp");
    const std::string boundary_values_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_boundary_values.hpp");
    const std::string solve_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_solve.hpp");
    const std::string energy_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_energy.hpp");

    check(
        surface_header.find("does not assemble BEM operators, solve sparse systems, transfer boundary values, compute energy, or orchestrate solves") != std::string::npos,
        "FEM/BEM surface header must document its non-owning solver boundary");
    check(
        operator_header.find("does not extract boundary surfaces, solve sparse systems, transfer boundary values, compute energy, or manage workspace") != std::string::npos,
        "FEM/BEM operator header must document its non-owning module boundary");
    check(
        boundary_values_header.find("does not extract boundary surfaces, solve sparse systems, combine potentials, recover fields, compute energy, or publish telemetry") != std::string::npos,
        "FEM/BEM boundary-values header must document its non-owning module boundary");
    check(
        solve_header.find("does not extract surfaces, assemble dense BEM operators, own sparse solver internals, define boundary-value helpers, own workspace lifecycle, or compute energy formula") != std::string::npos,
        "FEM/BEM solve header must document its non-owning helper boundary");
    check(
        energy_header.find("does not extract surfaces, assemble operators, solve sparse systems, recover fields, or publish telemetry") != std::string::npos,
        "FEM/BEM energy header must document its non-owning compute boundary");
}

void fem_bem_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string surface =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_surface.cpp");
    const std::string op =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_operator.cpp");
    const std::string linear_solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_linear_solve.cpp");
    const std::string boundary_values =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_boundary_values.cpp");
    const std::string workspace =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_workspace.cpp");
    const std::string potential =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_potential.cpp");
    const std::string telemetry =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_telemetry.cpp");
    const std::string rhs =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_rhs.cpp");
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_solve.cpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_energy.cpp");

    check(
        aggregate.find("FEM/BEM demag aggregate source contract") != std::string::npos,
        "FEM/BEM aggregate source file must document its source contract");
    check(
        aggregate.find("does not extract surfaces, assemble BEM operators, solve sparse systems, transfer boundary values, manage workspace, combine potentials, prepare RHS, compute energy, publish telemetry, or orchestrate solves") != std::string::npos,
        "FEM/BEM aggregate source file must document its non-owning module boundary");
    check(
        surface.find("FEM/BEM demag surface source contract") != std::string::npos,
        "FEM/BEM surface source file must document its source contract");
    check(
        surface.find("does not assemble BEM operators, solve sparse systems, transfer boundary values, compute energy, or orchestrate solves") != std::string::npos,
        "FEM/BEM surface source file must document its non-owning solver boundary");
    check(
        op.find("FEM/BEM demag dense-operator source contract") != std::string::npos,
        "FEM/BEM operator source file must document its source contract");
    check(
        op.find("does not extract boundary surfaces, solve sparse systems, transfer boundary values, compute energy, or manage workspace") != std::string::npos,
        "FEM/BEM operator source file must document its non-owning module boundary");
    check(
        linear_solve.find("FEM/BEM demag linear-solve source contract") != std::string::npos,
        "FEM/BEM linear-solve source file must document its source contract");
    check(
        linear_solve.find("does not assemble boundary operators, prepare RHS, transfer boundary values, recover fields, compute energy, or publish telemetry") != std::string::npos,
        "FEM/BEM linear-solve source file must document its non-owning module boundary");
    check(
        boundary_values.find("FEM/BEM demag boundary-values source contract") != std::string::npos,
        "FEM/BEM boundary-values source file must document its source contract");
    check(
        boundary_values.find("does not extract boundary surfaces, solve sparse systems, combine potentials, recover fields, compute energy, or publish telemetry") != std::string::npos,
        "FEM/BEM boundary-values source file must document its non-owning module boundary");
    check(
        workspace.find("FEM/BEM demag workspace source contract") != std::string::npos,
        "FEM/BEM workspace source file must document its source contract");
    check(
        workspace.find("does not run per-step solves, transfer boundary values, combine potentials, recover fields, compute energy, or publish telemetry") != std::string::npos,
        "FEM/BEM workspace source file must document its non-owning solve boundary");
    check(
        potential.find("FEM/BEM demag potential source contract") != std::string::npos,
        "FEM/BEM potential source file must document its source contract");
    check(
        potential.find("does not solve sparse systems, transfer Dirichlet boundary values, recover H_demag, compute energy, or publish telemetry") != std::string::npos,
        "FEM/BEM potential source file must document its non-owning module boundary");
    check(
        telemetry.find("FEM/BEM demag telemetry source contract") != std::string::npos,
        "FEM/BEM telemetry source file must document its source contract");
    check(
        telemetry.find("does not extract surfaces, solve sparse systems, transfer potentials, recover fields, or compute energy") != std::string::npos,
        "FEM/BEM telemetry source file must document its non-owning compute boundary");
    check(
        rhs.find("FEM/BEM demag RHS source contract") != std::string::npos,
        "FEM/BEM RHS source file must document its source contract");
    check(
        rhs.find("does not assemble source RHS, solve sparse systems, transfer boundary values, recover fields, compute energy, or publish telemetry") != std::string::npos,
        "FEM/BEM RHS source file must document its non-owning module boundary");
    check(
        solve.find("FEM/BEM demag solve orchestration source contract") != std::string::npos,
        "FEM/BEM solve source file must document its source contract");
    check(
        solve.find("does not extract surfaces, assemble dense BEM operators, own sparse solver internals, define boundary-value helpers, own workspace lifecycle, or compute energy formula") != std::string::npos,
        "FEM/BEM solve source file must document its non-owning helper boundary");
    check(
        energy.find("FEM/BEM demag energy source contract") != std::string::npos,
        "FEM/BEM energy source file must document its source contract");
    check(
        energy.find("does not extract surfaces, assemble operators, solve sparse systems, recover fields, or publish telemetry") != std::string::npos,
        "FEM/BEM energy source file must document its non-owning compute boundary");
}

void fem_bem_compute_wrapper_is_owned_by_solve_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_solve.cpp");
    const std::string solve_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_solve.hpp");

    const char *symbols[] = {
        "bool context_compute_demag_fem_bem(",
        "prepare_demag_fem_bem_neumann_rhs(",
        "extract_demag_fem_bem_boundary_trace(",
        "workspace->boundary_operator.apply(",
        "prepare_demag_fem_bem_dirichlet_rhs(",
        "combine_demag_fem_bem_total_potential(",
        "recover_demag_poisson_field(",
        "publish_demag_fem_bem_solver_stats(",
        "accumulate_demag_fem_bem_phase_timings(",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM compute orchestration must not be defined in demag_fem_bem.cpp");
        check(
            solve.find(symbol) != std::string::npos,
            "FEM/BEM compute orchestration must be defined in demag_fem_bem_solve.cpp");
    }
    check(
        solve_header.find("Compute one Fredkin-Koehler FEM/BEM demag field") !=
            std::string::npos,
        "FEM/BEM solve header must document its contract");
}

void fem_bem_boundary_surface_is_owned_by_surface_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string surface =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_surface.cpp");

    const char *symbols[] = {
        "struct FaceRecord",
        "bool build_face_records(",
        "const FaceRecord *find_face_record(",
        "bool add_oriented_boundary_face(",
        "bool build_demag_boundary_surface(",
        "surface.global_to_boundary.assign",
        "surface.triangles.push_back",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM boundary surface extraction must not be defined in demag_fem_bem.cpp");
        check(
            surface.find(symbol) != std::string::npos,
            "FEM/BEM boundary surface extraction must be defined in demag_fem_bem_surface.cpp");
    }
}

void fem_bem_dense_operator_is_owned_by_operator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string op =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_operator.cpp");

    const char *symbols[] = {
        "double solid_angle_magnitude(",
        "std::array<double, 3> lindholm_linear_triangle_weights(",
        "double boundary_node_solid_angle_sum(",
        "bool DenseDemagBemOperator::build(",
        "bool DenseDemagBemOperator::apply(",
        "matrix_.assign(",
        "const double omega_sum = boundary_node_solid_angle_sum",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM dense BEM operator must not be defined in demag_fem_bem.cpp");
        check(
            op.find(symbol) != std::string::npos,
            "FEM/BEM dense BEM operator must be defined in demag_fem_bem_operator.cpp");
    }
}

void fem_bem_sparse_solve_is_owned_by_linear_solve_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_linear_solve.cpp");

    const char *symbols[] = {
        "bool solve_demag_fem_bem_sparse_system(",
        "bool solve_demag_fem_bem_serial_system(",
        "bool should_use_hypre_fem_bem_solver(",
        "void destroy_fem_bem_hypre_cache(",
        "struct FemBemHypreCache",
        "FULLMAG_FEM_FEM_BEM_LINEAR_SOLVER",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM sparse solve policy must not be defined in demag_fem_bem.cpp");
        check(
            solve.find(symbol) != std::string::npos,
            "FEM/BEM sparse solve policy must be defined in demag_fem_bem_linear_solve.cpp");
    }
}

void fem_bem_boundary_value_rhs_is_owned_by_boundary_values_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string boundary_values =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_boundary_values.cpp");

    const char *symbols[] = {
        "bool set_demag_fem_bem_boundary_values(",
        "bool prepare_demag_fem_bem_dirichlet_rhs(",
        "global_data[tdof] = boundary_values[i]",
        "stiffness_form.SpMat().Mult(",
        "laplace_rhs *= -1.0",
        "laplace_data[tdof] = global_data[tdof]",
        "u2_data[tdof] = global_data[tdof]",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM boundary value and Dirichlet RHS preparation must not be defined in demag_fem_bem.cpp");
        check(
            boundary_values.find(symbol) != std::string::npos,
            "FEM/BEM boundary value and Dirichlet RHS preparation must be defined in demag_fem_bem_boundary_values.cpp");
    }
}

void fem_bem_workspace_lifecycle_is_owned_by_workspace_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string workspace =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_workspace.cpp");
    const std::string workspace_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_workspace.hpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");

    check(
        fem_bem.find("struct DemagFemBemWorkspace") == std::string::npos,
        "FEM/BEM workspace struct must not be defined in demag_fem_bem.cpp");
    check(
        workspace_header.find("struct DemagFemBemWorkspace") != std::string::npos,
        "FEM/BEM workspace struct must be declared in demag_fem_bem_workspace.hpp");
    check(
        workspace_header.find("struct DemagFemBemRuntimeState") != std::string::npos,
        "FEM/BEM runtime state must be declared in demag_fem_bem_workspace.hpp");
    check(
        workspace_header.find("DemagFemBemWorkspace *workspace") != std::string::npos,
        "FEM/BEM runtime state must own the workspace pointer");
    check(
        workspace_header.find("bool ready") != std::string::npos,
        "FEM/BEM runtime state must own readiness");
    check(
        workspace_header.find("neumann_gauge_tdofs") != std::string::npos,
        "FEM/BEM workspace must own all Neumann gauge true DOFs");
    check(
        context_header.find("DemagFemBemRuntimeState demag_fem_bem") != std::string::npos,
        "Context must store FEM/BEM demag runtime through its owner");
    check(
        context_header.find("mfem_demag_fem_bem_workspace") == std::string::npos,
        "Context must not own flat FEM/BEM demag workspace pointer");
    check(
        context_header.find("bool demag_fem_bem_ready") == std::string::npos,
        "Context must not own flat FEM/BEM demag readiness");

    const char *symbols[] = {
        "bool initialize_demag_fem_bem_workspace(",
        "void destroy_demag_fem_bem_workspace(",
        "bool context_initialize_demag_fem_bem(",
        "void context_destroy_demag_fem_bem(",
        "std::make_unique<mfem::H1_FECollection>",
        "AddDomainIntegrator(new mfem::DiffusionIntegrator())",
        "collect_neumann_gauge_nodes(",
        "build_node_to_true_dof_map(",
        "workspace->neumann_gauge_tdofs.reserve",
        "for (int tdof : workspace->neumann_gauge_tdofs)",
        "eliminate_row_col_zero(*workspace->dirichlet_op, tdof)",
        "ctx.demag_fem_bem.workspace = workspace.release()",
        "ctx.demag_fem_bem.ready = true",
        "ctx.demag_fem_bem.ready = false",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM workspace lifecycle must not be defined in demag_fem_bem.cpp");
        check(
            workspace.find(symbol) != std::string::npos,
            "FEM/BEM workspace lifecycle must be defined in demag_fem_bem_workspace.cpp");
    }
}

void fem_bem_potential_trace_is_owned_by_potential_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string potential =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_potential.cpp");

    const char *symbols[] = {
        "bool extract_demag_fem_bem_boundary_trace(",
        "bool combine_demag_fem_bem_total_potential(",
        "boundary_trace.size() != boundary_tdofs.size()",
        "std::fill(boundary_trace.begin(), boundary_trace.end(), 0.0)",
        "boundary_trace[i] = potential_data[tdof]",
        "total_potential.SetSize(u1.Size())",
        "total_data[i] = u1_data[i] + u2_data[i]",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM boundary trace and total potential helpers must not be defined in demag_fem_bem.cpp");
        check(
            potential.find(symbol) != std::string::npos,
            "FEM/BEM boundary trace and total potential helpers must be defined in demag_fem_bem_potential.cpp");
    }
}

void fem_bem_hierarchical_apply_reuses_workspace_scratch() {
    const std::filesystem::path root = fem_source_root();
    const std::string operator_source = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_operator.cpp");
    const std::string workspace_header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_workspace.hpp");
    const size_t apply_begin = operator_source.find(
        "bool HierarchicalDemagBemOperator::apply(");
    const size_t apply_end = operator_source.find(
        "uint32_t HierarchicalDemagBemOperator::size() const", apply_begin);
    check(
        apply_begin != std::string::npos && apply_end != std::string::npos &&
            apply_end > apply_begin,
        "hierarchical BEM apply source must remain discoverable");
    const std::string apply_source = operator_source.substr(
        apply_begin,
        apply_end - apply_begin);
    check(
        apply_source.find("std::vector<double> projected") == std::string::npos,
        "hierarchical BEM apply must not allocate a projected scratch vector");
    check(
        apply_source.find("u2_boundary.assign") == std::string::npos,
        "hierarchical BEM apply must not resize the output on every step");
    check(
        apply_source.find("impl_->projected") != std::string::npos,
        "hierarchical BEM apply must use persistent projected scratch");
    check(
        apply_source.find("u2_boundary.size()") != std::string::npos,
        "hierarchical BEM apply must validate the preallocated output size");
    check(
        workspace_header.find("std::vector<double> boundary_u1") != std::string::npos &&
            workspace_header.find("std::vector<double> boundary_u2") != std::string::npos,
        "FEM/BEM workspace must own persistent boundary scratch vectors");
}

void fem_bem_telemetry_is_owned_by_telemetry_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string telemetry =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_telemetry.cpp");
    const std::string telemetry_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_telemetry.hpp");

    check(
        fem_bem.find("struct DemagFemBemSolveTelemetry") == std::string::npos,
        "FEM/BEM solve telemetry struct must not be defined in demag_fem_bem.cpp");
    check(
        telemetry_header.find("struct DemagFemBemSolveTelemetry") != std::string::npos,
        "FEM/BEM solve telemetry struct must be declared in demag_fem_bem_telemetry.hpp");

    const char *symbols[] = {
        "void publish_demag_fem_bem_solver_stats(",
        "void accumulate_demag_fem_bem_phase_timings(",
        "ctx.poisson_demag.solves_current_step += 2u",
        "ctx.poisson_demag.last_iterations =",
        "ctx.poisson_demag.last_residual =",
        "ctx.poisson_demag.last_solver_apply_wall_time_ns =",
        "accumulate_demag_poisson_phase_timings(",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM solver stats and timing publication must not be defined in demag_fem_bem.cpp");
        check(
            telemetry.find(symbol) != std::string::npos,
            "FEM/BEM solver stats and timing publication must be defined in demag_fem_bem_telemetry.cpp");
    }
}

void fem_bem_neumann_rhs_is_owned_by_rhs_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string fem_bem =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem.cpp");
    const std::string rhs =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_fem_bem_rhs.cpp");

    const char *symbols[] = {
        "bool prepare_demag_fem_bem_neumann_rhs(",
        "neumann_rhs.SetSize(source_rhs.Size())",
        "neumann_data[i] = src_data[i]",
        "for (int gauge_tdof : gauge_tdofs)",
        "neumann_data[gauge_tdof] = 0.0",
    };
    for (const char *symbol : symbols) {
        check(
            fem_bem.find(symbol) == std::string::npos,
            "FEM/BEM Neumann RHS preparation must not be defined in demag_fem_bem.cpp");
        check(
            rhs.find(symbol) != std::string::npos,
            "FEM/BEM Neumann RHS preparation must be defined in demag_fem_bem_rhs.cpp");
    }
}

} // namespace

int main() {
#if FULLMAG_HAS_MFEM_STACK
    fem_bem_rejects_one_iteration_candidate_without_publishing_it();
    fem_bem_neumann_rhs_zeros_every_gauge_dof();
    fem_bem_neumann_rhs_rejects_invalid_gauge_lists();
    fem_bem_workspace_pins_one_gauge_per_disconnected_component();
#endif
    boundary_surface_extracts_closed_body_only_tet();
    boundary_surface_rejects_incomplete_explicit_facets();
    boundary_surface_rejects_duplicate_explicit_facets();
    boundary_surface_rejects_internal_explicit_facet();
    boundary_surface_rejects_extra_explicit_facet();
    boundary_surface_rejects_inconsistent_mesh_buffers();
    boundary_surface_rejects_bad_geometry();
    boundary_surface_accepts_complete_permuted_reversed_facets();
    boundary_surface_rejects_nonmanifold_volume_faces();
    boundary_surface_rejects_non_tet_active_topology();
    boundary_surface_is_scale_invariant();
    dense_bem_operator_is_finite_and_has_constant_sanity();
    dense_bem_rejects_boundary_limit_before_allocation();
    hierarchical_bem_matches_dense_reference_and_is_deterministic();
    hierarchical_bem_rejects_invalid_budget_before_build();
    fem_bem_energy_matches_demag_energy_contract();
    fem_bem_energy_is_owned_by_energy_module();
    fem_bem_aggregate_header_documents_submodule_boundaries();
    fem_bem_leaf_headers_document_submodule_boundaries();
    fem_bem_source_files_document_module_boundaries();
    fem_bem_compute_wrapper_is_owned_by_solve_module();
    fem_bem_boundary_surface_is_owned_by_surface_module();
    fem_bem_dense_operator_is_owned_by_operator_module();
    fem_bem_sparse_solve_is_owned_by_linear_solve_module();
    fem_bem_boundary_value_rhs_is_owned_by_boundary_values_module();
    fem_bem_workspace_lifecycle_is_owned_by_workspace_module();
    fem_bem_potential_trace_is_owned_by_potential_module();
    fem_bem_hierarchical_apply_reuses_workspace_scratch();
    fem_bem_telemetry_is_owned_by_telemetry_module();
    fem_bem_neumann_rhs_is_owned_by_rhs_module();
    return 0;
}
