/*
 * stt_contract.cpp - native FEM spin-transfer torque contract tests.
 *
 * STT contributes directly to dm/dt RHS, not to H_eff. These tests cover the
 * executable Slonczewski CPP and Zhang-Li CIP paths without requiring MFEM.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/sot.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
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
constexpr double kExactElectronChargeTest = 1.602176634e-19;
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

void canonical_slonczewski_gpu_descriptor_contract_is_source_visible() {
    const std::filesystem::path root = fem_source_root();
    const std::string kernels = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.cu");
    const std::string header = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.hpp");
    const std::string torque = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_slonczewski_torque.cu");
    const std::string mesh_regions = read_text_file(
        root / "gpu" / "cuda" / "mesh" / "mesh_regions_state.hpp");
    const std::string runtime = read_text_file(
        root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.cpp");

    check(
        header.find("formula_version") != std::string::npos &&
            header.find("current_density_x") != std::string::npos &&
            header.find("stack_normal_x") != std::string::npos &&
            header.find("active_node_mask") != std::string::npos,
        "FEM GPU Slonczewski descriptor must carry formula version, vector current, stack normal, and target mask");
    check(
        kernels.find("FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2") != std::string::npos &&
            kernels.find("kExactElectronCharge") != std::string::npos &&
            kernels.find("current_density_x") != std::string::npos &&
            kernels.find("stack_normal_x") != std::string::npos,
        "FEM GPU Slonczewski kernel must implement the canonical v2 signed-current branch");
    check(
        torque.find("ctx.stt.formula_version") != std::string::npos &&
            torque.find("ctx.stt.stack_normal") != std::string::npos &&
            torque.find("stt_active_node_mask") != std::string::npos,
        "FEM GPU RK torque wrapper must forward the canonical descriptor and target mask");
    check(
        mesh_regions.find("stt_active_node_mask") != std::string::npos,
        "FEM GPU mesh-region state must own the optional STT target mask");
    check(
        runtime.find("gpu_state_upload_stt_target_mask") != std::string::npos,
        "FEM GPU bootstrap must upload the STT target mask through the state module");
}

void canonical_zhang_li_gpu_descriptor_matches_cpu_contract() {
    const std::filesystem::path root = fem_source_root();
    const std::string kernels = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.cu");
    const std::string header = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.hpp");
    const std::string torque = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_zhang_li_torque.cu");
    const std::string mesh_regions = read_text_file(
        root / "gpu" / "cuda" / "mesh" / "mesh_regions_state.hpp");
    const std::string runtime = read_text_file(
        root / "gpu" / "cuda" / "runtime" / "gpu_state_runtime.cpp");
    const std::string state_header = read_text_file(
        root / "gpu" / "cuda" / "state" / "gpu_state.hpp");

    check(
        header.find("active_element_mask") != std::string::npos &&
            header.find("formula_version") != std::string::npos &&
            header.find("lande_g") != std::string::npos,
        "FEM GPU Zhang-Li descriptor must carry target-element mask, formula version, and Landé factor");
    check(
        kernels.find("FULLMAG_FEM_STT_FORMULA_ZHANG_LI_V1") != std::string::npos &&
            kernels.find("kExactElectronCharge") != std::string::npos &&
            kernels.find("active_element_mask") != std::string::npos &&
            kernels.find("canonical_v1") != std::string::npos,
        "FEM GPU Zhang-Li kernel must implement the canonical exact-constant branch and target-element mask");
    check(
        torque.find("ctx.stt.formula_version") != std::string::npos &&
            torque.find("ctx.stt.lande_g") != std::string::npos &&
            torque.find("active_element_mask") != std::string::npos,
        "FEM GPU RK Zhang-Li wrapper must forward the canonical descriptor and target-element mask");
    check(
        mesh_regions.find("stt_active_element_mask") != std::string::npos,
        "FEM GPU mesh-region state must own the optional Zhang-Li target-element mask");
    check(
        runtime.find("gpu_state_upload_stt_element_mask") != std::string::npos &&
            state_header.find("gpu_state_upload_stt_element_mask") != std::string::npos,
        "FEM GPU bootstrap must upload the Zhang-Li target-element mask through the state module");
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

void prescribed_sot_module_owns_local_physics() {
    const std::filesystem::path root = fem_source_root();
    const std::string header = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "sot.hpp");
    const std::string source = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "sot.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");

    check(
        header.find("struct SotRuntimeState") != std::string::npos,
        "FEM SOT module must own prescribed-SOT runtime state");
    check(
        source.find("FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1") != std::string::npos &&
            source.find("kExactElectronCharge") != std::string::npos &&
            source.find("damping_like") != std::string::npos &&
            source.find("field_like") != std::string::npos,
        "FEM SOT source must own the canonical SI/Gilbert algebra");
    check(
        context_header.find("SotRuntimeState sot") != std::string::npos,
        "Context must store SOT state through the SOT owner");
}

void configure_sot_context(fullmag::fem::Context &ctx) {
    ctx.mesh.n_nodes = 1;
    ctx.mesh.magnetic_node_mask = {1u};
    ctx.sot.enabled = true;
    ctx.sot.formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    ctx.sot.current_density_am2 = 1.0e11;
    ctx.sot.xi_dl = 0.12;
    ctx.sot.xi_fl = -0.02;
    ctx.sot.thickness = 1.5e-9;
    ctx.sot.envelope_value = 0.25;
    ctx.sot.sigma = {0.0, 1.0, 0.0};
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.material.damping = 0.1;
    ctx.material_fields.material.gyromagnetic_ratio = kGammaMu0Test;
}

void prescribed_sot_rhs_matches_si_oracle_and_current_reversal() {
    fullmag::fem::Context ctx;
    configure_sot_context(ctx);
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);
    double max_rhs = 0.0;
    fullmag::fem::add_sot_rhs_aos(ctx, m, rhs, max_rhs, 0.0, 0.0);

    const double gamma_e = kGammaMu0Test / kMu0Test;
    const double omega_base = gamma_e * kHbarTest * ctx.sot.current_density_am2 *
        ctx.sot.envelope_value /
        (2.0 * kExactElectronChargeTest *
         ctx.material_fields.material.saturation_magnetisation * ctx.sot.thickness);
    const double omega_dl = omega_base * ctx.sot.xi_dl;
    const double omega_fl = omega_base * ctx.sot.xi_fl;
    const double inv_gilbert = 1.0 / (1.0 + ctx.material_fields.material.damping *
                                      ctx.material_fields.material.damping);
    const double damping_like = (omega_dl - ctx.material_fields.material.damping * omega_fl) * inv_gilbert;
    const double field_like = (omega_fl + ctx.material_fields.material.damping * omega_dl) * inv_gilbert;
    check_near(rhs[0], 0.0, 1e-30, "SOT macrospin rhs x");
    check_near(rhs[1], damping_like, std::abs(damping_like) * 1e-12, "SOT damping-like basis");
    check_near(rhs[2], field_like, std::abs(field_like) * 1e-12, "SOT field-like basis");

    ctx.sot.current_density_am2 = -ctx.sot.current_density_am2;
    std::vector<double> reversed(3u, 0.0);
    fullmag::fem::add_sot_rhs_aos(ctx, m, reversed, max_rhs, 0.0, 0.0);
    check_near(reversed[1], -rhs[1], std::abs(rhs[1]) * 1e-12, "SOT signed current reversal y");
    check_near(reversed[2], -rhs[2], std::abs(rhs[2]) * 1e-12, "SOT signed current reversal z");
}

void prescribed_sot_rhs_respects_magnetic_and_target_masks() {
    fullmag::fem::Context ctx;
    configure_sot_context(ctx);
    ctx.sot.active_node_mask = {0u};
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);
    double max_rhs = 0.0;
    fullmag::fem::add_sot_rhs_aos(ctx, m, rhs, max_rhs, 0.0, 0.0);
    check_near(rhs[0], 0.0, 0.0, "SOT target mask x");
    check_near(rhs[1], 0.0, 0.0, "SOT target mask y");
    check_near(rhs[2], 0.0, 0.0, "SOT target mask z");

    ctx.sot.active_node_mask.clear();
    ctx.mesh.magnetic_node_mask = {0u};
    rhs.assign(3u, 0.0);
    fullmag::fem::add_sot_rhs_aos(ctx, m, rhs, max_rhs, 0.0, 0.0);
    check_near(rhs[0], 0.0, 0.0, "SOT magnetic mask x");
    check_near(rhs[1], 0.0, 0.0, "SOT magnetic mask y");
    check_near(rhs[2], 0.0, 0.0, "SOT magnetic mask z");
}

void prescribed_sot_plan_import_validates_append_only_descriptor() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    fullmag_fem_plan_desc plan{};
    plan.has_prescribed_sot = 1;
    plan.sot_formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    plan.sot_current_density_am2 = 1.0e11;
    plan.sot_xi_dl = 0.1;
    plan.sot_xi_fl = 0.0;
    plan.sot_thickness = 1.0e-9;
    plan.sot_sigma[1] = 1.0;
    const uint8_t mask[2] = {1u, 0u};
    plan.sot_active_node_mask = mask;
    plan.sot_active_node_mask_len = 2;
    plan.sot_envelope_value = 1.0;
    std::string error;
    check(
        fullmag::fem::initialize_sot_plan_fields(ctx, plan, error),
        "canonical FEM SOT descriptor must import");
    check(ctx.sot.enabled && ctx.sot.active_node_mask.size() == 2u,
          "FEM SOT import must retain enablement and node mask");

    plan.sot_active_node_mask_len = 1;
    check(
        !fullmag::fem::initialize_sot_plan_fields(ctx, plan, error),
        "FEM SOT descriptor with a short node mask must fail closed");
    check(error.find("sot_active_node_mask") != std::string::npos,
          "FEM SOT short-mask error must identify the field");
}

void prescribed_sot_envelope_is_evaluated_at_rk_stage_time() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    fullmag_fem_plan_desc plan{};
    plan.has_prescribed_sot = 1;
    plan.sot_formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    plan.sot_current_density_am2 = 1.0e11;
    plan.sot_xi_dl = 0.1;
    plan.sot_thickness = 1.0e-9;
    plan.sot_sigma[1] = 1.0;
    plan.sot_envelope.abi_version = FULLMAG_FEM_SOT_ENVELOPE_ABI_VERSION;
    plan.sot_envelope.struct_size = sizeof(fullmag_fem_sot_envelope_desc);
    plan.sot_envelope.kind = FULLMAG_FEM_TIME_SINUSOIDAL;
    plan.sot_envelope.time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    plan.sot_envelope.amplitude = 2.0;
    plan.sot_envelope.frequency_hz = 1.0;
    plan.sot_envelope.offset = 0.5;
    std::string error;
    check(
        fullmag::fem::initialize_sot_plan_fields(ctx, plan, error),
        "stage-time SOT envelope descriptor must import");
    check_near(
        fullmag::fem::evaluate_sot_envelope(ctx.sot, 0.25, 0.0),
        2.5,
        1e-14,
        "stage-time sinusoidal SOT envelope");
    check_near(
        fullmag::fem::evaluate_sot_envelope(ctx.sot, 0.35, 0.10),
        2.5,
        1e-14,
        "stage-local sinusoidal SOT envelope");

    const fullmag_fem_time_point points[2] = {{0.0, 0.0}, {1.0, 2.0}};
    plan.sot_envelope.kind = FULLMAG_FEM_TIME_PIECEWISE_LINEAR;
    plan.sot_envelope.time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
    plan.sot_envelope.points = points;
    plan.sot_envelope.point_count = 2;
    check(
        fullmag::fem::initialize_sot_plan_fields(ctx, plan, error),
        "piecewise-linear SOT envelope descriptor must import");
    check_near(
        fullmag::fem::evaluate_sot_envelope(ctx.sot, 0.25, 0.0),
        0.5,
        1e-14,
        "piecewise-linear SOT envelope");
}

void prescribed_sot_event_alignment_handles_pulse_pwl_and_stage_local_time() {
    fullmag::fem::SotRuntimeState sot;
    sot.envelope_kind = FULLMAG_FEM_TIME_PULSE;
    sot.envelope_time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
    sot.envelope_t_on_s = 1.0e-13;
    sot.envelope_t_off_s = 2.0e-13;
    double event_time_s = 0.0;
    check(
        fullmag::fem::next_sot_envelope_event_time(
            sot, 0.0, 2.5e-13, 0.0, event_time_s),
        "pulse must expose the first future event");
    check_near(event_time_s, 1.0e-13, 1.0e-25, "pulse on event");
    check(
        fullmag::fem::next_sot_envelope_event_time(
            sot, 0.0, 2.5e-13, 1.0e12, event_time_s),
        "absolute pulse timing must ignore the unused stage origin");
    check_near(event_time_s, 1.0e-13, 1.0e-25, "absolute pulse event with unused stage origin");
    check(
        fullmag::fem::next_sot_envelope_event_time(
            sot, 1.0e-13, 2.5e-13, 0.0, event_time_s),
        "pulse must expose the off event after the on knot");
    check_near(event_time_s, 2.0e-13, 1.0e-25, "pulse off event");
    check(
        !fullmag::fem::next_sot_envelope_event_time(
            sot, 2.0e-13, 2.5e-13, 0.0, event_time_s),
        "pulse must not repeat an event at the accepted boundary");

    sot.envelope_kind = FULLMAG_FEM_TIME_PIECEWISE_LINEAR;
    sot.envelope_time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    sot.envelope_point_times_s = {1.0e-13, 3.0e-13, 5.0e-13};
    sot.envelope_point_values = {0.0, 1.0, 0.0};
    check(
        fullmag::fem::next_sot_envelope_event_time(
            sot, 1.0e-12, 3.0e-13, 1.0e-12, event_time_s),
        "stage-local PWL must expose a future knot in absolute time");
    check_near(event_time_s, 1.1e-12, 1.0e-24, "stage-local PWL event");
    check(
        !fullmag::fem::next_sot_envelope_event_time(
            sot, 1.0e-12, 5.0e-14, 1.0e-12, event_time_s),
        "PWL event outside the requested interval must not clip the step");
}

void configure_slonczewski_context(fullmag::fem::Context &ctx) {
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
}

void slonczewski_cpp_rhs_uses_current_sign_and_field_like_term() {
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
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
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
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
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
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
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
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
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
    ctx.mesh.magnetic_node_mask = {0u};
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs = {1.0, 2.0, 3.0};

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    check_near(rhs[0], 1.0, 0.0, "masked Slonczewski rhs x");
    check_near(rhs[1], 2.0, 0.0, "masked Slonczewski rhs y");
    check_near(rhs[2], 3.0, 0.0, "masked Slonczewski rhs z");
}

void canonical_slonczewski_uses_signed_stack_current_exact_constants_and_target_mask() {
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
    ctx.mesh.n_nodes = 2;
    ctx.stt.formula_version = FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2;
    ctx.stt.realization_version = FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_THIN_LAYER_V1;
    ctx.stt.current_density_am2 = {3.0e12, -4.0e12, 0.0};
    ctx.stt.stack_normal = {0.0, 1.0, 0.0};
    ctx.stt.active_node_mask = {1u, 0u};
    ctx.stt.epsilon_prime = 0.35;
    ctx.material_fields.material.damping = 0.2;
    const std::vector<double> m = {1.0, 0.0, 0.0, 1.0, 0.0, 0.0};
    std::vector<double> rhs(6u, 0.0);

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    const double jn = -4.0e12;
    const double gamma_e = kGammaMu0Test / kMu0Test;
    const double omega = gamma_e * kHbarTest * jn /
        (kExactElectronChargeTest * ctx.material_fields.material.saturation_magnetisation *
         ctx.stt.free_layer_thickness);
    const double epsilon = ctx.stt.degree * 0.5;
    const double alpha = ctx.material_fields.material.damping;
    const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
    const double damping_like = omega * (epsilon + alpha * ctx.stt.epsilon_prime) * inv_gilbert;
    const double field_like = omega * (ctx.stt.epsilon_prime - alpha * epsilon) * inv_gilbert;
    check_near(rhs[1], -field_like, std::abs(field_like) * 1e-12, "canonical Slonczewski independent epsilon_prime");
    check_near(rhs[2], -damping_like, std::abs(damping_like) * 1e-12, "canonical Slonczewski signed J dot n_stack");
    check_near(rhs[3], 0.0, 0.0, "canonical Slonczewski target mask x");
    check_near(rhs[4], 0.0, 0.0, "canonical Slonczewski target mask y");
    check_near(rhs[5], 0.0, 0.0, "canonical Slonczewski target mask z");

    ctx.stt.current_density_am2 = {-3.0e12, 4.0e12, 0.0};
    std::vector<double> reversed(6u, 0.0);
    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, reversed);
    check_near(reversed[1], -rhs[1], std::abs(rhs[1]) * 1e-12, "canonical Slonczewski current reversal y");
    check_near(reversed[2], -rhs[2], std::abs(rhs[2]) * 1e-12, "canonical Slonczewski current reversal z");

    ctx.stt.current_density_am2 = {3.0e12, -4.0e12, 0.0};
    ctx.stt.stack_normal = {0.0, -1.0, 0.0};
    std::vector<double> reversed_normal(6u, 0.0);
    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, reversed_normal);
    check_near(reversed_normal[1], -rhs[1], std::abs(rhs[1]) * 1e-12, "canonical Slonczewski stack-normal reversal y");
    check_near(reversed_normal[2], -rhs[2], std::abs(rhs[2]) * 1e-12, "canonical Slonczewski stack-normal reversal z");
}

void configure_zhang_li_context(fullmag::fem::Context &ctx) {
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
}

void zhang_li_rhs_uses_gilbert_alpha_beta_projection() {
    fullmag::fem::Context ctx;
    configure_zhang_li_context(ctx);
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

void canonical_zhang_li_uses_g_over_two_sign_and_no_beta_denominator() {
    fullmag::fem::Context ctx;
    configure_zhang_li_context(ctx);
    ctx.stt.formula_version = FULLMAG_FEM_STT_FORMULA_ZHANG_LI_V1;
    ctx.stt.operator_version = FULLMAG_FEM_STT_OPERATOR_ZL_CENTRAL_REFERENCE_V1;
    ctx.stt.lande_g = 1.7;
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
        (ctx.stt.lande_g * kBohrMagnetonTest * ctx.stt.degree *
         ctx.stt.current_density_am2[0]) /
        (2.0 * kExactElectronChargeTest * ctx.material_fields.material.saturation_magnetisation);
    const double alpha = ctx.material_fields.material.damping;
    const double inv_gilbert = 1.0 / (1.0 + alpha * alpha);
    const double expected_y = -(ctx.stt.beta - alpha) * u_x * inv_gilbert;
    const double expected_z = -(1.0 + alpha * ctx.stt.beta) * u_x * inv_gilbert;
    check_near(rhs[1], expected_y, std::abs(expected_y) * 1e-12, "canonical Zhang-Li cross coefficient");
    check_near(rhs[2], expected_z, std::abs(expected_z) * 1e-12, "canonical Zhang-Li signed advection");

    ctx.stt.active_element_mask = {0u};
    std::vector<double> masked(12u, 0.0);
    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, m, masked);
    check(
        std::all_of(masked.begin(), masked.end(), [](double value) { return value == 0.0; }),
        "canonical Zhang-Li target element mask excludes inactive elements");

    ctx.stt.active_element_mask = {1u};
    ctx.stt.current_density_am2[0] *= -1.0;
    std::vector<double> reversed(12u, 0.0);
    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, m, reversed);
    check_near(reversed[1], -rhs[1], std::abs(rhs[1]) * 1e-12, "canonical Zhang-Li current reversal y");
    check_near(reversed[2], -rhs[2], std::abs(rhs[2]) * 1e-12, "canonical Zhang-Li current reversal z");
}

void zhang_li_rhs_uses_tetra_gradient_and_nodal_projection() {
    fullmag::fem::Context ctx;
    configure_zhang_li_context(ctx);
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
    fullmag::fem::Context ctx;
    configure_zhang_li_context(ctx);
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
    fullmag::fem::Context forward;
    configure_zhang_li_context(forward);
    fullmag::fem::Context reverse;
    configure_zhang_li_context(reverse);
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
    fullmag::fem::Context ctx;
    configure_zhang_li_context(ctx);
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
    fullmag::fem::Context ctx;
    configure_slonczewski_context(ctx);
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

void canonical_stt_plan_import_rejects_interface_flux_and_missing_thin_layer_data() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan{};
    plan.has_slonczewski_stt = 1;
    plan.stt_formula_version = FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2;
    plan.stt_realization_version = FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_INTERFACE_FLUX_V1;
    plan.stt_current_density_am2[2] = 1.0e12;
    plan.stt_degree = 0.4;
    plan.stt_spin_polarization[2] = 1.0;
    plan.stt_stack_normal[2] = 1.0;
    plan.stt_lambda = 1.0;
    std::string error;
    check(!fullmag::fem::initialize_stt_plan_fields(ctx, plan, error), "FEM InterfaceFlux must fail closed");
    check(error.find("surface functional") != std::string::npos, "InterfaceFlux error identifies missing surface realization");

    plan.stt_realization_version = FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_THIN_LAYER_V1;
    check(!fullmag::fem::initialize_stt_plan_fields(ctx, plan, error), "canonical thin layer requires explicit thickness");
    check(error.find("explicit free-layer thickness") != std::string::npos, "thin-layer error identifies thickness");
}

void canonical_stt_plan_import_rejects_read_only_slonczewski_v1() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan{};
    plan.has_slonczewski_stt = 1;
    plan.stt_formula_version = FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V1;
    plan.stt_realization_version = FULLMAG_FEM_STT_REALIZATION_SLONCZEWSKI_THIN_LAYER_V1;
    plan.stt_current_density_am2[2] = 1.0e12;
    plan.stt_degree = 0.4;
    plan.stt_spin_polarization[2] = 1.0;
    plan.stt_stack_normal[2] = 1.0;
    plan.stt_lambda = 1.0;
    plan.stt_free_layer_thickness = 1.0e-9;
    std::string error;
    check(!fullmag::fem::initialize_stt_plan_fields(ctx, plan, error), "Slonczewski v1 must be read-only");
    check(error.find("read-only provenance") != std::string::npos, "Slonczewski v1 error identifies read-only provenance");
}

void canonical_stt_gpu_plan_reaches_device_prerequisite_after_formula_qualification() {
    fullmag::fem::Context slonczewski;
    configure_slonczewski_context(slonczewski);
    slonczewski.stt.formula_version = FULLMAG_FEM_STT_FORMULA_SLONCZEWSKI_V2;
    std::string reason;
    const auto slonczewski_plan =
        fullmag::fem::gpu_rk_plan_device_resident(slonczewski, reason);
    check(!slonczewski_plan.enabled, "canonical Slonczewski GPU plan must be disabled");
    check(
        reason.find("FemGpuState") != std::string::npos &&
            reason.find("device-resident") != std::string::npos,
        "canonical Slonczewski GPU plan must reach device prerequisites after formula qualification");

    fullmag::fem::Context zhang_li;

    configure_zhang_li_context(zhang_li);
    zhang_li.stt.formula_version = FULLMAG_FEM_STT_FORMULA_ZHANG_LI_V1;
    reason.clear();
    const auto zhang_li_plan = fullmag::fem::gpu_rk_plan_device_resident(zhang_li, reason);
    check(!zhang_li_plan.enabled, "canonical Zhang-Li GPU plan must be disabled");
    check(
        reason.find("FemGpuState") != std::string::npos &&
            reason.find("device-resident") != std::string::npos,
        "canonical Zhang-Li GPU plan must reach device prerequisites after formula qualification");
}

} // namespace

int main() {
    slonczewski_cpp_is_owned_by_slonczewski_module();
    canonical_slonczewski_gpu_descriptor_contract_is_source_visible();
    canonical_zhang_li_gpu_descriptor_matches_cpu_contract();
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
    canonical_slonczewski_uses_signed_stack_current_exact_constants_and_target_mask();
    zhang_li_rhs_uses_tetra_gradient_and_nodal_projection();
    zhang_li_skew_tetra_affine_rhs_matches_analytic_gradient();
    zhang_li_rhs_uses_gilbert_alpha_beta_projection();
    canonical_zhang_li_uses_g_over_two_sign_and_no_beta_denominator();
    zhang_li_current_direction_reverses_rhs();
    zhang_li_adds_torque_without_scaling_existing_rhs();
    combined_stt_updates_max_rhs();
    stt_plan_import_copies_parameters_and_validates_family();
    canonical_stt_plan_import_rejects_interface_flux_and_missing_thin_layer_data();
    canonical_stt_plan_import_rejects_read_only_slonczewski_v1();
    canonical_stt_gpu_plan_reaches_device_prerequisite_after_formula_qualification();
    prescribed_sot_module_owns_local_physics();
    prescribed_sot_rhs_matches_si_oracle_and_current_reversal();
    prescribed_sot_rhs_respects_magnetic_and_target_masks();
    prescribed_sot_plan_import_validates_append_only_descriptor();
    prescribed_sot_envelope_is_evaluated_at_rk_stage_time();
    prescribed_sot_event_alignment_handles_pulse_pwl_and_stage_local_time();
    return 0;
}
