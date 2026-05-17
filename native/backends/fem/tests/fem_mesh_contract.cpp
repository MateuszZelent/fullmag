/*
 * fem_mesh_contract.cpp - native FEM mesh topology ownership contract.
 *
 * Context construction may orchestrate mesh import, but periodic topology
 * reduction and nodal-volume geometry helpers belong to the FEM mesh core
 * module. This keeps Context moving toward the documented facade role.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

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
    const std::string fem_mesh = read_text_file(root / "core" / "fem_mesh.cpp");
    const std::string fem_mesh_header = read_text_file(root / "core" / "fem_mesh.hpp");
    const std::string aos =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "aos_field.cpp");

    const char *mesh_symbols[] = {
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
        aos.find("void project_static_periodic_aos(") != std::string::npos,
        "AoS periodic projection helper must remain in runtime/aos_field.cpp");
    check(
        fem_mesh_header.find("Own FEM mesh topology helpers") != std::string::npos,
        "FemMesh header must document its topology contract");
}

} // namespace

int main() {
    fem_mesh_topology_helpers_are_owned_by_core_module();
    return 0;
}
