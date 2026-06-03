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
    return fem_root.parent_path().parent_path();
}

std::filesystem::path fem_source_root() {
    return repo_root() / "backends" / "fem";
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
        matrix.find("| Exchange | sinusoidal mode | finest-mesh `H_ex` agrees with `2 A_ex/(mu0 Ms) Delta m` within 25% and `E_ex = A k^2 V` converges under refinement | scripted in `tests/fem_exchange_validation/sinusoidal_mode.py`; representative `fullmag --headless` finest-mesh stage passes on managed runtime; full CSV sweep requires a PyO3 `_fullmag_core` built with MFEM/libCEED |") !=
            std::string::npos,
        "validation matrix must map exchange sinusoidal fixture to its scripted runtime gate");
    check(
        matrix.find("| Demag Poisson | uniformly magnetized sphere | `H_demag ~= -M/3` inside | covered by `tests/fem_demag_validation/sphere_validation.py` (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must map Poisson sphere fixture to the scripted runtime gate");
    check(
        matrix.find("| Demag Poisson | ellipsoid factors | Osborn demag factors agree within 10% per axis and sum to 1 within 0.15 per shape | covered by `tests/fem_demag_validation/ellipsoid_validation.py` (requires MFEM stack) |") !=
            std::string::npos,
        "validation matrix must map Poisson ellipsoid fixture to the scripted runtime gate");
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

void validation_matrix_names_remaining_interaction_local_contract_pass() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("## Local Interaction Contract Pass") != std::string::npos,
        "validation matrix must contain the local interaction contract pass");

    const char *rows[] = {
        "| Exchange | `fem_exchange_contract` | `fem_exchange.md` pins `A_ex` in `J/m`, `Ms`/`H_ex` in `A/m`, and `E_ex` in `J` | source/docs gate pins positive `E_ex = integral A_ex |grad m|^2 dV` and the `H_ex,c = -2 h_raw_c/(mu0 Ms)` weak-form sign; sinusoidal Laplacian and energy convergence remain runtime fixtures | CPU owners: `exchange_*`; GPU owners: `gpu/cuda/exchange/*`, `rk_exchange_dispatch.*`, `rk_exchange_energy_reductions.*` | local-ready; runtime-open for MFEM sinusoidal Laplacian and convergence sweep |",
        "| Demag | `fem_demag_contract`, `fem_demag_poisson_contract`, `fem_demag_fem_bem_contract` | `fem_demag_poisson.md` and `fem_demag_fem_bem.md` pin `u` in `A`, `H_demag` in `A/m`, and `E_d` in `J` | local gates pin `H_demag = -grad(u)` and `E_d = -0.5 mu0 integral Ms m.H_demag dV`; sphere/ellipsoid/airbox/residual checks remain runtime fixtures | CPU owners: `demag*`, `demag_poisson_*`, `demag_fem_bem_*`; GPU owners: `gpu/cuda/demag_poisson/*`, `rk_demag_dispatch.*`, `rk_demag_energy_reductions.*` | local-ready; runtime-open for sphere, ellipsoid, airbox convergence, residual, and strict GPU residency gates |",
        "| Zeeman | `fem_zeeman_contract` | `fem_zeeman.md` pins `H_ext`/`Ms` in `A/m` and `E_Z` in `J` | local gate pins additive `H_Z = H_ext` and negative work sign `E_Z = -mu0 integral Ms m.H_ext dV` | CPU owners: `zeeman_*`; GPU owners: `gpu/cuda/interactions/zeeman/zeeman_kernels.*`, `rk_external_energy_reductions.*`, `rk_effective_field.*` | local-ready; CPU/GPU parity still runtime-open |",
        "| Anisotropy | `fem_anisotropy_contract` | `fem_anisotropy_uniaxial.md` and `fem_anisotropy_cubic.md` pin `Ku*`/`Kc*` in `J/m^3`, axes dimensionless, `H_ani`/`H_cub` in `A/m`, and energies in `J` | local gate pins easy-axis/easy-cubic signs, cubic `H_cub = -(1/(mu0 Ms)) d e_cub/dm`, per-node scaling, and axis validation; directional derivative remains a production qualification fixture | CPU owners: `anisotropy_*`; GPU owners: `gpu/cuda/interactions/anisotropy/anisotropy_kernels.*`, `rk_anisotropy_field.*`, `rk_anisotropy_energy_reductions.*` | local-ready; broader derivative and CPU/GPU parity gates remain runtime/open qualification |",
        "| DMI | `fem_dmi_contract`, `fem_dmi_weak_residual` | `fem_dmi.md` pins `Dind` / `InterfacialDMI(D=...)` as unchanged `J/m^2` surface input and `H_DMI` in `A/m` | weak-residual gate pins interfacial/bulk directional derivatives, chirality, spiral-pitch handedness/sign, boundary tilt, and non-default interface-normal use | CPU owners: `dmi_*`; GPU owners: `gpu/cuda/interactions/dmi/dmi_kernels.*`, `rk_dmi_fields.*`, `rk_dmi_energy_reductions.*` | local-ready plus prior CUDA smoke evidence; public status must stay below `validated` until documented validation workloads are current |",
        "| Oersted | `fem_oersted_contract` | `fem_oersted.md` pins `I` in `A`, radius/center in `m`, and `H_oe` in `A/m` | local gate pins Ampere-law inside/outside field direction `a x r_hat`, envelope scaling, and unscaled explicit-field addition; no standalone energy is reported | CPU owners: `oersted_*`; GPU owners: `gpu/cuda/interactions/oersted/oersted_kernels.*`, `rk_oersted_field.*`, `rk_effective_field.*` | local-ready; generalized current-solution and CPU/GPU parity remain runtime-open |",
        "| Thermal | `fem_thermal_brown_contract` | `fem_thermal.md` and `fem_thermal_brown.md` pin `T` in `K`, `dt` in `s`, `V_i` in `m^3`, `gamma_mu0` in `m/(A s)`, and `H_therm` in `A/m` | local gate pins Brown sigma scaling, accepted `(time, dt)` replay/cache, nonmagnetic zeroing, and no deterministic standalone energy; variance-vs-`dt` and Boltzmann macrospin remain runtime/statistical fixtures | CPU owners: `thermal_brown_*`; GPU owners: `gpu/cuda/interactions/thermal/thermal_kernels.*`, `rk_thermal_field.*` | local-ready; runtime-open for statistical variance, Boltzmann macrospin, and CPU/GPU parity gates |",
        "| Magnetoelastic | `fem_magnetoelastic_contract` | `fem_magnetoelastic.md` pins `B1/B2` in `Pa`, strain dimensionless, `H_mel` in `A/m`, and `E_mel` in `J` | local gate pins engineering-shear Voigt convention, negative field derivative sign, energy integration, nonmagnetic masking, and additive `H_eff`; coupled mechanics remains deferred | CPU owners: `magnetoelastic_*`; GPU owners: `gpu/cuda/interactions/magnetoelastic/*`, `rk_magnetoelastic_field.*`, `rk_magnetoelastic_energy_reductions.*` | local-ready for prescribed strain; coupled mechanics and CPU/GPU parity remain runtime-open |",
    };

    for (const char *row : rows) {
        check(
            matrix.find(row) != std::string::npos,
            "validation matrix must name every remaining interaction local contract row");
    }

    check(
        matrix.find("This section is a local-contract readiness table, not a validated-status promotion.") !=
            std::string::npos,
        "local interaction contract pass must explicitly avoid validated-status promotion");
}

void validation_matrix_names_runtime_validation_stage() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("## Runtime Validation Matrix (MFEM/CUDA Stage)") !=
            std::string::npos,
        "validation matrix must contain the separate runtime validation stage");
    check(
        matrix.find("No row in this section changes a capability row to `validated`.") !=
            std::string::npos,
        "runtime validation matrix must explicitly avoid public validated-status promotion");

    const char *rows[] = {
        "| Exchange | sinusoidal Laplacian | recovered `H_ex` matches `2 A_ex/(mu0 Ms) Delta m` for sinusoidal magnetization within 25% on the finest mesh | MFEM/libCEED CPU runtime or equivalent native FEM runtime | runtime-open; scripted acceptance covered by `tests/fem_exchange_validation/sinusoidal_mode.py`, full CSV run still requires MFEM/libCEED PyO3 core |",
        "| Exchange | energy convergence | `E_ex` converges to `A k^2 V` under mesh refinement | MFEM/libCEED CPU runtime with PyO3 `_fullmag_core` built against the same stack | runtime-open; scripted acceptance covered by `tests/fem_exchange_validation/sinusoidal_mode.py`, full CSV run still requires MFEM/libCEED PyO3 core |",
        "| Demag | sphere | uniformly magnetized sphere gives `H_demag ~= -M/3` and finite `E_d` | MFEM/libCEED/Hypre runtime | runtime-open; scripted gate exists at `tests/fem_demag_validation/sphere_validation.py` |",
        "| Demag | ellipsoid factors | effective demag factors agree with Osborn ellipsoid references within 10% per axis and sum to 1 within 0.15 per shape | MFEM/libCEED/Hypre runtime | runtime-open; scripted gate exists at `tests/fem_demag_validation/ellipsoid_validation.py` |",
        "| Demag | airbox convergence | Dirichlet/Robin airbox sweep improves with increasing airbox extent | MFEM/libCEED/Hypre runtime | runtime-open; scripted gate exists at `tests/fem_demag_validation/airbox_convergence.py` |",
        "| Demag | residual and iteration telemetry | solve publishes finite residuals, nonnegative iteration counts, and demag phase timings for assemble/RHS, solve, recover, and energy | MFEM/libCEED/Hypre runtime | runtime-open; telemetry CSV acceptance covered by `tests/fem_demag_validation/telemetry_validation.py` and `tests/fem_demag_validation/test_acceptance.py`, active solve evidence still required |",
        "| DMI | chirality | interfacial and bulk DMI choose the expected handedness for domain-wall / spiral fixtures | MFEM runtime for active solve; local weak-residual executable for source-level proof | local fixture covered by `fem_dmi_weak_residual`; runtime CSV acceptance covered by `tests/fem_dmi_validation/artifact_validation.py` and `tests/fem_dmi_validation/test_acceptance.py`; active runtime freshness still required before public validated status |",
        "| DMI | spiral pitch | bulk/interfacial spiral pitch sign and scale match the documented coefficient convention | MFEM runtime for active solve; local weak-residual executable for source-level proof | local fixture covered by `fem_dmi_weak_residual`; runtime CSV acceptance covered by `tests/fem_dmi_validation/artifact_validation.py` and `tests/fem_dmi_validation/test_acceptance.py`; active runtime freshness still required before public validated status |",
        "| DMI | boundary tilt | natural-boundary derivative is nonzero for tangential tilt and zero for the baseline uniform state | MFEM runtime for active solve; local weak-residual executable for source-level proof | local fixture covered by `fem_dmi_weak_residual`; runtime CSV acceptance covered by `tests/fem_dmi_validation/artifact_validation.py` and `tests/fem_dmi_validation/test_acceptance.py`; active runtime freshness still required before public validated status |",
        "| Thermal | variance vs `dt` | Brown-field sample variance scales as `1/dt` with node volume, damping, `Ms`, and temperature | local sampler statistics plus stochastic runtime harness with deterministic seed | local sampler gate covered by `fem_thermal_brown_contract`; runtime CSV acceptance covered by `tests/fem_thermal_validation/artifact_validation.py` and `tests/fem_thermal_validation/test_acceptance.py`; active stochastic runtime evidence still required |",
        "| Thermal | Boltzmann macrospin | long-run macrospin statistics match Boltzmann equilibrium within documented tolerance | statistical runtime harness with deterministic seed | runtime CSV acceptance covered by `tests/fem_thermal_validation/artifact_validation.py` and `tests/fem_thermal_validation/test_acceptance.py`; active stochastic LLG runtime trajectory gate still missing |",
        "| GPU | strict residency counters | strict GPU path reports device source-of-truth, `hot_loop_compute_h2d_bytes = 0`, `hot_loop_compute_d2h_bytes = 0`, and `hot_loop_compute_host_sync_count = 0` | CUDA-visible MFEM/libCEED/Hypre GPU runtime | runtime-open; `scripts/analysis/fem_gpu_benchmark.py --require-gpu-strict-residency` enforces device source-of-truth plus zero hot-loop compute transfer/sync counters, and the box500 interaction preset enables it; current qualification still requires rerun |",
        "| GPU | CPU/GPU parity | CPU and GPU fields, energies, and accepted-step statistics agree within per-interaction tolerances | CUDA-visible MFEM/libCEED/Hypre GPU runtime plus CPU reference run | runtime-open; scripted gate exists at `scripts/analysis/fem_gpu_benchmark.py --box500-airbox-interaction-consistency-preset` and `just bench-fem-box500-consistency` |",
    };

    for (const char *row : rows) {
        check(
            matrix.find(row) != std::string::npos,
            "validation matrix must name every runtime validation stage row");
    }

    check(
        matrix.find("## Runtime Artifact Acceptance Commands") !=
            std::string::npos,
        "validation matrix must publish concrete runtime artifact acceptance commands");
    const char *commands[] = {
        "| Exchange sinusoidal Laplacian and energy convergence | `python3 tests/fem_exchange_validation/sinusoidal_mode.py` |",
        "| Demag sphere | `python3 tests/fem_demag_validation/sphere_validation.py` |",
        "| Demag ellipsoid factors | `python3 tests/fem_demag_validation/ellipsoid_validation.py` |",
        "| Demag airbox convergence | `python3 tests/fem_demag_validation/airbox_convergence.py` |",
        "| Demag residual and iteration telemetry artifact | `python3 tests/fem_demag_validation/telemetry_validation.py <demag_telemetry.csv>` |",
        "| DMI chirality, spiral pitch, and boundary tilt artifact | `python3 tests/fem_dmi_validation/artifact_validation.py <dmi_runtime.csv>` |",
        "| Thermal variance and Boltzmann macrospin artifact | `python3 tests/fem_thermal_validation/artifact_validation.py <thermal_runtime.csv>` |",
        "| GPU strict residency and CPU/GPU parity | `just bench-fem-box500-consistency` |",
    };
    for (const char *command : commands) {
        check(
            matrix.find(command) != std::string::npos,
            "validation matrix must name every runtime artifact acceptance command");
    }
}

void validation_matrix_documents_scope_and_runtime_boundary() {
    const std::filesystem::path root = repo_root();
    const std::string matrix =
        read_text_file(root / "docs" / "validation" / "fem_cpu_validation_matrix.md");

    check(
        matrix.find("## Current Local Gates") != std::string::npos &&
            matrix.find("## Required Physics Fixtures") != std::string::npos &&
            matrix.find("## Runtime Artifact Acceptance Commands") != std::string::npos &&
            matrix.find("## Environment Boundary") != std::string::npos,
        "validation matrix must separate local gates, required physics fixtures, runtime artifact commands, and environment boundary");
    check(
        matrix.find("Rows marked runtime-open\nhave scripted gates or artifact validators") !=
            std::string::npos,
        "validation matrix must keep runtime-open execution separate from local contracts");
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
        fem_source_root() / "cpu" / "mfem" / "interactions";

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

void interaction_contract_uses_canonical_fem_backend_root() {
    const std::filesystem::path fem_root = fem_source_root();
    const std::filesystem::path interactions =
        fem_root / "cpu" / "mfem" / "interactions";
    const std::filesystem::path retired_interactions =
        repo_root() / "native" / "backends" / "fem" / "cpu" / "mfem" / "interactions";
    const std::string cmake = read_text_file(fem_root / "CMakeLists.txt");

    check(fem_root.filename() == "fem", "canonical FEM backend root must be named fem");
    check(fem_root.parent_path().filename() == "backends", "canonical FEM backend root must live under backends");
    check(
        std::filesystem::exists(interactions),
        "FEM interaction contracts must inspect backends/fem/cpu/mfem/interactions");
    check(
        !std::filesystem::exists(retired_interactions),
        "native/backends/fem/cpu/mfem/interactions must not be recreated as an active implementation tree");
    check(
        cmake.find("cpu/mfem/interactions/exchange.cpp") != std::string::npos,
        "FEM CMake source list must keep interaction implementations under cpu/mfem/interactions");
    check(
        cmake.find("native/backends/fem") == std::string::npos,
        "FEM CMake source list must not refer to the retired native/backends/fem root");
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
    validation_matrix_names_remaining_interaction_local_contract_pass();
    validation_matrix_names_runtime_validation_stage();
    validation_matrix_documents_scope_and_runtime_boundary();
    capability_matrix_blocks_validation_promotion_for_risky_fem_terms();
    progress_report_marks_interaction_docs_gate_closed();
    progress_report_marks_local_interaction_split_contract_covered();
    progress_report_marks_validation_matrix_contract_covered();
    progress_report_summary_matches_contract_closed_scope();
    interaction_headers_declare_ownership_boundaries();
    interaction_contract_uses_canonical_fem_backend_root();
    return 0;
}
