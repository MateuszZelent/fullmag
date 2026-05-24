/*
 * magnetoelastic_contract.cpp - native FEM magnetoelastic contract tests.
 *
 * Magnetoelasticity contributes an H_eff field in A/m and a conservative
 * coupling energy in J. The executable contract is prescribed small strain in
 * Voigt engineering-shear form.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"

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

void magnetoelastic_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic.hpp");
    const std::string prescribed =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.cpp");
    const std::string prescribed_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.hpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_field.hpp");

    const char *compute_symbol = "void compute_magnetoelastic_field(";
    const char *add_symbol = "void add_magnetoelastic_field(";
    const char *plan_symbol = "void initialize_magnetoelastic_plan_fields(";
    const char *upload_symbol = "bool upload_magnetoelastic_strain(";

    check(
        aggregate.find(compute_symbol) == std::string::npos,
        "magnetoelastic field/energy compute must not be defined in magnetoelastic.cpp");
    check(
        aggregate.find(add_symbol) == std::string::npos,
        "magnetoelastic H_eff addition must not be defined in magnetoelastic.cpp");
    check(
        context.find("ctx.magnetoelastic.enabled = plan.has_magnetoelastic") == std::string::npos,
        "Context must not own magnetoelastic flag plan import");
    check(
        context.find("plan.mel_strain_voigt") == std::string::npos,
        "Context must not own magnetoelastic strain plan import");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "magnetoelastic plan import must be defined in magnetoelastic.cpp");
    check(
        aggregate.find(upload_symbol) != std::string::npos,
        "magnetoelastic strain upload must be defined in magnetoelastic.cpp");
    check(
        api.find("ctx.magnetoelastic.uniform_strain = uniform != 0") == std::string::npos,
        "C ABI facade must not own magnetoelastic strain mode mutation");
    check(
        api.find("ctx.magnetoelastic.strain_voigt.assign") == std::string::npos,
        "C ABI facade must not own magnetoelastic strain buffer mutation");
    check(
        api.find("gpu_state_upload_magnetoelastic_strain") == std::string::npos,
        "C ABI facade must not own magnetoelastic GPU strain upload");
    check(
        api.find("compute_magnetoelastic_field(ctx") == std::string::npos,
        "C ABI facade must not own magnetoelastic field recompute after strain upload");
    check(
        prescribed.find(compute_symbol) != std::string::npos,
        "magnetoelastic field/energy compute must be defined in magnetoelastic_prescribed_strain.cpp");
    check(
        field.find(add_symbol) != std::string::npos,
        "magnetoelastic H_eff addition must be defined in magnetoelastic_field.cpp");
    check(
        prescribed_header.find("Compute prescribed-strain magnetoelastic effective field and energy") !=
            std::string::npos,
        "magnetoelastic prescribed-strain header must document its physical contract");
    check(
        prescribed_header.find("does not import plan fields or add H_mel to H_eff") !=
            std::string::npos,
        "magnetoelastic prescribed-strain header must document its non-owning aggregate/add boundary");
    check(
        field_header.find("Add the current magnetoelastic H field") != std::string::npos,
        "magnetoelastic field-add header must document its physical contract");
    check(
        field_header.find("does not compute B1/B2 field/energy or import strain plan fields") !=
            std::string::npos,
        "magnetoelastic field-add header must document its non-owning compute/plan boundary");
    check(
        aggregate_header.find("Initialize prescribed-strain magnetoelastic plan fields") !=
            std::string::npos,
        "magnetoelastic aggregate header must document plan-field initialization ownership");
    check(
        aggregate_header.find("Upload prescribed magnetoelastic strain") != std::string::npos,
        "magnetoelastic aggregate header must document runtime strain-upload ownership");
    check(
        aggregate_header.find("does not compute B1/B2 H_mel/energy or add H_mel to H_eff") !=
            std::string::npos,
        "magnetoelastic aggregate header must document its non-owning field boundary");
    check(
        aggregate_header.find("magnetoelastic_prescribed_strain.*") != std::string::npos,
        "magnetoelastic aggregate header must name the prescribed-strain owner");
    check(
        aggregate_header.find("magnetoelastic_field.*") != std::string::npos,
        "magnetoelastic aggregate header must name the field-add owner");
}

void magnetoelastic_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic.cpp");
    const std::string prescribed =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.cpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_field.cpp");

    check(
        aggregate.find("Magnetoelastic aggregate source contract") != std::string::npos,
        "magnetoelastic aggregate source file must document its source contract");
    check(
        aggregate.find("does not compute B1/B2 H_mel/energy or add H_mel to H_eff") !=
            std::string::npos,
        "magnetoelastic aggregate source file must document its non-owning field boundary");
    check(
        prescribed.find("Prescribed-strain magnetoelastic source contract") !=
            std::string::npos,
        "magnetoelastic prescribed-strain source file must document its source contract");
    check(
        prescribed.find("does not import plan fields or add H_mel to H_eff") !=
            std::string::npos,
        "magnetoelastic prescribed-strain source file must document its non-owning aggregate/add boundary");
    check(
        field.find("Magnetoelastic field-add source contract") != std::string::npos,
        "magnetoelastic field-add source file must document its source contract");
    check(
        field.find("does not compute B1/B2 field/energy or import strain plan fields") !=
            std::string::npos,
        "magnetoelastic field-add source file must document its non-owning compute/plan boundary");
}

void magnetoelastic_runtime_state_is_owned_by_prescribed_strain_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string prescribed_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.hpp");

    fullmag::fem::MagnetoelasticRuntimeState runtime;
    runtime.enabled = true;
    runtime.b1 = 1.0;
    runtime.b2 = 2.0;
    runtime.uniform_strain = false;
    runtime.strain_voigt = {0.1, 0.2, 0.3, 0.04, 0.05, 0.06};
    check(runtime.enabled, "magnetoelastic runtime state owns enablement");
    check(runtime.b1 == 1.0, "magnetoelastic runtime state owns B1");
    check(runtime.b2 == 2.0, "magnetoelastic runtime state owns B2");
    check(!runtime.uniform_strain, "magnetoelastic runtime state owns strain mode");
    check(runtime.strain_voigt.size() == 6u, "magnetoelastic runtime state owns strain buffer");

    check(
        prescribed_header.find("struct MagnetoelasticRuntimeState") != std::string::npos,
        "magnetoelastic runtime state must be declared by magnetoelastic_prescribed_strain.hpp");
    check(
        prescribed_header.find("bool enabled") != std::string::npos,
        "magnetoelastic runtime state must own enablement");
    check(
        prescribed_header.find("double b1") != std::string::npos,
        "magnetoelastic runtime state must own B1");
    check(
        prescribed_header.find("double b2") != std::string::npos,
        "magnetoelastic runtime state must own B2");
    check(
        prescribed_header.find("bool uniform_strain") != std::string::npos,
        "magnetoelastic runtime state must own strain mode");
    check(
        prescribed_header.find("std::vector<double> strain_voigt") != std::string::npos,
        "magnetoelastic runtime state must own strain buffer");
    check(
        prescribed_header.find("std::vector<double> h_xyz") != std::string::npos,
        "magnetoelastic runtime state must own the H_mel field buffer");
    check(
        prescribed_header.find("double energy_joules") != std::string::npos,
        "magnetoelastic runtime state must own the conservative energy diagnostic");
    check(
        context_header.find("MagnetoelasticRuntimeState magnetoelastic") != std::string::npos,
        "Context must store magnetoelastic runtime state through the prescribed-strain owner");
    check(
        context_header.find("bool enable_magnetoelastic") == std::string::npos,
        "Context must not own flat magnetoelastic enablement");
    check(
        context_header.find("double mel_b1") == std::string::npos,
        "Context must not own flat magnetoelastic B1");
    check(
        context_header.find("double mel_b2") == std::string::npos,
        "Context must not own flat magnetoelastic B2");
    check(
        context_header.find("bool mel_uniform_strain") == std::string::npos,
        "Context must not own flat magnetoelastic strain mode");
    check(
        context_header.find("std::vector<double> mel_strain_voigt") == std::string::npos,
        "Context must not own flat magnetoelastic strain buffer");
    check(
        context_header.find("h_mel_xyz") == std::string::npos,
        "Context must not own a flat magnetoelastic H field buffer");
    check(
        context_header.find("mel_energy") == std::string::npos,
        "Context must not own flat magnetoelastic energy state");
    check(
        context_header.find("last_magnetoelastic_energy_joules") == std::string::npos,
        "Context must not own a flat magnetoelastic step-metrics energy cache");
}

void engineering_shear_voigt_convention_is_backend_neutral() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path repo_root = root.parent_path().parent_path().parent_path();
    const std::string prescribed =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.cpp");
    const std::string prescribed_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.hpp");
    const std::string gpu_magnetoelastic =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "magnetoelastic" / "magnetoelastic_kernels.cu");
    const std::string fem_note =
        read_text_file(repo_root / "docs" / "physics" / "0720-fem-magnetoelastic-small-strain-mfem-gpu.md");
    const char *voigt_order = "[e11, e22, e33, 2e23, 2e13, 2e12]";

    check(
        prescribed_header.find(voigt_order) != std::string::npos,
        "CPU magnetoelastic header must document engineering-shear Voigt order");
    check(
        fem_note.find(voigt_order) != std::string::npos,
        "FEM GPU magnetoelastic physics note must document engineering-shear Voigt order");
    check(
        prescribed.find("const double tensor_e23 = eps[3] * 0.5;") != std::string::npos,
        "CPU magnetoelastic evaluator must convert engineering 2e23 to tensor e23");
    check(
        prescribed.find("const double tensor_e13 = eps[4] * 0.5;") != std::string::npos,
        "CPU magnetoelastic evaluator must convert engineering 2e13 to tensor e13");
    check(
        prescribed.find("const double tensor_e12 = eps[5] * 0.5;") != std::string::npos,
        "CPU magnetoelastic evaluator must convert engineering 2e12 to tensor e12");
    check(
        gpu_magnetoelastic.find("tensor_e23 = eps[3] * 0.5;") != std::string::npos,
        "GPU magnetoelastic kernel must convert engineering 2e23 to tensor e23");
    check(
        gpu_magnetoelastic.find("tensor_e13 = eps[4] * 0.5;") != std::string::npos,
        "GPU magnetoelastic kernel must convert engineering 2e13 to tensor e13");
    check(
        gpu_magnetoelastic.find("tensor_e12 = eps[5] * 0.5;") != std::string::npos,
        "GPU magnetoelastic kernel must convert engineering 2e12 to tensor e12");
    check(
        gpu_magnetoelastic.find("2.0 * b2 * (lmx * lmy * tensor_e12 + lmx * lmz * tensor_e13 + lmy * lmz * tensor_e23)") !=
            std::string::npos,
        "GPU magnetoelastic energy must use tensor shear after engineering-shear conversion");
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
    ctx.magnetoelastic.enabled = true;
    ctx.magnetoelastic.b1 = 1.0e6;
    ctx.magnetoelastic.b2 = 2.0e6;
    ctx.magnetoelastic.uniform_strain = true;
    ctx.magnetoelastic.strain_voigt = {0.1, 0.2, 0.3, 0.04, 0.06, 0.08};
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.integration_weights.mfem_lumped_mass = {5.0e-27, 7.0e-27};
    return ctx;
}

void uniform_strain_field_and_energy_follow_b1_b2_contract() {
    auto ctx = make_context();
    const std::vector<double> m = {
        1.0, 2.0, 3.0,
        0.0, 1.0, 0.0,
    };

    fullmag::fem::compute_magnetoelastic_field(ctx, m);

    const double e11 = 0.1;
    const double e22 = 0.2;
    const double e33 = 0.3;
    const double e23 = 0.02;
    const double e13 = 0.03;
    const double e12 = 0.04;
    const double inv_mu0_ms = -1.0 / (kMu0Test * ctx.material_fields.material.saturation_magnetisation);

    check_near(
        ctx.magnetoelastic.h_xyz[0],
        inv_mu0_ms * (2.0 * ctx.magnetoelastic.b1 * 1.0 * e11 + 2.0 * ctx.magnetoelastic.b2 * (2.0 * e12 + 3.0 * e13)),
        1e-6,
        "magnetoelastic Hx");
    check_near(
        ctx.magnetoelastic.h_xyz[1],
        inv_mu0_ms * (2.0 * ctx.magnetoelastic.b1 * 2.0 * e22 + 2.0 * ctx.magnetoelastic.b2 * (1.0 * e12 + 3.0 * e23)),
        1e-6,
        "magnetoelastic Hy");
    check_near(
        ctx.magnetoelastic.h_xyz[2],
        inv_mu0_ms * (2.0 * ctx.magnetoelastic.b1 * 3.0 * e33 + 2.0 * ctx.magnetoelastic.b2 * (1.0 * e13 + 2.0 * e23)),
        1e-6,
        "magnetoelastic Hz");

    const double e_density0 =
        ctx.magnetoelastic.b1 * (1.0 * 1.0 * e11 + 2.0 * 2.0 * e22 + 3.0 * 3.0 * e33) +
        2.0 * ctx.magnetoelastic.b2 * (1.0 * 2.0 * e12 + 1.0 * 3.0 * e13 + 2.0 * 3.0 * e23);
    const double e_density1 = ctx.magnetoelastic.b1 * e22;
    const double expected_energy =
        e_density0 * ctx.integration_weights.mfem_lumped_mass[0] +
        e_density1 * ctx.integration_weights.mfem_lumped_mass[1];
    check_near(
        ctx.magnetoelastic.energy_joules,
        expected_energy,
        std::fabs(expected_energy) * 1e-12,
        "magnetoelastic energy");
}

void per_node_strain_and_masking_are_respected() {
    auto ctx = make_context();
    ctx.magnetoelastic.uniform_strain = false;
    ctx.magnetoelastic.strain_voigt = {
        0.1, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.2, 0.0, 0.0, 0.0, 0.0,
    };
    ctx.material_fields.Ms_field = {800e3, 400e3};
    ctx.mesh.magnetic_node_mask = {1u, 0u};
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };

    fullmag::fem::compute_magnetoelastic_field(ctx, m);

    const double expected_hx =
        -1.0 / (kMu0Test * ctx.material_fields.Ms_field[0]) * (2.0 * ctx.magnetoelastic.b1 * 0.1);
    check_near(ctx.magnetoelastic.h_xyz[0], expected_hx, 1e-6, "per-node magnetoelastic Hx");
    check_near(ctx.magnetoelastic.h_xyz[3], 0.0, 0.0, "masked magnetoelastic Hx");
    check_near(ctx.magnetoelastic.h_xyz[4], 0.0, 0.0, "masked magnetoelastic Hy");
    check_near(ctx.magnetoelastic.h_xyz[5], 0.0, 0.0, "masked magnetoelastic Hz");
}

void add_magnetoelastic_field_is_additive() {
    fullmag::fem::Context ctx;
    ctx.magnetoelastic.enabled = true;
    ctx.magnetoelastic.h_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_magnetoelastic_field(ctx, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "magnetoelastic Hx added");
    check_near(h_eff[1], 22.0, 0.0, "magnetoelastic Hy added");
    check_near(h_eff[2], 33.0, 0.0, "magnetoelastic Hz added");
}

void magnetoelastic_plan_import_copies_coupling_and_strain() {
    fullmag::fem::Context ctx;
    ctx.magnetoelastic.energy_joules = 42.0;
    const double strain[] = {0.1, 0.2, 0.3, 0.04, 0.05, 0.06};
    fullmag_fem_plan_desc plan{};
    plan.has_magnetoelastic = 1;
    plan.mel_b1 = 1.5e6;
    plan.mel_b2 = -2.5e6;
    plan.mel_uniform_strain = 1;
    plan.mel_strain_voigt = strain;
    plan.mel_strain_len = 6;

    fullmag::fem::initialize_magnetoelastic_plan_fields(ctx, plan);

    check(ctx.magnetoelastic.enabled, "magnetoelastic flag copied from plan");
    check_near(ctx.magnetoelastic.b1, 1.5e6, 0.0, "magnetoelastic B1 copied");
    check_near(ctx.magnetoelastic.b2, -2.5e6, 0.0, "magnetoelastic B2 copied");
    check(ctx.magnetoelastic.uniform_strain, "magnetoelastic uniform strain flag copied");
    check(ctx.magnetoelastic.strain_voigt == std::vector<double>({0.1, 0.2, 0.3, 0.04, 0.05, 0.06}),
          "magnetoelastic strain copied from plan");
    check_near(ctx.magnetoelastic.energy_joules, 0.0, 0.0, "magnetoelastic energy reset on plan import");
}

void magnetoelastic_runtime_upload_updates_strain_and_recomputes_field() {
    auto ctx = make_context();
    ctx.magnetoelastic.uniform_strain = true;
    ctx.magnetoelastic.strain_voigt.clear();
    ctx.state.m_xyz = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    const double strain[] = {
        0.1, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.2, 0.0, 0.0, 0.0, 0.0,
    };
    std::string error;

    check(
        fullmag::fem::upload_magnetoelastic_strain(ctx, strain, 12, false, error),
        error.c_str());

    check(!ctx.magnetoelastic.uniform_strain, "runtime strain upload updates strain mode");
    check(ctx.magnetoelastic.strain_voigt == std::vector<double>(strain, strain + 12),
          "runtime strain upload updates strain buffer");
    check_near(ctx.magnetoelastic.h_xyz[0], -2.0 * ctx.magnetoelastic.b1 * 0.1 /
                                             (kMu0Test * ctx.material_fields.material.saturation_magnetisation),
               1e-6, "runtime strain upload recomputes H_mel");

    check(
        !fullmag::fem::upload_magnetoelastic_strain(ctx, nullptr, 0, true, error),
        "runtime strain upload rejects null/empty strain");
    check(
        error.find("strain data pointer is null or length is zero") != std::string::npos,
        "runtime strain upload reports invalid strain input");
}

} // namespace

int main() {
    magnetoelastic_responsibilities_are_owned_by_separate_modules();
    magnetoelastic_source_files_document_module_boundaries();
    magnetoelastic_runtime_state_is_owned_by_prescribed_strain_module();
    engineering_shear_voigt_convention_is_backend_neutral();
    uniform_strain_field_and_energy_follow_b1_b2_contract();
    per_node_strain_and_masking_are_respected();
    add_magnetoelastic_field_is_additive();
    magnetoelastic_plan_import_copies_coupling_and_strain();
    magnetoelastic_runtime_upload_updates_strain_and_recomputes_field();
    return 0;
}
