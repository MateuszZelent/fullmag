/*
 * interaction_docs_contract.cpp - docs/physics coverage for native FEM interactions.
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

std::filesystem::path repo_root() {
    const std::filesystem::path this_file(__FILE__);
    const std::filesystem::path fem_root = this_file.is_absolute()
        ? this_file.parent_path().parent_path()
        : std::filesystem::current_path() / this_file.parent_path().parent_path();
    return fem_root.parent_path().parent_path().parent_path();
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: missing FEM docs file %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

bool has_any_heading(const std::string &text, const char *const *headings, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        if (text.find(headings[i]) != std::string::npos) {
            return true;
        }
    }
    return false;
}

void check_doc_has_section(
    const std::string &text,
    const char *doc,
    const char *const *headings,
    size_t count,
    const char *section_name) {
    if (!has_any_heading(text, headings, count)) {
        std::fprintf(stderr, "FAIL: %s missing required %s section\n", doc, section_name);
        std::exit(1);
    }
}

void required_interaction_docs_exist_and_name_their_implementation() {
    const std::filesystem::path physics = repo_root() / "docs" / "physics";
    const char *docs[] = {
        "fem_exchange.md",
        "fem_demag_poisson.md",
        "fem_demag_fem_bem.md",
        "fem_dmi.md",
        "fem_thermal.md",
        "fem_thermal_brown.md",
        "fem_stt.md",
        "fem_oersted.md",
        "fem_magnetoelastic.md",
        "fem_zeeman.md",
        "fem_anisotropy_uniaxial.md",
        "fem_anisotropy_cubic.md",
    };

    for (const char *doc : docs) {
        const std::string text = read_text_file(physics / doc);
        check(text.find("Implementation:") != std::string::npos, "interaction doc names implementation path");
        check(text.find("Test:") != std::string::npos, "interaction doc names test path");
    }
}

void required_interaction_docs_have_physics_contract_sections() {
    const std::filesystem::path physics = repo_root() / "docs" / "physics";
    const char *docs[] = {
        "fem_exchange.md",
        "fem_demag_poisson.md",
        "fem_demag_fem_bem.md",
        "fem_dmi.md",
        "fem_thermal.md",
        "fem_thermal_brown.md",
        "fem_stt.md",
        "fem_oersted.md",
        "fem_magnetoelastic.md",
        "fem_zeeman.md",
        "fem_anisotropy_uniaxial.md",
        "fem_anisotropy_cubic.md",
    };
    const char *energy[] = {"## Energia"};
    const char *field_or_torque[] = {"## Pole", "## Pole / torque", "## Torque", "## RHS / torque"};
    const char *units[] = {"## Jednostki"};
    const char *boundary[] = {"## Warunki brzegowe"};
    const char *discretization[] = {"## Dyskretyzacja FEM"};
    const char *capability[] = {"## Ograniczenia capability"};
    const char *tests[] = {"## Testy"};

    for (const char *doc : docs) {
        const std::string text = read_text_file(physics / doc);
        check_doc_has_section(text, doc, energy, 1, "energy");
        check_doc_has_section(text, doc, field_or_torque, 4, "field-or-torque");
        check_doc_has_section(text, doc, units, 1, "units");
        check_doc_has_section(text, doc, boundary, 1, "boundary-condition");
        check_doc_has_section(text, doc, discretization, 1, "FEM-discretization");
        check_doc_has_section(text, doc, capability, 1, "capability");
        check_doc_has_section(text, doc, tests, 1, "tests");
    }
}

void required_release_gate_docs_exist() {
    const std::filesystem::path root = repo_root();
    const char *docs[] = {
        "docs/physics/units.md",
        "docs/physics/llg_conventions.md",
        "docs/physics/fem_exchange.md",
        "docs/physics/fem_demag_poisson.md",
        "docs/physics/fem_dmi.md",
        "docs/physics/fem_thermal.md",
        "docs/physics/fem_stt.md",
        "docs/validation/fem_cpu_validation_matrix.md",
        "docs/performance/fem_cpu_baselines.md",
    };

    for (const char *doc : docs) {
        const std::string text = read_text_file(root / doc);
        check(!text.empty(), "release gate doc is not empty");
    }
}

void validation_matrix_names_closed_fixture_owners() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("| DMI | directional derivative | finite-difference energy derivative matches weak residual | covered by `fem_dmi_weak_residual` |") !=
            std::string::npos,
        "validation matrix must map DMI directional-derivative fixture to fem_dmi_weak_residual");
    check(
        matrix.find("| STT | macrospin CPP | sign and precession direction match reference | covered by `fem_stt_contract` |") !=
            std::string::npos,
        "validation matrix must map STT macrospin CPP fixture to fem_stt_contract");
    check(
        matrix.find("| LLG | damping-only macrospin | energy decreases under relaxation | covered by `fem_llg_rhs_contract` |") !=
            std::string::npos,
        "validation matrix must map LLG damping-only macrospin fixture to fem_llg_rhs_contract");
}

void validation_matrix_names_leaf_header_gate_rows() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("| Zeeman/anisotropy | `fem_zeeman_contract`, `fem_anisotropy_contract` | local field, energy, Zeeman plan-field initialization plus broadcast/field/energy module ownership and leaf/source-level docstrings, Zeeman runtime H_ext plus uniform external-field plan storage ownership, Context no longer owning flat Zeeman enable/field-vector fields, uniaxial/cubic module ownership and leaf/source-level docstrings, anisotropy runtime H_ani/H_cubic/energy plus uniaxial/cubic plan storage ownership, Context no longer owning flat anisotropy/cubic plan fields, aggregate/leaf-header non-ownership docstrings, and anisotropy plan-field initialization plus axis normalization/validation ownership |") !=
            std::string::npos,
        "validation matrix must map Zeeman/anisotropy to aggregate/leaf-header boundary coverage");
}

void validation_matrix_names_mfem_stack_fixture_statuses() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("| Exchange | sinusoidal mode | convergence of `H_ex` against analytic Laplacian | runtime-open (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must keep exchange sinusoidal fixture runtime-open until MFEM stack is available");
    check(
        matrix.find("| Demag Poisson | uniformly magnetized sphere | `H_demag ~= -M/3` inside | covered by `tests/fem_demag_validation/sphere_validation.py` (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must map Poisson sphere fixture to the scripted runtime gate");
    check(
        matrix.find("| Demag Poisson | airbox sweep | convergence with airbox size and boundary mode | covered by `tests/fem_demag_validation/airbox_convergence.py` (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must map Poisson airbox sweep fixture to the scripted runtime gate");
    check(
        matrix.find("| Demag FEM/BEM | body-only sphere or ellipsoid | demag factor agreement | runtime-open (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must keep FEM/BEM demag factor fixture runtime-open until MFEM stack is available");
    check(
        matrix.find(".fullmag/runtimes/fem-gpu-host/include") != std::string::npos,
        "validation matrix must name the missing MFEM runtime include blocker");
}

} // namespace

int main() {
    required_interaction_docs_exist_and_name_their_implementation();
    required_interaction_docs_have_physics_contract_sections();
    required_release_gate_docs_exist();
    validation_matrix_names_closed_fixture_owners();
    validation_matrix_names_leaf_header_gate_rows();
    validation_matrix_names_mfem_stack_fixture_statuses();
    return 0;
}
