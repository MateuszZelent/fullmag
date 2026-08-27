/*
 * rk_explicit_contract.cpp - native FEM explicit Runge-Kutta workspace contracts.
 */

#include "context.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_explicit_step.hpp"
#include "cpu/mfem/integrators/rk_stepper_workspace.hpp"
#include "cpu/mfem/runtime/backend_step.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
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

void check_near(double actual, double expected, double tolerance, const char *msg) {
    if (std::fabs(actual - expected) > tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g (tol %.3g)\n",
            msg,
            expected,
            actual,
            tolerance);
        std::exit(1);
    }
}

void check_vector_near(
    const std::vector<double> &actual,
    const std::vector<double> &expected,
    double tolerance,
    const char *msg)
{
    check(actual.size() == expected.size(), "vector comparison size mismatch");
    for (size_t i = 0; i < actual.size(); ++i) {
        if (std::fabs(actual[i] - expected[i]) > tolerance) {
            std::fprintf(
                stderr,
                "FAIL: %s[%zu]: expected %.17g, got %.17g (tol %.3g)\n",
                msg,
                i,
                expected[i],
                actual[i],
                tolerance);
            std::exit(1);
        }
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

std::filesystem::path repo_root() {
    const std::filesystem::path fem_root = fem_source_root();
    return fem_root.parent_path().parent_path();
}

void rk_workspace_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.cpp");
    const std::string rk_tableau =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_tableau.hpp");
    const std::string rk_workspace =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");

    check(
        context_header.find("struct StepperWorkspace {") == std::string::npos,
        "StepperWorkspace definition must not live in context.hpp");
    check(
        context_header.find("struct ExplicitTableau {") == std::string::npos,
        "ExplicitTableau definition must not live in context.hpp");
    check(
        context_header.find("const ExplicitTableau &tableau_for_integrator(") ==
            std::string::npos,
        "RK tableau selector declaration must not live in context.hpp");
    check(
        context_header.find("void stepper_workspace_allocate(") == std::string::npos,
        "RK workspace allocation declaration must not live in context.hpp");
    check(
        context_header.find("bool context_step_explicit_rk_mfem(") == std::string::npos,
        "explicit RK step declaration must not live in context.hpp");
    check(
        rk_tableau.find("struct ExplicitTableau {") != std::string::npos,
        "ExplicitTableau definition must live in rk_tableau.hpp");
    check(
        rk_tableau.find("Explicit Runge-Kutta tableau contract") != std::string::npos,
        "RK tableau header must document its contract");
    check(
        rk_workspace.find("struct StepperWorkspace {") != std::string::npos,
        "StepperWorkspace definition must live in rk_stepper_workspace.hpp");
    check(
        rk_workspace.find("struct RkStepperRuntimeState") != std::string::npos,
        "RK stepper workspace header must declare the runtime workspace owner");
    check(
        rk_workspace.find("StepperWorkspace workspace") != std::string::npos,
        "RK stepper runtime state must own the reusable StepperWorkspace");
    check(
        rk_workspace.find("std::unique_ptr<RkAttemptCacheSnapshot> attempt_checkpoint") !=
            std::string::npos,
        "adaptive RK attempt checkpoint must be owned by the reusable workspace");
    check(
        context_header.find("RkStepperRuntimeState stepper{}") != std::string::npos,
        "Context must store RK workspace through the runtime owner");
    check(
        context_header.find("StepperWorkspace stepper") == std::string::npos,
        "Context must not own a flat StepperWorkspace field");
    check(
        rk_workspace.find("Reusable explicit Runge-Kutta stepper workspace") !=
            std::string::npos,
        "Stepper workspace header must document its contract");
    check(
        bridge.find("void stepper_workspace_allocate(") == std::string::npos,
        "stepper workspace allocation must not be defined in mfem_bridge.cpp");
    check(
        rk_explicit.find("void stepper_workspace_allocate(") != std::string::npos,
        "stepper workspace allocation must be defined in rk_explicit.cpp");
    check(
        bridge.find("static bool evaluate_rhs(") == std::string::npos,
        "explicit RK stage RHS evaluator must not be defined in mfem_bridge.cpp");
    check(
        rk_stage_rhs.find("bool evaluate_rk_stage_rhs(") != std::string::npos,
        "explicit RK stage RHS evaluator must be defined in rk_stage_rhs.cpp");
    check(
        bridge.find("bool context_step_explicit_rk_mfem(") == std::string::npos,
        "explicit RK stepper must not be defined in mfem_bridge.cpp");
    check(
        rk_explicit_step.find("bool context_step_explicit_rk_mfem(") != std::string::npos,
        "explicit RK stepper must be defined in rk_explicit_step.cpp");
    check(
        rk_explicit_step.find("std::make_unique<RkAttemptCacheSnapshot>(ctx, false)") !=
            std::string::npos &&
            rk_explicit_step.find("fallback_attempt_cache") != std::string::npos,
        "adaptive RK stepper must allocate its compatibility checkpoint outside the attempt loop");
    check(
        rk_explicit_step.find("compute_adaptive_error_norm_mass_weighted(") !=
            std::string::npos &&
            rk_explicit_step.find("ctx.integration_weights.mfem_lumped_mass") !=
                std::string::npos &&
            rk_explicit_step.find("ctx.mesh.node_volumes") != std::string::npos,
        "adaptive RK production path must consume canonical FEM measure weights");
}

void integrator_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.cpp");
    const std::string heun =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "heun.cpp");
    const std::string llg_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.cpp");
    const std::string rk23 =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk23.cpp");
    const std::string rk4 =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk4.cpp");
    const std::string rk45 =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk45.cpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.cpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");

    check(
        adaptive.find("Adaptive timestep source contract") != std::string::npos,
        "adaptive_dt source file must document its source contract");
    check(
        adaptive.find("does not evaluate RK stages, compose H_eff, update magnetization, or publish step metrics") != std::string::npos,
        "adaptive_dt source file must document its non-owning step boundary");
    check(
        heun.find("Heun tableau source contract") != std::string::npos,
        "Heun tableau source file must document its source contract");
    check(
        heun.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "Heun tableau source file must document its non-owning step boundary");
    check(
        llg_rhs.find("LLG RHS source contract") != std::string::npos,
        "LLG RHS source file must document its source contract");
    check(
        llg_rhs.find("does not compose H_eff, evaluate interaction fields, advance time, or own step metrics") != std::string::npos,
        "LLG RHS source file must document its non-owning integration boundary");
    check(
        rk23.find("RK23 tableau source contract") != std::string::npos,
        "RK23 tableau source file must document its source contract");
    check(
        rk23.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "RK23 tableau source file must document its non-owning step boundary");
    check(
        rk4.find("RK4 tableau source contract") != std::string::npos,
        "RK4 tableau source file must document its source contract");
    check(
        rk4.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "RK4 tableau source file must document its non-owning step boundary");
    check(
        rk45.find("RK45 tableau source contract") != std::string::npos,
        "RK45 tableau source file must document its source contract");
    check(
        rk45.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "RK45 tableau source file must document its non-owning step boundary");
    check(
        rk_explicit.find("Explicit RK workspace source contract") != std::string::npos,
        "explicit RK workspace source file must document its source contract");
    check(
        rk_explicit.find("does not evaluate stage RHS, perform complete RK steps, compose H_eff, or own adaptive control") != std::string::npos,
        "explicit RK workspace source file must document its non-owning step boundary");
    check(
        rk_explicit_step.find("Explicit RK step source contract") != std::string::npos,
        "explicit RK step source file must document its source contract");
    check(
        rk_explicit_step.find("does not define tableau coefficients, own workspace allocation, compose H_eff internals, or publish standalone stage RHS") != std::string::npos,
        "explicit RK step source file must document its non-owning helper boundary");
    check(
        rk_stage_rhs.find("RK stage RHS source contract") != std::string::npos,
        "RK stage RHS source file must document its source contract");
    check(
        rk_stage_rhs.find("does not define RK tableau coefficients, allocate stepper workspace, accept/reject adaptive steps, or publish final step metrics") != std::string::npos,
        "RK stage RHS source file must document its non-owning step boundary");
}

void integrator_headers_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.hpp");
    const std::string llg_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.hpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.hpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.hpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.hpp");
    const std::string rk_workspace =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");
    const std::string rk_tableau =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_tableau.hpp");
    const std::string tableaus =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "tableaus.hpp");

    check(
        adaptive.find("It does not evaluate RK stages") != std::string::npos &&
            adaptive.find("publish step metrics") != std::string::npos,
        "adaptive_dt header must document its non-owning step boundary");
    check(
        llg_rhs.find("It does not compose H_eff") != std::string::npos &&
            llg_rhs.find("advance time") != std::string::npos &&
            llg_rhs.find("step metrics") != std::string::npos,
        "LLG RHS header must document its non-owning integration boundary");
    check(
        rk_explicit.find("It does not evaluate stage RHS") != std::string::npos &&
            rk_explicit.find("own adaptive control") != std::string::npos,
        "explicit RK header must document its non-owning step boundary");
    check(
        rk_explicit_step.find("It does not define tableau coefficients") !=
                std::string::npos &&
            rk_explicit_step.find("standalone stage RHS") != std::string::npos,
        "explicit RK step header must document its non-owning helper boundary");
    check(
        rk_stage_rhs.find("It does not define RK tableau coefficients") !=
                std::string::npos &&
            rk_stage_rhs.find("final step") != std::string::npos &&
            rk_stage_rhs.find("metrics") != std::string::npos,
        "RK stage RHS header must document its non-owning step boundary");
    check(
        rk_workspace.find("It does not evaluate stage RHS") != std::string::npos &&
            rk_workspace.find("adaptive") != std::string::npos &&
            rk_workspace.find("accept/reject policy") != std::string::npos,
        "RK workspace header must document its non-owning module boundary");
    check(
        rk_tableau.find("It does not allocate workspace") != std::string::npos &&
            rk_tableau.find("run") != std::string::npos &&
            rk_tableau.find("adaptive control") != std::string::npos,
        "RK tableau header must document its non-owning step boundary");
    check(
        tableaus.find("Own named explicit Runge-Kutta tableau accessors") !=
                std::string::npos &&
            tableaus.find("run") != std::string::npos &&
            tableaus.find("adaptive control") != std::string::npos,
        "named tableaus header must document its ownership and non-owning boundary");
}

void workspace_reallocates_when_stage_count_grows() {
    fullmag::fem::StepperWorkspace ws;
    fullmag::fem::stepper_workspace_allocate(ws, 6u, 2);
    ws.k[0][0] = 1.0;
    ws.k[1][0] = 2.0;
    ws.fsal_valid = true;

    fullmag::fem::stepper_workspace_allocate(ws, 6u, 4);

    check(ws.allocated, "workspace remains allocated");
    check(ws.dof_len == 6u, "workspace keeps requested dof length");
    check(ws.k[0].size() == 6u, "stage 0 is allocated");
    check(ws.k[1].size() == 6u, "stage 1 is allocated");
    check(ws.k[2].size() == 6u, "stage 2 is allocated after stage-count growth");
    check(ws.k[3].size() == 6u, "stage 3 is allocated after stage-count growth");
    check(!ws.fsal_valid, "stage-count growth invalidates FSAL cache");
}

void workspace_invalidates_fsal_when_stage_count_shrinks() {
    fullmag::fem::StepperWorkspace ws;
    fullmag::fem::stepper_workspace_allocate(ws, 6u, 7);
    ws.fsal_valid = true;

    fullmag::fem::stepper_workspace_allocate(ws, 6u, 4);

    check(ws.k[0].size() == 6u, "stage 0 remains allocated after stage-count shrink");
    check(ws.k[3].size() == 6u, "stage 3 remains allocated after stage-count shrink");
    check(!ws.fsal_valid, "stage-count shrink invalidates FSAL cache");
}

void workspace_allocates_common_buffers() {
    fullmag::fem::StepperWorkspace ws;
    fullmag::fem::stepper_workspace_allocate(ws, 9u, 3);

    check(ws.m_backup.size() == 9u, "m backup allocated");
    check(ws.m_stage.size() == 9u, "stage magnetization allocated");
    check(ws.h_ex_tmp.size() == 9u, "exchange temp field allocated");
    check(ws.h_demag_tmp.size() == 9u, "demag temp field allocated");
    check(ws.h_eff_tmp.size() == 9u, "effective temp field allocated");
    check(ws.err.size() == 9u, "adaptive error buffer allocated");
}

void endpoint_cache_telemetry_has_explicit_validity_dimensions() {
    fullmag::fem::EndpointCacheValidity validity{};
    check(!validity.valid(), "an empty endpoint cache validity must be invalid");
    validity.state = true;
    validity.time = true;
    validity.dynamic_sources = true;
    validity.transport = true;
    validity.projection = true;
    check(validity.valid(), "all endpoint cache validity dimensions must be required");

    fullmag::fem::StepperWorkspace ws;
    ws.endpoint_telemetry.cache_validity = validity;
    ws.endpoint_telemetry.final_refresh_reason =
        fullmag::fem::RkFinalRefreshReason::CacheHit;
    ws.endpoint_telemetry.final_rhs_evaluations = 2u;
    ws.endpoint_telemetry.extra_poisson_solves = 3u;
    check(
        ws.endpoint_telemetry.final_refresh_reason ==
            fullmag::fem::RkFinalRefreshReason::CacheHit &&
            ws.endpoint_telemetry.final_rhs_evaluations == 2u &&
            ws.endpoint_telemetry.extra_poisson_solves == 3u,
        "endpoint telemetry must be typed and owned by the CPU RK workspace");

    const std::filesystem::path root = fem_source_root();
    const std::string stepper_header = read_text_file(
        root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");
    const std::string step_source = read_text_file(
        root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    for (const char *field : {
             "bool state",
             "bool time",
             "bool dynamic_sources",
             "bool transport",
             "bool projection",
             "final_rhs_evaluations",
             "extra_poisson_solves",
             "accepted_step_wall_time_ns",
         }) {
        check(
            stepper_header.find(field) != std::string::npos,
            "endpoint telemetry header must expose every required validity/cost field");
    }
    check(
        step_source.find("endpoint_refresh_reason") != std::string::npos &&
            step_source.find("endpoint_telemetry.extra_poisson_solves") !=
                std::string::npos,
        "CPU RK step must account for the final refresh reason and Poisson cost");
}

void rk_transaction_payload_inventory_covers_owned_vectors() {
    const std::string transaction = read_text_file(
        fem_source_root() / "cpu" / "mfem" / "integrators" / "rk_step_transaction.cpp");
    for (const char *field : {
             "state.m_xyz",
             "anisotropy.uniaxial_axis_x_field",
             "anisotropy.h_uniaxial_xyz",
             "magnetoelastic.strain_voigt",
             "exchange.h_xyz",
             "exchange.mfem.h_x",
             "demag.h_xyz",
             "demag.cached_xyz",
             "zeeman.h_ext_xyz",
             "zeeman.regional_drives",
             "attempt_trace.records",
             "hot_loop_violation_message",
             "dmi.h_interfacial_xyz",
             "effective_field.h_xyz",
             "oersted.h_basis_per_ampere_xyz",
             "stage_transport.torque_xyz_per_s",
             "thermal_brown.xi_xyz",
             "gpu_hybrid_stage_m",
             "cpu_k0",
             "poisson_solution",
             "fem_bem_boundary",
             "fem_bem_rhs",
         }) {
        check(
            transaction.find(field) != std::string::npos,
            "RK transaction payload inventory must name every owned dynamic vector");
    }
}

void fsal_reuse_requires_matching_source_state() {
    const std::filesystem::path root = fem_source_root();
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string gpu_rk_cuda =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string gpu_rk_rhs =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.cu");
    const std::string gpu_rk_fsal =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_fsal_policy.cpp");
    const std::string integrator_note = read_text_file(
        repo_root() / "docs" / "physics" / "0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md");

    check(
        rk_explicit_step.find("bool rk_rhs_allows_fsal_reuse(const fullmag::fem::Context &ctx)") !=
            std::string::npos,
        "CPU RK stepper must centralize the FSAL reuse gate");
    check(
        rk_explicit_step.find("ctx.thermal_brown.temperature > 0.0") !=
            std::string::npos,
        "CPU RK FSAL reuse gate must reject stochastic Brown thermal RHS");
    check(
        rk_explicit_step.find("ctx.oersted.has_stage_callback || ctx.stage_transport.has_stage_callback") !=
            std::string::npos,
        "CPU RK FSAL reuse gate must reject mutable stage callback sources");
    check(
        rk_explicit_step.find("ctx.oersted.time_dep_kind != 0u") ==
            std::string::npos,
        "CPU RK FSAL must permit deterministic time-dependent Oersted at the matching endpoint");
    check(
        gpu_rk_fsal.find("bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)") !=
            std::string::npos,
        "GPU RK stepper must centralize the autonomous-RHS FSAL reuse gate");
    check(
        gpu_rk_fsal.find("ctx.thermal_brown.temperature > 0.0") !=
            std::string::npos,
        "GPU RK FSAL reuse gate must reject stochastic Brown thermal RHS");
    check(
        gpu_rk_fsal.find("ctx.oersted.time_dep_kind != 0u") ==
            std::string::npos,
        "GPU RK FSAL must permit deterministic time-dependent Oersted at the matching endpoint");
    check(
        gpu_rk_rhs.find("bool gpu_rk_rhs_allows_fsal_reuse(") == std::string::npos,
        "GPU RK RHS runtime must not own FSAL reuse policy after extraction");
    check(
        integrator_note.find("FSAL reuse is disabled for stochastic Brown thermal fields, and time-dependent Oersted fields reuse it only when the accepted endpoint source state matches the next first stage") !=
            std::string::npos,
        "integrator physics note must document the Oersted FSAL endpoint condition");
}

void rk_rhs_passes_explicit_stage_and_endpoint_times() {
    const std::filesystem::path root = fem_source_root();
    const std::string cpu_stage =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");
    const std::string cpu_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string cpu_effective =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "effective_field.cpp");
    const std::string gpu_oersted =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_oersted_field.cu");
    const std::string gpu_final =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_final_refresh.cu");

    check(
        cpu_stage.find("double evaluation_time_s") != std::string::npos,
        "CPU RK stage RHS must accept an explicit evaluation time");
    check(
        cpu_step.find("ctx.state.current_time + tab.c[s] * dt") != std::string::npos,
        "CPU RK stages must use their tableau c_j times");
    check(
        cpu_step.find("ctx.state.current_time + dt") != std::string::npos,
        "CPU final effective-field refresh must use accepted endpoint time");
    check(
        cpu_effective.find("double evaluation_time_s") != std::string::npos,
        "CPU effective-field assembly must carry explicit evaluation time");
    check(
        gpu_oersted.find("double evaluation_time_s") != std::string::npos,
        "GPU Oersted accumulation must accept explicit evaluation time");
    check(
        gpu_final.find("ctx.state.current_time + active_dt") != std::string::npos,
        "GPU final refresh must use accepted endpoint time before commit");
}

#if FULLMAG_HAS_MFEM_STACK
constexpr double kPi = 3.141592653589793238462643383279502884;

void configure_oersted_only_rk_context(
    fullmag::fem::Context &ctx,
    fullmag_fem_integrator integrator) {
    ctx.mfem_context.ready = true;
    ctx.mesh.n_nodes = 1;
    ctx.mesh.magnetic_node_mask = {1u};
    ctx.mesh.node_volumes = {1.0};
    ctx.state.m_xyz = {1.0, 0.2, -0.1};
    fullmag::fem::normalize_aos_field(ctx.state.m_xyz);
    ctx.state.current_time = 0.071;
    ctx.base_plan.integrator = integrator;
    ctx.base_plan.precession_enabled = true;
    ctx.mfem_device.device_string_override = "cpu";
    ctx.exchange.enabled = false;
    ctx.demag.enabled = false;
    ctx.material_fields.material.gyromagnetic_ratio = 1.7;
    ctx.material_fields.material.damping = 0.13;

    ctx.oersted.has_cylinder = true;
    ctx.oersted.current = 2.3;
    ctx.oersted.time_dep_kind = 1;
    ctx.oersted.time_dep_freq = 0.83;
    ctx.oersted.time_dep_phase = 0.37;
    ctx.oersted.time_dep_offset = 0.21;
    ctx.oersted.h_basis_per_ampere_xyz = {0.0, 0.0, 1.0};

    ctx.zeeman.h_ext_xyz.assign(3u, 0.0);
    ctx.anisotropy.h_uniaxial_xyz.assign(3u, 0.0);
    ctx.anisotropy.h_cubic_xyz.assign(3u, 0.0);
    ctx.dmi.h_interfacial_xyz.assign(3u, 0.0);
}

struct StageOerstedCallbackProbe {
    std::vector<double> evaluation_times;
    std::vector<uint64_t> stage_identities;
    std::vector<uint64_t> begin_identities;
    uint32_t begin_count = 0;
    uint32_t commit_count = 0;
    uint32_t rollback_count = 0;
};

extern "C" int stage_oersted_probe_evaluate(
    void *user_data,
    const double *m_xyz,
    uint64_t m_xyz_len,
    double evaluation_time_s,
    uint64_t stage_identity,
    double *out_h_xyz_apm,
    uint64_t out_h_xyz_len,
    uint64_t *out_source_state_revision,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageOerstedCallbackProbe *>(user_data);
    if (probe == nullptr || m_xyz == nullptr || out_h_xyz_apm == nullptr ||
        m_xyz_len != out_h_xyz_len || (m_xyz_len % 3u) != 0u) {
        return 1;
    }
    probe->evaluation_times.push_back(evaluation_time_s);
    probe->stage_identities.push_back(stage_identity);
    for (uint64_t index = 0; index < m_xyz_len; index += 3u) {
        out_h_xyz_apm[index] = 0.0;
        out_h_xyz_apm[index + 1u] = 0.0;
        out_h_xyz_apm[index + 2u] = 1.0 + 0.25 * m_xyz[index] + evaluation_time_s;
    }
    if (out_source_state_revision != nullptr) {
        *out_source_state_revision = 17u;
    }
    return 0;
}

extern "C" int stage_oersted_probe_begin(
    void *user_data,
    uint64_t,
    uint64_t attempt_identity,
    double,
    double,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageOerstedCallbackProbe *>(user_data);
    if (probe == nullptr) return 1;
    probe->begin_count += 1u;
    probe->begin_identities.push_back(attempt_identity);
    return 0;
}

extern "C" int stage_oersted_probe_commit(
    void *user_data,
    uint64_t,
    uint64_t,
    double,
    double,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageOerstedCallbackProbe *>(user_data);
    if (probe == nullptr) return 1;
    probe->commit_count += 1u;
    return 0;
}

extern "C" int stage_oersted_probe_rollback(
    void *user_data,
    uint64_t,
    uint64_t,
    double,
    double,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageOerstedCallbackProbe *>(user_data);
    if (probe == nullptr) return 1;
    probe->rollback_count += 1u;
    return 0;
}

fullmag_fem_stage_oersted_callback_v1 make_stage_oersted_probe_callback(
    StageOerstedCallbackProbe &probe)
{
    fullmag_fem_stage_oersted_callback_v1 callback{};
    callback.abi_version = FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ABI_VERSION;
    callback.struct_size = sizeof(callback);
    callback.user_data = &probe;
    callback.evaluate = &stage_oersted_probe_evaluate;
    callback.begin_attempt = &stage_oersted_probe_begin;
    callback.commit_attempt = &stage_oersted_probe_commit;
    callback.rollback_attempt = &stage_oersted_probe_rollback;
    return callback;
}

std::vector<double> stage_oersted_probe_rhs(
    const fullmag::fem::Context &ctx,
    const std::vector<double> &m,
    double time_s)
{
    std::vector<double> h(m.size(), 0.0);
    for (size_t index = 0; index < m.size(); index += 3u) {
        h[index + 2u] = 1.0 + 0.25 * m[index] + time_s;
    }
    std::vector<double> rhs;
    double max_rhs = 0.0;
    fullmag::fem::llg_rhs_aos(
        m,
        h,
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.material.damping,
        nullptr,
        ctx.base_plan.precession_enabled,
        rhs,
        max_rhs);
    return rhs;
}

std::vector<double> stage_oersted_probe_rk_step(
    const fullmag::fem::Context &ctx,
    const fullmag::fem::ExplicitTableau &tableau,
    const std::vector<double> &m_initial,
    double time_initial,
    double dt)
{
    std::vector<std::vector<double>> stages(
        static_cast<size_t>(tableau.stages),
        std::vector<double>(m_initial.size(), 0.0));
    for (int stage = 0; stage < tableau.stages; ++stage) {
        std::vector<double> m_stage = m_initial;
        if (stage > 0) {
            for (size_t index = 0; index < m_stage.size(); ++index) {
                double increment = 0.0;
                for (int prior = 0; prior < stage; ++prior) {
                    increment += tableau.a[stage][prior] * stages[prior][index];
                }
                m_stage[index] += dt * increment;
            }
            fullmag::fem::normalize_aos_field(m_stage);
        }
        stages[stage] = stage_oersted_probe_rhs(
            ctx,
            m_stage,
            time_initial + tableau.c[stage] * dt);
    }
    std::vector<double> accepted = m_initial;
    for (size_t index = 0; index < accepted.size(); ++index) {
        double increment = 0.0;
        for (int stage = 0; stage < tableau.stages; ++stage) {
            increment += tableau.b_hi[stage] * stages[stage][index];
        }
        accepted[index] += dt * increment;
    }
    fullmag::fem::normalize_aos_field(accepted);
    return accepted;
}

void cpu_stage_oersted_callback_samples_exact_stages_and_commits()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
    ctx.oersted.has_cylinder = false;
    ctx.oersted.h_basis_per_ampere_xyz.clear();
    StageOerstedCallbackProbe probe;
    const auto callback = make_stage_oersted_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_oersted_stage_callback(ctx, &callback, error),
        error.c_str());
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_RK4);
    const auto expected = stage_oersted_probe_rk_step(
        ctx, tableau, ctx.state.m_xyz, ctx.state.current_time, 0.19);
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::run_backend_step(ctx, 0.19, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check_vector_near(
        ctx.state.m_xyz,
        expected,
        2e-13,
        "stage Oersted callback must drive the exact dynamic RK state");
    check(probe.begin_count == 1u, "stage Oersted callback must begin one attempt");
    check(probe.commit_count == 1u, "stage Oersted callback must commit one attempt");
    check(probe.rollback_count == 0u, "accepted stage Oersted callback must not roll back");
    check(
        probe.evaluation_times.size() == static_cast<size_t>(tableau.stages + 1),
        "stage Oersted callback must include every RK stage and endpoint refresh");
    check(
        probe.stage_identities.back() != probe.stage_identities.front() &&
            (probe.stage_identities.back() & 0xffffu) == 0xffffu,
        "accepted endpoint refresh must have a distinct reserved stage identity");
    for (size_t index = 1; index < probe.stage_identities.size(); ++index) {
        check(
            probe.stage_identities[index] != probe.stage_identities[index - 1],
            "stage Oersted callback identities must be distinct within an attempt");
    }
    check(!ctx.oersted.stage_attempt_active, "accepted stage callback attempt must close");
}

void cpu_stage_oersted_callback_rolls_back_adaptive_retries()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    ctx.oersted.has_cylinder = false;
    ctx.oersted.h_basis_per_ampere_xyz.clear();
    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.atol = 1e-10;
    ctx.adaptive_dt.rtol = 1e-10;
    ctx.adaptive_dt.dt_min = 1e-9;
    ctx.adaptive_dt.dt_max = 1.0;
    ctx.adaptive_dt.safety_factor = 0.8;
    ctx.adaptive_dt.dt_grow_max = 2.0;
    ctx.adaptive_dt.dt_shrink_min = 0.2;
    ctx.adaptive_dt.max_reject = 30;
    StageOerstedCallbackProbe probe;
    const auto callback = make_stage_oersted_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_oersted_stage_callback(ctx, &callback, error),
        error.c_str());
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::run_backend_step(ctx, 0.8, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check(stats.rejected_attempts > 0u, "dynamic stage callback fixture must reject an initial attempt");
    check(
        probe.begin_count == stats.rejected_attempts + 1u,
        "every adaptive stage callback attempt must have a begin hook");
    check(
        probe.rollback_count == stats.rejected_attempts,
        "every rejected dynamic stage callback attempt must roll back");
    check(probe.commit_count == 1u, "only the accepted dynamic stage callback attempt may commit");
    check(!ctx.oersted.stage_attempt_active, "adaptive callback attempt must close after acceptance");
    for (size_t index = 1; index < probe.begin_identities.size(); ++index) {
        check(
            probe.begin_identities[index] == probe.begin_identities[index - 1] + 1u,
            "adaptive callback attempt identities must be contiguous");
    }
}

void cpu_stage_oersted_callback_rolls_back_native_failure()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
    ctx.oersted.has_cylinder = false;
    ctx.oersted.h_basis_per_ampere_xyz.clear();
    StageOerstedCallbackProbe probe;
    const auto callback = make_stage_oersted_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_oersted_stage_callback(ctx, &callback, error),
        error.c_str());
    ctx.stepper.failure_injection.next =
        fullmag::fem::RkStepFailurePoint::AfterCandidateMagnetization;
    const auto m_before = ctx.state.m_xyz;
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::run_backend_step(ctx, 0.19, stats, error) != FULLMAG_FEM_OK,
        "native RK failure fixture must fail");
    check(probe.rollback_count == 1u, "native RK failure must roll back the stage callback");
    check(probe.commit_count == 0u, "failed native RK attempt must not commit the callback");
    check_vector_near(
        ctx.state.m_xyz,
        m_before,
        0.0,
        "native RK failure must preserve magnetization with a stage callback");
    check(!ctx.oersted.stage_attempt_active, "failed stage callback attempt must close");
}

void gpu_requested_stage_oersted_callback_fails_closed()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    ctx.oersted.has_cylinder = false;
    ctx.oersted.h_basis_per_ampere_xyz.clear();
    ctx.mfem_device.device_string_override = "cuda";
    StageOerstedCallbackProbe probe;
    const auto callback = make_stage_oersted_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_oersted_stage_callback(ctx, &callback, error),
        error.c_str());
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_HEUN);
    fullmag_fem_step_stats stats{};
    check(
        !fullmag::fem::context_step_explicit_rk_mfem(
            ctx, tableau, 0.01, stats, error),
        "GPU-requested stage Oersted callback must fail closed");
    check(
        error.find("CPU-only stage Oersted callback") != std::string::npos,
        "GPU callback rejection must identify the missing device-resident lane");
    check(probe.begin_count == 0u && probe.evaluation_times.empty(),
        "GPU callback rejection must happen before any stage invocation");
}

struct StageTransportCallbackProbe {
    std::vector<double> evaluation_times;
    std::vector<uint64_t> stage_identities;
    std::vector<uint64_t> begin_identities;
    uint32_t begin_count = 0;
    uint32_t commit_count = 0;
    uint32_t rollback_count = 0;
};

extern "C" int stage_transport_probe_evaluate(
    void *user_data,
    const double *m_xyz,
    uint64_t m_xyz_len,
    double evaluation_time_s,
    uint64_t stage_identity,
    double *out_torque_xyz_per_s,
    uint64_t out_torque_xyz_len,
    uint64_t *out_source_state_revision,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageTransportCallbackProbe *>(user_data);
    if (probe == nullptr || m_xyz == nullptr || out_torque_xyz_per_s == nullptr ||
        m_xyz_len != out_torque_xyz_len || (m_xyz_len % 3u) != 0u) {
        return 1;
    }
    probe->evaluation_times.push_back(evaluation_time_s);
    probe->stage_identities.push_back(stage_identity);
    for (uint64_t index = 0; index < m_xyz_len; index += 3u) {
        out_torque_xyz_per_s[index] =
            0.63 + 0.31 * m_xyz[index + 2u] + 0.17 * evaluation_time_s;
        out_torque_xyz_per_s[index + 1u] =
            -0.27 + 0.19 * m_xyz[index] - 0.11 * evaluation_time_s;
        out_torque_xyz_per_s[index + 2u] =
            0.14 - 0.23 * m_xyz[index + 1u] + 0.07 * evaluation_time_s;
    }
    if (out_source_state_revision != nullptr) {
        *out_source_state_revision = 23u;
    }
    return 0;
}

extern "C" int stage_transport_probe_begin(
    void *user_data,
    uint64_t,
    uint64_t attempt_identity,
    double,
    double,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageTransportCallbackProbe *>(user_data);
    if (probe == nullptr) return 1;
    probe->begin_count += 1u;
    probe->begin_identities.push_back(attempt_identity);
    return 0;
}

extern "C" int stage_transport_probe_commit(
    void *user_data,
    uint64_t,
    uint64_t,
    double,
    double,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageTransportCallbackProbe *>(user_data);
    if (probe == nullptr) return 1;
    probe->commit_count += 1u;
    return 0;
}

extern "C" int stage_transport_probe_rollback(
    void *user_data,
    uint64_t,
    uint64_t,
    double,
    double,
    char *,
    uint64_t)
{
    auto *probe = static_cast<StageTransportCallbackProbe *>(user_data);
    if (probe == nullptr) return 1;
    probe->rollback_count += 1u;
    return 0;
}

fullmag_fem_stage_transport_callback_v1 make_stage_transport_probe_callback(
    StageTransportCallbackProbe &probe)
{
    fullmag_fem_stage_transport_callback_v1 callback{};
    callback.abi_version = FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ABI_VERSION;
    callback.struct_size = sizeof(callback);
    callback.user_data = &probe;
    callback.evaluate = &stage_transport_probe_evaluate;
    callback.begin_attempt = &stage_transport_probe_begin;
    callback.commit_attempt = &stage_transport_probe_commit;
    callback.rollback_attempt = &stage_transport_probe_rollback;
    return callback;
}

std::vector<double> stage_transport_probe_rhs(
    const fullmag::fem::Context &ctx,
    const std::vector<double> &m,
    double time_s)
{
    std::vector<double> h(m.size(), 0.0);
    std::vector<double> rhs;
    double max_rhs = 0.0;
    fullmag::fem::llg_rhs_aos(
        m,
        h,
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.material.damping,
        nullptr,
        ctx.base_plan.precession_enabled,
        rhs,
        max_rhs);
    for (size_t index = 0; index < m.size(); index += 3u) {
        rhs[index] += 0.63 + 0.31 * m[index + 2u] + 0.17 * time_s;
        rhs[index + 1u] += -0.27 + 0.19 * m[index] - 0.11 * time_s;
        rhs[index + 2u] += 0.14 - 0.23 * m[index + 1u] + 0.07 * time_s;
    }
    return rhs;
}

std::vector<double> stage_transport_probe_rk_step(
    const fullmag::fem::Context &ctx,
    const fullmag::fem::ExplicitTableau &tableau,
    const std::vector<double> &m_initial,
    double time_initial,
    double dt)
{
    std::vector<std::vector<double>> stages(
        static_cast<size_t>(tableau.stages),
        std::vector<double>(m_initial.size(), 0.0));
    for (int stage = 0; stage < tableau.stages; ++stage) {
        std::vector<double> m_stage = m_initial;
        if (stage > 0) {
            for (size_t index = 0; index < m_stage.size(); ++index) {
                double increment = 0.0;
                for (int prior = 0; prior < stage; ++prior) {
                    increment += tableau.a[stage][prior] * stages[prior][index];
                }
                m_stage[index] += dt * increment;
            }
            fullmag::fem::normalize_aos_field(m_stage);
        }
        stages[stage] = stage_transport_probe_rhs(
            ctx,
            m_stage,
            time_initial + tableau.c[stage] * dt);
    }
    std::vector<double> accepted = m_initial;
    for (size_t index = 0; index < accepted.size(); ++index) {
        double increment = 0.0;
        for (int stage = 0; stage < tableau.stages; ++stage) {
            increment += tableau.b_hi[stage] * stages[stage][index];
        }
        accepted[index] += dt * increment;
    }
    fullmag::fem::normalize_aos_field(accepted);
    return accepted;
}

void cpu_stage_transport_callback_samples_exact_stages_and_commits()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
    ctx.oersted = {};
    StageTransportCallbackProbe probe;
    const auto callback = make_stage_transport_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_transport_stage_callback(ctx, &callback, error),
        error.c_str());
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_RK4);
    const auto expected = stage_transport_probe_rk_step(
        ctx, tableau, ctx.state.m_xyz, ctx.state.current_time, 0.19);
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::run_backend_step(ctx, 0.19, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check_vector_near(
        ctx.state.m_xyz,
        expected,
        2e-13,
        "stage transport callback must add the exact dynamic torque RHS");
    check(probe.begin_count == 1u, "stage transport callback must begin one attempt");
    check(probe.commit_count == 1u, "stage transport callback must commit one attempt");
    check(probe.rollback_count == 0u, "accepted stage transport callback must not roll back");
    check(
        probe.evaluation_times.size() == static_cast<size_t>(tableau.stages + 1),
        "stage transport callback must include every RK stage and endpoint refresh");
    check(
        probe.stage_identities.back() != probe.stage_identities.front() &&
            (probe.stage_identities.back() & 0xffffu) == 0xffffu,
        "accepted transport endpoint refresh must have a distinct reserved stage identity");
    check(
        ctx.stage_transport.stage_source_state_revision == 23u,
        "accepted transport callback must publish the source-state revision");
    check(!ctx.stage_transport.stage_attempt_active,
        "accepted stage transport callback attempt must close");
}

void cpu_stage_transport_callback_rolls_back_adaptive_retries()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    ctx.oersted = {};
    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.atol = 1e-10;
    ctx.adaptive_dt.rtol = 1e-10;
    ctx.adaptive_dt.dt_min = 1e-9;
    ctx.adaptive_dt.dt_max = 1.0;
    ctx.adaptive_dt.safety_factor = 0.8;
    ctx.adaptive_dt.dt_grow_max = 2.0;
    ctx.adaptive_dt.dt_shrink_min = 0.2;
    ctx.adaptive_dt.max_reject = 30;
    StageTransportCallbackProbe probe;
    const auto callback = make_stage_transport_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_transport_stage_callback(ctx, &callback, error),
        error.c_str());
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::run_backend_step(ctx, 0.8, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check(stats.rejected_attempts > 0u,
        "dynamic stage transport fixture must reject an initial attempt");
    check(
        probe.begin_count == stats.rejected_attempts + 1u,
        "every adaptive transport attempt must have a begin hook");
    check(
        probe.rollback_count == stats.rejected_attempts,
        "every rejected transport attempt must roll back");
    check(probe.commit_count == 1u,
        "only the accepted dynamic transport attempt may commit");
    check(!ctx.stage_transport.stage_attempt_active,
        "adaptive transport callback attempt must close after acceptance");
    for (size_t index = 1; index < probe.begin_identities.size(); ++index) {
        check(
            probe.begin_identities[index] == probe.begin_identities[index - 1] + 1u,
            "adaptive transport attempt identities must be contiguous");
    }
}

void cpu_stage_transport_callback_rolls_back_native_failure()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
    ctx.oersted = {};
    StageTransportCallbackProbe probe;
    const auto callback = make_stage_transport_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_transport_stage_callback(ctx, &callback, error),
        error.c_str());
    const auto m_before = ctx.state.m_xyz;
    const double time_before = ctx.state.current_time;
    const uint64_t step_before = ctx.state.step_count;
    const auto torque_before = ctx.stage_transport.torque_xyz_per_s;
    ctx.stepper.failure_injection.next =
        fullmag::fem::RkStepFailurePoint::AfterCandidateMagnetization;
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::run_backend_step(ctx, 0.19, stats, error) != FULLMAG_FEM_OK,
        "native RK transport failure fixture must fail");
    check(probe.rollback_count == 1u,
        "native RK failure must roll back the stage transport callback");
    check(probe.commit_count == 0u,
        "failed native RK transport attempt must not commit");
    check_vector_near(
        ctx.state.m_xyz,
        m_before,
        0.0,
        "stage transport native failure must preserve magnetization");
    check_near(
        ctx.state.current_time,
        time_before,
        0.0,
        "stage transport native failure must preserve time");
    check(
        ctx.state.step_count == step_before,
        "stage transport native failure must preserve step count");
    check_vector_near(
        ctx.stage_transport.torque_xyz_per_s,
        torque_before,
        0.0,
        "stage transport native failure must restore torque state");
    check(!ctx.stage_transport.stage_attempt_active,
        "failed stage transport callback attempt must close");
}

void gpu_requested_stage_transport_callback_fails_closed()
{
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    ctx.oersted = {};
    ctx.mfem_device.device_string_override = "cuda";
    StageTransportCallbackProbe probe;
    const auto callback = make_stage_transport_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_transport_stage_callback(ctx, &callback, error),
        error.c_str());
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_HEUN);
    fullmag_fem_step_stats stats{};
    check(
        !fullmag::fem::context_step_explicit_rk_mfem(
            ctx, tableau, 0.01, stats, error),
        "GPU-requested stage transport callback must fail closed");
    check(
        error.find("CPU-only stage transport callback") != std::string::npos,
        "GPU transport rejection must identify the missing device-resident lane");
    check(probe.begin_count == 0u && probe.evaluation_times.empty(),
        "GPU transport rejection must happen before any stage invocation");
}

void set_step_profile(fullmag::fem::Context &ctx, bool enabled) {
    ctx.gpu_state.rk_phase_timings.override_configured = true;
    ctx.gpu_state.rk_phase_timings.override_enabled = enabled;
}

double reference_oersted_scale(const fullmag::fem::Context &ctx, double time_s) {
    return ctx.oersted.current *
        (std::sin(
             2.0 * kPi * ctx.oersted.time_dep_freq * time_s +
             ctx.oersted.time_dep_phase) +
         ctx.oersted.time_dep_offset);
}

std::vector<double> reference_oersted_rhs(
    const fullmag::fem::Context &ctx,
    const std::vector<double> &m,
    double time_s)
{
    const double scale = reference_oersted_scale(ctx, time_s);
    const std::vector<double> h = {0.0, 0.0, scale};
    std::vector<double> rhs;
    double max_rhs = 0.0;
    fullmag::fem::llg_rhs_aos(
        m,
        h,
        ctx.material_fields.material.gyromagnetic_ratio,
        ctx.material_fields.material.damping,
        nullptr,
        ctx.base_plan.precession_enabled,
        rhs,
        max_rhs);
    return rhs;
}

std::vector<double> reference_oersted_rk_step(
    const fullmag::fem::Context &ctx,
    const fullmag::fem::ExplicitTableau &tableau,
    const std::vector<double> &m_initial,
    double time_initial,
    double dt)
{
    std::vector<std::vector<double>> stages(
        static_cast<size_t>(tableau.stages),
        std::vector<double>(m_initial.size(), 0.0));
    for (int stage = 0; stage < tableau.stages; ++stage) {
        std::vector<double> m_stage = m_initial;
        if (stage > 0) {
            for (size_t i = 0; i < m_stage.size(); ++i) {
                double increment = 0.0;
                for (int prior = 0; prior < stage; ++prior) {
                    increment += tableau.a[stage][prior] * stages[prior][i];
                }
                m_stage[i] += dt * increment;
            }
            fullmag::fem::normalize_aos_field(m_stage);
        }
        stages[stage] = reference_oersted_rhs(
            ctx,
            m_stage,
            time_initial + tableau.c[stage] * dt);
    }

    std::vector<double> accepted = m_initial;
    for (size_t i = 0; i < accepted.size(); ++i) {
        double increment = 0.0;
        for (int stage = 0; stage < tableau.stages; ++stage) {
            increment += tableau.b_hi[stage] * stages[stage][i];
        }
        accepted[i] += dt * increment;
    }
    fullmag::fem::normalize_aos_field(accepted);
    return accepted;
}

void executed_cpu_rk_steps_sample_all_stage_times_and_publish_endpoint_field() {
    for (const auto integrator : {
             FULLMAG_FEM_INTEGRATOR_HEUN,
             FULLMAG_FEM_INTEGRATOR_RK4,
             FULLMAG_FEM_INTEGRATOR_RK23_BS,
             FULLMAG_FEM_INTEGRATOR_RK45_DP54,
         }) {
        fullmag::fem::Context ctx;
        configure_oersted_only_rk_context(ctx, integrator);
        const auto &tableau = fullmag::fem::tableau_for_integrator(integrator);
        const double dt = 0.19;
        const double initial_time = ctx.state.current_time;
        const auto expected_m = reference_oersted_rk_step(
            ctx, tableau, ctx.state.m_xyz, initial_time, dt);

        fullmag_fem_step_stats stats{};
        std::string error;
        check(
            fullmag::fem::context_step_explicit_rk_mfem(ctx, tableau, dt, stats, error),
            error.c_str());
        check_vector_near(
            ctx.state.m_xyz,
            expected_m,
            2e-13,
            "executed CPU RK state must use every tableau evaluation time");
        const double accepted_time = initial_time + dt;
        check_near(ctx.state.current_time, accepted_time, 0.0, "accepted CPU RK time");
        check_near(stats.time_seconds, accepted_time, 0.0, "CPU RK stats accepted time");
        check(stats.step == 1u && ctx.state.step_count == 1u, "CPU RK accepted step count");
        check_near(
            ctx.effective_field.h_xyz[2],
            reference_oersted_scale(ctx, accepted_time),
            2e-14,
            "final H_eff must use the same accepted endpoint time as stats");
        const uint32_t expected_rhs =
            integrator == FULLMAG_FEM_INTEGRATOR_HEUN ? 3u :
            integrator == FULLMAG_FEM_INTEGRATOR_RK4 ? 5u :
            integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS ? 4u : 7u;
        check(stats.rhs_evaluations == expected_rhs, "CPU RK first-step RHS count");
        check(stats.fsal_reused == 0u, "CPU RK first step cannot reuse FSAL");
        const auto &endpoint = ctx.stepper.workspace.endpoint_telemetry;
        check(
            endpoint.accepted_step_wall_time_ns == stats.wall_time_ns &&
                endpoint.accepted_step_wall_time_ns > 0u,
            "CPU RK endpoint telemetry must publish accepted-step wall time");
        if (integrator == FULLMAG_FEM_INTEGRATOR_HEUN ||
            integrator == FULLMAG_FEM_INTEGRATOR_RK4) {
            check(
                endpoint.final_refresh_reason ==
                    fullmag::fem::RkFinalRefreshReason::NonFsalTableau,
                "non-FSAL tableau must report its explicit endpoint refresh reason");
            check(
                endpoint.endpoint_refreshes == 1u &&
                    endpoint.endpoint_cache_hits == 0u &&
                    endpoint.final_rhs_evaluations == 1u,
                "non-FSAL tableau must report one endpoint refresh and RHS evaluation");
        } else {
            check(
                endpoint.final_refresh_reason ==
                    fullmag::fem::RkFinalRefreshReason::CacheHit,
                "FSAL tableau must report an accepted endpoint cache hit");
            check(
                endpoint.endpoint_refreshes == 0u &&
                    endpoint.endpoint_cache_hits == 1u &&
                    endpoint.final_rhs_evaluations == 0u &&
                    endpoint.extra_poisson_solves == 0u,
                "FSAL tableau must avoid an extra endpoint RHS/Poisson solve");
            check(
                endpoint.cache_validity.state && endpoint.cache_validity.time &&
                    endpoint.cache_validity.dynamic_sources &&
                    endpoint.cache_validity.transport && endpoint.cache_validity.projection,
                "FSAL endpoint cache must satisfy every validity dimension");
        }
    }
}

void deterministic_oersted_fsal_requires_an_identical_next_source_state() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_RK23_BS);
    const double dt = 0.11;
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::context_step_explicit_rk_mfem(ctx, tableau, dt, stats, error),
        error.c_str());

    const double second_time = ctx.state.current_time;
    const auto expected_second = reference_oersted_rk_step(
        ctx, tableau, ctx.state.m_xyz, second_time, dt);
    check(
        fullmag::fem::context_step_explicit_rk_mfem(ctx, tableau, dt, stats, error),
        error.c_str());
    check(stats.fsal_reused == 1u, "deterministic Oersted endpoint may be reused by FSAL");
    check(
        ctx.stepper.workspace.endpoint_telemetry.final_refresh_reason ==
            fullmag::fem::RkFinalRefreshReason::CacheHit &&
            ctx.stepper.workspace.endpoint_telemetry.final_rhs_evaluations == 0u,
        "deterministic Oersted FSAL step must retain its endpoint cache");
    check_vector_near(ctx.state.m_xyz, expected_second, 2e-13, "FSAL Oersted second step");

    std::vector<double> uploaded = ctx.state.m_xyz;
    check(
        fullmag::fem::context_upload_magnetization_f64(
            ctx, uploaded.data(), static_cast<uint64_t>(uploaded.size()), error) ==
            FULLMAG_FEM_OK,
        error.c_str());
    check(!ctx.stepper.workspace.fsal_valid, "magnetization upload invalidates CPU FSAL source state");
    check(
        fullmag::fem::context_step_explicit_rk_mfem(ctx, tableau, dt, stats, error),
        error.c_str());
    check(stats.fsal_reused == 0u, "source-state mismatch must not report FSAL reuse");
}

void brown_thermal_final_rhs_uses_last_stage_without_fsal() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    ctx.mesh.node_volumes = {1.0e-27};
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.thermal_brown.temperature = 300.0;
    ctx.thermal_brown.seed = 1234u;
    fullmag::fem::initialize_thermal_brown_field(ctx);

    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_RK23_BS);
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::context_step_explicit_rk_mfem(ctx, tableau, 0.11, stats, error),
        error.c_str());

    check(stats.fsal_reused == 0u, "Brown thermal RHS must not reuse FSAL");
    const double first_stage_rhs = fullmag::fem::max_norm_aos(ctx.stepper.workspace.k[0]);
    const double last_stage_rhs = fullmag::fem::max_norm_aos(
        ctx.stepper.workspace.k[tableau.stages - 1]);
    check(
        std::fabs(first_stage_rhs - last_stage_rhs) > 1e-12,
        "Brown thermal fixture must distinguish first and last stage RHS");
    check_near(
        stats.max_rhs_amplitude,
        last_stage_rhs,
        std::max(1.0, last_stage_rhs) * 1e-14,
        "Brown thermal final stats must use the last stage RHS without FSAL");
    check(
        ctx.stepper.workspace.endpoint_telemetry.final_refresh_reason ==
            fullmag::fem::RkFinalRefreshReason::CacheHit &&
            ctx.stepper.workspace.endpoint_telemetry.final_rhs_evaluations == 0u &&
            ctx.stepper.workspace.endpoint_telemetry.cache_validity.dynamic_sources,
        "Brown thermal endpoint cache may serve the current interval but not next-step FSAL");
}

void cpu_fsal_endpoint_cache_requires_matching_candidate_state() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    ctx.oersted.has_cylinder = false;
    ctx.oersted.h_basis_per_ampere_xyz.clear();
    StageOerstedCallbackProbe probe;
    const auto callback = make_stage_oersted_probe_callback(probe);
    std::string error;
    check(
        fullmag::fem::configure_oersted_stage_callback(ctx, &callback, error),
        error.c_str());

    auto injected = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_RK23_BS);
    injected.b_hi[0] += 0.5;
    fullmag_fem_step_stats stats{};
    check(
        fullmag::fem::context_step_explicit_rk_mfem(ctx, injected, 0.19, stats, error),
        error.c_str());

    check(stats.fsal_reused == 0u, "mismatched endpoint state must not report FSAL reuse");
    check(!ctx.stepper.workspace.fsal_valid, "mismatched endpoint state must invalidate FSAL");
    check(
        ctx.stepper.workspace.endpoint_telemetry.final_refresh_reason ==
            fullmag::fem::RkFinalRefreshReason::CandidateStateMismatch &&
            ctx.stepper.workspace.endpoint_telemetry.endpoint_refreshes == 1u &&
            ctx.stepper.workspace.endpoint_telemetry.final_rhs_evaluations == 1u,
        "mismatched endpoint must report one explicit refresh and final RHS evaluation");
    check(
        probe.evaluation_times.size() == static_cast<size_t>(injected.stages + 1),
        "mismatched endpoint state must trigger one endpoint field refresh");
    check(
        (probe.stage_identities.back() & 0xffffu) == 0xffffu,
        "mismatched endpoint refresh must use the reserved endpoint identity");
}

void gpu_requested_oersted_only_step_rejects_host_rk_fallback() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    ctx.mfem_device.device_string_override = "cuda";
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_HEUN);
    fullmag_fem_step_stats stats{};
    std::string error;

    const bool step_ok = fullmag::fem::context_step_explicit_rk_mfem(
        ctx, tableau, 0.01, stats, error);

    check(!step_ok, "GPU-requested Oersted-only step must fail when GPU RK plan is disabled");
    check(
        error.find("GPU RK plan is disabled") != std::string::npos &&
            error.find("allocated FemGpuState") != std::string::npos,
        "GPU-requested Oersted-only step must report the disabled GPU plan prerequisite");
}

void rejected_cpu_retry_rolls_back_and_reports_only_accepted_attempt_fsal() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
    set_step_profile(ctx, true);
    const auto &tableau = fullmag::fem::tableau_for_integrator(
        FULLMAG_FEM_INTEGRATOR_RK23_BS);
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::context_step_explicit_rk_mfem(ctx, tableau, 0.05, stats, error),
        error.c_str());
    check(ctx.stepper.workspace.fsal_valid, "accepted RK23 step seeds CPU FSAL cache");

    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.atol = 1e-10;
    ctx.adaptive_dt.rtol = 1e-10;
    ctx.adaptive_dt.dt_min = 1e-9;
    ctx.adaptive_dt.dt_max = 1.0;
    ctx.adaptive_dt.safety_factor = 0.8;
    ctx.adaptive_dt.dt_grow_max = 2.0;
    ctx.adaptive_dt.dt_shrink_min = 0.2;
    ctx.adaptive_dt.max_reject = 30;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.demag.cached_xyz = {31.0, 32.0, 33.0};
    ctx.demag.cached_visual_xyz = {34.0, 35.0, 36.0};
    ctx.demag.cache_valid = true;
    ctx.demag.last_refresh_time = 0.0125;
    const auto demag_cache_before = ctx.demag.cached_xyz;
    const auto demag_visual_cache_before = ctx.demag.cached_visual_xyz;
    const double proposed_dt = 0.8;
    ctx.base_plan.dt_seconds = proposed_dt;

    const std::vector<double> m_before = ctx.state.m_xyz;
    const double time_before = ctx.state.current_time;
    const uint64_t step_before = ctx.state.step_count;
    ctx.stepper.transaction_telemetry = {};
    check(
        fullmag::fem::context_step_explicit_rk_mfem(
            ctx, tableau, proposed_dt, stats, error),
        error.c_str());
    check(stats.rejected_attempts > 0u, "adaptive CPU RK fixture must reject its first attempt");
    check(
        ctx.stepper.attempt_trace.records.size() ==
            static_cast<size_t>(stats.rejected_attempts + 1u),
        "adaptive CPU RK must publish exactly one trace record per attempted step");
    check(
        ctx.stepper.transaction_telemetry.attempt_cache_capture_count ==
            ctx.stepper.attempt_trace.records.size(),
        "adaptive CPU RK must capture one cache snapshot per attempted step");
    check(
        ctx.stepper.transaction_telemetry.attempt_cache_restore_count ==
            stats.rejected_attempts,
        "adaptive CPU RK must restore one cache snapshot per rejected attempt");
    check(
        ctx.stepper.transaction_telemetry.attempt_cache_snapshot_payload_bytes > 0u,
        "adaptive CPU RK must report cache snapshot payload bytes");
    check(
        ctx.stepper.transaction_telemetry.attempt_cache_restore_payload_bytes > 0u,
        "adaptive CPU RK retries must report restored cache payload bytes");
    for (size_t attempt = 0; attempt < ctx.stepper.attempt_trace.records.size(); ++attempt) {
        const auto &record = ctx.stepper.attempt_trace.records[attempt];
        check(record.attempt == attempt, "adaptive CPU RK trace attempt indices must be contiguous");
        check(record.target_step == step_before + 1u, "all retry records must target one accepted step");
        check(record.time_seconds == time_before, "retry records must retain the pre-step time");
        check(record.dt_attempt_seconds > 0.0, "attempt trace dt must be positive");
        check(record.estimator_order == tableau.order_est, "attempt trace must publish estimator order");
        check(
            record.decision == (attempt + 1u == ctx.stepper.attempt_trace.records.size()
                ? fullmag::fem::RkAttemptDecision::Accepted
                : fullmag::fem::RkAttemptDecision::Retry),
            "adaptive CPU RK trace must end in one accepted decision after its retries");
    }
    check(
        stats.fsal_reused == 0u,
        "accepted retry must not report FSAL reused by the rejected attempt");
    check(ctx.state.step_count == step_before + 1u, "rejected attempts must not advance step count");
    check_near(
        ctx.state.current_time,
        time_before + stats.dt_seconds,
        2e-16,
        "rejected attempts must not advance committed time");
    check_near(
        stats.time_seconds,
        ctx.state.current_time,
        0.0,
        "accepted retry stats time must match committed state time");
    const auto expected_m = reference_oersted_rk_step(
        ctx, tableau, m_before, time_before, stats.dt_seconds);
    check_vector_near(
        ctx.state.m_xyz,
        expected_m,
        2e-12,
        "accepted retry must start from the pre-attempt magnetization");
    check_vector_near(
        ctx.demag.cached_xyz,
        demag_cache_before,
        0.0,
        "rejected retry must not publish a demag field cache");
    check_vector_near(
        ctx.demag.cached_visual_xyz,
        demag_visual_cache_before,
        0.0,
        "rejected retry must not publish a visual demag cache");
    check_near(
        ctx.demag.last_refresh_time,
        0.0125,
        0.0,
        "rejected retry must preserve the accepted demag cache timestamp");
}

void cpu_rk_guard_failures_preserve_committed_state() {
    const auto assert_unchanged = [](const fullmag::fem::Context &ctx,
                                     const std::vector<double> &m_before,
                                     double time_before,
                                     uint64_t step_before,
                                     const char *message) {
        check_vector_near(ctx.state.m_xyz, m_before, 0.0, message);
        check_near(ctx.state.current_time, time_before, 0.0, message);
        check(ctx.state.step_count == step_before, message);
    };

    for (bool rotation_guard : {false, true}) {
        fullmag::fem::Context ctx;
        configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK23_BS);
        const auto &tableau = fullmag::fem::tableau_for_integrator(
            FULLMAG_FEM_INTEGRATOR_RK23_BS);
        ctx.adaptive_dt.enabled = true;
        ctx.adaptive_dt.atol = 1.0;
        ctx.adaptive_dt.rtol = 0.0;
        ctx.adaptive_dt.dt_min = 0.2;
        ctx.adaptive_dt.dt_max = 0.2;
        ctx.adaptive_dt.safety_factor = 0.9;
        ctx.adaptive_dt.dt_grow_max = 2.0;
        ctx.adaptive_dt.dt_shrink_min = 0.2;
        ctx.adaptive_dt.max_reject = 2;
        ctx.adaptive_dt.has_max_spin_rotation = rotation_guard;
        ctx.adaptive_dt.max_spin_rotation = 1.0e-12;
        ctx.adaptive_dt.has_norm_tolerance = !rotation_guard;
        ctx.adaptive_dt.norm_tolerance = 1.0e-16;
        const auto m_before = ctx.state.m_xyz;
        const double time_before = ctx.state.current_time;
        const uint64_t step_before = ctx.state.step_count;
        fullmag_fem_step_stats stats{};
        std::string error;
        check(
            !fullmag::fem::context_step_explicit_rk_mfem(
                ctx, tableau, 0.2, stats, error),
            "production CPU RK guard must reject at dt_min");
        check(!error.empty(), "production CPU RK guard failure must carry a reason");
        assert_unchanged(
            ctx,
            m_before,
            time_before,
            step_before,
            rotation_guard ? "rotation guard rollback" : "norm guard rollback");
    }

    const auto &rk4 = fullmag::fem::tableau_for_integrator(FULLMAG_FEM_INTEGRATOR_RK4);
    for (int invalid_stage = 1; invalid_stage < rk4.stages; ++invalid_stage) {
        fullmag::fem::Context ctx;
        configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
        auto injected = rk4;
        injected.a[invalid_stage][0] = std::numeric_limits<double>::infinity();
        const auto m_before = ctx.state.m_xyz;
        const double time_before = ctx.state.current_time;
        const uint64_t step_before = ctx.state.step_count;
        fullmag_fem_step_stats stats{};
        std::string error;
        check(
            !fullmag::fem::context_step_explicit_rk_mfem(
                ctx, injected, 0.2, stats, error),
            "nonfinite intermediate RK stage must fail closed");
        assert_unchanged(
            ctx, m_before, time_before, step_before, "intermediate-stage rollback");
    }

    fullmag::fem::Context ctx;

    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK4);
    auto injected = rk4;
    injected.b_hi[0] = std::numeric_limits<double>::quiet_NaN();
    const auto m_before = ctx.state.m_xyz;
    const double time_before = ctx.state.current_time;
    const uint64_t step_before = ctx.state.step_count;
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        !fullmag::fem::context_step_explicit_rk_mfem(ctx, injected, 0.2, stats, error),
        "nonfinite high-order RK candidate must fail closed");
    assert_unchanged(ctx, m_before, time_before, step_before, "high-order rollback");
}

struct PublishedRkStateSnapshot {
    fullmag::fem::FemBasePlanRuntimeState base_plan;
    fullmag::fem::AdaptiveDtRuntimeState adaptive_dt;
    fullmag::fem::FemStateRuntimeState state;
    fullmag::fem::ExchangeRuntimeState exchange;
    fullmag::fem::DemagRuntimeState demag;
    fullmag::fem::EffectiveFieldRuntimeState effective_field;
    fullmag::fem::AnisotropyRuntimeState anisotropy;
    fullmag::fem::DmiRuntimeState dmi;
    fullmag::fem::ZeemanRuntimeState zeeman;
    fullmag::fem::OerstedRuntimeState oersted;
    fullmag::fem::TransportStageRuntimeState stage_transport;
    fullmag::fem::ThermalBrownRuntimeState thermal;
    bool fsal_valid = false;
    std::vector<double> fsal_k0;
    uint64_t demag_solves_current_step = 0;
    uint64_t transfer_host_to_device = 0;
    uint64_t transfer_device_to_host = 0;
};

PublishedRkStateSnapshot capture_published_rk_state(
    const fullmag::fem::Context &ctx)
{
    return {
        ctx.base_plan,
        ctx.adaptive_dt,
        ctx.state,
        ctx.exchange,
        ctx.demag,
        ctx.effective_field,
        ctx.anisotropy,
        ctx.dmi,
        ctx.zeeman,
        ctx.oersted,
        ctx.stage_transport,
        ctx.thermal_brown,
        ctx.stepper.workspace.fsal_valid,
        ctx.stepper.workspace.k[0],
        ctx.poisson_demag.solves_current_step,
        ctx.transfer_audit.audit.counters.h2d_bytes,
        ctx.transfer_audit.audit.counters.d2h_bytes,
    };
}

void assert_published_rk_state_equal(
    const fullmag::fem::Context &ctx,
    const PublishedRkStateSnapshot &before,
    const char *label)
{
    check_vector_near(ctx.state.m_xyz, before.state.m_xyz, 0.0, label);
    check(ctx.state.step_count == before.state.step_count, label);
    check_near(ctx.state.current_time, before.state.current_time, 0.0, label);
    check_near(ctx.base_plan.dt_seconds, before.base_plan.dt_seconds, 0.0, label);
    check_near(ctx.adaptive_dt.current_dt, before.adaptive_dt.current_dt, 0.0, label);
    check_near(ctx.adaptive_dt.prev_error_norm, before.adaptive_dt.prev_error_norm, 0.0, label);
    check(ctx.adaptive_dt.has_prev_error_norm == before.adaptive_dt.has_prev_error_norm, label);
    check(ctx.adaptive_dt.rejected_steps == before.adaptive_dt.rejected_steps, label);
    check_vector_near(ctx.exchange.h_xyz, before.exchange.h_xyz, 0.0, label);
    check(ctx.exchange.mfem.ready == before.exchange.mfem.ready, label);
    check_vector_near(ctx.demag.h_xyz, before.demag.h_xyz, 0.0, label);
    check_vector_near(ctx.demag.h_visual_xyz, before.demag.h_visual_xyz, 0.0, label);
    check_vector_near(ctx.demag.cached_xyz, before.demag.cached_xyz, 0.0, label);
    check_vector_near(ctx.demag.cached_visual_xyz, before.demag.cached_visual_xyz, 0.0, label);
    check(ctx.demag.cache_valid == before.demag.cache_valid, label);
    check(ctx.demag.call_count == before.demag.call_count, label);
    check_near(ctx.demag.last_refresh_time, before.demag.last_refresh_time, 0.0, label);
    check_vector_near(ctx.effective_field.h_xyz, before.effective_field.h_xyz, 0.0, label);
    check_vector_near(ctx.effective_field.h_visual_xyz, before.effective_field.h_visual_xyz, 0.0, label);
    check_vector_near(ctx.anisotropy.h_uniaxial_xyz, before.anisotropy.h_uniaxial_xyz, 0.0, label);
    check_vector_near(ctx.dmi.h_interfacial_xyz, before.dmi.h_interfacial_xyz, 0.0, label);
    check_vector_near(ctx.zeeman.h_drive_xyz, before.zeeman.h_drive_xyz, 0.0, label);
    check_near(ctx.zeeman.last_evaluation_time_s, before.zeeman.last_evaluation_time_s, 0.0, label);
    check_vector_near(ctx.oersted.h_xyz, before.oersted.h_xyz, 0.0, label);
    check(ctx.stage_transport.has_stage_callback == before.stage_transport.has_stage_callback, label);
    check_vector_near(
        ctx.stage_transport.torque_xyz_per_s,
        before.stage_transport.torque_xyz_per_s,
        0.0,
        label);
    check(ctx.stage_transport.stage_identity == before.stage_transport.stage_identity, label);
    check(
        ctx.stage_transport.stage_source_state_revision ==
            before.stage_transport.stage_source_state_revision,
        label);
    check(
        ctx.stage_transport.stage_attempt_active ==
            before.stage_transport.stage_attempt_active,
        label);
    check_vector_near(ctx.thermal_brown.h_xyz, before.thermal.h_xyz, 0.0, label);
    check(ctx.stepper.workspace.fsal_valid == before.fsal_valid, label);
    check_vector_near(ctx.stepper.workspace.k[0], before.fsal_k0, 0.0, label);
    check(ctx.poisson_demag.solves_current_step == before.demag_solves_current_step, label);
    check(
        ctx.transfer_audit.audit.counters.h2d_bytes ==
            before.transfer_host_to_device,
        label);
    check(
        ctx.transfer_audit.audit.counters.d2h_bytes ==
            before.transfer_device_to_host,
        label);
}

void cpu_rk_failure_injection_rolls_back_complete_published_state() {
    for (const auto failpoint : {
             fullmag::fem::RkStepFailurePoint::AfterCandidateMagnetization,
             fullmag::fem::RkStepFailurePoint::DuringFinalFieldRefresh,
             fullmag::fem::RkStepFailurePoint::DuringFinalStatistics,
         }) {
        fullmag::fem::Context ctx;
        configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK45_DP54);
        set_step_profile(ctx, true);
        fullmag::fem::stepper_workspace_allocate(ctx.stepper.workspace, 3u, 7);
        ctx.stepper.workspace.fsal_valid = true;
        ctx.stepper.workspace.k[0] = {1.0, 2.0, 3.0};
        ctx.base_plan.dt_seconds = 0.125;
        ctx.adaptive_dt.current_dt = 0.125;
        ctx.adaptive_dt.prev_error_norm = 0.75;
        ctx.adaptive_dt.has_prev_error_norm = true;
        ctx.demag.cached_xyz = {4.0, 5.0, 6.0};
        ctx.demag.cached_visual_xyz = {7.0, 8.0, 9.0};
        ctx.demag.cache_valid = true;
        ctx.demag.call_count = 11;
        ctx.effective_field.h_visual_xyz = {10.0, 11.0, 12.0};
        ctx.poisson_demag.solves_current_step = 13;
        ctx.transfer_audit.audit.counters.h2d_bytes = 17;
        ctx.transfer_audit.audit.counters.d2h_bytes = 19;
        const auto before = capture_published_rk_state(ctx);
        ctx.stepper.failure_injection.next = failpoint;

        fullmag_fem_step_stats stats{};
        std::string error;
        const int status = fullmag::fem::run_backend_step(ctx, 0.125, stats, error);
        check(status != FULLMAG_FEM_OK, "injected RK failure must fail the backend step");
        check(!error.empty(), "injected RK failure must publish a reason");
        check(ctx.stepper.failure_injection.injected_count == 1u,
              "configured RK failpoint must execute exactly once");
        assert_published_rk_state_equal(ctx, before, "complete RK transaction rollback");
        const auto &telemetry = ctx.stepper.transaction_telemetry;
        check(telemetry.step_transaction_begin_count == 1u,
              "failed RK step must report one outer transaction begin");
        check(telemetry.step_transaction_commit_count == 0u,
              "failed RK step must not report a transaction commit");
        check(telemetry.step_transaction_rollback_count == 1u,
              "failed RK step must report one transaction rollback");
        check(stats.rk_transaction_rollback_count == 1u,
              "public failed RK stats must include the transaction rollback");
        check(telemetry.step_transaction_host_snapshot_payload_bytes > 0u,
              "failed RK step must report host snapshot payload bytes");
        check(
            telemetry.step_transaction_host_restore_payload_bytes ==
                telemetry.step_transaction_host_snapshot_payload_bytes,
            "outer RK rollback must report the restored host snapshot payload");
        check(telemetry.step_transaction_device_snapshot_payload_bytes == 0u,
              "CPU RK transaction must not report a device snapshot payload");
        check(telemetry.step_transaction_device_restore_payload_bytes == 0u,
              "CPU RK transaction must not report a device restore payload");
    }
}

void cpu_sot_pulse_failure_rollback_preserves_event_knot() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    ctx.oersted = {};
    ctx.state.current_time = 0.0;
    ctx.state.step_count = 0;
    ctx.sot.enabled = true;
    ctx.sot.formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    ctx.sot.current_density_am2 = 1.0e11;
    ctx.sot.xi_dl = 0.12;
    ctx.sot.xi_fl = -0.02;
    ctx.sot.thickness = 1.5e-9;
    ctx.sot.envelope_kind = FULLMAG_FEM_TIME_PULSE;
    ctx.sot.envelope_time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
    ctx.sot.envelope_amplitude = 1.0;
    ctx.sot.envelope_t_on_s = 1.0e-9;
    ctx.sot.envelope_t_off_s = 2.0e-9;
    ctx.sot.sigma = {0.0, 1.0, 0.0};
    ctx.material_fields.material.saturation_magnetisation = 800.0e3;

    const std::vector<double> initial_m = ctx.state.m_xyz;
    const double initial_time = ctx.state.current_time;
    const uint64_t initial_step = ctx.state.step_count;
    ctx.stepper.failure_injection.next =
        fullmag::fem::RkStepFailurePoint::AfterCandidateMagnetization;

    fullmag_fem_step_stats stats{};
    std::string error;
    const int failed_status = fullmag::fem::run_backend_step(
        ctx, 1.5e-9, stats, error);
    check(failed_status != FULLMAG_FEM_OK,
          "SOT pulse injected failure must fail the FEM backend step");
    check(!error.empty(), "SOT pulse injected failure must carry a reason");
    check(ctx.stepper.failure_injection.injected_count == 1u,
          "SOT pulse failpoint must execute exactly once");
    check_vector_near(
        ctx.state.m_xyz, initial_m, 0.0,
        "SOT pulse rollback must restore magnetization before event knot");
    check_near(
        ctx.state.current_time, initial_time, 0.0,
        "SOT pulse rollback must restore time before event knot");
    check(ctx.state.step_count == initial_step,
          "SOT pulse rollback must restore step index before event knot");

    ctx.stepper.failure_injection.next = fullmag::fem::RkStepFailurePoint::None;
    stats = {};
    error.clear();
    check(
        fullmag::fem::run_backend_step(ctx, 1.5e-9, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check_near(
        ctx.state.current_time, 1.0e-9, 1.0e-21,
        "retry after SOT rollback must stop exactly at pulse onset");
    check_near(
        stats.dt_seconds, 1.0e-9, 1.0e-21,
        "retry after SOT rollback must publish clipped pulse-onset dt");

    stats = {};
    error.clear();
    check(
        fullmag::fem::run_backend_step(ctx, 1.5e-9, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check_near(
        ctx.state.current_time, 2.0e-9, 1.0e-21,
        "second SOT pulse step must stop exactly at pulse offset");
    check_near(
        stats.dt_seconds, 1.0e-9, 1.0e-21,
        "second SOT pulse step must publish clipped pulse-offset dt");

    stats = {};
    error.clear();
    check(
        fullmag::fem::run_backend_step(ctx, 1.5e-9, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check_near(
        ctx.state.current_time, 3.5e-9, 1.0e-21,
        "post-pulse SOT step must resume the requested dt");
    check_near(
        stats.dt_seconds, 1.5e-9, 1.0e-21,
        "post-pulse SOT step must publish the unclipped dt");
}

void cpu_sot_pulse_energy_rejection_rolls_back_at_event_knot() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_HEUN);
    ctx.oersted = {};
    ctx.state.current_time = 1.0e-9;
    ctx.state.step_count = 0;
    ctx.base_plan.dt_seconds = 1.5e-9;
    ctx.adaptive_dt.current_dt = 1.5e-9;
    ctx.adaptive_dt.dt_min = 1.0e-9;
    ctx.adaptive_dt.max_reject = 2;
    ctx.sot.enabled = true;
    ctx.sot.formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    ctx.sot.current_density_am2 = 1.0e11;
    ctx.sot.xi_dl = 0.12;
    ctx.sot.xi_fl = -0.02;
    ctx.sot.thickness = 1.5e-9;
    ctx.sot.envelope_kind = FULLMAG_FEM_TIME_PULSE;
    ctx.sot.envelope_time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
    ctx.sot.envelope_amplitude = 1.0;
    ctx.sot.envelope_t_on_s = 1.0e-9;
    ctx.sot.envelope_t_off_s = 2.0e-9;
    ctx.sot.sigma = {0.0, 1.0, 0.0};
    ctx.material_fields.material.saturation_magnetisation = 800.0e3;
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 1.0e-30;
    ctx.stage_completion.relax_previous_total_energy_valid = true;
    ctx.stage_completion.relax_previous_total_energy_j = -1.0e30;

    const std::vector<double> initial_m = ctx.state.m_xyz;
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::run_backend_step(ctx, 1.5e-9, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check_vector_near(
        ctx.state.m_xyz, initial_m, 0.0,
        "energy-rejected SOT pulse must restore magnetization at event knot");
    check_near(
        ctx.state.current_time, 1.0e-9, 0.0,
        "energy-rejected SOT pulse must restore time at event knot");
    check(
        ctx.state.step_count == 0u,
        "energy-rejected SOT pulse must restore step index at event knot");
    check(
        ctx.stage_completion.relax_energy_window_count == 0u,
        "energy-rejected SOT pulse must not publish a plateau sample");
    check(
        ctx.stage_completion.relax_energy_rejected_attempts == 1u,
        "energy-rejected SOT pulse must count one rejected event-knot attempt");
    check(
        stats.rejected_attempts == 1u,
        "public stats must expose the rejected SOT event-knot attempt");
    check(
        ctx.stage_completion.snapshot.has_reason == 1 &&
            ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
        "energy-rejected SOT pulse must stop explicitly at controller floor");
}

void cpu_rk_success_commits_state_and_completion_once() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK45_DP54);
    set_step_profile(ctx, true);
    ctx.stage_completion.relax_stop.has_max_steps = 1;
    ctx.stage_completion.relax_stop.max_steps = 100;
    const uint64_t step_before = ctx.state.step_count;
    const double time_before = ctx.state.current_time;
    const uint32_t completion_samples_before = ctx.stage_completion.relax_energy_window_count;
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::run_backend_step(ctx, 0.125, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check(ctx.state.step_count == step_before + 1u, "successful RK step commits one index");
    check_near(ctx.state.current_time, time_before + 0.125, 0.0, "successful RK time commit");
    check(stats.step == ctx.state.step_count, "successful RK stats match committed step");
    check(
        ctx.stage_completion.relax_energy_window_count == completion_samples_before + 1u,
        "successful RK telemetry publishes one completion sample");
    const auto &telemetry = ctx.stepper.transaction_telemetry;
    check(telemetry.step_transaction_begin_count == 1u,
          "successful RK step must report one outer transaction begin");
    check(telemetry.step_transaction_commit_count == 1u,
          "successful RK step must report one outer transaction commit");
    check(telemetry.step_transaction_rollback_count == 0u,
          "successful RK step must not report a transaction rollback");
    check(stats.rk_transaction_commit_count == 1u,
          "public successful RK stats must include the committed transaction");
    check(stats.rk_transaction_rollback_count == 0u,
          "public successful RK stats must include zero transaction rollbacks");
    check(telemetry.step_transaction_host_snapshot_payload_bytes > 0u,
          "successful RK step must report host snapshot payload bytes");
    check(telemetry.step_transaction_host_restore_payload_bytes == 0u,
          "successful RK step must not report restored host payload bytes");
    check(
        telemetry.step_transaction_host_capture_wall_time_ns <=
            telemetry.step_transaction_begin_wall_time_ns,
        "host snapshot time must be a bounded part of transaction begin time");
}

void profiler_off_does_not_collect_rk_transaction_telemetry() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK45_DP54);
    set_step_profile(ctx, false);
    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::run_backend_step(ctx, 0.125, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    const auto &telemetry = ctx.stepper.transaction_telemetry;
    check(telemetry.step_transaction_begin_count == 0u,
          "profiler-off RK must not count transaction captures");
    check(telemetry.step_transaction_commit_count == 0u,
          "profiler-off RK must not count transaction commits");
    check(telemetry.step_transaction_rollback_count == 0u,
          "profiler-off RK must not count transaction rollbacks");
    check(telemetry.step_transaction_host_snapshot_payload_bytes == 0u,
          "profiler-off RK must not calculate host snapshot payload bytes");
    check(telemetry.attempt_cache_snapshot_payload_bytes == 0u,
          "profiler-off RK must not calculate attempt-cache payload bytes");
}

void cpu_relaxation_energy_rejection_rolls_back_until_stagnation() {
    fullmag::fem::Context ctx;
    configure_oersted_only_rk_context(ctx, FULLMAG_FEM_INTEGRATOR_RK45_DP54);
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 1.0e-30;
    ctx.stage_completion.relax_previous_total_energy_valid = true;
    ctx.stage_completion.relax_previous_total_energy_j = -1.0e30;
    ctx.adaptive_dt.max_reject = 2;
    ctx.adaptive_dt.dt_min = 1.0e-16;
    const auto before = capture_published_rk_state(ctx);

    fullmag_fem_step_stats stats{};
    std::string error;
    check(
        fullmag::fem::run_backend_step(ctx, 0.125, stats, error) == FULLMAG_FEM_OK,
        error.c_str());
    check(ctx.state.step_count == before.state.step_count, "energy rejection keeps step index");
    check_near(ctx.state.current_time, before.state.current_time, 0.0, "energy rejection keeps time");
    check_vector_near(ctx.state.m_xyz, before.state.m_xyz, 0.0, "energy rejection restores magnetization");
    check(ctx.stage_completion.relax_energy_window_count == 0, "rejected energy never enters plateau window");
    check(ctx.stage_completion.relax_energy_rejected_attempts == 3, "energy retries are counted");
    check(stats.rejected_attempts == 3, "energy retries reach public step stats");
    check(ctx.stage_completion.snapshot.has_reason == 1, "exhausted energy retries stop explicitly");
    check(
        ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
        "exhausted energy retries are numerical stagnation");
}
#endif

void gpu_rk_call_path_uses_each_tableau_time_and_invalidates_rejected_fsal() {
    const auto root = fem_source_root() / "gpu" / "cuda" / "integrators" / "rk";
    const std::string gpu_rk_workspace = read_text_file(root / "rk_workspace_memory.cpp");
    const std::string gpu_device_memory = read_text_file(
        fem_source_root() / "gpu" / "cuda" / "state" / "device_memory.cpp");
    const std::string setup = read_text_file(root / "rk_attempt_setup.cu");
    const std::string rk4 = read_text_file(root / "rk4_stage_sequence.cu");
    const std::string rk23 = read_text_file(root / "rk23_stage_sequence.cu");
    const std::string rk23_k3 = read_text_file(root / "rk23_adaptive_k3.cu");
    const std::string rk45 = read_text_file(root / "rk45_stage_sequence.cu");
    const std::string attempt_loop = read_text_file(root / "rk_attempt_loop.cu");
    const std::string adaptive = read_text_file(root / "rk_adaptive_runtime.cu");
    const std::string final_refresh = read_text_file(root / "rk_final_refresh.cu");
    const std::string stage_schedule = read_text_file(root / "rk_stage_schedule.cu");
    const std::string backend_step = read_text_file(
        fem_source_root() / "cpu" / "mfem" / "runtime" / "backend_step.cpp");

    check(
        gpu_device_memory.find("bool gpu_device_zero_component(") != std::string::npos,
        "GPU device-memory module must own the component zero-fill helper");
    check(
        gpu_rk_workspace.find("gpu_device_zero_component(rk.k[stage]") != std::string::npos,
        "GPU RK workspace must initialize every stage buffer before weighted predictors");

    check(setup.find("ctx.state.current_time,") != std::string::npos,
          "GPU RK stage 0 must use t_n");
    check(
        setup.find("ctx.state.current_time + (is_heun ? 1.0 : (is_rk45 ? 0.2 : 0.5)) * active_dt") !=
            std::string::npos,
        "GPU Heun/RK4/RK23/RK45 common stage 1 must use its exact c_1");
    check(rk4.find("ctx.state.current_time + 0.5 * active_dt") != std::string::npos,
          "GPU RK4 stage 2 must use c=1/2");
    check(rk4.find("ctx.state.current_time + active_dt") != std::string::npos,
          "GPU RK4 stage 3 must use c=1");
    check(rk23.find("ctx.state.current_time + 0.75 * active_dt") != std::string::npos,
          "GPU RK23 stage 2 must use c=3/4");
    check(
        attempt_loop.find("ctx.adaptive_dt.current_dt = active_dt") != std::string::npos &&
            rk23_k3.find("ctx.state.current_time + ctx.adaptive_dt.current_dt") !=
                std::string::npos,
        "GPU adaptive RK23 endpoint/error stage must use the active retry endpoint");
    for (const char *time_expression : {
             "ctx.state.current_time + 0.3 * active_dt",
             "ctx.state.current_time + 0.8 * active_dt",
             "ctx.state.current_time + (8.0 / 9.0) * active_dt",
         }) {
        check(rk45.find(time_expression) != std::string::npos,
              "GPU RK45 internal stage must use its exact tableau abscissa");
    }
    check(
        rk45.find("ctx.state.current_time + active_dt") != std::string::npos &&
            rk45.find("ctx.state.current_time + active_dt", rk45.find("ctx.state.current_time + active_dt") + 1u) !=
                std::string::npos,
        "GPU RK45 must evaluate both c=1 endpoint stages at t_n+dt");
    check(
        final_refresh.find("ctx.state.current_time + active_dt") != std::string::npos,
        "GPU final H_eff refresh must precede accepted-time commit at t_n+dt");
    check(
        attempt_loop.find("gpu_rk_restore_adaptive_reject_magnetization_device") !=
                std::string::npos &&
            adaptive.find("gpu.rk.fsal_valid = false") != std::string::npos,
        "GPU adaptive rejection must restore m and invalidate FSAL before retry");
    check(
        stage_schedule.find("RkStepFailurePoint::AfterCandidateMagnetization") !=
            std::string::npos,
        "GPU RK production path must expose the post-candidate atomicity failpoint");
    check(
        final_refresh.find("RkStepFailurePoint::DuringFinalFieldRefresh") !=
            std::string::npos,
        "GPU RK production path must expose the final-refresh atomicity failpoint");
    check(
            backend_step.find("RkStepFailurePoint::DuringFinalStatistics") !=
                std::string::npos &&
            backend_step.find("RkStepTransaction transaction(ctx)") !=
                std::string::npos,
        "backend step must keep the transaction open through final statistics");
}

void gpu_requested_rk_never_falls_through_to_host_stepper() {
    const auto source = read_text_file(
        fem_source_root() / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");

    check(
        source.find("#include \"cpu/mfem/runtime/mfem_device.hpp\"") != std::string::npos,
        "explicit RK owner must inspect the resolved MFEM device request");
    check(
        source.find("if (mfem_device_requests_gpu(ctx))") != std::string::npos &&
            source.find("GPU RK plan is disabled") != std::string::npos,
        "a GPU-requested native step must fail closed when its GPU RK plan is disabled");
}

} // namespace

int main() {
    rk_workspace_is_owned_by_integrator_module();
    integrator_source_files_document_module_boundaries();
    integrator_headers_document_module_boundaries();
    workspace_reallocates_when_stage_count_grows();
    workspace_invalidates_fsal_when_stage_count_shrinks();
    workspace_allocates_common_buffers();
    endpoint_cache_telemetry_has_explicit_validity_dimensions();
    rk_transaction_payload_inventory_covers_owned_vectors();
    fsal_reuse_requires_matching_source_state();
    rk_rhs_passes_explicit_stage_and_endpoint_times();
    gpu_rk_call_path_uses_each_tableau_time_and_invalidates_rejected_fsal();
    gpu_requested_rk_never_falls_through_to_host_stepper();
#if FULLMAG_HAS_MFEM_STACK
    executed_cpu_rk_steps_sample_all_stage_times_and_publish_endpoint_field();
    deterministic_oersted_fsal_requires_an_identical_next_source_state();
    brown_thermal_final_rhs_uses_last_stage_without_fsal();
    cpu_fsal_endpoint_cache_requires_matching_candidate_state();
    cpu_stage_oersted_callback_samples_exact_stages_and_commits();
    cpu_stage_oersted_callback_rolls_back_adaptive_retries();
    cpu_stage_oersted_callback_rolls_back_native_failure();
    gpu_requested_stage_oersted_callback_fails_closed();
    cpu_stage_transport_callback_samples_exact_stages_and_commits();
    cpu_stage_transport_callback_rolls_back_adaptive_retries();
    cpu_stage_transport_callback_rolls_back_native_failure();
    gpu_requested_stage_transport_callback_fails_closed();
    gpu_requested_oersted_only_step_rejects_host_rk_fallback();
    rejected_cpu_retry_rolls_back_and_reports_only_accepted_attempt_fsal();
    cpu_rk_guard_failures_preserve_committed_state();
    cpu_rk_failure_injection_rolls_back_complete_published_state();
    cpu_sot_pulse_failure_rollback_preserves_event_knot();
    cpu_sot_pulse_energy_rejection_rolls_back_at_event_knot();
    cpu_rk_success_commits_state_and_completion_once();
    profiler_off_does_not_collect_rk_transaction_telemetry();
    cpu_relaxation_energy_rejection_rolls_back_until_stagnation();
#endif
    return 0;
}
