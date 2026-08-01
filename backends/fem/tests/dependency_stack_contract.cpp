#include "source_facade_contract_utils.hpp"

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

void managed_fem_dependency_stack_uses_qualified_versions() {
    const std::string dockerfile =
        read_text_file(repo_root() / "docker" / "fem-gpu" / "Dockerfile");
    const std::string guide = read_text_file(
        repo_root() / "docs" / "guides" / "mfem-host-parity-setup-ubuntu22.md");

    check(
        dockerfile.find("ENV MFEM_REF=v4.9") != std::string::npos,
        "managed FEM GPU image must pin MFEM v4.9");
    check(
        dockerfile.find("ENV HYPRE_REF=v3.1.0") != std::string::npos,
        "managed FEM GPU image must pin hypre v3.1.0");
    check(
        guide.find("MFEM v4.9") != std::string::npos,
        "host-parity guide must document MFEM v4.9");
    check(
        guide.find("hypre v3.1.0") != std::string::npos,
        "host-parity guide must document hypre v3.1.0");
}

} // namespace

int main() {
    managed_fem_dependency_stack_uses_qualified_versions();
    return 0;
}
