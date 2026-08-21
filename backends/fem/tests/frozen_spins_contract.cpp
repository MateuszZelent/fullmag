/*
 * frozen_spins_contract.cpp - native FEM Frozen Spins subsystem contracts.
 *
 * Verifies:
 * 1. FrozenSpins class lifecycle, descriptor import, size checks, and mask validation.
 * 2. Exact projection of state vector onto reference for frozen DOFs.
 * 3. Exact zeroing of RHS vector for frozen DOFs.
 * 4. Source-facade and architectural decoupling (Context, builder, API, integrators).
 */

#include "cpu/mfem/interactions/frozen_spins.hpp"
#include "context.hpp"

#include <cmath>
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

void test_frozen_spins_unit_contract() {
    using namespace fullmag::fem;

    FrozenSpins fs{};
    check(!fs.enabled(), "newly created FrozenSpins must be disabled");
    check(fs.frozen_count() == 0, "frozen_count must be 0 when disabled");

    std::string error;
    // Null import with 0 lengths is a valid disabled import
    check(fs.import_descriptor(nullptr, 0, nullptr, 0, 10, 10, "fp", error),
          "null descriptor import must succeed as disabled");
    check(!fs.enabled(), "null descriptor must remain disabled");

    // Invalid length mismatch: mask_len != true_dofs
    uint8_t mask[2] = {1, 0};
    double ref[6] = {0.0, 0.0, 1.0, 0.0, 0.0, 0.0};
    check(!fs.import_descriptor(mask, 1, ref, 6, 2, 2, "fp", error),
          "mismatched mask length must fail");
    check(error.find("frozen_spins_mask_length_mismatch") != std::string::npos,
          "error must indicate mask length mismatch");

    // Invalid length mismatch: ref_len != 3 * true_dofs
    check(!fs.import_descriptor(mask, 2, ref, 5, 2, 2, "fp", error),
          "mismatched ref length must fail");
    check(error.find("frozen_spins_reference_length_mismatch") != std::string::npos,
          "error must indicate reference length mismatch");

    // Valid import with 2 nodes: node 0 frozen to [0, 0, 1], node 1 free
    check(fs.import_descriptor(mask, 2, ref, 6, 2, 2, "fp", error),
          "valid descriptor import must succeed");
    check(fs.enabled(), "FrozenSpins must be enabled after non-empty mask import");
    check(fs.frozen_count() == 1, "frozen_count must be 1");

    // Test project_onto_reference
    std::vector<double> state = {
        0.577, 0.577, 0.577,  // node 0 (should become 0.0, 0.0, 1.0)
        1.0,   0.0,   0.0    // node 1 (should remain untouched)
    };
    fs.project_onto_reference(state);
    check(std::abs(state[0] - 0.0) < 1e-15, "node 0 x must be projected to 0.0");
    check(std::abs(state[1] - 0.0) < 1e-15, "node 0 y must be projected to 0.0");
    check(std::abs(state[2] - 1.0) < 1e-15, "node 0 z must be projected to 1.0");
    check(std::abs(state[3] - 1.0) < 1e-15, "node 1 x must remain 1.0");
    check(std::abs(state[4] - 0.0) < 1e-15, "node 1 y must remain 0.0");
    check(std::abs(state[5] - 0.0) < 1e-15, "node 1 z must remain 0.0");

    // Test zero_frozen_rhs
    std::vector<double> rhs = {
        10.0, 20.0, 30.0,  // node 0 (should be zeroed)
        40.0, 50.0, 60.0   // node 1 (should remain untouched)
    };
    fs.zero_frozen_rhs(rhs);
    check(std::abs(rhs[0] - 0.0) < 1e-15, "node 0 rhs_x must be 0.0");
    check(std::abs(rhs[1] - 0.0) < 1e-15, "node 0 rhs_y must be 0.0");
    check(std::abs(rhs[2] - 0.0) < 1e-15, "node 0 rhs_z must be 0.0");
    check(std::abs(rhs[3] - 40.0) < 1e-15, "node 1 rhs_x must remain 40.0");
    check(std::abs(rhs[4] - 50.0) < 1e-15, "node 1 rhs_y must remain 50.0");
    check(std::abs(rhs[5] - 60.0) < 1e-15, "node 1 rhs_z must remain 60.0");
}

void test_frozen_spins_architecture_contract() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_h = read_text_file(root / "include" / "context.hpp");
    const std::string builder_cpp = read_text_file(root / "core" / "fem_context_builder.cpp");
    const std::string api_cpp = read_text_file(root / "src" / "api.cpp");
    const std::string rk_rhs_cpp = read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");
    const std::string rk_step_cpp = read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string backend_step_cpp = read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");

    check(context_h.find("FrozenSpins frozen_spins") != std::string::npos,
          "Context must declare frozen_spins module");
    check(builder_cpp.find("ctx.frozen_spins.import_descriptor") != std::string::npos,
          "fem_context_builder must import frozen_spins descriptor");
    check(builder_cpp.find("ctx.frozen_spins.project_onto_reference") != std::string::npos,
          "fem_context_builder must project initial state onto reference");
    check(api_cpp.find("frozen_spins_fem_unqualified") == std::string::npos,
          "api.cpp must not reject valid frozen spins descriptors with blanket error");
    check(rk_rhs_cpp.find("ctx.frozen_spins.zero_frozen_rhs") != std::string::npos,
          "rk_stage_rhs must zero RHS on frozen spins");
    check(rk_step_cpp.find("ctx.frozen_spins.project_onto_reference") != std::string::npos,
          "rk_explicit_step must project state and candidate onto reference");
    check(backend_step_cpp.find("ctx.frozen_spins.project_onto_reference") != std::string::npos,
          "backend_step must project state onto reference before attempt and on rollback");
}

void test_frozen_spins_solver_step_contract() {
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0e-9, 0.0, 0.0,
        0.0, 1.0e-9, 0.0,
        0.0, 0.0, 1.0e-9,
    };
    const uint32_t elements[] = {0, 1, 2, 3};
    const uint32_t cell_types[] = {FULLMAG_FEM_CELL_TET4};
    const uint32_t cell_offsets[] = {0, 4};
    const uint64_t cell_ordinals[] = {0};
    const uint32_t element_markers[] = {1};
    const uint32_t boundary_faces[] = {0, 1, 2};
    const uint32_t facet_types[] = {FULLMAG_FEM_FACET_TRI3};
    const uint32_t facet_roles[] = {FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    const uint32_t facet_offsets[] = {0, 3};
    const uint64_t facet_ordinals[] = {0};
    const uint32_t boundary_markers[] = {1};

    // Initial magnetization: node 0 along +z, nodes 1,2,3 along +x
    const double m_init[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };

    // Node 0 frozen to [0, 0, 1], others free
    const uint8_t frozen_mask[] = {1, 0, 0, 0};
    const double frozen_reference[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 0.0,
        0.0, 0.0, 0.0,
        0.0, 0.0, 0.0,
    };

    fullmag_fem_plan_desc plan = {};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
    plan.mesh.nodes_xyz = nodes;
    plan.mesh.nodes_xyz_len = 12;
    plan.mesh.cell_types = cell_types;
    plan.mesh.cell_types_len = 1;
    plan.mesh.cell_offsets = cell_offsets;
    plan.mesh.cell_offsets_len = 2;
    plan.mesh.cell_nodes = elements;
    plan.mesh.cell_nodes_len = 4;
    plan.mesh.cell_global_ordinals = cell_ordinals;
    plan.mesh.cell_global_ordinals_len = 1;
    plan.mesh.cell_markers = element_markers;
    plan.mesh.cell_markers_len = 1;
    plan.mesh.facet_types = facet_types;
    plan.mesh.facet_types_len = 1;
    plan.mesh.facet_roles = facet_roles;
    plan.mesh.facet_roles_len = 1;
    plan.mesh.facet_offsets = facet_offsets;
    plan.mesh.facet_offsets_len = 2;
    plan.mesh.facet_nodes = boundary_faces;
    plan.mesh.facet_nodes_len = 3;
    plan.mesh.facet_global_ordinals = facet_ordinals;
    plan.mesh.facet_global_ordinals_len = 1;
    plan.mesh.facet_markers = boundary_markers;
    plan.mesh.facet_markers_len = 1;

    plan.material.saturation_magnetisation = 8.0e5;
    plan.material.exchange_stiffness = 1.3e-11;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[0] = 0.0;
    plan.external_field_am[1] = 1.0e5;
    plan.external_field_am[2] = 0.0;
    plan.initial_magnetization_xyz = m_init;
    plan.initial_magnetization_len = 12;
    plan.frozen_mask = frozen_mask;
    plan.frozen_mask_len = 4;
    plan.frozen_reference_xyz = frozen_reference;
    plan.frozen_reference_len = 12;

    fullmag_fem_backend *handle = fullmag_fem_backend_create(&plan);
    check(handle != nullptr, "FEM backend create for frozen spins P1 Heun must succeed");

    fullmag_fem_step_stats stats = {};
    constexpr double dt = 1.0e-13;
    for (int step = 0; step < 10; ++step) {
        const int rc = fullmag_fem_backend_step(handle, dt, &stats);
        check(rc == FULLMAG_FEM_OK, "fullmag_fem_backend_step must succeed");
    }

    std::vector<double> m_out(12, 0.0);
    check(fullmag_fem_backend_copy_field_f64(
              handle, FULLMAG_FEM_OBSERVABLE_M, m_out.data(), m_out.size()) == FULLMAG_FEM_OK,
          "copy magnetization field must succeed");

    // Check frozen node 0 defect
    const double defect_x = std::abs(m_out[0] - 0.0);
    const double defect_y = std::abs(m_out[1] - 0.0);
    const double defect_z = std::abs(m_out[2] - 1.0);
    const double max_defect = std::max({defect_x, defect_y, defect_z});
    check(max_defect < 1.0e-14, "frozen node 0 defect must be < 1e-14 in FEM explicit RK");

    // Check free node 1 displacement
    const double disp_x = m_out[3] - 1.0;
    const double disp_y = m_out[4] - 0.0;
    const double disp_z = m_out[5] - 0.0;
    const double disp = std::sqrt(disp_x * disp_x + disp_y * disp_y + disp_z * disp_z);
    check(disp > 1.0e-4, "free node 1 must evolve under exchange and Zeeman field");

    fullmag_fem_backend_destroy(handle);
}

void test_frozen_spins_direct_minimizer_contract() {
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0e-8, 0.0, 0.0,
        0.0, 1.0e-8, 0.0,
        0.0, 0.0, 1.0e-8,
    };
    const uint32_t elements[] = {0, 1, 2, 3};
    const uint32_t cell_types[] = {FULLMAG_FEM_CELL_TET4};
    const uint32_t cell_offsets[] = {0, 4};
    const uint64_t cell_ordinals[] = {0};
    const uint32_t element_markers[] = {1};
    const uint32_t boundary_faces[] = {0, 1, 2};
    const uint32_t facet_types[] = {FULLMAG_FEM_FACET_TRI3};
    const uint32_t facet_roles[] = {FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    const uint32_t facet_offsets[] = {0, 3};
    const uint64_t facet_ordinals[] = {0};
    const uint32_t boundary_markers[] = {1};

    const double m_init[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        1.0, 0.0, 0.0,
    };

    const uint8_t frozen_mask[] = {1, 0, 0, 0};
    const double frozen_reference[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        1.0, 0.0, 0.0,
    };

    fullmag_fem_plan_desc plan = {};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
    plan.mesh.nodes_xyz = nodes;
    plan.mesh.nodes_xyz_len = 12;
    plan.mesh.cell_types = cell_types;
    plan.mesh.cell_types_len = 1;
    plan.mesh.cell_offsets = cell_offsets;
    plan.mesh.cell_offsets_len = 2;
    plan.mesh.cell_nodes = elements;
    plan.mesh.cell_nodes_len = 4;
    plan.mesh.cell_global_ordinals = cell_ordinals;
    plan.mesh.cell_global_ordinals_len = 1;
    plan.mesh.cell_markers = element_markers;
    plan.mesh.cell_markers_len = 1;
    plan.mesh.facet_types = facet_types;
    plan.mesh.facet_types_len = 1;
    plan.mesh.facet_roles = facet_roles;
    plan.mesh.facet_roles_len = 1;
    plan.mesh.facet_offsets = facet_offsets;
    plan.mesh.facet_offsets_len = 2;
    plan.mesh.facet_nodes = boundary_faces;
    plan.mesh.facet_nodes_len = 3;
    plan.mesh.facet_global_ordinals = facet_ordinals;
    plan.mesh.facet_global_ordinals_len = 1;
    plan.mesh.facet_markers = boundary_markers;
    plan.mesh.facet_markers_len = 1;

    plan.material.saturation_magnetisation = 8.0e5;
    plan.material.exchange_stiffness = 1.3e-11;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[0] = 0.0;
    plan.external_field_am[1] = 1.0e5;
    plan.external_field_am[2] = 0.0;
    plan.initial_magnetization_xyz = m_init;
    plan.initial_magnetization_len = 12;
    plan.frozen_mask = frozen_mask;
    plan.frozen_mask_len = 4;
    plan.frozen_reference_xyz = frozen_reference;
    plan.frozen_reference_len = 12;

    fullmag_fem_backend *handle = fullmag_fem_backend_create(&plan);
    check(handle != nullptr, "FEM backend create for frozen spins minimizer must succeed");

    fullmag_fem_step_stats stats = {};
    // Test PG-BB
    const int rc_bb = fullmag_fem_backend_relax_step(
        handle, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &stats);
    check(rc_bb == FULLMAG_FEM_OK, "PG-BB relax step with frozen spins must succeed");

    // Test NCG
    const int rc_ncg = fullmag_fem_backend_relax_step(
        handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &stats);
    check(rc_ncg == FULLMAG_FEM_OK, "NCG relax step with frozen spins must succeed");

    std::vector<double> m_out(12, 0.0);
    check(fullmag_fem_backend_copy_field_f64(
              handle, FULLMAG_FEM_OBSERVABLE_M, m_out.data(), m_out.size()) == FULLMAG_FEM_OK,
          "copy magnetization field must succeed");

    // Frozen node 0 invariant verification
    const double defect_x = std::abs(m_out[0] - 0.0);
    const double defect_y = std::abs(m_out[1] - 0.0);
    const double defect_z = std::abs(m_out[2] - 1.0);
    const double max_defect = std::max({defect_x, defect_y, defect_z});
    check(max_defect < 1.0e-14, "frozen node 0 defect must be < 1e-14 in FEM direct minimizers");

    fullmag_fem_backend_destroy(handle);
}

} // namespace

int main() {
    std::printf("Running native FEM Frozen Spins contract tests...\n");
    test_frozen_spins_unit_contract();
    std::printf("PASS: FrozenSpins unit contract\n");
    test_frozen_spins_architecture_contract();
    std::printf("PASS: FrozenSpins architecture contract\n");
    test_frozen_spins_solver_step_contract();
    std::printf("PASS: FrozenSpins solver step contract\n");
    test_frozen_spins_direct_minimizer_contract();
    std::printf("PASS: FrozenSpins direct minimizer contract\n");
    return 0;
}
