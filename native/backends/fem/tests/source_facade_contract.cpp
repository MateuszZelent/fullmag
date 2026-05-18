/*
 * source_facade_contract.cpp - native FEM source-facade ownership docs.
 *
 * The module split leaves several top-level source files as compatibility
 * facades. This contract keeps those boundaries explicit and prevents
 * src/context.cpp or src/mfem_bridge.cpp from becoming undocumented owners of
 * core, runtime, interaction, or integrator responsibilities again.
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

void source_facades_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string dmi =
        read_text_file(root / "src" / "dmi_weak_residual.cpp");
    const std::string error = read_text_file(root / "src" / "error.cpp");
    const std::string gpu_exchange =
        read_text_file(root / "src" / "gpu_exchange.cpp");
    const std::string gpu_rk = read_text_file(root / "src" / "gpu_rk.cpp");
    const std::string gpu_state =
        read_text_file(root / "src" / "gpu_state.cpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string transfer =
        read_text_file(root / "src" / "transfer_audit.cpp");

    check(
        api.find("FEM C ABI facade source contract") != std::string::npos,
        "api source file must document its source contract");
    check(
        api.find("does not own Context construction internals, MFEM runtime lifecycle, interaction physics, integrator stages, or transfer-audit policy") != std::string::npos,
        "api source file must document its non-owning module boundary");
    check(
        context.find("FEM Context facade source contract") != std::string::npos,
        "context source file must document its source contract");
    check(
        context.find("does not own base/core import helpers, runtime lifecycle, device policy, integrator stage mechanics, or interaction physics") != std::string::npos,
        "context source file must document its non-owning module boundary");
    check(
        dmi.find("DMI weak-residual facade source contract") != std::string::npos,
        "DMI weak-residual source file must document its source contract");
    check(
        dmi.find("does not own Context plan import, effective-field composition, demag solves, runtime state I/O, or integrator execution") != std::string::npos,
        "DMI weak-residual source file must document its non-owning module boundary");
    check(
        error.find("FEM error facade source contract") != std::string::npos,
        "error source file must document its source contract");
    check(
        error.find("does not own backend creation, Context construction, solver execution, availability policy, or transfer auditing") != std::string::npos,
        "error source file must document its non-owning module boundary");
    check(
        gpu_exchange.find("GPU exchange facade source contract") != std::string::npos,
        "GPU exchange source file must document its source contract");
    check(
        gpu_exchange.find("does not own Context construction, MFEM exchange assembly, CPU fallback exchange, integrator execution, or C ABI entrypoints") != std::string::npos,
        "GPU exchange source file must document its non-owning module boundary");
    check(
        gpu_rk.find("GPU RK facade source contract") != std::string::npos,
        "GPU RK source file must document its source contract");
    check(
        gpu_rk.find("does not own Context construction, CPU explicit RK stages, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints") != std::string::npos,
        "GPU RK source file must document its non-owning module boundary");
    check(
        gpu_state.find("GPU state facade source contract") != std::string::npos,
        "GPU state source file must document its source contract");
    check(
        gpu_state.find("does not own MFEM device selection, Context construction, exchange operator assembly, integrator execution, or C ABI entrypoints") != std::string::npos,
        "GPU state source file must document its non-owning module boundary");
    check(
        bridge.find("Legacy MFEM bridge facade source contract") != std::string::npos,
        "legacy MFEM bridge source file must document its source contract");
    check(
        bridge.find("does not own runtime lifecycle, interaction physics, integrators, field buffers, metrics, or CPU runtime policy") != std::string::npos,
        "legacy MFEM bridge source file must document its non-owning module boundary");
    check(
        transfer.find("Transfer-audit facade source contract") != std::string::npos,
        "transfer-audit source file must document its source contract");
    check(
        transfer.find("does not own C ABI calls, Context construction, MFEM device policy, interaction physics, or integrator execution") != std::string::npos,
        "transfer-audit source file must document its non-owning module boundary");
}

void common_fem_utilities_have_single_header() {
    const std::filesystem::path root = fem_source_root();
    const std::string common = read_text_file(root / "include" / "fem_common.hpp");
    const std::string llg =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.cpp");
    const std::string rk_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string thermal_sigma =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.cpp");
    const std::string demag_energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_energy.cpp");

    for (const char *symbol : {
             "kPi",
             "kMu0",
             "scalar_field_value",
             "vector_norm3",
             "elapsed_ns",
             "ScopedPhaseTimer",
         }) {
        check(
            common.find(symbol) != std::string::npos,
            "common FEM utility header must own shared scalar/timing/vector helpers");
    }
    for (const std::string *source : {&llg, &rk_step, &thermal_sigma, &demag_energy}) {
        check(
            source->find("#include \"fem_common.hpp\"") != std::string::npos,
            "duplicate FEM utility users must include fem_common.hpp");
    }
    check(
        llg.find("double scalar_field_value(") == std::string::npos &&
            llg.find("double vector_norm3(") == std::string::npos,
        "LLG RHS must use shared scalar/vector helpers instead of local copies");
    check(
        rk_step.find("class ScopedPhaseTimer") == std::string::npos,
        "RK stepper must use shared timing helper instead of a local timer class");
    check(
        thermal_sigma.find("constexpr double kMu0") == std::string::npos,
        "Brown sigma must use shared constants instead of local mu0 copy");
    check(
        demag_energy.find("double scalar_field_value(") == std::string::npos,
        "Demag energy must use shared scalar helper instead of local copy");
}

} // namespace

int main() {
    source_facades_document_module_boundaries();
    common_fem_utilities_have_single_header();
    return 0;
}
