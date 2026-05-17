/*
 * fem_field_buffers_contract.cpp - native FEM field-buffer ownership.
 *
 * Context construction may orchestrate plan import, but sizing, zeroing, and
 * external-field seeding for nodal AOS field buffers belong to the FEM core
 * field-buffer module. This is one step toward the documented FemFieldBuffers
 * split.
 */

#include "context.hpp"
#include "core/fem_field_buffers.hpp"

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

void field_buffer_helpers_are_owned_by_core_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string field_buffers = read_text_file(root / "core" / "fem_field_buffers.cpp");
    const std::string field_header = read_text_file(root / "core" / "fem_field_buffers.hpp");

    check(
        context.find("void fill_zero_vector_field(") == std::string::npos,
        "Context must not define field-buffer zero helper");
    check(
        field_buffers.find("void fill_zero_vector_field(") != std::string::npos,
        "Field-buffer zero helper must be defined in core/fem_field_buffers.cpp");
    check(
        field_buffers.find("void initialize_context_field_buffers(") != std::string::npos,
        "Context field-buffer initialization must be defined in core/fem_field_buffers.cpp");
    check(
        field_header.find("Own FEM field buffer sizing and zero-initialization") !=
            std::string::npos,
        "FemFieldBuffers header must document its contract");
}

void field_buffer_initialization_contract() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.has_external_field = true;
    ctx.h_ext_xyz = {1.0, 2.0, 3.0, 4.0, 5.0, 6.0};

    fullmag::fem::initialize_context_field_buffers(ctx);

    const std::vector<double> zeros(6, 0.0);
    check(ctx.h_ex_xyz == zeros, "exchange field buffer initialized to zero");
    check(ctx.h_demag_xyz == zeros, "demag field buffer initialized to zero");
    check(ctx.h_ani_xyz == zeros, "uniaxial anisotropy field buffer initialized to zero");
    check(ctx.h_dmi_xyz == zeros, "interfacial DMI field buffer initialized to zero");
    check(ctx.h_cubic_ani_xyz == zeros, "cubic anisotropy field buffer initialized to zero");
    check(ctx.h_bulk_dmi_xyz == zeros, "bulk DMI field buffer initialized to zero");
    check(ctx.h_mel_xyz == zeros, "magnetoelastic field buffer initialized to zero");
    check(ctx.h_eff_xyz == ctx.h_ext_xyz, "effective field seeded from external field");

    ctx.has_external_field = false;
    ctx.h_eff_xyz = {9.0, 9.0, 9.0};
    fullmag::fem::initialize_context_field_buffers(ctx);
    check(ctx.h_eff_xyz == zeros, "effective field zeroed when no external field exists");
}

} // namespace

int main() {
    field_buffer_helpers_are_owned_by_core_module();
    field_buffer_initialization_contract();
    return 0;
}
