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

void cpu_thread_runtime_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string runtime_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "cpu_threads.hpp");
    const std::string runtime =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "cpu_threads.cpp");

    check(
        bridge.find("struct CpuThreadRequest") == std::string::npos,
        "CPU thread request type must not be defined in mfem_bridge.cpp");
    check(
        bridge.find("void configure_cpu_openmp_runtime(") == std::string::npos,
        "CPU OpenMP runtime configuration must not be defined in mfem_bridge.cpp");
    check(
        runtime.find("CpuThreadRequest requested_cpu_threads(") != std::string::npos,
        "CPU thread request parsing must be defined in cpu_threads.cpp");
    check(
        runtime.find("void configure_cpu_openmp_runtime(") != std::string::npos,
        "CPU OpenMP runtime configuration must be defined in cpu_threads.cpp");
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

void fullmag_auto_mode_overrides_manual_omp() {
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");

    fullmag.set("auto");
    resolved.set("5");
    omp.set("12");

    const auto request = fullmag::fem::requested_cpu_threads();
    check(request.auto_requested, "FULLMAG_CPU_THREADS=auto enables auto mode");
    check(request.requested_threads >= 1, "auto mode detects at least one CPU thread");
    check(request.auto_resolved_threads == 5, "auto-resolved env value is preserved");
}

void auto_thread_cap_scales_by_context_size() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 5000;
    ctx.mesh.n_elements = 1000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 8,
        "small FEM contexts cap auto CPU threads at 8");

    ctx.mesh.n_nodes = 20000;
    ctx.mesh.n_elements = 100000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 16,
        "medium FEM contexts cap auto CPU threads at 16");

    ctx.mesh.n_nodes = 100000;
    ctx.mesh.n_elements = 500000;
    check(
        fullmag::fem::auto_cpu_thread_cap_for_context(ctx, 32) == 32,
        "large FEM contexts keep requested auto CPU threads");
}

void configure_cpu_runtime_writes_context_fields() {
    ScopedEnv fullmag("FULLMAG_CPU_THREADS");
    ScopedEnv resolved("FULLMAG_CPU_THREADS_AUTO_RESOLVED");
    ScopedEnv omp("OMP_NUM_THREADS");
    resolved.unset();
    omp.unset();
    fullmag.set("3");

    fullmag::fem::Context ctx;
    fullmag::fem::configure_cpu_openmp_runtime(ctx);

    check(!ctx.cpu_threads.auto_requested, "manual CPU runtime does not mark auto mode");
    check(ctx.cpu_threads.requested_omp_threads == 3, "manual CPU runtime stores requested threads");
    check(ctx.cpu_threads.effective_omp_threads == 3, "manual CPU runtime stores effective threads");
}

} // namespace

int main() {
    cpu_thread_runtime_is_owned_by_runtime_module();
    manual_env_precedence_matches_runtime_contract();
    fullmag_auto_mode_overrides_manual_omp();
    auto_thread_cap_scales_by_context_size();
    configure_cpu_runtime_writes_context_fields();
    return 0;
}
