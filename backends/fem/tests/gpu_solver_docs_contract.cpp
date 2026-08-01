#include "source_facade_contract_utils.hpp"

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

void gpu_ncg_demag_optimization_contract_is_documented() {
    const std::filesystem::path physics = repo_root() / "docs" / "physics";
    const std::string relaxation_note = read_text_file(
        physics / "0510-fem-relaxation-algorithms-mfem-gpu.md");
    const std::string demag_policy = read_text_file(
        physics / "0532-fem-demag-solver-policy-and-runtime-threading.md");
    const std::string gpu_runtime =
        read_text_file(physics / "0560-all-in-gpu-fem-runtime.md");

    check(
        relaxation_note.find("accepted endpoint token is consumed at most once") !=
            std::string::npos,
        "FEM GPU NCG docs must bound accepted endpoint reuse");
    check(
        demag_policy.find("hypre_HandleComputeStream(hypre_handle())") !=
            std::string::npos,
        "GPU demag docs must name the exact pinned HYPRE stream accessor");
    check(
        gpu_runtime.find("device-wide compatibility barrier is not strict GPU") !=
            std::string::npos,
        "strict GPU docs must reject a hidden global synchronization fallback");
}

} // namespace

int main() {
    gpu_ncg_demag_optimization_contract_is_documented();
    return 0;
}
