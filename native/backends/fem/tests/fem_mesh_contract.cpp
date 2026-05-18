/*
 * fem_mesh_contract.cpp - native FEM mesh topology ownership contract.
 *
 * Context construction may orchestrate mesh import, but periodic topology
 * reduction and nodal-volume geometry helpers belong to the FEM mesh core
 * module. This keeps Context moving toward the documented facade role.
 */

#include "context.hpp"
#include "core/fem_mesh.hpp"

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

void fem_mesh_topology_helpers_are_owned_by_core_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string fem_mesh = read_text_file(root / "core" / "fem_mesh.cpp");
    const std::string fem_mesh_header = read_text_file(root / "core" / "fem_mesh.hpp");
    const std::string aos =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "aos_field.cpp");

    const char *mesh_symbols[] = {
        "bool initialize_mesh_plan_fields(",
        "void initialize_magnetic_masks(",
        "bool validate_periodic_plan_compatibility(",
        "bool build_static_periodic_reduction(",
        "bool validate_periodic_scalar_field_classes(",
        "void compute_node_volumes(",
    };
    for (const char *symbol : mesh_symbols) {
        check(
            context.find(symbol) == std::string::npos,
            "Context must not define FEM mesh topology helper");
        check(
            fem_mesh.find(symbol) != std::string::npos,
            "FEM mesh topology helper must be defined in core/fem_mesh.cpp");
    }

    check(
        context.find("void project_static_periodic_aos(") == std::string::npos,
        "Context must use the AoS runtime periodic projection helper");
    check(
        context.find("void copy_optional_span(") == std::string::npos,
        "Context must not define mesh optional-span copy helper");
    check(
        context.find("ctx.mesh.periodic_node_pairs.assign(") == std::string::npos,
        "Context must not own periodic node-pair plan import");
    check(
        context.find("periodic_node_pairs pointer is null") == std::string::npos,
        "Context must not own periodic node-pair pointer validation");
    check(
        context.find("Build magnetic element mask") == std::string::npos,
        "Context must not own magnetic mask policy comments");
    check(
        context.find("ctx.mesh.magnetic_element_mask.assign(") == std::string::npos,
        "Context must not own magnetic element mask construction");
    check(
        context.find("native FEM time-domain periodic_node_pairs currently support only") ==
            std::string::npos,
        "Context must not own periodic capability policy");
    check(
        context.find("Validate base material fields per periodic class") == std::string::npos,
        "Context must not own periodic material class validation orchestration");
    check(
        fem_mesh.find("FEM mesh core source contract") != std::string::npos,
        "FemMesh source file must document its source contract");
    check(
        fem_mesh.find("does not own base scalar plan fields, material fields, state initialization, field buffers, runtime devices, or interaction physics") != std::string::npos,
        "FemMesh source file must document its non-owning module boundary");
    check(
        aos.find("void project_static_periodic_aos(") != std::string::npos,
        "AoS periodic projection helper must remain in runtime/aos_field.cpp");
    check(
        fem_mesh_header.find("Own FEM mesh topology helpers") != std::string::npos,
        "FemMesh header must document its topology contract");
    check(
        fem_mesh_header.find("struct FemMeshRuntimeState") != std::string::npos,
        "FemMesh header must declare the runtime mesh owner");
    check(
        fem_mesh_header.find("std::vector<double> nodes_xyz") != std::string::npos,
        "FemMesh runtime state must own node coordinates");
    check(
        fem_mesh_header.find("std::vector<uint32_t> elements") != std::string::npos,
        "FemMesh runtime state must own tetrahedral connectivity");
    check(
        fem_mesh_header.find("std::unordered_set<uint32_t> periodic_boundary_marker_set") !=
            std::string::npos,
        "FemMesh runtime state must own periodic boundary marker set");
    check(
        fem_mesh_header.find("std::vector<uint8_t> magnetic_node_mask") !=
            std::string::npos,
        "FemMesh runtime state must own magnetic node mask");
    check(
        fem_mesh_header.find("std::vector<double> node_volumes") != std::string::npos,
        "FemMesh runtime state must own nodal dual volumes");
    check(
        context_header.find("FemMeshRuntimeState mesh{}") != std::string::npos,
        "Context must store FEM mesh runtime state as mesh");
    check(
        context_header.find("std::vector<double> nodes_xyz;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> elements;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> element_markers;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> boundary_faces;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> boundary_markers;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> periodic_node_pairs;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> periodic_reduced_node;") == std::string::npos &&
            context_header.find("std::vector<uint32_t> periodic_representative_nodes;") == std::string::npos &&
            context_header.find("uint32_t periodic_reduced_node_count") == std::string::npos &&
            context_header.find("std::unordered_set<uint32_t> periodic_boundary_marker_set;") == std::string::npos &&
            context_header.find("std::vector<uint8_t> magnetic_element_mask;") == std::string::npos &&
            context_header.find("std::vector<uint8_t> magnetic_node_mask;") == std::string::npos &&
            context_header.find("std::vector<double> node_volumes;") == std::string::npos,
        "Context must not keep flat mesh topology, mask, periodic, or nodal-volume fields");
    check(
        fem_mesh_header.find(
            "It does not own base scalar plan fields, material fields, state") !=
                std::string::npos &&
            fem_mesh_header.find(
                "initialization, field buffers, runtime devices, or interaction physics") !=
                std::string::npos,
        "FemMesh header must document its non-owning module boundary");
}

void mesh_plan_import_copies_geometry_markers_and_periodic_pairs() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 3;
    ctx.n_elements = 1;
    ctx.n_boundary_faces = 1;

    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    const uint32_t elements[] = {0u, 1u, 2u, 0u};
    const uint32_t element_markers[] = {7u};
    const uint32_t boundary_faces[] = {0u, 1u, 2u};
    const uint32_t boundary_markers[] = {3u};
    const uint32_t periodic_node_pairs[] = {1u, 2u};
    const uint32_t periodic_boundary_markers[] = {11u, 12u};

    fullmag_fem_mesh_desc mesh{};
    mesh.nodes_xyz = nodes;
    mesh.n_nodes = ctx.n_nodes;
    mesh.elements = elements;
    mesh.n_elements = ctx.n_elements;
    mesh.element_markers = element_markers;
    mesh.boundary_faces = boundary_faces;
    mesh.n_boundary_faces = ctx.n_boundary_faces;
    mesh.boundary_markers = boundary_markers;
    mesh.periodic_node_pairs = periodic_node_pairs;
    mesh.n_periodic_node_pairs = 1;
    mesh.periodic_boundary_pair_markers = periodic_boundary_markers;
    mesh.periodic_boundary_pair_count = 1;

    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, mesh, error), error.c_str());

    check(ctx.mesh.nodes_xyz == std::vector<double>(nodes, nodes + 9), "mesh nodes copied");
    check(ctx.mesh.elements == std::vector<uint32_t>(elements, elements + 4), "mesh elements copied");
    check(ctx.mesh.element_markers == std::vector<uint32_t>({7u}), "mesh element markers copied");
    check(ctx.mesh.boundary_faces == std::vector<uint32_t>({0u, 1u, 2u}), "mesh boundary faces copied");
    check(ctx.mesh.boundary_markers == std::vector<uint32_t>({3u}), "mesh boundary markers copied");
    check(ctx.mesh.periodic_node_pairs == std::vector<uint32_t>({1u, 2u}), "periodic pairs copied");
    check(ctx.mesh.periodic_reduced_node_count == 2u, "periodic reduction built");
    check(ctx.mesh.periodic_boundary_marker_set.count(11u) == 1u, "periodic boundary marker A copied");
    check(ctx.mesh.periodic_boundary_marker_set.count(12u) == 1u, "periodic boundary marker B copied");

    mesh.periodic_node_pairs = nullptr;
    check(
        !fullmag::fem::initialize_mesh_plan_fields(ctx, mesh, error),
        "periodic node-pair count requires pointer");
    check(
        error.find("FEM mesh periodic_node_pairs pointer is null") != std::string::npos,
        "periodic node-pair pointer error string");
}

void magnetic_masks_follow_shared_marker_policy() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 5;
    ctx.n_elements = 2;
    ctx.mesh.elements = {
        0u, 1u, 2u, 3u,
        1u, 2u, 3u, 4u,
    };
    ctx.mesh.element_markers = {0u, 7u};

    fullmag::fem::initialize_magnetic_masks(ctx);

    check(
        ctx.mesh.magnetic_element_mask == std::vector<uint8_t>({0u, 1u}),
        "mixed zero/non-zero markers treat zero as air");
    check(
        ctx.mesh.magnetic_node_mask == std::vector<uint8_t>({0u, 1u, 1u, 1u, 1u}),
        "magnetic node mask is union of magnetic elements");

    ctx.mesh.element_markers = {0u, 0u};
    fullmag::fem::initialize_magnetic_masks(ctx);
    check(
        ctx.mesh.magnetic_element_mask == std::vector<uint8_t>({1u, 1u}),
        "all-zero markers are treated as fully magnetic");

    ctx.mesh.element_markers = {3u, 7u};
    fullmag::fem::initialize_magnetic_masks(ctx);
    check(
        ctx.mesh.magnetic_element_mask == std::vector<uint8_t>({1u, 1u}),
        "all-nonzero markers are treated as fully magnetic");
}

void periodic_plan_compatibility_rejects_unsupported_terms_and_mismatched_fields() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.n_elements = 1;
    ctx.mesh.periodic_node_pairs = {0u, 1u};
    ctx.mesh.periodic_reduced_node = {0u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u};
    ctx.mesh.periodic_reduced_node_count = 1u;
    ctx.enable_exchange = true;
    ctx.material_fields.Ms_field = {800e3, 800e3};
    ctx.material_fields.A_field = {1.0e-11, 1.0e-11};
    ctx.material_fields.alpha_field = {0.02, 0.02};

    std::string error;
    check(
        fullmag::fem::validate_periodic_plan_compatibility(ctx, error),
        error.c_str());

    ctx.enable_magnetoelastic = true;
    check(
        !fullmag::fem::validate_periodic_plan_compatibility(ctx, error),
        "periodic plan rejects magnetoelastic without reduced operator");
    check(
        error.find("periodic_node_pairs currently support only") != std::string::npos,
        "periodic unsupported-term error string");

    ctx.enable_magnetoelastic = false;
    ctx.material_fields.Ms_field = {800e3, 900e3};
    check(
        !fullmag::fem::validate_periodic_plan_compatibility(ctx, error),
        "periodic plan rejects per-class material mismatch");
    check(
        error.find("Ms_field") != std::string::npos,
        "periodic material mismatch names the field");

    ctx.mesh.periodic_node_pairs.clear();
    check(
        fullmag::fem::validate_periodic_plan_compatibility(ctx, error),
        "non-periodic plan bypasses periodic compatibility checks");
}

} // namespace

int main() {
    fem_mesh_topology_helpers_are_owned_by_core_module();
    mesh_plan_import_copies_geometry_markers_and_periodic_pairs();
    magnetic_masks_follow_shared_marker_policy();
    periodic_plan_compatibility_rejects_unsupported_terms_and_mismatched_fields();
    return 0;
}
