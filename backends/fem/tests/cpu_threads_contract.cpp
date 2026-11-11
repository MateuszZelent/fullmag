/*
 * cpu_threads_contract.cpp - native FEM CPU runtime thread-selection contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/cpu_threads.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>

#ifdef _OPENMP
#include <omp.h>
#endif

#if defined(FULLMAG_FEM_EXPECTS_OPENMP) && !defined(_OPENMP)
#error "MFEM OpenMP thread contract must compile with OpenMP enabled"
#endif

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

class ScopedEnv {
public:
    explicit ScopedEnv(const char *name)
        : name_(name)
    {
        const char *raw = std::getenv(name_);
        if (raw != nullptr) {
            previous_ = std::string(raw);
        }
    }

    ~ScopedEnv()
    {
        if (previous_) {
            setenv(name_, previous_->c_str(), 1);
        } else {
            unsetenv(name_);
        }
    }

    void set(const char *value) { setenv(name_, value, 1); }
    void unset() { unsetenv(name_); }

private:
    const char *name_;
    std::optional<std::string> previous_;
};

#ifdef _OPENMP
class ScopedOpenMpRuntimeState {
public:
    ScopedOpenMpRuntimeState()
        : max_threads_(omp_get_max_threads())
        , dynamic_(omp_get_dynamic())
#if _OPENMP >= 200805
        , max_active_levels_(omp_get_max_active_levels())
#else
        , nested_(omp_get_nested())
#endif
    {}

    ~ScopedOpenMpRuntimeState()
    {
        omp_set_dynamic(dynamic_);
#if _OPENMP >= 200805
        omp_set_max_active_levels(max_active_levels_);
#else
        omp_set_nested(nested_);
#endif
        omp_set_num_threads(max_threads_);
    }

    void seed_distinct_runtime_state() const
    {
        omp_set_num_threads(7);
        omp_set_dynamic(1);
#if _OPENMP >= 200805
        omp_set_max_active_levels(2);
#else
        omp_set_nested(1);
#endif
    }

private:
    int max_threads_;
    int dynamic_;
#if _OPENMP >= 200805
    int max_active_levels_;
#else
    int nested_;
#endif
};

void check_openmp_runtime_settings(int expected_threads) {
    check(
        omp_get_max_threads() == expected_threads,
        "library CPU thread setter updates the OpenMP max-thread ICV");
    check(omp_get_dynamic() == 0, "library CPU thread setter disables dynamic teams");
    check(omp_get_nested() == 0, "library CPU thread setter disables nested teams");
#if _OPENMP >= 200805
    check(
        omp_get_max_active_levels() == 1,
        "library CPU thread setter limits active OpenMP levels to one");
#endif
}
#endif

void cpu_thread_runtime_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string runtime_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "cpu_threads.hpp");
    const std::string runtime =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "cpu_threads.cpp");
    const std::string mfem_context =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.cpp");

    check(
        bridge.find("struct CpuThreadRequest") == std::string::npos,
        "CPU thread request type must not be defined in mfem_bridge.cpp");
    check(
        bridge.find("void configure_fem_host_runtime_threads(") == std::string::npos,
        "FEM host runtime thread configuration must not be defined in mfem_bridge.cpp");
    check(
        runtime.find("CpuThreadRequest requested_cpu_threads(") != std::string::npos,
        "CPU thread request parsing must be defined in cpu_threads.cpp");
    check(
        runtime.find("void configure_fem_host_runtime_threads(") != std::string::npos,
        "FEM host runtime thread configuration must be defined in cpu_threads.cpp");
    check(
        runtime_header.find("struct CpuThreadRuntimeState") != std::string::npos,
        "CPU thread telemetry state must be defined by cpu_threads.hpp");
    check(
        context_header.find("bool cpu_threads_auto_requested") == std::string::npos,
        "Context must not expose flat CPU thread auto telemetry");
    check(
        context_header.find("int requested_omp_threads") == std::string::npos,
        "Context must not expose flat requested OMP telemetry");
    check(
        context_header.find("int effective_omp_threads") == std::string::npos,
        "Context must not expose flat effective OMP telemetry");

    const size_t host_threads =
        mfem_context.find("configure_fem_host_runtime_threads(ctx);");
    const size_t device_branch =
        mfem_context.find("#if FULLMAG_HAS_CUDA_RUNTIME", host_threads);
    const size_t gpu_branch = mfem_context.find("if (use_gpu_device)", device_branch);
    const size_t compute_stream =
        mfem_context.find("cudaStreamCreateWithPriority(&cs", gpu_branch);
    const size_t gpu_branch_end = mfem_context.find("} else {", gpu_branch);
    check(host_threads != std::string::npos, "host thread policy must be configured");
    check(
        host_threads < device_branch,
        "host thread policy must be configured before the CPU/GPU branch");
    check(
        gpu_branch < compute_stream && compute_stream < gpu_branch_end,
        "CUDA stream creation must remain scoped to the GPU branch");
}

void manual_env_precedence_matches_runtime_contract() {
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    resolved.unset();

    fullmag.set("4");
    omp.set("6");
    auto request = fullmag::fem::requested_cpu_threads();
    check(request.requested_threads == 6, "OMP_NUM_THREADS takes precedence over manual FULLMAG_CPU_THREADS");
    check(!request.auto_requested, "manual OMP thread count is not auto mode");

    omp.unset();
    request = fullmag::fem::requested_cpu_threads();
    check(request.requested_threads == 4, "manual FULLMAG_CPU_THREADS used when OMP is unset");
    check(!request.auto_requested, "manual FULLMAG thread count is not auto mode");
}

void fullmag_auto_mode_prefers_native_resolved_threads() {
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv native_resolved("FULLMAG_NATIVE_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");

    fullmag.set("auto");
    resolved.set("5");
    native_resolved.set("3");
    omp.set("12");

    auto request = fullmag::fem::requested_cpu_threads();
    check(request.auto_requested, "FULLMAG_CPU_THREADS=auto enables auto mode");
    check(request.requested_threads >= 1, "auto mode detects at least one CPU thread");
    check(request.auto_resolved_threads == 3, "native auto-resolved env value takes precedence");

    native_resolved.unset();
    request = fullmag::fem::requested_cpu_threads();
    check(request.auto_resolved_threads == 5, "legacy auto-resolved env remains a fallback");
}

void auto_thread_cap_scales_by_context_size() {
    fullmag::fem::Context ctx;
    ctx.mfem_device.device_string_override = "cpu";
    ctx.demag.enabled = false;
    ctx.mesh.n_nodes = 5000;
    ctx.mesh.n_elements = 1000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 8,
        "small FEM contexts cap auto CPU threads at 8");
    check(
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, 32) ==
            fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_SMALL_MESH,
        "small FEM contexts report small-mesh auto CPU thread cap");

    ctx.mesh.n_nodes = 20000;
    ctx.mesh.n_elements = 100000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 16,
        "medium FEM contexts cap auto CPU threads at 16");
    check(
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, 32) ==
            fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_MEDIUM_MESH,
        "medium FEM contexts report medium-mesh auto CPU thread cap");

    ctx.mesh.n_nodes = 100000;
    ctx.mesh.n_elements = 500000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 32,
        "large FEM contexts keep requested auto CPU threads");
    check(
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, 32) ==
            fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_AUTO_UNCAPPED,
        "large FEM contexts report uncapped auto CPU threads");

    ctx.mesh.n_nodes = 5000;
    ctx.mesh.n_elements = 1000;
    ctx.demag.enabled = true;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 8,
        "small FEM demag contexts cap auto CPU threads at 8");
    check(
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, 32) ==
            fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_SMALL_MESH,
        "small FEM demag contexts report small-mesh auto CPU thread cap");

    ctx.mesh.n_nodes = 20000;
    ctx.mesh.n_elements = 100000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 16,
        "medium FEM demag contexts cap auto CPU threads at 16");
    check(
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, 32) ==
            fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_MEDIUM_MESH,
        "medium FEM demag contexts report medium-mesh auto CPU thread cap");
}

void configure_host_runtime_writes_cpu_context_fields() {
#ifdef _OPENMP
    ScopedOpenMpRuntimeState openmp_runtime;
    openmp_runtime.seed_distinct_runtime_state();
#endif
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv native_resolved("FULLMAG_NATIVE_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    resolved.unset();
    native_resolved.set("3");
    omp.unset();
    fullmag.set("40");

    fullmag::fem::Context ctx;
    ctx.mfem_device.device_string_override = "cpu";
    ctx.mesh.n_nodes = 5000;
    ctx.mesh.n_elements = 1000;
    fullmag::fem::configure_fem_host_runtime_threads(ctx);

    check(!ctx.cpu_threads.auto_requested, "manual CPU runtime does not mark auto mode");
    check(ctx.cpu_threads.requested_omp_threads == 40, "manual CPU runtime stores requested threads");
    check(ctx.cpu_threads.effective_omp_threads == 40, "manual CPU runtime is not auto-capped by mesh size or allocation");
    check(
        ctx.cpu_threads.cap_reason == fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_NONE,
        "manual CPU runtime reports no auto cap reason");
    check(
        ctx.cpu_threads.dynamic_threads_disabled,
        "host runtime disables dynamic OpenMP thread adjustment");
    check(
        ctx.cpu_threads.nested_parallelism_disabled,
        "host runtime disables nested parallelism");
    check(
        ctx.cpu_threads.max_active_parallel_levels == 1,
        "host runtime publishes a single active parallel level");
#ifdef _OPENMP
    check_openmp_runtime_settings(40);
#endif
}

void configure_host_runtime_writes_gpu_context_fields() {
#ifdef _OPENMP
    ScopedOpenMpRuntimeState openmp_runtime;
    openmp_runtime.seed_distinct_runtime_state();
#endif
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    resolved.unset();
    omp.unset();
    fullmag.set("4");

    fullmag::fem::Context ctx;
    ctx.mfem_device.device_string_override = "cuda";
    fullmag::fem::configure_fem_host_runtime_threads(ctx);

    check(!ctx.cpu_threads.auto_requested, "manual GPU host runtime does not mark auto mode");
    check(ctx.cpu_threads.requested_omp_threads == 4, "GPU host runtime stores requested threads");
    check(ctx.cpu_threads.effective_omp_threads == 4, "GPU host runtime keeps requested threads effective");
    check(
        ctx.cpu_threads.cap_reason == fullmag::fem::FULLMAG_FEM_HOST_THREAD_POLICY_NONE,
        "manual GPU host runtime reports no resolved policy override");
#ifdef _OPENMP
    check_openmp_runtime_settings(4);
#endif
}

void automatic_cpu_runtime_applies_size_cap_to_openmp() {
#ifdef _OPENMP
    ScopedOpenMpRuntimeState openmp_runtime;
    openmp_runtime.seed_distinct_runtime_state();
#endif
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv native_resolved("FULLMAG_NATIVE_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    fullmag.set("auto");
    resolved.unset();
    native_resolved.unset();
    omp.unset();

    const auto request = fullmag::fem::requested_cpu_threads();
    fullmag::fem::Context ctx;
    ctx.mfem_device.device_string_override = "cpu";
    ctx.mesh.n_nodes = 5000;
    ctx.mesh.n_elements = 1000;
    const int expected_threads =
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, request.requested_threads);
    const int expected_reason =
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, request.requested_threads);

    fullmag::fem::configure_fem_host_runtime_threads(ctx);

    check(ctx.cpu_threads.auto_requested, "auto CPU runtime preserves automatic intent");
    check(
        ctx.cpu_threads.effective_omp_threads == expected_threads,
        "auto CPU runtime applies the context-size thread cap");
    check(
        ctx.cpu_threads.cap_reason == expected_reason,
        "auto CPU runtime reports the matching size-cap reason");
#ifdef _OPENMP
    check_openmp_runtime_settings(expected_threads);
#endif
}

void automatic_cpu_runtime_combines_external_allocation_and_mesh_cap() {
#ifdef _OPENMP
    ScopedOpenMpRuntimeState openmp_runtime;
    openmp_runtime.seed_distinct_runtime_state();
#endif
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv native_resolved("FULLMAG_NATIVE_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    fullmag.set("auto");
    resolved.unset();
    native_resolved.set("40");
    omp.unset();

    const auto detected_request = fullmag::fem::requested_cpu_threads();
    check(detected_request.requested_threads >= 1, "auto mode has a detected host limit");
    check(detected_request.auto_resolved_threads == 40, "auto mode reads the external allocation limit");

    fullmag::fem::Context medium;
    medium.mfem_device.device_string_override = "cpu";
    medium.mesh.n_nodes = 20000;
    medium.mesh.n_elements = 100000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(medium, 40) == 16,
        "external allocation 40 still meets the medium-mesh cap of 16");
    fullmag::fem::configure_fem_host_runtime_threads(medium);
    const int expected_medium_threads = detected_request.requested_threads < 16
        ? detected_request.requested_threads
        : 16;
    check(
        medium.cpu_threads.effective_omp_threads == expected_medium_threads,
        "external allocation 40 and detected host limit are both subject to the medium-mesh cap");
    const int expected_medium_reason = detected_request.requested_threads > 16
        ? fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_MEDIUM_MESH
        : fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_AUTO_UNCAPPED;
    check(
        medium.cpu_threads.cap_reason == expected_medium_reason,
        "medium-mesh telemetry identifies the size limit only when it is restrictive");
#ifdef _OPENMP
    check_openmp_runtime_settings(expected_medium_threads);
#endif

    fullmag::fem::Context small;
    small.mfem_device.device_string_override = "cpu";
    small.mesh.n_nodes = 5000;
    small.mesh.n_elements = 1000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(small, 40) == 8,
        "external allocation 40 still meets the small-mesh cap of 8");
    fullmag::fem::configure_fem_host_runtime_threads(small);
    const int expected_small_threads = detected_request.requested_threads < 8
        ? detected_request.requested_threads
        : 8;
    check(
        small.cpu_threads.effective_omp_threads == expected_small_threads,
        "external allocation 40 and detected host limit are both subject to the small-mesh cap");
    const int expected_small_reason = detected_request.requested_threads > 8
        ? fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_SMALL_MESH
        : fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_AUTO_UNCAPPED;
    check(
        small.cpu_threads.cap_reason == expected_small_reason,
        "small-mesh telemetry identifies the size limit only when it is restrictive");
#ifdef _OPENMP
    check_openmp_runtime_settings(expected_small_threads);
#endif

    native_resolved.set("3");
    fullmag::fem::Context externally_limited;
    externally_limited.mfem_device.device_string_override = "cpu";
    externally_limited.mesh.n_nodes = 20000;
    externally_limited.mesh.n_elements = 100000;
    fullmag::fem::configure_fem_host_runtime_threads(externally_limited);
    const int expected_external_threads = detected_request.requested_threads < 3
        ? detected_request.requested_threads
        : 3;
    check(
        externally_limited.cpu_threads.effective_omp_threads == expected_external_threads,
        "external allocation 3 limits medium-mesh auto mode to 3 when detected capacity permits");
    const int expected_external_reason = detected_request.requested_threads > 3
        ? fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_EXTERNAL_AUTO_RESOLVED
        : fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_AUTO_UNCAPPED;
    check(
        externally_limited.cpu_threads.cap_reason == expected_external_reason,
        "telemetry reports the external allocation only when it is the restrictive bound");
#ifdef _OPENMP
    check_openmp_runtime_settings(expected_external_threads);
#endif
}

void automatic_gpu_host_policy_is_deliberately_one_thread() {
    fullmag::fem::Context ctx;
    ctx.mfem_device.device_string_override = "cuda";

    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 1,
        "automatic GPU host policy defaults deliberately to one thread");
    check(
        fullmag::fem::auto_cpu_thread_cap_reason_for_context(ctx, 32) ==
            fullmag::fem::FULLMAG_FEM_HOST_THREAD_POLICY_GPU_DEFAULT_ONE,
        "automatic GPU host policy reports the deliberate one-thread decision");
}

void automatic_gpu_host_policy_overrides_external_cpu_auto_resolution() {
#ifdef _OPENMP
    ScopedOpenMpRuntimeState openmp_runtime;
    openmp_runtime.seed_distinct_runtime_state();
#endif
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv native_resolved("FULLMAG_NATIVE_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    fullmag.set("auto");
    resolved.set("40");
    native_resolved.set("40");
    omp.set("40");

    fullmag::fem::Context ctx;
    ctx.mfem_device.device_string_override = "cuda";
    fullmag::fem::configure_fem_host_runtime_threads(ctx);

    check(ctx.cpu_threads.auto_requested, "GPU host runtime preserves automatic thread intent");
    check(
        ctx.cpu_threads.effective_omp_threads == 1,
        "qualified GPU host policy overrides external CPU auto resolution");
    check(
        ctx.cpu_threads.cap_reason == fullmag::fem::FULLMAG_FEM_HOST_THREAD_POLICY_GPU_DEFAULT_ONE,
        "qualified GPU host policy reports deliberate one-thread resolution");
#ifdef _OPENMP
    check_openmp_runtime_settings(1);
#endif
}

} // namespace

int main() {
    cpu_thread_runtime_is_owned_by_runtime_module();
    manual_env_precedence_matches_runtime_contract();
    fullmag_auto_mode_prefers_native_resolved_threads();
    auto_thread_cap_scales_by_context_size();
    configure_host_runtime_writes_cpu_context_fields();
    configure_host_runtime_writes_gpu_context_fields();
    automatic_cpu_runtime_applies_size_cap_to_openmp();
    automatic_cpu_runtime_combines_external_allocation_and_mesh_cap();
    automatic_gpu_host_policy_is_deliberately_one_thread();
    automatic_gpu_host_policy_overrides_external_cpu_auto_resolution();
    return 0;
}
