/*
 * Native FEM relaxation source-layout contract.
 *
 * Production FEM energy minimizers must live in backends/fem, not in Rust
 * runner reference/orchestration paths. Keep algorithm files split so BB, NCG,
 * and tangent-plane work can evolve without recreating a monolith.
 */

#include "source_facade_contract_utils.hpp"

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::fem_source_root;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

void native_relaxation_algorithms_live_under_mfem_relaxation() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "cpu" / "mfem" / "relaxation";

    check(
        std::filesystem::exists(relaxation_root / "relaxation_step.hpp"),
        "native FEM relaxation must expose a module-owned relaxation_step.hpp");
    check(
        std::filesystem::exists(relaxation_root / "relaxation_step.cpp"),
        "native FEM relaxation must own production minimizer step dispatch");
    check(
        std::filesystem::exists(relaxation_root / "relaxation_math.hpp") &&
            std::filesystem::exists(relaxation_root / "relaxation_math.cpp"),
        "native FEM relaxation must keep shared tangent-space math out of algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "projected_gradient_bb.hpp") &&
            std::filesystem::exists(relaxation_root / "projected_gradient_bb.cpp"),
        "native FEM projected-gradient BB must live in dedicated algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "nonlinear_cg.hpp") &&
            std::filesystem::exists(relaxation_root / "nonlinear_cg.cpp"),
        "native FEM nonlinear CG must live in dedicated algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "tangent_plane_implicit.hpp") &&
            std::filesystem::exists(relaxation_root / "tangent_plane_implicit.cpp"),
        "native FEM tangent-plane implicit relaxation must have dedicated native files");
}

void c_abi_exposes_native_relaxation_step() {
    const std::filesystem::path root = fem_source_root();
    const std::string public_header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string relaxation_step =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "relaxation_step.cpp");
    const std::string projected_gradient =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "projected_gradient_bb.cpp");
    const std::string nonlinear_cg =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "nonlinear_cg.cpp");
    const std::string tangent_plane =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "tangent_plane_implicit.cpp");

    check(
        public_header.find("fullmag_fem_relax_algorithm") != std::string::npos,
        "C ABI must expose native FEM relaxation algorithm selection");
    check(
        public_header.find("fullmag_fem_backend_relax_step(") != std::string::npos,
        "C ABI must expose a native FEM relaxation step entrypoint");
    check(
        api.find("fullmag::fem::run_backend_relaxation_step(") != std::string::npos,
        "api.cpp must delegate native relaxation step execution to runtime");
    check(
        backend_step.find("run_backend_relaxation_step(") != std::string::npos,
        "backend_step.cpp must own runtime delegation for native relaxation steps");
    check(
        relaxation_step.find("run_projected_gradient_bb_step(") != std::string::npos,
        "relaxation_step.cpp must route projected-gradient BB to the native algorithm module");
    check(
        relaxation_step.find("run_nonlinear_cg_step(") != std::string::npos,
        "relaxation_step.cpp must route nonlinear CG to the native algorithm module");
    check(
        projected_gradient.find("metric_dot_fields(") != std::string::npos &&
            projected_gradient.find("metric_gradient_norm_sq(") != std::string::npos,
        "native FEM projected-gradient BB must use the FEM mass metric");
    check(
        nonlinear_cg.find("not implemented yet") == std::string::npos,
        "native FEM nonlinear CG must not be an unavailable stub");
    check(
        nonlinear_cg.find("metric_dot_fields(") != std::string::npos &&
            nonlinear_cg.find("metric_gradient_norm_sq(") != std::string::npos,
        "native FEM nonlinear CG must use the FEM mass metric");
    check(
        relaxation_step.find("run_tangent_plane_implicit_step(") != std::string::npos,
        "relaxation_step.cpp must route tangent-plane implicit to the native algorithm module");
    check(
        tangent_plane.find("not implemented yet") == std::string::npos,
        "native FEM tangent-plane implicit relaxation must not be an unavailable stub");
    check(
        tangent_plane.find("metric_dot_fields(") != std::string::npos &&
            tangent_plane.find("metric_gradient_norm_sq(") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use the FEM mass metric");
    check(
        tangent_plane.find("assemble_tangent_plane_operator(") != std::string::npos &&
            tangent_plane.find("solve_tangent_plane_linear_system(") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must assemble and solve a global tangent-plane system");
    check(
        tangent_plane.find("mass_form->SpMat()") != std::string::npos &&
            tangent_plane.find("exchange_form->SpMat()") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use MFEM mass and exchange operators");
    check(
        tangent_plane.find("HyprePCG") != std::string::npos &&
            tangent_plane.find("HypreBoomerAMG") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use Hypre solver/preconditioner support when available");
    check(
        tangent_plane.find("implicit_tangent_direction(") == std::string::npos &&
            tangent_plane.find("node_norm(") == std::string::npos,
        "native FEM tangent-plane implicit relaxation must not regress to a local diagonal step");
}

void runner_does_not_claim_production_fem_minimizer_ownership() {
    const std::string runner_fem =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "direct_minimizer.rs");
    const std::string runner_algorithm =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "algorithm.rs");

    check(
        runner_fem.find("backend.relax_step(") != std::string::npos,
        "runner FEM direct-minimizer path must call the native production relaxation ABI");
    check(
        runner_fem.find("bootstrap") == std::string::npos,
        "runner FEM direct-minimizer path must not describe native production relaxation as bootstrap");
    check(
        runner_fem.find("projected_gradient_line_search(") == std::string::npos &&
            runner_fem.find("nonlinear_cg_line_search(") == std::string::npos,
        "runner must not own production FEM direct-minimizer line-search loops");
    check(
        runner_algorithm.find("RelaxationAlgorithmIR::TangentPlaneImplicit => true") !=
            std::string::npos ||
            runner_algorithm.find("| RelaxationAlgorithmIR::TangentPlaneImplicit => Some(control)") !=
            std::string::npos,
        "runner must route tangent-plane implicit relaxation through the native FEM ABI");
}

} // namespace

int main() {
    native_relaxation_algorithms_live_under_mfem_relaxation();
    c_abi_exposes_native_relaxation_step();
    runner_does_not_claim_production_fem_minimizer_ownership();
    return 0;
}
