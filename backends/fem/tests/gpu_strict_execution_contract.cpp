#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    if (!input) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

std::filesystem::path source_root()
{
    const std::filesystem::path file(__FILE__);
    return file.is_absolute()
        ? file.parent_path().parent_path()
        : std::filesystem::current_path() / file.parent_path().parent_path();
}

void make_exchange_context_ready(fullmag::fem::Context &ctx)
{
    ctx.mesh.n_nodes = 8;
    ctx.base_plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    ctx.exchange.enabled = true;
    ctx.demag.enabled = false;
    ctx.gpu_state.device.lifecycle.initialized = true;
    ctx.gpu_state.device.lifecycle.allocated = true;
    ctx.gpu_state.device.lifecycle.node_count = 8;
    ctx.gpu_state.device.lifecycle.dof_len = 24;
    ctx.gpu_state.device.lifecycle.stage_count = 2;
    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = true;
    ctx.gpu_state.legacy_exchange.lumped_mass_ready = true;
    ctx.gpu_state.device.runtime_coefficients.uploaded = true;
    ctx.gpu_state.device.legacy_exchange.uploaded = true;
    ctx.gpu_state.device.legacy_exchange.rows = 8;
    ctx.gpu_state.device.legacy_exchange.cols = 8;
    ctx.gpu_state.device.legacy_exchange.csr_row_offsets = reinterpret_cast<int *>(1);
    ctx.gpu_state.device.legacy_exchange.csr_col_indices = reinterpret_cast<int *>(1);
    ctx.gpu_state.device.legacy_exchange.csr_values = reinterpret_cast<double *>(1);
    ctx.gpu_state.device.materials.ms = reinterpret_cast<double *>(1);
    ctx.gpu_state.device.mesh_metrics.inv_lumped_mass = reinterpret_cast<double *>(1);
}

} // namespace

int main()
{
    using namespace fullmag::fem;

    {
        Context ctx;
        make_exchange_context_ready(ctx);
        std::string reason;
        const GpuRkPlan plan = gpu_rk_plan_device_resident(ctx, reason);
        const uint64_t baseline =
            FEM_GPU_OPERATOR_EXCHANGE |
            FEM_GPU_OPERATOR_LLG_RHS |
            FEM_GPU_OPERATOR_RK_STEPPER |
            FEM_GPU_OPERATOR_REDUCTIONS;
        check(plan.enabled, "exchange-only strict device plan must be enabled");
        check(plan.execution_class == FemGpuExecutionClass::DeviceResident,
              "strict device plan must resolve device-resident execution");
        check(plan.required_operator_mask == baseline,
              "exchange-only plan must publish the exact required operator mask");
        check(plan.resolved_device_operator_mask == baseline,
              "strict device plan must resolve every required operator to device");
        check(plan.resolved_host_operator_mask == 0,
              "strict device plan must not resolve host operators");
        check(plan.resolved_unknown_operator_mask == 0,
              "strict device plan must not leave unknown operators");
        check(gpu_rk_plan_is_strict_device_resident(plan, reason),
              "complete device plan must pass strict preflight");
    }

    {
        fullmag_fem_transfer_audit transfer{};
        std::string reason;
        check(gpu_rk_strict_transfer_audit_is_clean(transfer, reason),
              "zero compute transfer audit must permit strict commit");
        transfer.hot_loop_control_scalar_d2h_bytes = sizeof(double);
        transfer.hot_loop_control_scalar_host_sync_count = 1;
        check(gpu_rk_strict_transfer_audit_is_clean(transfer, reason),
              "bounded control-scalar readback must not count as compute transfer");
        transfer.hot_loop_compute_d2h_bytes = sizeof(double);
        check(!gpu_rk_strict_transfer_audit_is_clean(transfer, reason),
              "compute D2H transfer must reject strict commit");
        check(reason.find("hot-loop compute") != std::string::npos,
              "transfer rejection must expose a typed diagnostic");
    }

    {
        const auto root = source_root();
        const std::string attempt = read_text_file(
            root / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.cu");
        const std::string step = read_text_file(
            root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
        const std::string backend_step = read_text_file(
            root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
        const std::string exchange = read_text_file(
            root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");
        const std::string demag = read_text_file(
            root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
        const std::string hypre = read_text_file(
            root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
        check(attempt.find("gpu_execution_receipt_begin_attempt") != std::string::npos &&
                  attempt.find("gpu_execution_receipt_reject_attempt") != std::string::npos &&
                  attempt.find("gpu_execution_receipt_fail_attempt") != std::string::npos,
              "attempt owner must account begin/reject/fail lifecycle");
        check(step.find("gpu_rk_strict_transfer_audit_is_clean") != std::string::npos,
              "GPU step owner must reject strict transfer violations before publication");
        check(backend_step.find("gpu_execution_receipt_commit_attempt") != std::string::npos &&
                  backend_step.find("gpu_rk_finalize_step_stats(ctx, out_stats, error)") != std::string::npos,
              "outer transaction owner must commit receipt only after final statistics");
        check(exchange.find("FEM_GPU_OPERATOR_EXCHANGE") != std::string::npos,
              "exchange owner must note actual device execution");
        check(demag.find("FEM_GPU_OPERATOR_DEMAG_RHS") != std::string::npos &&
                  demag.find("FEM_GPU_OPERATOR_DEMAG_RECOVERY") != std::string::npos,
              "device demag owner must note RHS and recovery execution");
        check(hypre.find("FEM_GPU_OPERATOR_DEMAG_SOLVE") != std::string::npos &&
                  hypre.find("FEM_GPU_OPERATOR_PRECONDITIONER") != std::string::npos,
              "Hypre owner must note solve and preconditioner execution");
        check(hypre.find("bool configure_hypre_device_vendor_kernels") != std::string::npos &&
                  hypre.find("HYPRE_ClearAllErrors") == std::string::npos,
              "strict Hypre setup must fail closed instead of clearing device-policy errors");
    }

    {
        Context ctx;
        make_exchange_context_ready(ctx);
        ctx.demag.enabled = true;
        ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON;
        std::string reason;
        const GpuRkPlan plan = gpu_rk_plan_device_resident(ctx, reason);
        const uint64_t host_demag =
            FEM_GPU_OPERATOR_DEMAG_SOLVE |
            FEM_GPU_OPERATOR_PRECONDITIONER;
        check(plan.enabled, "explicit hybrid compatibility plan must remain executable");
        check(plan.execution_class == FemGpuExecutionClass::HybridCpuPoisson,
              "explicit hybrid plan must retain hybrid execution class");
        check((plan.resolved_host_operator_mask & host_demag) == host_demag,
              "hybrid plan must expose host demag solve and preconditioner");
        check(!gpu_rk_plan_is_strict_device_resident(plan, reason),
              "hybrid plan must fail strict device preflight");
        check(reason.find("hybrid_cpu_poisson") != std::string::npos,
              "strict hybrid rejection must be typed and explicit");
    }

    {
        GpuRkPlan incomplete{};
        incomplete.enabled = true;
        incomplete.execution_class = FemGpuExecutionClass::DeviceResident;
        incomplete.required_operator_mask =
            FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_LLG_RHS;
        incomplete.resolved_device_operator_mask = FEM_GPU_OPERATOR_EXCHANGE;
        incomplete.resolved_unknown_operator_mask = FEM_GPU_OPERATOR_LLG_RHS;
        std::string reason;
        check(!gpu_rk_plan_is_strict_device_resident(incomplete, reason),
              "missing required device operator must fail strict preflight");
        check(reason.find("unresolved") != std::string::npos,
              "unknown operator rejection must identify unresolved execution");
    }

    std::printf("FEM GPU strict execution contract PASS\n");
    return 0;
}
