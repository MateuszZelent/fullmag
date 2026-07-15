/*
 * zeeman_contract.cpp - native FEM Zeeman/external-field contract tests.
 *
 * The Zeeman interaction is local and should be testable without MFEM: a
 * uniform field is copied to nodal H_ext in A/m, added to H_eff without gamma
 * or damping factors, and integrated as E = -mu0 integral Ms m.H dV.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_near(double actual, double expected, double tol, const char *msg);

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

void zeeman_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman.hpp");
    const std::string uniform =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_uniform_field.cpp");
    const std::string uniform_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_uniform_field.hpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_field.hpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_energy.cpp");
    const std::string energy_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_energy.hpp");
    const std::string context_cpp = read_text_file(root / "src" / "context.cpp");

    const char *plan_symbol = "void initialize_zeeman_plan_fields(";
    const char *broadcast_symbol = "void initialize_uniform_zeeman_field(";
    const char *add_symbol = "void add_zeeman_field(";
    const char *energy_symbol = "double zeeman_energy_from_field(";

    check(
        aggregate.find(broadcast_symbol) == std::string::npos,
        "Zeeman broadcast must not be defined in zeeman.cpp");
    check(
        aggregate.find(add_symbol) == std::string::npos,
        "Zeeman H_eff addition must not be defined in zeeman.cpp");
    check(
        aggregate.find(energy_symbol) == std::string::npos,
        "Zeeman energy must not be defined in zeeman.cpp");
    check(
        uniform.find(broadcast_symbol) != std::string::npos,
        "Zeeman broadcast must be defined in zeeman_uniform_field.cpp");
    check(
        field.find(add_symbol) != std::string::npos,
        "Zeeman H_eff addition must be defined in zeeman_field.cpp");
    check(
        energy.find(energy_symbol) != std::string::npos,
        "Zeeman energy must be defined in zeeman_energy.cpp");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "Zeeman plan import must be defined in zeeman.cpp");
    check(
        aggregate_header.find("Initialize native FEM Zeeman plan fields") !=
            std::string::npos,
        "Zeeman aggregate header must document plan import ownership");
    check(
        aggregate_header.find("does not broadcast H_ext, add H_eff, or integrate energy") !=
            std::string::npos,
        "Zeeman aggregate header must document its non-owning field/energy boundary");
    check(
        aggregate_header.find("runtime output") != std::string::npos &&
            aggregate_header.find("storage only") != std::string::npos,
        "Zeeman aggregate header must document runtime-output ownership");
    check(
        aggregate_header.find("zeeman_uniform_field.*") != std::string::npos,
        "Zeeman aggregate header must name the uniform-field owner");
    check(
        aggregate_header.find("zeeman_field.*") != std::string::npos,
        "Zeeman aggregate header must name the field-add owner");
    check(
        aggregate_header.find("zeeman_energy.*") != std::string::npos,
        "Zeeman aggregate header must name the energy owner");
    check(
        uniform_header.find("Initialize the native FEM Zeeman field buffer") !=
            std::string::npos,
        "Zeeman uniform-field header must document its physical contract");
    check(
        uniform_header.find("does not add H_ext to H_eff or integrate Zeeman energy") !=
            std::string::npos,
        "Zeeman uniform-field header must document its non-owning add/energy boundary");
    check(
        field_header.find("Add the Zeeman field contribution") != std::string::npos,
        "Zeeman field-add header must document its physical contract");
    check(
        field_header.find("does not broadcast uniform fields or integrate Zeeman energy") !=
            std::string::npos,
        "Zeeman field-add header must document its non-owning broadcast/energy boundary");
    check(
        energy_header.find("Compute Zeeman energy") != std::string::npos,
        "Zeeman energy header must document its physical contract");
    check(
        energy_header.find("does not broadcast H_ext or add H_ext to H_eff") !=
            std::string::npos,
        "Zeeman energy header must document its non-owning field boundary");
    check(
        context_cpp.find("ctx.zeeman.has_external_field = plan.has_external_field != 0;") ==
            std::string::npos,
        "context_from_plan must delegate Zeeman enable import to zeeman.cpp");
    check(
        context_cpp.find("ctx.zeeman.external_field_am = {\n        plan.external_field_am[0]") ==
            std::string::npos,
        "context_from_plan must delegate Zeeman field import to zeeman.cpp");
}

void zeeman_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman.cpp");
    const std::string uniform =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_uniform_field.cpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_field.cpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_energy.cpp");

    check(
        aggregate.find("Zeeman aggregate source contract") != std::string::npos,
        "Zeeman aggregate source file must document its source contract");
    check(
        aggregate.find("does not broadcast H_ext, add H_eff, or integrate energy") !=
            std::string::npos,
        "Zeeman aggregate source file must document its non-owning field/energy boundary");
    check(
        uniform.find("Zeeman uniform-field source contract") != std::string::npos,
        "Zeeman uniform-field source file must document its source contract");
    check(
        uniform.find("does not add H_ext to H_eff or integrate Zeeman energy") !=
            std::string::npos,
        "Zeeman uniform-field source file must document its non-owning add/energy boundary");
    check(
        field.find("Zeeman field-add source contract") != std::string::npos,
        "Zeeman field-add source file must document its source contract");
    check(
        field.find("does not broadcast uniform fields or integrate Zeeman energy") !=
            std::string::npos,
        "Zeeman field-add source file must document its non-owning broadcast/energy boundary");
    check(
        energy.find("Zeeman energy source contract") != std::string::npos,
        "Zeeman energy source file must document its source contract");
    check(
        energy.find("does not broadcast H_ext or add H_ext to H_eff") != std::string::npos,
        "Zeeman energy source file must document its non-owning field boundary");
}

void zeeman_runtime_state_is_owned_by_aggregate_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string zeeman_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman.hpp");

    check(
        zeeman_header.find("struct ZeemanRuntimeState") != std::string::npos,
        "Zeeman runtime state must be declared by zeeman.hpp");
    check(
        zeeman_header.find("std::vector<double> h_ext_xyz") != std::string::npos,
        "Zeeman runtime state must own the nodal H_ext field buffer");
    check(
        zeeman_header.find("bool has_external_field") != std::string::npos,
        "Zeeman runtime state must own the external-field enable flag");
    check(
        zeeman_header.find("std::array<double, 3> external_field_am") !=
            std::string::npos,
        "Zeeman runtime state must own the uniform external-field vector");
    check(
        context_header.find("ZeemanRuntimeState zeeman") != std::string::npos,
        "Context must store Zeeman runtime output through the Zeeman owner");
    check(
        context_header.find("std::vector<double> h_ext_xyz") == std::string::npos,
        "Context must not own a flat Zeeman field buffer");
    check(
        context_header.find("bool has_external_field") == std::string::npos,
        "Context must not own a flat Zeeman enable flag");
    check(
        context_header.find("std::array<double, 3> external_field_am") ==
            std::string::npos,
        "Context must not own a flat Zeeman external-field vector");
}

fullmag_fem_time_dependence_desc constant_waveform_desc() {
    fullmag_fem_time_dependence_desc waveform{};
    waveform.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    waveform.struct_size = sizeof(waveform);
    waveform.kind = FULLMAG_FEM_TIME_CONSTANT;
    return waveform;
}

fullmag_fem_regional_field_drive_desc global_uniform_drive_desc() {
    fullmag_fem_regional_field_drive_desc drive{};
    drive.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.struct_size = sizeof(drive);
    drive.target.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.target.struct_size = sizeof(drive.target);
    drive.target.kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
    drive.spatial_profile.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.spatial_profile.struct_size = sizeof(drive.spatial_profile);
    drive.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM;
    drive.amplitude_b_t = kMu0Test * 7.0;
    drive.direction[1] = 1.0;
    drive.waveform = constant_waveform_desc();
    drive.time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    return drive;
}

void regional_drive_descriptor_validation_and_owned_copy() {
    fullmag::fem::Context ctx;
    std::string error;
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drive_count = 1;
    check(
        !fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error),
        "regional drive null/count mismatch rejected");

    auto drive = global_uniform_drive_desc();
    plan.regional_field_drives = &drive;
    drive.abi_version = 99;
    check(
        !fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error),
        "regional drive ABI mismatch rejected");

    drive = global_uniform_drive_desc();
    check(
        fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error),
        error.c_str());
    drive.amplitude_b_t = 0.0;
    check_near(
        ctx.zeeman.regional_drives[0].amplitude_b_t,
        kMu0Test * 7.0,
        0.0,
        "native runtime owns copied drive amplitude");
}

void regional_drive_abi_layout_is_self_consistent() {
    fullmag_fem_regional_field_drive_abi_layout layout{};
    check(
        fullmag_fem_get_regional_field_drive_abi_layout(&layout) == FULLMAG_FEM_OK,
        "regional drive ABI layout query succeeds");
    check(layout.abi_version == FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION, "regional ABI version");
    check(layout.struct_size == sizeof(layout), "regional ABI layout size");
    check(layout.regional_field_drive_desc_size == sizeof(fullmag_fem_regional_field_drive_desc), "regional descriptor size");
    check(layout.plan_desc_size == sizeof(fullmag_fem_plan_desc), "regional plan size");
    check(layout.plan_regional_field_drives_offset == offsetof(fullmag_fem_plan_desc, regional_field_drives), "regional plan pointer offset");
    check(layout.step_stats_drive_energy_joules_offset == offsetof(fullmag_fem_step_stats, drive_energy_joules), "drive energy offset");
}

void regional_drive_waveform_golden_values() {
    fullmag::fem::OwnedTimeDependence waveform;
    std::string error;
    auto desc = constant_waveform_desc();
    check(fullmag::fem::copy_time_dependence(desc, waveform, error), error.c_str());
    check_near(fullmag::fem::evaluate_time_dependence(waveform, 123.0), 1.0, 0.0, "constant waveform");

    desc.kind = FULLMAG_FEM_TIME_SINC_PULSE;
    desc.parameters.sinc_pulse = {2.0e9, 3.0e-10, 0.25};
    check(fullmag::fem::copy_time_dependence(desc, waveform, error), error.c_str());
    check_near(fullmag::fem::evaluate_time_dependence(waveform, 3.0e-10), 0.25, 1e-16, "sinc center limit");

    fullmag_fem_time_point points[] = {{0.0, 1.0}, {2.0, 5.0}};
    desc.kind = FULLMAG_FEM_TIME_PIECEWISE_LINEAR;
    desc.points = points;
    desc.point_count = 2;
    check(fullmag::fem::copy_time_dependence(desc, waveform, error), error.c_str());
    points[1].value = 99.0;
    check_near(fullmag::fem::evaluate_time_dependence(waveform, 1.0), 3.0, 1e-15, "owned PWL interpolation");
}

void global_uniform_regional_drive_projects_and_materializes_exactly() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {0,0,0, 1,0,0, 0,1,0, 0,0,1};
    ctx.mesh.elements = {0,1,2,3};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.node_volumes = {1.0/24.0, 1.0/24.0, 1.0/24.0, 1.0/24.0};
    auto drive_desc = global_uniform_drive_desc();
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drives = &drive_desc;
    plan.regional_field_drive_count = 1;
    std::string error;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(fullmag::fem::project_regional_field_drive_bases(ctx, error), error.c_str());
    fullmag::fem::materialize_regional_field_drive(ctx, 4.0);
    for (size_t node = 0; node < 4; ++node) {
        check_near(ctx.zeeman.h_drive_xyz[3*node], 0.0, 1e-14, "global drive Hx");
        check_near(ctx.zeeman.h_drive_xyz[3*node+1], 7.0, 1e-14, "global drive Hy exact");
        check_near(ctx.zeeman.h_drive_xyz[3*node+2], 0.0, 1e-14, "global drive Hz");
    }
}

void spatial_sinc_regional_drive_uses_tetra_volume_projection() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {0,0,0, 1,0,0, 0,1,0, 0,0,1};
    ctx.mesh.elements = {0,1,2,3};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.node_volumes = {1.0/24.0, 1.0/24.0, 1.0/24.0, 1.0/24.0};
    auto drive_desc = global_uniform_drive_desc();
    drive_desc.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_SINC;
    drive_desc.spatial_profile.sinc_axis[0] = 1.0;
    drive_desc.spatial_profile.sinc_period_m = 1.0;
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drives = &drive_desc;
    plan.regional_field_drive_count = 1;
    std::string error;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(fullmag::fem::project_regional_field_drive_bases(ctx, error), error.c_str());
    const auto &basis = ctx.zeeman.regional_drives[0].basis_h_xyz;
    check(basis.size() == 12, "spatial sinc basis AOS-3 length");
    check(basis[1] > basis[4], "spatial sinc lumped projection varies along x");
    check(basis[4] > 0.0 && basis[1] < 7.0, "spatial sinc basis is a bounded volume projection");
}

void geometry_mask_projection_matches_analytic_clipped_tetra_volume() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {0,0,0, 1,0,0, 0,1,0, 0,0,1};
    ctx.mesh.elements = {0,1,2,3};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.node_volumes = {1.0/24.0, 1.0/24.0, 1.0/24.0, 1.0/24.0};
    fullmag_fem_geometry_mask_node box{};
    box.kind = FULLMAG_FEM_GEOMETRY_BOX;
    box.center_m[0] = 0.25;
    box.center_m[1] = 0.5;
    box.center_m[2] = 0.5;
    box.size_m[0] = 0.5;
    box.size_m[1] = 2.0;
    box.size_m[2] = 2.0;
    fullmag_fem_geometry_mask_desc geometry{
        FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
        sizeof(fullmag_fem_geometry_mask_desc), &box, 1, 0};
    auto drive_desc = global_uniform_drive_desc();
    drive_desc.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_GEOMETRY_MASK;
    drive_desc.spatial_profile.geometry_mask = &geometry;
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drives = &drive_desc;
    plan.regional_field_drive_count = 1;
    std::string error;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(fullmag::fem::project_regional_field_drive_bases(ctx, error), error.c_str());
    const auto &basis = ctx.zeeman.regional_drives[0].basis_h_xyz;
    double projected_volume = 0.0;
    for (size_t node = 0; node < 4; ++node) {
        projected_volume += (basis[3 * node + 1] / 7.0) * ctx.mesh.node_volumes[node];
    }
    check_near(projected_volume, 7.0 / 48.0, 2e-7,
        "geometry mask clipped tetra volume");

    fullmag_fem_geometry_mask_node cylinder{};
    cylinder.kind = FULLMAG_FEM_GEOMETRY_CYLINDER;
    cylinder.center_m[2] = 0.5;
    cylinder.axis[2] = 1.0;
    cylinder.radius_m = 2.0;
    cylinder.height_m = 2.0;
    geometry.nodes = &cylinder;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(fullmag::fem::project_regional_field_drive_bases(ctx, error), error.c_str());
    for (size_t node = 0; node < 4; ++node) {
        check_near(ctx.zeeman.regional_drives[0].basis_h_xyz[3 * node + 1], 7.0, 1e-12,
            "enclosing cylinder geometry mask is exact");
    }
}

void periodic_node_pair_requires_identical_projected_basis_without_averaging() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {0,0,0, 1,0,0, 0,1,0, 0,0,1};
    ctx.mesh.elements = {0,1,2,3};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.node_volumes = {1.0/24.0, 1.0/24.0, 1.0/24.0, 1.0/24.0};
    ctx.mesh.periodic_node_pairs = {0, 1};
    auto drive_desc = global_uniform_drive_desc();
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drives = &drive_desc;
    plan.regional_field_drive_count = 1;
    std::string error;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(fullmag::fem::project_regional_field_drive_bases(ctx, error),
        "global uniform basis must satisfy every periodic pair exactly");
    drive_desc.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_SINC;
    drive_desc.spatial_profile.sinc_axis[0] = 1.0;
    drive_desc.spatial_profile.sinc_period_m = 1.0;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(!fullmag::fem::project_regional_field_drive_bases(ctx, error),
        "nonperiodic projected sinc basis must fail instead of averaging paired nodes");
    check(error.find("periodic node pair") != std::string::npos,
        "PBC projection failure identifies the periodic pair contract");
}

void multiple_regional_drives_superpose_and_cancel() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.mesh.nodes_xyz = {0,0,0, 1,0,0, 0,1,0, 0,0,1};
    ctx.mesh.elements = {0,1,2,3};
    ctx.mesh.magnetic_element_mask = {1};
    ctx.mesh.node_volumes = {1.0/24.0, 1.0/24.0, 1.0/24.0, 1.0/24.0};
    fullmag_fem_regional_field_drive_desc drives[] = {
        global_uniform_drive_desc(), global_uniform_drive_desc()};
    drives[1].direction[1] = -1.0;
    fullmag_fem_plan_desc plan{};
    plan.regional_field_drives = drives;
    plan.regional_field_drive_count = 2;
    std::string error;
    check(fullmag::fem::copy_regional_field_drive_plan(ctx, plan, error), error.c_str());
    check(fullmag::fem::project_regional_field_drive_bases(ctx, error), error.c_str());
    fullmag::fem::materialize_regional_field_drive(ctx, 0.0);
    for (double value : ctx.zeeman.h_drive_xyz) {
        check_near(value, 0.0, 1e-14, "opposite regional drives cancel exactly");
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

fullmag::fem::Context make_context() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.Ms_field = {800e3, 1.0e6};
    ctx.integration_weights.mfem_lumped_mass = {2.0e-27, 3.0e-27};
    return ctx;
}

void plan_fields_are_imported_by_zeeman_module() {
    fullmag::fem::Context ctx;
    ctx.zeeman.has_external_field = false;
    ctx.zeeman.external_field_am = {-1.0, -2.0, -3.0};

    fullmag_fem_plan_desc plan{};
    plan.has_external_field = 1;
    plan.external_field_am[0] = 11.0;
    plan.external_field_am[1] = 22.0;
    plan.external_field_am[2] = 33.0;

    fullmag::fem::initialize_zeeman_plan_fields(ctx, plan);

    check(ctx.zeeman.has_external_field, "Zeeman plan import enables external field");
    check_near(ctx.zeeman.external_field_am[0], 11.0, 0.0, "Zeeman plan Hx import");
    check_near(ctx.zeeman.external_field_am[1], 22.0, 0.0, "Zeeman plan Hy import");
    check_near(ctx.zeeman.external_field_am[2], 33.0, 0.0, "Zeeman plan Hz import");

    plan.has_external_field = 0;
    plan.external_field_am[0] = 44.0;
    plan.external_field_am[1] = 55.0;
    plan.external_field_am[2] = 66.0;

    fullmag::fem::initialize_zeeman_plan_fields(ctx, plan);

    check(!ctx.zeeman.has_external_field, "Zeeman plan import disables external field");
    check_near(ctx.zeeman.external_field_am[0], 44.0, 0.0, "disabled Zeeman plan still imports Hx");
    check_near(ctx.zeeman.external_field_am[1], 55.0, 0.0, "disabled Zeeman plan still imports Hy");
    check_near(ctx.zeeman.external_field_am[2], 66.0, 0.0, "disabled Zeeman plan still imports Hz");
}

void disabled_zeeman_is_zero() {
    auto ctx = make_context();
    ctx.zeeman.has_external_field = false;
    ctx.zeeman.external_field_am = {10.0, 20.0, 30.0};

    fullmag::fem::initialize_uniform_zeeman_field(ctx);

    check(ctx.zeeman.h_ext_xyz.size() == 6u, "disabled Zeeman h_ext size");
    for (double value : ctx.zeeman.h_ext_xyz) {
        check_near(value, 0.0, 0.0, "disabled Zeeman field component");
    }

    std::vector<double> h_eff(6u, 5.0);
    fullmag::fem::add_zeeman_field(ctx, h_eff);
    for (double value : h_eff) {
        check_near(value, 5.0, 0.0, "disabled Zeeman does not alter H_eff");
    }

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    check_near(
        fullmag::fem::zeeman_energy_from_field(ctx, m),
        0.0,
        0.0,
        "disabled Zeeman energy");
}

void uniform_field_is_broadcast_added_and_integrated() {
    auto ctx = make_context();
    ctx.zeeman.has_external_field = true;
    ctx.zeeman.external_field_am = {100.0, 200.0, 300.0};

    fullmag::fem::initialize_uniform_zeeman_field(ctx);

    const std::vector<double> expected_h = {
        100.0, 200.0, 300.0,
        100.0, 200.0, 300.0,
    };
    check(ctx.zeeman.h_ext_xyz == expected_h, "Zeeman field broadcast");

    std::vector<double> h_eff = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    fullmag::fem::add_zeeman_field(ctx, h_eff);
    const std::vector<double> expected_eff = {
        101.0, 202.0, 303.0,
        104.0, 205.0, 306.0,
    };
    check(h_eff == expected_eff, "Zeeman field added to H_eff");

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    const double expected_energy =
        -kMu0Test * (800e3 * 100.0 * 2.0e-27 + 1.0e6 * 200.0 * 3.0e-27);

    check_near(
        fullmag::fem::zeeman_energy_from_field(ctx, m),
        expected_energy,
        std::fabs(expected_energy) * 1e-12,
        "Zeeman energy sign and units");
}

} // namespace

int main() {
    zeeman_responsibilities_are_owned_by_separate_modules();
    zeeman_source_files_document_module_boundaries();
    zeeman_runtime_state_is_owned_by_aggregate_module();
    regional_drive_descriptor_validation_and_owned_copy();
    regional_drive_abi_layout_is_self_consistent();
    regional_drive_waveform_golden_values();
    global_uniform_regional_drive_projects_and_materializes_exactly();
    spatial_sinc_regional_drive_uses_tetra_volume_projection();
    geometry_mask_projection_matches_analytic_clipped_tetra_volume();
    periodic_node_pair_requires_identical_projected_basis_without_averaging();
    multiple_regional_drives_superpose_and_cancel();
    plan_fields_are_imported_by_zeeman_module();
    disabled_zeeman_is_zero();
    uniform_field_is_broadcast_added_and_integrated();
    return 0;
}
