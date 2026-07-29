/*
 * fem_material_fields_contract.cpp - native FEM material-field ownership.
 *
 * Context construction may orchestrate plan import, but per-node material
 * field copying and scalar material validation belong to the FEM core material
 * module. This is one step toward the documented FemMaterialFields split.
 */

#include "context.hpp"
#include "core/fem_context_builder.hpp"
#include "core/fem_material_fields.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

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

void material_field_helpers_are_owned_by_core_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string material_fields = read_text_file(root / "core" / "fem_material_fields.cpp");
    const std::string material_header = read_text_file(root / "core" / "fem_material_fields.hpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");

    check(
        context.find("auto copy_field = []") == std::string::npos,
        "Context must not define per-node material field copy helper");
    check(
        context.find("auto check_field_len = ") == std::string::npos,
        "Context must not define per-node material field length helper");
    check(
        context.find("auto validate_field_values = ") == std::string::npos,
        "Context must not define per-node material field value helper");
    check(
        context.find("ctx.material_fields.material = plan.material;") == std::string::npos,
        "Context must not copy scalar material fields directly");
    check(
        material_fields.find("void initialize_material_plan_fields(") != std::string::npos,
        "Scalar material plan import must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("void copy_plan_material_fields(") != std::string::npos,
        "Material field copy helper must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("bool validate_material_fields(") != std::string::npos,
        "Material field validation helper must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("bool validate_elementwise_ms_runtime_support(") !=
            std::string::npos,
        "Elementwise Ms runtime legality must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("FEM material-fields core source contract") != std::string::npos,
        "FemMaterialFields source file must document its source contract");
    check(
        material_fields.find("does not import mesh topology, initialize magnetization, size field buffers, choose runtime devices, or compute interaction fields") != std::string::npos,
        "FemMaterialFields source file must document its non-owning module boundary");
    check(
        material_header.find("Own FEM scalar and per-node material field import") !=
            std::string::npos,
        "FemMaterialFields header must document its contract");
    check(
        material_header.find("struct FemMaterialFieldsRuntimeState") != std::string::npos,
        "FemMaterialFields header must declare the runtime field owner");
    check(
        material_header.find("std::vector<double> Ms_field") != std::string::npos,
        "FemMaterialFields runtime state must own the Ms per-node field");
    check(
        material_header.find("std::vector<double> Ms_element_field") != std::string::npos &&
            material_header.find("std::vector<double> A_element_field") != std::string::npos,
        "FemMaterialFields runtime state must own discontinuous per-element material coefficients");
    check(
        material_header.find("fullmag_fem_material_desc material") != std::string::npos,
        "FemMaterialFields runtime state must own scalar material constants");
    check(
        context_header.find("FemMaterialFieldsRuntimeState material_fields{}") !=
            std::string::npos,
        "Context must store per-node material fields under material_fields");
    for (const char *flat_field : {
             "std::vector<double> Ms_field;",
             "std::vector<double> A_field;",
             "std::vector<double> alpha_field;",
             "std::vector<double> Ku_field;",
             "std::vector<double> Ku2_field;",
             "std::vector<double> Dind_field;",
             "std::vector<double> Dbulk_field;",
             "std::vector<double> Kc1_field;",
             "std::vector<double> Kc2_field;",
             "std::vector<double> Kc3_field;",
             "std::vector<double> Ms_element_field;",
             "std::vector<double> A_element_field;",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat per-node material fields");
    }
    check(
        context_header.find("fullmag_fem_material_desc material") == std::string::npos,
        "Context must not own flat scalar material constants");
    check(
        material_header.find(
            "It does not own mesh topology, magnetization initialization, field-buffer") !=
                std::string::npos &&
            material_header.find(
                "sizing, runtime device selection, or interaction field computation") !=
                std::string::npos,
        "FemMaterialFields header must document its non-owning module boundary");
}

void material_plan_import_and_validation_contract() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.mesh.n_elements = 2;

    const double ms[] = {800e3, 1.0e6};
    const double alpha[] = {0.1, 0.2};
    const double ms_element[] = {700e3, 900e3};
    const double a_element[] = {8e-12, 13e-12};
    fullmag_fem_plan_desc plan = {};
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.ms_field = ms;
    plan.ms_field_len = 2;
    plan.alpha_field = alpha;
    plan.alpha_field_len = 2;
    plan.ms_element_field = ms_element;
    plan.ms_element_field_len = 2;
    plan.a_element_field = a_element;
    plan.a_element_field_len = 2;

    fullmag::fem::initialize_material_plan_fields(ctx, plan);
    check(ctx.material_fields.material.saturation_magnetisation == 800e3, "scalar Ms copied from plan");
    check(ctx.material_fields.material.exchange_stiffness == 13e-12, "scalar A copied from plan");
    check(ctx.material_fields.material.damping == 0.1, "scalar alpha copied from plan");
    check(ctx.material_fields.material.gyromagnetic_ratio == 2.211e5, "scalar gamma_mu0 copied from plan");
    check(ctx.material_fields.Ms_field == std::vector<double>({800e3, 1.0e6}), "Ms field copied from plan");
    check(ctx.material_fields.alpha_field == std::vector<double>({0.1, 0.2}), "alpha field copied from plan");
    check(
        ctx.material_fields.Ms_element_field == std::vector<double>({700e3, 900e3}),
        "Ms per-element coefficient copied from plan");
    check(
        ctx.material_fields.A_element_field == std::vector<double>({8e-12, 13e-12}),
        "A per-element coefficient copied from plan");

    // Cross-coefficient Ms_node + A_element remains legal. Same-coefficient
    // nodal/element conflicts are covered by the focused test below.
    ctx.material_fields.Ms_element_field.clear();
    std::string error;
    check(
        fullmag::fem::validate_material_fields(ctx, error),
        error.empty() ? "material fields should validate" : error.c_str());

    ctx.material_fields.Ms_field = {800e3};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "wrong per-node field length must fail validation");
    check(
        error.find("Ms_field") != std::string::npos,
        "wrong length error should identify the material field");

    ctx.material_fields.Ms_field = {800e3, 1.0e6};
    ctx.material_fields.A_element_field = {8e-12};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "wrong per-element field length must fail validation");
    check(
        error.find("A_element_field") != std::string::npos &&
            error.find("n_elements") != std::string::npos,
        "wrong per-element length error should identify the element material field");

    ctx.material_fields.A_element_field = {8e-12, -1.0e-12};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "negative per-element A coefficient must fail validation");
    check(
        error.find("A_element_field") != std::string::npos,
        "invalid per-element A error should identify the element field");

    ctx.material_fields.A_element_field = {8e-12, 13e-12};
    ctx.material_fields.material.gyromagnetic_ratio = 0.0;
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "invalid gamma_mu0 must fail validation");
    check(
        error.find("gamma_mu0") != std::string::npos,
        "gamma validation error should mention gamma_mu0 convention");
}

void material_plan_import_rejects_conflicting_nodal_and_element_realizations() {
    const double ms[] = {800e3, 1.0e6};
    const double a[] = {8e-12, 13e-12};
    const double ms_element[] = {700e3, 900e3};
    const double a_element[] = {6e-12, 11e-12};

    struct Case {
        const char *coefficient;
        const char *nodal_location;
        const char *element_location;
        const double *nodal_values;
        const double *element_values;
        bool ms;
    };
    const Case cases[] = {
        {"Ms", "ms_field", "ms_element_field", ms, ms_element, true},
        {"A", "a_field", "a_element_field", a, a_element, false},
    };

    for (const Case &test : cases) {
        fullmag::fem::Context ctx;
        ctx.mesh.n_nodes = 2;
        ctx.mesh.n_elements = 2;
        fullmag_fem_plan_desc plan = {};
        plan.material.saturation_magnetisation = 800e3;
        plan.material.exchange_stiffness = 13e-12;
        plan.material.damping = 0.1;
        plan.material.gyromagnetic_ratio = 2.211e5;
        if (test.ms) {
            plan.ms_field = test.nodal_values;
            plan.ms_field_len = 2;
            plan.ms_element_field = test.element_values;
            plan.ms_element_field_len = 2;
        } else {
            plan.a_field = test.nodal_values;
            plan.a_field_len = 2;
            plan.a_element_field = test.element_values;
            plan.a_element_field_len = 2;
        }
        fullmag::fem::initialize_material_plan_fields(ctx, plan);

        std::string error;
        check(
            !fullmag::fem::validate_material_fields(ctx, error),
            "native material import must reject conflicting nodal and element realizations");
        check(
            error.find(test.coefficient) != std::string::npos &&
                error.find(test.nodal_location) != std::string::npos &&
                error.find(test.element_location) != std::string::npos,
            "native conflict diagnostic must name the coefficient and both ABI locations");
    }
}

void native_dg0_ms_validation_uses_the_realized_magnetic_element_mask() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 6u;
    ctx.mesh.n_elements = 3u;
    ctx.mesh.magnetic_element_mask = {1u, 1u, 0u};
    ctx.material_fields.material.saturation_magnetisation = 0.8e6;
    ctx.material_fields.material.exchange_stiffness = 13e-12;
    ctx.material_fields.material.damping = 0.1;
    ctx.material_fields.material.gyromagnetic_ratio = 2.211e5;
    ctx.material_fields.Ms_element_field = {0.7e6, 1.1e6, 0.0};

    std::string error;
    check(
        fullmag::fem::validate_material_fields(ctx, error),
        "native material validation must accept canonical zero DG0 Ms in inactive air");

    ctx.material_fields.Ms_element_field[0u] = 0.0;
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "native material validation must reject zero DG0 Ms in an active element");
    ctx.material_fields.Ms_element_field = {0.7e6, 1.1e6, -1.0};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "native material validation must reject a negative DG0 Ms in inactive air");
}

void elementwise_material_runtime_support_distinguishes_a_from_ms() {
    fullmag::fem::Context ctx;
    std::string error;

    ctx.material_fields.A_element_field = {8e-12, 13e-12};
    ctx.exchange.enabled = true;
    ctx.mfem_device.device_string_override = "cpu";
    check(
        fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "elementwise A must remain legal for exchange-only CPU execution");

    ctx.mfem_device.device_string_override = "cuda";
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "GPU lane must reject elementwise A before state upload");
    check(
        error.find("A_element_field") != std::string::npos &&
            error.find("GPU material-state upload") != std::string::npos &&
            error.find("resolved device 'gpu'") != std::string::npos,
        "GPU elementwise A rejection must name field, first unsupported lane, and device");

    ctx.mfem_device.device_string_override = "cpu";
    ctx.zeeman.has_external_field = true;
    check(
        fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU Zeeman must remain legal with elementwise A and exchange enabled");

    ctx.zeeman.has_external_field = false;
    ctx.exchange.enabled = false;
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU must reject elementwise A when exchange is disabled");
    check(
        error.find("A_element_field") != std::string::npos &&
            error.find("exchange-disabled plan") != std::string::npos &&
            error.find("resolved device 'cpu'") != std::string::npos,
        "CPU no-exchange elementwise-A rejection must name field, plan state, and device");

    ctx.material_fields.Ms_element_field = {700e3, 1.1e6};
    ctx.exchange.enabled = true;
    ctx.mfem_device.device_string_override = "cuda";
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "GPU lane must reject elementwise Ms before state upload");
    check(
        error.find("Ms_element_field") != std::string::npos &&
            error.find("GPU material-state upload") != std::string::npos &&
            error.find("resolved device 'gpu'") != std::string::npos,
        "GPU elementwise Ms rejection must name field, first unsupported owner, and device");

    ctx.mfem_device.device_string_override = "cpu";
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU elementwise Ms must reject lumped-mass exchange projection");
    check(
        error.find("lumped-mass exchange projection") != std::string::npos,
        "CPU DG0 Ms rejection must identify the missing consistent-mass prerequisite");

    ctx.exchange.mfem.use_consistent_mass = true;
    check(
        fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU consistent-mass exchange must accept elementwise Ms through the common material adapter");

    ctx.demag.enabled = true;
    ctx.zeeman.has_external_field = true;
    check(
        fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU Poisson demag and Zeeman must accept elementwise Ms through the common material adapter");

    ctx.demag.enabled = false;
    ctx.zeeman.has_external_field = false;
    ctx.exchange.enabled = false;
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU handle with no qualified Ms owner must fail closed");
    check(
        error.find("exchange-disabled plan") != std::string::npos,
        "CPU ownerless rejection must identify the mandatory exchange owner");

    ctx.zeeman.has_external_field = true;
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error) &&
            error.find("exchange-disabled plan") != std::string::npos,
        "CPU Zeeman-only execution must not promote DG0 Ms without exchange");
    ctx.zeeman.has_external_field = false;
    ctx.demag.enabled = true;
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error) &&
            error.find("exchange-disabled plan") != std::string::npos,
        "CPU demag-only execution must not promote DG0 Ms without exchange");
    ctx.demag.enabled = false;

    ctx.exchange.enabled = true;
    ctx.anisotropy.uniaxial_enabled = true;
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU uniaxial anisotropy must fail closed until it consumes the common material adapter");
    check(
        error.find("Ms_element_field") != std::string::npos &&
            error.find("uniaxial anisotropy") != std::string::npos &&
            error.find("resolved device 'cpu'") != std::string::npos,
        "CPU unsupported-owner rejection must name field, owner, and device");

    ctx.anisotropy.uniaxial_enabled = false;
    ctx.dmi.interfacial_enabled = true;
    check(
        !fullmag::fem::validate_elementwise_ms_runtime_support(ctx, error),
        "CPU DMI must fail closed for elementwise Ms until it consumes the common material adapter");
    check(
        error.find("interfacial DMI") != std::string::npos,
        "CPU DMI rejection must identify the first unsupported owner");
}

fullmag_fem_plan_desc elementwise_material_context_plan(bool include_ms, bool include_a) {
    static const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, -1.0,
    };
    // Two conformal tetrahedra share the face (0, 1, 2).  Their distinct
    // element-owned Ms and A values must never be smeared at those nodes.
    static const uint32_t elements[] = {0u, 1u, 2u, 3u, 0u, 2u, 1u, 4u};
    static const uint32_t cell_types[] = {
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
    };
    static const uint32_t cell_offsets[] = {0u, 4u, 8u};
    static const uint64_t cell_ordinals[] = {0u, 1u};
    static const uint32_t cell_markers[] = {1u, 2u};
    static const uint32_t facet_offsets[] = {0u};
    static const double initial_m[] = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    static const double element_ms[] = {700e3, 1.1e6};
    static const double element_a[] = {8e-12, 13e-12};

    fullmag_fem_plan_desc plan{};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
    plan.mesh.nodes_xyz = nodes;
    plan.mesh.nodes_xyz_len = 15;
    plan.mesh.cell_types = cell_types;
    plan.mesh.cell_types_len = 2;
    plan.mesh.cell_offsets = cell_offsets;
    plan.mesh.cell_offsets_len = 3;
    plan.mesh.cell_nodes = elements;
    plan.mesh.cell_nodes_len = 8;
    plan.mesh.cell_global_ordinals = cell_ordinals;
    plan.mesh.cell_global_ordinals_len = 2;
    plan.mesh.cell_markers = cell_markers;
    plan.mesh.cell_markers_len = 2;
    plan.mesh.facet_offsets = facet_offsets;
    plan.mesh.facet_offsets_len = 1;
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    if (include_ms) {
        plan.ms_element_field = element_ms;
        plan.ms_element_field_len = 2;
    }
    if (include_a) {
        plan.a_element_field = element_a;
        plan.a_element_field_len = 2;
    }
    plan.fe_order = 1;
    plan.hmax = 1.0;
    plan.dt_seconds = 1e-13;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.use_consistent_mass = include_ms ? 1 : 0;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.initial_magnetization_xyz = initial_m;
    plan.initial_magnetization_len = 15;
    plan.mfem_device_string = "cpu";
    return plan;
}

void elementwise_material_context_builder_fails_closed_before_backend_initialization() {
    static const double oersted_field[] = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    static const double uniform_strain[] = {0.01, 0.0, 0.0, 0.0, 0.0, 0.0};

    struct Reproducer {
        const char *name;
        bool include_ms;
        bool include_a;
        bool expect_accept;
        const char *field;
        const char *unsupported_term;
        const char *device;
        void (*configure)(fullmag_fem_plan_desc &);
    };
    const Reproducer reproducers[] = {
        {"CPU Ms Zeeman", true, false, true, "", "", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_external_field = 1;
             plan.external_field_am[2] = 1.0;
         }},
        {"CPU Ms missing consistent mass", true, false, false, "Ms_element_field", "lumped-mass exchange projection", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.use_consistent_mass = 0;
         }},
        {"CPU Ms Zeeman-only", true, false, false, "Ms_element_field", "exchange-disabled plan", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.enable_exchange = 0;
             plan.has_external_field = 1;
             plan.external_field_am[2] = 1.0;
         }},
        {"CPU Ms demag-only", true, false, false, "Ms_element_field", "exchange-disabled plan", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.enable_exchange = 0;
             plan.enable_demag = 1;
         }},
        {"CPU Ms uniaxial anisotropy", true, false, false, "Ms_element_field", "uniaxial anisotropy", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_uniaxial_anisotropy = 1;
             plan.uniaxial_anisotropy_constant = 1.0e5;
             plan.anisotropy_axis[2] = 1.0;
         }},
        {"CPU Ms cubic anisotropy", true, false, false, "Ms_element_field", "cubic anisotropy", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_cubic_anisotropy = 1;
             plan.cubic_kc1 = 1.0e5;
             plan.cubic_axis1[0] = 1.0;
             plan.cubic_axis2[1] = 1.0;
         }},
        {"CPU Ms interfacial DMI", true, false, false, "Ms_element_field", "interfacial DMI", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_interfacial_dmi = 1;
             plan.dmi_constant = 1.0e-3;
             plan.dmi_interface_normal[2] = 1.0;
         }},
        {"CPU Ms bulk DMI", true, false, false, "Ms_element_field", "bulk DMI", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_bulk_dmi = 1;
             plan.bulk_dmi_constant = 1.0e-3;
         }},
        {"CPU Ms thermal", true, false, false, "Ms_element_field", "thermal Brown", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.temperature = 300.0;
             plan.thermal_seed = 1;
         }},
        {"CPU Ms Zhang-Li STT", true, false, false, "Ms_element_field", "Zhang-Li STT", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_zhang_li_stt = 1;
             plan.stt_current_density_am2[0] = 1.0e11;
             plan.stt_degree = 0.5;
             plan.stt_beta = 0.1;
         }},
        {"CPU Ms Slonczewski STT", true, false, false, "Ms_element_field", "Slonczewski STT", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_slonczewski_stt = 1;
             plan.stt_current_density_am2[0] = 1.0e11;
             plan.stt_degree = 0.5;
             plan.stt_beta = 0.1;
             plan.stt_spin_polarization[2] = 1.0;
             plan.stt_lambda = 1.0;
             plan.stt_epsilon_prime = 0.0;
             plan.stt_free_layer_thickness = 1.0e-9;
             plan.stt_current_sign = 1.0;
         }},
        {"CPU Ms Oersted", true, false, false, "Ms_element_field", "Oersted", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.oersted_field_xyz = oersted_field;
             plan.oersted_field_len = 15;
         }},
        {"CPU Ms magnetoelastic", true, false, false, "Ms_element_field", "magnetoelastic", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_magnetoelastic = 1;
             plan.mel_b1 = 1.0e6;
             plan.mel_b2 = 0.0;
             plan.mel_uniform_strain = 1;
             plan.mel_strain_voigt = uniform_strain;
             plan.mel_strain_len = 6;
         }},
        {"CPU Ms exchange-disabled", true, false, false, "Ms_element_field", "exchange-disabled plan", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.enable_exchange = 0;
         }},
        {"CUDA Ms GPU", true, false, false, "Ms_element_field", "GPU material-state upload", "gpu", [](fullmag_fem_plan_desc &plan) {
             plan.mfem_device_string = "cuda";
         }},
        {"CPU A Zeeman", false, true, true, "", "", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.has_external_field = 1;
             plan.external_field_am[2] = 1.0;
         }},
        {"CPU A exchange-disabled", false, true, false, "A_element_field", "exchange-disabled plan", "cpu", [](fullmag_fem_plan_desc &plan) {
             plan.enable_exchange = 0;
         }},
        {"CUDA A GPU", false, true, false, "A_element_field", "GPU material-state upload", "gpu", [](fullmag_fem_plan_desc &plan) {
             plan.mfem_device_string = "cuda";
         }},
    };

    for (const Reproducer &reproducer : reproducers) {
        fullmag::fem::Context ctx;
        std::string error;
        fullmag_fem_plan_desc plan = elementwise_material_context_plan(
            reproducer.include_ms,
            reproducer.include_a);
        reproducer.configure(plan);
        const bool built = fullmag::fem::build_context_from_plan(ctx, plan, error);
        if (built != reproducer.expect_accept) {
            std::fprintf(
                stderr,
                "elementwise material case '%s': expected_accept=%d built=%d error=%s\n",
                reproducer.name,
                reproducer.expect_accept ? 1 : 0,
                built ? 1 : 0,
                error.c_str());
        }
        check(
            built == reproducer.expect_accept,
            "Context builder must match the elementwise material legality table");
        if (reproducer.expect_accept) {
#if FULLMAG_HAS_MFEM_STACK
            fullmag::fem::context_destroy_mfem(ctx);
#endif
            fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
            continue;
        }
        check(
            error.find(reproducer.field) != std::string::npos &&
                error.find(reproducer.unsupported_term) != std::string::npos &&
                error.find(std::string("resolved device '") + reproducer.device + "'") != std::string::npos,
            "Context-builder elementwise-material rejection must name field, first unsupported term, and resolved device");
        check(
            !ctx.mfem_context.ready && ctx.mfem_context.mesh == nullptr &&
                !ctx.gpu_state.device.lifecycle.allocated,
            "elementwise-material rejection must occur before MFEM or GPU backend initialization");
    }
}

} // namespace

int main() {
    material_field_helpers_are_owned_by_core_module();
    material_plan_import_and_validation_contract();
    material_plan_import_rejects_conflicting_nodal_and_element_realizations();
    native_dg0_ms_validation_uses_the_realized_magnetic_element_mask();
    elementwise_material_runtime_support_distinguishes_a_from_ms();
    elementwise_material_context_builder_fails_closed_before_backend_initialization();
    return 0;
}
