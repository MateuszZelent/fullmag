/*
 * stt_contract.cpp - native FEM spin-transfer torque contract tests.
 *
 * STT contributes directly to dm/dt RHS, not to H_eff. These tests cover the
 * executable Slonczewski CPP and Zhang-Li CIP paths without requiring MFEM.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "tetra_geometry_oracle.hpp"

#include <algorithm>
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
constexpr double kHbarTest = 1.054571817e-34;
constexpr double kElectronChargeTest = 1.60217662e-19;
constexpr double kBohrMagnetonTest = 9.274009994e-24;
constexpr double kGammaMu0Test = 2.211e5;

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

void slonczewski_cpp_is_owned_by_slonczewski_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string stt =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.cpp");
    const std::string slonczewski = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "stt_slonczewski.cpp");
    const std::string slonczewski_header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "stt_slonczewski.hpp");

    const char *symbol = "void add_slonczewski_stt_rhs_aos(";
    const char *hbar_marker = "HBAR";
    const char *thickness_marker = "effective_magnetic_thickness_along_axis";

    check(
        stt.find(symbol) == std::string::npos,
        "Slonczewski CPP STT must not be defined in stt.cpp");
    check(
        stt.find(hbar_marker) == std::string::npos,
        "Slonczewski physical constants must not remain in stt.cpp");
    check(
        stt.find(thickness_marker) == std::string::npos,
        "Slonczewski thickness helper must not remain in stt.cpp");
    check(
        slonczewski.find(symbol) != std::string::npos,
        "Slonczewski CPP STT must be defined in stt_slonczewski.cpp");
    check(
        slonczewski.find(hbar_marker) != std::string::npos,
        "Slonczewski physical constants must be defined in stt_slonczewski.cpp");
    check(
        slonczewski.find(thickness_marker) != std::string::npos,
        "Slonczewski thickness helper must be defined in stt_slonczewski.cpp");
    check(
        slonczewski_header.find("Add Slonczewski CPP spin-transfer torque") !=
            std::string::npos,
        "Slonczewski module header must document its physical contract");
}

void zhang_li_cip_is_owned_by_zhang_li_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string stt =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.cpp");
    const std::string zhang_li =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt_zhang_li.cpp");
    const std::string zhang_li_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt_zhang_li.hpp");

    const char *symbol = "void add_zhang_li_stt_rhs_aos(";
    const char *gradient_marker = "tetrahedron_gradients";
    const char *bohr_marker = "MU_B";

    check(
        stt.find(symbol) == std::string::npos,
        "Zhang-Li CIP STT must not be defined in stt.cpp");
    check(
        stt.find(gradient_marker) == std::string::npos,
        "Zhang-Li tetrahedral gradient helper must not remain in stt.cpp");
    check(
        stt.find(bohr_marker) == std::string::npos,
        "Zhang-Li physical constants must not remain in stt.cpp");
    check(
        zhang_li.find(symbol) != std::string::npos,
        "Zhang-Li CIP STT must be defined in stt_zhang_li.cpp");
    check(
        zhang_li.find(gradient_marker) != std::string::npos,
        "Zhang-Li tetrahedral gradient helper must be defined in stt_zhang_li.cpp");
    check(
        zhang_li.find(bohr_marker) != std::string::npos,
        "Zhang-Li physical constants must be defined in stt_zhang_li.cpp");
    check(
        zhang_li_header.find("Add Zhang-Li CIP spin-transfer torque") !=
            std::string::npos,
        "Zhang-Li module header must document its physical contract");
}

void stt_plan_fields_are_owned_by_stt_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string stt =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.cpp");
    const std::string stt_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.hpp");

    fullmag::fem::SttRuntimeState runtime;
    runtime.zhang_li_enabled = true;
    runtime.slonczewski_enabled = false;
    runtime.current_density_am2 = {1.0, 2.0, 3.0};
    runtime.degree = 0.7;
    runtime.beta = 0.2;
    runtime.spin_polarization = {0.0, 0.0, 1.0};
    runtime.lambda = 1.5;
    runtime.epsilon_prime = 0.25;
    runtime.free_layer_thickness = 2.0e-9;
    runtime.current_sign = -1.0;
    check(runtime.zhang_li_enabled, "STT runtime state owns Zhang-Li enablement");
    check(!runtime.slonczewski_enabled, "STT runtime state owns Slonczewski enablement");
    check(runtime.current_density_am2[2] == 3.0, "STT runtime state owns current density");
    check(runtime.degree == 0.7, "STT runtime state owns degree");
    check(runtime.beta == 0.2, "STT runtime state owns beta");
    check(runtime.spin_polarization[2] == 1.0, "STT runtime state owns spin polarization");
    check(runtime.lambda == 1.5, "STT runtime state owns lambda");
    check(runtime.epsilon_prime == 0.25, "STT runtime state owns epsilon prime");
    check(runtime.free_layer_thickness == 2.0e-9, "STT runtime state owns free-layer thickness");
    check(runtime.current_sign == -1.0, "STT runtime state owns current sign");

    check(
        context.find("plan.has_zhang_li_stt") == std::string::npos,
        "Context must not own STT plan-family validation");
    check(
        context.find("stt_spin_polarization must be finite") == std::string::npos,
        "Context must not own Slonczewski spin-polarization validation");
    check(
        stt.find("bool initialize_stt_plan_fields(") != std::string::npos,
        "STT plan import must be defined in stt.cpp");
    check(
        stt_header.find("Initialize executable STT plan fields") != std::string::npos,
        "STT aggregate header must document plan-field initialization ownership");
    check(
        stt_header.find("struct SttRuntimeState") != std::string::npos,
        "STT aggregate header must declare STT runtime plan storage");
    check(
        stt_header.find("bool zhang_li_enabled") != std::string::npos,
        "STT runtime state must own Zhang-Li enablement");
    check(
        stt_header.find("bool slonczewski_enabled") != std::string::npos,
        "STT runtime state must own Slonczewski enablement");
    check(
        stt_header.find("std::array<double, 3> current_density_am2") != std::string::npos,
        "STT runtime state must own current density");
    check(
        stt_header.find("double degree") != std::string::npos,
        "STT runtime state must own degree");
    check(
        stt_header.find("double beta") != std::string::npos,
        "STT runtime state must own beta");
    check(
        stt_header.find("std::array<double, 3> spin_polarization") != std::string::npos,
        "STT runtime state must own spin polarization");
    check(
        stt_header.find("double lambda") != std::string::npos,
        "STT runtime state must own lambda");
    check(
        stt_header.find("double epsilon_prime") != std::string::npos,
        "STT runtime state must own epsilon prime");
    check(
        stt_header.find("double free_layer_thickness") != std::string::npos,
        "STT runtime state must own free-layer thickness");
    check(
        stt_header.find("double current_sign") != std::string::npos,
        "STT runtime state must own current sign");
    check(
        context_header.find("SttRuntimeState stt") != std::string::npos,
        "Context must store STT plan storage through the STT owner");
    check(
        context_header.find("bool has_zhang_li_stt") == std::string::npos,
        "Context must not own flat Zhang-Li enablement");
    check(
        context_header.find("bool has_slonczewski_stt") == std::string::npos,
        "Context must not own flat Slonczewski enablement");
    check(
        context_header.find("std::array<double, 3> stt_current_density_am2") == std::string::npos,
        "Context must not own flat STT current density");
    check(
        context_header.find("double stt_degree") == std::string::npos,
        "Context must not own flat STT degree");
    check(
        context_header.find("double stt_beta") == std::string::npos,
        "Context must not own flat STT beta");
    check(
        context_header.find("std::array<double, 3> stt_spin_polarization") == std::string::npos,
        "Context must not own flat STT spin polarization");
    check(
        context_header.find("double stt_lambda") == std::string::npos,
        "Context must not own flat STT lambda");
    check(
        context_header.find("double stt_epsilon_prime") == std::string::npos,
        "Context must not own flat STT epsilon prime");
    check(
        context_header.find("double stt_free_layer_thickness") == std::string::npos,
        "Context must not own flat STT free-layer thickness");
    check(
        context_header.find("double stt_current_sign") == std::string::npos,
        "Context must not own flat STT current sign");
}

void stt_aggregate_header_documents_submodule_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string stt_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.hpp");

    check(
        stt_header.find("owns plan import") != std::string::npos,
        "STT aggregate header must document plan import ownership");
    check(
        stt_header.find("family dispatch") != std::string::npos,
        "STT aggregate header must document dispatch ownership");
    check(
        stt_header.find("reusable") != std::string::npos &&
            stt_header.find("workspace") != std::string::npos,
        "STT aggregate header must document aggregate ownership");
    check(
        stt_header.find("does not define") != std::string::npos &&
            stt_header.find("Slonczewski CPP") != std::string::npos &&
            stt_header.find("torque") != std::string::npos,
        "STT aggregate header must document that Slonczewski physics is not owned by the aggregate");
    check(
        stt_header.find("does not define") != std::string::npos &&
            stt_header.find("Zhang-Li CIP") != std::string::npos &&
            stt_header.find("torque") != std::string::npos,
        "STT aggregate header must document that Zhang-Li physics is not owned by the aggregate");
    check(
        stt_header.find("stt_slonczewski.*") != std::string::npos,
        "STT aggregate header must name the Slonczewski owner");
    check(
        stt_header.find("stt_zhang_li.*") != std::string::npos,
        "STT aggregate header must name the Zhang-Li owner");
}

void stt_rhs_hot_path_uses_reusable_workspace() {
    const std::filesystem::path root = fem_source_root();
    const std::string stt =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.cpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string rk_workspace =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");

    check(
        stt.find("llg_only") == std::string::npos,
        "STT aggregate must not copy the full LLG RHS in the hot path");
    check(
        stt.find("std::vector<double> zhang_li") == std::string::npos,
        "STT aggregate must not allocate a temporary Zhang-Li RHS in the hot path");
    check(
        rk_workspace.find("SttWorkspace stt;") != std::string::npos,
        "RK stepper workspace must own reusable STT scratch buffers");
    check(
        rk_stage_rhs.find("add_stt_rhs_aos(ctx, m_state, out_k, max_rhs, ws.stt)") !=
            std::string::npos,
        "RK stage RHS must pass reusable STT workspace into the aggregate");
    check(
        rk_explicit_step.find("add_stt_rhs_aos(ctx, ctx.state.m_xyz, ws.k[0], max_rhs_final, ws.stt)") !=
            std::string::npos,
        "RK final RHS fallback must pass reusable STT workspace into the aggregate");
}

void stt_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string stt =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt.cpp");
    const std::string slonczewski = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "stt_slonczewski.cpp");
    const std::string zhang_li =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt_zhang_li.cpp");

    check(
        stt.find("STT aggregate source contract") != std::string::npos,
        "STT aggregate source file must document its source contract");
    check(
        stt.find("does not define Slonczewski CPP or Zhang-Li CIP torque physics") !=
            std::string::npos,
        "STT aggregate source file must document its non-owning torque boundary");
    check(
        slonczewski.find("Slonczewski CPP STT source contract") != std::string::npos,
        "Slonczewski STT source file must document its source contract");
    check(
        slonczewski.find("does not import plan fields or compute Zhang-Li CIP torque") !=
            std::string::npos,
        "Slonczewski STT source file must document its non-owning aggregate/Zhang-Li boundary");
    check(
        zhang_li.find("Zhang-Li CIP STT source contract") != std::string::npos,
        "Zhang-Li STT source file must document its source contract");
    check(
        zhang_li.find("does not import plan fields or compute Slonczewski CPP torque") !=
            std::string::npos,
        "Zhang-Li STT source file must document its non-owning aggregate/Slonczewski boundary");
}

void stt_leaf_headers_document_non_owning_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string slonczewski_header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "stt_slonczewski.hpp");
    const std::string zhang_li_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "stt_zhang_li.hpp");

    check(
        slonczewski_header.find("does not own Zhang-Li CIP torque, reusable Zhang-Li scratch, aggregate family dispatch, or effective-field composition") !=
            std::string::npos,
        "Slonczewski STT header must document its non-owning Zhang-Li/scratch/composition boundary");
    check(
        zhang_li_header.find("does not own Slonczewski CPP torque, aggregate family dispatch, plan import, or effective-field composition") !=
            std::string::npos,
        "Zhang-Li STT header must document its non-owning Slonczewski/aggregate/composition boundary");
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

fullmag::fem::Context make_slonczewski_context() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.stt.slonczewski_enabled = true;
    ctx.stt.current_density_am2 = {0.0, 0.0, 1.0e12};
    ctx.stt.spin_polarization = {0.0, 0.0, 1.0};
    ctx.stt.degree = 1.0;
    ctx.stt.lambda = 1.0;
    ctx.stt.epsilon_prime = 0.25;
    ctx.stt.free_layer_thickness = 1.0e-9;
    ctx.stt.current_sign = 1.0;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.material.gyromagnetic_ratio = kGammaMu0Test;
    return ctx;
}

void slonczewski_cpp_rhs_uses_current_sign_and_field_like_term() {
    auto ctx = make_slonczewski_context();
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    const double prefactor =
        (1.0e12 * kHbarTest * kGammaMu0Test) /
        (2.0 * kElectronChargeTest * kMu0Test *
         ctx.material_fields.material.saturation_magnetisation * ctx.stt.free_layer_thickness);
    const double beta_stt = prefactor * 0.5;

    check_near(rhs[0], 0.0, 0.0, "Slonczewski rhs x");
    check_near(rhs[1], -ctx.stt.epsilon_prime * beta_stt, beta_stt * 1e-12, "Slonczewski field-like y");
    check_near(rhs[2], -beta_stt, beta_stt * 1e-12, "Slonczewski damping-like z");

    std::vector<double> signed_rhs(3u, 0.0);
    ctx.stt.current_sign = -1.0;
    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, signed_rhs);
    check_near(signed_rhs[2], beta_stt, beta_stt * 1e-12, "Slonczewski current sign");
}

void macrospin_cpp_sign_and_precession_direction_match_reference() {
    auto ctx = make_slonczewski_context();
    ctx.stt.epsilon_prime = 0.0;
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    const double prefactor =
        (1.0e12 * kHbarTest * kGammaMu0Test) /
        (2.0 * kElectronChargeTest * kMu0Test *
         ctx.material_fields.material.saturation_magnetisation * ctx.stt.free_layer_thickness);
    const double beta_stt = prefactor * 0.5;

    check_near(rhs[0], 0.0, 0.0, "macrospin CPP rhs x");
    check_near(rhs[1], 0.0, beta_stt * 1e-12, "macrospin CPP field-like-free y");
    check_near(
        rhs[2],
        -beta_stt,
        beta_stt * 1e-12,
        "macrospin CPP positive current drives m x (m x p) toward -p");

    std::vector<double> reversed_rhs(3u, 0.0);
    ctx.stt.current_sign = -1.0;
    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, reversed_rhs);
    check_near(
        reversed_rhs[2],
        beta_stt,
        beta_stt * 1e-12,
        "macrospin CPP current sign reverses the reference precession direction");
}

void slonczewski_uses_geometry_thickness_fallback_when_explicit_thickness_is_zero() {
    auto ctx = make_slonczewski_context();
    ctx.stt.free_layer_thickness = 0.0;
    ctx.mesh.n_nodes = 2;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        0.0, 0.0, 2.0e-9,
    };
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> rhs(6u, 0.0);

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    const double fallback_thickness = 2.0e-9;
    const double prefactor =
        (1.0e12 * kHbarTest * kGammaMu0Test) /
        (2.0 * kElectronChargeTest * kMu0Test *
         ctx.material_fields.material.saturation_magnetisation * fallback_thickness);
    const double beta_stt = prefactor * 0.5;

    check_near(
        rhs[2],
        -beta_stt,
        beta_stt * 1e-12,
        "Slonczewski geometry-derived thickness fallback");
}

void slonczewski_direct_torque_matches_effective_field_form_with_gilbert_damping() {
    auto ctx = make_slonczewski_context();
    ctx.material_fields.material.damping = 0.2;
    ctx.stt.epsilon_prime = 0.35;
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    const double prefactor =
        (1.0e12 * kHbarTest * kGammaMu0Test) /
        (2.0 * kElectronChargeTest * kMu0Test *
         ctx.material_fields.material.saturation_magnetisation * ctx.stt.free_layer_thickness);
    const double beta_stt = prefactor * 0.5;
    const double alpha = ctx.material_fields.material.damping;
    const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
    const double damping_like = beta_stt * (1.0 + alpha * ctx.stt.epsilon_prime) * inv_gilbert;
    const double field_like = beta_stt * (ctx.stt.epsilon_prime - alpha) * inv_gilbert;

    check_near(rhs[0], 0.0, 0.0, "Slonczewski Gilbert-equivalent rhs x");
    check_near(rhs[1], -field_like, std::abs(field_like) * 1e-12, "Slonczewski Gilbert-equivalent field-like y");
    check_near(rhs[2], -damping_like, std::abs(damping_like) * 1e-12, "Slonczewski Gilbert-equivalent damping-like z");
}

void slonczewski_skips_nonmagnetic_nodes() {
    auto ctx = make_slonczewski_context();
    ctx.mesh.magnetic_node_mask = {0u};
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs = {1.0, 2.0, 3.0};

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    check_near(rhs[0], 1.0, 0.0, "masked Slonczewski rhs x");
    check_near(rhs[1], 2.0, 0.0, "masked Slonczewski rhs y");
    check_near(rhs[2], 3.0, 0.0, "masked Slonczewski rhs z");
}

fullmag::fem::Context make_zhang_li_context() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 4;
    ctx.mesh.n_elements = 1;
    ctx.stt.zhang_li_enabled = true;
    ctx.stt.current_density_am2 = {1.0e12, 0.0, 0.0};
    ctx.stt.degree = 1.0;
    ctx.stt.beta = 0.0;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.material.damping = 0.0;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.mesh.cell_nodes = {0, 1, 2, 3};
    ctx.mesh.magnetic_element_mask = {1u};
    return ctx;
}

void zhang_li_rhs_uses_gilbert_alpha_beta_projection() {
    auto ctx = make_zhang_li_context();
    ctx.stt.beta = 0.2;
    ctx.material_fields.material.damping = 0.5;
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> rhs(12u, 0.0);

    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, m, rhs);

    const double u_x =
        (ctx.stt.degree * kBohrMagnetonTest * ctx.stt.current_density_am2[0]) /
        (kElectronChargeTest * ctx.material_fields.material.saturation_magnetisation *
         (1.0 + ctx.stt.beta * ctx.stt.beta));
    const double alpha = ctx.material_fields.material.damping;
    const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
    const double adiabatic = (1.0 + alpha * ctx.stt.beta) * u_x * inv_gilbert;
    const double nonadiabatic_y = (ctx.stt.beta - alpha) * u_x * inv_gilbert;

    check_near(rhs[0], 0.0, 0.0, "Zhang-Li Gilbert node0 rhs x");
    check_near(rhs[1], nonadiabatic_y, std::abs(nonadiabatic_y) * 1e-12, "Zhang-Li Gilbert node0 rhs y");
    check_near(rhs[2], adiabatic, adiabatic * 1e-12, "Zhang-Li Gilbert node0 rhs z");
    check_near(rhs[3], -adiabatic, adiabatic * 1e-12, "Zhang-Li Gilbert node1 rhs x");
    check_near(rhs[4], nonadiabatic_y, std::abs(nonadiabatic_y) * 1e-12, "Zhang-Li Gilbert node1 rhs y");
    check_near(rhs[5], adiabatic, adiabatic * 1e-12, "Zhang-Li Gilbert node1 rhs z");
}

void zhang_li_rhs_uses_tetra_gradient_and_nodal_projection() {
    auto ctx = make_zhang_li_context();
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> rhs(12u, 0.0);

    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, m, rhs);

    const double u_x =
        (ctx.stt.degree * kBohrMagnetonTest * ctx.stt.current_density_am2[0]) /
        (kElectronChargeTest * ctx.material_fields.material.saturation_magnetisation);

    check_near(rhs[0], 0.0, 0.0, "Zhang-Li node0 rhs x");
    check_near(rhs[1], 0.0, 0.0, "Zhang-Li node0 rhs y");
    check_near(rhs[2], u_x, u_x * 1e-12, "Zhang-Li node0 rhs z");
    check_near(rhs[3], -u_x, u_x * 1e-12, "Zhang-Li node1 rhs x");
    check_near(rhs[5], u_x, u_x * 1e-12, "Zhang-Li node1 rhs z");
}

void zhang_li_skew_tetra_affine_rhs_matches_analytic_gradient() {
    auto ctx = make_zhang_li_context();
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        2.0, 0.0, 0.0,
        1.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };

    const std::array<fullmag::fem::test::Vec3, 4> points = {{
        {0.0, 0.0, 0.0}, {2.0, 0.0, 0.0}, {1.0, 1.0, 0.0}, {0.0, 0.0, 1.0},
    }};
    std::array<fullmag::fem::test::Vec3, 4> gradients{};
    check(fullmag::fem::test::p1_tetra_gradients(points, gradients), "skew tetra oracle geometry is nondegenerate");
    const std::array<fullmag::fem::test::Vec3, 4> expected_gradients = {{
        {-0.5, -0.5, -1.0}, {0.5, -0.5, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0},
    }};
    for (size_t node = 0; node < gradients.size(); ++node) {
        for (size_t direction = 0; direction < 3; ++direction) {
            check_near(gradients[node][direction], expected_gradients[node][direction], 1e-15, "skew tetra P1 gradient");
        }
    }
    for (size_t direction = 0; direction < 3; ++direction) {
        double sum = 0.0;
        for (const auto &gradient : gradients) {
            sum += gradient[direction];
        }
        check_near(sum, 0.0, 1e-15, "skew tetra P1 gradients sum to zero");
    }

    const double u_x =
        (ctx.stt.degree * kBohrMagnetonTest * ctx.stt.current_density_am2[0]) /
        (kElectronChargeTest * ctx.material_fields.material.saturation_magnetisation);
    const std::vector<double> mx = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 2.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> rhs(12u, 0.0);

    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, mx, rhs);

    const fullmag::fem::test::Vec3 affine_mz_gradient = {1.0, 0.0, 0.0};
    check_near(
        affine_mz_gradient[0],
        0.0 * gradients[0][0] + 2.0 * gradients[1][0] + 1.0 * gradients[2][0] + 0.0 * gradients[3][0],
        1e-15,
        "skew tetra affine m_z derivative x");

    for (size_t node = 0; node < 4; ++node) {
        const double mz = mx[node * 3u + 2u];
        check_near(rhs[node * 3u + 0u], -mz * u_x, std::max(std::abs(mz * u_x) * 1e-12, 1e-24), "Zhang-Li skew-tetra affine rhs x");
        check_near(rhs[node * 3u + 1u], 0.0, 1e-24, "Zhang-Li skew-tetra affine rhs y");
        check_near(rhs[node * 3u + 2u], u_x, u_x * 1e-12, "Zhang-Li skew-tetra affine rhs z");
    }

    const std::vector<double> my = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    std::fill(rhs.begin(), rhs.end(), 0.0);
    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, my, rhs);
    for (double value : rhs) {
        check_near(value, 0.0, 1e-24, "Zhang-Li skew-tetra transverse affine rhs");
    }
}

void zhang_li_current_direction_reverses_rhs() {
    auto forward = make_zhang_li_context();
    auto reverse = make_zhang_li_context();
    reverse.stt.current_density_am2 = {-1.0e12, 0.0, 0.0};
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> forward_rhs(12u, 0.0);
    std::vector<double> reverse_rhs(12u, 0.0);

    fullmag::fem::add_zhang_li_stt_rhs_aos(forward, m, forward_rhs);
    fullmag::fem::add_zhang_li_stt_rhs_aos(reverse, m, reverse_rhs);

    for (size_t i = 0; i < forward_rhs.size(); ++i) {
        check_near(
            reverse_rhs[i],
            -forward_rhs[i],
            std::max(std::fabs(forward_rhs[i]) * 1e-12, 1e-24),
            "Zhang-Li current direction reversal");
    }
}

void zhang_li_adds_torque_without_scaling_existing_rhs() {
    auto ctx = make_zhang_li_context();
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> rhs(12u, 10.0);

    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, m, rhs);

    const double u_x =
        (ctx.stt.degree * kBohrMagnetonTest * ctx.stt.current_density_am2[0]) /
        (kElectronChargeTest * ctx.material_fields.material.saturation_magnetisation);

    check_near(rhs[0], 10.0, 0.0, "Zhang-Li preserves existing rhs x");
    check_near(rhs[2], 10.0 + u_x, u_x * 1e-12, "Zhang-Li adds to existing rhs z");
    check_near(rhs[3], 10.0 - u_x, u_x * 1e-12, "Zhang-Li adds node1 rhs x");
    check_near(rhs[5], 10.0 + u_x, u_x * 1e-12, "Zhang-Li adds node1 rhs z");
}

void combined_stt_updates_max_rhs() {
    auto ctx = make_slonczewski_context();
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);
    double max_rhs = 0.0;

    fullmag::fem::add_stt_rhs_aos(ctx, m, rhs, max_rhs);

    check(max_rhs > 0.0, "combined STT updates max_rhs");
}

void stt_plan_import_copies_parameters_and_validates_family() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan{};
    plan.has_slonczewski_stt = 1;
    plan.stt_current_density_am2[0] = 1.0;
    plan.stt_current_density_am2[1] = 2.0;
    plan.stt_current_density_am2[2] = 3.0;
    plan.stt_degree = 0.7;
    plan.stt_beta = 0.2;
    plan.stt_spin_polarization[2] = 4.0;
    plan.stt_lambda = 1.5;
    plan.stt_epsilon_prime = 0.25;
    plan.stt_free_layer_thickness = 2.0e-9;
    plan.stt_current_sign = -1.0;

    std::string error;
    check(fullmag::fem::initialize_stt_plan_fields(ctx, plan, error), error.c_str());
    check(ctx.stt.slonczewski_enabled, "Slonczewski flag copied");
    check(!ctx.stt.zhang_li_enabled, "Zhang-Li flag copied");
    check(ctx.stt.current_density_am2[2] == 3.0, "STT current density copied");
    check(ctx.stt.degree == 0.7, "STT degree copied");
    check(ctx.stt.beta == 0.2, "STT beta copied");
    check(ctx.stt.spin_polarization[2] == 1.0, "STT spin polarization normalized");
    check(ctx.stt.lambda == 1.5, "STT lambda copied");
    check(ctx.stt.epsilon_prime == 0.25, "STT epsilon prime copied");
    check(ctx.stt.free_layer_thickness == 2.0e-9, "STT free-layer thickness copied");
    check(ctx.stt.current_sign == -1.0, "STT current sign copied");

    plan.has_zhang_li_stt = 1;
    check(
        !fullmag::fem::initialize_stt_plan_fields(ctx, plan, error),
        "simultaneous STT families must fail");
    check(
        error.find("only one executable STT family") != std::string::npos,
        "STT family validation error should identify exclusivity");

    plan.has_zhang_li_stt = 0;
    plan.stt_spin_polarization[2] = 0.0;
    check(
        !fullmag::fem::initialize_stt_plan_fields(ctx, plan, error),
        "zero Slonczewski spin polarization must fail");
    check(
        error.find("stt_spin_polarization") != std::string::npos,
        "STT spin-polarization error should identify the field");

    plan.stt_spin_polarization[2] = 1.0;
    plan.stt_lambda = 0.5;
    check(
        !fullmag::fem::initialize_stt_plan_fields(ctx, plan, error),
        "Slonczewski lambda below one must fail");
    check(
        error.find("stt_lambda") != std::string::npos,
        "STT lambda validation error should identify the field");

    plan.stt_lambda = 1.0;
    plan.stt_degree = -0.1;
    check(
        !fullmag::fem::initialize_stt_plan_fields(ctx, plan, error),
        "negative STT degree must fail");
    check(
        error.find("stt_degree") != std::string::npos,
        "STT degree validation error should identify the field");
}

} // namespace

int main() {
    slonczewski_cpp_is_owned_by_slonczewski_module();
    zhang_li_cip_is_owned_by_zhang_li_module();
    stt_plan_fields_are_owned_by_stt_module();
    stt_aggregate_header_documents_submodule_boundaries();
    stt_rhs_hot_path_uses_reusable_workspace();
    stt_source_files_document_module_boundaries();
    stt_leaf_headers_document_non_owning_boundaries();
    slonczewski_cpp_rhs_uses_current_sign_and_field_like_term();
    macrospin_cpp_sign_and_precession_direction_match_reference();
    slonczewski_uses_geometry_thickness_fallback_when_explicit_thickness_is_zero();
    slonczewski_direct_torque_matches_effective_field_form_with_gilbert_damping();
    slonczewski_skips_nonmagnetic_nodes();
    zhang_li_rhs_uses_tetra_gradient_and_nodal_projection();
    zhang_li_skew_tetra_affine_rhs_matches_analytic_gradient();
    zhang_li_rhs_uses_gilbert_alpha_beta_projection();
    zhang_li_current_direction_reverses_rhs();
    zhang_li_adds_torque_without_scaling_existing_rhs();
    combined_stt_updates_max_rhs();
    stt_plan_import_copies_parameters_and_validates_family();
    return 0;
}
