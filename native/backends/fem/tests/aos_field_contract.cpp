/*
 * aos_field_contract.cpp - native FEM AoS field helper contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

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

void aos_helpers_are_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string exchange =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.cpp");
    const std::string dmi =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi.cpp");
    const std::string aos =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "aos_field.cpp");

    const char *symbols[] = {
        "void unpack_aos_to_components(",
        "void unpack_aos_to_existing_components(",
        "void pack_components_to_aos(",
        "void project_static_periodic_aos(",
    };
    for (const char *symbol : symbols) {
        check(bridge.find(symbol) == std::string::npos, "bridge must not own AoS helper");
        check(exchange.find(symbol) == std::string::npos, "exchange must not own AoS helper");
        check(dmi.find(symbol) == std::string::npos, "DMI must not own AoS helper");
        check(aos.find(symbol) != std::string::npos, "AoS helper must be defined in runtime module");
    }
}

void aos_pack_unpack_and_existing_resize_contract() {
    const std::vector<double> aos = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    std::vector<double> x;
    std::vector<double> y;
    std::vector<double> z;
    fullmag::fem::unpack_aos_to_components(aos, x, y, z);
    check(x == std::vector<double>({1.0, 4.0}), "unpack x");
    check(y == std::vector<double>({2.0, 5.0}), "unpack y");
    check(z == std::vector<double>({3.0, 6.0}), "unpack z");

    x = {9.0};
    y = {9.0};
    z = {9.0};
    fullmag::fem::unpack_aos_to_existing_components(aos, x, y, z);
    check(x == std::vector<double>({1.0, 4.0}), "existing unpack resizes x");
    check(y == std::vector<double>({2.0, 5.0}), "existing unpack resizes y");
    check(z == std::vector<double>({3.0, 6.0}), "existing unpack resizes z");

    std::vector<double> packed;
    fullmag::fem::pack_components_to_aos(x, y, z, packed);
    check(packed == aos, "pack components to AoS");
}

void periodic_projection_copies_representative_vectors() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 4;
    ctx.mesh.periodic_reduced_node = {0u, 1u, 0u, 1u};
    ctx.mesh.periodic_representative_nodes = {2u, 3u};
    std::vector<double> field = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
    };

    fullmag::fem::project_static_periodic_aos(ctx, field);

    const std::vector<double> expected = {
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
    };
    check(field == expected, "periodic AoS projection");

    field = {1.0, 2.0, 3.0};
    ctx.mesh.periodic_reduced_node.clear();
    fullmag::fem::project_static_periodic_aos(ctx, field);
    check(field == std::vector<double>({1.0, 2.0, 3.0}), "empty periodic map leaves field unchanged");
}

} // namespace

int main() {
    aos_helpers_are_owned_by_runtime_module();
    aos_pack_unpack_and_existing_resize_contract();
    periodic_projection_copies_representative_vectors();
    return 0;
}
