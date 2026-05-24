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
        matrix.find("| Exchange | sinusoidal mode | convergence of helical `E_ex = A k^2 V` with finite `H_ex` diagnostic | scripted in `tests/fem_exchange_validation/sinusoidal_mode.py`; representative `fullmag --headless` finest-mesh stage passes on managed runtime; full CSV sweep requires a PyO3 `_fullmag_core` built with MFEM/libCEED |") !=
            std::string::npos,
        "validation matrix must map exchange sinusoidal fixture to its scripted runtime gate");
    check(
        matrix.find("| Demag Poisson | uniformly magnetized sphere | `H_demag ~= -M/3` inside | covered by `tests/fem_demag_validation/sphere_validation.py` (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must map Poisson sphere fixture to the scripted runtime gate");
    check(
        matrix.find("| Demag Poisson | airbox sweep | convergence with airbox size and boundary mode | covered by `tests/fem_demag_validation/airbox_convergence.py` (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must map Poisson airbox sweep fixture to the scripted runtime gate");
    check(
        matrix.find("| Demag FEM/BEM | body-only sphere | demag factor agreement | scripted in `tests/fem_demag_validation/fem_bem_body_validation.py`; body-only mesh materializes and source CLI diagnostic passes through Fredkin-Koehler, but active run remains runtime-open until the launcher/PyO3 core reports MFEM/libCEED CPU availability |") !=
            std::string::npos,
        "validation matrix must map FEM/BEM demag factor fixture to its scripted runtime gate and runtime blocker");
    check(
        matrix.find("OpenMPI headers/runtime components, CUDA headers/libraries referenced") !=
            std::string::npos &&
            matrix.find("relocated `MFEMConfig.cmake` / `MFEMTargets.cmake` metadata") !=
                std::string::npos,
        "validation matrix must document the regenerated relocatable MFEM host runtime bundle");
}

void validation_matrix_names_periodic_fixture_coverage() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("| Periodic FEM | exchange periodic pair fixture | class-consistent field across periodic nodes | local class/reduction coverage by `fem_mesh_contract` and `fem_aos_field_contract`; active exchange numerical periodic fixture requires MFEM stack |") !=
            std::string::npos,
        "validation matrix must map periodic exchange pair fixture to local class/reduction coverage and active-MFEM blocker");
}

void validation_matrix_documents_scope_and_runtime_boundary() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("## Current Local Gates") != std::string::npos &&
            matrix.find("## Required Physics Fixtures") != std::string::npos &&
            matrix.find("## Environment Boundary") != std::string::npos,
        "validation matrix must separate local gates, required physics fixtures, and environment boundary");
    check(
        matrix.find("Rows marked\n`runtime-open (requires MFEM stack)` still lack a concrete numerical fixture\ngate") !=
            std::string::npos,
        "validation matrix must keep runtime-open numerical fixture gates separate from local contracts");
}

void capability_matrix_blocks_validation_promotion_for_risky_fem_terms() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "specs" / "capability-matrix-v0.md");

    const char *features[] = {
        "Slonczewski STT",
        "Zhang-Li STT",
        "DMI interfacial/bulk",
        "thermal noise",
        "generalized/current-solution Oersted on FEM",
        "two-way magnetoelasticity",
    };

    check(
        matrix.find("must not be described as `validated` until their feature-specific gates pass") !=
            std::string::npos,
        "capability matrix must keep risky native FEM terms out of validated status");
    for (const char *feature : features) {
        check(
            matrix.find(feature) != std::string::npos,
            "capability matrix must list each risky native FEM feature");
    }
}

void progress_report_marks_interaction_docs_gate_closed() {
    const std::filesystem::path root = repo_root();
    const std::string progress = read_text_file(
        root / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Dodac dokumentacje fizyczna u gory plikow solvera | zrobione kontraktowo dla aktywnych interakcji |") !=
            std::string::npos,
        "progress report must mark per-interaction physical docs/docstrings as contract-covered");
    check(
        progress.find("`fem_interaction_docs_contract`") != std::string::npos &&
            progress.find("boundary docstring") != std::string::npos,
        "progress report must cite the interaction docs contract and boundary docstring coverage");
}

void progress_report_marks_local_interaction_split_contract_covered() {
    const std::filesystem::path root = repo_root();
    const std::string progress = read_text_file(
        root / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Wydzielic lokalne oddzialywania (`anis`, `cubic`, `DMI`, `thermal`, `STT`, `Oersted`) | zrobione kontraktowo |") !=
            std::string::npos,
        "progress report must mark local interaction split as contract-covered");
    check(
        progress.find("`fem_zeeman_contract`") != std::string::npos &&
            progress.find("`fem_anisotropy_contract`") != std::string::npos &&
            progress.find("`fem_dmi_contract`") != std::string::npos &&
            progress.find("`fem_thermal_brown_contract`") != std::string::npos &&
            progress.find("`fem_stt_contract`") != std::string::npos &&
            progress.find("`fem_oersted_contract`") != std::string::npos &&
            progress.find("`fem_magnetoelastic_contract`") != std::string::npos &&
            progress.find("`fem_effective_field_contract`") != std::string::npos,
        "progress report must cite local-interaction contract gates");
    check(
        progress.find("dalsza walidacja runtime MFEM-stack i fixture fizyczne pozostaje osobna") !=
            std::string::npos,
        "progress report must keep active runtime/fixture validation separate from module split coverage");
}

void progress_report_marks_validation_matrix_contract_covered() {
    const std::filesystem::path root = repo_root();
    const std::string progress = read_text_file(
        root / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Stworzyc pelna macierz testow FEM CPU | zrobione kontraktowo |") !=
            std::string::npos,
        "progress report must mark the FEM CPU validation matrix as contract-covered");
    check(
        progress.find("`docs/validation/fem_cpu_validation_matrix.md`") !=
                std::string::npos &&
            progress.find("Current Local Gates") != std::string::npos &&
            progress.find("Required Physics Fixtures") != std::string::npos &&
            progress.find("Environment Boundary") != std::string::npos,
        "progress report must cite the validation matrix sections");
    check(
        progress.find("runtime-open fixture/convergence gates MFEM-stack pozostaja osobna kwalifikacja") !=
            std::string::npos,
        "progress report must keep active runtime fixture qualification open");
}

void progress_report_summary_matches_contract_closed_scope() {
    const std::filesystem::path root = repo_root();
    const std::string progress = read_text_file(
        root / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("Ten wpis zamyka kontraktowy wycinek modularizacji native FEM CPU") !=
            std::string::npos,
        "progress report introduction must describe the current contract-closed modularization scope");
    check(
        progress.find("produkcyjna kwalifikacja runtime MFEM/libCEED i fixture numeryczne pozostaja osobnymi gate'ami") !=
            std::string::npos,
        "progress report introduction must keep production runtime qualification separate");
    check(
        progress.find("pierwszy maly wycinek") == std::string::npos &&
            progress.find("pierwsze wydzielenia z monolitu") == std::string::npos,
        "progress report introduction must not describe the current table as only the first small slice");
}

void interaction_headers_declare_ownership_boundaries() {
    const std::filesystem::path interactions =
        repo_root() / "native" / "backends" / "fem" / "cpu" / "mfem" / "interactions";

    for (const auto &entry : std::filesystem::directory_iterator(interactions)) {
        if (!entry.is_regular_file() || entry.path().extension() != ".hpp") {
            continue;
        }
        const std::string text = read_text_file(entry.path());
        if (text.find("owns") == std::string::npos &&
            text.find("does not own") == std::string::npos) {
            std::fprintf(
                stderr,
                "FAIL: interaction header %s must declare ownership boundaries\n",
                entry.path().string().c_str());
            std::exit(1);
        }
    }
}

} // namespace

int main() {
    required_interaction_docs_exist_and_name_their_implementation();
    required_interaction_docs_have_physics_contract_sections();
    required_release_gate_docs_exist();
    validation_matrix_names_closed_fixture_owners();
    validation_matrix_names_leaf_header_gate_rows();
    validation_matrix_names_mfem_stack_fixture_statuses();
    validation_matrix_names_periodic_fixture_coverage();
    validation_matrix_documents_scope_and_runtime_boundary();
    capability_matrix_blocks_validation_promotion_for_risky_fem_terms();
    progress_report_marks_interaction_docs_gate_closed();
    progress_report_marks_local_interaction_split_contract_covered();
    progress_report_marks_validation_matrix_contract_covered();
    progress_report_summary_matches_contract_closed_scope();
    interaction_headers_declare_ownership_boundaries();
    return 0;
}
