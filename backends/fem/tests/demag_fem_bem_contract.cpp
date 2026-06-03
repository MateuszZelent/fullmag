/*
 * demag_fem_bem_contract.cpp - body-only FEM/BEM demag helper contracts.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
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

std::filesystem::path repo_root() {
    auto path = fem_source_root();
    for (int depth = 0; depth < 8; ++depth) {
        if (std::filesystem::exists(path / "Cargo.toml") &&
            std::filesystem::exists(path / "justfile")) {
            return path;
        }
        if (!path.has_parent_path()) {
            break;
        }
        path = path.parent_path();
    }
    std::fprintf(
        stderr,
        "FAIL: unable to locate repository root from %s\n",
        fem_source_root().string().c_str());
    std::exit(1);
}

fullmag::fem::Context unit_tet_context() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.mesh.elements = {0, 1, 2, 3};
    ctx.mesh.element_markers = {1};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.magnetic_node_mask = {1, 1, 1, 1};
    ctx.mesh.boundary_faces = {
        0, 2, 1,
        0, 1, 3,
        0, 3, 2,
        1, 2, 3,
    };
    ctx.mesh.boundary_markers = {1, 1, 1, 1};
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.integration_weights.mfem_lumped_mass = {1.0, 1.0, 1.0, 1.0};
    return ctx;
}

void boundary_surface_extracts_closed_body_only_tet() {
    auto ctx = unit_tet_context();
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

void dense_bem_operator_is_finite_and_has_constant_sanity() {
    auto ctx = unit_tet_context();
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

void fem_bem_energy_matches_demag_energy_contract() {
    auto ctx = unit_tet_context();
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
        "boundary_values_global(tdof) = boundary_values[i]",
        "stiffness_form.SpMat().Mult(",
        "laplace_rhs *= -1.0",
        "laplace_rhs(tdof) = boundary_values_global(tdof)",
        "u2(tdof) = boundary_values_global(tdof)",
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
        "boundary_trace.assign(boundary_nodes.size(), 0.0)",
        "boundary_trace[i] = potential(tdof)",
        "total_potential.SetSize(u1.Size())",
        "total_potential(i) = u1(i) + u2(i)",
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
        "neumann_rhs(i) = source_rhs(i)",
        "neumann_rhs(0) = 0.0",
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

void progress_report_marks_open_boundary_fem_bem_demag_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Wydzielic open-boundary FEM/BEM demag | zrobione kontraktowo |") !=
            std::string::npos,
        "progress report must mark open-boundary FEM/BEM demag split as contract-covered");
    check(
        progress.find("`fem_demag_fem_bem_contract`") != std::string::npos &&
            progress.find("`fem_interaction_docs_contract`") != std::string::npos &&
            progress.find("demag_fem_bem_surface.*") != std::string::npos &&
            progress.find("demag_fem_bem_operator.*") != std::string::npos &&
            progress.find("demag_fem_bem_linear_solve.*") != std::string::npos &&
            progress.find("demag_fem_bem_rhs.*") != std::string::npos &&
            progress.find("demag_fem_bem_boundary_values.*") != std::string::npos &&
            progress.find("demag_fem_bem_workspace.*") != std::string::npos &&
            progress.find("demag_fem_bem_potential.*") != std::string::npos &&
            progress.find("demag_fem_bem_telemetry.*") != std::string::npos &&
            progress.find("demag_fem_bem_energy.*") != std::string::npos &&
            progress.find("demag_fem_bem_solve.*") != std::string::npos,
        "progress report must cite FEM/BEM demag contracts and owner modules");
    check(
        progress.find("aktywna walidacja runtime FEM/BEM demag MFEM-stack pozostaje osobna") !=
            std::string::npos,
        "progress report must keep active FEM/BEM demag runtime validation separate from module split coverage");
}

} // namespace

int main() {
    boundary_surface_extracts_closed_body_only_tet();
    dense_bem_operator_is_finite_and_has_constant_sanity();
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
    fem_bem_telemetry_is_owned_by_telemetry_module();
    fem_bem_neumann_rhs_is_owned_by_rhs_module();
    progress_report_marks_open_boundary_fem_bem_demag_split_contract_covered();
    return 0;
}
