/*
 * rk_explicit_contract.cpp - native FEM explicit Runge-Kutta workspace contracts.
 */

#include "context.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_explicit_step.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

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

fullmag::fem::Context make_oersted_only_rk_context(fullmag_fem_integrator integrator) {
    fullmag::fem::Context ctx;
    ctx.mfem_context.ready = true;
    ctx.mesh.n_nodes = 1;
    ctx.mesh.magnetic_node_mask = {1u};
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
    return ctx;
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
        auto ctx = make_oersted_only_rk_context(integrator);
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
    }
}

void deterministic_oersted_fsal_requires_an_identical_next_source_state() {
    auto ctx = make_oersted_only_rk_context(FULLMAG_FEM_INTEGRATOR_RK23_BS);
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

void gpu_requested_oersted_only_step_rejects_host_rk_fallback() {
    auto ctx = make_oersted_only_rk_context(FULLMAG_FEM_INTEGRATOR_HEUN);
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
    auto ctx = make_oersted_only_rk_context(FULLMAG_FEM_INTEGRATOR_RK23_BS);
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
    const double proposed_dt = 0.8;
    ctx.base_plan.dt_seconds = proposed_dt;

    const std::vector<double> m_before = ctx.state.m_xyz;
    const double time_before = ctx.state.current_time;
    const uint64_t step_before = ctx.state.step_count;
    check(
        fullmag::fem::context_step_explicit_rk_mfem(
            ctx, tableau, proposed_dt, stats, error),
        error.c_str());
    check(stats.rejected_attempts > 0u, "adaptive CPU RK fixture must reject its first attempt");
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
}
#endif

void gpu_rk_call_path_uses_each_tableau_time_and_invalidates_rejected_fsal() {
    const auto root = fem_source_root() / "gpu" / "cuda" / "integrators" / "rk";
    const std::string setup = read_text_file(root / "rk_attempt_setup.cu");
    const std::string rk4 = read_text_file(root / "rk4_stage_sequence.cu");
    const std::string rk23 = read_text_file(root / "rk23_stage_sequence.cu");
    const std::string rk23_k3 = read_text_file(root / "rk23_adaptive_k3.cu");
    const std::string rk45 = read_text_file(root / "rk45_stage_sequence.cu");
    const std::string attempt_loop = read_text_file(root / "rk_attempt_loop.cu");
    const std::string adaptive = read_text_file(root / "rk_adaptive_runtime.cu");
    const std::string final_refresh = read_text_file(root / "rk_final_refresh.cu");

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
    fsal_reuse_requires_matching_source_state();
    rk_rhs_passes_explicit_stage_and_endpoint_times();
    gpu_rk_call_path_uses_each_tableau_time_and_invalidates_rejected_fsal();
    gpu_requested_rk_never_falls_through_to_host_stepper();
#if FULLMAG_HAS_MFEM_STACK
    executed_cpu_rk_steps_sample_all_stage_times_and_publish_endpoint_field();
    deterministic_oersted_fsal_requires_an_identical_next_source_state();
    gpu_requested_oersted_only_step_rejects_host_rk_fallback();
    rejected_cpu_retry_rolls_back_and_reports_only_accepted_attempt_fsal();
#endif
    return 0;
}
