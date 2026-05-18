/*
 * mfem_context_contract.cpp - native FEM MFEM context lifecycle ownership.
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

void mfem_context_lifecycle_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string runtime =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.cpp");
    const std::string runtime_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.hpp");

    check(
        bridge.find("bool context_initialize_mfem(") == std::string::npos,
        "MFEM context initialization must not be defined in mfem_bridge.cpp");
    check(
        bridge.find("void context_destroy_mfem(") == std::string::npos,
        "MFEM context destruction must not be defined in mfem_bridge.cpp");
    check(
        bridge.find("bool context_upload_mfem_exchange_to_gpu_state(") == std::string::npos,
        "MFEM legacy sparse upload wrapper must not be defined in mfem_bridge.cpp");
    check(
        runtime.find("bool context_initialize_mfem(") != std::string::npos,
        "MFEM context initialization must be defined in runtime/mfem_context.cpp");
    check(
        runtime.find("void context_destroy_mfem(") != std::string::npos,
        "MFEM context destruction must be defined in runtime/mfem_context.cpp");
    check(
        runtime.find("bool context_upload_mfem_exchange_to_gpu_state(") != std::string::npos,
        "MFEM legacy sparse upload wrapper must be defined in runtime/mfem_context.cpp");
    check(
        context_header.find("context_initialize_mfem") == std::string::npos,
        "MFEM context initialization declaration must not live in context.hpp");
    check(
        context_header.find("context_destroy_mfem") == std::string::npos,
        "MFEM context destruction declaration must not live in context.hpp");
    check(
        context_header.find("context_upload_mfem_exchange_to_gpu_state") == std::string::npos,
        "MFEM legacy sparse upload declaration must not live in context.hpp");
    check(
        runtime_header.find("Initialize, publish, and destroy the native MFEM runtime context") !=
            std::string::npos,
        "mfem_context header must document lifecycle ownership");
    check(
        runtime_header.find("struct MfemContextRuntimeState") != std::string::npos,
        "mfem_context header must declare the runtime state owner");
    check(
        runtime_header.find("int selected_device_index") != std::string::npos &&
            runtime_header.find("mfem::Device *device") != std::string::npos,
        "MFEM context runtime state must own typed MFEM device selection");
    check(
        context_header.find("MfemContextRuntimeState mfem_context{}") != std::string::npos,
        "Context must store actual MFEM context runtime state under mfem_context");
    for (const char *flat_field : {
             "int mfem_selected_device_index",
             "void *mfem_device",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat actual MFEM device runtime fields");
    }
}

void mfem_runtime_pointers_are_typed() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string exchange_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "exchange.hpp");
    const std::string mfem_context_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.hpp");

    for (const char *needle : {
             "void *mfem_mesh",
             "void *mfem_fec",
             "void *mfem_fes",
             "void *mfem_gf_",
             "void *mfem_poisson",
             "void *mfem_cached_hypre",
             "void *mfem_periodic",
             "void *mfem_demag",
             "void *mfem_dmi",
             "void  *mfem_boundary",
         }) {
        check(
            context_header.find(needle) == std::string::npos,
            "Context MFEM-owned pointers must be typed, not void pointers");
    }
    check(
        context_header.find("mfem::Mesh *mfem_mesh") != std::string::npos,
        "Context must expose typed MFEM mesh pointer under MFEM guard");
    check(
        context_header.find("mfem::FiniteElementSpace *mfem_fes") != std::string::npos,
        "Context must expose typed MFEM FE space pointer under MFEM guard");
    check(
        context_header.find("PoissonHypreWorkspace *mfem_poisson_hypre_workspace") !=
            std::string::npos,
        "Context must expose typed Poisson Hypre workspace pointer");
    check(
        exchange_header.find("void *exchange_form") == std::string::npos &&
            exchange_header.find("mfem::BilinearForm *exchange_form") != std::string::npos,
        "Exchange MFEM runtime state must use typed operator pointers");
    check(
        mfem_context_header.find("void *device") == std::string::npos &&
            mfem_context_header.find("mfem::Device *device") != std::string::npos,
        "MFEM context runtime state must use typed device pointer");
}

void runtime_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aos =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "aos_field.cpp");
    const std::string availability =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "availability.cpp");
    const std::string cpu_threads =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "cpu_threads.cpp");
    const std::string field_refresh =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "field_refresh.cpp");
    const std::string gpu_state =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "gpu_state_runtime.cpp");
    const std::string interrupt =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "interrupt.cpp");
    const std::string mfem_context =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.cpp");
    const std::string mfem_device =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_device.cpp");
    const std::string snapshot =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.cpp");
    const std::string stage_completion =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "stage_completion.cpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");
    const std::string step_metrics =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "step_metrics.cpp");

    check(
        aos.find("AoS field runtime source contract") != std::string::npos,
        "AoS field runtime source file must document its source contract");
    check(
        aos.find("does not evaluate LLG RHS, compose H_eff, own state I/O, or publish metrics") != std::string::npos,
        "AoS field runtime source file must document its non-owning module boundary");
    check(
        availability.find("Runtime availability source contract") != std::string::npos,
        "availability runtime source file must document its source contract");
    check(
        availability.find("does not initialize MFEM contexts, choose devices, manage GPU state, or execute solver steps") != std::string::npos,
        "availability runtime source file must document its non-owning module boundary");
    check(
        cpu_threads.find("CPU threading runtime source contract") != std::string::npos,
        "CPU threading runtime source file must document its source contract");
    check(
        cpu_threads.find("does not choose MFEM devices, manage contexts, execute steps, or publish solver metrics") != std::string::npos,
        "CPU threading runtime source file must document its non-owning module boundary");
    check(
        field_refresh.find("Field-refresh runtime source contract") != std::string::npos,
        "field-refresh runtime source file must document its source contract");
    check(
        field_refresh.find("does not solve demag, compose H_eff, own state I/O, or publish step metrics") != std::string::npos,
        "field-refresh runtime source file must document its non-owning module boundary");
    check(
        gpu_state.find("GPU-state runtime source contract") != std::string::npos,
        "GPU-state runtime source file must document its source contract");
    check(
        gpu_state.find("does not choose MFEM devices, assemble exchange operators, execute RK stages, or own state I/O") != std::string::npos,
        "GPU-state runtime source file must document its non-owning module boundary");
    check(
        interrupt.find("Interrupt runtime source contract") != std::string::npos,
        "interrupt runtime source file must document its source contract");
    check(
        interrupt.find("does not own step execution, stage completion, field composition, or metrics publication") != std::string::npos,
        "interrupt runtime source file must document its non-owning module boundary");
    check(
        mfem_context.find("MFEM context runtime source contract") != std::string::npos,
        "MFEM context runtime source file must document its source contract");
    check(
        mfem_context.find("does not own device selection, GPU-state bootstrap, interaction physics, or step integrators") != std::string::npos,
        "MFEM context runtime source file must document its non-owning module boundary");
    check(
        mfem_device.find("MFEM device runtime source contract") != std::string::npos,
        "MFEM device runtime source file must document its source contract");
    check(
        mfem_device.find("does not allocate Context resources, bootstrap GPU state, execute steps, or own availability policy") != std::string::npos,
        "MFEM device runtime source file must document its non-owning module boundary");
    check(
        snapshot.find("Snapshot runtime source contract") != std::string::npos,
        "snapshot runtime source file must document its source contract");
    check(
        snapshot.find("does not own steady-state integration, state I/O primitives, common step metrics, or field-refresh policy") != std::string::npos,
        "snapshot runtime source file must document its non-owning module boundary");
    check(
        stage_completion.find("Stage-completion runtime source contract") != std::string::npos,
        "stage-completion runtime source file must document its source contract");
    check(
        stage_completion.find("does not integrate RK stages, compute fields, own adaptive control, or publish common step metrics") != std::string::npos,
        "stage-completion runtime source file must document its non-owning module boundary");
    check(
        state_io.find("State I/O runtime source contract") != std::string::npos,
        "state I/O runtime source file must document its source contract");
    check(
        state_io.find("does not compute fields, advance integrators, own snapshots, or publish step metrics") != std::string::npos,
        "state I/O runtime source file must document its non-owning module boundary");
    check(
        step_metrics.find("Step-metrics runtime source contract") != std::string::npos,
        "step-metrics runtime source file must document its source contract");
    check(
        step_metrics.find("does not execute steps, compose fields, own snapshots, or manage state I/O") != std::string::npos,
        "step-metrics runtime source file must document its non-owning module boundary");
}

void runtime_headers_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string availability =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "availability.hpp");
    const std::string cpu_threads =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "cpu_threads.hpp");
    const std::string field_refresh =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "field_refresh.hpp");
    const std::string gpu_state =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "gpu_state_runtime.hpp");
    const std::string interrupt =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "interrupt.hpp");
    const std::string mfem_device =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_device.hpp");
    const std::string phase_timings =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "phase_timings.hpp");
    const std::string snapshot =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.hpp");
    const std::string stage_completion =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "stage_completion.hpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.hpp");

    check(
        availability.find("It does not initialize MFEM contexts") != std::string::npos &&
            availability.find("manage GPU state") != std::string::npos &&
            availability.find("execute solver steps") != std::string::npos,
        "availability runtime header must document its non-owning module boundary");
    check(
        cpu_threads.find("It does not choose MFEM devices") != std::string::npos &&
            cpu_threads.find("execute steps") != std::string::npos &&
            cpu_threads.find("solver metrics") != std::string::npos,
        "CPU threading runtime header must document its non-owning module boundary");
    check(
        field_refresh.find("It does not solve demag") != std::string::npos &&
            field_refresh.find("own state I/O") != std::string::npos &&
            field_refresh.find("publish step") != std::string::npos &&
            field_refresh.find("metrics") != std::string::npos,
        "field-refresh runtime header must document its non-owning module boundary");
    check(
        gpu_state.find("It does not choose MFEM devices") != std::string::npos &&
            gpu_state.find("execute RK") != std::string::npos &&
            gpu_state.find("own state I/O") != std::string::npos,
        "GPU-state runtime header must document its non-owning module boundary");
    check(
        interrupt.find("It does not own step execution") != std::string::npos &&
            interrupt.find("field composition") != std::string::npos &&
            interrupt.find("metrics publication") != std::string::npos,
        "interrupt runtime header must document its non-owning module boundary");
    check(
        mfem_device.find("It does not allocate Context resources") != std::string::npos &&
            mfem_device.find("execute steps") != std::string::npos &&
            mfem_device.find("own availability policy") != std::string::npos,
        "MFEM device runtime header must document its non-owning module boundary");
    check(
        phase_timings.find("It does not execute phases") != std::string::npos &&
            phase_timings.find("advance") != std::string::npos &&
            phase_timings.find("ABI snapshots") != std::string::npos,
        "phase timings runtime header must document its non-owning module boundary");
    check(
        snapshot.find("It does not own steady-state integration") != std::string::npos &&
            snapshot.find("common step") != std::string::npos &&
            snapshot.find("field-refresh policy") != std::string::npos,
        "snapshot runtime header must document its non-owning module boundary");
    check(
        stage_completion.find("It does not integrate RK stages") != std::string::npos &&
            stage_completion.find("common step metrics") != std::string::npos,
        "stage-completion runtime header must document its non-owning module boundary");
    check(
        state_io.find("It does not compute fields") != std::string::npos &&
            state_io.find("own snapshots") != std::string::npos &&
            state_io.find("publish") != std::string::npos &&
            state_io.find("metrics") != std::string::npos,
        "state I/O runtime header must document its non-owning module boundary");
}

} // namespace

int main() {
    mfem_context_lifecycle_is_owned_by_runtime_module();
    mfem_runtime_pointers_are_typed();
    runtime_source_files_document_module_boundaries();
    runtime_headers_document_module_boundaries();
    return 0;
}
