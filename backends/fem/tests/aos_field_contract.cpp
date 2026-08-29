/*
 * aos_field_contract.cpp - native FEM AoS field helper contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

#include <cstdio>
#include <cstdlib>
#include <cmath>
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
        "bool bind_local_node_aos_vector_field(",
        "void unpack_aos_to_components(",
        "void unpack_aos_to_existing_components(",
        "void pack_components_to_aos(",
        "bool normalize_active_magnetization_aos(",
        "bool project_static_periodic_aos_checked(",
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

void typed_local_node_view_rejects_invalid_shape_and_map() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    std::vector<double> field = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    fullmag::fem::AosVectorFieldView view;
    std::string error;
    check(
        fullmag::fem::bind_local_node_aos_vector_field(ctx, field, view, error),
        error.c_str());
    check(view.data == field.data(), "typed AoS view points at local-node storage");
    check(view.node_count == 2u, "typed AoS view records local-node count");
    check(
        view.space == fullmag::fem::AosVectorFieldSpace::local_nodes,
        "typed AoS view records local-node space");

    field.pop_back();
    check(
        !fullmag::fem::bind_local_node_aos_vector_field(ctx, field, view, error),
        "typed AoS view rejects malformed local-node shape");
    check(error.find("length mismatch") != std::string::npos, "shape error is explicit");

    field = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    ctx.mesh.periodic_reduced_node = {0u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u};
    ctx.mesh.periodic_reduced_node_count = 1u;
    check(
        !fullmag::fem::project_static_periodic_aos_checked(ctx, field, error),
        "checked periodic projection rejects a map without revision");
    check(error.find("revision") != std::string::npos, "revision error is explicit");
}

void typed_periodic_node_map_view_exposes_local_and_true_spaces() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.periodic_reduced_node = {0u, 1u, 0u, 1u};
    ctx.mesh.periodic_representative_nodes = {2u, 3u};
    ctx.mesh.periodic_reduced_node_count = 2u;
    ctx.mesh.periodic_map_revision = 17u;

    fullmag::fem::PeriodicNodeMapView view;
    std::string error;
    check(fullmag::fem::bind_periodic_node_map(ctx, view, error), error.c_str());
    check(view.local_node_count == 4u, "periodic map view records local-node extent");
    check(view.true_node_count == 2u, "periodic map view records reduced true-node extent");
    check(view.local_to_true == ctx.mesh.periodic_reduced_node.data(),
          "periodic map view binds canonical local-to-true storage");
    check(view.true_representatives == ctx.mesh.periodic_representative_nodes.data(),
          "periodic map view binds canonical true representatives");
    check(view.revision == 17u, "periodic map view records map revision");

    ctx.mesh.periodic_reduced_node[3] = 2u;
    check(!fullmag::fem::bind_periodic_node_map(ctx, view, error),
          "periodic map view rejects an out-of-range true-node index");
    check(error.find("out of range") != std::string::npos,
          "periodic map view reports the invalid true-node index");
}

void active_magnetization_normalization_respects_mask() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 3;
    ctx.mesh.magnetic_node_mask = {1u, 0u, 1u};
    std::vector<double> m = {
        3.0, 4.0, 0.0,
        2.0, 0.0, 0.0,
        0.0, 0.0, -5.0,
    };
    std::string error;
    check(
        fullmag::fem::normalize_active_magnetization_aos(ctx, m, error),
        error.c_str());
    check(std::abs(m[0] - 0.6) < 1.0e-15, "active node 0 mx normalized");
    check(std::abs(m[1] - 0.8) < 1.0e-15, "active node 0 my normalized");
    check(m[3] == 2.0, "inactive node is left unchanged");
    check(m[8] == -1.0, "active node 2 normalized");

    m[3] = std::numeric_limits<double>::quiet_NaN();
    check(
        fullmag::fem::normalize_active_magnetization_aos(ctx, m, error),
        "nonfinite inactive airbox magnetization must be ignored");
    check(std::isnan(m[3]), "inactive airbox magnetization remains untouched");

    m = {
        1.0, 0.0, 0.0,
        2.0, 0.0, 0.0,
        0.0, 0.0, 0.0,
    };
    check(
        !fullmag::fem::normalize_active_magnetization_aos(ctx, m, error),
        "zero active magnetization must be rejected");
    check(
        error.find("zero, subnormal, or invalid magnetization norm") != std::string::npos,
        "zero active magnetization error string");

    for (double invalid : {
             std::numeric_limits<double>::denorm_min(),
             std::numeric_limits<double>::quiet_NaN(),
             std::numeric_limits<double>::infinity(),
         }) {
        m = {
            invalid, 0.0, 0.0,
            2.0, 0.0, 0.0,
            0.0, 0.0, -1.0,
        };
        check(
            !fullmag::fem::normalize_active_magnetization_aos(ctx, m, error),
            "subnormal and nonfinite active magnetization must be rejected");
    }
}

void active_magnetization_normalization_is_idempotent_at_fp64_roundoff() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.mesh.magnetic_node_mask = {1u};
    std::vector<double> m = {
        0.9998162380980484,
        0.019170028388013908,
        6.86072797124435e-06,
    };
    const auto before = m;
    std::string error;
    check(
        fullmag::fem::normalize_active_magnetization_aos(ctx, m, error),
        error.c_str());
    check(
        m == before,
        "already-unit FP64 continuation state must remain bitwise unchanged");
}

void periodic_projection_copies_representative_vectors() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.periodic_reduced_node = {0u, 1u, 0u, 1u};
    ctx.mesh.periodic_representative_nodes = {2u, 3u};
    ctx.mesh.periodic_reduced_node_count = 2u;
    ctx.mesh.periodic_map_revision = 1u;
    std::vector<double> field = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
    };

    std::string error;
    const bool projected =
        fullmag::fem::project_static_periodic_aos_checked(ctx, field, error);
    check(projected, error.c_str());
    auto audit = fullmag::fem::representation_audit_snapshot(ctx);
    check(audit.representation_copy_count == 1u,
          "periodic projection records one representation copy");
    check(audit.gather_scatter_bytes == 96u,
          "periodic projection records exact representative read/write bytes");
    check(audit.invalid_space_assertion_count == 0u,
          "valid periodic projection records no invalid-space assertion");

    const std::vector<double> expected = {
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
    };
    check(field == expected, "periodic AoS projection");

    field = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
        7.0, 8.0, 9.0,
        10.0, 11.0, 12.0,
    };
    {
        fullmag::fem::TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        check(
            fullmag::fem::project_static_periodic_aos_checked(ctx, field, error),
            "hot-loop periodic projection succeeds");
    }
    audit = fullmag::fem::representation_audit_snapshot(ctx);
    check(audit.hot_loop_representation_copy_count == 1u,
          "hot-loop representation copies are counted separately");
    check(audit.hot_loop_gather_scatter_bytes == 96u,
          "hot-loop gather/scatter bytes are exact");

    field = {1.0, 2.0, 3.0};
    ctx.mesh.periodic_reduced_node.clear();
    ctx.mesh.periodic_representative_nodes.clear();
    ctx.mesh.periodic_reduced_node_count = 0u;
    ctx.mesh.periodic_map_revision = 0u;
    check(!fullmag::fem::project_static_periodic_aos_checked(ctx, field, error),
          "identity projection still validates local-node extent");
    check(error.find("length mismatch") != std::string::npos,
          "identity projection reports invalid local-node extent");
    audit = fullmag::fem::representation_audit_snapshot(ctx);
    check(audit.invalid_space_assertion_count == 1u,
          "invalid local-node extent increments invalid-space telemetry");
}

} // namespace

int main() {
    aos_helpers_are_owned_by_runtime_module();
    aos_pack_unpack_and_existing_resize_contract();
    typed_local_node_view_rejects_invalid_shape_and_map();
    typed_periodic_node_map_view_exposes_local_and_true_spaces();
    active_magnetization_normalization_respects_mask();
    active_magnetization_normalization_is_idempotent_at_fp64_roundoff();
    periodic_projection_copies_representative_vectors();
    return 0;
}
